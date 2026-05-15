
-- 1. Adiciona role 'client' ao enum app_role
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'client';

-- 2. Coluna agent_paused em tenants
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS agent_paused boolean NOT NULL DEFAULT false;

-- 3. tenant_users (vínculo usuário <-> empresa)
CREATE TABLE IF NOT EXISTS public.tenant_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON public.tenant_users(tenant_id);
ALTER TABLE public.tenant_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage tenant_users" ON public.tenant_users
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users see own tenant_users" ON public.tenant_users
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- 4. tenant_permissions
CREATE TABLE IF NOT EXISTS public.tenant_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  module text NOT NULL,
  visibility text NOT NULL DEFAULT 'editable' CHECK (visibility IN ('hidden','read_only','editable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module)
);
ALTER TABLE public.tenant_permissions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage tenant_permissions" ON public.tenant_permissions
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Clients read own tenant_permissions" ON public.tenant_permissions
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE TRIGGER trg_tenant_permissions_updated
  BEFORE UPDATE ON public.tenant_permissions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 5. audit_logs
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  user_id uuid,
  actor_role text,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON public.audit_logs(tenant_id, created_at DESC);
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read audit_logs" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Clients read own audit_logs" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (tenant_id IN (SELECT tenant_id FROM public.tenant_users WHERE user_id = auth.uid()));

CREATE POLICY "Service insert audit_logs" ON public.audit_logs
  FOR INSERT TO public WITH CHECK (true);

CREATE POLICY "Authenticated insert audit_logs" ON public.audit_logs
  FOR INSERT TO authenticated WITH CHECK (true);

-- 6. Funções auxiliares
CREATE OR REPLACE FUNCTION public.get_user_tenant_id(_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT tenant_id FROM public.tenant_users WHERE user_id = _user_id LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.can_edit_module(_user_id uuid, _tenant_id uuid, _module text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT
    CASE
      WHEN public.has_role(_user_id, 'admin') THEN true
      WHEN NOT EXISTS (SELECT 1 FROM public.tenant_users WHERE user_id = _user_id AND tenant_id = _tenant_id) THEN false
      ELSE COALESCE(
        (SELECT visibility = 'editable' FROM public.tenant_permissions
         WHERE tenant_id = _tenant_id AND module = _module),
        true
      )
    END;
$$;

CREATE OR REPLACE FUNCTION public.module_visibility(_user_id uuid, _tenant_id uuid, _module text)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT visibility FROM public.tenant_permissions WHERE tenant_id = _tenant_id AND module = _module),
    'editable'
  );
$$;

-- 7. RLS expandido para clientes acessarem dados da própria empresa
-- tenants: SELECT próprio tenant
CREATE POLICY "Clients view own tenant" ON public.tenants
  FOR SELECT TO authenticated
  USING (id = public.get_user_tenant_id(auth.uid()));

CREATE POLICY "Clients update own tenant" ON public.tenants
  FOR UPDATE TO authenticated
  USING (id = public.get_user_tenant_id(auth.uid()))
  WITH CHECK (id = public.get_user_tenant_id(auth.uid()));

-- crm_leads
CREATE POLICY "Clients view own crm_leads" ON public.crm_leads
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

CREATE POLICY "Clients update own crm_leads" ON public.crm_leads
  FOR UPDATE TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid())
         AND public.can_edit_module(auth.uid(), tenant_id, 'crm'));

-- follow_ups
CREATE POLICY "Clients view own follow_ups" ON public.follow_ups
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

-- follow_up_sequences
CREATE POLICY "Clients view own sequences" ON public.follow_up_sequences
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

CREATE POLICY "Clients manage own sequences" ON public.follow_up_sequences
  FOR ALL TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid())
         AND public.can_edit_module(auth.uid(), tenant_id, 'followups'))
  WITH CHECK (tenant_id = public.get_user_tenant_id(auth.uid())
              AND public.can_edit_module(auth.uid(), tenant_id, 'followups'));

-- follow_up_steps (via sequência)
CREATE POLICY "Clients view own steps" ON public.follow_up_steps
  FOR SELECT TO authenticated
  USING (sequence_id IN (
    SELECT id FROM public.follow_up_sequences
    WHERE tenant_id = public.get_user_tenant_id(auth.uid())
  ));

CREATE POLICY "Clients manage own steps" ON public.follow_up_steps
  FOR ALL TO authenticated
  USING (sequence_id IN (
    SELECT id FROM public.follow_up_sequences
    WHERE tenant_id = public.get_user_tenant_id(auth.uid())
      AND public.can_edit_module(auth.uid(), tenant_id, 'followups')
  ))
  WITH CHECK (sequence_id IN (
    SELECT id FROM public.follow_up_sequences
    WHERE tenant_id = public.get_user_tenant_id(auth.uid())
      AND public.can_edit_module(auth.uid(), tenant_id, 'followups')
  ));

-- chat_messages
CREATE POLICY "Clients view own chat_messages" ON public.chat_messages
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

-- agent_logs
CREATE POLICY "Clients view own agent_logs" ON public.agent_logs
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

-- conversation_state
CREATE POLICY "Clients view own conversation_state" ON public.conversation_state
  FOR SELECT TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

-- crm_lead_history
CREATE POLICY "Clients view own crm_lead_history" ON public.crm_lead_history
  FOR SELECT TO authenticated
  USING (lead_id IN (
    SELECT id FROM public.crm_leads
    WHERE tenant_id = public.get_user_tenant_id(auth.uid())
  ));
