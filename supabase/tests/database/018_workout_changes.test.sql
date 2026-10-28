-- Solo fixture sintetiche locali; rollback finale. Identità SQL, RLS e transazioni reali.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();
insert into auth.users(id,aud,role,email) values
 ('11111111-1111-4111-8111-111111111111','authenticated','authenticated','changes-a@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','authenticated','authenticated','changes-b@example.invalid');
insert into public.exercises(id,owner_id,name,measurement_mode,muscle_group) values
 ('aaaaaaaa-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','Chest press','reps','Petto'),
 ('aaaaaaaa-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','Lat machine','reps','Schiena'),
 ('aaaaaaaa-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111','Spinta manubri','reps','Petto'),
 ('aaaaaaaa-0000-4000-8000-000000000004','11111111-1111-4111-8111-111111111111','Stairs Master','seconds','Cardio'),
 ('aaaaaaaa-0000-4000-8000-000000000005','11111111-1111-4111-8111-111111111111','Tapis roulant','seconds','Cardio');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal1"}',true);
select public.save_workout_draft('bbbbbbbb-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001',0,'Programma sintetico','',jsonb_build_array(
 jsonb_build_object('id','dddddddd-0000-4000-8000-000000000001','label','Lun','title','Lunedì','exercises',jsonb_build_array(
  jsonb_build_object('id','eeeeeeee-0000-4000-8000-000000000001','exercise_id','aaaaaaaa-0000-4000-8000-000000000001','sets',3,'optional_sets',1,'reps_min',8,'reps_max',12,'rest_seconds',90,'rir',2,'note','Nota chest'),
  jsonb_build_object('id','eeeeeeee-0000-4000-8000-000000000003','exercise_id','aaaaaaaa-0000-4000-8000-000000000004','sets',1,'duration_seconds',600))),
 jsonb_build_object('id','dddddddd-0000-4000-8000-000000000002','label','Mer','title','Mercoledì','exercises',jsonb_build_array(
  jsonb_build_object('id','eeeeeeee-0000-4000-8000-000000000002','exercise_id','aaaaaaaa-0000-4000-8000-000000000002','sets',5,'optional_sets',2,'reps_min',6,'reps_max',8,'rest_seconds',150,'rpe',8,'note','Nota lat'),
  jsonb_build_object('id','eeeeeeee-0000-4000-8000-000000000004','exercise_id','aaaaaaaa-0000-4000-8000-000000000005','sets',1,'duration_seconds',900)))
));
select public.publish_workout_version('cccccccc-0000-4000-8000-000000000001',1,1);
select public.start_workout_session('ffffffff-0000-4000-8000-000000000001','cccccccc-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000001',
  (now() at time zone 'Europe/Rome')::date - (extract(isodow from now() at time zone 'Europe/Rome')::int-1),'Europe/Rome');
reset role;
create temp table commands(name text primary key, doc jsonb);
grant select,update on commands to authenticated;
insert into commands select 'swap', jsonb_build_object('id','99999999-0000-4000-8000-000000000001','sessionId',s.id,'planId',s.plan_id,'versionId',s.version_id,
 'sourceDate',s.diary_date,'sourceDayId',s.day_id,'sourceId',s.day_snapshot->'exercises'->0->>'id','timeZone',s.time_zone,
 'createdAt',to_char(s.diary_date,'YYYY-MM-DD') || 'T08:00:00.000Z','before',s.day_snapshot->'exercises'->0,
 'after',peppitness_private.prescription_snapshot(s.owner_id,'eeeeeeee-0000-4000-8000-000000000002') || jsonb_build_object('id',s.day_snapshot->'exercises'->0->>'id'),
 'partner',jsonb_build_object('date',s.diary_date+2,'dayId','dddddddd-0000-4000-8000-000000000002','prescriptionId','eeeeeeee-0000-4000-8000-000000000002',
   'before',peppitness_private.prescription_snapshot(s.owner_id,'eeeeeeee-0000-4000-8000-000000000002'),
   'after',s.day_snapshot->'exercises'->0 || jsonb_build_object('id','eeeeeeee-0000-4000-8000-000000000002')),'cancelled',false)
 from public.workout_sessions s;
insert into commands select 'cardio', jsonb_build_object('id','99999999-0000-4000-8000-000000000002','sessionId',s.id,'planId',s.plan_id,'versionId',s.version_id,
 'sourceDate',s.diary_date,'sourceDayId',s.day_id,'sourceId',s.day_snapshot->'exercises'->1->>'id','timeZone',s.time_zone,
 'createdAt',to_char(s.diary_date,'YYYY-MM-DD') || 'T08:00:00.000Z','before',s.day_snapshot->'exercises'->1,
 'after',peppitness_private.prescription_snapshot(s.owner_id,'eeeeeeee-0000-4000-8000-000000000004') || jsonb_build_object('id',s.day_snapshot->'exercises'->1->>'id','duration_seconds',600),
 'partner',null,'cancelled',false) from public.workout_sessions s;
