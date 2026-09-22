-- Aviso ao DONO DA PLATAFORMA (Mariano) quando a conexao do WhatsApp de
-- QUALQUER cliente cai ou volta. Configuracao GLOBAL (linha unica),
-- diferente do resto do sistema que e por tenant - fica no painel admin
-- da plataforma (Configuracoes), nao no painel de cada cliente.
CREATE TABLE public.platform_connection_alert_config (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true), -- garante 1 linha so
  active boolean NOT NULL DEFAULT false,
  owner_phone_e164 text,
  -- {empresa} disponivel nas duas mensagens, com o nome do tenant que mudou.
  connected_message_template text NOT NULL
    DEFAULT '✅ {empresa} reconectou e está funcionando normalmente novamente.',
  disconnected_message_template text NOT NULL
    DEFAULT '⚠️ Atenção: {empresa} desconectou. A IA de atendimento não está recebendo mensagens novas até reconectar.',
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO public.platform_connection_alert_config (id) VALUES (true)
ON CONFLICT (id) DO NOTHING;

-- Ultimo status de conexao ja verificado de CADA tenant (nao muda com o
-- tenant editando nada - so o monitor grava aqui), pra so disparar
-- aviso quando REALMENTE mudar entre uma checagem e outra.
ALTER TABLE public.tenants ADD COLUMN last_known_connection_status text;
