## Objetivo
Impedir que a IA responda "tá tudo certo" quando prometeu N agendamentos (2–3) e executou menos. Escalar humano quando N>3. Constante: `MAX_AUTO_BOOKINGS = 3`.

## Onde vive tudo
Dentro de `supabase/functions/whatsapp-webhook/index.ts`, na seção depois do loop de tool-calling e antes do envio via UAZAPI. Reaproveita `BookingGuard`, `recordCompletedAction` e `conversation_state` existentes.

## Gatilho
Após o loop de tool-calls do turno, verificar se **houve pelo menos 1 chamada da tool `agendar` OU `criar_agendamento`** nesse turno (independente de sucesso, independente do texto de saída).
- Se **não** → libera resposta normal, não roda nenhuma das camadas novas.
- Se **sim** → roda Camada 1 (lazy) + Camada 2 (guard) + Camada 3 (mismatch).

## Camada 1 — Classificador de intenção (lazy)
Nova função `classifyPendingBookings(historyWindow)` inline no arquivo.
- Input: janela das últimas 6 mensagens (client + assistant, sem tool_calls).
- LLM: mesmo modelo do agente (`openai/gpt-5-mini`), `temperature: 0`, `response_format: json_object`.
- Prompt curto em PT-BR: "Quantos agendamentos distintos (por pessoa, serviço ou horário) o cliente confirmou nesta janela? Considere 'sim'/'pode'/'beleza' como aceite da oferta imediatamente anterior da IA. Retorne JSON: `{ total_bookings_requested: number, reasoning: string }`."
- Persiste `pending_bookings` em `conversation_state` pra não reclassificar no mesmo turno.
- Timeout curto (5s); se falhar, cai pra fallback determinístico = `max(1, chamadas_de_agendar_no_turno)`.

## Camada 2 — Guard de completude (contagem CORRIGIDA por provider)

Função `countSuccessfulBookingsInTurn(toolCalls, provider)` inline, com regras específicas por provider (validadas contra o código real):

| Provider | Tool name | Critério de sucesso | Critério de bloqueio (NÃO contar) |
|---|---|---|---|
| **Trinks** | `criar_agendamento` | resposta crua da API (`JSON.parse` do body); assumir sucesso se **não** tem `error`, **não** tem `blocked`, **não** tem `code` de erro | `blocked: true` (inclui caso `id: "duplicate"`), `error` presente, `status >= 400` |
| **OneBeleza** | `agendar` | `success: true` (SEMPRE presente no sucesso, único critério confiável) | `blocked: true`, `error` presente, `conflict: true`. **NÃO usar `id`** (vem como boolean `true` às vezes) |
| **Frizzar** | `agendar` | `ok: true` + `agendamentoId` presente. **Contar `agendamentos.length`** (array de bookings criados, 1 por serviço), não 1 por chamada | `error` presente, `ok` ausente |
| **Bemp** | `agendar` (não `criar_agendamento`) | `ok: true` (do wrap `{ ok: true, ...parsed }`) | `blocked: true`, `error` presente, `subscription_overdue` |
| **AppBarber** | `criar_agendamento` | `ok: true` + `appointment_id` truthy | `error` presente, `status >= 400`, `recoverable: true` |

**Regra transversal em todos os providers:** `tc.result.blocked === true` OU `tc.result.error` presente → nunca conta como sucesso.

Comparação:

| Caso | Ação |
|---|---|
| `criados >= prometidos` | Libera resposta normal |
| `criados < prometidos` **e** `prometidos ≤ 3` | Bloqueia resposta, re-injeta 1 turno forçado ("Faltam X agendamentos dos Y prometidos ao cliente. Execute as chamadas restantes agora. NÃO responda ao cliente até completar.") — máximo 1 re-injeção |
| Re-injeção falhou (ainda faltam) | Envia resposta determinística parcial: "Consegui confirmar [lista dos criados]. Ainda preciso confirmar [lista dos que faltam] — pode me ajudar aí?" |
| `prometidos > 3` | Bloqueia loop imediatamente (antes até de tentar), envia msg fixa de escalada humana, marca `conversation_pauses` com motivo `multi_booking_overflow` |

Msg fixa de escalada: *"Pra 4 ou mais agendamentos na mesma conversa prefiro te passar pro atendimento humano pra não errar nenhum — só um momento."*

## Camada 3 — Mismatch resposta ↔ execução
Se após Camada 2 ainda tem `criados < prometidos` **e** o texto final da IA contém regex de confirmação total (`/confirm|agendei|marquei|pronto|t[aá]\s+marcado|feito|show|te\s+espero/i`), força o mesmo caminho de bloqueio (resposta determinística parcial). Rede de segurança pro caso de a Camada 1 subestimar.

## Migration
Adicionar coluna `pending_bookings jsonb` em `conversation_state` (opcional, default null) — apenas cache pra evitar reclassificar.

## Logs
Cada acionamento vira uma entrada em `tool_calls` do `agent_logs`:
```
{ layer: "multi_booking_guard", provider, prometidos, criados, criados_por_tool: [...], acao: "released"|"reinject"|"partial_fallback"|"human_escalation", classifier_source: "llm"|"fallback" }
```

## Fora de escopo
- Refactor de providers pra interface comum
- Extração de helpers pra `_shared/`
- Camada 1 always-on
- Mudar modelo de IA
- Tocar em `src/lib/booking.ts` (frontend, sem relação com o guard)

## Ordem de implementação
1. Migration `pending_bookings` em `conversation_state`
2. `countSuccessfulBookingsInTurn` com a tabela por provider acima
3. `classifyPendingBookings` (lazy, gatilho = houve chamada de agendar/criar_agendamento no turno)
4. Guard + re-injeção + fallback determinístico + escalada humana
5. Camada 3 (regex mismatch)
6. Teste no simulador com casos: 1 booking simples, "sim" seco pra 2 horários, 3 serviços diferentes (corte+barba+sobrancelha), 4+ (escalada). Rodar em pelo menos 2 providers diferentes (Frizzar por causa do array + um sem-array, ex Bemp ou Trinks).

## Critério de aceite
Não é "compilou". É: no simulador, cenário "IA oferece 14h e 15h, cliente responde só 'sim'" produz **2 agendamentos** ou **resposta determinística explícita de que faltou 1** — nunca "tá tudo certo" silencioso.