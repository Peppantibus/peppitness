-- Sola lettura di metadati, adatta anche al cloud: nessun dato personale.
with rpcs(signature) as (values
  ('public.apply_workout_day_swap(uuid,jsonb)'),
  ('public.undo_workout_day_swap(uuid,uuid)'),
  ('public.start_workout_session(uuid,uuid,uuid,date,text)'),
  ('public.start_workout_session(uuid,uuid,uuid,date,text,uuid,uuid,boolean)'),
  ('public.start_free_workout_session(uuid,date,text)')
), checks(name,ok) as (
  select 'rpc_owner_mfa_lock_acl:'||signature,coalesce((select
    prosecdef and 'search_path=""'=any(proconfig)
    and position('require_mfa()' in prosrc)>0 and position('auth.uid()' in prosrc)>0
    and position('280928' in prosrc)>0
    and has_function_privilege('authenticated',oid,'EXECUTE')
    and not has_function_privilege('anon',oid,'EXECUTE')
    from pg_proc where oid=to_regprocedure(signature)),false) from rpcs
  union all select 'swap_rls_mfa_and_owner',coalesce((select relrowsecurity and relforcerowsecurity
    from pg_class where oid=to_regclass('public.workout_day_swaps')),false)
    and exists(select 1 from pg_policy where polrelid=to_regclass('public.workout_day_swaps') and polname='mfa_aal2_required' and not polpermissive)
    and not has_table_privilege('authenticated','public.workout_day_swaps','INSERT,UPDATE,DELETE')
  union all select 'session_rls_mfa',coalesce((select relrowsecurity and relforcerowsecurity
    from pg_class where oid=to_regclass('public.workout_sessions')),false)
    and exists(select 1 from pg_policy where polrelid='public.workout_sessions'::regclass and polname='mfa_aal2_required' and not polpermissive)
  union all select 'free_context_check',exists(select 1 from pg_constraint where conrelid='public.workout_sessions'::regclass and conname='workout_session_kind_context' and convalidated)
  union all select 'free_kind_immutable_and_empty_guard',coalesce((select position('Session kind cannot change' in prosrc)>0 and position('Free session has no exercises' in prosrc)>0
    from pg_proc where oid=to_regprocedure('peppitness_private.guard_free_workout()')),false)
  union all select 'legacy_session_format_policy',exists(select 1 from pg_policy where polrelid='public.workout_sessions'::regclass and polname='free_workout_client_format' and not polpermissive)
  union all select 'legacy_sets_format_policy',exists(select 1 from pg_policy where polrelid='public.workout_set_logs'::regclass and polname='free_workout_client_format' and not polpermissive)
  union all select 'private_receipts_closed:'||name,coalesce((select
    not has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE')
    from pg_class where oid=to_regclass('peppitness_private.'||name)),false)
    from (values('day_swap_receipts'),('free_workout_starts')) t(name)
  union all select 'private_start_closed',not has_function_privilege('authenticated','peppitness_private.start_workout_session_base(uuid,uuid,uuid,date,text)','EXECUTE')
  union all select 'exercise_changes_use_actual_calendar',coalesce((select position('scheduled_workout_day' in prosrc)>0 from pg_proc where oid='public.apply_workout_change(uuid,jsonb,integer)'::regprocedure),false)
  union all select 'cycle_guard_installed',exists(select 1 from pg_trigger where tgrelid='public.workout_plans'::regclass and tgname='c_day_swap_cycle' and tgenabled='O')
  union all select 'free_guard_installed',exists(select 1 from pg_trigger where tgrelid='public.workout_sessions'::regclass and tgname='b_guard_free_workout' and tgenabled='O')
  union all select 'migration_recorded:'||version,exists(select 1 from supabase_migrations.schema_migrations m where m.version=v.version)
    from (values('20261109120000'),('20261109160000')) v(version)
)
select name,coalesce(ok,false) as ok from checks order by name;
