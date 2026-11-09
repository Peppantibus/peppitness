-- Solo fixture sintetiche e rollback: proprietà, MFA, vincoli e nessuna mutazione del diario.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pg_catalog;
select no_plan();
insert into auth.users(id,aud,role,email) values
 ('20111111-1111-4111-8111-111111111111','authenticated','authenticated','calendar-a@example.invalid'),
 ('20222222-2222-4222-8222-222222222222','authenticated','authenticated','calendar-b@example.invalid');
insert into public.exercises(id,owner_id,name,measurement_mode) values
 ('20aaaaaa-0000-4000-8000-000000000001','20111111-1111-4111-8111-111111111111','Panca sintetica','reps');
create temp table dates as select (date_trunc('week',clock_timestamp() at time zone 'Europe/Rome')::date+7) mon;
grant select on dates to authenticated;
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"20111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal1"}',true);
select public.save_workout_draft('20bbbbbb-0000-4000-8000-000000000001','20cccccc-0000-4000-8000-000000000001',0,'Settimana test','',jsonb_build_array(
 jsonb_build_object('id','20dddddd-0000-4000-8000-000000000001','label','Lun','title','A','exercises',jsonb_build_array(
 jsonb_build_object('id','20eeeeee-0000-4000-8000-000000000001','exercise_id','20aaaaaa-0000-4000-8000-000000000001','sets',2,'reps_min',8,'reps_max',10,'rest_seconds',60))),
 jsonb_build_object('id','20dddddd-0000-4000-8000-000000000002','label','Mer','title','B','exercises',jsonb_build_array(
 jsonb_build_object('id','20eeeeee-0000-4000-8000-000000000002','exercise_id','20aaaaaa-0000-4000-8000-000000000001','sets',3,'reps_min',8,'reps_max',10,'rest_seconds',60)))));
select public.publish_workout_version('20cccccc-0000-4000-8000-000000000001',1,1);
update public.workout_plans set cycle_start=(select mon from dates),cycle_weeks=1,revision=3 where id='20bbbbbb-0000-4000-8000-000000000001';
reset role;
create temp table command(doc jsonb);
insert into command select jsonb_build_object('id','20888888-0000-4000-8000-000000000001','planId','20bbbbbb-0000-4000-8000-000000000001',
 'versionId','20cccccc-0000-4000-8000-000000000001','sourceDate',mon,'targetDate',mon+1,
 'sourceDayId','20dddddd-0000-4000-8000-000000000001','targetDayId',null,'timeZone','Europe/Rome','cancelled',false) from dates;
grant select on command to authenticated;
create function pg_temp.apply(doc jsonb) returns public.workout_day_swaps language sql as $$
 select public.apply_workout_day_swap((doc->>'id')::uuid,doc);
