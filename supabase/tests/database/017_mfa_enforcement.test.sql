-- MFA aal2 nel livello dati (SA-03). Fixture inventate, rollback finale.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();

-- Struttura: nessuna tabella public con RLS senza vincolo MFA, nessuna RPC definer senza controllo.
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity
      and not exists (select 1 from pg_policy p where p.polrelid = c.oid and p.polname = 'mfa_aal2_required' and not p.polpermissive)),
  0, 'ogni tabella public con RLS ha la policy restrittiva MFA');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef and p.prokind = 'f' and p.proname <> 'is_mfa_satisfied'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and position('require_mfa' in pg_get_functiondef(p.oid)) = 0),
  0, 'ogni RPC definer eseguibile dal client richiama require_mfa');
select ok(has_function_privilege('authenticated', 'public.is_mfa_satisfied()', 'execute')
  and not has_function_privilege('anon', 'public.is_mfa_satisfied()', 'execute'), 'stato MFA leggibile solo da authenticated');
select ok(not has_function_privilege('authenticated', 'peppitness_private.require_mfa()', 'execute'), 'helper MFA non invocabile dal client');
select ok(not has_table_privilege('authenticated', 'peppitness_private.security_settings', 'select'), 'impostazione globale non leggibile dal client');

insert into auth.users(id, aud, role, email) values
  ('17111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'mfa-a@example.invalid'),
  ('17222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'mfa-b@example.invalid');
insert into public.user_settings(owner_id, display_name, workout_weekdays) values
  ('17111111-1111-4111-8111-111111111111', 'Persona A', array[1]::smallint[]),
  ('17222222-2222-4222-8222-222222222222', 'Persona B', array[2]::smallint[]);

-- B senza fattori e flag globale spento: comportamento invariato con sessione aal1.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"17222222-2222-4222-8222-222222222222","role":"authenticated","aal":"aal1"}', true);
select ok(public.is_mfa_satisfied(), 'senza fattori e flag spento: aal1 sufficiente');
select is((select count(*)::integer from public.user_settings), 1, 'B aal1 senza fattori legge i propri dati');
select lives_ok($q$ select public.delete_meal_plans('17aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $q$, 'RPC ammessa senza requisito MFA');
reset role;

-- A con fattore verificato.
insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at)
  values ('17f00000-0000-4000-8000-000000000001', '17111111-1111-4111-8111-111111111111', 'test', 'totp', 'verified', now(), now());

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"17111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal1"}', true);
select ok(not public.is_mfa_satisfied(), 'fattore verificato: aal1 non basta');
select is((select count(*)::integer from public.user_settings), 0, 'A aal1: lettura propri dati negata');
select throws_ok($q$ insert into public.exercises(id, name, variant, equipment, load_convention, per_side)
  values ('17eeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'x', '', '', 'total', false) $q$, '42501', null, 'A aal1: scrittura diretta negata');
select throws_ok($q$ select public.delete_meal_plans('17aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $q$, '42501', 'MFA required', 'A aal1: RPC definer negata');
select throws_ok($q$ select public.adopt_shared_exercise('17aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $q$, null, null, 'A aal1: RPC invoker negata');
select set_config('request.jwt.claims', '{"sub":"17111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}', true);
select ok(public.is_mfa_satisfied(), 'A aal2 soddisfa il requisito');
select is((select count(*)::integer from public.user_settings), 1, 'A aal2: legge solo i propri dati');
select lives_ok($q$ select public.delete_meal_plans('17aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $q$, 'A aal2: RPC ammessa');
-- aal2 di A non apre i dati di B.
select is((select count(*)::integer from public.user_settings where owner_id = '17222222-2222-4222-8222-222222222222'), 0, 'A aal2: nessun dato di B');
reset role;

-- Anonimo: mai soddisfatto.
set local role anon;
select throws_ok($q$ select public.is_mfa_satisfied() $q$, '42501', null, 'anon non può chiamare lo stato MFA');
reset role;

-- Flag globale: B senza fattori ora richiede aal2.
update peppitness_private.security_settings set mfa_required = true;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"17222222-2222-4222-8222-222222222222","role":"authenticated","aal":"aal1"}', true);
select ok(not public.is_mfa_satisfied(), 'flag globale: aal1 insufficiente anche senza fattori');
select is((select count(*)::integer from public.user_settings), 0, 'flag globale: B aal1 non legge');
select throws_ok($q$ select public.delete_meal_plans('17aaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') $q$, '42501', 'MFA required', 'flag globale: RPC negata');
select set_config('request.jwt.claims', '{"sub":"17222222-2222-4222-8222-222222222222","role":"authenticated","aal":"aal2"}', true);
select is((select count(*)::integer from public.user_settings), 1, 'flag globale: B aal2 legge i propri dati');
reset role;

select * from finish();
rollback;
