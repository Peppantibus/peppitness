-- Test locale con rollback: eliminazione dei piani, snapshot storici e isolamento utenti.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();
select ok(not has_function_privilege('anon', 'public.delete_workout_plans(uuid)', 'execute'), 'Eliminazione programmi non anonima');
select ok(not has_function_privilege('anon', 'public.delete_meal_plans(uuid)', 'execute'), 'Eliminazione piani alimentari non anonima');
select ok(not has_table_privilege('authenticated', 'public.workout_plans', 'DELETE'), 'Cancellazione diretta programmi non consentita');
select ok(not has_table_privilege('authenticated', 'public.meal_plans', 'DELETE'), 'Cancellazione diretta piani alimentari non consentita');

insert into auth.users(id, aud, role, email) values
  ('41111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'delete-a@example.invalid'),
  ('42222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'delete-b@example.invalid');
insert into public.exercises(id, owner_id, name, measurement_mode) values
  ('4aaaaaaa-0000-4000-8000-000000000001', '41111111-1111-4111-8111-111111111111', 'Squat', 'reps');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"41111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select lives_ok($q$ select public.save_workout_draft('4bbbbbbb-0000-4000-8000-000000000001', '4ccccccc-0000-4000-8000-000000000001', 0,
  'Programma A', '', jsonb_build_array(jsonb_build_object('id', '4ddddddd-0000-4000-8000-000000000001', 'label', 'A', 'title', 'Seduta A',
    'exercises', jsonb_build_array(jsonb_build_object('id', '4eeeeeee-0000-4000-8000-000000000001',
      'exercise_id', '4aaaaaaa-0000-4000-8000-000000000001', 'sets', 1, 'reps_min', 8, 'reps_max', 8)))) $q$, 'Programma creato');
select lives_ok($q$ select public.publish_workout_version('4ccccccc-0000-4000-8000-000000000001', 1, 1) $q$, 'Programma pubblicato');
select lives_ok($q$ insert into public.active_plans(workout_plan_id) values ('4bbbbbbb-0000-4000-8000-000000000001') $q$, 'Programma seguito');
select lives_ok($q$ select public.start_workout_session('4fffffff-0000-4000-8000-000000000001', '4ccccccc-0000-4000-8000-000000000001',
  '4ddddddd-0000-4000-8000-000000000001', '2026-09-28', 'Europe/Rome') $q$, 'Seduta avviata');
select lives_ok($q$ insert into public.workout_set_logs(session_id, prescription_id, set_index, amount, completed)
  values ('4fffffff-0000-4000-8000-000000000001', '4eeeeeee-0000-4000-8000-000000000001', 0, 8, true) $q$, 'Serie registrata');
select lives_ok($q$ update public.workout_sessions set status = 'completed', revision = 2 $q$, 'Seduta conclusa');

select lives_ok($q$ insert into public.meal_plans(id, name, document) values
  ('49999999-0000-4000-8000-000000000001', 'Dieta A', '{"guidance":"","days":[]}'::jsonb) $q$, 'Piano alimentare creato');
select lives_ok($q$ update public.active_plans set meal_plan_id = '49999999-0000-4000-8000-000000000001', revision = 2 $q$, 'Piano seguito');
select lives_ok($q$ insert into public.meal_logs(diary_date, meal_id, meal_plan_id, status, note, day_type, meal_snapshot)
  values ('2026-09-28', '49999999-0000-4000-8000-000000000021', '49999999-0000-4000-8000-000000000001',
    'followed', '', 'training', '{"id":"49999999-0000-4000-8000-000000000021","name":"Colazione"}'::jsonb) $q$, 'Pasto registrato');

select set_config('request.jwt.claims', '{"sub":"42222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
select lives_ok($q$ insert into public.meal_plans(id, name, document) values
  ('49999999-0000-4000-8000-000000000002', 'Dieta B', '{"guidance":"","days":[]}'::jsonb) $q$, 'Piano B creato');
select is(public.delete_workout_plans('4bbbbbbb-0000-4000-8000-000000000001'), 0, 'B non elimina il programma di A');
select is(public.delete_meal_plans(null), 1, 'B elimina solo i propri piani');

select set_config('request.jwt.claims', '{"sub":"41111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select is(public.delete_workout_plans('4bbbbbbb-0000-4000-8000-000000000001'), 1, 'Programma A eliminato');
select is((select workout_plan_id from public.active_plans), null::uuid, 'Selezione della Scheda svuotata');
select is((select count(*)::integer from public.workout_sessions), 1, 'Seduta storica conservata');
select is((select count(*)::integer from public.workout_set_logs), 1, 'Serie storica conservata');
select is((select day_snapshot->>'title' from public.workout_sessions), 'Seduta A', 'Snapshot della seduta leggibile');
select lives_ok($q$ update public.workout_set_logs set amount = 9, revision = 2 $q$, 'Serie storica ancora correggibile');
select is(public.delete_meal_plans(null), 1, 'Tutti i piani alimentari di A eliminati');
select is((select meal_plan_id from public.active_plans), null::uuid, 'Selezione Dieta svuotata');
select is((select count(*)::integer from public.meal_logs), 1, 'Pasto storico conservato');
select lives_ok($q$ update public.meal_logs set note = 'Conservato', revision = 2 $q$, 'Pasto storico ancora correggibile');
select throws_ok($q$ insert into public.meal_logs(diary_date, meal_id, meal_plan_id, status, note, day_type, meal_snapshot)
  values ('2026-09-29', '49999999-0000-4000-8000-000000000022', '49999999-0000-4000-8000-000000000001',
    'followed', '', 'training', '{"id":"49999999-0000-4000-8000-000000000022","name":"Cena"}'::jsonb) $q$,
  '23503', 'Meal plan not available', 'Nuovo pasto senza piano respinto');

select * from finish();
rollback;
