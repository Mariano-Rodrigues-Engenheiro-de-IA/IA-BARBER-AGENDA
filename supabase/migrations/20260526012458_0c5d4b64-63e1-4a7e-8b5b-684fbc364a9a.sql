-- 1) Block non-admins from updating sensitive tenant columns via trigger
CREATE OR REPLACE FUNCTION public.prevent_tenant_sensitive_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.has_role(auth.uid(), 'admin') THEN
    RETURN NEW;
  END IF;

  IF NEW.uazapi_token IS DISTINCT FROM OLD.uazapi_token
     OR NEW.uazapi_url IS DISTINCT FROM OLD.uazapi_url
     OR NEW.trinks_api_key IS DISTINCT FROM OLD.trinks_api_key
     OR NEW.trinks_establishment_id IS DISTINCT FROM OLD.trinks_establishment_id
     OR NEW.onebeleza_token IS DISTINCT FROM OLD.onebeleza_token
     OR NEW.onebeleza_celular IS DISTINCT FROM OLD.onebeleza_celular
     OR NEW.bemp_token IS DISTINCT FROM OLD.bemp_token
     OR NEW.bemp_domain IS DISTINCT FROM OLD.bemp_domain
     OR NEW.frizzar_token IS DISTINCT FROM OLD.frizzar_token
     OR NEW.frizzar_base_url IS DISTINCT FROM OLD.frizzar_base_url
     OR NEW.zaylo_publishable_key IS DISTINCT FROM OLD.zaylo_publishable_key
     OR NEW.zaylo_base_url IS DISTINCT FROM OLD.zaylo_base_url
     OR NEW.zaylo_barbershop_id IS DISTINCT FROM OLD.zaylo_barbershop_id
     OR NEW.agent_system_prompt IS DISTINCT FROM OLD.agent_system_prompt
     OR NEW.agent_knowledge_base IS DISTINCT FROM OLD.agent_knowledge_base
     OR NEW.agent_settings IS DISTINCT FROM OLD.agent_settings
     OR NEW.agent_paused IS DISTINCT FROM OLD.agent_paused
     OR NEW.api_provider IS DISTINCT FROM OLD.api_provider
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.kanban_columns IS DISTINCT FROM OLD.kanban_columns
  THEN
    RAISE EXCEPTION 'Apenas administradores podem alterar credenciais e configurações sensíveis do tenant';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_tenant_sensitive_update ON public.tenants;
CREATE TRIGGER trg_prevent_tenant_sensitive_update
BEFORE UPDATE ON public.tenants
FOR EACH ROW
EXECUTE FUNCTION public.prevent_tenant_sensitive_update();

-- 2) Remove tenants from realtime publication (credentials should not stream)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'tenants'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime DROP TABLE public.tenants';
  END IF;
END $$;