
CREATE TABLE public.provider_prompts (
  provider TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.provider_prompts TO authenticated;
GRANT ALL ON public.provider_prompts TO service_role;
ALTER TABLE public.provider_prompts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can read provider prompts" ON public.provider_prompts
  FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can insert provider prompts" ON public.provider_prompts
  FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can update provider prompts" ON public.provider_prompts
  FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin')) WITH CHECK (public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admins can delete provider prompts" ON public.provider_prompts
  FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'));
CREATE TRIGGER update_provider_prompts_updated_at
  BEFORE UPDATE ON public.provider_prompts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
