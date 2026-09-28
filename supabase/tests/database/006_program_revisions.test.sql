-- Revisione dei programmi pubblicati: aggiornamento in place, nuova versione, nessuna modifica,
-- solo nome/ciclo, storico delle sedute invariato. Solo locale, rollback finale.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();

select ok(not has_function_privilege('anon', 'public.save_workout_revision(uuid, uuid, integer, integer, uuid, text, text, jsonb, date, integer)', 'execute'), 'Revisione non eseguibile da anonimo');
select ok(has_function_privilege('authenticated', 'public.save_workout_revision(uuid, uuid, integer, integer, uuid, text, text, jsonb, date, integer)', 'execute'), 'Revisione eseguibile da utente autenticato');
select ok(not has_function_privilege('authenticated', 'peppitness_private.write_workout_days(uuid, uuid, jsonb, boolean)', 'execute'), 'Scrittura dei figli non esposta');

insert into auth.users(id, aud, role, email) values
  ('61111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'revision-a@example.invalid'),
  ('62222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'revision-b@example.invalid');
insert into public.exercises(id, owner_id, name, measurement_mode) values
  ('6aaaaaaa-0000-4000-8000-000000000001', '61111111-1111-4111-8111-111111111111', 'Squat', 'reps'),
  ('6aaaaaaa-0000-4000-8000-000000000002', '61111111-1111-4111-8111-111111111111', 'Panca', 'reps');

-- Documento parametrico: stessi ID di giorno e prescrizione, serie variabili.
create function pg_temp.days(p_sets integer, p_day uuid default '6ddddddd-0000-4000-8000-000000000001',
  p_item uuid default '6eeeeeee-0000-4000-8000-000000000001') returns jsonb language sql as $$
  select jsonb_build_array(jsonb_build_object('id', p_day, 'label', 'Lun', 'title', 'Petto', 'note', '',
    'exercises', jsonb_build_array(jsonb_build_object('id', p_item, 'exercise_id', '6aaaaaaa-0000-4000-8000-000000000001',
      'sets', p_sets, 'optional_sets', 0, 'reps_min', 8, 'reps_max', 10, 'duration_seconds', null,
      'rest_seconds', 90, 'rir', null, 'rpe', null, 'note', ''))))
$$;
grant execute on function pg_temp.days(integer, uuid, uuid) to authenticated;

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"61111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select lives_ok($q$ select public.save_workout_draft('6bbbbbbb-0000-4000-8000-000000000001', '6ccccccc-0000-4000-8000-000000000001', 0,
  'Scheda settembre', '', pg_temp.days(2)) $q$, 'Bozza creata');
select lives_ok($q$ select public.publish_workout_version('6ccccccc-0000-4000-8000-000000000001', 1, 1) $q$, 'Versione 1 pubblicata');

-- 1. Salvataggio identico: nessuna scrittura.
select is(public.save_workout_revision('6bbbbbbb-0000-4000-8000-000000000001', '6ccccccc-0000-4000-8000-000000000001', 2, 2,
  '6ccccccc-0000-4000-8000-000000000011', 'Scheda settembre', '', pg_temp.days(2), null, null)->>'outcome', 'unchanged', 'Contenuto identico: nessuna modifica');
select is((select revision from public.workout_plans), 2, 'Revisione del programma invariata');
select is((select revision from public.workout_plan_versions), 2, 'Revisione della versione invariata');

-- 2. Solo nome e ciclo: nessuna nuova versione.
select is(public.save_workout_revision('6bbbbbbb-0000-4000-8000-000000000001', '6ccccccc-0000-4000-8000-000000000001', 2, 2,
  '6ccccccc-0000-4000-8000-000000000012', 'Scheda ottobre', '', pg_temp.days(2), '2026-10-05', 8)->>'outcome', 'metadata', 'Solo nome e ciclo');
select is((select count(*)::integer from public.workout_plan_versions), 1, 'Nessuna nuova versione per nome e ciclo');
select is((select name from public.workout_plans), 'Scheda ottobre', 'Nome del programma aggiornato');
select is((select cycle_start from public.workout_plans), '2026-10-05'::date, 'Inizio del ciclo aggiornato');
select is((select cycle_weeks from public.workout_plans), 8::smallint, 'Durata del ciclo aggiornata');
select is((select title from public.workout_plan_versions), 'Scheda ottobre', 'Titolo della versione mai usata allineato al nome');

