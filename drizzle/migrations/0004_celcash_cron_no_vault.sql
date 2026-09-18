DO $mig$
DECLARE
  v_url text := 'https://bazfkghkipqamnksbrdz.supabase.co';
  v_token text := public.get_internal_cron_token();
  j record;
BEGIN
  FOR j IN
    SELECT jobname FROM cron.job
    WHERE jobname IN (
      'sync-celcash-overdue-daily',
      'evaluate-celcash-billing-daily',
      'celcash-sync-daily',
      'celcash-billing-dispatch-daily'
    )
  LOOP
    PERFORM cron.unschedule(j.jobname);
  END LOOP;

  PERFORM cron.schedule(
    'celcash-sync-daily',
    '50 11 * * *',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', %L
        ),
        body := '{"all": true}'::jsonb
      );
    $cmd$, v_url || '/functions/v1/sync-celcash-overdue', v_token)
  );

  PERFORM cron.schedule(
    'celcash-billing-dispatch-daily',
    '0 12 * * *',
    format($cmd$
      SELECT net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-cron-secret', %L
        ),
        body := '{}'::jsonb
      );
    $cmd$, v_url || '/functions/v1/evaluate-celcash-billing', v_token)
  );
END
$mig$;