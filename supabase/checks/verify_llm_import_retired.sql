-- Sola lettura. Budget disabilitato, zero bozze/job attivi. I conteggi conservati si confrontano col preflight.
select jsonb_build_object(
  'budget_disabled', (select count(*) = 1 and not bool_or(enabled) from peppitness_private.import_budget_config),
  'drafts_left', (select count(*) from public.import_drafts),
  'jobs_not_expired', (select count(*) from public.import_jobs where status <> 'expired'),
  'receipts_kept', (select count(*) from public.import_receipts),
  'ledger_rows_kept', (select count(*) from peppitness_private.import_usage_ledger)
) as llm_import_retired;
