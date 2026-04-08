---
name: AI Agent WhatsApp
description: AI agent via WhatsApp using UAZAPI + Lovable AI + Trinks API tool-calling
type: feature
---
- WhatsApp integration via UAZAPI (subdomain: zyloia)
- Edge function: whatsapp-webhook receives messages, processes with Lovable AI (gemini-2.5-flash), responds via UAZAPI
- 10 tools: buscar_cliente, cadastrar_cliente, listar_profissionais, listar_servicos, listar_servicos_profissional, listar_horarios, buscar_agendamento, criar_agendamento, cancelar_agendamento, editar_agendamento
- listar_horarios endpoint: GET /agendamentos/profissionais/{data}?servicoDuracao={min} — returns horariosVagos (IGNORE intervalosVagos)
- cancelar_agendamento: PATCH /agendamentos/{id}/status/cancelado with {quemCancelou: 1, motivo: "..."}
- editar_agendamento: PUT /agendamentos/{id} with full body
- buscar_agendamento: GET /agendamentos?clienteId={id} — also accepts telefone param, auto-resolves clienteId
- Conversation history stored in chat_messages table (tenant_id + phone_number), last 60 msgs
- Trinks API base URL: https://api.trinks.com/v1, auth via X-Api-Key + estabelecimentoId header
- UAZAPI API: POST /send/text with header "token"
- System prompt adapted from n8n production prompt (Bendita Barber Club style)
- Tool call rounds: up to 8
- Brasília timezone (UTC-3) injected in prompt
- ❌ emoji resets conversation memory for that user
