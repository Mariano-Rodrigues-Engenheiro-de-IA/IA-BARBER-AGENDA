CREATE TABLE public.follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  link_sent_at timestamptz NOT NULL DEFAULT now(),
  follow_up_at timestamptz NOT NULL,
  sent_at timestamptz,
  confirmed_at timestamptz,
  follow_up_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.follow_ups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view follow_ups" ON public.follow_ups
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Service can insert follow_ups" ON public.follow_ups
  FOR INSERT TO public
  WITH CHECK (true);

CREATE POLICY "Service can update follow_ups" ON public.follow_ups
  FOR UPDATE TO public
  USING (true);

CREATE INDEX idx_follow_ups_pending ON public.follow_ups (status, follow_up_at)
  WHERE status = 'pending';