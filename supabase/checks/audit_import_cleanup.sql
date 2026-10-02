-- Sola lettura. Conteggi/metadati aggregati; niente documenti, ID personali,
-- email, token, segreti, testo SQL di cron o corpi delle funzioni in output.
with routines as (
  select n.nspname as schema, p.proname as name, pg_get_functiondef(p.oid) as definition
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'peppitness_private') and p.prokind = 'f'
), import_tables as (
  select c.oid, n.nspname as schema, c.relname as name,
    c.relrowsecurity as rls, c.relforcerowsecurity as forced_rls,
    pg_total_relation_size(c.oid) as bytes
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'peppitness_private')
    and c.relkind = 'r' and c.relname like 'import_%'
)
select jsonb_build_object(
  'checked_at', clock_timestamp(),
  'table_counts', jsonb_build_object(
    'import_jobs', (select count(*) from public.import_jobs),
    'import_drafts', (select count(*) from public.import_drafts),
    'import_receipts', (select count(*) from public.import_receipts),
    'import_usage_ledger', (select count(*) from peppitness_private.import_usage_ledger),
    'import_budget_config', (select count(*) from peppitness_private.import_budget_config),
    'import_budget_retired', (select count(*) from peppitness_private.import_budget_retired),
    'import_retention_runs', (select count(*) from peppitness_private.import_retention_runs)
  ),
  'jobs', (select jsonb_agg(t) from (
    select kind, status, count(*) as count, min(created_at) as oldest_created,
      min(expires_at) as first_expiry, max(expires_at) as last_expiry
    from public.import_jobs group by kind, status order by kind, status
  ) t),
  'drafts', (select jsonb_agg(t) from (
    select j.status as job_status, count(*) as count,
      count(*) filter (where d.extraction is not null) as with_extraction,
      sum(pg_column_size(d.normalized_document)) as normalized_stored_bytes,
      coalesce(sum(pg_column_size(d.extraction)), 0) as extraction_stored_bytes,
      min(d.expires_at) as first_expiry, max(d.expires_at) as last_expiry
    from public.import_drafts d join public.import_jobs j on j.id = d.job_id and j.owner_id = d.owner_id
    group by j.status order by j.status
  ) t),
  'integrity', jsonb_build_object(
    'orphan_drafts', (select count(*) from public.import_drafts d where not exists (
      select 1 from public.import_jobs j where j.id = d.job_id and j.owner_id = d.owner_id)),
    'orphan_ledger', (select count(*) from peppitness_private.import_usage_ledger l where not exists (
      select 1 from public.import_jobs j where j.id = l.job_id and j.owner_id = l.owner_id)),
    'expired_jobs_with_content', (select count(*) from public.import_jobs j join public.import_drafts d
      on d.job_id = j.id and d.owner_id = j.owner_id where j.status = 'expired'),
    'expired_drafts_waiting', (select count(*) from public.import_drafts where expires_at <= clock_timestamp()),
    'ready_without_extraction', (select count(*) from public.import_jobs j left join public.import_drafts d
      on d.job_id = j.id and d.owner_id = j.owner_id where j.status = 'ready' and d.extraction is null),
    'running_jobs', (select count(*) from public.import_jobs where status = 'running'),
    'committed_receipts_without_plan', (select count(*) from public.import_receipts r where result_state = 'committed'
      and not (case when kind = 'workout' then exists (select 1 from public.workout_plans p where p.id = r.plan_id and p.owner_id = r.owner_id)
        else exists (select 1 from public.meal_plans p where p.id = r.plan_id and p.owner_id = r.owner_id) end)),
    'receipts_with_missing_analysis_job', (select count(*) from public.import_receipts r
      where r.provenance->'analysis'->>'jobId' is not null and not exists (
        select 1 from public.import_jobs j where j.id::text = r.provenance->'analysis'->>'jobId' and j.owner_id = r.owner_id))
  ),
  'retention', (select jsonb_set(result, '{scheduled}', (result->'scheduled') - array['command', 'username', 'database', 'jobId'])
    from (select peppitness_private.import_retention_status() as result) t),
  'retention_history', (select jsonb_agg(t) from (
    select status, count(*) as count, max(finished_at) as last_finished, sum(expired_jobs) as expired_jobs
    from peppitness_private.import_retention_runs group by status
  ) t),
  'ledger', (select jsonb_agg(t) from (
    select state, budget_month, currency, count(*) as count,
      sum(reserved_micros) as reserved_micros, sum(actual_micros) as actual_micros,
      min(created_at) as oldest_created, max(reconciled_at) as last_reconciled
    from peppitness_private.import_usage_ledger group by state, budget_month, currency order by budget_month, state
  ) t),
  'retired_usage', (select jsonb_agg(t) from (
    select budget_month, known_micros, uncertain_micros from peppitness_private.import_budget_retired
  ) t),
  'receipts', (select jsonb_agg(t) from (
    select kind, result_state, count(*) as count,
      count(*) filter (where provenance->'analysis'->>'jobId' is not null) as with_analysis_job,
      count(*) filter (where result_state = 'committed' and provenance->'analysis'->>'jobId' is null) as without_analysis_job
    from public.import_receipts group by kind, result_state order by kind, result_state
  ) t),
  'tables', (select jsonb_agg(t) from (select schema, name, bytes, rls, forced_rls from import_tables order by schema, name) t),
  'relation_bytes', (select sum(bytes) from import_tables),
  'foreign_keys', (select jsonb_agg(t) from (
    select con.conrelid::regclass::text as from_table, con.confrelid::regclass::text as to_table,
      con.conname as name, con.convalidated as validated
    from pg_constraint con where con.contype = 'f'
      and (con.conrelid in (select oid from import_tables) or con.confrelid in (select oid from import_tables))
    order by from_table, name
  ) t),
  'routine_dependencies', (select jsonb_agg(t) from (
    select schema, name,
      definition like '%import_jobs%' as jobs,
      definition like '%import_drafts%' as drafts,
      definition like '%import_usage_ledger%' as ledger,
      definition like '%import_budget_config%' as budget
    from routines where definition ~ 'import_jobs|import_drafts|import_usage_ledger|import_budget_config'
    order by schema, name
  ) t),
  'storage', jsonb_build_object('buckets', (select count(*) from storage.buckets), 'objects', (select count(*) from storage.objects))
) as cleanup_audit;