create function pg_temp.try_partial_source(p_command jsonb) returns public.workout_changes language plpgsql as $$ begin
  insert into public.workout_set_logs(session_id,prescription_id,set_index,load) values((p_command->>'sessionId')::uuid,(p_command->>'sourceId')::uuid,0,0);
  return public.apply_workout_change((p_command->>'id')::uuid,p_command,1);
end $$;
create function pg_temp.try_new_version(p_command jsonb) returns public.workout_changes language plpgsql security definer as $$ begin
  update public.workout_plans set active_version_id=null,revision=revision+1 where id=(p_command->>'planId')::uuid;
  return public.apply_workout_change((p_command->>'id')::uuid,p_command,1);
end $$;
create function pg_temp.try_completed_partner(p_command jsonb) returns public.workout_changes language plpgsql security definer as $$ begin
  insert into public.workout_sessions(id,owner_id,plan_id,version_id,day_id,diary_date,time_zone,day_snapshot,status,completed_at)
  select gen_random_uuid(),owner_id,plan_id,version_id,(p_command->'partner'->>'dayId')::uuid,(p_command->'partner'->>'date')::date,time_zone,
    jsonb_set(day_snapshot,'{exercises}',jsonb_build_array(p_command->'partner'->'before')),'completed',clock_timestamp() from public.workout_sessions where id=(p_command->>'sessionId')::uuid;
  return public.apply_workout_change((p_command->>'id')::uuid,p_command,1);
