-- Sola lettura, nessun contenuto personale. Dopo la nuova migrazione.
select jsonb_build_object(
 'tables', (select jsonb_agg(t) from (
   select c.relname, c.relrowsecurity as rls, c.relforcerowsecurity as force_rls,
     exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attname='muscle_group' and not a.attisdropped) as category_column,
     not has_table_privilege('anon', c.oid, 'select') as anon_denied,
     not has_table_privilege('authenticated', c.oid, 'update') as no_unrestricted_update
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('exercises','shared_exercises'))t),
 'category_update', has_column_privilege('authenticated','public.exercises','muscle_group','update'),
 'shared_category_readonly', not has_column_privilege('authenticated','public.shared_exercises','muscle_group','update'),
 'private_helpers', (select jsonb_agg(t) from (
   select p.proname, not has_function_privilege('authenticated',p.oid,'execute') as authenticated_denied,
      not has_function_privilege('anon',p.oid,'execute') as anon_denied, p.proconfig
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='peppitness_private'
     and p.proname in ('infer_muscle_group','set_initial_muscle_group','snapshot_prescription_muscle_group','snapshot_session_muscle_groups'))t),
 'shared_groups', (select jsonb_agg(t) from (select muscle_group,count(*) as count from public.shared_exercises group by muscle_group order by muscle_group)t),
 'personal_groups', (select jsonb_agg(t) from (select muscle_group,count(*) as count from public.exercises group by muscle_group order by muscle_group)t),
 'invalid_groups', (select count(*) from public.exercises where muscle_group not in ('Petto','Schiena','Spalle','Bicipiti','Tricipiti','Gambe','Glutei','Polpacci','Addome','Full body','Cardio'))
) as verification;
