-- Ritmo configurável entre cada mensagem enfileirada — antes era fixo
-- (60-120s), agora ajustável no painel. Padrão mantém o comportamento
-- atual (60-120s) pra não mudar nada em quem já está usando.

ALTER TABLE public.celcash_billing_config
  ADD COLUMN pace_seconds_min integer NOT NULL DEFAULT 60,
  ADD COLUMN pace_seconds_max integer NOT NULL DEFAULT 120;
