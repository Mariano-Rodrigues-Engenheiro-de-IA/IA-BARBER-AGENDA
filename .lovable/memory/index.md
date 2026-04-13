# Project Memory

## Core
SaaS multi-tenant para salões de beleza/barbearias. Dark theme, primary #3B82F6, accent #10B981.
Inter font. Lovable Cloud backend. Portuguese-BR UI.
Integração API Trinks para agendamento. WhatsApp futuro.
UAZAPI docs: https://docs.uazapi.com — SEMPRE consultar antes de implementar/testar endpoints.

## Memories
- [Design tokens](mem://design/tokens) — Dark theme, glass-card utility, glow effects
- [Tenant model](mem://features/tenants) — Multi-tenant with Trinks API credentials, agent config
- [Auth flow](mem://features/auth) — Admin-only via user_roles table with has_role() function
- [UAZAPI Labels](mem://features/uazapi-labels) — Endpoint /chat/label usa campo `jid`, funciona como toggle
