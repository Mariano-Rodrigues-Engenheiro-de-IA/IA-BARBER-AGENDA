---
name: UAZAPI Label endpoint format
description: Correct payload format for UAZAPI /chat/label endpoint
type: feature
---
- Endpoint: POST /chat/label
- Campo correto: `jid` (NÃO `chatId` ou `number`)
- Formato: `{ jid: "PHONE@s.whatsapp.net", labelId: "ID" }`
- A API funciona como toggle: cada chamada alterna add/remove
- Documentação: https://docs.uazapi.com — sempre consultar antes de testar
