ALTER TABLE public.celcash_overdue_subscribers
  ADD COLUMN IF NOT EXISTS no_card_on_file boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.celcash_overdue_subscribers.no_card_on_file IS
  'true quando o cliente está em atraso mas não tem cartão cadastrado na CelCash (não pode receber cobrança automática de cartão)';

CREATE INDEX IF NOT EXISTS celcash_overdue_subscribers_tenant_card_idx
  ON public.celcash_overdue_subscribers (tenant_id, no_card_on_file);