-- Agendamento automático diário: sincroniza a CelCash e, pouco depois,
-- dispara as mensagens de cobrança com base no que acabou de ser
-- sincronizado. Antes disso, tudo era manual (botões "Sincronizar agora"
-- / "Disparar agora" no painel) — o código já tinha o modo "cron" pronto
-- nas 2 Edge Functions, só faltava esse agendamento de verdade.
--
-- Horário fixo (decisão explícita do usuário: prioriza simplicidade e
-- menos chamadas — se precisar mudar depois, é só editar o cron
-- schedule abaixo e reaplicar). 17h de Brasília = 20h UTC (Brasília não
-- tem mais horário de verão desde 2019) — a ideia é dar tempo de quem
-- pagou durante o dia já estar refletido no sistema, e só cobrar quem
-- realmente ainda está pendente até essa hora.
--
-- 10 minutos de intervalo entre sincronizar e disparar: tempo de sobra
-- pra sincronização terminar (ela tem até ~3.7min por rodada) antes do
-- disparo ler os dados frescos.
--
-- ⚠️ DEPENDÊNCIA: isso só funciona se os secrets abaixo já estiverem
-- cadastrados no Vault do projeto (Project Settings > Vault, ou já
-- configurados automaticamente se o projeto usa "Connect" do Supabase):
--   - project_url             (ex: https://bazfkghkipqamnksbrdz.supabase.co)
--   - service_role_key        (usado pela sincronização)
--   - anon_key ou publishable_key (usado pelo disparo, no header apikey)
-- Se algum desses não existir, os cron jobs abaixo rodam mas as chamadas
-- HTTP falham silenciosamente (erro de autenticação) — checar em
-- cron.job_run_details se não vir nenhum resultado depois de configurar.

-- 17h00 (Brasília) — sincroniza todos os tenants com CelCash habilitado.
SELECT cron.schedule(
  'celcash-sync-daily',
  '0 20 * * *',
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

-- 17h10 (Brasília) — dispara as mensagens configuradas, com base no que
-- acabou de ser sincronizado 10 minutos antes.
SELECT cron.schedule(
  'celcash-billing-dispatch-daily',
  '10 20 * * *',
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
