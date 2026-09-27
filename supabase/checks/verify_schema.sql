-- Verifica dopo l'applicazione delle migrazioni, locale o cloud.
-- Solo metadati di schema/permessi: nessun record applicativo, utente o segreto.
-- Non sostituisce le prove HTTP a due account sullo stesso ambiente.
with expected_tables(name, direct_insert, direct_update, policy_count, direct_delete) as (
  values
    ('user_settings', true, true, 3, false),
    ('exercises', true, true, 3, false),
    ('workout_plans', false, true, 2, false),
    ('workout_plan_versions', false, false, 1, false),
    ('workout_days', false, false, 1, false),
    ('workout_prescriptions', false, false, 1, false),
    ('meal_plans', true, true, 3, false),
    ('active_plans', true, true, 3, false),
    ('workout_sessions', false, true, 3, true),
    ('workout_set_logs', true, true, 3, false),
    ('diary_days', true, true, 3, false),
    ('meal_logs', true, true, 3, false)
), table_checks as (
  select e.name,
    coalesce(c.relkind = 'r'
      and c.relrowsecurity and c.relforcerowsecurity
      and not has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE')
      and not has_table_privilege('anon', c.oid, 'DELETE')
      and has_table_privilege('authenticated', c.oid, 'SELECT')
      and has_any_column_privilege('authenticated', c.oid, 'INSERT') = e.direct_insert
      and has_any_column_privilege('authenticated', c.oid, 'UPDATE') = e.direct_update
      and has_table_privilege('authenticated', c.oid, 'DELETE') = e.direct_delete
      and (select count(*) from pg_policy p where p.polrelid = c.oid) = e.policy_count,
    false) as ok
  from expected_tables e
  left join pg_class c on c.oid = to_regclass('public.' || e.name)
), expected_functions(signature, definer, client_execute) as (
  values
    ('peppitness_private.stamp_record()', false, false),
    ('public.save_workout_draft(uuid,uuid,integer,text,text,jsonb)', true, true),
    ('public.publish_workout_version(uuid,integer,integer)', true, true),
    ('public.activate_workout_version(uuid,integer)', true, true),
    ('public.start_workout_session(uuid,uuid,uuid,date,text)', true, true)
), function_checks as (
  select e.signature,
    coalesce(p.prosecdef = e.definer
      and not has_function_privilege('anon', p.oid, 'EXECUTE')
      and has_function_privilege('authenticated', p.oid, 'EXECUTE') = e.client_execute
      and 'search_path=""' = any(p.proconfig)
      and position('PT409' in p.prosrc) > 0
      and position('40001' in p.prosrc) = 0,
    false) as ok
  from expected_functions e
  left join pg_proc p on p.oid = to_regprocedure(e.signature)
)
select jsonb_build_object(
  'tables_ok', (select bool_and(ok) from table_checks),
  'table_checks', (select jsonb_object_agg(name, ok) from table_checks),
  'functions_ok', (select bool_and(ok) from function_checks),
  'function_checks', (select jsonb_object_agg(signature, ok) from function_checks),
  'private_schema_closed',
    coalesce(not has_schema_privilege('anon', to_regnamespace('peppitness_private'), 'USAGE')
      and not has_schema_privilege('authenticated', to_regnamespace('peppitness_private'), 'USAGE'), false),
  'migration_versions', (select jsonb_agg(version order by version) from supabase_migrations.schema_migrations)
) as schema_verification;
