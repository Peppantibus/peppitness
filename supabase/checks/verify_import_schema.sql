-- Sola lettura dei metadati; non sostituisce pgTAP o le sessioni HTTP A/B.
with server_functions(signature) as (values
 ('public.create_import_job(uuid,uuid,text,text,text,jsonb,jsonb)'),
 ('public.find_import_job(uuid,uuid)'),
 ('public.complete_import_job(uuid,uuid,integer,uuid,integer,jsonb)'),
 ('public.fail_import_job(uuid,uuid,integer,uuid,text)'),
 ('public.touch_import_job(uuid,uuid,integer)'),
 ('public.expire_import_job(uuid,uuid,integer)'),
 ('public.get_import_budget_config()'),
 ('public.get_import_reservation(uuid,uuid)'),
 ('public.reserve_import_budget(uuid,uuid,uuid,integer,text,integer,integer,boolean)'),
 ('public.dispatch_import_attempt(uuid,uuid)'),
 ('public.reconcile_import_usage(uuid,uuid,text,jsonb,integer)')
), functions as (
 select to_regprocedure(signature) as oid from server_functions
), tables as (
 select c.oid, c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in ('import_jobs','import_drafts')
)
select
 (select count(*)=2 and bool_and(relrowsecurity) from tables) as import_tables_rls_ok,
 not has_schema_privilege('authenticated','peppitness_private','usage')
   and not has_schema_privilege('anon','peppitness_private','usage')
   and not has_schema_privilege('service_role','peppitness_private','usage') as private_schema_closed,
 (select count(*)=11 and bool_and(f.oid is not null and p.prosecdef
   and 'search_path=""'=any(p.proconfig)
   and has_function_privilege('service_role',f.oid,'execute')
   and not has_function_privilege('anon',f.oid,'execute')
   and not has_function_privilege('authenticated',f.oid,'execute'))
   from functions f left join pg_proc p on p.oid=f.oid) as server_functions_ok,
 has_function_privilege('authenticated','public.get_import_job(uuid)','execute')
   and not has_function_privilege('anon','public.get_import_job(uuid)','execute')
   and not has_function_privilege('service_role','public.get_import_job(uuid)','execute') as read_rpc_grants_ok,
 not has_column_privilege('authenticated','public.import_jobs','lease_token','select') as lease_private,
 (select bool_and(not has_table_privilege(role, t.oid, 'insert,update,delete'))
   from tables t cross join unnest(array['anon','authenticated','service_role']) as role) as no_direct_writes,
 (select count(*)=2 from pg_trigger where tgname in ('import_jobs_result','import_drafts_result')
   and tgdeferrable and tginitdeferred and tgenabled='O') as atomic_result_constraints_ok,
 not has_function_privilege('service_role','peppitness_private.record_import_attempt(uuid,uuid,integer,uuid)','execute')
   and not has_function_privilege('authenticated','peppitness_private.record_import_attempt(uuid,uuid,integer,uuid)','execute') as attempt_helper_private,
 (select count(*)=3 and bool_and(c.relrowsecurity
   and not has_table_privilege('service_role',c.oid,'select,insert,update,delete')
   and not has_table_privilege('authenticated',c.oid,'select,insert,update,delete')
   and not has_table_privilege('anon',c.oid,'select,insert,update,delete'))
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='peppitness_private'
   and c.relname in ('import_budget_config','import_usage_ledger','import_budget_retired')) as budget_tables_private,
 coalesce((select not enabled or (project_limit_micros is not null and account_limit_micros is not null
   and input_micros_per_million is not null and output_micros_per_million is not null and provider is not null
   and model is not null and currency is not null and price_version is not null)
   from peppitness_private.import_budget_config where singleton),true) as budget_config_fail_closed,
 exists(select 1 from pg_constraint where conrelid='peppitness_private.import_usage_ledger'::regclass
   and contype='u' and pg_get_constraintdef(oid)='UNIQUE (owner_id, job_id, attempt)') as budget_attempt_unique,
 exists(select 1 from pg_trigger where tgrelid='peppitness_private.import_usage_ledger'::regclass
   and tgname='import_usage_retire' and tgenabled='O') as project_usage_survives_account_delete,
 -- Task 18: ricevute private in scrittura, helper condivisi non esposti, tombstone e cascata account.
 (select c.relrowsecurity and has_table_privilege('authenticated',c.oid,'select')
   and not has_table_privilege('authenticated',c.oid,'insert,update,delete')
   and not has_table_privilege('anon',c.oid,'select,insert,update,delete')
   and not has_table_privilege('service_role',c.oid,'select,insert,update,delete')
   from pg_class c where c.oid='public.import_receipts'::regclass) as receipts_read_only_own,
 has_function_privilege('authenticated','public.get_import_receipt(uuid)','execute')
   and not has_function_privilege('anon','public.get_import_receipt(uuid)','execute')
   and not has_function_privilege('service_role','public.get_import_receipt(uuid)','execute') as receipt_lookup_grants_ok,
 (select count(*)=8 and bool_and(p.proconfig @> array['search_path=""']
   and not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')
   and not has_function_privilege('service_role',p.oid,'execute'))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='peppitness_private'
   and p.proname in ('canonical_json','import_command_hash','import_content_hash','claim_import_receipt',
     'finalize_import_receipt','import_follow','lock_import_selection','apply_import_selection')) as receipt_helpers_private,
 exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='peppitness_private'
   and p.proname='canonical_json' and p.proconfig @> array['extra_float_digits=1']) as canonical_float_digits_fixed,
 (select count(*)=2 from pg_trigger where tgname='import_receipts_tombstone' and tgenabled='O'
   and tgrelid in ('public.workout_plans'::regclass,'public.meal_plans'::regclass)) as receipt_tombstones_ok,
 not exists(select 1 from pg_constraint where conrelid='public.import_receipts'::regclass and contype='f'
   and confrelid in ('public.workout_plans'::regclass,'public.meal_plans'::regclass))
   and exists(select 1 from pg_constraint where conrelid='public.import_receipts'::regclass and contype='f'
     and confrelid='auth.users'::regclass and confdeltype='c') as receipts_survive_plans_not_account,
 exists(select 1 from pg_trigger where tgname='import_receipts_committed_plan'
   and tgrelid='public.import_receipts'::regclass and tgdeferrable and tginitdeferred and tgenabled='O') as receipt_plan_constraint_ok,
 -- Task 19: RPC di conferma della scheda, solo authenticated, SECURITY DEFINER con search_path vuoto.
 coalesce((select p.prosecdef and p.proconfig @> array['search_path=""']
   and has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute')
   and not has_function_privilege('service_role',p.oid,'execute')
   from pg_proc p where p.oid=to_regprocedure('public.commit_workout_import(uuid,jsonb,jsonb,jsonb)')),false) as workout_commit_rpc_ok,
 (select count(*)=9 and bool_and(p.proconfig @> array['search_path=""']
   and not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')
   and not has_function_privilege('service_role',p.oid,'execute'))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='peppitness_private'
   and p.proname in ('import_require','import_keys','import_text','import_integer','import_decimal','import_exercise_values',
     'import_exercise_matches','import_check_provenance','import_workout_targets')) as workout_commit_helpers_private,
 -- Task 20: RPC di conferma della dieta e validatore privato; nessuna tabella nutrizionale nuova.
 coalesce((select p.prosecdef and p.proconfig @> array['search_path=""']
   and has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute')
   and not has_function_privilege('service_role',p.oid,'execute')
   from pg_proc p where p.oid=to_regprocedure('public.commit_diet_import(uuid,jsonb,jsonb,jsonb)')),false) as diet_commit_rpc_ok,
 coalesce((select p.proconfig @> array['search_path=""'] and not has_function_privilege('anon',p.oid,'execute')
   and not has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('service_role',p.oid,'execute')
   from pg_proc p where p.oid=to_regprocedure('peppitness_private.import_diet_targets(jsonb)')),false) as diet_commit_helper_private,
 exists(select 1 from pg_trigger where tgname='b_validate_meal_plan' and tgrelid='public.meal_plans'::regclass and tgenabled='O')
   and exists(select 1 from pg_constraint where conrelid='public.meal_plans'::regclass and contype='c'
     and pg_get_constraintdef(oid) like '%octet_length((document)::text) <= 262144%') as diet_document_schema_unchanged,
 -- Task 23: retention effettiva, job pianificato unico, manutenzione privata, scarto solo authenticated, ultimo esito.
 exists(select 1 from pg_extension where extname='pg_cron')
   and (select count(*)=1 and bool_and(active and schedule='17 * * * *' and command='select peppitness_private.run_import_retention(500)')
     from cron.job where jobname='peppitness-import-retention') as retention_job_scheduled,
 (select count(*)=4 and bool_and(p.proconfig @> array['search_path=""']
   and not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')
   and not has_function_privilege('service_role',p.oid,'execute'))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='peppitness_private'
   and p.proname in ('expire_import_content','run_import_retention','schedule_import_retention','import_retention_status')) as retention_functions_private,
 coalesce((select p.prosecdef and p.proconfig @> array['search_path=""']
   and has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute')
   and not has_function_privilege('service_role',p.oid,'execute')
   from pg_proc p where p.oid=to_regprocedure('public.discard_import_job(uuid)')),false) as discard_rpc_ok,
 coalesce((select p.prosecdef and p.proconfig @> array['search_path=""']
   and has_function_privilege('authenticated',p.oid,'execute') and not has_function_privilege('anon',p.oid,'execute')
   and not has_function_privilege('service_role',p.oid,'execute')
   from pg_proc p where p.oid=to_regprocedure('public.renew_import_job(uuid)')),false) as renew_rpc_ok,
 coalesce((select c.relrowsecurity and not has_table_privilege('anon',c.oid,'select,insert,update,delete')
   and not has_table_privilege('authenticated',c.oid,'select,insert,update,delete')
   and not has_table_privilege('service_role',c.oid,'select,insert,update,delete')
   from pg_class c where c.oid=to_regclass('peppitness_private.import_retention_runs')),false) as retention_runs_private,
 -- Ultimo esito registrato non fallito (vero anche prima della prima esecuzione) e ultimo run pg_cron non fallito.
 coalesce((select status<>'failed' from peppitness_private.import_retention_runs order by finished_at desc, id desc limit 1),true)
   and coalesce((select d.status<>'failed' from cron.job_run_details d join cron.job c on c.jobid=d.jobid
     where c.jobname='peppitness-import-retention' order by d.start_time desc limit 1),true) as retention_last_run_ok;
