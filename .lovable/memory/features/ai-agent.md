---
name: AI Agent WhatsApp
description: AI agent via WhatsApp using UAZAPI + Lovable AI + multi-provider tool-calling (Trinks, One Beleza, None)
type: feature
---
- WhatsApp integration via UAZAPI (subdomain: zyloia)
- Edge function: whatsapp-webhook receives messages, processes with Lovable AI (gemini-2.5-flash), responds via UAZAPI
- **Multi-provider architecture**: tenant.api_provider enum (trinks | onebeleza | none)
- Tenant lookup: matches by whatsapp_number, fallback to first active tenant
- Provider dispatcher: buildToolsForProvider() + executeToolForProvider()

## Trinks Provider
- 10 tools: buscar_cliente, cadastrar_cliente, listar_profissionais, listar_servicos, listar_servicos_profissional, listar_horarios, buscar_agendamento, criar_agendamento, cancelar_agendamento, editar_agendamento
- listar_horarios endpoint: GET /agendamentos/profissionais/{data}?servicoDuracao={min} — returns horariosVagos (IGNORE intervalosVagos)
- cancelar_agendamento: PATCH /agendamentos/{id}/status/cancelado with {quemCancelou: 1, motivo: "..."}
- editar_agendamento: PUT /agendamentos/{id} with full body
- Trinks API base URL: https://api.trinks.com/v1, auth via X-Api-Key + estabelecimentoId header

## One Beleza Provider
- 10 tools: buscar_cliente, cadastrar_cliente, buscar_servicos, buscar_barbeiros_por_servico, buscar_datas_disponiveis, buscar_horarios, agendar, buscar_agendamentos_dia, confirmar_agendamento, desmarcar_agendamento
- API base: https://onechatbotapi.azurewebsites.net, auth via Bearer Token
- Cadastro uses different host: https://onetotemapi.azurewebsites.net
- celular param fixed per tenant (onebeleza_celular)
- agendar uses multipart/form-data (POST)
- desmarcar uses DELETE method
- Sequential flow: Servico → Barbeiro → Datas → Horarios → Agendar

## None Provider
- No scheduling tools, just enviar_link_agendamento
- Uses tenant.booking_link to send scheduling URL

## Common
- Conversation history stored in chat_messages table (tenant_id + phone_number), last 60 msgs
- UAZAPI API: POST /send/text with header "token"
- System prompt adapted per provider with shared base (date, tone, rules)
- Tool call rounds: up to 8
- Brasília timezone (UTC-3) injected in prompt
- ❌ emoji resets conversation memory for that user
- Debounce: 10s window, atomic claim
