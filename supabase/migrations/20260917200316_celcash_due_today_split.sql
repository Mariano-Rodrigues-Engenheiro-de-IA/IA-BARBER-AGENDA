-- Separa a cobrança automática em 2 disparos distintos:
--   1. Lembrete de vencimento no dia (mensagem própria, tom mais leve)
--   2. Cobrança de atrasados (mensagem já existente), agora com um teto
--      configurável de dias em atraso, e excluindo quem vence hoje (esses
--      recebem só o lembrete, não os dois no mesmo dia).

ALTER TABLE public.celcash_billing_config
  ADD COLUMN due_today_active boolean NOT NULL DEFAULT false,
  ADD COLUMN due_today_message_template text NOT NULL DEFAULT 'Oi {nome}! Passando pra lembrar que sua assinatura vence hoje. Qualquer coisa, estamos por aqui 😊',
  ADD COLUMN overdue_max_days integer; -- NULL = sem teto (comportamento atual)

-- Para o log de disparo saber diferenciar os 2 tipos de mensagem, e não
-- misturar o controle de repetição de um com o do outro.
ALTER TABLE public.celcash_billing_sent_log
  ADD COLUMN message_type text NOT NULL DEFAULT 'overdue'
    CHECK (message_type IN ('due_today', 'overdue'));
