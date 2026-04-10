

# Arquitetura Multi-API: Trinks + One Beleza + Sem API

## Resumo

Transformar o webhook de um sistema hardcoded para Trinks em uma arquitetura plugável onde cada tenant escolhe seu provedor de agendamento: **Trinks**, **One Beleza**, ou **Nenhum** (link direto no WhatsApp).

## O Que Muda

### 1. Banco de Dados

Adicionar coluna `api_provider` na tabela `tenants`:

- Valores: `trinks`, `onebeleza`, `none` (default: `trinks`)
- Adicionar campos para One Beleza: `onebeleza_token`, `onebeleza_celular` (celular fixo usado nas chamadas API)
- O campo `trinks_api_key` e `trinks_establishment_id` continuam existindo, usados apenas quando `api_provider = 'trinks'`

### 2. Webhook: Arquitetura de Providers

Refatorar `whatsapp-webhook/index.ts` para ter uma interface de provider:

```text
whatsapp-webhook/index.ts
  │
  ├── buildTools(tenant)        ← escolhe tools baseado em api_provider
  ├── executeTool(tenant, ...)  ← despacha para provider correto
  │
  ├── providers/trinks    ← código atual (já existe)
  │     buildTrinksTools()
  │     executeTrinksTool()
  │
  ├── providers/onebeleza ← NOVO
  │     buildOneBelezaTools()
  │     executeOneBelezaTool()
  │
  └── providers/none      ← NOVO
        buildNoneTools()   ← sem tools de agendamento
```

Como edge functions suportam apenas 1 arquivo (`index.ts`), todo o código fica no mesmo arquivo mas organizado em seções claras.

### 3. Provider One Beleza: Ferramentas

Baseado na API documentada e nos nodes n8n, as ferramentas seriam:

| Ferramenta | Endpoint One Beleza | Método |
|---|---|---|
| `buscar_cliente` | `/api/Clientes/GetClientePeloNumero?Celular=...` | GET |
| `cadastrar_cliente` | `/api/OLoginChatBot/CadastrarUsuario` (host diferente: onetotemapi) | POST |
| `buscar_servicos` | `/api/Servicos/RetornarGrupoServicos?celular=...` | GET |
| `buscar_barbeiros_por_servico` | `/api/Profissionais/PesquisarProfissionais?celular=...&servicosId=...` | GET |
| `buscar_datas_disponiveis` | `/api/Agendamento/RetornarDatasPorServico?celular=...&servicosid=...&profissionalid=...` | GET |
| `buscar_horarios` | `/api/Agendamento/HorariosPorProfissionaisByDataServico?celular=...&date=...&servicoId=...&ProfissionalId=...` | POST |
| `agendar` | `/api/Agendamento/MarcarAgendamentoForm?celular=...` (form-data) | POST |
| `buscar_agendamentos_dia` | `/api/Agendamento/GetTodosAgendamentosDia?date=...` | GET |
| `confirmar_agendamento` | `/api/Agendamento/ConfirmarAgendamento?agendasId=...&celular=...` | POST |
| `desmarcar_agendamento` | `/api/Agendamento/DesmarcarAgendamento?celular=...&agendasId=...` | DELETE |

Diferenças chave vs Trinks:
- Autenticação: Bearer Token (header `Authorization`)
- O `celular` vai na URL como query param (fixo por tenant)
- Agendar usa `multipart/form-data` (não JSON)
- Fluxo sequencial obrigatório: Servico → Barbeiro → Datas → Horarios → Agendar
- Cancelamento = DELETE (não PATCH)
- Tem endpoint de confirmação de agendamento (Trinks nao tem)

### 4. Provider "Nenhum" (Sem API)

- Sem ferramentas de agendamento
- O agente apenas conversa e pode enviar um link de agendamento (configurável no tenant)
- Adicionar campo `booking_link` no tenant para o link que o agente deve enviar

### 5. System Prompt: Adaptação por Provider

O prompt base permanece o mesmo (tom de voz, regras de data, etc). A seção de ferramentas e fluxo de agendamento muda conforme o provider:

- **Trinks**: prompt atual (já funciona)
- **One Beleza**: fluxo sequencial de 5 passos (servico → barbeiro → datas → horarios → agendar), adaptar nomes das ferramentas
- **None**: sem fluxo de agendamento, apenas orientar o cliente ao link

### 6. Admin UI: Seletor de Provider

No `TenantForm.tsx`, aba "Integração API":
- Dropdown: "Provedor de Agendamento" → Trinks / One Beleza / Nenhum
- Mostrar/esconder campos conforme seleção:
  - **Trinks**: X-Api-Key + Establishment ID (já existe)
  - **One Beleza**: Bearer Token + Celular da conta
  - **Nenhum**: Link de agendamento

### 7. Tenant lookup no webhook

Atualmente o webhook pega o primeiro tenant ativo. Precisa mudar para match por `whatsapp_number` (campo que já existe na tabela) para funcionar multi-tenant de verdade.

## Etapas de Implementação

1. Migration: adicionar `api_provider`, `onebeleza_token`, `onebeleza_celular`, `booking_link` ao `tenants`
2. Refatorar webhook: extrair Trinks para seção isolada, criar dispatcher por provider
3. Implementar provider One Beleza: tools + executor
4. Implementar provider None: sem tools
5. Adaptar `buildSystemPrompt` para variar por provider
6. Atualizar `TenantForm.tsx`: seletor de provider + campos condicionais
7. Fix tenant lookup: match por `whatsapp_number` em vez de `LIMIT 1`
8. Atualizar memórias do projeto

## Detalhes Tecnic -- Seguranca

- Tokens One Beleza ficam no banco (como já acontece com Trinks)
- Cada tenant tem suas credenciais isoladas
- RLS já protege acesso aos tenants

