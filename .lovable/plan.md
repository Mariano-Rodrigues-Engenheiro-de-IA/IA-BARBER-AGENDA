## Objetivo

1. **Resumo persistente do cliente** — IA mantém e atualiza um pequeno "dossiê" por cliente (preferências, plano, histórico de serviços) e usa em toda conversa.
2. **Simulador de IA no painel do cliente** — nova aba "Simulador" onde o dono manda mensagem e a IA responde usando o **prompt real e código real**, mas sem WhatsApp e **sem nunca criar/cancelar/editar agendamento real** (só leitura).

---

## Parte 1 — Resumo persistente do cliente

### 1.1 Migração (1 migração)
Adicionar à tabela `crm_leads`:
- `ai_summary text default ''`
- `ai_summary_updated_at timestamptz`

(RLS já existe, contempla update por cliente e admin — não muda.)

### 1.2 Novo bloco no system prompt (`buildSystemPrompt`)
Logo após o bloco "👤 IDENTIDADE DO CLIENTE":
```
## 🗂️ RESUMO/JORNADA DESTE CLIENTE
{ai_summary se existir; senão: "(cliente novo / sem resumo ainda — colete informações naturalmente)"}
Atualizado em: {ai_summary_updated_at relativo, ex: "há 3 dias"}
```
+ Regras curtas:
- **Use ativamente** este resumo para personalizar (ex: "Vai querer corte e barba de novo?", "Como cliente do clube, o desconto já tá aplicado").
- **Atualize sempre que** o cliente revelar algo relevante e estável: serviço favorito, plano/assinatura, preferência de profissional, restrições, datas importantes, padrão de frequência.
- **NÃO** registre coisas efêmeras (humor, mensagens isoladas) nem dados sensíveis sem necessidade.
- Mantém-se **curto** (até ~600 caracteres). Reescreva consolidando, não acumulando.

### 1.3 Nova ferramenta universal `atualizar_resumo_cliente`
Injetada em **todos os provedores** (Trinks, OneBeleza, Frizzar, Bemp, Zaylo, None) via `buildToolsForProvider`. Parâmetros: `{ resumo: string }`. Executor:
- Faz upsert em `crm_leads` (mesma chave `tenant_id + phone_number` que o sistema já usa).
- Atualiza `ai_summary` + `ai_summary_updated_at = now()`.
- Logado em `agent_logs.tool_calls`.

### 1.4 Carregar resumo em `callAIAgent`
Já buscamos `crm_leads` pra pegar `name`. Vou trazer `ai_summary` e `ai_summary_updated_at` no mesmo SELECT e passar pra `buildSystemPrompt`.

### 1.5 UI (mínima, opcional nesta entrega)
Exibir `ai_summary` no card do CRM/Kanban como um trechinho cinza "🤖 Resumo da IA: …" (read-only) — útil pro dono ver o que a IA aprendeu. Reaproveita o componente atual dos leads.

---

## Parte 2 — Simulador de IA no painel do cliente

### 2.1 Estratégia técnica (sem refatorar `whatsapp-webhook`)
Adicionar um **novo endpoint POST** dentro da própria `whatsapp-webhook/index.ts`, ativado quando o body tem `{ mode: "simulator", message, history }`:
- Roda `callAIAgent` exatamente como hoje (mesmo prompt, mesmo provedor, mesmas ferramentas).
- **Bloqueia tools de escrita** (criar/cancelar/editar agendamento, cadastrar cliente, agendar, desmarcar, confirmar, atualizar_resumo_cliente) — quando chamadas no modo simulador, retornam um JSON falso `{ ok: true, simulated: true, message: "Ação simulada — no WhatsApp real isto criaria o agendamento." }` e a IA segue normal.
- **Tools de leitura** rodam de verdade (buscar serviços, horários, profissionais).
- **Não envia** nada pela UAZAPI.
- **Não grava** em `chat_messages`, `agent_logs`, `crm_leads` nem `conversation_state` (a sessão é efêmera).
- Retorna `{ response: string, toolCalls: [...] }`.

Auth do endpoint:
- Requer JWT do usuário autenticado (cliente do tenant) — valida via `SUPABASE_JWKS` que já está disponível.
- Confere se o `user_id` do JWT pertence ao `tenant_id` requisitado (via `tenant_users`).
- Sem JWT válido → 401.

### 2.2 UI nova: aba "Simulador" em `src/pages/client/Ai.tsx`
Adiciona aba `simulator` (entre "Ferramentas" e "Sua empresa"). Componente novo `<SimulatorTab tenantId={…} />`:
- Chat simples: bolhas usuário/assistente, scroll automático.
- Header curto: "🧪 Simulador — conversa não real. Buscas funcionam; agendamentos são apenas simulados."
- Input + botão "Enviar" + botão "Limpar conversa".
- Estado: `useState<UIMessage[]>` (memória local — não persiste; recarregou → zerou; é proposital).
- `sendMessage` → `supabase.functions.invoke("whatsapp-webhook", { body: { mode: "simulator", tenantId, message, history } })`.
- Loader "digitando…" enquanto aguarda.
- Mostra discretamente quando uma ferramenta de escrita foi simulada (badge cinza "ação simulada").

Permissão de visibilidade da aba: usar `useModulePermission("ai_prompt")` (já existe). Se o cliente tem visibilidade do prompt, vê o simulador.

### 2.3 Sem persistência, sem custo de WhatsApp
- Não chama UAZAPI.
- Não cria follow-ups.
- Não toca em `chat_messages`.
- IA usa o **mesmo modelo** do produção (custa créditos da IA normalmente — é o ponto: testar resposta real).

---

## Arquivos tocados

- `supabase/functions/whatsapp-webhook/index.ts` — bloco resumo no prompt; nova tool universal; carrega summary; endpoint `mode: "simulator"` com bloqueio de tools de escrita.
- 1 migração: `crm_leads.ai_summary` + `ai_summary_updated_at`.
- `src/pages/client/Ai.tsx` — adiciona aba "Simulador".
- Novo `src/components/SimulatorTab.tsx`.
- (Opcional) cards do CRM/Kanban: mostrar `ai_summary` resumido.

## Não muda

- Trinks, OneBeleza, Frizzar, Bemp, Zaylo, None: nenhuma mudança no fluxo real do WhatsApp.
- Prompts customizados de tenant continuam intactos.
- RLS existente segue valendo.
