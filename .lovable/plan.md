

# Correção: Recebimento de Mídia + Ferramentas Customizadas UAZAPI

## Problemas Identificados

### 1. IA nao recebe audio/imagem do usuario
Os logs mostram `getBase64 response status: 404`, `getLink response: 404`, `downloadMedia failed: 404`. O codigo usa endpoints antigos (`/getBase64/{id}`, `/getLink/{id}`, `/downloadMedia/{id}`) que nao existem no UAZAPI v2. O endpoint correto e `POST /message/download` com `{id}` no body JSON.

### 2. Ferramenta de envio de midia (catalogo/imagem/audio/documento)
O codigo usa FormData para enviar ao `/send/media`, mas a UAZAPI aceita JSON simples: `{number, type, file, caption}` onde `file` pode ser uma URL publica ou string base64. Nao precisa de FormData.

### 3. Ferramenta de localizacao
Falta o campo `address` no payload. A UAZAPI exige `{number, name, address, latitude, longitude}`. Tambem falta o campo `address` na UI e no config da ferramenta.

## Mudancas

### `supabase/functions/whatsapp-webhook/index.ts`

**A) Corrigir download de midia recebida (linhas ~162-265)**
- Substituir os 3 metodos falhando (`/getBase64`, `/getLink`, `/downloadMedia`) por uma unica chamada ao endpoint correto: `POST /message/download` com body `{id: messageId}`
- A resposta retorna base64 ou URL do arquivo
- Manter fallback: se `/message/download` falhar, tentar `GET /message/download/{id}` como alternativa

**B) Corrigir envio de midia nas custom tools (linhas ~1362-1403)**
- Trocar FormData por JSON body: `{number, type, file, caption}` onde `file` = URL configurada
- Endpoint continua `/send/media` mas com Content-Type JSON
- Para audio PTT, usar `type: "ptt"` em vez de `"audio"`

**C) Corrigir envio de localizacao (linhas ~1405-1422)**
- Adicionar campo `address` ao payload: `{number, name, address, latitude, longitude}`

### `src/pages/TenantForm.tsx`

**D) Adicionar campo "Endereco" na UI de localizacao**
- Adicionar campo `address` ao tipo `CustomToolConfig`
- Adicionar Input de "Endereco" no formulario de `send_location`
- Atualizar template de Localizacao com campo `address`

### `mem://features/ai-agent.md`

- Documentar endpoints corretos da UAZAPI v2

## Detalhes Tecnicos

```text
ANTES (404):
  GET /getBase64/{messageId}     → 404
  GET /getLink/{messageId}       → 404
  GET /downloadMedia/{messageId} → 404

DEPOIS:
  POST /message/download  body: {id: messageId}  → base64/url

ANTES (send_media custom tool):
  POST /send/media  FormData(number, type, file blob)

DEPOIS:
  POST /send/media  JSON {number, type, file: "https://...", caption}

ANTES (send_location):
  {number, lat, lng, name}

DEPOIS:
  {number, latitude, longitude, name, address}
```