end $$;
-- Le note del nuovo esercizio sostituiscono quelle della prescrizione; qui entrambe vuote.
set local role authenticated;
select ok(not has_function_privilege('anon','public.apply_workout_change(uuid,jsonb,integer)','execute'),'anonimo escluso dalla RPC');
set local role anon;
select throws_ok($q$ select public.apply_workout_change(gen_random_uuid(),'{}',1) $q$,'42501',null::text,'chiamata RPC anonima negata realmente');
select throws_ok($q$ select public.undo_workout_change(gen_random_uuid(),gen_random_uuid()) $q$,'42501',null::text,'annullamento anonimo negato realmente');
set local role authenticated;
select ok(not has_any_column_privilege('authenticated','public.workout_changes','INSERT,UPDATE'),'nessuna mutazione diretta delle ricevute');
select throws_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000001',jsonb_set((select doc from commands where name='swap'),'{partner,date}',to_jsonb(((select doc->>'sourceDate' from commands where name='swap')::date-1)::text)),1) $q$,'22023',null::text,'partner passato respinto');
select throws_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000001',jsonb_set((select doc from commands where name='swap'),'{partner,date}',to_jsonb(((select doc->>'sourceDate' from commands where name='swap')::date+9)::text)),1) $q$,'22023',null::text,'altra settimana respinta');
select throws_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000001',(select doc from commands where name='swap'),2) $q$,'PT409',null::text,'revisione catalogo obsoleta respinta');
select throws_ok($q$ update public.workout_sessions set day_snapshot='{}',revision=revision+1 $q$,'42501',null::text,'snapshot non aggiornabile dal client');
select throws_ok($q$ select pg_temp.try_partial_source((select doc from commands where name='swap')) $q$,'PT409',null::text,'sorgente con zero parziale respinta');
select throws_ok($q$ select pg_temp.try_completed_partner((select doc from commands where name='swap')) $q$,'PT409',null::text,'partner completato respinto');
select throws_ok($q$ select pg_temp.try_new_version((select doc from commands where name='swap')) $q$,'PT409',null::text,'programma cambiato respinto');
select is((select count(*)::int from public.workout_changes),0,'rifiuti senza ricevute parziali');
reset role;
select throws_ok($q$ update public.workout_sessions set day_snapshot='{}',revision=revision+1 $q$,'23514',null::text,'trigger vieta snapshot arbitrario anche senza ACL');
create function pg_temp.fail_session_update() returns trigger language plpgsql as $$ begin raise exception using errcode='23514',message='synthetic snapshot failure'; end $$;
create trigger synthetic_session_failure before update on public.workout_sessions for each row execute function pg_temp.fail_session_update();
set local role authenticated;
select throws_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000001',(select doc from commands where name='swap'),1) $q$,'23514',null::text,'errore finale applicazione dopo ricevuta');
select is((select count(*)::int from public.workout_changes),0,'rollback ricevuta e destinazione se fallisce lo snapshot');
select is((select day_snapshot->'exercises'->0->>'name' from public.workout_sessions),'Chest press','rollback sorgente se fallisce lo snapshot');
reset role;
drop trigger synthetic_session_failure on public.workout_sessions;
set local role authenticated;
select lives_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000001',(select doc from commands where name='swap'),1) $q$,'scambio applicato');
select is((select day_snapshot->'exercises'->0->>'name' from public.workout_sessions),'Lat machine','card attiva nuova identità');
select is((select day_snapshot->'exercises'->0->>'sets' from public.workout_sessions),'5','dose del partner trasferita');
select is((select change_doc->'partner'->'after'->>'sets' from public.workout_changes),'3','destinazione conserva dose sorgente');
select is((select day_snapshot->'exercises'->0->>'optional_sets' from public.workout_sessions),'2','facoltative del partner trasferite');
select lives_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000001',(select doc from commands where name='swap'),1) $q$,'risposta persa: replay senza inversione');
select is((select count(*)::int from public.workout_changes),1,'ricevuta unica');
select throws_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000001',jsonb_set((select doc from commands where name='swap'),'{after,sets}','99'),1) $q$,'PT409',null::text,'stesso request con altro comando respinto');
select throws_ok($q$ insert into public.workout_set_logs(session_id,prescription_id,set_index,load,amount,exercise_id) values('ffffffff-0000-4000-8000-000000000001','eeeeeeee-0000-4000-8000-000000000001',0,20,8,'aaaaaaaa-0000-4000-8000-000000000001') $q$,'PT409',null::text,'client vecchio non associa chest alla lat');
select throws_ok($q$ insert into public.workout_set_logs(session_id,prescription_id,set_index,load,amount) values('ffffffff-0000-4000-8000-000000000001','eeeeeeee-0000-4000-8000-000000000001',0,20,8) $q$,'PT409',null::text,'identità omessa respinta su occorrenza modificata');
-- Atomicità dell'annullamento: errore finale sulla ricevuta deve annullare anche il ripristino della card.
reset role;
create function pg_temp.fail_change_update() returns trigger language plpgsql as $$ begin raise exception using errcode='23514',message='synthetic final failure'; end $$;
create trigger synthetic_change_failure before update on public.workout_changes for each row execute function pg_temp.fail_change_update();
set local role authenticated;
select throws_ok($q$ select public.undo_workout_change('99999999-0000-4000-8000-000000000009','99999999-0000-4000-8000-000000000001') $q$,'23514',null::text,'errore finale annullamento');
select is((select day_snapshot->'exercises'->0->>'name' from public.workout_sessions),'Lat machine','rollback completo card dopo errore finale');
select is((select change_doc->>'cancelled' from public.workout_changes),'false','rollback completo ricevuta');
reset role;
drop trigger synthetic_change_failure on public.workout_changes;
set local role authenticated;
select lives_ok($q$ select public.undo_workout_change('99999999-0000-4000-8000-000000000009','99999999-0000-4000-8000-000000000001') $q$,'annullamento atomico');
select lives_ok($q$ select public.undo_workout_change('99999999-0000-4000-8000-000000000009','99999999-0000-4000-8000-000000000001') $q$,'annullamento idempotente');
select is((select day_snapshot->'exercises'->0->>'name' from public.workout_sessions),'Chest press','sorgente ripristinata');
select is((select change_doc->>'cancelled' from public.workout_changes),'true','tombstone annullamento leggibile');
select throws_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000002',jsonb_set((select doc from commands where name='cardio'),'{partner}',jsonb_build_object('date','2026-10-30')),1) $q$,'22023',null::text,'cardio: partner respinto prima di cercare date o sedute');
reset role;
insert into public.workout_sessions(id,owner_id,plan_id,version_id,day_id,diary_date,time_zone,day_snapshot,status,completed_at)
 select 'ffffffff-0000-4000-8000-000000000099',owner_id,plan_id,version_id,'dddddddd-0000-4000-8000-000000000002',diary_date+2,time_zone,
   jsonb_set(day_snapshot,'{exercises}',jsonb_build_array(peppitness_private.prescription_snapshot(owner_id,'eeeeeeee-0000-4000-8000-000000000004'))),'completed',clock_timestamp()
 from public.workout_sessions where id='ffffffff-0000-4000-8000-000000000001';
