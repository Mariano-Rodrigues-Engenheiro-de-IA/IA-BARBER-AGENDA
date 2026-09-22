-- Pausar/retomar o processamento da fila de cobrança sem perder o que
-- já está enfileirado — itens continuam "pending", só não são
-- processados enquanto pausado. Retomar continua de onde parou.
ALTER TABLE public.celcash_billing_config
  ADD COLUMN queue_paused boolean NOT NULL DEFAULT false;
