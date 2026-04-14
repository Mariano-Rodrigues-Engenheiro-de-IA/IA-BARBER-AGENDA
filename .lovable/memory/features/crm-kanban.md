---
name: CRM Kanban
description: CRM Kanban board driven by WhatsApp labels (UAZAPI), drag & drop moves leads, supports funnel stages + independent flags, bidirectional sync
type: feature
---
## CRM Kanban

- Tabela `crm_leads`: tenant_id, phone_number, label_id (funnel stage), flag_labels text[] (independent flags like IA OFF), notes
- Tabela `crm_lead_history`: auditoria de movimentação (from_label, to_label, changed_by ai/manual/whatsapp)
- Campo `kanban_columns` (jsonb) na tabela `tenants`: define colunas [{label_id, name, color, order, type}]
  - `type: "funnel"` = coluna do Kanban (etapa do funil)
  - `type: "flag"` = marcação independente (ex: IA OFF), aparece como badge no card
- Um lead pode estar em UMA etapa do funil E ter múltiplas flags simultaneamente

## Sincronização Bidirecional (WhatsApp ↔ Painel)
- **WhatsApp → Painel**: webhook `whatsapp-webhook` escuta evento `chats.update` do UAZAPI, lê `wa_label[]`, sincroniza funnel + flags no DB
- **Painel → WhatsApp (funnel)**: edge function `move-crm-lead` remove label antiga + adiciona nova via `/chat/labels`
- **Painel → WhatsApp (flags)**: `move-crm-lead` com `toggleFlag` param adiciona/remove flag via `/chat/labels` e atualiza DB
- UI: badges clicáveis no card do lead para toggle de flags (ativas mostram ✕, inativas mostram +)

## IA OFF
- Contato com flag "IA OFF" no CRM → webhook ignora mensagem, IA não responde
- Funciona com etiqueta nativa do WhatsApp ou adicionada via painel/ferramenta

## Outras
- Página `/tenants/:id/kanban`: Kanban drag & drop com @dnd-kit (só colunas funnel), flags como badges clicáveis
- Configuração das colunas no TenantForm (aba Kanban) com seletor Funil/Flag
