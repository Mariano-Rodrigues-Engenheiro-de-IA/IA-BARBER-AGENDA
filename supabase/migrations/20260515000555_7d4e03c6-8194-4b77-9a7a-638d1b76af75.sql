
-- Sequences (templates reutilizáveis)
CREATE TABLE public.follow_up_sequences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  name text NOT NULL,
  trigger_type text NOT NULL DEFAULT 'first_contact_traffic',
  trigger_config jsonb NOT NULL DEFAULT '{"keywords":[],"match_mode":"any","catch_all":false}'::jsonb,
  business_hours jsonb NOT NULL DEFAULT '{"enabled":false,"start":"08:00","end":"21:00","timezone":"America/Sao_Paulo"}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_fus_tenant ON public.follow_up_sequences(tenant_id);
ALTER TABLE public.follow_up_sequences ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage sequences" ON public.follow_up_sequences FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));
CREATE POLICY "Service can read sequences" ON public.follow_up_sequences FOR SELECT TO public USING (true);
CREATE TRIGGER trg_fus_updated BEFORE UPDATE ON public.follow_up_sequences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Steps
CREATE TABLE public.follow_up_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id uuid NOT NULL REFERENCES public.follow_up_sequences(id) ON DELETE CASCADE,
  step_order integer NOT NULL,
  delay_minutes integer NOT NULL DEFAULT 30,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, step_order)
);
CREATE INDEX idx_fust_seq ON public.follow_up_steps(sequence_id);
ALTER TABLE public.follow_up_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage steps" ON public.follow_up_steps FOR ALL TO authenticated
  USING (has_role(auth.uid(),'admin')) WITH CHECK (has_role(auth.uid(),'admin'));
CREATE POLICY "Service can read steps" ON public.follow_up_steps FOR SELECT TO public USING (true);

-- Estender follow_ups
ALTER TABLE public.follow_ups
  ADD COLUMN sequence_id uuid,
  ADD COLUMN step_order integer,
  ADD COLUMN matched_keyword text,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN cancel_reason text;
CREATE INDEX idx_fu_seq ON public.follow_ups(sequence_id);
CREATE INDEX idx_fu_tenant_phone ON public.follow_ups(tenant_id, phone_number);
