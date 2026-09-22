-- lovable-cron-fallback-reviewed: usuario exige aviso de conexao/desconexao em poucos minutos; UAZAPI nao oferece webhook de status confiavel, entao polling de 5 minutos e necessario (288 execucoes/dia informadas ao usuario)
SELECT cron.schedule(
  'monitor-whatsapp-connection-5min',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://bazfkghkipqamnksbrdz.supabase.co/functions/v1/monitor-whatsapp-connection',
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', public.get_internal_cron_token()),
    body := '{}'::jsonb
  );
  $$
);