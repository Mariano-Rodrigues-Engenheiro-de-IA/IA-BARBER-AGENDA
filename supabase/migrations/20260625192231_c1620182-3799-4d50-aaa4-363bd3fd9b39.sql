
ALTER TYPE public.api_provider ADD VALUE IF NOT EXISTS 'appbarber';

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS appbarber_api_key TEXT,
  ADD COLUMN IF NOT EXISTS appbarber_establishment_code TEXT,
  ADD COLUMN IF NOT EXISTS appbarber_base_url TEXT DEFAULT 'https://proxy.zayloia.com';

CREATE OR REPLACE FUNCTION public.prevent_tenant_sensitive_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
     OR NEW.appbarber_api_key IS DISTINCT FROM OLD.appbarber_api_key
     OR NEW.appbarber_establishment_code IS DISTINCT FROM OLD.appbarber_establishment_code
     OR NEW.appbarber_base_url IS DISTINCT FROM OLD.appbarber_base_url
     OR NEW.celcash_enabled IS DISTINCT FROM OLD.celcash_enabled
     OR NEW.celcash_env IS DISTINCT FROM OLD.celcash_env
     OR NEW.celcash_galax_id IS DISTINCT FROM OLD.celcash_galax_id
     OR NEW.celcash_galax_hash IS DISTINCT FROM OLD.celcash_galax_hash
     OR NEW.api_provider IS DISTINCT FROM OLD.api_provider
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.kanban_columns IS DISTINCT FROM OLD.kanban_columns
  THEN
    RAISE EXCEPTION 'Apenas administradores podem alterar credenciais e configurações sensíveis do tenant';
  END IF;

  IF NEW.agent_system_prompt IS DISTINCT FROM OLD.agent_system_prompt
     AND NOT public.can_edit_module(auth.uid(), NEW.id, 'ai_prompt') THEN
    RAISE EXCEPTION 'Sem permissão para alterar o prompt da IA';
  END IF;

  IF NEW.agent_knowledge_base IS DISTINCT FROM OLD.agent_knowledge_base
     AND NOT public.can_edit_module(auth.uid(), NEW.id, 'ai_knowledge') THEN
    RAISE EXCEPTION 'Sem permissão para alterar a base de conhecimento da IA';
  END IF;

  IF NEW.agent_settings IS DISTINCT FROM OLD.agent_settings
     AND NOT public.can_edit_module(auth.uid(), NEW.id, 'ai_prompt') THEN
    RAISE EXCEPTION 'Sem permissão para alterar as configurações do agente';
  END IF;

  IF NEW.agent_paused IS DISTINCT FROM OLD.agent_paused
     AND NOT public.can_edit_module(auth.uid(), NEW.id, 'ai_prompt') THEN
    RAISE EXCEPTION 'Sem permissão para pausar/retomar o agente';
  END IF;

  RETURN NEW;
END;
$function$;
