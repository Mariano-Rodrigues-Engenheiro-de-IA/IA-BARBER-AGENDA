-- Reagenda o disparo de cobrança para 9h da manhã (Brasília), em vez de
-- 17h (decisão revista pelo usuário). Sincronização continua 10 minutos
-- antes do disparo.
--
-- cron.schedule com o mesmo nome de job já existente substitui o
-- agendamento anterior (não cria um job duplicado).

-- 8h50 (Brasília) = 11h50 UTC — sincroniza.
SELECT cron.schedule(
  'celcash-sync-daily',
  '50 11 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/sync-celcash-overdue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key')
    ),
    body := jsonb_build_object('all', true)
  );
  $$
);

-- 9h00 (Brasília) = 12h00 UTC — dispara.
SELECT cron.schedule(
  'celcash-billing-dispatch-daily',
  '0 12 * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'project_url') || '/functions/v1/evaluate-celcash-billing',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'anon_key')
    ),
    body := '{}'::jsonb
  );
  $$
);
