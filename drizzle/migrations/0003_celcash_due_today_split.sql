ALTER TABLE public.celcash_billing_config
  ADD COLUMN IF NOT EXISTS due_today_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS due_today_message_template text NOT NULL DEFAULT 'Oi {nome}! Passando pra lembrar que sua assinatura vence hoje. Qualquer coisa, estamos por aqui 😊',
  ADD COLUMN IF NOT EXISTS overdue_max_days integer;

ALTER TABLE public.celcash_billing_sent_log
  ADD COLUMN IF NOT EXISTS message_type text NOT NULL DEFAULT 'overdue';

CREATE INDEX IF NOT EXISTS celcash_billing_sent_log_type_idx
  ON public.celcash_billing_sent_log (tenant_id, celcash_customer_id, message_type, sent_at DESC);