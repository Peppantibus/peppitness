-- Read-only metadata verification. No personal data or credentials.
select
 (select count(*)=2 and bool_and(c.relrowsecurity and c.relforcerowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname in ('morning_routines','morning_routine_days')) as forced_rls,
 (select count(*)=2 from pg_policies where schemaname='public' and tablename in ('morning_routines','morning_routine_days') and policyname='mfa_aal2_required' and permissive='RESTRICTIVE') as mfa_policies,
 (select bool_and(has_table_privilege('authenticated',c.oid,'SELECT') and not has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE'))
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('morning_routines','morning_routine_days')) as private_read_only_tables,
 (select count(*)=2 and bool_and(p.prosecdef and has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
   and pg_get_functiondef(p.oid) like '%perform peppitness_private.require_mfa();%') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('save_morning_routine','set_morning_routine_day')) as guarded_rpcs,
 (select count(*)=2 from information_schema.columns where table_schema='public' and table_name in ('morning_routines','morning_routine_days') and column_name='last_request_id' and is_nullable='NO') as idempotency_identity,
 (select count(*)=2 from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('morning_routines','morning_routine_days') and t.tgname='a_stamp_record' and not t.tgisinternal) as revision_triggers;
