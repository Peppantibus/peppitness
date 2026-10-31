-- Solo dati sintetici, rollback finale; RPC, ACL, MFA e atomicità effettivi.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();
insert into auth.users(id,aud,role,email) values
 ('19111111-1111-4111-8111-111111111111','authenticated','authenticated','session-a@example.invalid'),
 ('19222222-2222-4222-8222-222222222222','authenticated','authenticated','session-b@example.invalid');
insert into public.exercises(id,owner_id,name,measurement_mode,muscle_group) values
 ('19aaaaaa-0000-4000-8000-000000000001','19111111-1111-4111-8111-111111111111','Curl sintetico','reps','Bicipiti');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"19111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal1"}',true);
select public.save_workout_draft('19bbbbbb-0000-4000-8000-000000000001','19cccccc-0000-4000-8000-000000000001',0,'Programma sintetico','',jsonb_build_array(
 jsonb_build_object('id','19dddddd-0000-4000-8000-000000000001','label','A','title','Seduta','exercises',jsonb_build_array(
  jsonb_build_object('id','19eeeeee-0000-4000-8000-000000000001','exercise_id','19aaaaaa-0000-4000-8000-000000000001',
   'sets',2,'reps_min',8,'reps_max',10,'rest_seconds',60)))));
select public.publish_workout_version('19cccccc-0000-4000-8000-000000000001',1,1);
select public.start_workout_session('19ffffff-0000-4000-8000-000000000001','19cccccc-0000-4000-8000-000000000001',
 '19dddddd-0000-4000-8000-000000000001',current_date,'Europe/Rome');
reset role;
create temp table command(doc jsonb);
insert into command select jsonb_build_object('action','add','allowDuplicate',true,'position',jsonb_build_object('kind','end'),
 'exercise',day_snapshot->'exercises'->0 || jsonb_build_object('id','19999999-0000-4000-8000-000000000001','session_added',true)) from public.workout_sessions
 where id='19ffffff-0000-4000-8000-000000000001';
grant select on command to authenticated;
create function pg_temp.edit(request uuid, edit jsonb) returns public.workout_sessions language sql as $$
 select public.edit_workout_session_exercises(request,'19ffffff-0000-4000-8000-000000000001',edit,
   (select jsonb_agg(e->'id' order by n) from public.workout_sessions s,
     jsonb_array_elements(s.day_snapshot->'exercises') with ordinality a(e,n) where s.id='19ffffff-0000-4000-8000-000000000001'));
$$;
select ok(not has_table_privilege('authenticated','peppitness_private.session_exercise_receipts','SELECT,INSERT,UPDATE,DELETE'),'ricevute private senza privilegi client');
select ok(not has_function_privilege('anon','public.edit_workout_session_exercises(uuid,uuid,jsonb,jsonb,jsonb)','execute'),'RPC non eseguibile anonimamente');
set local role anon;
select throws_ok($q$ select public.edit_workout_session_exercises(gen_random_uuid(),gen_random_uuid(),'{}','[]') $q$,'42501',null::text,'chiamata anonima realmente negata');
set local role authenticated;
select lives_ok($q$ select pg_temp.edit('19888888-0000-4000-8000-000000000001',(select doc from command)) $q$,'aggiunta ammessa per proprietario con aal1 senza fattori');
select is((select jsonb_array_length(day_snapshot->'exercises') from public.workout_sessions),2,'snapshot contiene nuova occorrenza');
select throws_ok($q$ select public.edit_workout_session_exercises(gen_random_uuid(),'19ffffff-0000-4000-8000-000000000001',
 (select doc from command),'[]') $q$,'PT409','Session order changed','ordine obsoleto respinto');
select throws_ok($q$ select pg_temp.edit(gen_random_uuid(),jsonb_set((select doc from command),'{exercise,id}','"19999999-0000-4000-8000-000000000002"')
 || '{"allowDuplicate":false}') $q$,'PT409','Explicit duplicate choice required','duplicato senza consenso respinto');
