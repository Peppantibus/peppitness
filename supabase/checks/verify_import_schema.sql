-- Sola lettura dei metadati; non sostituisce pgTAP o le sessioni HTTP A/B.
with server_functions(signature) as (values
 ('public.create_import_job(uuid,uuid,text,text,text,jsonb,jsonb)'),
 ('public.find_import_job(uuid,uuid)'),
 ('public.complete_import_job(uuid,uuid,integer,uuid,integer,jsonb)'),
 ('public.fail_import_job(uuid,uuid,integer,uuid,text)'),
 ('public.touch_import_job(uuid,uuid,integer)'),
 ('public.expire_import_job(uuid,uuid,integer)')
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
 (select count(*)=6 and bool_and(f.oid is not null and p.prosecdef
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
   and not has_function_privilege('authenticated','peppitness_private.record_import_attempt(uuid,uuid,integer,uuid)','execute') as attempt_helper_private;
