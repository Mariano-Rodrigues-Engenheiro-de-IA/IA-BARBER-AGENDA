## Objetivo
Garantir que a IA da One Beleza agende sempre no cliente correto da conversa, sem cair no cliente dono da conta.

## Diagnóstico confirmado
Pelos logs atuais, o fluxo já encontra o cliente certo antes de agendar:
- `buscar_cliente` para o número do MZ retorna `cliforcolsid: 47417`
- o `agendar` também registra `resolved cliente: cliforcolsid=47417`
- mesmo assim, o agendamento continua sendo atribuído ao dono da conta

Isso indica que o problema não é mais “achar o cliente”, e sim “como o request final de agendamento está sendo montado/enviado para a One Beleza”. Hoje o código ainda depende de um request ambíguo: usa o `celular` da conta no endpoint e tenta forçar o cliente via multipart, mas a API aparentemente está ignorando esse vínculo.

Também identifiquei uma inconsistência real no código: o auto-cadastro da One Beleza considera cliente existente só se vier `clienteId` ou `id`, mas o retorno real do `buscar_cliente` vem com `cliforcolsid`. Isso mostra que o tratamento do identificador do cliente está inconsistente em partes diferentes do fluxo.

## Plano
### 1) Centralizar o ID real do cliente da One Beleza
No `whatsapp-webhook`, vou criar uma resolução única de cliente para One Beleza que:
- normalize o telefone do WhatsApp
- busque o cliente pelo telefone
- extraia sempre o ID em ordem de prioridade consistente (`cliforcolsid`, `cliForColsId`, `cliForColsid`, etc.)
- retorne um objeto padronizado com `clientId`, `phone`, `name` e payload bruto

Isso evita que cada trecho use uma lógica diferente para descobrir o cliente.

### 2) Persistir o cliente resolvido no estado da conversa
Vou adicionar ao `conversation_state` em memória da função algo como:
- `selectedClientId`
- `selectedClientPhone`
- `selectedClientName`

E vou alimentar isso sempre que:
- `buscar_cliente` retornar sucesso
- `cadastrar_cliente` criar/encontrar um cliente
- houver auto-registro da One Beleza

Assim, o fluxo inteiro passa a trabalhar com o cliente da conversa já travado, em vez de depender só de nova busca na hora do agendamento.

### 3) Travar o `agendar` para usar somente o cliente da conversa
No case `agendar` da One Beleza, vou alterar a regra para:
- usar primeiro o `selectedClientId` persistido na sessão
- se não existir, resolver novamente por telefone
- bloquear o agendamento se houver divergência entre cliente da sessão e cliente resolvido por telefone
- bloquear se o cliente não existir

Ou seja: se a conversa é do MZ, o `agendar` só segue se o cliente final for o MZ.

### 4) Reestruturar o request final do agendamento
Vou ajustar a montagem do request para eliminar ambiguidade do lado da One Beleza:
- revisar os campos enviados no `FormData`
- enviar apenas o conjunto de chaves que fizer sentido para o cliente real, em vez de múltiplos aliases soltos sem validação
- garantir que o payload de agendamento use explicitamente o ID resolvido da conversa como fonte da verdade
- manter logs detalhados do payload final enviado

A meta aqui é parar de “tentar vários nomes” e passar a montar um request determinístico.

### 5) Corrigir a detecção de cliente existente no auto-cadastro
Vou corrigir o trecho de auto-registro da One Beleza para reconhecer cliente existente também quando o retorno vier com:
- `cliforcolsid`
- `cliForColsId`
- `cliForColsid`

Isso evita falso negativo de “cliente não existe” e remove comportamento inconsistente no começo do fluxo.

### 6) Melhorar os logs para auditoria definitiva
Vou deixar os logs do `agendar` mais explícitos, registrando:
- telefone normalizado da conversa
- cliente retornado pelo `buscar_cliente`
- `selectedClientId` da sessão
- cliente efetivamente enviado no request
- campos finais do payload de agendamento
- motivo de bloqueio em caso de divergência

Assim fica fácil provar no monitor se a IA usou o cliente certo ou não.

## Validação após a correção
Depois de implementar, vou validar no fluxo real:
1. mensagem do cliente entra
2. `buscar_cliente` resolve o ID correto
3. esse ID fica salvo na sessão
4. `agendar` usa exatamente esse mesmo ID
5. os logs mostram o cliente final usado no request
6. o agendamento deixa de cair no dono da conta

## Detalhes técnicos
Arquivos principais:
- `supabase/functions/whatsapp-webhook/index.ts`

Ajustes previstos:
- ampliar `AgentSessionState`
- atualizar `loadConversationState()` e `saveConversationState()`
- capturar cliente ao processar `buscar_cliente` / `cadastrar_cliente`
- criar helper único de resolução do cliente One Beleza
- endurecer o `case "agendar"` para usar o cliente da sessão como verdade
- corrigir a heurística de cliente existente no auto-registro
- reforçar logs do tool call

Se você aprovar, eu implemento isso agora.