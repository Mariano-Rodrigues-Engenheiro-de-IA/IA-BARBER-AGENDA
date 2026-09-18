CREATE TABLE public.celcash_billing_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  celcash_customer_id text NOT NULL,
  phone_e164 text NOT NULL,
  name text,
  message_type text NOT NULL CHECK (message_type IN ('due_today', 'overdue')),
  message_text text NOT NULL,
  overdue_amount_cents_at_send integer,
  next_due_date_at_send date,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'error')),
  sent_at timestamptz,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX celcash_billing_queue_pending_idx
  ON public.celcash_billing_queue (scheduled_at)
  WHERE status = 'pending';
CREATE INDEX celcash_billing_queue_tenant_idx
  ON public.celcash_billing_queue (tenant_id, created_at DESC);

GRANT SELECT ON public.celcash_billing_queue TO authenticated;
GRANT ALL ON public.celcash_billing_queue TO service_role;

ALTER TABLE public.celcash_billing_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage all celcash_billing_queue"
  ON public.celcash_billing_queue FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Tenant users view their celcash_billing_queue"
  ON public.celcash_billing_queue FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));