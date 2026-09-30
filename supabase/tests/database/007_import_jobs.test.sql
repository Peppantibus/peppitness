-- Solo fixture sintetiche; nessun provider. Le identità SQL non sostituiscono HTTP/Auth.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();
\ir import_jobs_fixture.inc
create temporary table import_test_state(name text primary key, value jsonb);
grant select, insert, update on import_test_state to service_role;
grant select on import_test_state to authenticated;
create function pg_temp.s(label text, path text) returns text language sql as $$
  select value #>> string_to_array(path, '.') from pg_temp.import_test_state where name = label;
$$;
create function pg_temp.input(owner_id uuid, request_id uuid, kind text default 'workout', digest text default repeat('a',64), model text default 'synthetic')
returns jsonb language sql as $$
  select public.create_import_job(owner_id, request_id, kind, digest, repeat('b',64),
    jsonb_build_object('reader','synthetic-fixture/1','schema','1.0','prompt','test/1','provider','synthetic','model',model,'rules','test/1'), document)
  from pg_temp.import_fixture;
$$;
create function pg_temp.complete_job(label text, draft_revision integer default 1) returns jsonb language sql as $$
  select public.complete_import_job('11111111-1111-4111-8111-111111111111', pg_temp.s(label,'job.jobId')::uuid,
    pg_temp.s(label,'revision')::integer, pg_temp.s(label,'leaseToken')::uuid, draft_revision,
    jsonb_build_object('extraction', extraction, 'validationIssues','[]'::jsonb,
      'usageSummary', jsonb_build_object('providerCalls',pg_temp.s(label,'attemptCount')::integer,
        'inputTokens',null,'outputTokens',null,'reasoningTokens',null,'cached',false,'costEstimate',null)))
  from pg_temp.import_fixture;
$$;

select ok((select relrowsecurity from pg_class where oid = 'public.import_jobs'::regclass), 'jobs RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.import_drafts'::regclass), 'drafts RLS');
select ok(not has_schema_privilege('authenticated','peppitness_private','usage'), 'schema privato chiuso');
select ok(not has_schema_privilege('service_role','peppitness_private','usage'), 'server senza grant ampio schema privato');
select ok(not has_table_privilege('service_role','public.import_jobs','insert'), 'server solo API ristrette');
select ok(not has_column_privilege('authenticated','public.import_jobs','lease_token','select'), 'lease non esposta');
select ok(not has_function_privilege('service_role','peppitness_private.record_import_attempt(uuid,uuid,integer,uuid)','execute'), 'tentativi non esposti prima del ledger');
select ok(not has_function_privilege('anon','public.get_import_job(uuid)','execute'), 'get non anonimo');
select ok(not has_function_privilege('authenticated','public.create_import_job(uuid,uuid,text,text,text,jsonb,jsonb)','execute'), 'create solo server');
select ok(not has_function_privilege('authenticated','public.complete_import_job(uuid,uuid,integer,uuid,integer,jsonb)','execute'), 'complete solo server');

insert into auth.users(id,aud,role,email) values
 ('11111111-1111-4111-8111-111111111111','authenticated','authenticated','jobs-a@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','authenticated','authenticated','jobs-b@example.invalid');

