
-- Drop old per-phone cache (will be replaced by full subscribers table)
DROP TABLE IF EXISTS public.celcash_cache CASCADE;

-- Subscribers table: full mirror of CelCash customers/subscriptions
CREATE TABLE public.celcash_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  celcash_customer_id text NOT NULL,
  celcash_subscription_id text,
  phone_e164 text,
  phone_raw text,
  name text,
  email text,
  document text,
  plan_id text,
  plan_name text,
  status text NOT NULL DEFAULT 'unknown',
  is_overdue boolean NOT NULL DEFAULT false,
  overdue_amount_cents integer NOT NULL DEFAULT 0,
  next_due_date date,
  last_payment_date date,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, celcash_customer_id)
);

CREATE INDEX celcash_subscribers_tenant_phone_idx
  ON public.celcash_subscribers (tenant_id, phone_e164);
CREATE INDEX celcash_subscribers_tenant_status_idx
  ON public.celcash_subscribers (tenant_id, status);
CREATE INDEX celcash_subscribers_tenant_overdue_idx
  ON public.celcash_subscribers (tenant_id, is_overdue);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.celcash_subscribers TO authenticated;
GRANT ALL ON public.celcash_subscribers TO service_role;

ALTER TABLE public.celcash_subscribers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage all celcash_subscribers"
  ON public.celcash_subscribers FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Tenant users view their subscribers"
  ON public.celcash_subscribers FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

CREATE TRIGGER update_celcash_subscribers_updated_at
  BEFORE UPDATE ON public.celcash_subscribers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Sync run log
CREATE TABLE public.celcash_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  total_fetched integer NOT NULL DEFAULT 0,
  total_upserted integer NOT NULL DEFAULT 0,
  total_marked_canceled integer NOT NULL DEFAULT 0,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX celcash_sync_runs_tenant_idx
  ON public.celcash_sync_runs (tenant_id, started_at DESC);

GRANT SELECT ON public.celcash_sync_runs TO authenticated;
GRANT ALL ON public.celcash_sync_runs TO service_role;

ALTER TABLE public.celcash_sync_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins view all sync runs"
  ON public.celcash_sync_runs FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Tenant users view their sync runs"
  ON public.celcash_sync_runs FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

CREATE TRIGGER update_celcash_sync_runs_updated_at
  BEFORE UPDATE ON public.celcash_sync_runs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Enable cron extensions for scheduled sync
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
