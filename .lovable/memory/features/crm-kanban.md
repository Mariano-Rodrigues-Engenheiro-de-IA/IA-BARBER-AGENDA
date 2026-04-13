---
name: CRM Kanban
description: CRM Kanban board driven by WhatsApp labels (UAZAPI), drag & drop moves leads, supports funnel stages + independent flags
type: feature
---
## CRM Kanban

- Tabela `crm_leads`: tenant_id, phone_number, label_id (funnel stage), flag_labels text[] (independent flags like IA OFF), notes
- Tabela `crm_lead_history`: auditoria de movimentação (from_label, to_label, changed_by ai/manual)
- Campo `kanban_columns` (jsonb) na tabela `tenants`: define colunas [{label_id, name, color, order, type}]
  - `type: "funnel"` = coluna do Kanban (etapa do funil)
  - `type: "flag"` = marcação independente (ex: IA OFF), aparece como badge no card
- Um lead pode estar em UMA etapa do funil E ter múltiplas flags simultaneamente
- Webhook `whatsapp-webhook`: após `add_label`, verifica tipo da coluna → funnel: upsert label_id | flag: adiciona a flag_labels
- Edge function `move-crm-lead`: remove label antiga + adiciona nova via `/chat/labels`, atualiza DB
- Página `/tenants/:id/kanban`: Kanban drag & drop com @dnd-kit (só colunas funnel), flags como badges
- Configuração das colunas no TenantForm (aba Kanban) com seletor Funil/Flag
