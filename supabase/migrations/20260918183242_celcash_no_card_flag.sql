-- Marca quem está na lista de inadimplentes mas nunca cadastrou um
-- cartão de pagamento (a cobrança nunca chegou a ser tentada de
-- verdade). Confirmado com dado real: 9 casos onde a transação
-- pendente tinha "PaymentMethodCreditCard" sem nenhum cartão dentro, e
-- "datetimeLastSentToOperator: null" (nunca foi enviada pra
-- processar). Decisão do usuário: manter na lista (é uma pendência
-- real também), só diferenciar visualmente.

ALTER TABLE public.celcash_overdue_subscribers
  ADD COLUMN no_card_on_file boolean NOT NULL DEFAULT false;
