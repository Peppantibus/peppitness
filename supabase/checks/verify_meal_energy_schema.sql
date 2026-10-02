-- Sola lettura; non esegue test o crea fixture nel progetto cloud.
select jsonb_build_object(
 'migration_present',exists(select 1 from supabase_migrations.schema_migrations where version='20261002143000'),
 'plan_validation',position('dailyCalories' in pg_get_functiondef('peppitness_private.validate_meal_plan()'::regprocedure))>0,
 'snapshot_validation',exists(select 1 from pg_trigger where tgrelid='public.meal_logs'::regclass and tgname='c_validate_meal_energy_snapshot' and tgenabled='O'),
 'plans_rls',(select relrowsecurity from pg_class where oid='public.meal_plans'::regclass),
 'logs_rls',(select relrowsecurity from pg_class where oid='public.meal_logs'::regclass),
 'anon_denied',not has_table_privilege('anon','public.meal_plans','select') and not has_table_privilege('anon','public.meal_logs','select'),
 'snapshot_immutable',not has_column_privilege('authenticated','public.meal_logs','meal_snapshot','update'),
 'private_helpers',not has_function_privilege('authenticated','peppitness_private.meal_energy_number(jsonb,numeric,numeric,boolean)','execute') and not has_function_privilege('anon','peppitness_private.meal_period_date(jsonb)','execute')
) as verification;
