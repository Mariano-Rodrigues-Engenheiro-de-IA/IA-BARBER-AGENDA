# Plano de Correção — Auditoria Cruzada (Claude + Lovable)

## 0. Resposta ao ponto que você pediu pra olhar primeiro (Bemp fora dos dois guards)

**Foi efeito colateral, não decisão bem fundamentada.** Confirmo pela leitura do código atual:

- `MultiBookingGuard` (`index.ts:6710`): gated em `provider === "frizzar"`. O comentário no código justifica que "1 chamada = 1 pessoa/horário" nos outros providers, o que é **verdade só pra Camada 2 (contagem prometido vs. criado)** — a Camada 3 (mismatch texto↔execução) e o classificador de intenção (`classifyPendingBookings`) fariam sentido nos outros. Ao restringir o guard inteiro ao Frizzar, perdi as três camadas de uma vez.
- `PhantomConfirmationGuard` (`index.ts:6609`): gated em `["trinks","appbarber"]`. O comentário diz "sem bug observado nos outros" — mas seu histórico mostra que a Bemp foi **exatamente** onde o Phantom foi criado (caso Leonardo/avô, caso Vinícius 15h). A restrição feita hoje ignorou essa origem.

**Resultado real:** Bemp saiu dos dois guards ao mesmo tempo, e é o provider com mais bugs de alucinação confirmados hoje. Isso vira o item #1 do plano.

---

## 1. Achados novos que a Claude não pegou (independentes)

- **CancelGuard cego a `desmarcar_agendamento`** (`index.ts:6927`): o guard filtra só `tc.name === "cancelar_agendamento"`. OneBeleza usa `desmarcar_agendamento` como nome canônico da tool (`index.ts:8810`). Se a IA chama e falha, o Cancel**Guard não detecta** — IA pode afirmar cancelamento falso na OneBeleza sem trava alguma. **Crítico**, provider-específico.
- **`frizzarLastListed` é `Map` module-level** (`index.ts:10272`) — em multi-instância Deno o Map pode estar vazio na instância errada, gerando falso "não listou antes" e bloqueando agendamento legítimo. Alto, específico Frizzar.
- **`editar_agendamento` só existe em Trinks** — os outros 4 providers fazem cancel+create manualmente, sem trava para o cenário "cancelou o antigo, criar falhou". Crítico compartilhado (bate com o item 2 da sua lista, mas confirma o escopo real).
- **Retry de 429 só no `cancelar_agendamento` da Trinks** (`index.ts:9527`). `criar_agendamento` da Trinks e todos os outros providers não têm — a IA recebe erro cru e pode tentar de novo (duplicata). Confirma seu item 4.

Concordo com o resto do seu documento — não achei divergência estrutural.

---

## 2. Plano priorizado por risco real

### P0 — Correções mínimas de segurança (fazer agora)

1. **Devolver Bemp aos dois guards** (`index.ts:6609`, `6710`):
   - Adicionar `"bemp"` a `_phantomGuardProviders`.
   - Ampliar `MultiBookingGuard` para `["frizzar","bemp"]`, mantendo o clamp do classificador que já protege contra falso positivo de "prometidos" (o clamp de `bookedServiceNames` vs `agendamentos.length` já foi implementado hoje).
2. **CancelGuard reconhecer `desmarcar_agendamento`** (`index.ts:6927`, `6930`) — mudar o filtro para `["cancelar_agendamento","desmarcar_agendamento"]`. Fecha alucinação de cancelamento na OneBeleza (e cobre o alias da Bemp qualquer que seja a ordem).
3. **Trava de remarcação sem rollback** — introduzir função `guardReschedule` que, quando detecta no mesmo turno `cancelar_agendamento` OK + `criar_agendamento` (ou `agendar`) FALHA, força re-injeção pedindo à IA recriar o antigo com os dados originais (que estão no `sessionState`/`chat_messages`), sem escalar humano nem pedir dado ao cliente. Roda pros 5 providers. Não é `editar_agendamento` atômico — é rollback conversacional.

### P1 — Ownership e validação de ID (fazer em seguida)

4. **Ownership check no cancelamento** para Frizzar, AppBarber e OneBeleza (`index.ts:10679`, `11885`, `10046`): antes de executar, validar que o `agendamentoId` pertence ao telefone ativo (buscar lista do cliente e comparar). Trinks já faz via `trinksListActiveByClienteIds`. Padrão único, isolado por provider.
5. **Validação de servicoId/profissionalId contra catálogo** — Trinks e Frizzar já persistem catálogo em `sessionState`; falta adicionar guard de pré-execução em `criar_agendamento`/`agendar` bloqueando IDs fora do catálogo com mensagem devolvida à IA ("servicoId X não está no catálogo, use um destes: [...]"). Estender persistência do catálogo para OneBeleza, Bemp e AppBarber.

