## Objetivo

Para tenants **Bemp + CelCash habilitado**, simplificar o fluxo: tabela local só com **ativos**, IA decide entre **agendar com plano** (ativo) ou **avulso** (não-ativo), e trata **inadimplência** reagindo ao erro de pagamento pendente devolvido pela **API Bemp**.

**Escopo:** somente quando `tenant.api_provider = 'bemp'` E `tenant.celcash_enabled = true`. Para qualquer outro provider (Trinks, OneBeleza, Zaylo, None) ou tenant sem CelCash, nada muda.

---

## 1. Sync CelCash — só ativos

**Arquivo:** `supabase/functions/sync-celcash-subscribers/index.ts`

- Filtrar antes do upsert: só linhas com `status === "active"` (e `trial`, se existir) entram em `celcash_subscribers`.
- Substituir o "marca como canceled quem não veio" por **DELETE** dos que não vieram no sync. A tabela passa a ser snapshot de ativos.
- Em `celcash_sync_runs`, manter `total_fetched` (todas as subs da API) + `total_upserted` (ativos) + novo `total_removed`.
- Resultado esperado: ~345 linhas para Toledos.

## 2. Lookup local — semântica nova

**Arquivo:** `supabase/functions/lookup-celcash-subscriber/index.ts`

- Achou linha → `is_subscriber: true` + `plan_id`, `plan_name`.
- Não achou → `is_subscriber: false` (sem distinção overdue/canceled).
- Remover `is_overdue` e `overdue_amount_cents` da resposta.

## 3. Prompt da IA — regra global condicional (Bemp + CelCash)

**Arquivo:** `supabase/functions/whatsapp-webhook/index.ts` (montagem do system prompt)

Injetar o bloco abaixo **somente quando** `tenant.api_provider === 'bemp'` E `tenant.celcash_enabled === true`:

```
## 💳 ASSINATURA E AGENDAMENTO (Bemp + CelCash)

1. ANTES de agendar, chame verificar_assinante(telefone do cliente).
2. Se is_subscriber=true → agende usando o serviço/plano correspondente
   ao plan_name retornado.
3. Se is_subscriber=false → agende como AVULSO (corte avulso, barba
   avulsa, ou o serviço solicitado em modo pago).
4. Se a ferramenta de agendamento da Bemp retornar erro indicando
   PAGAMENTO PENDENTE / INADIMPLÊNCIA / ASSINATURA EM ATRASO, NÃO
   tente de novo. Envie ao cliente:
   "Não consegui concluir seu agendamento porque há um pagamento
   pendente na sua assinatura. Deseja regularizar?"
   E aguarde a resposta. Não envie link de pagamento, não escale
   humano automaticamente.
```

Para outros providers ou tenants sem CelCash, o prompt continua exatamente como está hoje.

## 4. Detecção do erro de pagamento pendente — só na Bemp

**Arquivo:** `supabase/functions/whatsapp-webhook/index.ts` (executor da Bemp)

- No executor das tools de agendamento da **Bemp**, inspecionar a resposta da API. Se `status >= 400` E o corpo bater regex `/pagamento.*pendente|inadimpl|assinatura.*atras|payment.*overdue|subscription.*overdue/i`, retornar à IA:
  ```json
  { "error": "subscription_overdue",
    "message": "Cliente está com pagamento pendente na assinatura." }
  ```
- Não tocar nos executores de Trinks / OneBeleza / Zaylo.

## 5. Tool `verificar_assinante` (Bemp + CelCash)

**Arquivo:** `supabase/functions/whatsapp-webhook/index.ts`

- Garantir que a tool `verificar_assinante({ telefone })` é injetada para a IA **somente** quando `api_provider='bemp'` E `celcash_enabled=true`. Ela chama internamente `lookup-celcash-subscriber`.
- Se já existe com outro nome, padronizar para `verificar_assinante`.

## 6. UI — Painel de assinantes

**Arquivo:** `src/pages/client/Overview.tsx` (e qualquer card que mostre métricas CelCash)

- Renomear "Total" → "Assinantes ativos".
- Remover contadores de "inativos" e "inadimplentes".
- Nota curta: "A tabela contém apenas assinantes ativos. Inadimplência é detectada no momento do agendamento."
- Só aparece para tenants com `celcash_enabled=true` (já é o comportamento atual).

---

## Fora de escopo

- ❌ Mudanças em Trinks, OneBeleza, Zaylo ou tenants sem CelCash.
- ❌ Lookup ao vivo na CelCash a cada conversa.
- ❌ Sync de `/charges`.
- ❌ Envio automático de link/PIX.
- ❌ Escalonamento humano automático na inadimplência.

---

## Validação

1. Rodar sync manual de Toledos (Bemp + CelCash) → `celcash_subscribers` com ~345 linhas, todas `active`.
2. Conferir que tenant Trinks/OneBeleza sem CelCash não recebe o bloco novo no prompt nem a tool `verificar_assinante`.
3. Simular telefone ativo → IA agenda com plano. Telefone não cadastrado → IA agenda avulso.
4. Forçar resposta mock de erro "pagamento pendente" da Bemp → IA envia mensagem padrão e para.
