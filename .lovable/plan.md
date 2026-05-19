# Melhorias no Painel do Cliente

Três blocos de mudanças no painel do cliente (e ajustes correspondentes no admin), sem mexer em integrações ou backend de IA.

---

## 1. Múltiplos CRMs (boards)

Hoje cada tenant tem **um único Kanban** definido em `tenants.kanban_columns` (jsonb). Vou permitir **vários CRMs por tenant** (ex.: Tráfego Pago, Assinatura, Contratação — nomes definidos pelo cliente).

**Modelo de dados**
- Nova tabela `crm_boards`: `id`, `tenant_id`, `name`, `order`, `columns jsonb` (mesmo formato atual: `[{label_id, name, color, order, type}]`), `created_at`, `updated_at`. RLS: admin tudo; cliente lê/edita os do próprio tenant (respeitando `can_edit_module('crm')`).
- Nova coluna `crm_leads.board_id uuid` (nullable). Leads existentes ficam num board "Principal" migrado automaticamente a partir de `tenants.kanban_columns`.
- Mantemos `tenants.kanban_columns` por compatibilidade, mas o app passa a ler de `crm_boards`.

**UI Admin (`TenantForm` → aba Kanban)**
- Lista de boards com botões "+ Novo CRM", renomear, excluir, reordenar.
- Ao selecionar um board, edita as colunas dele (funnel/flag) com o editor atual.

**UI Cliente (`/app/crm`)**
- Seletor de board no topo (tabs ou dropdown).
- Botão "+ Novo CRM" se tiver permissão `editable`.
- Kanban renderiza colunas do board selecionado; leads filtrados por `board_id`.

**Tela Admin `TenantKanban`**
- Mesmo seletor de board.

**Edge function `move-crm-lead`**: continua igual (opera por phone + label). Sem mudança.

---

## 2. Follow-ups: remover "simples", renomear "Cadências" → "Follow-ups"

Hoje convivem dois fluxos: follow-up simples (linha em `follow_ups` criada quando IA envia link) e cadências personalizadas (`follow_up_sequences` + `follow_up_steps`).

**Mudanças**
- **Manter** `follow_up_sequences`/`follow_up_steps` (lógica que já roda em `process-followups`).
- **Remover da UI** toda a seção "Follow-up simples" / configuração de delay padrão / mensagem default. A tabela `follow_ups` continua existindo (é onde os jobs ficam enfileirados), só some da interface como item separado.
- Renomear em **todas as telas** "Cadência/Cadências" → "Follow-up/Follow-ups personalizados":
  - Cliente: `src/pages/client/FollowUps.tsx`
  - Admin: `src/pages/FollowUpsDashboard.tsx`, `SequencesEditor.tsx`, navegação/sidebar.
- Cliente vê só "Follow-ups" no menu (sem "Cadências" nem "Follow-up simples").

Sem mudança em edge functions nem em `process-followups`.

---

## 3. Visão Geral do cliente — gráficos de análise

Reaproveitar `src/pages/client/Overview.tsx`. Manter os 4 cards atuais no topo e adicionar abaixo uma grade de gráficos (Recharts, já instalado). Período selecionável (7/30 dias) igual ao dashboard admin.

**Cards extras (linha 2, métricas tangíveis de uso da IA)**
- Agendamentos criados pela IA (conta `tool_calls` com `name in ('criar_agendamento','agendar')` e `!blocked` em `agent_logs`)
- Links de agendamento enviados (`tool_calls.name = 'enviar_link_agendamento'`)
- Mensagens enviadas pela IA (`chat_messages` role=assistant)
- Clientes únicos atendidos (distinct phone_number em `chat_messages`)

**Gráficos (linha 3+, coloridos, glass-card)**
1. **Atividade diária** — Area chart empilhado: mensagens do cliente vs respostas da IA por dia.
2. **Agendamentos & Links por dia** — Bar chart agrupado (verde = agendamentos, amarelo = links).
3. **Funil de conversão** — Bar chart horizontal: Conversas → Links enviados → Agendamentos → Follow-ups confirmados.
4. **Distribuição por horário** — Bar chart 0–23h mostrando picos de atendimento (heatmap visual de horas).
5. **Top 5 clientes mais ativos** — Bar chart horizontal com nº de mensagens por phone_number.
6. **Status de follow-ups** — Donut/Pie: pending / sent / confirmed / cancelled.

Tudo derivado de `chat_messages`, `agent_logs`, `follow_ups` que o cliente já pode ler via RLS.

---

## Detalhes técnicos

**Migrations (schema)**
```sql
create table public.crm_boards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  "order" int not null default 0,
  columns jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.crm_boards enable row level security;
-- policies: admin ALL; cliente SELECT (tenant_id = get_user_tenant_id(auth.uid()));
-- cliente ALL when can_edit_module(auth.uid(), tenant_id, 'crm').

alter table public.crm_leads add column board_id uuid;
-- data migration: para cada tenant com kanban_columns não-vazio,
-- criar 1 board "Principal" com essas colunas e setar board_id em todos os leads existentes.
```

**Arquivos a mexer**
- `src/pages/client/Crm.tsx` — seletor de board + criar board
- `src/pages/TenantKanban.tsx` — seletor de board
- `src/pages/TenantForm.tsx` — editor de boards (aba Kanban)
- `src/hooks/useCrmLeads.ts` — filtrar por board_id, hooks `useCrmBoards`, `useCreateBoard`
- `src/pages/client/FollowUps.tsx` — remover seção simples, renomear
- `src/pages/FollowUpsDashboard.tsx` + `SequencesEditor.tsx` — renomear
- `src/components/ClientLayout.tsx` / `AdminLayout.tsx` — labels do menu
- `src/pages/client/Overview.tsx` — novos cards + gráficos

Sem mudanças em: edge functions, integrações, RLS de tabelas existentes (só `crm_leads.board_id` é nullable, então legado funciona), prompt da IA.

---

Confirma que posso seguir com tudo? Se quiser cortar/ajustar alguma parte (ex.: pular algum gráfico, manter `follow_ups` simples visível só pro admin etc.), me diz.
