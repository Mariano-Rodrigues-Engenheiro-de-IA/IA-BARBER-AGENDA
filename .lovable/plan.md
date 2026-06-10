## Diagnóstico do gargalo

Investiguei o número final 2868 (`+5561983012868`, Mariano Rodrigues) e a cadeia inteira:

| Camada | Status |
|---|---|
| Tabela `celcash_subscribers` | Encontrado, `status=active`, `is_overdue=false`, `plan_id=1193`, **`plan_name=NULL`** |
| Função `whatsapp-webhook` (`getCelCashContextCached`) | OK — injeta o bloco `[CELCASH]` corretamente |
| Prompt do tenant Don Castro (REGRA 12 + PASSO 2 do fluxo) | OK — instrui a IA a usar o `plan_name` para escolher o `service_id` "Don's Club [plano]" |
| Sync `sync-celcash-subscribers` | **Bug**: nunca consegue popular `plan_name` |

**Causa raiz:** o endpoint `/v2/subscriptions` da CelCash NÃO retorna o nome do plano. Ele só retorna `planMyId` e `planGalaxPayId`. Confirmei lendo os keys do `raw_payload` de uma assinatura real — não existe `Plan`, só `planMyId`/`planGalaxPayId`. Resultado: 100% das 345 assinaturas ativas estão com `plan_name=NULL`, então a IA recebe `[CELCASH] Assinatura #1: Plano — status active …` (sem nome). Sem nome de plano, a IA não consegue mapear "plano corte e barba" → `service_id` do "Don's Club corte e barba" e cai no fallback de serviço avulso.

Ou seja: **não é o prompt nem o webhook — é o sync que está incompleto.**

## Plano de correção

### 1. Buscar planos da CelCash no sync (`supabase/functions/sync-celcash-subscribers/index.ts`)

Antes de iterar pelas subscriptions, fazer 1 chamada por tenant em `GET /v2/plans?limit=100&startAt=0` (paginar se necessário), e montar um `Map<string, string>` com chaves `galaxPayId` e `myId` apontando para o `name` do plano.

Ao montar cada `row` da subscription, popular:
```ts
const planKey = String(s.planGalaxPayId ?? s.planMyId ?? "");
plan_name: planMap.get(planKey) || planMap.get(String(s.planMyId)) || null,
plan_id: String(s.planMyId ?? s.planGalaxPayId ?? "") || null,
```

### 2. Reexecutar o sync manualmente para o tenant Don Castro

Disparar `sync-celcash-subscribers` com `{ tenant_id: "fdbc80c3-…" }` e validar via SQL que `plan_name` ficou preenchido para o número 2868 e para a maioria das 345 ativas.

### 3. Hardening no bloco `[CELCASH]` (`whatsapp-webhook/index.ts`, função `formatCelCashContextBlock`)

Se `planName` vier vazio, mostrar `Plano #<plan_id>` em vez de apenas `Plano`, para nunca esconder a informação útil. (Salvaguarda — não substitui a correção do sync.)

### 4. Validação final

- Rodar `supabase--curl_edge_functions` em `lookup-celcash-subscriber` com o telefone 61983012868 e conferir o `plan_name` no JSON.
- Spawn de uma conversa de teste pelo simulador ou conferir logs do `whatsapp-webhook` (`[CelCash] Context injected …`) para garantir que o bloco agora cita o nome do plano.

## Fora do escopo

- Não vou mexer no prompt do Don Castro — ele já está correto.
- Não vou recriar tabelas nem mexer no cron — ele segue rodando a cada 1h e vai recarregar tudo certo após o fix.
