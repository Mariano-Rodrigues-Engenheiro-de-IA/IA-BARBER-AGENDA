-- Suporte a mensagens divididas em vários blocos (WhatsApp separados).
-- is_continuation=true marca um bloco que faz parte da MESMA "cobrança
-- lógica" que o bloco anterior — usado pra não contar em dobro no
-- limite máximo de cobranças por dívida (max_overdue_messages) nem na
-- checagem de "já mandei essa hoje" (due_today, owner_alert): só o
-- PRIMEIRO bloco de cada grupo conta pra essas checagens.

ALTER TABLE public.celcash_billing_queue
  ADD COLUMN is_continuation boolean NOT NULL DEFAULT false;

ALTER TABLE public.celcash_billing_sent_log
  ADD COLUMN is_continuation boolean NOT NULL DEFAULT false;
