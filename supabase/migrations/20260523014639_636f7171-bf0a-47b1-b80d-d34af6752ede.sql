-- Allow tenant users to delete their own chat messages
CREATE POLICY "Clients delete own chat_messages"
ON public.chat_messages
FOR DELETE
TO authenticated
USING (tenant_id = get_user_tenant_id(auth.uid()));

CREATE POLICY "Admins delete chat_messages"
ON public.chat_messages
FOR DELETE
TO authenticated
USING (has_role(auth.uid(), 'admin'::app_role));

-- Also allow deleting conversation_state so the AI session resets
CREATE POLICY "Clients delete own conversation_state"
ON public.conversation_state
FOR DELETE
TO authenticated
USING (tenant_id = get_user_tenant_id(auth.uid()));