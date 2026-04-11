

# Ferramentas Customizáveis por Tenant

## Resumo

Adicionar uma aba "Ferramentas" no formulário de tenant onde o admin pode cadastrar ferramentas de envio (PIX, localização, imagem, áudio, documento, link) que a IA aciona automaticamente via UAZAPI. Sem migration de banco -- usa o campo `agent_settings` (JSONB) que já existe.

## Mudanças

### 1. TenantForm.tsx — Nova aba "Ferramentas"

- Adicionar 5a aba no TabsList: "Ferramentas" (ícone Wrench)
- Ler/salvar `agent_settings.custom_tools[]` do tenant
- Interface CRUD:
  - Lista de ferramentas com nome, tipo, status (switch on/off), botões editar/excluir
  - Dialog para adicionar/editar ferramenta com campos:
    - Nome de exibição (ex: "Enviar PIX")
    - Tipo (dropdown: Texto, Imagem, Áudio, Localização, Documento, Link)
    - Campos de configuração dinâmicos conforme tipo selecionado
    - Instrução para o prompt (textarea - quando a IA deve usar)
    - Switch ativo/inativo
- Templates prontos (botões rápidos): PIX, Localização, Catálogo de Serviços, Link Agendamento, Escalar Humano
- O `agent_settings` é salvo junto com o resto do form no submit

### 2. Webhook (index.ts) — Injeção e execução dinâmica

**buildToolsForProvider():**
- Após montar tools do provider, ler `tenant.agent_settings?.custom_tools`
- Para cada ferramenta `enabled: true`, gerar tool definition OpenAI-format e concatenar

**buildSystemPrompt():**
- Injetar seção "FERRAMENTAS CUSTOMIZADAS" com as `prompt_instruction` de cada ferramenta ativa

**Nova função executeCustomTool():**
- Mapeia tipo para endpoint UAZAPI:
  - `send_text` → POST `/send/text` (texto fixo)
  - `send_image` → POST `/send/media` (type: image, URL + caption)
  - `send_audio` → POST `/send/media` (type: audio, URL, ptt: true)
  - `send_location` → POST `/send/location` (lat, lng, name)
  - `send_document` → POST `/send/media` (type: document, URL + caption)
  - `send_link` → POST `/send/text` (URL fixa)

**executeToolForProvider():**
- Se tool name não pertence a nenhum provider, verificar se é custom tool e despachar para `executeCustomTool()`

### 3. Estrutura de dados (agent_settings)

```json
{
  "custom_tools": [
    {
      "id": "uuid",
      "name": "enviar_pix",
      "display_name": "Enviar PIX",
      "description": "Envia a chave PIX para o cliente",
      "type": "send_text",
      "config": { "text": "Chave PIX: 11999998888" },
      "prompt_instruction": "Use quando o cliente perguntar sobre PIX",
      "enabled": true
    }
  ]
}
```

### 4. Tipos de ferramenta e seus campos de config

| Tipo | Campos | Uso |
|------|--------|-----|
| send_text | text | PIX, informações fixas |
| send_image | url, caption | Catálogo, promoções |
| send_audio | url | Mensagem de boas-vindas |
| send_location | latitude, longitude, name | Endereço |
| send_document | url, caption | Tabela de preços |
| send_link | url | Redes sociais, agendamento |

### 5. Memória do projeto

Atualizar `mem://features/ai-agent.md` com a seção de custom tools.

## Arquivos modificados

- `src/pages/TenantForm.tsx` — nova aba + CRUD de ferramentas
- `supabase/functions/whatsapp-webhook/index.ts` — injeção dinâmica + executeCustomTool
- `.lovable/memory/features/ai-agent.md` — documentar custom tools