-- 3. Versione mai usata: aggiornata sul posto.
select is(public.save_workout_revision('6bbbbbbb-0000-4000-8000-000000000001', '6ccccccc-0000-4000-8000-000000000001', 3, 3,
  '6ccccccc-0000-4000-8000-000000000013', 'Scheda ottobre', '', pg_temp.days(3), '2026-10-05', 8)->>'outcome', 'updated', 'Versione mai usata aggiornata');
select is((select count(*)::integer from public.workout_plan_versions), 1, 'Ancora una sola versione');
select is((select version_number from public.workout_plan_versions), 1, 'Stesso numero di versione');
select is((select status from public.workout_plan_versions), 'published', 'La versione resta pubblicata');
select is((select sets from public.workout_prescriptions), 3, 'Serie aggiornate');
select is((select id from public.workout_days), '6ddddddd-0000-4000-8000-000000000001'::uuid, 'ID dei giorni conservati');
select is((select active_version_id from public.workout_plans), '6ccccccc-0000-4000-8000-000000000001'::uuid, 'Versione in uso invariata');

-- Seduta sulla versione 1: da qui la versione 1 è immutabile.
select lives_ok($q$ select public.start_workout_session('6fffffff-0000-4000-8000-000000000001', '6ccccccc-0000-4000-8000-000000000001',
  '6ddddddd-0000-4000-8000-000000000001', '2026-10-05', 'Europe/Rome') $q$, 'Seduta avviata sulla versione 1');
select lives_ok($q$ insert into public.workout_set_logs(session_id, prescription_id, set_index, amount, completed)
  values ('6fffffff-0000-4000-8000-000000000001', '6eeeeeee-0000-4000-8000-000000000001', 0, 8, true) $q$, 'Serie registrata');
select lives_ok($q$ update public.workout_sessions set status = 'completed', revision = 2 $q$, 'Seduta conclusa');

-- 4. Versione usata: il contenuto nuovo diventa la versione 2.
select is(public.save_workout_revision('6bbbbbbb-0000-4000-8000-000000000001', '6ccccccc-0000-4000-8000-000000000001', 3, 4,
  '6ccccccc-0000-4000-8000-000000000002', 'Scheda ottobre', '', pg_temp.days(4), '2026-10-05', 8)->>'outcome', 'created', 'Versione usata: nuova versione');
select is((select count(*)::integer from public.workout_plan_versions), 2, 'Due versioni');
select is((select version_number from public.workout_plan_versions where id = '6ccccccc-0000-4000-8000-000000000002'), 2, 'Numero v2');
select is((select status from public.workout_plan_versions where id = '6ccccccc-0000-4000-8000-000000000002'), 'published', 'v2 pubblicata');
select is((select active_version_id from public.workout_plans), '6ccccccc-0000-4000-8000-000000000002'::uuid, 'v2 in uso');
select is((select p.sets from public.workout_prescriptions p join public.workout_days d on d.id = p.day_id
  where d.version_id = '6ccccccc-0000-4000-8000-000000000001'), 3, 'Contenuto della v1 invariato');
select is((select p.sets from public.workout_prescriptions p join public.workout_days d on d.id = p.day_id
  where d.version_id = '6ccccccc-0000-4000-8000-000000000002'), 4, 'Contenuto nuovo nella v2');
select isnt((select id from public.workout_days where version_id = '6ccccccc-0000-4000-8000-000000000002'),
  '6ddddddd-0000-4000-8000-000000000001'::uuid, 'Figli della v2 con ID propri');
select is((select version_id from public.workout_sessions), '6ccccccc-0000-4000-8000-000000000001'::uuid, 'La seduta resta sulla v1');
select is((select (day_snapshot->'exercises'->0->>'sets')::integer from public.workout_sessions), 3, 'Snapshot della seduta invariato');
select is((select count(*)::integer from public.workout_set_logs), 1, 'Serie registrate invariate');

-- Riprova con lo stesso ID dopo una risposta persa: stesso esito, nessun duplicato.
select is(public.save_workout_revision('6bbbbbbb-0000-4000-8000-000000000001', '6ccccccc-0000-4000-8000-000000000001', 3, 4,
  '6ccccccc-0000-4000-8000-000000000002', 'Scheda ottobre', '', pg_temp.days(4), '2026-10-05', 8)->>'outcome', 'created', 'Riprova idempotente');
select is((select count(*)::integer from public.workout_plan_versions), 2, 'Nessuna versione duplicata');

-- Revisione obsoleta: conflitto, nessuna scrittura.
select throws_ok($q$ select public.save_workout_revision('6bbbbbbb-0000-4000-8000-000000000001', '6ccccccc-0000-4000-8000-000000000002', 3, 2,
  '6ccccccc-0000-4000-8000-000000000014', 'Scheda ottobre', '', pg_temp.days(5), '2026-10-05', 8) $q$, 'PT409', 'Revision conflict', 'Revisione obsoleta respinta');

