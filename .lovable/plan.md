# Backfill de resumos da IA

## Diagnóstico

O código do painel do cliente (`src/pages/client/Conversations.tsx` linhas 168–181 e 436–450) já lê e renderiza `crm_leads.ai_summary` corretamente. O motivo de você não ver o resumo é simples: **quase nenhum lead tem resumo gravado ainda**.

Estado atual no banco:
- Total de leads: 692
- Leads com `ai_summary` preenchido: **6**
- Exemplos por tenant: Champion 2/789, Bendita 1/632, Clínica Viver Bem 0/564, Marquez 0/184, Régis 0/177, Toledo's 1/26.

O auto-persist novo só dispara quando chega **uma nova mensagem** pelo webhook. Para os 686 leads antigos, nada vai aparecer até o cliente mandar mensagem de novo.

## Plano

Criar uma **edge function de backfill** (`backfill-client-summaries`) que:

1. Recebe `{ tenant_id?: string, limit?: number, force?: boolean }`. Sem `tenant_id` processa todos; sem `force` pula leads que já têm `ai_summary` não vazio.
2. Para cada lead elegível:
   - Carrega últimas ~40 mensagens de `chat_messages` (user + assistant) daquele `tenant_id + phone_number`.
   - Pula se houver menos de 2 mensagens do usuário (mesma regra do webhook).
   - Chama Lovable AI Gateway (`google/gemini-2.5-flash`) com o mesmo prompt extractor que o webhook usa em `maybeAutoPersistClientSummary` (mesmas regras de merge, ≤600 chars, PT-BR, factual).
   - Faz `update` em `crm_leads.ai_summary` + `ai_summary_updated_at`.
3. Loga progresso, rate-limit simples (pequeno delay entre chamadas) e retorna `{ processed, updated, skipped, errors }`.

Disparo: após deploy, eu chamo a função uma vez por tenant grande (Champion, Bendita, Viver Bem, Marquez, Régis, Ikaro, Toledo's…) e reporto os números. Nada é destrutivo — só preenche `ai_summary` vazio (ou atualiza se `force=true`).

## Detalhes técnicos

- Arquivo novo: `supabase/functions/backfill-client-summaries/index.ts`.
- Reaproveita constantes/prompt do `whatsapp-webhook` (copia o bloco extractor; sem refactor agora pra não mexer no caminho crítico do agente).
- Usa `SUPABASE_SERVICE_ROLE_KEY` (já existe) e `LOVABLE_API_KEY` (já existe).
- Sem migration, sem mudança de schema, sem mudança no front. O bloco "Resumo da IA" já está pronto e vai aparecer automaticamente assim que `ai_summary` for preenchido (refetch a cada 30 s).

## Critério de sucesso

Depois de rodar o backfill no tenant que você está olhando agora (`aa8ebe5e-…`), abrir uma conversa antiga já mostra o "Resumo da IA" no topo, sem precisar de mensagem nova do cliente.
