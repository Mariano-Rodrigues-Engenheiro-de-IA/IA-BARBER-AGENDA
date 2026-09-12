# Project Memory

## Core
SaaS multi-tenant para salões de beleza/barbearias. Dark theme, primary #3B82F6, accent #10B981.
Inter font. Lovable Cloud backend. Portuguese-BR UI.
Integração API Trinks para agendamento. WhatsApp futuro.

## Memories
- [Design tokens](mem://design/tokens) — Dark theme, glass-card utility, glow effects
- [Tenant model](mem://features/tenants) — Multi-tenant with Trinks API credentials, agent config
- [Auth flow](mem://features/auth) — Admin-only via user_roles table with has_role() function
- [Monitor 24h da IA](mem://features/ai-audit-monitor) — Edge Function audit-monitor, achados com prova, tela /ai-monitor
- [AI Agent](mem://features/ai-agent) — WhatsApp chatbot with custom tools, debounce, media
- [UAZAPI Labels](mem://features/uazapi-labels) — POST /chat/labels with add_labelid/remove_labelid, number field
- [CRM Kanban](mem://features/crm-kanban) — Kanban board driven by WhatsApp labels, drag & drop, crm_leads + crm_lead_history tables
