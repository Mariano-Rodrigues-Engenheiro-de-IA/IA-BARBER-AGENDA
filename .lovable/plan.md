# Auditoria de confirmações falsas + plano de correção só para a Bemp

Dados tirados direto de `agent_logs` e `chat_messages`. AppBarber e Frizzar: últimos 7 dias. Bemp: últimos 15 dias. Cada caso suspeito foi lido na conversa real antes de ser contado.

## 1. Números reais

| | AppBarber (7d) | Frizzar (7d) | Bemp (15d) |
|---|---|---|---|
| Atendimentos registrados | 1.091 | 347 | 1.287 |
| Clientes diferentes | 299 | 62 | 317 |
| Atendimentos com pedido de agendar, remarcar ou cancelar | 214 | 97 | 369 |
| Tentativas reais de agendar ou cancelar | 57 | 34 | 66 |
| Que deram certo | 50 | 32 | 60 |
| Que falharam | 7 | 2 | 6 |
| Respostas dizendo "confirmado/agendado" sem agendar no mesmo atendimento | 128 | 8 | 15 |
| Dessas, eram resposta a lembrete, a mensagem do atendente ou a agendamento já existente | ~118 | 7 | 10 |
| **Confirmações falsas comprovadas** | 0 que escaparam* | 0 | **2** (+2 sem como confirmar) |
| Recuperação automática (a trava pegou e a IA refez) | 19 tentativas: 4 agendaram, 3 passaram para a equipe, 4 ainda afirmaram sem agendar | 1 tentativa, 0 recuperadas | 2 tentativas, 0 recuperadas |

*AppBarber: a trava de "resposta prometia agendamento sem agendar" disparou 11 vezes e a de "horário que não existe na agenda" 2 vezes. Em 4 dessas o texto final ainda dizia confirmado, ou seja, falhou de vez.

### Os 2 casos comprovados da Bemp (mesmo padrão), reconstruídos pelo histórico completo da conversa
Os registros de atendimento da IA guardam só o que a IA respondeu. As mensagens que o atendente digitou pelo WhatsApp da barbearia ficam no histórico da conversa, cada uma com seu próprio código de mensagem.
- **26/09, Don Castro, 5521979845862 (horário UTC).**
  - 13:52 IA: "O Carlos tem 13h30, ou o Emerson tem 13h30 ou 14h. Qual prefere?"
  - 13:53 atendente: "Para hoje temos uma vaga as 13.30h com o profissional Carlos", depois "o Alan esta sem disponibilidade de horário na data de hoje" e "Gostaria de agendar?"
  - 14:18 cliente: "Quero sim, por favor / Profissional, Carlos"
  - IA: "Seu horário está confirmado..." sem nenhuma ferramenta.
- **01/10, Don Castro, 5521990396512 (horário UTC).**
  - 14:27:07 IA: "Prefere hoje ou amanhã?"
  - 14:27:10 atendente: "17h com o Alan, podemos confirmar?"
  - 14:27:31 cliente: "Pode sim 👍🏾"
  - IA: "Seu horário com o Alan às 17h está confirmado" sem nenhuma ferramenta.
  - O "17h" saiu da mensagem do atendente, não foi inventado pela IA. Mesmo assim, a IA nunca consultou se o Alan tinha 17h livre.
- **Sem como confirmar:** 24/09 (Abel, a IA só consultou a agenda) e 26/09 (Emerson, sem nenhuma ferramenta). Os dados não mostram se o atendente agendou por fora.

### Outros erros recorrentes nos mesmos registros
- **Mensagens não respondidas por etiqueta IA OFF:** 238 no AppBarber, 152 na Bemp e 44 na Frizzar. É o maior volume de "IA não respondeu" nas três.
- **Bemp: 6 falhas ao agendar, todas passadas para a equipe, sem mentira ao cliente.** Os motivos:
  - 3 recusas da própria Bemp: falta de crédito do plano; "Selecione um cliente para continuar", que é um agendamento enviado sem o cliente; e "Não foi possível realizar o seu agendamento", duas vezes seguidas para o mesmo cliente;
  - 2 bloqueadas por trava nossa: horário fora da lista oferecida e horário sem consulta prévia;
  - 1 chamada sem os dados obrigatórios.
- **Bemp: 3 consultas de serviço com unidade errada** ("salonId 1 não pertence às unidades válidas").
- **AppBarber:** 5 bloqueios por regra de negócio (plano não permite aquele dia), 4 casos com mais de um serviço onde a recuperação parou no meio ("1/2"), 4 agendamentos sem nome do cliente e 3 recusas de cancelamento por prazo.
- **Respostas vazias que ficaram em silêncio:** 17 no AppBarber, 4 na Bemp e 2 na Frizzar.

## 2. Por que a Bemp deixou passar
A trava de confirmação falsa é pulada quando a última mensagem antes do cliente foi do **atendente humano** e o cliente responde curto. Ela foi feita assim para não atrapalhar quem responde "ok" a um lembrete. Nos 2 casos, a última mensagem antes do "sim" do cliente era do atendente (13:53:55 e 14:27:10), e ele estava **oferecendo um horário novo** em forma de pergunta. Com a trava desligada, a IA respondeu "está confirmado" sem agendar.

