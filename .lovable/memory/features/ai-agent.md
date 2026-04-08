---
name: AI Agent WhatsApp
description: AI agent via WhatsApp using UAZAPI + Lovable AI + Trinks API tool-calling
type: feature
---
- WhatsApp integration via UAZAPI (subdomain: zyloia)
- Edge function: whatsapp-webhook receives messages, processes with Lovable AI (gemini-3-flash-preview), responds via UAZAPI
- Tool-calling: listar_servicos, listar_profissionais, buscar_cliente, criar_cliente, criar_agendamento (Trinks API)
- Conversation history stored in chat_messages table (tenant_id + phone_number)
- Trinks API base URL: https://api.trinks.com/v1, auth via X-Api-Key + estabelecimentoId header
- UAZAPI API: POST /message/send-text with header "token"
- Webhook URL: https://bazfkghkipqamnksbrdz.supabase.co/functions/v1/whatsapp-webhook
