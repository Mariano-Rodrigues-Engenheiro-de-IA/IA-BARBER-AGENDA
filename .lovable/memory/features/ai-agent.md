---
name: AI Agent WhatsApp
description: AI agent via WhatsApp using UAZAPI + Lovable AI + multi-provider tool-calling (Trinks, One Beleza, None) + custom tools + follow-up system + persistent state
type: feature
---
- WhatsApp integration via UAZAPI (subdomain: zyloia)
- Edge function: whatsapp-webhook receives messages, processes with Lovable AI (gemini-2.5-flash), responds via UAZAPI
- **Multi-provider architecture**: tenant.api_provider enum (trinks | onebeleza | none)
- Tenant lookup: matches by whatsapp_number, fallback to first active tenant
- Provider dispatcher: buildToolsForProvider() + executeToolForProvider()

## Persistent Conversation State (One Beleza)
- Table: conversation_state (tenant_id + phone_number, unique)
- Persists: services, professionals, slots, selected IDs across messages
- Loaded at start of callAIAgent(), saved after all tool rounds
- Expires after 2 hours of inactivity
- Cleared on ❌ reset alongside chat_messages

## ID Resolution Layer (One Beleza)
- resolveOneBelezaToolArgs() validates/corrects IDs before API calls
- Covers: buscar_barbeiros_por_servico, buscar_datas_disponiveis, buscar_horarios, agendar
- Uses persisted state to auto-correct hallucinated IDs
- Single valid option → auto-correct; ambiguous → block with valid options
- Enhanced logging: originalArgs, resolvedArgs, correctionReason in tool_calls

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

## Follow-up System (None Provider)
- Table: follow_ups (tenant_id, phone_number, status, follow_up_at, follow_up_message)
- Status flow: pending → sent | confirmed | expired
- When enviar_link_agendamento executes, creates follow-up record with configurable delay
- Client confirmation detected via regex patterns (agendei, marquei, confirmei, etc.)
- Edge function: process-followups runs via pg_cron every 5 min
- Configurable per tenant in agent_settings.follow_up: { enabled, delay_minutes, message }
- Default: enabled, 30 min delay, 1 follow-up max
- UI in TenantForm "Integração API" tab under "none" provider

## Custom Tools (Dynamic per Tenant)
- Stored in `tenants.agent_settings.custom_tools[]` (JSONB)
- Each tool: { id, name, display_name, description, type, config, prompt_instruction, enabled }
- Types: send_text, send_image, send_audio, send_location, send_document, send_link, escalate_human, send_combo
- send_combo: sends multiple items (text, image, audio, document, location) sequentially with 800ms delay
  - config.combo_items[]: { id, type, config } — each item has its own type and config
  - UI: ComboConfigFields with add/remove/reorder items
- Injected dynamically into buildToolsForProvider() as OpenAI tool definitions
- Executed via executeCustomTool() → UAZAPI endpoints (/send/text, /send/media, /send/location)
- Prompt instructions injected into buildSystemPrompt() as "FERRAMENTAS CUSTOMIZADAS" section
- UI: CRUD in TenantForm.tsx "Ferramentas" tab with templates (PIX, Localização, Catálogo, Link, Escalar Humano, Audiovisagismo)

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
- ❌ emoji resets conversation memory + conversation_state for that user
- Debounce: 10s window, atomic claim