**Os itens 2 e 3 sozinhos não resolveriam esses 2 casos.** Hoje a trava só age se, antes de tudo, a conversa não for "confirmação de atendente humano". Nos dois casos ela foi marcada assim, então nenhum detector chega a ser consultado. O item 1 é o que liga a trava nesses casos. Os itens 2 e 3 garantem que, uma vez ligada, ela reconheça "está confirmado" e obrigue a IA a agendar de verdade.

**Horário confirmado sem consulta (caso 2):** além de confirmar sem agendar, a IA aceitou um horário dado pelo atendente sem consultar a agenda. O item 1 já cobre isso: ao ser chamada de novo, a IA precisa consultar os horários e agendar. A ferramenta de agendar da Bemp também já recusa horário que não veio de uma consulta, como aconteceu em 21/09.

Além disso, a Bemp usa a lista antiga de frases de confirmação, que só reconhece a primeira pessoa ("agendei", "marquei"). "Seu horário está confirmado" passa despercebido. O AppBarber já tem um detector que reconhece essa forma desde o caso de 17/09. Na Frizzar não houve confirmação falsa comprovada, então não há o que aproveitar dela além da regra de obrigar a IA a chamar uma ferramenta quando ela é chamada de novo.

## 3. Plano de correção, só na Bemp

**O que é reaproveitado e por quê funciona lá:**
- **Detector de confirmação do AppBarber.** Reconhece "está confirmado", "ficou marcado" e "já deixei reservado", e ignora perguntas e negações. Desde que entrou, não houve confirmação comprovada escapando no AppBarber.
- **Ferramenta obrigatória na nova tentativa** (Frizzar e AppBarber). Quando a IA é chamada de novo, ela não pode responder só com texto. No AppBarber, todas as recuperações que deram certo vieram desse caminho. Na Bemp, as 2 novas tentativas foram em texto e não recuperaram nada.

**Mudanças, todas declaradas na configuração da Bemp:**
1. **Pergunta do atendente com horário novo conta como agendamento novo** (opção liga/desliga só na Bemp). Se a última mensagem humana é uma pergunta oferecendo um horário ("podemos confirmar?", "gostaria de agendar?", "pode ser às 17h?") e o cliente responde "sim", a trava passa a valer. Lembretes ("Este é um lembrete do seu agendamento...") e confirmações do atendente ("agendado para hoje...") continuam fora da trava.
2. **A Bemp passa a usar o detector de confirmação do AppBarber**, sem alterar o detector. Ele só vale fora do contexto de lembrete, que é o que já protege o texto padrão "seu horário está confirmado".
3. **A nova tentativa da Bemp passa a exigir ferramenta**, como na Frizzar e no AppBarber. Se ainda assim não agendar, a IA avisa o cliente que vai confirmar com a equipe e passa para o atendente. Nunca diz "confirmado".
4. **Agendar sem o cliente** ("Selecione um cliente para continuar"): antes de enviar, a ferramenta de agendar da Bemp confere se tem o código do cliente. Se faltar, devolve para a IA o motivo ("consulte ou cadastre o cliente primeiro"), em vez de mandar o pedido para a Bemp falhar.

Nada muda no AppBarber, na Frizzar, no OneBeleza ou no Trinks. Quem não declarar as opções novas continua exatamente como hoje.

## Detalhes técnicos
- `providers/bemp/index.ts → phantomGuardConfig`, campos opcionais novos:
  - `humanProposalIsNewBooking: true`
  - `claimDetector: appBarberClaimsCompletedBooking` (importado de `providers/appbarber/guard-core.ts`, sem alterar a função)
  - `recoveryToolChoice: "required"`
- `index.ts`, no ponto que monta `isHumanExistingBookingConfirmation` e `hasExplicitCreationClaim`: ler esses campos da configuração do provider. Os outros providers não declaram os campos, então o comportamento deles fica idêntico. A troca do atual `provider === "appbarber"` por `cfg.claimDetector` mantém o AppBarber igual.
- A pergunta humana de horário novo é reconhecida com o `isBookingTimeConfirmationPrompt` já existente, aplicado à mensagem do atendente, e com um filtro que exclui lembrete.
- Na ferramenta `agendar` da Bemp (`executeBempTool`): se não houver `clientId`, devolver `{ blocked: true, reason }` antes de chamar a API.
- Testes novos em `src/test/` com as frases reais dos 2 casos (devem disparar a trava), com o lembrete de 17/09 seguido de "👍" (não deve disparar) e com o "Pode sim / Fechado" de 21/09, que tinha agendamento anterior (não deve disparar).
- Publicar o `whatsapp-webhook` e acompanhar os registros da Bemp por 7 dias.

## Como comprovar
Reproduzir no simulador da Don Castro: mensagem humana "17h com o Alan, podemos confirmar?" e cliente "Pode sim". A IA tem que chamar `agendar` ou avisar que vai confirmar com a equipe, nunca dizer "confirmado" sem um código de agendamento. Um lembrete seguido de "ok" tem que continuar recebendo a confirmação normal.
