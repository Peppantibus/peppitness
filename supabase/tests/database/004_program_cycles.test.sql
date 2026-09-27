-- Ciclo del programma: inizio e durata con revisione, solo proprietario. Solo locale, rollback finale.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();

insert into auth.users(id, aud, role, email) values
  ('31111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'cycle-a@example.invalid'),
  ('32222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'cycle-b@example.invalid');
insert into public.workout_plans(id, owner_id, name) values ('3bbbbbbb-0000-4000-8000-000000000001', '31111111-1111-4111-8111-111111111111', 'Ciclo di prova');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"31111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select is((select cycle_start from public.workout_plans), null::date, 'Programmi esistenti senza ciclo');
select lives_ok($q$ update public.workout_plans set cycle_start = '2026-09-28', cycle_weeks = 8, revision = 2 $q$, 'Inizio e durata salvati');
select is((select cycle_weeks from public.workout_plans), 8::smallint, 'Durata letta');
select throws_ok($q$ update public.workout_plans set cycle_weeks = 6, revision = 2 $q$, 'PT409', 'Revision conflict', 'Revisione obsoleta respinta');
select throws_ok($q$ update public.workout_plans set cycle_weeks = null, revision = 3 $q$, '23514', null::text, 'Inizio senza durata respinto');
select throws_ok($q$ update public.workout_plans set cycle_weeks = 60, revision = 3 $q$, '23514', null::text, 'Durata oltre 52 settimane respinta');
select lives_ok($q$ update public.workout_plans set cycle_start = null, cycle_weeks = null, revision = 3 $q$, 'Ciclo rimosso');

select set_config('request.jwt.claims', '{"sub":"32222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
update public.workout_plans set cycle_start = '2026-01-05', cycle_weeks = 4, revision = 4;
reset role;
select is((select cycle_start from public.workout_plans where id = '3bbbbbbb-0000-4000-8000-000000000001'), null::date, 'B non modifica il ciclo di A');

select * from finish();
rollback;
