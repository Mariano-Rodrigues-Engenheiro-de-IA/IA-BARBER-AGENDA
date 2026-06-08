
CREATE TABLE IF NOT EXISTS public.celcash_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  phone_number text NOT NULL,
  payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, phone_number)
);

CREATE INDEX IF NOT EXISTS celcash_cache_expires_idx ON public.celcash_cache(expires_at);
CREATE INDEX IF NOT EXISTS celcash_cache_tenant_phone_idx ON public.celcash_cache(tenant_id, phone_number);

GRANT SELECT ON public.celcash_cache TO authenticated;
GRANT ALL ON public.celcash_cache TO service_role;

ALTER TABLE public.celcash_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can view all celcash_cache"
  ON public.celcash_cache FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Tenant users can view their cache"
  ON public.celcash_cache FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

CREATE TRIGGER update_celcash_cache_updated_at
  BEFORE UPDATE ON public.celcash_cache
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
