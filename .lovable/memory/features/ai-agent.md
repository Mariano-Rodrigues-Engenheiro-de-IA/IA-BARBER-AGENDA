---
name: AI Agent WhatsApp
description: AI agent via WhatsApp using UAZAPI + Lovable AI + multi-provider tool-calling (Trinks, One Beleza, None) + custom tools
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
- Auto-correction: reconcileOneBelezaAgendaId auto-corrects hallucinated agendasId values

## None Provider
- No scheduling tools, just enviar_link_agendamento
- Uses tenant.booking_link to send scheduling URL

## Custom Tools (Dynamic per Tenant)
- Stored in `tenants.agent_settings.custom_tools[]` (JSONB)
- Each tool: { id, name, display_name, description, type, config, prompt_instruction, enabled }
- Types: send_text, send_image, send_audio, send_location, send_document, send_link, escalate_human
- Injected dynamically into buildToolsForProvider() as OpenAI tool definitions
- Executed via executeCustomTool() → UAZAPI endpoints (/send/text, /send/media, /send/location)
- Prompt instructions injected into buildSystemPrompt() as "FERRAMENTAS CUSTOMIZADAS" section
- UI: CRUD in TenantForm.tsx "Ferramentas" tab with templates (PIX, Localização, Catálogo, Link, Escalar Humano)

## UAZAPI v2 Endpoints
- Media download: POST /message/download with body {id: messageId} (fallback: GET /message/download/{id})
- Send text: POST /send/text with JSON {number, text}
- Send media: POST /send/media with JSON {number, type, file, caption} — type: "image"|"ptt"|"document", file = URL
- Send location: POST /send/location with JSON {number, latitude, longitude, name, address}

## Common
- Conversation history stored in chat_messages table (tenant_id + phone_number), last 60 msgs
- System prompt adapted per provider with shared base (date, tone, rules)
- Tool call rounds: up to 8
- Brasília timezone (UTC-3) injected in prompt
- ❌ emoji resets conversation memory for that user
- Debounce: 10s window, atomic claim
