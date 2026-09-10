# Blindagem completa do AppBarber

## Objetivo
Eliminar os caminhos conhecidos em que o fluxo pode confirmar parcialmente, ignorar uma segunda pessoa/serviço, repetir uma criação ou deixar uma alegação falsa passar. A mudança ficará restrita ao AppBarber e à orquestração dos guards já existente.

> “Zero erro” não pode ser garantido contra indisponibilidade da API ou comportamento futuro do modelo, mas o sistema deixará de depender apenas do modelo para validar esses cenários e falhará de forma segura quando não puder comprovar a operação.

## Implementação

1. **Representar deterministicamente o pedido pendente**
   - Extrair do histórico completo sinais de quantidade, pessoas e serviços solicitados.
   - Persistir no estado da conversa o que foi pedido e o que já foi concluído, para a segunda mensagem não apagar a obrigação original.
   - Tratar “para mim e meu filho”, “dois cortes”, nomes distintos e dois horários como duas criações obrigatórias.

2. **Corrigir o fluxo de múltiplas pessoas**
   - Permitir uma chamada separada para cada pessoa, inclusive usando o mesmo telefone do responsável quando aceito pela API.
   - Não substituir o nome do filho/dependente pelo nome do titular da conversa.
   - Se faltar o nome da segunda pessoa, confirmar somente o primeiro e perguntar o nome, sem afirmar que o pedido inteiro terminou.
   - Depois da resposta com o nome, retomar apenas o agendamento pendente, sem repetir o já criado.

3. **Corrigir múltiplos serviços**
   - Remover a contradição que ainda oferece `services[]` múltiplo no formato da ferramenta, apesar da API exigir chamadas separadas sem combo.
   - Para serviços sem combo, exigir uma criação por serviço em horários consecutivos validados.
   - Para combo real do catálogo, manter uma única criação.

4. **Tornar o MultiBookingGuard fail-closed**
   - Evidência determinística de múltiplos sempre terá precedência sobre classificador, filtro barato e clamps.
   - Nenhum clamp poderá reduzir duas pessoas/serviços comprovados para uma criação.
   - Habilitar recuperação após sucesso parcial somente quando existir item pendente identificado e ainda não concluído.
   - Bloquear chamadas extras depois que cada item pendente tiver sido concluído, preservando o ledger/dedupe existente.

5. **Fechar os demais guards AppBarber**
   - Tirar PhantomCancel e StaleConfirmation do modo apenas observação após validar os casos legítimos.
   - PhantomConfirmation não deixará alegação explícita de criação passar apenas por falta de evidência auxiliar.
   - CancelGuard e RescheduleGuard usarão sucesso real da ferramenta, não apenas ausência de `error`.
   - Substituir mensagens que prometem retorno futuro sem execução real por respostas honestas e acionamento comprovado quando necessário.

6. **Testes e simulação**
   - Adicionar regressões para: Mariano pai+filho; dois cortes; dois serviços da mesma pessoa; combo real; criação parcial; nome da segunda pessoa ausente; retomada na mensagem seguinte; 422 de limite; conflito de horário; retry 429; dedupe; cancelamento/remarcação parcial; confirmação preexistente e intervenção humana.
   - Simular os eventos AppBarber recentes e comprovar: nenhum múltiplo genuíno liberado como único, nenhuma criação concluída repetida e nenhuma confirmação total com pedido parcial.
   - Rodar os testes existentes para garantir que Frizzar e os demais providers não mudaram.

7. **Publicação e observabilidade**
   - Publicar somente `whatsapp-webhook`, mantendo `verify_jwt = false`.
   - Registrar no log a expectativa estruturada, itens concluídos, itens pendentes e decisão de cada guard para auditoria posterior.

## Critérios de aceite

- “Para mim e meu filho” exige duas criações; se faltar o nome do filho, pergunta e retoma apenas a pendência.
- “Dois cortes” nunca é reduzido para um por classificador, filtro ou clamp.
- Um sucesso parcial nunca gera confirmação total.
- Uma falha não provoca repetição ilimitada ou duplicação.
- Confirmação, cancelamento e remarcação só são afirmados com resultado real correspondente.
- Testes AppBarber e regressões dos outros providers permanecem aprovados.
