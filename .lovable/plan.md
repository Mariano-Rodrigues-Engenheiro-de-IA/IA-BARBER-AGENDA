
Objetivo

Blindar o fluxo da One Beleza contra alucinação de IDs em serviço, profissional, data, horário e agendamento. O melhor caminho não é “reforçar prompt”, e sim tirar da IA a responsabilidade de lembrar números.

Diagnóstico do problema atual

- Hoje o `sessionState` da One Beleza só existe dentro de uma única execução do webhook. Em cada nova mensagem do cliente, ele começa vazio.
- Nas próximas mensagens, a IA recebe só histórico textual de `chat_messages`; ela não recebe os resultados estruturados das ferramentas anteriores. Então ela tenta “lembrar” IDs pelo texto e pode trocar números.
- Isso aparece exatamente no caso que você relatou: nos logs, `buscar_barbeiros_por_servico` retornou `profissionalId=40658`, mas depois `buscar_horarios` foi chamado com `ProfissionalId=40659`, gerando 500.
- A blindagem atual está incompleta:
  - `agendar` já tem validação razoável.
  - `confirmar/desmarcar` já têm correção parcial de `agendasId`.
  - Mas `buscar_datas_disponiveis` e `buscar_horarios` ainda aceitam IDs alucinados antes da validação final.
- Ou seja: o erro acontece no meio do fluxo, antes de chegar na proteção mais forte.

Melhor caminho

Criar uma camada determinística de “estado estruturado da conversa + resolvedor de IDs” no backend.

Na prática:
- a IA escolhe a opção humana (“João Paulo”, “segunda”, “esse horário”);
- o backend traduz isso para IDs válidos;
- e qualquer chamada com ID errado é corrigida ou bloqueada antes de bater na API da One Beleza.

Plano de implementação

1. Persistir estado estruturado por conversa
- Criar uma tabela de estado por `tenant_id + phone_number`.
- Salvar nela:
  - serviços válidos retornados
  - profissionais válidos por serviço
  - datas válidas por serviço + profissional
  - slots válidos por serviço + profissional + data
  - agendas válidas do dia
  - seleção atual: serviço, profissional, data, slot e agenda-alvo
- Limpar esse estado quando o cliente mandar `❌`.
- Expirar estado antigo por inatividade.

2. Validar e corrigir IDs em todas as ferramentas One Beleza
- Antes de executar cada tool, criar uma camada de resolução:
  - `buscar_barbeiros_por_servico`: validar `servicosId`
  - `buscar_datas_disponiveis`: validar `servicosId + profissionalid`
  - `buscar_horarios`: validar `servicoId + ProfissionalId + date`
  - `agendar`: continuar exigindo slot exato
  - `confirmar_agendamento` / `desmarcar_agendamento`: usar agenda válida do estado
- Regra:
  - se houver 1 candidato válido, autocorrigir
  - se houver ambiguidade, bloquear e fazer a IA perguntar de novo
  - nunca deixar ID “suspeito” seguir para a API

3. Resolver escolhas por contexto, não por memória do modelo
- Quando o cliente responder:
  - “segunda”
  - “qualquer um”
  - “João Paulo”
  - “esse horário”
- o backend vai casar isso com o estado salvo da conversa.
- Assim, a IA não precisa lembrar que João Paulo era `40658`; o sistema já sabe.

4. Transformar remarcação em fluxo explícito
- Hoje a One Beleza não está blindada como fluxo completo de remarcação.
- Vou tratar remarcação como sequência determinística:
  - localizar agendamento correto
  - escolher novo slot válido
  - confirmar com o cliente
  - executar com IDs resolvidos pelo backend
- Isso evita improviso de agenda antiga + slot novo.

5. Melhorar observabilidade no Monitor do Agente
- Enriquecer `tool_calls` com:
  - `originalArgs`
  - `resolvedArgs`
  - `correctionReason`
  - snapshot resumido do estado usado
- No monitor, destacar quando:
  - um ID foi autocorrigido
  - uma chamada foi bloqueada
  - o valor veio do estado persistido
- Isso vai facilitar muito depurar casos reais.

6. Ajustar o prompt para a nova arquitetura
- Manter as regras de sequência.
- Reduzir a dependência de “copiar ID manualmente do retorno”.
- A regra principal passa a ser:
  - a IA escolhe a opção correta
  - o backend garante o ID correto

O que isso resolve no seu caso

- Depois que `buscar_barbeiros_por_servico` retorna `40658`, esse profissional fica salvo como seleção válida.
- Quando o cliente responde “pode ser segunda”, o próximo `buscar_horarios` não depende mais da IA lembrar o número.
- O backend reaproveita/corrige para `40658`.
- Resultado: para de acontecer o cenário `40659 -> 500 -> "tive um probleminha"`.

Detalhes técnicos

- Arquivo principal: `supabase/functions/whatsapp-webhook/index.ts`
- Mudança de banco: nova tabela de estado de conversa
- Blindagens já existentes e que serão reaproveitadas:
  - `reconcileOneBelezaAgendaId(...)`
  - `reconcileOneBelezaSchedulingArgs(...)`
  - `buildOneBelezaSchedulingValidationResult(...)`
- Principal lacuna atual:
  - o estado não sobrevive entre mensagens
  - e a validação não cobre as etapas intermediárias do fluxo

Validação depois da implementação

- Reproduzir o caso “João Paulo / segunda-feira” e confirmar uso consistente de `40658`
- Testar cancelamento, confirmação e remarcação
- Validar casos com mais de um agendamento no dia
- Conferir no Monitor do Agente quando houve autocorreção ou bloqueio
