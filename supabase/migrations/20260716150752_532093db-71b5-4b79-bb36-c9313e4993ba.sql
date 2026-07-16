
-- ============================================================
-- 1. TENANTS: visibility + created_by
-- ============================================================
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'restricted',
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE public.tenants
  DROP CONSTRAINT IF EXISTS tenants_visibility_check;
ALTER TABLE public.tenants
  ADD CONSTRAINT tenants_visibility_check CHECK (visibility IN ('restricted','general'));

-- Backfill: todas as empresas atuais viram RESTRICTED
UPDATE public.tenants SET visibility = 'restricted' WHERE visibility IS NULL;

-- ============================================================
-- 2. staff_tenant_access
-- ============================================================
CREATE TABLE IF NOT EXISTS public.staff_tenant_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, tenant_id)
);

GRANT SELECT ON public.staff_tenant_access TO authenticated;
GRANT ALL ON public.staff_tenant_access TO service_role;
ALTER TABLE public.staff_tenant_access ENABLE ROW LEVEL SECURITY;

-- Admins gerenciam tudo
CREATE POLICY "Admins manage staff_tenant_access"
  ON public.staff_tenant_access FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Staff vê apenas suas próprias liberações (para saber que empresas tem)
CREATE POLICY "Staff see own accesses"
  ON public.staff_tenant_access FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- ============================================================
-- 3. Funções de acesso
-- ============================================================
CREATE OR REPLACE FUNCTION public.staff_has_tenant_access(_user_id uuid, _tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.has_role(_user_id, 'staff')
    AND (
      EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = _tenant_id AND t.visibility = 'general')
      OR EXISTS (SELECT 1 FROM public.staff_tenant_access sta WHERE sta.user_id = _user_id AND sta.tenant_id = _tenant_id)
    )
$$;

-- Combina admin + staff-com-acesso (helper usado em várias policies)
CREATE OR REPLACE FUNCTION public.can_access_tenant(_user_id uuid, _tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.has_role(_user_id, 'admin')
      OR public.staff_has_tenant_access(_user_id, _tenant_id)
$$;

REVOKE EXECUTE ON FUNCTION public.staff_has_tenant_access(uuid, uuid) FROM public, anon;
REVOKE EXECUTE ON FUNCTION public.can_access_tenant(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.staff_has_tenant_access(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_access_tenant(uuid, uuid) TO authenticated, service_role;

-- ============================================================
-- 4. TRIGGER: bloquear staff de alterar visibility/created_by
-- ============================================================
CREATE OR REPLACE FUNCTION public.protect_tenant_ownership_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN
    RETURN NEW;
  END IF;
  IF NEW.visibility IS DISTINCT FROM OLD.visibility THEN
    RAISE EXCEPTION 'Apenas administradores podem alterar a visibilidade da empresa';
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Apenas administradores podem alterar o responsável pela empresa';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_tenant_ownership ON public.tenants;
CREATE TRIGGER trg_protect_tenant_ownership
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_tenant_ownership_fields();

-- ============================================================
-- 5. TRIGGER: staff que cria empresa vira dono + ganha acesso automático
-- ============================================================
CREATE OR REPLACE FUNCTION public.tenant_grant_creator_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Força visibility restricted se um staff criou (admin pode escolher)
  IF NOT public.has_role(auth.uid(), 'admin') THEN
    NEW.visibility := 'restricted';
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_before_insert ON public.tenants;
CREATE TRIGGER trg_tenant_before_insert
  BEFORE INSERT ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.tenant_grant_creator_access();

CREATE OR REPLACE FUNCTION public.tenant_after_insert_grant_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.created_by IS NOT NULL AND public.has_role(NEW.created_by, 'staff') THEN
    INSERT INTO public.staff_tenant_access (user_id, tenant_id, granted_by)
    VALUES (NEW.created_by, NEW.id, NEW.created_by)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_tenant_after_insert ON public.tenants;
CREATE TRIGGER trg_tenant_after_insert
  AFTER INSERT ON public.tenants
  FOR EACH ROW
  EXECUTE FUNCTION public.tenant_after_insert_grant_access();

-- ============================================================
-- 6. RLS: TENANTS — adiciona policies staff
-- ============================================================
DROP POLICY IF EXISTS "Staff view accessible tenants" ON public.tenants;
CREATE POLICY "Staff view accessible tenants"
  ON public.tenants FOR SELECT
  TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), id));

DROP POLICY IF EXISTS "Staff insert tenants" ON public.tenants;
CREATE POLICY "Staff insert tenants"
  ON public.tenants FOR INSERT
  TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'staff'));

DROP POLICY IF EXISTS "Staff update accessible tenants" ON public.tenants;
CREATE POLICY "Staff update accessible tenants"
  ON public.tenants FOR UPDATE
  TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), id))
  WITH CHECK (public.staff_has_tenant_access(auth.uid(), id));

-- ============================================================
-- 7. RLS: policies staff para todas as tabelas tenant-scoped
-- ============================================================

