
CREATE TABLE public.conversation_pauses (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  paused BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_number)
);

CREATE INDEX idx_conversation_pauses_tenant_phone ON public.conversation_pauses(tenant_id, phone_number);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_pauses TO authenticated;
GRANT ALL ON public.conversation_pauses TO service_role;

ALTER TABLE public.conversation_pauses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage all conversation_pauses"
  ON public.conversation_pauses FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Clients view own conversation_pauses"
  ON public.conversation_pauses FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

CREATE POLICY "Clients insert own conversation_pauses"
  ON public.conversation_pauses FOR INSERT
  TO authenticated
  WITH CHECK (tenant_id = public.get_user_tenant_id(auth.uid()));

CREATE POLICY "Clients update own conversation_pauses"
  ON public.conversation_pauses FOR UPDATE
  TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()))
  WITH CHECK (tenant_id = public.get_user_tenant_id(auth.uid()));

CREATE POLICY "Clients delete own conversation_pauses"
  ON public.conversation_pauses FOR DELETE
  TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

CREATE TRIGGER update_conversation_pauses_updated_at
  BEFORE UPDATE ON public.conversation_pauses
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
