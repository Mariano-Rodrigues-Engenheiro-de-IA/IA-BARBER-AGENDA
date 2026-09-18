-- lovable-cron-fallback-reviewed: 1440 runs/day; fila precisa enviar cada mensagem no minuto agendado (espaçamento 1-2 min exigido pelo usuário para evitar bloqueio no WhatsApp); usuário informado do custo.
SELECT cron.unschedule('celcash-billing-queue-every-minute')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'celcash-billing-queue-every-minute');

SELECT cron.schedule(
  'celcash-billing-queue-every-minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bazfkghkipqamnksbrdz.supabase.co/functions/v1/process-celcash-billing-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', public.get_internal_cron_token()
    ),
    body := '{}'::jsonb
  );
  $$
);