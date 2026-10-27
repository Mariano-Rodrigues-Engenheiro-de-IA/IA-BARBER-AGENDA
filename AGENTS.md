# AGENTS.md

## Cron jobs (pg_cron)

- To pause or resume a scheduled job, use the scheduler's own function: `SELECT cron.alter_job(job_id := <id>, active := <bool>);`. A direct `UPDATE cron.job SET active = ...` is rejected with "permission denied for table job" from both the data-change connection and the migration connection. Why: the Cloud database roles have no write grant on pg_cron's internal table, only on its function.

## Trinks availability

- Keep pure slot calculations in the existing Trinks `slots.ts` module and provider orchestration in its `index.ts`; creation validates the full API grid without rescheduling-only additions, because a client's occupied window is free only when editing that booking.
