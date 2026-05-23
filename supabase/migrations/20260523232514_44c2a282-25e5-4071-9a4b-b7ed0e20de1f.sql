
-- ============ Remove public/anon policies (service_role bypasses RLS) ============

-- conversation_state
DROP POLICY IF EXISTS "Service can select conversation_state" ON public.conversation_state;
DROP POLICY IF EXISTS "Service can insert conversation_state" ON public.conversation_state;
DROP POLICY IF EXISTS "Service can update conversation_state" ON public.conversation_state;
DROP POLICY IF EXISTS "Service can delete conversation_state" ON public.conversation_state;

-- chat_messages
DROP POLICY IF EXISTS "Service can insert chat messages" ON public.chat_messages;

-- agent_logs
DROP POLICY IF EXISTS "Service can insert agent logs" ON public.agent_logs;

-- crm_leads
DROP POLICY IF EXISTS "Service can insert crm_leads" ON public.crm_leads;
DROP POLICY IF EXISTS "Service can update crm_leads" ON public.crm_leads;

-- crm_lead_history
DROP POLICY IF EXISTS "Service can insert crm_lead_history" ON public.crm_lead_history;

-- follow_ups
DROP POLICY IF EXISTS "Service can insert follow_ups" ON public.follow_ups;
DROP POLICY IF EXISTS "Service can update follow_ups" ON public.follow_ups;

-- follow_up_sequences / steps (remove public SELECT)
DROP POLICY IF EXISTS "Service can read sequences" ON public.follow_up_sequences;
DROP POLICY IF EXISTS "Service can read steps" ON public.follow_up_steps;

-- onebeleza_client_aliases
DROP POLICY IF EXISTS "Service can select onebeleza_aliases" ON public.onebeleza_client_aliases;
DROP POLICY IF EXISTS "Service can insert onebeleza_aliases" ON public.onebeleza_client_aliases;
DROP POLICY IF EXISTS "Service can update onebeleza_aliases" ON public.onebeleza_client_aliases;

-- audit_logs: remove public insert; tighten authenticated insert
DROP POLICY IF EXISTS "Service insert audit_logs" ON public.audit_logs;
DROP POLICY IF EXISTS "Authenticated insert audit_logs" ON public.audit_logs;

CREATE POLICY "Authenticated insert own audit_logs"
ON public.audit_logs
FOR INSERT
TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND (
    tenant_id IS NULL
    OR tenant_id = public.get_user_tenant_id(auth.uid())
    OR public.has_role(auth.uid(), 'admin')
  )
);

-- ============ Storage: tenant-media tenant-scoped writes ============
DROP POLICY IF EXISTS "Authenticated users can delete tenant media" ON storage.objects;
DROP POLICY IF EXISTS "Authenticated users can upload tenant media" ON storage.objects;

CREATE POLICY "Tenant media upload scoped"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'tenant-media'
  AND (
    public.has_role(auth.uid(), 'admin')
    OR (storage.foldername(name))[1] = public.get_user_tenant_id(auth.uid())::text
  )
);

CREATE POLICY "Tenant media update scoped"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'tenant-media'
  AND (
    public.has_role(auth.uid(), 'admin')
    OR (storage.foldername(name))[1] = public.get_user_tenant_id(auth.uid())::text
  )
);

CREATE POLICY "Tenant media delete scoped"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'tenant-media'
  AND (
    public.has_role(auth.uid(), 'admin')
    OR (storage.foldername(name))[1] = public.get_user_tenant_id(auth.uid())::text
  )
);

-- ============ Restrict SECURITY DEFINER helper functions from anon ============
REVOKE EXECUTE ON FUNCTION public.has_role(uuid, app_role) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.get_user_tenant_id(uuid) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.can_edit_module(uuid, uuid, text) FROM anon, public;
REVOKE EXECUTE ON FUNCTION public.module_visibility(uuid, uuid, text) FROM anon, public;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_tenant_id(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_edit_module(uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.module_visibility(uuid, uuid, text) TO authenticated;
