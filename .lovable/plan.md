
Diagnóstico

- Eu conferi os logs do webhook e o agendamento duplicado não veio de um webhook repetido.
- O que aconteceu foi isto:
  - 1ª criação: a IA chamou `criar_agendamento` logo depois que o cliente enviou só o horário `15:40` e criou o agendamento `485518287`.
  - 2ª criação: depois que o cliente respondeu `Sim`, a IA chamou `criar_agendamento` de novo e criou o `485518538`.
- Então a causa raiz é: hoje a regra de “esperar confirmação final” está só no prompt. No código, a ferramenta `criar_agendamento` ainda faz o POST sem uma trava real de confirmação e sem deduplicação.

Plano de correção

1. Endurecer `criar_agendamento` no código
- Antes de criar, validar no histórico recente se a última mensagem do cliente é uma confirmação explícita (`sim`, `ok`, `pode`, `isso`, etc.).
- Validar também se a assistente tinha acabado de mandar uma mensagem de confirmação do resumo do agendamento.
- Se não estiver nesse estado, a ferramenta não cria e devolve um bloqueio claro para a IA pedir confirmação em vez de agendar.

2. Adicionar trava anti-duplicidade no servidor
- Antes do POST, buscar os agendamentos ativos do cliente.
- Se já existir um agendamento ativo equivalente, não criar outro.
- Considerar como duplicado pelo menos: mesmo `clienteId`, mesmo `profissionalId` e mesma `dataHoraInicio` (e aproveitar `servicoId` quando vier consistente).
- Nesse caso, retornar o `id` já existente como sucesso deduplicado, para a IA não tentar recriar.

3. Aproveitar o ajuste no mesmo ponto crítico
- Em `criar_agendamento`, resolver o `clienteId` sempre pelo telefone da conversa, sem confiar no ID enviado pelo modelo.
- Normalizar `dataHoraInicio` antes de comparar/criar, para a checagem de duplicidade não falhar por diferença de formato.

4. Corrigir um ponto de contexto que aumenta risco de erro
- Ajustar a leitura do histórico para realmente usar as mensagens mais recentes da conversa, não as mais antigas.
- Isso reduz deriva de contexto e ajuda a IA a respeitar melhor o estado atual da confirmação.

Arquivos impactados

- `supabase/functions/whatsapp-webhook/index.ts`
- Possivelmente uma migration apenas se eu decidir adicionar uma proteção extra de replay por `message_id`, mas a correção principal do bug atual fica toda no webhook.

Como implementar

- Criar helpers no webhook para:
  - detectar confirmação explícita
  - ler a janela recente da conversa
  - resolver `clienteId` pelo telefone
  - localizar agendamento ativo equivalente
- Alterar o case `criar_agendamento` para:
  1. normalizar dados
  2. validar estado de confirmação
  3. checar duplicidade existente
  4. só então fazer o POST real

Validação

- Fluxo 1: cliente escolhe um horário (`15:40`) → a IA deve apenas confirmar, sem criar.
- Fluxo 2: cliente responde `Sim` → deve existir exatamente 1 criação.
- Fluxo 3: cliente manda `Sim` de novo ou a IA tenta repetir a chamada → não deve criar novo agendamento.
- Conferir nos logs que há no máximo um `criar_agendamento response (201)` para o mesmo slot.

Detalhes técnicos

- O ponto principal hoje está no case `criar_agendamento` de `executeTrinksTool()`.
- O prompt já manda “não agendar sem confirmação” e “não executar duas vezes”, mas isso não basta; precisa virar regra obrigatória no código.
- Vou manter a correção no backend do agente, sem depender de mudar o prompt do painel para resolver esse bug.
