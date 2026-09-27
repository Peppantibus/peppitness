-- Test esclusivamente locali. Fixture inventate, nessuna password; rollback finale.
-- Le identita SQL simulate verificano PostgreSQL/RLS, non il login o le API HTTP.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();

select ok((select relrowsecurity from pg_class where oid = 'public.user_settings'::regclass), 'RLS su impostazioni');
select ok((select relrowsecurity from pg_class where oid = 'public.exercises'::regclass), 'RLS su esercizi');
select ok(not has_schema_privilege('authenticated', 'peppitness_private', 'usage'), 'Schema helper non accessibile al client');
select ok(not has_function_privilege('authenticated', 'peppitness_private.stamp_record()', 'execute'), 'Helper non invocabile direttamente');

insert into auth.users(id, aud, role, email) values
  ('11111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'test-a@example.invalid'),
  ('22222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'test-b@example.invalid');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);

select lives_ok($q$
  insert into public.user_settings(display_name, workout_weekdays) values ('Persona A', array[1,3,5]::smallint[])
$q$, 'A crea le proprie impostazioni senza fornire owner_id');
select lives_ok($q$
  insert into public.exercises(id, name, variant, equipment, load_convention, per_side)
  values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Rematore di prova', 'unilaterale', 'manubrio', 'single-dumbbell', true)
$q$, 'A crea un proprio esercizio');
select is((select owner_id from public.exercises), '11111111-1111-4111-8111-111111111111'::uuid, 'Proprietario predefinito dalla sessione');
select is((select revision from public.exercises), 1, 'Revisione iniziale 1');

select lives_ok($q$
  update public.exercises set name = 'Rematore rinominato', revision = 2
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$q$, 'Rinomina consentita con revisione corretta');
select is((select id from public.exercises), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid, 'Rinomina conserva identita');
select throws_ok($q$
  update public.exercises set name = 'Modifica obsoleta', revision = 2
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$q$, 'PT409', 'Revision conflict', 'Seconda modifica dalla stessa revisione respinta');
select is((select name from public.exercises), 'Rematore rinominato', 'Conflitto non sovrascrive il dato');
select throws_ok($q$
  update public.exercises set note = 'Senza revisione'
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$q$, 'PT409', 'Revision conflict', 'Update senza incremento respinto');
select throws_ok($q$
  update public.exercises set variant = 'diversa', revision = 3
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$q$, '42501', null::text, 'Client non altera la variante confrontabile');
select throws_ok($q$
  update public.exercises set owner_id = '22222222-2222-4222-8222-222222222222', revision = 3
$q$, '42501', null::text, 'Trasferimento proprieta vietato');
select throws_ok($q$
  update public.user_settings set owner_id = '22222222-2222-4222-8222-222222222222', revision = 2
$q$, '42501', null::text, 'Trasferimento impostazioni vietato');

select lives_ok($q$
  update public.user_settings set time_zone = 'Europe/Rome', workout_weekdays = '{}'::smallint[], revision = 2
$q$, 'Nessun giorno abituale e un valore valido');
select throws_ok($q$
  update public.user_settings set display_name = 'Obsoleto', revision = 2
$q$, 'PT409', 'Revision conflict', 'Conflitto anche nelle impostazioni');
select throws_ok($q$
  update public.user_settings set time_zone = 'Invalid/Zone', revision = 3
$q$, '23514', 'Unknown time zone', 'Fuso inesistente respinto');
select throws_ok($q$
  update public.user_settings set workout_weekdays = array[1,1]::smallint[], revision = 3
$q$, '23514', 'Workout weekdays must be unique', 'Giorni duplicati respinti');
select throws_ok($q$
  update public.user_settings set workout_weekdays = array[8]::smallint[], revision = 3
$q$, '23514', null::text, 'Giorno fuori intervallo respinto');
select throws_ok($q$
  insert into public.exercises(name) values ('   ')
$q$, '23514', null::text, 'Nome vuoto respinto');
select throws_ok($q$
  insert into public.exercises(name, revision) values ('Revisione inventata', 8)
$q$, '23514', 'Initial revision must be 1', 'Revisione iniziale arbitraria respinta');
select lives_ok($q$
  update public.exercises set archived_at = now(), revision = 3
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$q$, 'Archiviazione consentita');
select is((select count(*) from public.exercises where archived_at is not null), 1::bigint, 'Esercizio archiviato resta disponibile');
select lives_ok($q$
  update public.exercises set archived_at = null, revision = 4
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
$q$, 'Esercizio archiviato ripristinabile');
select is((select count(*) from public.exercises where archived_at is null), 1::bigint, 'Ripristino conserva la riga');
select throws_ok($q$ delete from public.exercises $q$, '42501', null::text, 'Cancellazione fisica esercizi non esposta');
select throws_ok($q$ delete from public.user_settings $q$, '42501', null::text, 'Cancellazione fisica impostazioni non esposta');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
select is((select count(*) from public.exercises), 0::bigint, 'B non vede esercizi di A');
select is((select count(*) from public.user_settings), 0::bigint, 'B non vede impostazioni di A');
select throws_ok($q$
  insert into public.exercises(owner_id, name) values ('11111111-1111-4111-8111-111111111111', 'Proprietario falsificato')
$q$, '42501', null::text, 'B non inserisce esercizi di A');
select throws_ok($q$
  insert into public.user_settings(owner_id) values ('11111111-1111-4111-8111-111111111111')
$q$, '42501', null::text, 'B non inserisce impostazioni di A');
select results_eq($q$
  update public.exercises set name = 'Attacco', revision = 5
  where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' returning id
$q$, $q$ select null::uuid where false $q$, 'B non modifica esercizio conoscendone ID');
select results_eq($q$
  update public.user_settings set display_name = 'Attacco', revision = 3
  where owner_id = '11111111-1111-4111-8111-111111111111' returning owner_id
$q$, $q$ select null::uuid where false $q$, 'B non modifica impostazioni conoscendone ID');
select throws_ok($q$ delete from public.exercises where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' $q$, '42501', null::text, 'B non elimina esercizi di A');
select throws_ok($q$ delete from public.user_settings where owner_id = '11111111-1111-4111-8111-111111111111' $q$, '42501', null::text, 'B non elimina impostazioni di A');
select lives_ok($q$ insert into public.user_settings(display_name) values ('Persona B') $q$, 'B crea le proprie impostazioni');
select lives_ok($q$
  insert into public.exercises(id, name, load_convention, measurement_mode)
  values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Plank di prova', 'bodyweight', 'seconds')
$q$, 'B crea esercizio a tempo e corpo libero');
select is((select count(*) from public.exercises), 1::bigint, 'B vede soltanto il proprio esercizio');
select is((select count(*) from public.user_settings), 1::bigint, 'B vede soltanto le proprie impostazioni');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select is((select name from public.exercises), 'Rematore rinominato', 'Dati di A intatti dopo i tentativi di B');
select is((select display_name from public.user_settings), 'Persona A', 'Impostazioni di A intatte');
select set_config('request.jwt.claims', '{}', true);
select is((select count(*) from public.exercises), 0::bigint, 'Ruolo authenticated senza identita non vede esercizi');
select is((select count(*) from public.user_settings), 0::bigint, 'Ruolo authenticated senza identita non vede impostazioni');

reset role;
set local role anon;
select set_config('request.jwt.claims', '{}', true);
select throws_ok($q$ select * from public.exercises $q$, '42501', null::text, 'Anon non legge esercizi');
select throws_ok($q$ select * from public.user_settings $q$, '42501', null::text, 'Anon non legge impostazioni');
select throws_ok($q$ insert into public.exercises(name) values ('Anon') $q$, '42501', null::text, 'Anon non crea esercizi');
select throws_ok($q$ insert into public.user_settings default values $q$, '42501', null::text, 'Anon non crea impostazioni');
select throws_ok($q$ update public.exercises set name = 'Anon', revision = 4 $q$, '42501', null::text, 'Anon non modifica esercizi');
select throws_ok($q$ update public.user_settings set display_name = 'Anon', revision = 3 $q$, '42501', null::text, 'Anon non modifica impostazioni');
select throws_ok($q$ delete from public.exercises $q$, '42501', null::text, 'Anon non elimina esercizi');
select throws_ok($q$ delete from public.user_settings $q$, '42501', null::text, 'Anon non elimina impostazioni');

reset role;
select * from finish();
rollback;
