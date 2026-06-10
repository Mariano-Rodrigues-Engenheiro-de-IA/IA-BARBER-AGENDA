## Objetivo

Eliminar chamadas em tempo real à CelCash durante o atendimento. A IA consulta uma tabela local (`celcash_subscribers`) por telefone para decidir se o cliente é assinante ativo, qual plano tem e se está inadimplente, antes de agendar na Bemp.

## Arquitetura

```text
[Cron 1x/hora]
      │
      ▼
[edge: sync-celcash-subscribers]  ─── paginação ──▶  CelCash /customers + /subscriptions + /charges
      │
      ▼
[tabela: celcash_subscribers]  ◀── consulta por telefone ──  [IA / agente Bemp]
```

## Mudanças

### 1. Nova tabela `celcash_subscribers`

Substitui o uso de `celcash_cache` (que é cache pontual por telefone). Campos principais:

- `tenant_id` (FK tenants)
- `celcash_customer_id` (id do cliente na CelCash)
- `phone_e164` (normalizado, índice único por tenant)
- `phone_raw`, `name`, `document` (CPF/CNPJ), `email`
- `subscription_id`, `plan_id`, `plan_name`
- `status` (`active`, `overdue`, `canceled`, `trial`, `pending`)
- `is_overdue` (bool), `overdue_amount_cents`, `next_due_date`, `last_payment_date`
- `raw_payload` (jsonb com snapshot completo da CelCash)
- `synced_at`, `created_at`, `updated_at`

Índices: `(tenant_id, phone_e164)` único, `(tenant_id, status)`, `(tenant_id, is_overdue)`.

RLS: admin vê tudo; usuários do tenant veem só do seu tenant. Service role full.

### 2. Edge function `sync-celcash-subscribers`

- Roda por tenant (parâmetro `tenant_id`) ou para todos os tenants com `celcash_enabled = true` (modo cron).
- Fluxo por tenant:
  1. Pega `celcash_galax_id` / `celcash_galax_hash` do tenant.
  2. Gera token (`/v2/token`) — já validado funcionando.
  3. Pagina `/v2/customers` (ou endpoint equivalente de assinantes) buscando todos.
  4. Para cada cliente, busca assinatura e status financeiro (inadimplência).
  5. Faz `upsert` em `celcash_subscribers` por `(tenant_id, celcash_customer_id)`.
  6. Marca como `canceled` quem sumiu da CelCash (diff por `synced_at`).
- Normaliza telefone para E.164 (`+55…`) antes de salvar.
- Log de execução em `agent_logs` (qtd sincronizada, erros, duração).

### 3. Cron via `pg_cron` + `pg_net`

- Habilita extensões (se já não estiverem).
- Job a cada 1 hora (ajustável) chamando `sync-celcash-subscribers` em modo "todos os tenants".
- Job adicional a cada 15min só para tenants com muitas mudanças? — opcional, começamos com 1h.

### 4. Endpoint de consulta para a IA

Edge function `lookup-celcash-subscriber`:
- Input: `tenant_id`, `phone`.
- Normaliza telefone, consulta `celcash_subscribers`.
- Retorna: `{ is_subscriber, status, plan_name, is_overdue, overdue_amount, next_due_date, customer_name }`.
- Se não achar, retorna `{ is_subscriber: false }` (sem fallback à CelCash — fica simples e rápido).

### 5. Integração com fluxo Bemp/IA

No tool/handler que hoje chama Bemp para agendar:
1. Antes de listar serviços, chama `lookup-celcash-subscriber` pelo telefone do lead.
2. Se `is_subscriber && !is_overdue`: filtra/prioriza os serviços do plano correspondente na Bemp.
3. Se `is_overdue`: a IA informa pendência financeira e oferece serviço avulso ou link de regularização.
4. Se não é assinante: fluxo normal de serviço avulso.

### 6. UI mínima (admin, opcional nesta fase)

Em `/tenants/:id` (aba CelCash) adicionar:
- Botão "Sincronizar agora" (chama a edge function manualmente).
- Mostrar `last_sync_at`, total de assinantes, ativos, inadimplentes.

## Pontos de decisão antes de codar

1. **Frequência do cron**: começo com **1 hora**. OK?
2. **Escopo do sync**: trazer **todos os clientes** ou só **assinantes ativos + inadimplentes**? Sugiro todos para ter histórico completo.
3. **Tabela `celcash_cache` antiga**: mantenho (cache pontual) ou removo? Sugiro **remover** — fica redundante.
4. **UI de sincronização agora** ou só backend + cron nesta etapa?

Me confirma esses 4 pontos (ou só diz "segue com os defaults") e eu implemento.
