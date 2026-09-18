-- Mesma troca de horário do commit b13501a (sincroniza 8h50, dispara
-- 9h00, Brasília), mas sem depender do Vault do projeto — Lovable
-- confirmou que o Vault está vazio e que as rotinas já existentes usam
-- endereço/credencial embutidos diretamente, sem ler do Vault.
--
-- ⚠️ AÇÃO NECESSÁRIA ANTES DE APLICAR: os 2 placeholders abaixo
-- (<PROJECT_URL> e <SERVICE_ROLE_KEY> / <ANON_OU_PUBLISHABLE_KEY>)
-- precisam ser substituídos pelos valores reais — eu (Carol) não tenho
-- acesso a essas credenciais, só a Lovable/o painel do Supabase têm.

SELECT cron.schedule(
  'celcash-sync-daily',
  '50 11 * * *',
  $$
  SELECT net.http_post(
    url := '<PROJECT_URL>/functions/v1/sync-celcash-overdue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer <SERVICE_ROLE_KEY>'
    ),
    body := jsonb_build_object('all', true)
  );
  $$
);

SELECT cron.schedule(
  'celcash-billing-dispatch-daily',
  '0 12 * * *',
  $$
  SELECT net.http_post(
    url := '<PROJECT_URL>/functions/v1/evaluate-celcash-billing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<ANON_OU_PUBLISHABLE_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);
