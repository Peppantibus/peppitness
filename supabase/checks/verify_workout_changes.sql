-- Sola lettura di metadati, utilizzabile anche sul progetto collegato dopo il rilascio.
-- Non legge sessioni, risultati o altri dati personali.
with checks(name, ok) as (
  select 'changes_rls_forced', coalesce((select relrowsecurity and relforcerowsecurity
    from pg_class where oid = to_regclass('public.workout_changes')), false)
  union all select 'changes_read_only_for_client', coalesce((select
    has_column_privilege('authenticated',oid,'change_doc','SELECT')
    and not has_any_column_privilege('authenticated',oid,'INSERT,UPDATE')
    and not has_table_privilege('authenticated',oid,'DELETE')
    and not has_any_column_privilege('anon',oid,'SELECT,INSERT,UPDATE')
    and not has_table_privilege('anon',oid,'DELETE')
    from pg_class where oid = to_regclass('public.workout_changes')),false)
  union all select 'owner_and_mfa_policies', (select count(*) = 2 from pg_policy
    where polrelid = to_regclass('public.workout_changes') and polname in ('own_changes','mfa_aal2_required'))
  union all select 'private_permits_closed', coalesce((select
    not has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE')
    from pg_class where oid = to_regclass('peppitness_private.session_change_permits')),false)
  union all select 'snapshot_not_directly_writable', not has_column_privilege('authenticated','public.workout_sessions','day_snapshot','UPDATE')
  union all select 'result_identity_and_request_columns', (select count(*) = 2 from pg_attribute
    where attrelid = 'public.workout_set_logs'::regclass and attname in ('exercise_id','change_id') and not attisdropped and atttypid = 'uuid'::regtype)
  union all select 'result_context_trigger', exists (select 1 from pg_trigger where tgrelid = 'public.workout_set_logs'::regclass
    and tgname = 'a_lock_set_exercise' and tgenabled = 'O' and not tgisinternal)
  union all select 'dated_start_trigger', exists (select 1 from pg_trigger where tgrelid = 'public.workout_sessions'::regclass
    and tgname = 'zz_dated_changes' and tgenabled = 'O' and not tgisinternal)
  union all select 'exact_snapshot_permit_guard', coalesce((select position('session_change_permits' in prosrc)>0
    and position('before_snapshot = OLD.day_snapshot' in prosrc)>0 and position('after_snapshot = NEW.day_snapshot' in prosrc)>0
    from pg_proc where oid=to_regprocedure('peppitness_private.guard_workout_session()')),false)
  union all select 'rpc_mfa_ownership_and_privileges', (select count(*)=2 and bool_and(prosecdef
    and 'search_path=""'=any(proconfig) and position('require_mfa()' in prosrc)>0 and position('auth.uid()' in prosrc)>0
    and has_function_privilege('authenticated',oid,'EXECUTE') and not has_function_privilege('anon',oid,'EXECUTE'))
    from pg_proc where oid in (to_regprocedure('public.apply_workout_change(uuid,jsonb,integer)'),to_regprocedure('public.undo_workout_change(uuid,uuid)')))
  union all select 'private_helpers_not_executable', (select count(*)=6 and not bool_or(
    has_function_privilege('authenticated',oid,'EXECUTE') or has_function_privilege('anon',oid,'EXECUTE'))
    from pg_proc where oid in (to_regprocedure('peppitness_private.prescription_snapshot(uuid,uuid)'),
      to_regprocedure('peppitness_private.replace_session_exercise(uuid,jsonb)'),
      to_regprocedure('peppitness_private.check_change_slot(uuid,uuid,date,uuid,uuid,uuid)'),
      to_regprocedure('peppitness_private.valid_change_number(jsonb,numeric,numeric,boolean)'),
      to_regprocedure('peppitness_private.apply_dated_workout_changes()'),to_regprocedure('peppitness_private.lock_set_exercise()')))
  union all select 'migration_recorded', exists(select 1 from supabase_migrations.schema_migrations where version='20261028150000')
)
select name, coalesce(ok,false) as ok from checks order by name;
