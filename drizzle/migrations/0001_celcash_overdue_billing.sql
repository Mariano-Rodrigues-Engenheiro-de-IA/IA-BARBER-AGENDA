-- Cobrança automática de inadimplentes (CelCash).
--
-- Tabela separada de celcash_subscribers de propósito: aquela tabela é um
-- snapshot só de assinantes ATIVOS (+ trial), usado pela IA de atendimento
-- para decidir preço de clube ("achou = é assinante ativo"). Misturar
-- inadimplentes ali quebraria essa lógica em produção. Esta tabela é
-- alimentada por uma sincronização própria e separada.

CREATE TABLE public.celcash_overdue_subscribers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  celcash_customer_id text NOT NULL,
  celcash_subscription_id text,
  phone_e164 text,
  phone_raw text,
  name text,
  email text,
  plan_id text,
  plan_name text,
  overdue_amount_cents integer NOT NULL DEFAULT 0,
  next_due_date date,
  last_payment_date date,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  synced_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, celcash_customer_id)
);

CREATE INDEX celcash_overdue_subscribers_tenant_phone_idx
  ON public.celcash_overdue_subscribers (tenant_id, phone_e164);
CREATE INDEX celcash_overdue_subscribers_tenant_due_idx
  ON public.celcash_overdue_subscribers (tenant_id, next_due_date);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.celcash_overdue_subscribers TO authenticated;
GRANT ALL ON public.celcash_overdue_subscribers TO service_role;

ALTER TABLE public.celcash_overdue_subscribers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage all celcash_overdue_subscribers"
  ON public.celcash_overdue_subscribers FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Tenant users view their overdue subscribers"
  ON public.celcash_overdue_subscribers FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));

CREATE TRIGGER update_celcash_overdue_subscribers_updated_at
  BEFORE UPDATE ON public.celcash_overdue_subscribers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Configuração de cobrança automática, uma linha por tenant.
CREATE TABLE public.celcash_billing_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL UNIQUE REFERENCES public.tenants(id) ON DELETE CASCADE,
  active boolean NOT NULL DEFAULT false,
  message_template text NOT NULL DEFAULT 'Oi {nome}! Vimos que sua assinatura está em atraso. Pode regularizar quando puder? Qualquer dúvida, estamos por aqui 😊',
  days_after_due integer NOT NULL DEFAULT 1,
  repeat_every_days integer, -- NULL = manda só 1 vez por fatura vencida
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.celcash_billing_config TO authenticated;
GRANT ALL ON public.celcash_billing_config TO service_role;

ALTER TABLE public.celcash_billing_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage all celcash_billing_config"
  ON public.celcash_billing_config FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Tenant users manage their billing config"
  ON public.celcash_billing_config FOR ALL
  TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()))
  WITH CHECK (tenant_id = public.get_user_tenant_id(auth.uid()));

CREATE TRIGGER update_celcash_billing_config_updated_at
  BEFORE UPDATE ON public.celcash_billing_config
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Histórico de disparos de cobrança (evita repetir fora do período configurado).
CREATE TABLE public.celcash_billing_sent_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  celcash_customer_id text NOT NULL,
  phone_e164 text,
  sent_at timestamptz NOT NULL DEFAULT now(),
  overdue_amount_cents_at_send integer,
  next_due_date_at_send date,
  message_sent text
);

CREATE INDEX celcash_billing_sent_log_tenant_customer_idx
  ON public.celcash_billing_sent_log (tenant_id, celcash_customer_id, sent_at DESC);

GRANT SELECT, INSERT ON public.celcash_billing_sent_log TO authenticated;
GRANT ALL ON public.celcash_billing_sent_log TO service_role;

ALTER TABLE public.celcash_billing_sent_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins view all celcash_billing_sent_log"
  ON public.celcash_billing_sent_log FOR SELECT
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Tenant users view their billing sent log"
  ON public.celcash_billing_sent_log FOR SELECT
  TO authenticated
  USING (tenant_id = public.get_user_tenant_id(auth.uid()));