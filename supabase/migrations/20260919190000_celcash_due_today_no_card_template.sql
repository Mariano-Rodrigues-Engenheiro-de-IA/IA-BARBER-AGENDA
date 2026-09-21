-- Mensagem própria para "vence hoje" quando o cliente não tem cartão
-- cadastrado — mesmo esquema já existente para a cobrança de atraso
-- (message_template / no_card_message_template).

ALTER TABLE public.celcash_billing_config
  ADD COLUMN due_today_no_card_message_template text NOT NULL
    DEFAULT 'Oi {nome}! Passando pra lembrar que sua assinatura vence hoje e não identificamos um cartão cadastrado. Pode atualizar seu cartão? Qualquer dúvida, estamos por aqui 😊';
