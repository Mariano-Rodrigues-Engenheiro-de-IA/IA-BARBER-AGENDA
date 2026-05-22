# Corrigir erro "Missing required fields" no enviar_contato

## Causa

Nos logs da Barbearia Marquês:
```
Tool enviar_contato: "Falha ao enviar contato: Missing required fields" (status 400)
```

A ferramenta foi acionada corretamente, mas o body enviado para a UAZAPI está em formato errado. Em `supabase/functions/whatsapp-webhook/index.ts` (linha 4859), enviamos:

```json
{ "number": "...", "contact": { "fullName": "...", "phoneNumber": "..." } }
```

A UAZAPI v2 `/send/contact` espera os campos no nível raiz, junto com `number` — por isso responde `Missing required fields`.

## Correção

Em `supabase/functions/whatsapp-webhook/index.ts`, dentro do `case "send_contact"` (≈linha 4848), trocar a montagem do body para o formato plano esperado pela UAZAPI:

```ts
const body: any = {
  number: phoneNumber,
  fullName,
  phoneNumber: contactPhone,
};
if (organization) body.organization = organization;

const res = await fetch(`${uazapiUrl}/send/contact`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Accept": "application/json", "token": uazapiToken },
  body: JSON.stringify(body),
});
```

Sem mudanças em prompt, UI, banco ou em outras ferramentas. Apenas esse case na edge function.

## Validação

Após o deploy, perguntar à IA da Barbearia Marquês algo como "me passa o contato da Asa Sul" e confirmar nos `agent_logs` que `enviar_contato` retorna `success: true`.
