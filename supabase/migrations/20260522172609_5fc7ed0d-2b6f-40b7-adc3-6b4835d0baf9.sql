CREATE POLICY "Clients update own ai_prompt_versions summary"
ON public.ai_prompt_versions
FOR UPDATE
TO authenticated
USING (tenant_id = get_user_tenant_id(auth.uid()) AND can_edit_module(auth.uid(), tenant_id, 'ai_prompt'))
WITH CHECK (tenant_id = get_user_tenant_id(auth.uid()) AND can_edit_module(auth.uid(), tenant_id, 'ai_prompt'));