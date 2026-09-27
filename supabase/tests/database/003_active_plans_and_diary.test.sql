-- Test esclusivamente locali: programma attivo, sedute/serie, piano alimentare e diario pasti.
-- Fixture inventate, nessuna password; rollback finale. Le identita SQL simulate
-- verificano PostgreSQL/RLS, non il login o le API HTTP.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();

select ok(bool_and(c.relrowsecurity and c.relforcerowsecurity), 'RLS forzata sulle nuove tabelle')
from pg_class c where c.oid in ('public.meal_plans'::regclass, 'public.active_plans'::regclass,
  'public.workout_sessions'::regclass, 'public.workout_set_logs'::regclass,
  'public.diary_days'::regclass, 'public.meal_logs'::regclass);
select ok(not bool_or(has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE') or has_table_privilege('anon', c.oid, 'DELETE')),
  'Nessun privilegio anonimo sulle nuove tabelle')
from pg_class c where c.oid in ('public.meal_plans'::regclass, 'public.active_plans'::regclass,
  'public.workout_sessions'::regclass, 'public.workout_set_logs'::regclass,
  'public.diary_days'::regclass, 'public.meal_logs'::regclass);
select ok(not has_function_privilege('anon', 'public.start_workout_session(uuid,uuid,uuid,date,text)', 'execute'), 'Avvio seduta non anonimo');
select ok(not has_column_privilege('authenticated', 'public.workout_sessions', 'day_snapshot', 'UPDATE'), 'Snapshot seduta non modificabile dal client');
select ok(not has_table_privilege('authenticated', 'public.workout_sessions', 'INSERT'), 'Sedute create solo dalla RPC');
select ok(not has_column_privilege('authenticated', 'public.meal_logs', 'meal_snapshot', 'UPDATE'), 'Snapshot pasto non modificabile');

insert into auth.users(id, aud, role, email) values
  ('11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'diary-a@example.invalid'),
  ('22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'diary-b@example.invalid');
insert into public.exercises(id, owner_id, name, measurement_mode) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Squat di prova', 'reps'),
  ('aaaaaaaa-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'Plank di prova', 'seconds');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

-- Programma con una seduta pubblicato da A, piu una bozza non pubblicata.
select lives_ok($q$
  select public.save_workout_draft('bbbbbbbb-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 0,
    'Programma A', '', jsonb_build_array(jsonb_build_object('id', 'dddddddd-0000-4000-8000-000000000001', 'label', 'A', 'title', 'Seduta A',
      'exercises', jsonb_build_array(
        jsonb_build_object('id', 'eeeeeeee-0000-4000-8000-000000000001', 'exercise_id', 'aaaaaaaa-0000-4000-8000-000000000001',
          'sets', 2, 'optional_sets', 1, 'reps_min', 8, 'reps_max', 10, 'rest_seconds', 90),
        jsonb_build_object('id', 'eeeeeeee-0000-4000-8000-000000000002', 'exercise_id', 'aaaaaaaa-0000-4000-8000-000000000002',
          'sets', 1, 'duration_seconds', 30)))))
$q$, 'Bozza del programma salvata');
select lives_ok($q$ select public.save_workout_draft('bbbbbbbb-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000009', 0, 'Solo bozza', '', '[]'::jsonb) $q$,
  'Programma senza versioni pubblicate');

select throws_ok($q$ insert into public.active_plans(workout_plan_id) values ('bbbbbbbb-0000-4000-8000-000000000001') $q$,
  '23514', null::text, 'Programma senza versione pubblicata non attivabile');
select lives_ok($q$ select public.publish_workout_version('cccccccc-0000-4000-8000-000000000001', 1, 1) $q$, 'Versione pubblicata');
select lives_ok($q$ insert into public.active_plans(workout_plan_id) values ('bbbbbbbb-0000-4000-8000-000000000001') $q$, 'Programma attivo salvato');
select throws_ok($q$ update public.active_plans set workout_plan_id = 'bbbbbbbb-0000-4000-8000-000000000002', revision = 2 $q$,
  '23514', null::text, 'Cambio verso programma non pubblicato respinto');
select throws_ok($q$ update public.active_plans set workout_plan_id = null, revision = 1 $q$,
  'PT409', 'Revision conflict', 'Selezione con revisione obsoleta respinta');

-- Seconda versione pubblicata e riattivazione esplicita della prima.
select lives_ok($q$
  select public.save_workout_draft('bbbbbbbb-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000002', 0,
    'Programma A v2', '', jsonb_build_array(jsonb_build_object('id', 'dddddddd-0000-4000-8000-000000000002', 'label', 'A', 'title', 'Seduta A2',
      'exercises', jsonb_build_array(jsonb_build_object('id', 'eeeeeeee-0000-4000-8000-000000000003',
        'exercise_id', 'aaaaaaaa-0000-4000-8000-000000000001', 'sets', 3, 'reps_min', 5, 'reps_max', 5)))))
$q$, 'Seconda bozza salvata');
select lives_ok($q$ select public.publish_workout_version('cccccccc-0000-4000-8000-000000000002', 1, 2) $q$, 'Seconda versione pubblicata');
select is((select active_version_id from public.workout_plans where id = 'bbbbbbbb-0000-4000-8000-000000000001'),
  'cccccccc-0000-4000-8000-000000000002'::uuid, 'Pubblicazione rende corrente la nuova versione');
select throws_ok($q$ select public.activate_workout_version('cccccccc-0000-4000-8000-000000000001', 1) $q$,
  'PT409', 'Revision conflict', 'Riattivazione con programma obsoleto respinta');
select throws_ok($q$ select public.activate_workout_version('cccccccc-0000-4000-8000-000000000009', 3) $q$,
  '55000', null::text, 'Bozza non riattivabile');
select lives_ok($q$ select public.activate_workout_version('cccccccc-0000-4000-8000-000000000001', 3) $q$, 'Versione precedente riattivata');
select is((select status from public.workout_plan_versions where id = 'cccccccc-0000-4000-8000-000000000002'), 'published', 'Versione successiva conservata');

-- Sedute
select lives_ok($q$
  select public.start_workout_session('ffffffff-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001',
    'dddddddd-0000-4000-8000-000000000001', '2026-09-28', 'Europe/Rome')
$q$, 'Seduta avviata');
select is((select jsonb_array_length(day_snapshot->'exercises') from public.workout_sessions), 2, 'Snapshot con tutte le prescrizioni');
select is((select day_snapshot->'exercises'->0->>'name' from public.workout_sessions), 'Squat di prova', 'Snapshot con nome esercizio');
select lives_ok($q$
  select public.start_workout_session('ffffffff-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001',
    'dddddddd-0000-4000-8000-000000000001', '2026-09-28', 'Europe/Rome')
$q$, 'Riavvio con lo stesso ID idempotente');
select is((select count(*)::integer from public.workout_sessions), 1, 'Nessuna seduta duplicata');
select throws_ok($q$
  select public.start_workout_session('ffffffff-0000-4000-8000-000000000002', 'cccccccc-0000-4000-8000-000000000001',
    'dddddddd-0000-4000-8000-000000000001', '2026-09-28', 'Europe/Rome')
$q$, 'PT409', 'Another session is active', 'Una sola seduta in corso per account');
select throws_ok($q$
  select public.start_workout_session('ffffffff-0000-4000-8000-000000000003', 'cccccccc-0000-4000-8000-000000000009',
    'dddddddd-0000-4000-8000-000000000001', '2026-09-28', 'Europe/Rome')
$q$, '55000', null::text, 'Seduta da bozza respinta');
select throws_ok($q$
  insert into public.workout_sessions(id, plan_id, version_id, day_id, diary_date, time_zone, day_snapshot)
  values (gen_random_uuid(), 'bbbbbbbb-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001',
    'dddddddd-0000-4000-8000-000000000001', '2026-09-28', 'Europe/Rome', '{}')
$q$, '42501', null::text, 'Insert diretto delle sedute vietato');

-- Serie
select lives_ok($q$
  insert into public.workout_set_logs(session_id, prescription_id, set_index, load, amount, completed)
  values ('ffffffff-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001', 0, 12.5, 10, true)
$q$, 'Serie registrata');
select lives_ok($q$
  insert into public.workout_set_logs(session_id, prescription_id, set_index, load, amount, completed)
  values ('ffffffff-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001', 2, null, null, false)
$q$, 'Serie facoltativa registrabile');
select throws_ok($q$
  insert into public.workout_set_logs(session_id, prescription_id, set_index, amount, completed)
  values ('ffffffff-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001', 3, 8, true)
$q$, '23514', null::text, 'Serie oltre la prescrizione respinta');
select throws_ok($q$
  insert into public.workout_set_logs(session_id, prescription_id, set_index, amount, completed)
  values ('ffffffff-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000003', 0, 8, true)
$q$, '23514', null::text, 'Prescrizione estranea alla seduta respinta');
select throws_ok($q$
  insert into public.workout_set_logs(session_id, prescription_id, set_index, amount, completed)
  values ('ffffffff-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001', 1, 8.5, true)
$q$, '23514', null::text, 'Ripetizioni decimali respinte');
select throws_ok($q$
  insert into public.workout_set_logs(session_id, prescription_id, set_index, completed)
  values ('ffffffff-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001', 1, true)
$q$, '23514', null::text, 'Serie completata senza risultato respinta');
select throws_ok($q$
  insert into public.workout_set_logs(session_id, prescription_id, set_index, amount, completed)
  values ('ffffffff-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001', 0, 9, true)
$q$, '23505', null::text, 'Doppio inserimento della stessa serie respinto');
select lives_ok($q$
  insert into public.workout_set_logs(session_id, prescription_id, set_index, amount, completed)
  values ('ffffffff-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000002', 0, 32.5, true)
$q$, 'Durata decimale ammessa per esercizio a tempo');
select throws_ok($q$
  update public.workout_set_logs set load = 15, revision = 1 where set_index = 0 and prescription_id = 'eeeeeeee-0000-4000-8000-000000000001'
$q$, 'PT409', 'Revision conflict', 'Modifica serie con revisione obsoleta respinta');
select lives_ok($q$
  update public.workout_set_logs set load = 15, revision = 2 where set_index = 0 and prescription_id = 'eeeeeeee-0000-4000-8000-000000000001'
$q$, 'Correzione serie con revisione');
select throws_ok($q$ update public.workout_set_logs set set_index = 1, revision = 3 $q$, '42501', null::text, 'Identita della serie non modificabile');

-- Completamento
select lives_ok($q$ update public.workout_sessions set status = 'completed', revision = 2 $q$, 'Seduta completata');
select ok((select completed_at is not null from public.workout_sessions), 'Orario di completamento dal server');
select throws_ok($q$ update public.workout_sessions set status = 'active', revision = 3 $q$, '55000', null::text, 'Seduta completata non riaperta');
select lives_ok($q$ update public.workout_set_logs set amount = 11, revision = 3 where set_index = 0 and prescription_id = 'eeeeeeee-0000-4000-8000-000000000001' $q$,
  'Storico correggibile dopo il completamento');
delete from public.workout_sessions where id = 'ffffffff-0000-4000-8000-000000000001';
select is((select count(*)::integer from public.workout_sessions), 1, 'Seduta completata non cancellabile dal client');
select lives_ok($q$
  select public.start_workout_session('ffffffff-0000-4000-8000-000000000004', 'cccccccc-0000-4000-8000-000000000001',
    'dddddddd-0000-4000-8000-000000000001', '2026-09-29', 'Europe/Rome')
$q$, 'Nuova seduta dopo il completamento');
select lives_ok($q$
  insert into public.workout_set_logs(session_id, prescription_id, set_index, amount, completed)
  values ('ffffffff-0000-4000-8000-000000000004', 'eeeeeeee-0000-4000-8000-000000000001', 0, 8, true)
$q$, 'Serie nella seduta da annullare');
delete from public.workout_sessions where id = 'ffffffff-0000-4000-8000-000000000004';
select is((select count(*)::integer from public.workout_set_logs where session_id = 'ffffffff-0000-4000-8000-000000000004'), 0,
  'Seduta in corso annullata con le sue serie');

-- Piano alimentare
select lives_ok($q$
  insert into public.meal_plans(id, name, document) values ('99999999-0000-4000-8000-000000000001', 'Piano di prova', jsonb_build_object(
    'guidance', '', 'days', jsonb_build_array(jsonb_build_object('id', '99999999-0000-4000-8000-000000000011', 'name', 'Palestra',
      'dayType', 'training', 'note', '', 'meals', jsonb_build_array(jsonb_build_object('id', '99999999-0000-4000-8000-000000000021',
        'name', 'Colazione', 'time', '07:30', 'note', '', 'alternatives', jsonb_build_array('Pane e ricotta'), 'additions', '[]'::jsonb,
        'foods', jsonb_build_array(jsonb_build_object('name', 'Yogurt', 'quantity', '150 g'))))))))
$q$, 'Piano alimentare valido salvato');
select throws_ok($q$
  insert into public.meal_plans(id, name, document) values (gen_random_uuid(), 'Invalido', '{"guidance":"","days":[],"extra":1}')
$q$, '23514', null::text, 'Proprieta sconosciute respinte');
select throws_ok($q$
  insert into public.meal_plans(id, name, document) values (gen_random_uuid(), 'Invalido', '{"guidance":"","days":[{"id":"99999999-0000-4000-8000-000000000012","name":" ","dayType":"any","note":"","meals":[]}]}')
$q$, '23514', null::text, 'Giornata senza nome respinta');
select throws_ok($q$
  update public.meal_plans set document = '{"guidance":"x","days":[]}', revision = 1
$q$, 'PT409', 'Revision conflict', 'Piano con revisione obsoleta respinto');
select throws_ok($q$
  insert into public.meal_plans(id, name, document) values (gen_random_uuid(), 'Enorme',
    jsonb_build_object('guidance', repeat('x', 16000), 'days', (select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'name', 'G', 'dayType', 'any',
      'note', repeat('n', 4000), 'meals', (select jsonb_agg(jsonb_build_object('id', gen_random_uuid(), 'name', 'P', 'time', '', 'note', repeat('m', 4000),
        'alternatives', '[]'::jsonb, 'additions', '[]'::jsonb, 'foods', '[]'::jsonb)) from generate_series(1, 20)))) from generate_series(1, 14))))
$q$, '23514', null::text, 'Documento oltre 256 KiB respinto anche se ogni campo e nei limiti');
select lives_ok($q$ update public.active_plans set meal_plan_id = '99999999-0000-4000-8000-000000000001', revision = 2 $q$, 'Piano alimentare attivo');

-- Diario pasti
select lives_ok($q$ insert into public.diary_days(diary_date, day_type) values ('2026-09-28', 'rest') $q$, 'Tipo di giornata salvato');
select throws_ok($q$ insert into public.diary_days(diary_date, day_type) values ('2026-09-28', 'training') $q$, '23505', null::text, 'Giornata duplicata respinta');
select lives_ok($q$
  insert into public.meal_logs(diary_date, meal_id, meal_plan_id, status, note, day_type, meal_snapshot)
  values ('2026-09-28', '99999999-0000-4000-8000-000000000021', '99999999-0000-4000-8000-000000000001', 'modified', 'Meno yogurt', 'rest',
    '{"id":"99999999-0000-4000-8000-000000000021","name":"Colazione"}')
$q$, 'Pasto registrato con snapshot');
select throws_ok($q$
  insert into public.meal_logs(diary_date, meal_id, meal_plan_id, status, day_type, meal_snapshot)
  values ('2026-09-27', '99999999-0000-4000-8000-000000000021', '99999999-0000-4000-8000-000000000001', 'followed', 'rest',
    '{"id":"99999999-0000-4000-8000-000000000099","name":"Colazione"}')
$q$, '23514', null::text, 'Snapshot incoerente respinto');
select throws_ok($q$ update public.meal_logs set day_type = 'training', revision = 2 $q$, '42501', null::text, 'Contesto del pasto non modificabile');
select lives_ok($q$ update public.meal_logs set status = 'followed', note = '', revision = 2 $q$, 'Registrazione correggibile');

-- Isolamento fra account
select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
select is((select count(*)::integer from public.workout_sessions) + (select count(*)::integer from public.workout_set_logs)
  + (select count(*)::integer from public.meal_plans) + (select count(*)::integer from public.meal_logs)
  + (select count(*)::integer from public.active_plans) + (select count(*)::integer from public.diary_days), 0, 'B non vede i dati di A');
select throws_ok($q$
  select public.start_workout_session(gen_random_uuid(), 'cccccccc-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000001', '2026-09-28', 'Europe/Rome')
$q$, '42501', null::text, 'B non avvia sedute sul programma di A');
select throws_ok($q$
  select public.start_workout_session('ffffffff-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000001', '2026-09-28', 'Europe/Rome')
$q$, '42501', null::text, 'B non riusa l''ID seduta di A');
select throws_ok($q$
  insert into public.workout_set_logs(session_id, prescription_id, set_index, amount, completed)
  values ('ffffffff-0000-4000-8000-000000000001', 'eeeeeeee-0000-4000-8000-000000000001', 1, 8, true)
$q$, '23514', null::text, 'B non scrive serie nella seduta di A');
select throws_ok($q$ insert into public.active_plans(workout_plan_id) values ('bbbbbbbb-0000-4000-8000-000000000001') $q$,
  '23514', null::text, 'B non seleziona il programma di A');
select throws_ok($q$
  insert into public.meal_logs(diary_date, meal_id, meal_plan_id, status, day_type, meal_snapshot)
  values ('2026-09-28', '99999999-0000-4000-8000-000000000021', '99999999-0000-4000-8000-000000000001', 'followed', 'rest',
    '{"id":"99999999-0000-4000-8000-000000000021","name":"Colazione"}')
$q$, '23503', null::text, 'B non registra pasti sul piano di A');
select throws_ok($q$ select public.activate_workout_version('cccccccc-0000-4000-8000-000000000001', 4) $q$, '42501', null::text,
  'B non riattiva versioni di A');
update public.workout_set_logs set amount = 1, revision = 9;
delete from public.workout_sessions;
reset role;
select is((select amount from public.workout_set_logs where session_id = 'ffffffff-0000-4000-8000-000000000001'
  and prescription_id = 'eeeeeeee-0000-4000-8000-000000000001' and set_index = 0), 11::numeric, 'Update di B invisibile e senza effetto');

-- Cancellazione amministrativa dell'account: rimozione a cascata senza errori.
select lives_ok($q$ delete from auth.users where id = '11111111-1111-4111-8111-111111111111' $q$, 'Account rimosso con tutto il diario');
select is((select count(*)::integer from public.workout_sessions) + (select count(*)::integer from public.meal_plans), 0, 'Nessun dato orfano');

select * from finish();
rollback;
