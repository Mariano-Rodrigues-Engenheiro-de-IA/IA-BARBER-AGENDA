
CREATE TABLE public.ai_prompt_versions (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL,
  version integer NOT NULL,
  prompt text NOT NULL,
  created_by uuid,
  created_by_role text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, version)
);

ALTER TABLE public.ai_prompt_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage ai_prompt_versions" ON public.ai_prompt_versions
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Clients view own ai_prompt_versions" ON public.ai_prompt_versions
  FOR SELECT TO authenticated
  USING (tenant_id = get_user_tenant_id(auth.uid()));

CREATE POLICY "Clients insert own ai_prompt_versions" ON public.ai_prompt_versions
  FOR INSERT TO authenticated
  WITH CHECK (tenant_id = get_user_tenant_id(auth.uid()) AND can_edit_module(auth.uid(), tenant_id, 'ai_prompt'));

CREATE INDEX idx_ai_prompt_versions_tenant ON public.ai_prompt_versions(tenant_id, version DESC);
