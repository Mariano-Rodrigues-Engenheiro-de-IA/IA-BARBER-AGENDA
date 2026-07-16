
CREATE OR REPLACE FUNCTION public.audit_tenants_changes()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_role text;
  v_before jsonb := '{}'::jsonb;
  v_after jsonb := '{}'::jsonb;
  v_actions text[] := ARRAY[]::text[];
  v_action text;
  v_settings_generic boolean := false;
BEGIN
  IF v_uid IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  v_role := public._current_actor_role();

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.audit_logs (tenant_id, user_id, actor_role, action, entity, entity_id, before, after)
    VALUES (NEW.id, v_uid, v_role, 'tenant_created', 'tenants', NEW.id::text, NULL,
      jsonb_build_object('name', NEW.name, 'visibility', NEW.visibility, 'api_provider', NEW.api_provider));
    RETURN NEW;
  END IF;

  IF NEW.agent_system_prompt IS DISTINCT FROM OLD.agent_system_prompt THEN
    v_actions := array_append(v_actions, 'prompt_updated');
    v_before := v_before || jsonb_build_object('agent_system_prompt', OLD.agent_system_prompt);
    v_after  := v_after  || jsonb_build_object('agent_system_prompt', NEW.agent_system_prompt);
  END IF;
  IF NEW.agent_knowledge_base IS DISTINCT FROM OLD.agent_knowledge_base THEN
    v_actions := array_append(v_actions, 'knowledge_updated');
    v_before := v_before || jsonb_build_object('agent_knowledge_base', OLD.agent_knowledge_base);
    v_after  := v_after  || jsonb_build_object('agent_knowledge_base', NEW.agent_knowledge_base);
  END IF;
  IF NEW.agent_paused IS DISTINCT FROM OLD.agent_paused THEN
    v_actions := array_append(v_actions, CASE WHEN NEW.agent_paused THEN 'agent_paused' ELSE 'agent_resumed' END);
    v_before := v_before || jsonb_build_object('agent_paused', OLD.agent_paused);
    v_after  := v_after  || jsonb_build_object('agent_paused', NEW.agent_paused);
  END IF;
  IF NEW.visibility IS DISTINCT FROM OLD.visibility THEN
    v_actions := array_append(v_actions, 'visibility_changed');
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
    v_actions := array_append(v_actions, 'integrations_updated');
    v_before := v_before || jsonb_build_object('api_provider', OLD.api_provider);
    v_after  := v_after  || jsonb_build_object('api_provider', NEW.api_provider);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_actions := array_append(v_actions, 'status_changed');
    v_before := v_before || jsonb_build_object('status', OLD.status);
    v_after  := v_after  || jsonb_build_object('status', NEW.status);
  END IF;

  -- agent_settings sub-keys (custom_tools, response_delay, follow_ups) + generic fallback
  IF NEW.agent_settings IS DISTINCT FROM OLD.agent_settings THEN
    v_settings_generic := true;
    IF (NEW.agent_settings->'custom_tools') IS DISTINCT FROM (OLD.agent_settings->'custom_tools') THEN
      v_actions := array_append(v_actions, 'custom_tools_updated');
      v_before := v_before || jsonb_build_object('custom_tools', OLD.agent_settings->'custom_tools');
      v_after  := v_after  || jsonb_build_object('custom_tools', NEW.agent_settings->'custom_tools');
      v_settings_generic := false;
    END IF;
    IF (NEW.agent_settings->'response_delay') IS DISTINCT FROM (OLD.agent_settings->'response_delay') THEN
      v_actions := array_append(v_actions, 'response_delay_updated');
      v_before := v_before || jsonb_build_object('response_delay', OLD.agent_settings->'response_delay');
      v_after  := v_after  || jsonb_build_object('response_delay', NEW.agent_settings->'response_delay');
      v_settings_generic := false;
    END IF;
    IF (NEW.agent_settings->'follow_ups') IS DISTINCT FROM (OLD.agent_settings->'follow_ups') THEN
      v_actions := array_append(v_actions, 'follow_ups_updated');
      v_before := v_before || jsonb_build_object('follow_ups', OLD.agent_settings->'follow_ups');
      v_after  := v_after  || jsonb_build_object('follow_ups', NEW.agent_settings->'follow_ups');
      v_settings_generic := false;
    END IF;
    IF v_settings_generic THEN
      v_actions := array_append(v_actions, 'agent_settings_updated');
      v_before := v_before || jsonb_build_object('agent_settings', OLD.agent_settings);
      v_after  := v_after  || jsonb_build_object('agent_settings', NEW.agent_settings);
    END IF;
  END IF;

  IF NEW.kanban_columns IS DISTINCT FROM OLD.kanban_columns THEN
    v_actions := array_append(v_actions, 'kanban_updated');
    v_before := v_before || jsonb_build_object('kanban_columns', OLD.kanban_columns);
    v_after  := v_after  || jsonb_build_object('kanban_columns', NEW.kanban_columns);
  END IF;

  IF NEW.name IS DISTINCT FROM OLD.name
     OR NEW.whatsapp_number IS DISTINCT FROM OLD.whatsapp_number
     OR NEW.logo_url IS DISTINCT FROM OLD.logo_url
     OR NEW.slug IS DISTINCT FROM OLD.slug THEN
    v_actions := array_append(v_actions, 'profile_updated');
    v_before := v_before || jsonb_build_object('name', OLD.name, 'whatsapp_number', OLD.whatsapp_number, 'logo_url', OLD.logo_url, 'slug', OLD.slug);
    v_after  := v_after  || jsonb_build_object('name', NEW.name, 'whatsapp_number', NEW.whatsapp_number, 'logo_url', NEW.logo_url, 'slug', NEW.slug);
  END IF;

  IF array_length(v_actions, 1) IS NULL THEN
    RETURN NEW;
  END IF;

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
$function$;