### P2 — Retry e idempotência em escrita

6. **Retry de 429 em `criar_agendamento`/`agendar`** pros 5 providers, reaproveitando o padrão já existente no `cancelar_agendamento` Trinks (`index.ts:9527`). Backoff exponencial curto (2 tentativas, 500ms/1500ms). Combinado com o dedupe de `agent_logs` que já existe (`index.ts:5545`), evita duplicata.
7. **`frizzarLastListed` migrar de Map módulo-level para `sessionState`** — chave `frizzarListedProfissionais` já usada em outros lugares. Fecha a janela de multi-instância.

### P3 — Consistência de contagem e casos raros

8. **Cancelamento multi-serviço com `.every()`** em vez de `.some()` (`index.ts:6930`) — se o cliente pediu cancelar 2 e só 1 caiu, IA precisa saber que faltou 1 e tentar de novo, mesma lógica do MultiBookingGuard mas do lado do cancel.
9. **`trinksResolveClienteIds` consolidar todos os IDs no `editar_agendamento`** (`index.ts:9555`) em vez de usar só `[0]`.
10. **Seção de remarcação no prompt Frizzar** — hoje nem existe. Após P0#3 (trava em código) faz sentido documentar o fluxo esperado no prompt também.

### Fora deste plano (fica pra depois)
- Refactor pra extrair providers em módulos separados (`_shared/providers/`) — mudança estrutural, requer sua aprovação explícita conforme regra do projeto.
- Testes automatizados — o projeto não tem suíte hoje; criar isso é escopo próprio.

---

## 3. Ordem de implementação nesta rodada

Vou fazer P0 (itens 1-3) e P1 (itens 4-5) agora, num commit por item, todos dentro de `supabase/functions/whatsapp-webhook/index.ts` (sem refactor estrutural, sem novos módulos). P2 e P3 num turno seguinte pra você conseguir isolar regressão se aparecer.

Ao final de cada item vou anotar aqui:
- o que mudou (linhas)
- por que
- qual teste manual/log confirmaria a correção

Depois você roda a nova varredura com a Claude em cima desse resultado.

---

## 4. Detalhes técnicos por item P0

### Item 1 — Devolver Bemp aos guards
- `index.ts:6609` — trocar `new Set(["trinks","appbarber"])` por `new Set(["trinks","appbarber","bemp"])`.
- `index.ts:6710` — trocar `provider === "frizzar"` por `["frizzar","bemp"].includes(provider)`.
- Deixar comentário explicando o histórico (por que não OneBeleza/AppBarber/Trinks no Multi).

### Item 2 — CancelGuard reconhecer desmarcar
- `index.ts:6926-6943` — introduzir `const CANCEL_TOOL_NAMES = new Set(["cancelar_agendamento","desmarcar_agendamento"])` e trocar as duas ocorrências de `tc?.name === "cancelar_agendamento"`.

### Item 3 — guardReschedule (rollback conversacional)
- Nova função pós-loop, antes do envio: detecta no turno atual pares (cancel OK, create FAIL) para o mesmo telefone; injeta system nudge forçando 1 rodada extra reusando dados do `chat_messages` e do `sessionState` (`trinksSelectedServiceId`, `frizzarLastListed`, etc.) pra recriar o antigo. Se falhar novamente, envia mensagem determinística: "Peraí, tive um problema técnico ao remarcar — vou refazer aqui e já te confirmo" (não escala humano, não pede dado).
- Fica gated pros 5 providers, mas só ativa se houver a combinação exata no mesmo turno.

### Item 4 — Ownership check no cancel (3 providers)
- Nas funções de execução de cancel/desmarcar de Frizzar/AppBarber/OneBeleza, adicionar chamada prévia à respectiva `listar_agendamentos_do_dia`/equivalente filtrando pelo telefone ativo, e comparar `agendamentoId`. Se não bater, devolver erro estruturado à IA: `{blocked: true, reason: "ownership_mismatch", validIds: [...]}`.

### Item 5 — Validação de servicoId/profissionalId
- Trinks/Frizzar: guard de pré-execução consultando `sessionState.*ServiceCatalog` já existente. Bemp/AppBarber/OneBeleza: adicionar persistência do catálogo após `listar_servicos`/`buscar_servicos` no `sessionState`, mesmo padrão dos outros.
