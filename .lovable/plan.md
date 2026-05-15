# Plano: Painel do Cliente (multi-tenant) com permissões granulares

## Visão geral

Criar um segundo painel ("Painel do Cliente") onde cada cliente acessa apenas a própria empresa, com login e senha. Você (ADM) controla, por empresa, quais funcionalidades ficam visíveis e se são editáveis ou somente-leitura. Tudo o que o cliente fizer (e o que você fizer no ADM) gera log de auditoria.

## O que muda na experiência

**Para o ADM (você):** continua com tudo. Ganha:
- Botão "Criar acesso do cliente" em cada empresa (gera email + senha temporária para compartilhar).
- Aba "Permissões" dentro de cada empresa: ligar/desligar e marcar como somente-leitura cada módulo.
- Aba "Auditoria" global: quem alterou o quê e quando.

**Para o cliente:** painel simplificado com linguagem amigável e logo + nome da própria empresa no topo (white-label leve). Menus:
- **Visão Geral** — métricas principais
- **Conversas** (antes "Monitor IA")
- **Follow-ups**
- **Sua IA** (antes "Empresas") — dados, integrações, prompt e base de conhecimento, conforme liberado
- **CRM** (kanban de leads)

Itens ocultados pelo ADM simplesmente não aparecem no menu nem nas rotas. Itens marcados como somente-leitura aparecem com campos desabilitados e botões de salvar escondidos.

## Modelo de permissões

8 módulos controláveis por empresa:
`overview`, `conversations`, `followups`, `crm`, `ai_prompt`, `ai_knowledge`, `integrations`, `company_data`.

Para cada módulo, 3 estados: **oculto**, **somente-leitura**, **editável**. Padrão ao criar acesso: tudo editável menos `integrations` (somente-leitura, porque mexe em tokens sensíveis).

## Estrutura técnica

```text
/                       → ADM (existente, protegido por role=admin)
/app                    → Painel do cliente (protegido por role=client)
  /app/overview
  /app/conversations
  /app/followups
  /app/ai
  /app/integrations
  /app/company
  /app/crm
/login                  → login único; redireciona conforme role
```

### Banco de dados (migration)

- Novo enum `app_role` ganha o valor `client` (já existe `admin`).
- Nova tabela `tenant_users(tenant_id, user_id, created_at)` — vínculo 1 usuário ↔ 1 empresa (UNIQUE em user_id).
- Nova tabela `tenant_permissions(tenant_id, module, visibility)` onde `visibility ∈ ('hidden','read_only','editable')`. Linha ausente = `editable`.
- Nova tabela `audit_logs(id, tenant_id, user_id, actor_role, action, entity, entity_id, before, after, created_at)`.
- Função `get_user_tenant_id(_user_id uuid) returns uuid` (security definer) e `can_edit(_user_id, _tenant_id, _module text) returns boolean`.
- RLS atualizada em `tenants`, `crm_leads`, `follow_ups`, `follow_up_sequences`, `chat_messages`, `agent_logs`, `conversation_state`: além de `has_role(admin)`, permitir `tenant_id = get_user_tenant_id(auth.uid())` para SELECT, e UPDATE só quando `can_edit(...)` for true.

### Edge function `admin-create-client-user`

Chamada pelo ADM no botão "Criar acesso". Usa `service_role` para:
1. Criar usuário em `auth.users` com email informado e senha aleatória.
2. Inserir `user_roles(role='client')` e `tenant_users(tenant_id, user_id)`.
3. Inserir `tenant_permissions` padrão.
4. Devolver email + senha temporária para o ADM copiar e enviar ao cliente.

### Frontend

- `useAuth` passa a expor `role` (`admin` | `client`) e, se cliente, `tenantId` + `permissions` (mapa módulo→estado).
- Novo `ClientLayout` (espelho simplificado do `AdminLayout`) usando logo/nome da empresa do tenant.
- Novo guard `ClientRoute` e rotas `/app/*`.
- Hook `useModulePermission(module)` retorna `{ visible, editable }`. Componentes de edição usam `disabled={!editable}` e escondem botão Salvar.
- No ADM:
  - Em `/tenants/:id`, nova aba **Acessos**: lista usuários vinculados, botão "Criar acesso do cliente" (modal mostra credenciais geradas uma única vez), botão "Resetar senha".
  - Em `/tenants/:id`, nova aba **Permissões**: tabela 8 módulos × 3 estados (radio).
  - Nova rota `/audit` no menu ADM.

### Auditoria

- Hook utilitário `logAudit(action, entity, entityId, before, after)` chamado nos handlers de save (frontend) e gatilhos PG nos updates de `tenants`, `follow_up_sequences`, `follow_up_steps`, `crm_leads` para capturar mudanças mesmo se vierem da IA.

## Sugestões extras (recomendo incluir já)

1. **Indicador de status do WhatsApp** no topo do painel do cliente (verde/vermelho), lendo o último ping do UAZAPI.
2. **Resumo "Últimas 24h"** na Visão Geral do cliente: nº de leads novos, conversas ativas, follow-ups enviados, taxa de resposta — números que ele entende.
3. **Botão "Pausar IA"** no painel do cliente (cria flag `agent_paused` no tenant; a webhook respeita). Útil para o cliente assumir manualmente.
4. **Convite por link** como evolução futura do "criar manualmente": mesmo backend, só troca o passo final por envio de email com link de definição de senha.
5. **Multi-empresa por usuário** preparado no schema (`tenant_users` é N:N) mesmo usando 1:1 hoje — evita migration futura.

## Entregáveis (ordem de implementação)

1. Migration: enum, tabelas, funções, RLS, triggers de auditoria.
2. Edge function `admin-create-client-user`.
3. `useAuth` com role/tenant/permissions + `ClientRoute` + `ClientLayout`.
4. Páginas `/app/*` reaproveitando componentes existentes com gating de permissão.
5. ADM: abas **Acessos** e **Permissões** em `/tenants/:id` + página `/audit`.
6. Indicador de status WhatsApp + botão "Pausar IA" + Visão Geral do cliente.

Confirma que posso seguir com este escopo?
