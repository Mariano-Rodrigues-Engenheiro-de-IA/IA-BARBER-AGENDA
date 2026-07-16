
-- === Módulo por colaborador ===
CREATE TABLE public.staff_module_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  module text NOT NULL,
  granted_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, module)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.staff_module_access TO authenticated;
GRANT ALL ON public.staff_module_access TO service_role;
ALTER TABLE public.staff_module_access ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage staff module access"
  ON public.staff_module_access FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Users read own module access"
  ON public.staff_module_access FOR SELECT
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.staff_has_module(_user_id uuid, _module text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(_user_id, 'admin')
      OR EXISTS (SELECT 1 FROM public.staff_module_access
                 WHERE user_id = _user_id AND module = _module);
$$;

-- === Auditoria automática via triggers ===
CREATE OR REPLACE FUNCTION public._current_actor_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN public.has_role(auth.uid(), 'admin') THEN 'admin'
    WHEN public.has_role(auth.uid(), 'staff') THEN 'staff'
    WHEN public.has_role(auth.uid(), 'client') THEN 'client'
    ELSE 'system'
  END;
$$;

-- Permite triggers SECURITY DEFINER inserirem em audit_logs mesmo sob RLS
DROP POLICY IF EXISTS "Triggers can insert audit logs" ON public.audit_logs;
CREATE POLICY "Triggers can insert audit logs"
  ON public.audit_logs FOR INSERT
  WITH CHECK (true);

-- Trigger de tenants: prompt, base, integrações, pausa, visibilidade, criação
CREATE OR REPLACE FUNCTION public.audit_tenants_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_actions text[] := ARRAY[]::text[];
  v_action text;
BEGIN
  IF v_uid IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  v_role := public._current_actor_role();

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.audit_logs (tenant_id, user_id, actor_role, action, entity, entity_id, before, after)
    VALUES (NEW.id, v_uid, v_role, 'tenant_created', 'tenants', NEW.id::text, NULL,
      jsonb_build_object('name', NEW.name, 'visibility', NEW.visibility, 'api_provider', NEW.api_provider));
    RETURN NEW;
  END IF;

  -- UPDATE — detecta cada mudança relevante
  IF NEW.agent_system_prompt IS DISTINCT FROM OLD.agent_system_prompt THEN
    v_actions := v_actions || 'prompt_updated';
    v_before := v_before || jsonb_build_object('agent_system_prompt', OLD.agent_system_prompt);
    v_after  := v_after  || jsonb_build_object('agent_system_prompt', NEW.agent_system_prompt);
  END IF;
  IF NEW.agent_knowledge_base IS DISTINCT FROM OLD.agent_knowledge_base THEN
    v_actions := v_actions || 'knowledge_updated';
    v_before := v_before || jsonb_build_object('agent_knowledge_base', OLD.agent_knowledge_base);
    v_after  := v_after  || jsonb_build_object('agent_knowledge_base', NEW.agent_knowledge_base);
  END IF;
  IF NEW.agent_paused IS DISTINCT FROM OLD.agent_paused THEN
    v_actions := v_actions || (CASE WHEN NEW.agent_paused THEN 'agent_paused' ELSE 'agent_resumed' END);
    v_before := v_before || jsonb_build_object('agent_paused', OLD.agent_paused);
    v_after  := v_after  || jsonb_build_object('agent_paused', NEW.agent_paused);
  END IF;
  IF NEW.visibility IS DISTINCT FROM OLD.visibility THEN
    v_actions := v_actions || 'visibility_changed';
    v_before := v_before || jsonb_build_object('visibility', OLD.visibility);
    v_after  := v_after  || jsonb_build_object('visibility', NEW.visibility);
  END IF;
  IF NEW.api_provider IS DISTINCT FROM OLD.api_provider
     OR NEW.trinks_api_key IS DISTINCT FROM OLD.trinks_api_key
     OR NEW.trinks_establishment_id IS DISTINCT FROM OLD.trinks_establishment_id
     OR NEW.onebeleza_token IS DISTINCT FROM OLD.onebeleza_token
     OR NEW.onebeleza_celular IS DISTINCT FROM OLD.onebeleza_celular
     OR NEW.frizzar_token IS DISTINCT FROM OLD.frizzar_token
     OR NEW.frizzar_base_url IS DISTINCT FROM OLD.frizzar_base_url
     OR NEW.bemp_token IS DISTINCT FROM OLD.bemp_token
     OR NEW.bemp_domain IS DISTINCT FROM OLD.bemp_domain
     OR NEW.appbarber_api_key IS DISTINCT FROM OLD.appbarber_api_key
     OR NEW.appbarber_establishment_code IS DISTINCT FROM OLD.appbarber_establishment_code
     OR NEW.appbarber_base_url IS DISTINCT FROM OLD.appbarber_base_url
     OR NEW.uazapi_token IS DISTINCT FROM OLD.uazapi_token
     OR NEW.uazapi_url IS DISTINCT FROM OLD.uazapi_url THEN
    v_actions := v_actions || 'integrations_updated';
    v_before := v_before || jsonb_build_object('api_provider', OLD.api_provider);
    v_after  := v_after  || jsonb_build_object('api_provider', NEW.api_provider);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_actions := v_actions || 'status_changed';
    v_before := v_before || jsonb_build_object('status', OLD.status);
    v_after  := v_after  || jsonb_build_object('status', NEW.status);
  END IF;

  -- Se nada relevante mudou, ignora (evita ruído de updated_at)
  IF array_length(v_actions, 1) IS NULL THEN
    RETURN NEW;
  END IF;

  -- Se só uma ação, usa nome específico; se várias, agrega
  IF array_length(v_actions, 1) = 1 THEN
    v_action := v_actions[1];
  ELSE
    v_action := 'tenant_updated_multi';
    v_after := v_after || jsonb_build_object('_changes', to_jsonb(v_actions));
  END IF;

  INSERT INTO public.audit_logs (tenant_id, user_id, actor_role, action, entity, entity_id, before, after)
  VALUES (NEW.id, v_uid, v_role, v_action, 'tenants', NEW.id::text, v_before, v_after);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_tenants_changes_trg ON public.tenants;
CREATE TRIGGER audit_tenants_changes_trg
  AFTER INSERT OR UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.audit_tenants_changes();

-- Trigger de staff_tenant_access
CREATE OR REPLACE FUNCTION public.audit_staff_tenant_access()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  INSERT INTO public.audit_logs (tenant_id, user_id, actor_role, action, entity, entity_id, before, after)
  VALUES (
    COALESCE(NEW.tenant_id, OLD.tenant_id), v_uid, public._current_actor_role(),
    CASE WHEN TG_OP = 'INSERT' THEN 'staff_access_granted' ELSE 'staff_access_revoked' END,
    'staff_tenant_access',
    COALESCE(NEW.user_id, OLD.user_id)::text,
    CASE WHEN TG_OP = 'DELETE' THEN jsonb_build_object('user_id', OLD.user_id, 'tenant_id', OLD.tenant_id) END,
    CASE WHEN TG_OP = 'INSERT' THEN jsonb_build_object('user_id', NEW.user_id, 'tenant_id', NEW.tenant_id) END
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS audit_staff_tenant_access_trg ON public.staff_tenant_access;
CREATE TRIGGER audit_staff_tenant_access_trg
  AFTER INSERT OR DELETE ON public.staff_tenant_access
  FOR EACH ROW EXECUTE FUNCTION public.audit_staff_tenant_access();

-- Trigger de staff_module_access
CREATE OR REPLACE FUNCTION public.audit_staff_module_access()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  INSERT INTO public.audit_logs (tenant_id, user_id, actor_role, action, entity, entity_id, before, after)
  VALUES (
    NULL, v_uid, public._current_actor_role(),
    CASE WHEN TG_OP = 'INSERT' THEN 'module_access_granted' ELSE 'module_access_revoked' END,
    'staff_module_access',
    COALESCE(NEW.user_id, OLD.user_id)::text,
    CASE WHEN TG_OP = 'DELETE' THEN jsonb_build_object('user_id', OLD.user_id, 'module', OLD.module) END,
    CASE WHEN TG_OP = 'INSERT' THEN jsonb_build_object('user_id', NEW.user_id, 'module', NEW.module) END
  );
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS audit_staff_module_access_trg ON public.staff_module_access;
CREATE TRIGGER audit_staff_module_access_trg
  AFTER INSERT OR DELETE ON public.staff_module_access
  FOR EACH ROW EXECUTE FUNCTION public.audit_staff_module_access();

-- Trigger de movimento de lead no CRM
CREATE OR REPLACE FUNCTION public.audit_crm_lead_move()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;
  IF NEW.column_id IS DISTINCT FROM OLD.column_id THEN
    INSERT INTO public.audit_logs (tenant_id, user_id, actor_role, action, entity, entity_id, before, after)
    VALUES (NEW.tenant_id, v_uid, public._current_actor_role(),
      'lead_moved', 'crm_leads', NEW.id::text,
      jsonb_build_object('column_id', OLD.column_id),
      jsonb_build_object('column_id', NEW.column_id, 'lead_name', NEW.name));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS audit_crm_lead_move_trg ON public.crm_leads;
CREATE TRIGGER audit_crm_lead_move_trg
  AFTER UPDATE ON public.crm_leads
  FOR EACH ROW EXECUTE FUNCTION public.audit_crm_lead_move();
