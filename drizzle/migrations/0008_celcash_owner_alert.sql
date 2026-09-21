ALTER TABLE public.celcash_billing_config
  ADD COLUMN IF NOT EXISTS owner_alert_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS owner_alert_days integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS owner_alert_phone_e164 text,
  ADD COLUMN IF NOT EXISTS owner_alert_message_template text NOT NULL
    DEFAULT 'Atenção: o cliente {nome} está com {dias_atraso} dias de atraso na assinatura (valor: {valor}). Pode ser interessante entrar em contato diretamente.';

DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'celcash_billing_sent_log'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%message_type%';

  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.celcash_billing_sent_log DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE public.celcash_billing_sent_log
  ADD CONSTRAINT celcash_billing_sent_log_message_type_check
    CHECK (message_type IN ('due_today', 'overdue', 'owner_alert'));

UPDATE public.celcash_billing_config
SET owner_alert_active = true,
    owner_alert_phone_e164 = '5521982762587'
WHERE tenant_id = 'fdbc80c3-1b7e-4fc4-93d9-5bd13301077d';