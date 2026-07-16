CREATE OR REPLACE FUNCTION public.can_edit_module(_user_id uuid, _tenant_id uuid, _module text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    CASE
      WHEN public.has_role(_user_id, 'admin') THEN true
      WHEN public.staff_has_tenant_access(_user_id, _tenant_id) THEN true
      WHEN NOT EXISTS (SELECT 1 FROM public.tenant_users WHERE user_id = _user_id AND tenant_id = _tenant_id) THEN false
      ELSE COALESCE(
        (SELECT visibility = 'editable' FROM public.tenant_permissions
         WHERE tenant_id = _tenant_id AND module = _module),
        true
      )
    END;
$function$;