## Objetivo
Fazer o lead cair no funil correto quando a etiqueta for adicionada direto no WhatsApp.

## O que os logs mostram
- O webhook está ativo e recebendo a atualização de etiqueta.
- No caso testado, o webhook recebeu a etiqueta `10` para o contato `556999234914`.
- Para o tenant `BAREBARIA DO REGIS`, o CRM configurado no banco usa as etiquetas `24`, `25`, `26` e `27`.
- O lead continua salvo com `label_id = "__none__"`, então o painel não tem como exibi-lo em nenhuma coluna.
- A etiqueta `10` existe, mas está cadastrada em outro tenant (`BENDITA BARBER`), o que indica divergência entre a etiqueta aplicada no WhatsApp e a configuração do CRM desse cliente.

## Plano
1. Corrigir a identificação do tenant no bloco de sync de etiquetas.
   - Hoje ele prioriza tenant por lead existente e ainda usa um critério legado baseado em `tenants.kanban_columns`.
   - Vou ajustar para priorizar o tenant pelo número dono da instância (`owner/whatsapp_number`) e validar boards reais em `crm_boards`, evitando associação errada quando o mesmo telefone aparece em mais de um tenant.

2. Remover o critério legado incorreto do label sync.
   - O código ainda tenta preferir tenants com `tenants.kanban_columns.length > 0`, mas esse projeto já usa `crm_boards`.
   - Vou trocar essa preferência por verificação real de colunas em `crm_boards`.

3. Tornar o diagnóstico explícito no webhook.
   - Adicionar logs com:
     - tenant escolhido,
     - IDs de etiquetas configuradas no CRM escolhido,
     - origem do match do tenant,
     - motivo do ignore quando a etiqueta do WhatsApp não pertence ao funil configurado.
   - Isso evita novo ciclo cego de tentativa e erro.

4. Proteger contra etiqueta válida em tenant errado.
   - Se a etiqueta recebida existir em outro tenant, o log vai apontar isso claramente.
   - Se necessário, vou bloquear o match por lead antigo quando ele conflitar com o owner da instância.

5. Validar após ajuste.
   - Conferir logs novos do `whatsapp-webhook`.
   - Confirmar que uma etiqueta aplicada no WhatsApp para esse tenant vira `label_id` correto em `crm_leads` e passa a aparecer na coluna do painel.

## Detalhes técnicos
- Arquivo principal: `supabase/functions/whatsapp-webhook/index.ts`
- Ponto crítico atual:
```text
Etiqueta recebida: 10
Etiquetas do board do tenant testado: 24, 25, 26, 27
Resultado: webhook ignora a etiqueta e o lead fica com __none__
```
- A causa mais provável agora não é o painel, e sim:
  - etiqueta errada aplicada no WhatsApp para esse tenant, e/ou
  - tenant sendo resolvido de forma errada no webhook em cenários com telefone repetido entre tenants.

## Resultado esperado
Depois do ajuste, o webhook deve sempre resolver o tenant correto, comparar contra os boards corretos e mover o lead para a etapa certa quando a etiqueta do WhatsApp corresponder ao funil configurado.