-- Suporte a múltiplos funis por tenant, e separação clara entre:
-- - token de acesso ao CRM (só admin configura, campo continua em
--   tenants.crm_zetta_token)
-- - funis configurados (o próprio cliente escolhe quantos quiser, cada um
--   vira uma linha aqui)

CREATE TABLE IF NOT EXISTS public.tenant_crm_funnels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  funnel_id text NOT NULL,
  funnel_name text NOT NULL,
  stages jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, funnel_id)
);

CREATE INDEX IF NOT EXISTS tenant_crm_funnels_tenant_idx ON public.tenant_crm_funnels (tenant_id);

ALTER TABLE public.tenant_crm_funnels ENABLE ROW LEVEL SECURITY;

-- Admin tem acesso total.
CREATE POLICY "Admins manage tenant_crm_funnels"
  ON public.tenant_crm_funnels FOR ALL
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Cliente (dono do tenant) gerencia os funis do próprio estabelecimento —
-- ele escolhe quantos quiser, sem acesso ao token em si (que fica só em
-- tenants.crm_zetta_token, protegido pelo trigger de campos sensíveis já
-- existente).
CREATE POLICY "Clients manage own tenant_crm_funnels"
  ON public.tenant_crm_funnels FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.tenant_users
      WHERE tenant_users.tenant_id = tenant_crm_funnels.tenant_id
        AND tenant_users.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.tenant_users
      WHERE tenant_users.tenant_id = tenant_crm_funnels.tenant_id
        AND tenant_users.user_id = auth.uid()
    )
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_crm_funnels TO authenticated;
GRANT ALL ON public.tenant_crm_funnels TO service_role;

COMMENT ON TABLE public.tenant_crm_funnels IS
  'Funis do CRM externo que o cliente escolheu monitorar — pode ter vários. O token de acesso continua só em tenants.crm_zetta_token, configurado apenas pelo admin.';
