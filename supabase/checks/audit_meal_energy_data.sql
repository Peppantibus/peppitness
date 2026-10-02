-- Sola lettura: soltanto conteggi/impronte, nessun contenuto dei piani o identificativo.
select 'user_settings' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.user_settings t
union all
select 'exercises' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.exercises t
union all
select 'shared_exercises' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.shared_exercises t
union all
select 'workout_plans' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.workout_plans t
union all
select 'workout_plan_versions' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.workout_plan_versions t
union all
select 'workout_days' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.workout_days t
union all
select 'workout_prescriptions' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.workout_prescriptions t
union all
select 'workout_sessions' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.workout_sessions t
union all
select 'workout_set_logs' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.workout_set_logs t
union all
select 'meal_plans' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.meal_plans t
union all
select 'active_plans' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.active_plans t
union all
select 'diary_days' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.diary_days t
union all
select 'meal_logs' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.meal_logs t
union all
select 'import_receipts' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.import_receipts t
union all
select 'import_drafts' as table_name,count(*) as rows,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' order by md5(row_to_json(t)::text)),'')) as fingerprint from public.import_drafts t;