select throws_ok($q$ select pg_temp.edit(gen_random_uuid(),'{"action":"move","id":"19999999-0000-4000-8000-000000000001","position":{"kind":"after","id":"19999999-0000-4000-8000-000000000001"}}') $q$,'PT409','Position not available','autoreferenza respinta');
select throws_ok($q$ select pg_temp.edit(gen_random_uuid(),'{"action":"remove","id":"19eeeeee-0000-4000-8000-000000000001","confirmed":true}') $q$,'23514',null::text,'prescrizioni originali protette');
insert into public.workout_set_logs(session_id,prescription_id,exercise_id,set_index,load,amount,completed)
 values('19ffffff-0000-4000-8000-000000000001','19999999-0000-4000-8000-000000000001','19aaaaaa-0000-4000-8000-000000000001',0,20,8,true);
select lives_ok($q$ select pg_temp.edit(gen_random_uuid(),'{"action":"move","id":"19999999-0000-4000-8000-000000000001","position":{"kind":"start"}}') $q$,'spostamento con risultati ammesso');
select is((select load::int from public.workout_set_logs),20,'carico intatto dopo spostamento');
select is((select day_snapshot->'exercises'->0->>'id' from public.workout_sessions),'19999999-0000-4000-8000-000000000001','ordine persistito');
select throws_ok($q$ select pg_temp.edit(gen_random_uuid(),'{"action":"remove","id":"19999999-0000-4000-8000-000000000001","confirmed":true}') $q$,'PT409','Exercise results changed','risultati non conosciuti impediscono rimozione');
select set_config('request.jwt.claims','{"sub":"19222222-2222-4222-8222-222222222222","role":"authenticated","aal":"aal1"}',true);
select throws_ok($q$ select public.edit_workout_session_exercises(gen_random_uuid(),'19ffffff-0000-4000-8000-000000000001','{"action":"remove"}','[]') $q$,'42501','Session not available','altro account escluso');
reset role;
insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
 values('19f00000-0000-4000-8000-000000000001','19111111-1111-4111-8111-111111111111','test','totp','verified',now(),now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"19111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal1"}',true);
select throws_ok($q$ select public.edit_workout_session_exercises(gen_random_uuid(),'19ffffff-0000-4000-8000-000000000001','{"action":"remove"}','[]') $q$,'42501','MFA required','MFA aal1 non basta con fattore verificato');
select set_config('request.jwt.claims','{"sub":"19111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
select lives_ok($q$ select pg_temp.edit(gen_random_uuid(),'{"action":"move","id":"19999999-0000-4000-8000-000000000001","position":{"kind":"end"}}') $q$,'MFA aal2 permette spostamento al proprietario');
reset role;
create function pg_temp.fail_edit() returns trigger language plpgsql as $$ begin raise exception using errcode='23514',message='synthetic failure'; end $$;
create trigger synthetic_failure before update on public.workout_sessions for each row execute function pg_temp.fail_edit();
set local role authenticated;
select throws_ok($q$ select public.edit_workout_session_exercises('19888888-0000-4000-8000-000000000009','19ffffff-0000-4000-8000-000000000001',
 '{"action":"remove","id":"19999999-0000-4000-8000-000000000001","confirmed":true}',
 '["19eeeeee-0000-4000-8000-000000000001","19999999-0000-4000-8000-000000000001"]','{"0":1}') $q$,'23514','synthetic failure','errore dopo cancellazione serie fa rollback');
select is((select count(*)::int from public.workout_set_logs),1,'serie conservata dopo rollback');
reset role;
select is((select count(*)::int from peppitness_private.session_exercise_receipts where id='19888888-0000-4000-8000-000000000009'),0,'nessuna ricevuta parziale');
select is((select count(*)::int from peppitness_private.session_change_permits),0,'nessun permesso residuo');
drop trigger synthetic_failure on public.workout_sessions;
set local role authenticated;
select lives_ok($q$ update public.workout_sessions set status='completed',revision=revision+1 $q$,'conclusione seduta con esercizio aggiunto');
select throws_ok($q$ select pg_temp.edit(gen_random_uuid(),'{"action":"move","id":"19999999-0000-4000-8000-000000000001","position":{"kind":"start"}}') $q$,'PT409','Session completed','storico protetto dalle mutazioni');
reset role;
select * from finish();
rollback;
