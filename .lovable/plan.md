# Melhorias no painel do cliente

## 1. Visão Geral — filtro de período funcional (7/14/30 dias)

**Arquivo:** `src/pages/client/Overview.tsx`

- Trocar `useState<"7d" | "30d">` por `"7d" | "14d" | "30d"` (default 30d).
- Adicionar opção "Últimos 14 dias" no `<Select>`.
- Calcular `days` com base nos 3 valores.
- **Bug atual:** os 4 cards do topo já dependem de `aiStats` (que vem de `messages` + `agentLogs` filtrados por período) — então já mudam. **Exceto** o primeiro card "Follow-ups enviados (24h)" que está fixo em 24h. Ajustar esse card para usar o período selecionado também (label dinâmica `Follow-ups enviados (${days}d)`), consultando `follow_ups` filtrado por `sent_at >= since`. Remover query `topData` separada.
- Garantir responsividade (grid já é `sm:grid-cols-2 lg:grid-cols-4`, manter).

## 2. Follow-ups — filtros e i18n

**Arquivo:** `src/pages/FollowUpsDashboard.tsx` (usado por `src/pages/client/FollowUps.tsx`)

- **Remover filtro "Projeto"** (`tenantFilter` + `<Select>` de tenants + query `tenants-list`). Como RLS já restringe ao tenant do cliente, esse filtro é desnecessário.
- **Período:** trocar opções para `7d | 14d | 30d | all` (manter "Todos"). O filtro já funciona via `gte("created_at", since)` — apenas adicionar 14d.
- **Traduzir termos em inglês:**
  - "Timeline — {phone}" → "Linha do tempo — {phone}"
  - Status badges no timeline (`sent/confirmed/pending/...`) já vêm em inglês — mapear para PT-BR: Enviado / Confirmado / Pendente / Cancelado / Expirado.
  - `(catch-all)` → `(qualquer mensagem)`.
  - Varrer o arquivo procurando outras strings em inglês visíveis.

## 3. Logo do cliente no avatar do sidebar

**Arquivo:** `src/components/ClientLayout.tsx`

- O sidebar já tem `tenant.logo_url` no topo. Replicar no avatar inferior (próximo ao e-mail): trocar `<Avatar><AvatarFallback>{initials}</AvatarFallback></Avatar>` por `<Avatar><AvatarImage src={tenant?.logo_url} /><AvatarFallback>{initials}</AvatarFallback></Avatar>`. Manter fallback nas iniciais quando não houver logo.

## 4. Versões de prompt — restore + resumo + espelhamento admin/cliente

### 4a. Schema (migration)

Adicionar coluna `change_summary text` em `ai_prompt_versions`.

### 4b. Painel do cliente — `src/pages/client/Ai.tsx`

- No diálogo "Salvar prompt", adicionar campo `<Textarea>` "Resumo das alterações" (obrigatório, ex: "Ajustei o tom da saudação"). Enviar `change_summary` no INSERT.
- Na lista de versões, exibir o `change_summary` (em vez de `prompt.slice(...)` apenas) como descrição principal.
- No diálogo "Visualizar versão" (`viewVersion`), substituir o botão atual "Carregar esta versão no editor" por **"Restaurar esta versão"**, que abre `<AlertDialog>` de confirmação com texto: "Tem certeza que deseja restaurar a versão vN? A IA passará a usar imediatamente as instruções desta versão (uma nova versão será criada como cópia da vN)." Ao confirmar: update em `tenants.agent_system_prompt` + insert em `ai_prompt_versions` (nova versão, `change_summary` = "Restaurado da versão vN").

### 4c. Painel do ADM — `src/pages/TenantForm.tsx`

Hoje o admin altera `agent_system_prompt` mas **não** cria versão. Para espelhar:

- Detectar mudança em `agent_system_prompt` no submit; se mudou, abrir o mesmo AlertDialog com campo "Resumo das alterações" antes de salvar.
- Após salvar tenant, inserir nova versão em `ai_prompt_versions` (com `created_by_role: "admin"`, `change_summary`).
- Adicionar bloco "Versões" reutilizando o mesmo UI (lista + visualizar + restaurar) — extrair em componente `PromptVersionsDialog` compartilhado em `src/components/PromptVersionsDialog.tsx` para usar tanto em `client/Ai.tsx` quanto em `TenantForm.tsx`.
- Como ambos painéis leem da mesma tabela `ai_prompt_versions` filtrada por `tenant_id`, o espelhamento é automático. O realtime já existe em `client/Ai.tsx` para `tenants`; adicionar também subscription em `ai_prompt_versions` para refletir novas versões instantaneamente. Adicionar realtime equivalente no admin.

### 4d. Espelhamento geral admin↔cliente

Verificar que todos os campos editáveis no `TenantForm` (admin) são os mesmos que o cliente edita em `client/Ai.tsx` (prompt, dados da empresa, integrações, ferramentas). Como ambos escrevem no mesmo registro `tenants`, já espelham. Garantir que o realtime no `client/Ai.tsx` cobre todas as abas (já cobre — usa UPDATE genérico na linha do tenant).

## Detalhes técnicos

- Migration SQL: `ALTER TABLE public.ai_prompt_versions ADD COLUMN change_summary text;`
- Componente novo: `src/components/PromptVersionsDialog.tsx` — props: `{ tenantId, currentVersion, versions, canEdit, onRestored }`. Encapsula listagem, visualização e restore com confirmação.
- Realtime em ambos painéis: subscription extra em `ai_prompt_versions` filtrada por `tenant_id`.
- `i18n` é manual (sem lib) — strings hardcoded em PT-BR.
- Sem novas dependências.

## Fora do escopo

- Não mexer no fluxo do agente WhatsApp.
- Não criar tradução automática de UI inteira — só os termos visíveis ao cliente reportados.
