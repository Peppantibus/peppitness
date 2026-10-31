-- Sola lettura di metadati: nessun accesso a sessioni o valori personali.
with checks(name, ok) as (
  select 'private_receipts_closed', coalesce((select
    not has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE')
    from pg_class where oid=to_regclass('peppitness_private.session_exercise_receipts')),false)
  union all select 'receipts_owner_session_fk', exists(select 1 from pg_constraint
    where conrelid=to_regclass('peppitness_private.session_exercise_receipts') and contype='f'
    and confrelid=to_regclass('public.workout_sessions') and array_length(conkey,1)=2 and confdeltype='c')
  union all select 'occurrences_unique', exists(select 1 from pg_constraint
    where conrelid=to_regclass('peppitness_private.session_exercise_receipts') and contype='u'
    and pg_get_constraintdef(oid)='UNIQUE (occurrence_id)')
  union all select 'rpc_owner_mfa_and_privileges', coalesce((select prosecdef and 'search_path=""'=any(proconfig)
    and position('require_mfa()' in prosrc)>0 and position('auth.uid()' in prosrc)>0
    and has_function_privilege('authenticated',oid,'EXECUTE') and not has_function_privilege('anon',oid,'EXECUTE')
    from pg_proc where oid=to_regprocedure('public.edit_workout_session_exercises(uuid,uuid,jsonb,jsonb,jsonb)')),false)
  union all select 'snapshot_guard_and_acl', not has_column_privilege('authenticated','public.workout_sessions','day_snapshot','UPDATE')
    and coalesce((select position('session_change_permits' in prosrc)>0 from pg_proc
      where oid=to_regprocedure('peppitness_private.guard_workout_session()')),false)
  union all select 'session_owner_mfa_and_rls', coalesce((select relrowsecurity and relforcerowsecurity
    from pg_class where oid=to_regclass('public.workout_sessions')),false)
    and exists(select 1 from pg_policy where polrelid='public.workout_sessions'::regclass
      and polname='mfa_aal2_required' and not polpermissive)
  union all select 'migration_recorded', exists(select 1 from supabase_migrations.schema_migrations where version='20261031120000')
)
select name,coalesce(ok,false) as ok from checks order by name;
