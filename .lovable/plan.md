## Problema

Quando o cliente tenta salvar o prompt pelo painel (Barbearia Marquêz e outros), recebe:
> "Apenas administradores podem alterar credenciais e configurações sensíveis do tenant"

Mesmo com o módulo `ai_prompt` configurado como `editable` para aquele tenant.

## Causa

O trigger `prevent_tenant_sensitive_update` (banco) bloqueia **todos os não-admins** de alterar estes campos da tabela `tenants`:

- `agent_system_prompt`
- `agent_knowledge_base`
- `agent_settings`
- `agent_paused`
- (+ credenciais de API, slug, status, kanban_columns, etc.)

O painel do cliente (`src/pages/client/Ai.tsx`) faz `update` direto na tabela `tenants` com `agent_system_prompt`, então cai na regra do trigger e é rejeitado — independente das policies de RLS e do `tenant_permissions`.

## Correção (1 migration, sem mudar UI)

Reescrever o trigger para separar dois grupos de campos:

**Grupo A — sempre admin-only** (credenciais e config estrutural):
`uazapi_token`, `uazapi_url`, `trinks_api_key`, `trinks_establishment_id`, `onebeleza_token`, `onebeleza_celular`, `bemp_token`, `bemp_domain`, `frizzar_token`, `frizzar_base_url`, `zaylo_*`, `api_provider`, `status`, `slug`, `kanban_columns`.

**Grupo B — admin OU cliente com permissão de módulo:**

| Campo | Módulo exigido (`can_edit_module`) |
|---|---|
| `agent_system_prompt` | `ai_prompt` |
| `agent_knowledge_base` | `ai_knowledge` |
| `agent_settings` | `ai_prompt` (usado pelas custom tools / config do agente) |
| `agent_paused` | `ai_prompt` |

Lógica do trigger novo:

```text
se admin → permite
se mudou qualquer campo do Grupo A → bloqueia (erro atual)
para cada campo do Grupo B alterado:
    se NOT can_edit_module(auth.uid(), tenant_id, <módulo>) → bloqueia
permite
```

Isso preserva 100% da proteção sobre credenciais e mantém o comportamento atual quando o admin oculta/torna read-only o módulo no painel, mas libera o caso legítimo: módulo `editable` → cliente salva o prompt.

## Verificação após aplicar

1. Logar como cliente da Barbearia Marquêz → editar prompt → Salvar → deve criar v(N+1) em `ai_prompt_versions` sem erro.
2. Tentar via cliente alterar `uazapi_token` (não tem UI para isso, mas via query) → deve continuar bloqueado.
3. Admin no painel → continua salvando tudo normalmente.

## Arquivos tocados

- 1 migration SQL (`CREATE OR REPLACE FUNCTION public.prevent_tenant_sensitive_update ...`).
- Nenhum arquivo de frontend ou edge function.
