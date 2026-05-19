
-- 1) crm_boards
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

create policy "Admins manage crm_boards"
on public.crm_boards
for all
to authenticated
using (has_role(auth.uid(), 'admin'::app_role))
with check (has_role(auth.uid(), 'admin'::app_role));

create policy "Clients view own crm_boards"
on public.crm_boards
for select
to authenticated
using (tenant_id = get_user_tenant_id(auth.uid()));

create policy "Clients insert own crm_boards"
on public.crm_boards
for insert
to authenticated
with check (
  tenant_id = get_user_tenant_id(auth.uid())
  and can_edit_module(auth.uid(), tenant_id, 'crm')
);

create policy "Clients update own crm_boards"
on public.crm_boards
for update
to authenticated
using (
  tenant_id = get_user_tenant_id(auth.uid())
  and can_edit_module(auth.uid(), tenant_id, 'crm')
);

create policy "Clients delete own crm_boards"
on public.crm_boards
for delete
to authenticated
using (
  tenant_id = get_user_tenant_id(auth.uid())
  and can_edit_module(auth.uid(), tenant_id, 'crm')
);

create trigger crm_boards_updated_at
before update on public.crm_boards
for each row execute function public.update_updated_at_column();

-- 2) crm_leads.board_id
alter table public.crm_leads add column board_id uuid;
create index crm_leads_board_id_idx on public.crm_leads(board_id);

-- 3) Migrate: para cada tenant com kanban_columns não vazio, cria board "Principal"
insert into public.crm_boards (tenant_id, name, "order", columns)
select t.id, 'Principal', 0, t.kanban_columns
from public.tenants t
where jsonb_array_length(coalesce(t.kanban_columns, '[]'::jsonb)) > 0;

-- 4) Vincula leads existentes ao board "Principal" do tenant
update public.crm_leads l
set board_id = b.id
from public.crm_boards b
where b.tenant_id = l.tenant_id
  and b.name = 'Principal'
  and l.board_id is null;
