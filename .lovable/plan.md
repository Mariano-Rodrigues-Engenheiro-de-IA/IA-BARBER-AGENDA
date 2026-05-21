## Objetivo
Eliminar a duplicação das mensagens da IA no painel de conversas do cliente.

## Diagnóstico confirmado
Encontrei evidência clara de que a duplicação nasce no webhook, não só na tela.

Caso recente do tenant `2b65801b-580b-4bc6-8527-fcd70524da2b`:
- Às `13:53:25`, a IA gravou uma resposta única no histórico: `Entendo, faz sentido... Me conta...`
- Em seguida, o envio foi dividido em `2` partes para o WhatsApp.
- Às `13:53:28` e `13:53:30`, o webhook recebeu os eventos `fromMe` dessas partes e gravou ambas como `assistant` com prefixo `[ATENDENTE HUMANO]: ...`
- Resultado: o painel mostra a resposta original da IA + os ecos do próprio envio, como se fossem mensagens extras.

Isso explica por que:
- a mensagem do cliente não duplica;
- a duplicação aparece só na resposta da IA;
- no painel surgem mensagens com prefixo `[ATENDENTE HUMANO]` logo após a resposta real.

## Plano de correção

### 1. Corrigir a origem no webhook
Arquivo principal:
- `supabase/functions/whatsapp-webhook/index.ts`

Vou ajustar a lógica de saída da IA para que o sistema trate como histórico apenas o que realmente foi enviado ao WhatsApp, evitando que o eco `fromMe` seja interpretado como mensagem manual do atendente.

Implementação:
- parar de gravar antecipadamente a resposta completa da IA como uma única linha em `chat_messages`;
- passar a gravar cada parte efetivamente enviada pela IA de forma controlada;
- usar o retorno do envio para associar `message_id` às mensagens da IA sempre que disponível;
- reforçar o filtro do ramo `fromMe` para ignorar qualquer mensagem que corresponda a partes recém-enviadas pela própria IA, em vez de tratá-la como `[ATENDENTE HUMANO]`.

Resultado esperado:
- mensagens automáticas da IA continuam aparecendo no histórico;
- ecos do WhatsApp não viram novas mensagens no banco;
- mensagens manuais reais do atendente continuam sendo registradas normalmente.

### 2. Blindar o painel do cliente
Arquivo principal:
- `src/pages/client/Conversations.tsx`

Mesmo corrigindo a origem, ainda existem registros já duplicados no banco. Então vou adicionar uma deduplicação defensiva na montagem da conversa.

Implementação:
- filtrar mensagens `assistant` com prefixo `[ATENDENTE HUMANO]:` quando elas forem eco da resposta anterior da IA;
- considerar proximidade de tempo + conteúdo equivalente/contido para não esconder mensagens humanas reais diferentes;
- manter a exibição limpa sem alterar o restante do layout.

Resultado esperado:
- o painel deixa de mostrar as duplicações já existentes;
- novas duplicações também deixam de aparecer.

### 3. Validar com o caso real que está falhando
Vou validar usando o mesmo padrão que apareceu nos logs:
- resposta única da IA dividida em 2 partes;
- chegada de eventos `fromMe` logo depois;
- conferência de que só aparecem as mensagens corretas na conversa.

## Detalhes técnicos
- Não pretendo mexer no banco para essa correção.
- A correção deve ficar concentrada em:
  - `supabase/functions/whatsapp-webhook/index.ts`
  - `src/pages/client/Conversations.tsx`
- O foco será separar corretamente:
  - mensagem automática da IA;
  - mensagem manual do atendente;
  - eco técnico do provedor de WhatsApp.

## Critério de sucesso
A conversa do cliente deve exibir apenas uma sequência lógica de mensagens:
- cliente fala;
- IA responde uma vez;
- sem blocos extras com `[ATENDENTE HUMANO]` duplicando o que a IA acabou de mandar.