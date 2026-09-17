-- Colaboradores (staff) podem receber, módulo por módulo, as mesmas
-- capacidades do admin. Tudo continua controlado manualmente pelo painel
-- em staff_module_access; sem o módulo marcado, nada muda.

-- 1) Campos sensíveis do tenant (tokens/integrações) e gestão da empresa
CREATE OR REPLACE FUNCTION public.prevent_tenant_sensitive_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_admin boolean;
  v_access boolean;
  v_creds boolean;
  v_manage boolean;
BEGIN
  v_admin := public.has_role(v_uid, 'admin');
  IF v_admin THEN
    RETURN NEW;
  END IF;

  v_access := public.staff_has_tenant_access(v_uid, NEW.id);
  v_creds  := v_access AND public.staff_has_module(v_uid, 'tenant-credentials');
  v_manage := v_access AND public.staff_has_module(v_uid, 'tenant-manage');

  IF NOT v_creds AND (
       NEW.uazapi_token IS DISTINCT FROM OLD.uazapi_token
    OR NEW.uazapi_url IS DISTINCT FROM OLD.uazapi_url
    OR NEW.trinks_api_key IS DISTINCT FROM OLD.trinks_api_key
    OR NEW.trinks_establishment_id IS DISTINCT FROM OLD.trinks_establishment_id
    OR NEW.onebeleza_token IS DISTINCT FROM OLD.onebeleza_token
    OR NEW.onebeleza_celular IS DISTINCT FROM OLD.onebeleza_celular
    OR NEW.bemp_token IS DISTINCT FROM OLD.bemp_token
    OR NEW.bemp_domain IS DISTINCT FROM OLD.bemp_domain
    OR NEW.frizzar_token IS DISTINCT FROM OLD.frizzar_token
    OR NEW.frizzar_base_url IS DISTINCT FROM OLD.frizzar_base_url
    OR NEW.appbarber_api_key IS DISTINCT FROM OLD.appbarber_api_key
    OR NEW.appbarber_establishment_code IS DISTINCT FROM OLD.appbarber_establishment_code
    OR NEW.appbarber_base_url IS DISTINCT FROM OLD.appbarber_base_url
    OR NEW.celcash_enabled IS DISTINCT FROM OLD.celcash_enabled
    OR NEW.celcash_env IS DISTINCT FROM OLD.celcash_env
    OR NEW.celcash_galax_id IS DISTINCT FROM OLD.celcash_galax_id
    OR NEW.celcash_galax_hash IS DISTINCT FROM OLD.celcash_galax_hash
    OR NEW.api_provider IS DISTINCT FROM OLD.api_provider
  ) THEN
    RAISE EXCEPTION 'Sem permissão para alterar credenciais e integrações desta empresa';
  END IF;

  IF NOT v_manage AND (
       NEW.status IS DISTINCT FROM OLD.status
    OR NEW.slug IS DISTINCT FROM OLD.slug
    OR NEW.kanban_columns IS DISTINCT FROM OLD.kanban_columns
    OR NEW.agent_mode IS DISTINCT FROM OLD.agent_mode
    OR NEW.test_phone_numbers IS DISTINCT FROM OLD.test_phone_numbers
    OR NEW.economic_mode_enabled IS DISTINCT FROM OLD.economic_mode_enabled
    OR NEW.archived IS DISTINCT FROM OLD.archived
    OR NEW.archived_at IS DISTINCT FROM OLD.archived_at
  ) THEN
    RAISE EXCEPTION 'Sem permissão para alterar configurações de gestão desta empresa';
  END IF;

  IF NEW.agent_system_prompt IS DISTINCT FROM OLD.agent_system_prompt
     AND NOT public.can_edit_module(v_uid, NEW.id, 'ai_prompt') THEN
    RAISE EXCEPTION 'Sem permissão para alterar o prompt da IA';
  END IF;

  IF NEW.agent_knowledge_base IS DISTINCT FROM OLD.agent_knowledge_base
     AND NOT public.can_edit_module(v_uid, NEW.id, 'ai_knowledge') THEN
    RAISE EXCEPTION 'Sem permissão para alterar a base de conhecimento da IA';
  END IF;

  IF NEW.agent_settings IS DISTINCT FROM OLD.agent_settings
     AND NOT public.can_edit_module(v_uid, NEW.id, 'ai_prompt') THEN
    RAISE EXCEPTION 'Sem permissão para alterar as configurações do agente';
  END IF;

  RETURN NEW;
