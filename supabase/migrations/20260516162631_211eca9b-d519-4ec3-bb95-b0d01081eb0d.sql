CREATE TABLE public.onebeleza_client_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  real_phone text NOT NULL,
  alias_phone text NOT NULL,
  real_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, real_phone),
  UNIQUE (tenant_id, alias_phone)
);

CREATE INDEX idx_onebeleza_aliases_tenant_real ON public.onebeleza_client_aliases (tenant_id, real_phone);
CREATE INDEX idx_onebeleza_aliases_tenant_alias ON public.onebeleza_client_aliases (tenant_id, alias_phone);

ALTER TABLE public.onebeleza_client_aliases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage onebeleza_aliases"
  ON public.onebeleza_client_aliases
  FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (has_role(auth.uid(), 'admin'::app_role));

CREATE POLICY "Clients view own onebeleza_aliases"
  ON public.onebeleza_client_aliases
  FOR SELECT TO authenticated
  USING (tenant_id = get_user_tenant_id(auth.uid()));

CREATE POLICY "Service can insert onebeleza_aliases"
  ON public.onebeleza_client_aliases
  FOR INSERT TO public
  WITH CHECK (true);

CREATE POLICY "Service can select onebeleza_aliases"
  ON public.onebeleza_client_aliases
  FOR SELECT TO public
  USING (true);

CREATE POLICY "Service can update onebeleza_aliases"
  ON public.onebeleza_client_aliases
  FOR UPDATE TO public
  USING (true);

CREATE TRIGGER trg_onebeleza_aliases_updated_at
  BEFORE UPDATE ON public.onebeleza_client_aliases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();