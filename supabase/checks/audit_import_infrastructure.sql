-- Sola lettura: metadati/conteggi, nessuna fonte, email, credenziale o ID utente.
select jsonb_build_object(
  'jobs', (select jsonb_agg(t) from (select status, count(*) as count from public.import_jobs group by status order by status) t),
  'runningJobs', (select count(*) from public.import_jobs where status = 'running'),
  'ledger', (select jsonb_agg(t) from (select state, count(*) as count, sum(reserved_micros) as reserved_micros, sum(actual_micros) as actual_micros from peppitness_private.import_usage_ledger group by state order by state) t),
  'budget', (select jsonb_build_object('enabled', enabled, 'model', model, 'project_limit_micros', project_limit_micros, 'account_limit_micros', account_limit_micros) from peppitness_private.import_budget_config),
  'cron', (select jsonb_agg(t) from (select jobname, active from cron.job where jobname like 'peppitness%') t),
  'sizes', (select jsonb_agg(t) from (select relname, pg_total_relation_size(relid) as bytes from pg_stat_user_tables where relname like 'import_%') t),
  'rls', (select jsonb_agg(t) from (select schemaname, tablename, rowsecurity from pg_tables where schemaname in ('public', 'peppitness_private') order by 1, 2) t)
) as audit;
