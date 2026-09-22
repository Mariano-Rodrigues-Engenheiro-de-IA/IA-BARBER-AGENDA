-- Instância dedicada pra mandar os avisos de conexão — campos
-- próprios, preenchidos pelo usuário no painel, em vez de depender da
-- variável de ambiente UAZAPI_URL/UAZAPI_TOKEN (que é um fallback
-- genérico compartilhado com outros propósitos no sistema, sem
-- garantia de qual número real está por trás).
ALTER TABLE public.platform_connection_alert_config
  ADD COLUMN instance_url text,
  ADD COLUMN instance_token text;
