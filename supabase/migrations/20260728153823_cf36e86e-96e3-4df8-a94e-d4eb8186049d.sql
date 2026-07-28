ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS economic_mode_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS chat_site_banner_url text,
  ADD COLUMN IF NOT EXISTS chat_site_welcome_message text,
  ADD COLUMN IF NOT EXISTS chat_site_brand_color text,
  ADD COLUMN IF NOT EXISTS chat_site_theme text NOT NULL DEFAULT 'dark',
  ADD COLUMN IF NOT EXISTS chat_site_invite_message text;

CREATE TABLE IF NOT EXISTS public.web_chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  token text NOT NULL UNIQUE,
  display_name text,
  invite_sent_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_number)
);

GRANT SELECT ON public.web_chat_sessions TO authenticated;
GRANT ALL ON public.web_chat_sessions TO service_role;

ALTER TABLE public.web_chat_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins and tenant members can view web chat sessions"
ON public.web_chat_sessions FOR SELECT TO authenticated
USING (
  public.has_role(auth.uid(), 'admin')
  OR public.staff_has_tenant_access(auth.uid(), tenant_id)
  OR EXISTS (SELECT 1 FROM public.tenant_users tu WHERE tu.user_id = auth.uid() AND tu.tenant_id = web_chat_sessions.tenant_id)
);

CREATE TRIGGER update_web_chat_sessions_updated_at
BEFORE UPDATE ON public.web_chat_sessions
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

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
     OR NEW.agent_mode IS DISTINCT FROM OLD.agent_mode
     OR NEW.test_phone_numbers IS DISTINCT FROM OLD.test_phone_numbers
     OR NEW.economic_mode_enabled IS DISTINCT FROM OLD.economic_mode_enabled
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