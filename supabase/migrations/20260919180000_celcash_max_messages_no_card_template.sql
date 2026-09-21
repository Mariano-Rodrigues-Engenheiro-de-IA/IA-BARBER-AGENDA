-- Limite máximo de cobranças (mensagens de "atrasado") por dívida
-- específica, e mensagem própria para quem não tem cartão cadastrado.

ALTER TABLE public.celcash_billing_config
  ADD COLUMN max_overdue_messages integer NOT NULL DEFAULT 5,
  ADD COLUMN no_card_message_template text NOT NULL
    DEFAULT 'Oi {nome}! Vimos que sua assinatura está em atraso e não identificamos um cartão cadastrado. Pode atualizar seu cartão pra regularizar? Qualquer dúvida, estamos por aqui 😊';
