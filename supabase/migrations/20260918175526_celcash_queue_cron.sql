-- Roda a fila de disparo (process-celcash-billing-queue) a cada 1
-- minuto — é essa chamada que efetivamente manda as mensagens já
-- enfileiradas por evaluate-celcash-billing, respeitando o horário
-- agendado de cada uma (espaçado 1-2 min entre si).
--
-- ⚠️ Mesmo padrão do commit acacf2f (sem Vault, Lovable confirmou que
-- está vazio): os 2 placeholders abaixo (<PROJECT_URL> e
-- <ANON_OU_PUBLISHABLE_KEY>) precisam ser preenchidos com os valores
-- reais antes de aplicar - mesmo formato já usado pelas outras rotinas
-- de cron deste projeto.

SELECT cron.schedule(
  'celcash-billing-queue-every-minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := '<PROJECT_URL>/functions/v1/process-celcash-billing-queue',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', '<ANON_OU_PUBLISHABLE_KEY>'
    ),
    body := '{}'::jsonb
  );
  $$
);
