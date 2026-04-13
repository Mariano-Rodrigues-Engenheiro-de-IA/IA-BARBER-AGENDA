---
name: CRM Kanban
description: CRM Kanban board driven by WhatsApp labels (UAZAPI), drag & drop moves leads
type: feature
---
## CRM Kanban

- Tabela `crm_leads`: tenant_id, phone_number, label_id, label_name, notes (unique per tenant+phone)
- Tabela `crm_lead_history`: auditoria de movimentação (from_label, to_label, changed_by ai/manual)
- Campo `kanban_columns` (jsonb) na tabela `tenants`: define colunas [{label_id, name, color, order}]
- Webhook `whatsapp-webhook`: após `add_label`, faz upsert em `crm_leads` + insere `crm_lead_history`
- Edge function `move-crm-lead`: remove label antiga + adiciona nova via `/chat/labels`, atualiza DB
- Página `/tenants/:id/kanban`: Kanban drag & drop com @dnd-kit
- Configuração das colunas no TenantForm (aba Kanban)