END;
$function$;

-- 2) Visibilidade da empresa: liberada para staff com o módulo de gestão
CREATE OR REPLACE FUNCTION public.protect_tenant_ownership_fields()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN
    RETURN NEW;
  END IF;
  IF NEW.visibility IS DISTINCT FROM OLD.visibility
     AND NOT public.staff_has_module(auth.uid(), 'tenant-manage') THEN
    RAISE EXCEPTION 'Sem permissão para alterar a visibilidade da empresa';
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Apenas administradores podem alterar o responsável pela empresa';
  END IF;
  RETURN NEW;
END;
$function$;

-- 3) Excluir empresa (staff com módulo de gestão e acesso à empresa)
DROP POLICY IF EXISTS "Staff delete accessible tenants" ON public.tenants;
CREATE POLICY "Staff delete accessible tenants" ON public.tenants
FOR DELETE TO authenticated
USING (public.staff_has_tenant_access(auth.uid(), id)
       AND public.staff_has_module(auth.uid(), 'tenant-manage'));

-- 4) Prompts globais por provider
DROP POLICY IF EXISTS "Staff read provider prompts" ON public.provider_prompts;
CREATE POLICY "Staff read provider prompts" ON public.provider_prompts
FOR SELECT TO authenticated
USING (public.staff_has_module(auth.uid(), 'prompts'));

DROP POLICY IF EXISTS "Staff write provider prompts" ON public.provider_prompts;
CREATE POLICY "Staff write provider prompts" ON public.provider_prompts
FOR INSERT TO authenticated
WITH CHECK (public.staff_has_module(auth.uid(), 'prompts'));

DROP POLICY IF EXISTS "Staff update provider prompts" ON public.provider_prompts;
CREATE POLICY "Staff update provider prompts" ON public.provider_prompts
FOR UPDATE TO authenticated
USING (public.staff_has_module(auth.uid(), 'prompts'))
WITH CHECK (public.staff_has_module(auth.uid(), 'prompts'));

DROP POLICY IF EXISTS "Staff delete provider prompts" ON public.provider_prompts;
CREATE POLICY "Staff delete provider prompts" ON public.provider_prompts
FOR DELETE TO authenticated
USING (public.staff_has_module(auth.uid(), 'prompts'));

-- 5) Gestão de colaboradores (aba "Colaboradores")
DROP POLICY IF EXISTS "Staff manage staff_tenant_access" ON public.staff_tenant_access;
CREATE POLICY "Staff manage staff_tenant_access" ON public.staff_tenant_access
FOR ALL TO authenticated
USING (public.staff_has_module(auth.uid(), 'staff'))
WITH CHECK (public.staff_has_module(auth.uid(), 'staff'));

DROP POLICY IF EXISTS "Staff manage staff_module_access" ON public.staff_module_access;
CREATE POLICY "Staff manage staff_module_access" ON public.staff_module_access
FOR ALL TO authenticated
USING (public.staff_has_module(auth.uid(), 'staff'))
WITH CHECK (public.staff_has_module(auth.uid(), 'staff'));

-- 6) Acessos e permissões por empresa
DROP POLICY IF EXISTS "Staff manage tenant_permissions" ON public.tenant_permissions;
CREATE POLICY "Staff manage tenant_permissions" ON public.tenant_permissions
FOR ALL TO authenticated
USING (public.staff_has_module(auth.uid(), 'tenant-access')
       AND public.staff_has_tenant_access(auth.uid(), tenant_id))
WITH CHECK (public.staff_has_module(auth.uid(), 'tenant-access')
       AND public.staff_has_tenant_access(auth.uid(), tenant_id));

DROP POLICY IF EXISTS "Staff manage tenant_users" ON public.tenant_users;
CREATE POLICY "Staff manage tenant_users" ON public.tenant_users
FOR ALL TO authenticated
USING (public.staff_has_module(auth.uid(), 'tenant-access')
       AND public.staff_has_tenant_access(auth.uid(), tenant_id))
WITH CHECK (public.staff_has_module(auth.uid(), 'tenant-access')
       AND public.staff_has_tenant_access(auth.uid(), tenant_id));