set local role authenticated;
select lives_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000002',(select doc from commands where name='cardio'),1) $q$,'cardio sostituito solo oggi');
select is((select day_snapshot->'exercises'->0->>'duration_seconds' from public.workout_sessions where id='ffffffff-0000-4000-8000-000000000099'),'900','cardio futuro completato non impedisce sostituzione e resta intatto');
reset role;
delete from public.workout_sessions where id='ffffffff-0000-4000-8000-000000000099';
set local role authenticated;
select is((select day_snapshot->'exercises'->1->>'duration_seconds' from public.workout_sessions),'600','cardio oggi 10 minuti canonici');
select is((select duration_seconds::text from public.workout_prescriptions where id='eeeeeeee-0000-4000-8000-000000000004'),'900','cardio futuro 15 minuti invariati');
select lives_ok($q$ insert into public.workout_set_logs(session_id,prescription_id,exercise_id,change_id,set_index,amount) values('ffffffff-0000-4000-8000-000000000001','eeeeeeee-0000-4000-8000-000000000003','aaaaaaaa-0000-4000-8000-000000000005','99999999-0000-4000-8000-000000000002',0,0) $q$,'zero è un risultato valido');
select throws_ok($q$ select public.undo_workout_change(gen_random_uuid(),'99999999-0000-4000-8000-000000000002') $q$,'PT409',null::text,'annullamento dopo valore zero respinto senza cancellarlo');
select is((select amount::text from public.workout_set_logs),'0','risultato conservato');
-- Un altro esercizio già registrato non blocca la chest intatta.
update commands set doc=jsonb_set(doc,'{id}','"99999999-0000-4000-8000-000000000003"') where name='swap';
select lives_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000003',(select doc from commands where name='swap'),1) $q$,'altro esercizio con risultati non blocca la coppia');
select throws_ok($q$ insert into public.workout_set_logs(session_id,prescription_id,exercise_id,change_id,set_index,load) values('ffffffff-0000-4000-8000-000000000001','eeeeeeee-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000002','99999999-0000-4000-8000-000000000001',0,25) $q$,'PT409',null::text,'stessa identità dopo annulla/nuovo scambio: ricevuta obsoleta respinta');
select lives_ok($q$ insert into public.workout_set_logs(session_id,prescription_id,exercise_id,change_id,set_index,load) values('ffffffff-0000-4000-8000-000000000001','eeeeeeee-0000-4000-8000-000000000001','aaaaaaaa-0000-4000-8000-000000000002','99999999-0000-4000-8000-000000000003',0,25) $q$,'valore parziale sul nuovo esercizio');
select throws_ok($q$ select public.undo_workout_change(gen_random_uuid(),'99999999-0000-4000-8000-000000000003') $q$,'PT409',null::text,'valore parziale blocca annullamento');
-- MFA e account B: anche RPC definer e letture complete sono isolate.
reset role;
update peppitness_private.security_settings set mfa_required=true;
set local role authenticated;
select throws_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000003',(select doc from commands where name='swap'),1) $q$,'42501','MFA required','replay richiede MFA');
select throws_ok($q$ select public.undo_workout_change(gen_random_uuid(),'99999999-0000-4000-8000-000000000003') $q$,'42501','MFA required','annullamento richiede MFA');
select is((select count(*)::int from public.workout_changes),0,'MFA mancante nasconde variazioni');
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","aal":"aal2"}',true);
select is((select count(*)::int from public.workout_changes),0,'account B non legge variazioni A');
select throws_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000003',(select doc from commands where name='swap'),1) $q$,'42501',null::text,'account B non ripete richiesta A');
select throws_ok($q$ select public.undo_workout_change(gen_random_uuid(),'99999999-0000-4000-8000-000000000003') $q$,'42501',null::text,'account B non annulla A');
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","aal":"aal2"}',true);
-- Avvio reale destinazione: snapshot derivato dalla variazione, settimana successiva base.
update public.workout_sessions set status='completed',revision=revision+1;
select public.start_workout_session('ffffffff-0000-4000-8000-000000000002','cccccccc-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000002',(select (doc->'partner'->>'date')::date from commands where name='swap'),'Europe/Rome');
select is((select day_snapshot->'exercises'->0->>'name' from public.workout_sessions where status='active'),'Chest press','avvio futuro applica il lato destinazione');
select is((select day_snapshot->'exercises'->0->>'sets' from public.workout_sessions where status='active'),'3','avvio futuro conserva la dose sorgente');
select is((select day_snapshot->'exercises'->1->>'duration_seconds' from public.workout_sessions where status='active'),'900','avvio futuro cardio invariato');
update public.workout_sessions set status='completed',revision=revision+1 where status='active';
select public.start_workout_session('ffffffff-0000-4000-8000-000000000003','cccccccc-0000-4000-8000-000000000001','dddddddd-0000-4000-8000-000000000001',(select (doc->>'sourceDate')::date+7 from commands where name='swap'),'Europe/Rome');
select is((select day_snapshot->'exercises'->0->>'name' from public.workout_sessions where status='active'),'Chest press','settimana successiva normale');
select is((select day_snapshot->'exercises'->0->>'name' from public.workout_sessions where id='ffffffff-0000-4000-8000-000000000001'),'Lat machine','storico scambiato conservato');
select lives_ok($q$ select public.apply_workout_change('99999999-0000-4000-8000-000000000003',(select doc from commands where name='swap'),1) $q$,'replay dopo completamento restituisce ricevuta e non riscrive storico');
select * from finish();
rollback;