-- agent_logs
DROP POLICY IF EXISTS "Staff view accessible agent_logs" ON public.agent_logs;
CREATE POLICY "Staff view accessible agent_logs" ON public.agent_logs
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- ai_prompt_versions
DROP POLICY IF EXISTS "Staff view accessible ai_prompt_versions" ON public.ai_prompt_versions;
CREATE POLICY "Staff view accessible ai_prompt_versions" ON public.ai_prompt_versions
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff insert ai_prompt_versions" ON public.ai_prompt_versions;
CREATE POLICY "Staff insert ai_prompt_versions" ON public.ai_prompt_versions
  FOR INSERT TO authenticated
  WITH CHECK (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff update ai_prompt_versions" ON public.ai_prompt_versions;
CREATE POLICY "Staff update ai_prompt_versions" ON public.ai_prompt_versions
  FOR UPDATE TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id))
  WITH CHECK (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- audit_logs
DROP POLICY IF EXISTS "Staff read accessible audit_logs" ON public.audit_logs;
CREATE POLICY "Staff read accessible audit_logs" ON public.audit_logs
  FOR SELECT TO authenticated
  USING (tenant_id IS NOT NULL AND public.staff_has_tenant_access(auth.uid(), tenant_id));

-- celcash_subscribers
DROP POLICY IF EXISTS "Staff view accessible celcash_subscribers" ON public.celcash_subscribers;
CREATE POLICY "Staff view accessible celcash_subscribers" ON public.celcash_subscribers
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- celcash_sync_runs
DROP POLICY IF EXISTS "Staff view accessible celcash_sync_runs" ON public.celcash_sync_runs;
CREATE POLICY "Staff view accessible celcash_sync_runs" ON public.celcash_sync_runs
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- chat_messages
DROP POLICY IF EXISTS "Staff view accessible chat_messages" ON public.chat_messages;
CREATE POLICY "Staff view accessible chat_messages" ON public.chat_messages
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff delete chat_messages" ON public.chat_messages;
CREATE POLICY "Staff delete chat_messages" ON public.chat_messages
  FOR DELETE TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- conversation_pauses
DROP POLICY IF EXISTS "Staff view conversation_pauses" ON public.conversation_pauses;
CREATE POLICY "Staff view conversation_pauses" ON public.conversation_pauses
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff insert conversation_pauses" ON public.conversation_pauses;
CREATE POLICY "Staff insert conversation_pauses" ON public.conversation_pauses
  FOR INSERT TO authenticated
  WITH CHECK (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff update conversation_pauses" ON public.conversation_pauses;
CREATE POLICY "Staff update conversation_pauses" ON public.conversation_pauses
  FOR UPDATE TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id))
  WITH CHECK (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff delete conversation_pauses" ON public.conversation_pauses;
CREATE POLICY "Staff delete conversation_pauses" ON public.conversation_pauses
  FOR DELETE TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- conversation_state
DROP POLICY IF EXISTS "Staff view conversation_state" ON public.conversation_state;
CREATE POLICY "Staff view conversation_state" ON public.conversation_state
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff delete conversation_state" ON public.conversation_state;
CREATE POLICY "Staff delete conversation_state" ON public.conversation_state
  FOR DELETE TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- crm_boards
DROP POLICY IF EXISTS "Staff view crm_boards" ON public.crm_boards;
CREATE POLICY "Staff view crm_boards" ON public.crm_boards
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff insert crm_boards" ON public.crm_boards;
CREATE POLICY "Staff insert crm_boards" ON public.crm_boards
  FOR INSERT TO authenticated
  WITH CHECK (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff update crm_boards" ON public.crm_boards;
CREATE POLICY "Staff update crm_boards" ON public.crm_boards
  FOR UPDATE TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id))
  WITH CHECK (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff delete crm_boards" ON public.crm_boards;
CREATE POLICY "Staff delete crm_boards" ON public.crm_boards
  FOR DELETE TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- crm_lead_history
DROP POLICY IF EXISTS "Staff view crm_lead_history" ON public.crm_lead_history;
CREATE POLICY "Staff view crm_lead_history" ON public.crm_lead_history
  FOR SELECT TO authenticated
  USING (lead_id IN (
    SELECT id FROM public.crm_leads WHERE public.staff_has_tenant_access(auth.uid(), tenant_id)
  ));

-- crm_leads
DROP POLICY IF EXISTS "Staff view crm_leads" ON public.crm_leads;
CREATE POLICY "Staff view crm_leads" ON public.crm_leads
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff update crm_leads" ON public.crm_leads;
CREATE POLICY "Staff update crm_leads" ON public.crm_leads
  FOR UPDATE TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id))
  WITH CHECK (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- follow_up_sequences
DROP POLICY IF EXISTS "Staff view follow_up_sequences" ON public.follow_up_sequences;
CREATE POLICY "Staff view follow_up_sequences" ON public.follow_up_sequences
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));
DROP POLICY IF EXISTS "Staff manage follow_up_sequences" ON public.follow_up_sequences;
CREATE POLICY "Staff manage follow_up_sequences" ON public.follow_up_sequences
  FOR ALL TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id))
  WITH CHECK (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- follow_up_steps
DROP POLICY IF EXISTS "Staff manage follow_up_steps" ON public.follow_up_steps;
CREATE POLICY "Staff manage follow_up_steps" ON public.follow_up_steps
  FOR ALL TO authenticated
  USING (sequence_id IN (
    SELECT id FROM public.follow_up_sequences WHERE public.staff_has_tenant_access(auth.uid(), tenant_id)
  ))
  WITH CHECK (sequence_id IN (
    SELECT id FROM public.follow_up_sequences WHERE public.staff_has_tenant_access(auth.uid(), tenant_id)
  ));

-- follow_ups
DROP POLICY IF EXISTS "Staff view follow_ups" ON public.follow_ups;
CREATE POLICY "Staff view follow_ups" ON public.follow_ups
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- onebeleza_client_aliases
DROP POLICY IF EXISTS "Staff view onebeleza_aliases" ON public.onebeleza_client_aliases;
CREATE POLICY "Staff view onebeleza_aliases" ON public.onebeleza_client_aliases
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));

-- tenant_permissions: staff apenas leitura das empresas que acessa
DROP POLICY IF EXISTS "Staff read tenant_permissions" ON public.tenant_permissions;
CREATE POLICY "Staff read tenant_permissions" ON public.tenant_permissions
  FOR SELECT TO authenticated
  USING (public.staff_has_tenant_access(auth.uid(), tenant_id));
