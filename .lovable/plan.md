## Diagnóstico

Hoje, no painel, o "tempo total" é praticamente sempre `25s + processamento da IA`, porque a métrica é construída assim no `whatsapp-webhook`:

- `aiDurationMs` = só o tempo dentro de `callAIAgent` (chamada ao modelo + tools).
- `totalDurationMs` = `Date.now() - última_mensagem_do_lote`, mas com um `Math.max(..., DEBOUNCE_MS + aiDurationMs)` que **força o piso** em "debounce + IA".
- O log é gravado **antes** dos `fetch` para a UAZAPI (`/send/text`). Ou seja, o tempo até o cliente realmente receber a resposta nunca entra na conta.
- Resultado: praticamente todos os logs aparecem como `25s` (debounce) + alguns segundos de IA, mesmo quando, no mundo real, demorou 40s, 1min, etc.

Além disso, o frontend (`AgentLogs.tsx → getTimingMetrics`) ainda re-aplica `Math.max(configuredDebounceMs, storedDebounceMs)` e `Math.max(duration_ms, debounce + ai)`, o que mascara qualquer valor mais baixo ou diferente que viesse do banco.

## O que vou mudar

Quero medir e mostrar o tempo **real** percebido pelo cliente, sem pisos artificiais, com marcos claros.

### 1) Edge function `whatsapp-webhook` — medir os marcos certos

Capturar 4 timestamps por execução:

- `t_last_msg` = `created_at` da última mensagem do cliente no lote (já temos via `newestQueuedAtMsForTotal`).
- `t_debounce_end` = `Date.now()` logo após o claim das mensagens (fim do silêncio de 25s).
- `t_ai_done` = momento em que `callAIAgent` retorna (já temos via `agentResult.durationMs`).
- `t_first_send` = momento logo após o primeiro `fetch /send/text` da UAZAPI retornar OK (mover o log para depois desse envio).

A partir disso, calcular sem `Math.max` artificial:

- `debounce_wait_ms` = `t_debounce_end − t_last_msg` (real, pode ser 25s, 26s, 28s — o que de fato esperou).
- `ai_processing_ms` = `agentResult.durationMs` (modelo + tools internas).
- `uazapi_send_ms` = `t_first_send − t_ai_done` (tempo da UAZAPI até a resposta sair).
- `total_response_ms` = `t_first_send − t_last_msg` (tempo total que o cliente esperou da última mensagem dele até começar a receber a resposta).

Mover o `supabase.from("agent_logs").insert(...)` para **depois do primeiro `/send/text` bem-sucedido**, registrando esses 4 valores em `tool_calls[0].result` e em `duration_ms = total_response_ms`. Se o envio falhar, ainda assim logar com `uazapi_send_ms = null` e marcar erro.

Remover qualquer `Math.max(measuredTotalMs, DEBOUNCE_MS + aiDurationMs)` — o número precisa ser o real.

### 2) Frontend `AgentLogs.tsx` — mostrar os tempos exatos

Em `getTimingMetrics`, parar de aplicar `Math.max` defensivo. Ler diretamente de `tool_calls[0].result`:

- `total_response_ms` (badge principal do reloginho — "tempo total que o cliente esperou")
- `debounce_wait_ms`
- `ai_processing_ms`
- `uazapi_send_ms`

No card resumido (cabeçalho), o reloginho passa a mostrar `total_response_ms` em segundos (ex.: `47.2s total`).

No expandido, a linha "Meta" passa a mostrar 4 métricas separadas, com labels claros:

- `Total (cliente esperou): 47.2s`
- `Espera (debounce): 25.3s`
- `Processamento IA: 18.4s`
- `Envio WhatsApp: 3.5s`

Para logs antigos sem os novos campos, manter fallback ao `duration_ms` cru.

### 3) Sanidade dos timestamps no painel

Os timestamps `dd/MM HH:mm:ss` já existem (mensagem do cliente, mensagens do lote). Não mexer nesse ponto — só garantir que o `total` agora seja consistente com a diferença visível entre o `created_at` da última mensagem do cliente e o `created_at` do log.

## Detalhes técnicos

- Arquivo: `supabase/functions/whatsapp-webhook/index.ts`
  - Adicionar `const tDebounceEnd = Date.now();` logo após o `claim` bem-sucedido (~linha 750).
  - Capturar `const tAiDone = Date.now();` imediatamente após `await callAIAgent(...)` (~linha 847).
  - Mover o bloco `await supabase.from("agent_logs").insert(...)` (linhas 990-1022) para **depois** do primeiro `/send/text` no loop (~linha 1041), capturando `const tFirstSend = Date.now();` após o primeiro envio.
  - Substituir as fórmulas (linhas 982-988) pelas novas, sem `Math.max` defensivo.
- Arquivo: `src/pages/AgentLogs.tsx`
  - Reescrever `getTimingMetrics` para ler `total_response_ms`, `debounce_wait_ms`, `ai_processing_ms`, `uazapi_send_ms` diretamente.
  - Atualizar header (linhas 211-218) e Meta (linhas ~292-301) para exibir as 4 métricas.

## Sobre o erro do agendamento (IA escolhendo profissional sem listar)

Não vou misturar isso aqui — é outra causa (prompt/tool flow do Trinks). Posso abrir um plano separado depois que esse de monitoramento estiver de pé, porque vamos precisar dos novos tempos para diagnosticar se o problema é timeout/race ou prompt.