$$;
select ok(not has_table_privilege('authenticated','peppitness_private.day_swap_receipts','select,insert,update,delete'),'ricevute inaccessibili');
select ok(not has_function_privilege('authenticated','peppitness_private.start_workout_session_base(uuid,uuid,uuid,date,text)','execute'),'avvio privato inaccessibile');
select ok(not has_function_privilege('anon','public.apply_workout_day_swap(uuid,jsonb)','execute'),'RPC non eseguibile anonimamente');
set local role anon;
select throws_ok($q$ select public.apply_workout_day_swap(gen_random_uuid(),'{}') $q$,'42501',null::text,'anonimo realmente respinto');
set local role authenticated;
select throws_ok($q$ select pg_temp.apply((select doc||jsonb_build_object('id',gen_random_uuid(),'sourceDate',(select mon+7 from dates),'targetDate',(select mon+8 from dates)) from command)) $q$,'22023','Dates outside week or cycle','scambio fuori ciclo respinto');
select throws_ok($q$ select pg_temp.apply((select doc||jsonb_build_object('id',gen_random_uuid(),'targetDate',(clock_timestamp() at time zone 'Europe/Rome')::date-1) from command)) $q$,'22023','Destination precedes today or account time zone changed','destinazione passata respinta');
select lives_ok($q$ select pg_temp.apply((select doc from command)) $q$,'scambio allenamento riposo ammesso');
select throws_ok($q$ update public.workout_plans set cycle_start=(select mon+1 from dates),revision=4 where id='20bbbbbb-0000-4000-8000-000000000001' $q$,'PT409','Undo day swaps before changing cycle','periodo non può invalidare uno scambio attivo');
select is((select count(*)::int from public.workout_sessions where owner_id=auth.uid()),0,'nessuna sessione creata');
select is((select count(*)::int from public.workout_day_swaps),1,'una eccezione persistente');
select lives_ok($q$ select pg_temp.apply((select doc from command)) $q$,'retry identico ammesso');
select is((select count(*)::int from public.workout_day_swaps),1,'retry senza doppio scambio');
select throws_ok($q$ select pg_temp.apply((select doc||jsonb_build_object('targetDate',(select mon+2 from dates)) from command)) $q$,'PT409','Request id reused','riutilizzo ID con contenuto diverso respinto');
select throws_ok($q$ update public.workout_day_swaps set cancelled=true $q$,'42501',null::text,'update diretto respinto');
select throws_ok($q$ delete from public.workout_day_swaps $q$,'42501',null::text,'delete diretto respinto');
select throws_ok($q$ select pg_temp.apply((select doc||jsonb_build_object('id',gen_random_uuid()) from command)) $q$,'PT409','Overlapping day swap','sovrapposizione respinta');
select throws_ok($q$ select public.start_workout_session(gen_random_uuid(),'20cccccc-0000-4000-8000-000000000001','20dddddd-0000-4000-8000-000000000001',(select mon+1 from dates),'Europe/Rome',null,null) $q$,'PT409','Schedule changed before start','avvio obsoleto respinto');
select throws_ok($q$ select public.start_workout_session(gen_random_uuid(),'20cccccc-0000-4000-8000-000000000001','20dddddd-0000-4000-8000-000000000001',(select mon+1 from dates),'Europe/Rome') $q$,'PT409','Reload schedule before start','client precedente bloccato');
select set_config('request.jwt.claims','{"sub":"20222222-2222-4222-8222-222222222222","role":"authenticated","aal":"aal1"}',true);
select is((select count(*)::int from public.workout_day_swaps),0,'RLS altro account');
select throws_ok($q$ select public.undo_workout_day_swap(gen_random_uuid(),'20888888-0000-4000-8000-000000000001') $q$,'42501','Swap not available','annullamento di altro account respinto');
reset role;
insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
 values('20f00000-0000-4000-8000-000000000001','20111111-1111-4111-8111-111111111111','test','totp','verified',now(),now());
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"20111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal1"}',true);
select is((select count(*)::int from public.workout_day_swaps),0,'RLS nasconde con MFA mancante');
select throws_ok($q$ select pg_temp.apply((select doc from command)) $q$,'42501','MFA required','retry non aggira MFA');
select throws_ok($q$ select public.undo_workout_day_swap(gen_random_uuid(),'20888888-0000-4000-8000-000000000001') $q$,'42501','MFA required','undo richiede MFA');
select set_config('request.jwt.claims','{"sub":"20111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
select is((select count(*)::int from public.workout_day_swaps),1,'aal2 legge la propria eccezione');
select lives_ok($q$ select public.undo_workout_day_swap('20999999-0000-4000-8000-000000000001','20888888-0000-4000-8000-000000000001') $q$,'undo prima dell’avvio');
select lives_ok($q$ select public.undo_workout_day_swap('20999999-0000-4000-8000-000000000001','20888888-0000-4000-8000-000000000001') $q$,'retry undo con ricevuta');
select lives_ok($q$ select pg_temp.apply((select doc||jsonb_build_object('id','20888888-0000-4000-8000-000000000002','targetDate',(select mon+2 from dates),'targetDayId','20dddddd-0000-4000-8000-000000000002') from command)) $q$,'scambio A B ammesso');
select lives_ok($q$ select public.start_workout_session('20ffffff-0000-4000-8000-000000000001','20cccccc-0000-4000-8000-000000000001','20dddddd-0000-4000-8000-000000000002',(select mon from dates),'Europe/Rome','20dddddd-0000-4000-8000-000000000002','20888888-0000-4000-8000-000000000002') $q$,'avvio B lunedì');
select throws_ok($q$ select public.undo_workout_day_swap(gen_random_uuid(),'20888888-0000-4000-8000-000000000002') $q$,'PT409','Occurrence already started','sessione vuota blocca undo');
select is((select day_snapshot->>'label' from public.workout_sessions where id='20ffffff-0000-4000-8000-000000000001'),'Mer','snapshot conserva etichetta originale');
update public.workout_sessions set status='completed',revision=revision+1 where id='20ffffff-0000-4000-8000-000000000001';
select throws_ok($q$ select public.undo_workout_day_swap(gen_random_uuid(),'20888888-0000-4000-8000-000000000002') $q$,'PT409','Occurrence already started','completamento blocca undo');
reset role;
select is(peppitness_private.scheduled_workout_day('20111111-1111-4111-8111-111111111111','20cccccc-0000-4000-8000-000000000001',(select mon+7 from dates)), '20dddddd-0000-4000-8000-000000000001'::uuid,'settimana successiva normale');
select * from finish();
rollback;
