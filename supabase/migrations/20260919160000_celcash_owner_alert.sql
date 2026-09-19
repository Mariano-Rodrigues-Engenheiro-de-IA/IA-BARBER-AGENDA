-- Aviso automático pro dono da barbearia quando um assinante bate um
-- número configurável de dias em atraso (padrão: 60). Diferente das
-- cobranças (due_today/overdue), que vão para o CLIENTE inadimplente,
-- este aviso vai para o NÚMERO PESSOAL do dono — por isso um telefone
-- de destino próprio (owner_alert_phone_e164), separado do
-- tenants.whatsapp_number (que é o número de atendimento da IA).

ALTER TABLE public.celcash_billing_config
  ADD COLUMN owner_alert_active boolean NOT NULL DEFAULT false,
  ADD COLUMN owner_alert_days integer NOT NULL DEFAULT 60,
  ADD COLUMN owner_alert_phone_e164 text,
  ADD COLUMN owner_alert_message_template text NOT NULL
    DEFAULT 'Atenção: o cliente {nome} está com {dias_atraso} dias de atraso na assinatura (valor: {valor}). Pode ser interessante entrar em contato diretamente.';

-- Reaproveita o mesmo log de controle de "já mandei antes" que due_today
-- e overdue já usam, como um terceiro tipo de mensagem.
-- Busca o nome da constraint dinamicamente em vez de assumir o padrão
-- gerado pelo Postgres (mais seguro contra qualquer nome customizado).
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'celcash_billing_sent_log'
    AND con.contype = 'c'
    AND pg_get_constraintdef(con.oid) ILIKE '%message_type%';

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.celcash_billing_sent_log DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE public.celcash_billing_sent_log
  ADD CONSTRAINT celcash_billing_sent_log_message_type_check
    CHECK (message_type IN ('due_today', 'overdue', 'owner_alert'));

-- Ativa e configura para o Dom Castro Barbearia (Fábio).
UPDATE public.celcash_billing_config
SET owner_alert_active = true,
    owner_alert_phone_e164 = '5521982762587'
WHERE tenant_id = 'fdbc80c3-1b7e-4fc4-93d9-5bd13301077d';