-- 5. Versione usata, solo nome: nessuna nuova versione, titolo della versione usata invariato.
select lives_ok($q$ select public.start_workout_session('6fffffff-0000-4000-8000-000000000002', '6ccccccc-0000-4000-8000-000000000002',
  (select id from public.workout_days where version_id = '6ccccccc-0000-4000-8000-000000000002'), '2026-10-06', 'Europe/Rome') $q$, 'Seduta sulla v2');
select is(public.save_workout_revision('6bbbbbbb-0000-4000-8000-000000000001', '6ccccccc-0000-4000-8000-000000000002',
  (select revision from public.workout_plans), (select revision from public.workout_plan_versions where id = '6ccccccc-0000-4000-8000-000000000002'),
  '6ccccccc-0000-4000-8000-000000000015', 'Scheda autunno', '', pg_temp.days(4), '2026-10-05', 8)->>'outcome', 'metadata', 'Versione usata: solo nome');
select is((select count(*)::integer from public.workout_plan_versions), 2, 'Ancora due versioni');
select is((select name from public.workout_plans), 'Scheda autunno', 'Nome aggiornato');
select is((select title from public.workout_plan_versions where id = '6ccccccc-0000-4000-8000-000000000002'), 'Scheda ottobre', 'Titolo della versione usata invariato');

-- Contenuti non validi: nessuna scrittura parziale.
select throws_ok($q$ select public.save_workout_revision('6bbbbbbb-0000-4000-8000-000000000001', '6ccccccc-0000-4000-8000-000000000002',
  (select revision from public.workout_plans), (select revision from public.workout_plan_versions where id = '6ccccccc-0000-4000-8000-000000000002'),
  '6ccccccc-0000-4000-8000-000000000016', 'Scheda autunno', '', '[]'::jsonb, '2026-10-05', 8) $q$, '23514', null::text, 'Programma senza giorni respinto');
select is((select count(*)::integer from public.workout_plan_versions), 2, 'Nessuna versione dopo il rifiuto');

-- Bozza non pubblicata: non si revisiona con questa funzione.
select lives_ok($q$ select public.save_workout_draft('6bbbbbbb-0000-4000-8000-000000000002', '6ccccccc-0000-4000-8000-000000000021', 0,
  'Solo bozza', '', pg_temp.days(2, '6ddddddd-0000-4000-8000-000000000021', '6eeeeeee-0000-4000-8000-000000000021')) $q$, 'Altra bozza');
select throws_ok($q$ select public.save_workout_revision('6bbbbbbb-0000-4000-8000-000000000002', '6ccccccc-0000-4000-8000-000000000021', 1, 1,
  '6ccccccc-0000-4000-8000-000000000022', 'Solo bozza', '', pg_temp.days(3, '6ddddddd-0000-4000-8000-000000000021', '6eeeeeee-0000-4000-8000-000000000021'), null, null) $q$,
  '55000', 'Only published versions can be revised', 'Bozza respinta');

-- Isolamento: B non modifica il programma di A.
select set_config('request.jwt.claims', '{"sub":"62222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
select throws_ok($q$ select public.save_workout_revision('6bbbbbbb-0000-4000-8000-000000000001', '6ccccccc-0000-4000-8000-000000000002', 1, 1,
  '6ccccccc-0000-4000-8000-000000000031', 'Intruso', '', pg_temp.days(9), null, null) $q$, '42501', 'Plan not available', 'B non revisiona il programma di A');

-- Guardie ancora attive fuori dalla RPC, anche con il flag impostato su una versione usata.
reset role;
select throws_ok($q$ update public.workout_plan_versions set guidance = 'Diretto', revision = revision + 1
  where id = '6ccccccc-0000-4000-8000-000000000001' $q$, '55000', 'Published versions are immutable', 'Versione pubblicata immutabile senza revisione');
select set_config('peppitness.revise_version', '6ccccccc-0000-4000-8000-000000000001', true);
select throws_ok($q$ update public.workout_plan_versions set guidance = 'Diretto', revision = revision + 1
  where id = '6ccccccc-0000-4000-8000-000000000001' $q$, '55000', 'Published versions are immutable', 'Versione usata immutabile anche con il flag');
select throws_ok($q$ delete from public.workout_days where version_id = '6ccccccc-0000-4000-8000-000000000001' $q$,
  '55000', 'Only draft children can change', 'Figli della versione usata immutabili');
select set_config('peppitness.revise_version', '', true);

select * from finish();
rollback;
