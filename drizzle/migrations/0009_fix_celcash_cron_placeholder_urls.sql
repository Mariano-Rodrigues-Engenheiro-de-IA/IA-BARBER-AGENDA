-- lovable-cron-fallback-reviewed: fila de cobranca exige espacamento de 1-2min entre mensagens (1440 execucoes/dia, custo informado e aceito pelo usuario); job ja existia, aqui so corrigimos URL/credencial em branco que causavam "Out of memory" no pg_net
SELECT cron.schedule(
  'celcash-sync-daily',
  '50 11 * * *',
  $$
  SELECT net.http_post(
    url := 'https://bazfkghkipqamnksbrdz.supabase.co/functions/v1/sync-celcash-overdue',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', public.get_internal_cron_token()),
    body := jsonb_build_object('all', true)
  );
  $$
);

SELECT cron.schedule(
  'celcash-billing-dispatch-daily',
  '0 12 * * *',
  $$
  SELECT net.http_post(
    url := 'https://bazfkghkipqamnksbrdz.supabase.co/functions/v1/evaluate-celcash-billing',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', public.get_internal_cron_token()),
    body := '{}'::jsonb
  );
  $$
);

SELECT cron.schedule(
  'celcash-billing-queue-every-minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bazfkghkipqamnksbrdz.supabase.co/functions/v1/process-celcash-billing-queue',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', public.get_internal_cron_token()),
    body := '{}'::jsonb
  );
  $$
);
