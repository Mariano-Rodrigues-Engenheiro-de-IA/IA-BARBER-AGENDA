---
name: UAZAPI Label endpoint format
description: Correct payload format for UAZAPI /chat/labels endpoint (add/remove)
type: feature
---
- Endpoint: POST /chat/labels (com 's' no final!)
- Para ADICIONAR: `{ number: "PHONE", add_labelid: "ID" }`
- Para REMOVER: `{ number: "PHONE", remove_labelid: "ID" }`
- NÃO usar /chat/label (sem 's') — esse é toggle e causa problemas
- NÃO usar jid — usar number (sem @s.whatsapp.net)
- Fonte: node n8n do usuário que funcionava em produção
