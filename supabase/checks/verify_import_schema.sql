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
   and tgname='import_usage_retire' and tgenabled='O') as project_usage_survives_account_delete;