set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into import_test_state values ('a',pg_temp.input('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
select is(pg_temp.s('a','job.status'),'running','nuovo job running');
select is(pg_temp.s('a','attemptCount'),'0','create non è una chiamata provider');
select is(pg_temp.s('a','revision'),'1','revisione iniziale');
select is(pg_temp.s('a','draftRevision'),'1','revisione bozza iniziale');
select is((pg_temp.input('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->'job'->>'jobId'),pg_temp.s('a','job.jobId'),'replay stesso job');
select is((pg_temp.input('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','workout',repeat('a',64),'next')->'job'->>'jobId'),pg_temp.s('a','job.jobId'),'cambio profilo non rompe replay');
select throws_ok($q$select pg_temp.input('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','workout',repeat('c',64))$q$,'PT409','Import request conflict','payload cambiato confligge');
select throws_ok($q$select pg_temp.input('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','diet')$q$,'PT409','Import request conflict','stessa chiave altro dominio confligge');
insert into import_test_state values ('b',pg_temp.input('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
select isnt(pg_temp.s('a','job.jobId'),pg_temp.s('b','job.jobId'),'stessa chiave in B indipendente');
select throws_ok($q$select public.touch_import_job('22222222-2222-4222-8222-222222222222',pg_temp.s('a','job.jobId')::uuid,1)$q$,'42501','Import job not available','server non confonde owner');
select throws_ok($q$update public.import_jobs set status='ready'$q$,'42501',null::text,'server non muta direttamente');

reset role;
-- Chiamata simulata SOLO sotto postgres di test; nessun trasporto provider.
update import_test_state set value = peppitness_private.import_server_result(peppitness_private.record_import_attempt(
 '11111111-1111-4111-8111-111111111111', pg_temp.s('a','job.jobId')::uuid,1,pg_temp.s('a','leaseToken')::uuid)) where name='a';
select is(pg_temp.s('a','attemptCount'),'1','tentativo codificato');
select is(pg_temp.s('a','providerOutcome'),'in_flight','invio distinto da creazione');
select throws_ok($q$select peppitness_private.record_import_attempt('11111111-1111-4111-8111-111111111111',pg_temp.s('a','job.jobId')::uuid,2,pg_temp.s('a','leaseToken')::uuid)$q$,
 'PT409','Import lease conflict','nessuna seconda chiamata implicita');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}',true);
select is((select count(id) from public.import_jobs),1::bigint,'A vede solo il proprio job');
select is((select count(*) from public.import_drafts),1::bigint,'A vede solo il proprio documento');
select is(public.get_import_job(pg_temp.s('a','job.jobId')::uuid)->>'status','running','protocollo lettura running');
select is(public.get_import_job(pg_temp.s('b','job.jobId')::uuid),null::jsonb,'lookup B non rivela esistenza');
select throws_ok($q$insert into public.import_jobs(owner_id) values ('22222222-2222-4222-8222-222222222222')$q$,'42501',null::text,'owner falsificato respinto');
select throws_ok($q$update public.import_jobs set status='ready',lease_token=gen_random_uuid(),revision=3$q$,'42501',null::text,'stato/lease non scrivibili');
select throws_ok($q$update public.import_drafts set extraction='{}',revision=2$q$,'42501',null::text,'proposta non scrivibile');
select throws_ok($q$delete from public.import_drafts$q$,'42501',null::text,'nessuna cancellazione diretta');
select throws_ok($q$select public.find_import_job('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')$q$,'42501',null::text,'lookup server non esposto');
select throws_ok($q$select pg_temp.complete_job('a')$q$,'42501',null::text,'complete non esposto');
select set_config('request.jwt.claims','{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}',true);
select is((select count(*) from public.import_drafts where job_id=pg_temp.s('a','job.jobId')::uuid),0::bigint,'B non legge documento A');
select is(public.get_import_job(pg_temp.s('a','job.jobId')::uuid),null::jsonb,'B non recupera risultato A');
select set_config('request.jwt.claims','{}',true);
select throws_ok($q$select public.get_import_job(pg_temp.s('a','job.jobId')::uuid)$q$,'42501','Authentication required','authenticated senza identità respinto');
reset role;
set local role anon;
select throws_ok($q$select id from public.import_jobs$q$,'42501',null::text,'anon niente jobs');
select throws_ok($q$select * from public.import_drafts$q$,'42501',null::text,'anon niente documenti');
select throws_ok($q$select public.get_import_job(gen_random_uuid())$q$,'42501',null::text,'anon niente RPC');
reset role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select throws_ok($q$update public.import_drafts set revision=1 where job_id=pg_temp.s('a','job.jobId')::uuid$q$,
 'PT409','Revision conflict','revisione bozza obsoleta');
select throws_ok($q$update public.import_drafts set owner_id='22222222-2222-4222-8222-222222222222',revision=2 where job_id=pg_temp.s('a','job.jobId')::uuid$q$,
 '23514','Import content is immutable','identità bozza immutabile');
select throws_ok($q$insert into public.import_drafts(job_id,owner_id,normalized_document,schema_version,expires_at)
 values(gen_random_uuid(),'22222222-2222-4222-8222-222222222222','{}','1.0',now())$q$,'23503',null::text,'FK composita owner/job');
select throws_ok($q$update public.import_jobs set status='ready',provider_outcome='completed',revision=3 where id=pg_temp.s('a','job.jobId')::uuid;
 set constraints all immediate$q$,'23514','Import result and state must be atomic','ready senza risultato impossibile');

set local role service_role;
select throws_ok($q$select pg_temp.complete_job('a',99)$q$,'PT409','Import draft revision conflict','complete bozza obsoleta annullato');
select is(public.find_import_job('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->'job'->>'status','running','rollback conserva running');
update import_test_state set value=public.fail_import_job('11111111-1111-4111-8111-111111111111',pg_temp.s('a','job.jobId')::uuid,
 pg_temp.s('a','revision')::integer,pg_temp.s('a','leaseToken')::uuid,'provider_outcome_uncertain') where name='a';
select is(pg_temp.s('a','job.status'),'failed','fallimento persistito');
select is(pg_temp.s('a','providerOutcome'),'uncertain','incerto codificato separatamente');
select is(pg_temp.s('a','job.usageSummary.inputTokens'),null::text,'usage ignoto resta null');
select is(pg_temp.s('a','job.error.retryable'),'false','nessun retry automatico');
select is(pg_temp.s('a','attemptCount'),'1','fallimento non cancella tentativo');
select throws_ok($q$select public.complete_import_job('11111111-1111-4111-8111-111111111111',pg_temp.s('a','job.jobId')::uuid,
  pg_temp.s('a','revision')::integer,gen_random_uuid(),1,'{}')$q$,'PT409','Import lease conflict','lease diversa respinta');
reset role;
-- Lease superata, contenuti non scaduti: la stessa risposta tardiva è ancora utile.
update public.import_jobs set lease_expires_at=now()-interval '1 minute', revision=revision+1 where id=pg_temp.s('a','job.jobId')::uuid;
update import_test_state set value=public.find_import_job('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where name='a';
set local role service_role;
update import_test_state set value=pg_temp.complete_job('a') where name='a';
select is(pg_temp.s('a','job.status'),'ready','risultato tardivo atomico');
select is(pg_temp.s('a','draftRevision'),'2','proposta scritta una volta');
select is(pg_temp.s('a','job.extraction.kind'),'workout','proposta recuperabile');
select is(pg_temp.s('a','job.error'),null::text,'ready senza vecchio errore');
select throws_ok($q$select pg_temp.complete_job('a',2)$q$,'PT409','Import lease conflict','ready non riscrivibile');
insert into import_test_state values ('cache',pg_temp.input('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
select is(pg_temp.s('cache','job.status'),'ready','cache stesso owner/input/profilo');
select is(pg_temp.s('cache','job.usageSummary.cached'),'true','cache esplicita');
select is(pg_temp.s('cache','attemptCount'),'0','cache nessuna chiamata');
insert into import_test_state values ('model',pg_temp.input('11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','workout',repeat('a',64),'next'));
select is(pg_temp.s('model','job.status'),'running','modello diverso niente cache');
insert into import_test_state values ('diet',pg_temp.input('11111111-1111-4111-8111-111111111111','dddddddd-dddd-4ddd-8ddd-dddddddddddd','diet'));
select is(pg_temp.s('diet','job.status'),'running','stessa fonte altro dominio niente cache');
select is(pg_temp.s('b','job.status'),'running','cache non condivisa con B');
reset role;
update public.import_jobs set lease_expires_at=now()-interval '1 minute',revision=revision+1 where id=pg_temp.s('model','job.jobId')::uuid;
select throws_ok($q$select peppitness_private.record_import_attempt('11111111-1111-4111-8111-111111111111',pg_temp.s('model','job.jobId')::uuid,2,pg_temp.s('model','leaseToken')::uuid)$q$,
 'PT409','Import lease conflict','lease scaduta non avvia nuova chiamata');
set local role service_role;
select is(pg_temp.input('11111111-1111-4111-8111-111111111111','cccccccc-cccc-4ccc-8ccc-cccccccccccc','workout',repeat('a',64),'next')->>'leaseToken',
 pg_temp.s('model','leaseToken'),'replay non riacquisisce lease scaduta');
update import_test_state set value=public.fail_import_job('11111111-1111-4111-8111-111111111111',pg_temp.s('diet','job.jobId')::uuid,
 pg_temp.s('diet','revision')::integer,pg_temp.s('diet','leaseToken')::uuid,'provider_refused') where name='diet';
select is(pg_temp.s('diet','providerOutcome'),'known_failure','fallimento noto distinto da incerto');
select is(pg_temp.s('diet','leaseToken'),null::text,'fallimento noto chiude lease');
select throws_ok($q$select public.fail_import_job('11111111-1111-4111-8111-111111111111',pg_temp.s('model','job.jobId')::uuid,
 2,pg_temp.s('model','leaseToken')::uuid,'raw_document')$q$,'22023','Invalid analysis failure','messaggi non codificati respinti');
select throws_ok($q$select public.touch_import_job('11111111-1111-4111-8111-111111111111',pg_temp.s('a','job.jobId')::uuid,1)$q$,'PT409','Import revision conflict','touch obsoleto');
update import_test_state set value=public.touch_import_job('11111111-1111-4111-8111-111111111111',pg_temp.s('a','job.jobId')::uuid,pg_temp.s('a','revision')::integer) where name='a';
select is(pg_temp.s('a','draftRevision'),'3','touch versionato senza edit manuali');
select throws_ok($q$select public.expire_import_job('11111111-1111-4111-8111-111111111111',pg_temp.s('a','job.jobId')::uuid,pg_temp.s('a','revision')::integer)$q$,'PT409','Import content not expired','expiry anticipata respinta');
reset role;
select throws_ok($q$update public.import_drafts set extraction='{}',revision=4 where job_id=pg_temp.s('a','job.jobId')::uuid$q$,'23514','Import content is immutable','estrazione finale immutabile anche server');
-- Simulazione orologio, solo postgres di test. Tutti i risultati cache scadono.
update public.import_jobs set expires_at=now()-interval '1 second',revision=revision+1 where owner_id='11111111-1111-4111-8111-111111111111';
update public.import_drafts set expires_at=now()-interval '1 second',revision=revision+1 where owner_id='11111111-1111-4111-8111-111111111111';
update import_test_state set value=public.find_import_job('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where name='a';
select is(pg_temp.s('a','job.status'),'expired','lookup scaduto senza proposta');
select is(pg_temp.s('a','job.extraction'),null::text,'risultato scaduto oscurato anche prima cleanup');
select throws_ok($q$select public.complete_import_job('11111111-1111-4111-8111-111111111111',pg_temp.s('model','job.jobId')::uuid,
 3,pg_temp.s('model','leaseToken')::uuid,2,'{}')$q$,'PT409','Import lease conflict','completamento dopo TTL respinto');
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"11111111-1111-4111-8111-111111111111"}',true);
select is((select count(*) from public.import_drafts),0::bigint,'RLS nasconde draft scaduti');
select is(public.get_import_job(pg_temp.s('a','job.jobId')::uuid)->>'status','expired','RPC restituisce expired');
reset role;
set local role service_role;
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select throws_ok($q$select public.touch_import_job('11111111-1111-4111-8111-111111111111',pg_temp.s('a','job.jobId')::uuid,pg_temp.s('a','revision')::integer)$q$,'PT409','Import content expired','nessuna resurrezione con touch');
update import_test_state set value=public.expire_import_job('11111111-1111-4111-8111-111111111111',pg_temp.s('a','job.jobId')::uuid,pg_temp.s('a','revision')::integer) where name='a';
select is(pg_temp.s('a','draftRevision'),null::text,'expire elimina contenuto effettivamente');
select is(pg_temp.s('a','attemptCount'),'1','expire conserva tentativi');
select is(pg_temp.input('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')->'job'->>'status','expired','vecchio replay resta expired');
insert into import_test_state values ('fresh',pg_temp.input('11111111-1111-4111-8111-111111111111','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
select is(pg_temp.s('fresh','job.status'),'running','cache scaduta ignorata');
reset role;
select is((select count(*) from public.workout_plans where owner_id in ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')),0::bigint,'nessun programma definitivo');
select is((select count(*) from public.meal_plans where owner_id in ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')),0::bigint,'nessuna dieta definitiva');
select is((select count(*) from public.exercises where owner_id in ('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')),0::bigint,'nessun esercizio creato');
set constraints all immediate;
delete from auth.users where id='11111111-1111-4111-8111-111111111111';
select is((select count(*) from public.import_jobs where owner_id='11111111-1111-4111-8111-111111111111'),0::bigint,'account cascade jobs');
select is((select count(*) from public.import_drafts where owner_id='11111111-1111-4111-8111-111111111111'),0::bigint,'account cascade contenuti');
select is((select count(*) from public.import_jobs where owner_id='22222222-2222-4222-8222-222222222222'),1::bigint,'delete A conserva B');
select * from finish();
rollback;
