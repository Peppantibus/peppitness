-- Budget solo sintetico, in transazione: rollback anche della configurazione.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pg_catalog;
select no_plan();
\ir import_jobs_fixture.inc
create temporary table budget_test_state(label text primary key,value jsonb);
grant all on budget_test_state to service_role;
create function pg_temp.b(label text,path text) returns text language sql as $$
 select value#>>string_to_array(path,'.') from pg_temp.budget_test_state where label=$1;
$$;
create function pg_temp.job(owner_id uuid,request_id uuid,model text default 'synthetic') returns jsonb language sql as $$
 select public.create_import_job(owner_id,request_id,'workout',repeat('a',64),repeat('b',64),
 jsonb_build_object('reader','synthetic-fixture/1','schema','1.0','prompt','test/1','provider','synthetic','model',model,'rules','test/1'),document)
 from pg_temp.import_fixture;
$$;
create function pg_temp.reserve(label text,reservation_id uuid,bytes integer default 10,output_tokens integer default 10,retry boolean default false)
returns jsonb language sql as $$
 select public.reserve_import_budget((select owner_id from public.import_jobs where id=pg_temp.b(label,'job.jobId')::uuid),
 pg_temp.b(label,'job.jobId')::uuid,reservation_id,pg_temp.b(label,'revision')::integer,repeat('c',64),bytes,output_tokens,retry);
$$;
-- Questo helper di test gira solo da postgres: le API reali non leggono le tabelle.

select is(peppitness_private.import_cost(1,1,1,1),2::bigint,'ceil input/output conservativo');
select is(peppitness_private.import_cost(100,200,1000000,2000000),500::bigint,'vettore costo condiviso TS');
select is(peppitness_private.import_cost(0,0,1,1),0::bigint,'zero noto esplicito');
select throws_ok($q$select peppitness_private.import_cost(null,0,1,1)$q$,'22023','Invalid import cost','ignoto non zero');
select throws_ok($q$select peppitness_private.import_cost(9007199254740991,1,9007199254740991,1)$q$,'22023','Import cost overflow','overflow respinto');
select ok((select not enabled and project_limit_micros is null from peppitness_private.import_budget_config),'nessun budget implicito');
select throws_ok($q$update peppitness_private.import_budget_config set enabled=true$q$,'23514',null::text,'config incompleta non attivabile');
select ok(not has_table_privilege('authenticated','peppitness_private.import_usage_ledger','select,insert,update,delete'),'ledger invisibile al browser');
select ok(not has_table_privilege('service_role','peppitness_private.import_budget_config','select,update'),'config non mutabile via client server');
select ok(not has_function_privilege('authenticated','public.dispatch_import_attempt(uuid,uuid)','execute'),'dispatch non esposto browser');
select ok(not has_function_privilege('anon','public.reserve_import_budget(uuid,uuid,uuid,integer,text,integer,integer,boolean)','execute'),'anon non prenota');
select ok(not has_function_privilege('service_role','peppitness_private.record_import_attempt(uuid,uuid,integer,uuid)','execute'),'nessun bypass ledger');
insert into auth.users(id,aud,role,email) values
 ('11111111-1111-4111-8111-111111111111','authenticated','authenticated','budget-a@example.invalid'),
 ('22222222-2222-4222-8222-222222222222','authenticated','authenticated','budget-b@example.invalid');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
insert into budget_test_state values
 ('a',pg_temp.job('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
 ('a2',pg_temp.job('11111111-1111-4111-8111-111111111111','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')),
 ('b',pg_temp.job('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')),
 ('profile',pg_temp.job('22222222-2222-4222-8222-222222222222','cccccccc-cccc-4ccc-8ccc-cccccccccccc','next'));
select throws_ok($q$select pg_temp.reserve('a','aaaaaaaa-0000-4000-8000-000000000001')$q$,'PT503','Import analysis disabled','default disabilitato');
delete from peppitness_private.import_budget_config;
select is(public.get_import_budget_config(),' {"enabled":false}'::jsonb,'config assente fail closed');
select throws_ok($q$select pg_temp.reserve('a','aaaaaaaa-0000-4000-8000-000000000001')$q$,'PT503','Import analysis disabled','assenza config non prenota');
insert into peppitness_private.import_budget_config(singleton,enabled,config_version,price_version,provider,model,currency,
 project_limit_micros,account_limit_micros,input_micros_per_million,output_micros_per_million,framing_tokens)
 values(true,true,'test/1','prices/1','synthetic','synthetic','USD',50,40,1000000,2000000,0);
insert into budget_test_state values ('r1',pg_temp.reserve('a','aaaaaaaa-0000-4000-8000-000000000001'));
select is(pg_temp.b('r1','reservedMicros'),'30','massimo input + output riservato');
select is(pg_temp.b('r1','job.attemptCount'),'0','riserva non inventa chiamata');
select is(pg_temp.b('r1','sendGranted'),'false','riserva da sola non autorizza invio');
select is(pg_temp.b('r1','state'),'reserved','stato prenotato');
select is(peppitness_private.import_budget_exposure(),30::numeric,'esposizione comprende riserva');
select is(pg_temp.reserve('a','aaaaaaaa-0000-4000-8000-000000000001')->>'reservationId','aaaaaaaa-0000-4000-8000-000000000001','replay stessa riserva');
select throws_ok($q$select pg_temp.reserve('a','aaaaaaaa-0000-4000-8000-000000000001',11)$q$,'PT409','Import reservation conflict','payload diverso stessa riserva confligge');
select throws_ok($q$select pg_temp.reserve('profile','bbbbbbbb-0000-4000-8000-000000000001')$q$,'PT409','Import analysis profile changed','profilo server obbligatorio');
select throws_ok($q$select pg_temp.reserve('b','bbbbbbbb-0000-4000-8000-000000000001',100001)$q$,'PT413','Import token limit exceeded','limite input prima invio');
select throws_ok($q$select pg_temp.reserve('b','bbbbbbbb-0000-4000-8000-000000000001',10,16001)$q$,'PT413','Import token limit exceeded','output massimo configurato');
select throws_ok($q$select pg_temp.reserve('b','bbbbbbbb-0000-4000-8000-000000000001')$q$,'PT429','Import project budget exhausted','due account non superano progetto');
select throws_ok($q$select pg_temp.reserve('a2','aaaaaaaa-0000-4000-8000-000000000002')$q$,'PT409','Import account concurrency limit','una analisi attiva per account');
select is((select count(*) from peppitness_private.import_usage_ledger),1::bigint,'fallimenti non lasciano riserve');
set local role service_role;
select is(public.get_import_reservation('22222222-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000001'),null::jsonb,'lookup owner B non vede A');
select throws_ok($q$select public.dispatch_import_attempt('22222222-2222-4222-8222-222222222222','aaaaaaaa-0000-4000-8000-000000000001')$q$,'42501','Import reservation not available','dispatch controlla owner');
update budget_test_state set value=public.dispatch_import_attempt('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001') where label='r1';
select is(pg_temp.b('r1','sendGranted'),'true','primo invio autorizzato');
select is(pg_temp.b('r1','attempt'),'1','un invio un tentativo');
select is(public.dispatch_import_attempt('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001')->>'sendGranted','false','replay non ri-autorizza invio');
select throws_ok($q$select public.reconcile_import_usage('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','not_sent','{"inputTokens":0,"outputTokens":0,"reasoningTokens":0}')$q$,
 'PT409','Import dispatch state conflict','dopo invio non dichiarare non inviato');
select throws_ok($q$select public.reconcile_import_usage('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','known','{"inputTokens":null,"outputTokens":0,"reasoningTokens":0}')$q$,
 '22023','Invalid import usage','usage parziale non riconciliato a zero');
update budget_test_state set value=public.reconcile_import_usage('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','uncertain',
 '{"inputTokens":null,"outputTokens":null,"reasoningTokens":null}') where label='r1';
select is(pg_temp.b('r1','state'),'uncertain','timeout esito incerto');
select is(pg_temp.b('r1','reservedMicros'),'30','timeout conserva massima riserva');
select is(pg_temp.b('r1','actualMicros'),null::text,'ignoto non equivale a zero');
select is(pg_temp.b('r1','job.job.usageSummary.inputTokens'),null::text,'protocollo pubblico mantiene ignoto');
reset role;
update budget_test_state set value=public.find_import_job('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where label='a';
select throws_ok($q$select pg_temp.reserve('a','aaaaaaaa-0000-4000-8000-000000000002',10,10,true)$q$,'PT409','Import analysis already active','ignoto non risolto da nuova chiamata');
update peppitness_private.import_budget_config set enabled=false,input_micros_per_million=10000000,output_micros_per_million=20000000,price_version='prices/2',config_version='test/2';
select throws_ok($q$select pg_temp.reserve('b','bbbbbbbb-0000-4000-8000-000000000001')$q$,'PT503','Import analysis disabled','kill switch blocca nuove analisi');
set local role service_role;
update budget_test_state set value=public.reconcile_import_usage('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','known',
 '{"inputTokens":5,"outputTokens":4,"reasoningTokens":3}',30) where label='r1';
select is(pg_temp.b('r1','actualMicros'),'13','snapshot prezzi originali e reasoning non doppio');
select is(pg_temp.b('r1','job.job.usageSummary.costEstimate.amountMicros'),'13','usage pubblico dal ledger');
select is(pg_temp.b('r1','job.job.usageSummary.outputTokens'),'4','output inclusivo reasoning');
select is(public.reconcile_import_usage('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','known',
 '{"inputTokens":5,"outputTokens":4,"reasoningTokens":3}',30)->>'actualMicros','13','reconcile idempotente');
select throws_ok($q$select public.reconcile_import_usage('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000001','known',
 '{"inputTokens":6,"outputTokens":4,"reasoningTokens":3}',30)$q$,'PT409','Import usage conflict','doppia riconciliazione diversa confligge');
reset role;
select is(peppitness_private.import_budget_exposure(),13::numeric,'nessun doppio addebito');
update peppitness_private.import_budget_config set enabled=true,project_limit_micros=500,account_limit_micros=400;
update budget_test_state set value=public.find_import_job('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where label='a';
select throws_ok($q$select pg_temp.reserve('a','aaaaaaaa-0000-4000-8000-000000000002',10,10,true)$q$,'PT429','Import retry deferred','Retry-After rispettato');
update peppitness_private.import_usage_ledger set retry_not_before=now()-interval '1 second';
select throws_ok($q$select pg_temp.reserve('a','aaaaaaaa-0000-4000-8000-000000000002')$q$,'PT409','Import explicit retry required','retry solo esplicito');
insert into budget_test_state values ('r2',pg_temp.reserve('a','aaaaaaaa-0000-4000-8000-000000000002',10,10,true));
select is(pg_temp.b('r2','reservedMicros'),'300','nuovo tentativo nuovi prezzi configurati');
select is(pg_temp.b('r2','job.attemptCount'),'1','seconda prenotazione non ancora chiamata');
update peppitness_private.import_budget_config set enabled=false;
select throws_ok($q$select public.dispatch_import_attempt('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002')$q$,'PT503','Import analysis disabled','kill switch anche fra reserve e dispatch');
update peppitness_private.import_budget_config set enabled=true;
update budget_test_state set value=public.dispatch_import_attempt('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002') where label='r2';
select is(pg_temp.b('r2','attempt'),'2','seconda chiamata conta secondo tentativo');
update budget_test_state set value=public.reconcile_import_usage('11111111-1111-4111-8111-111111111111','aaaaaaaa-0000-4000-8000-000000000002','known',
 '{"inputTokens":0,"outputTokens":0,"reasoningTokens":0}') where label='r2';
select is(pg_temp.b('r2','job.job.usageSummary.providerCalls'),'2','429 noto zero non azzera chiamate');
select is(pg_temp.b('r2','job.job.usageSummary.costEstimate.amountMicros'),'13','zero noto non addebita due volte il primo');
update budget_test_state set value=public.find_import_job('11111111-1111-4111-8111-111111111111','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where label='a';
select throws_ok($q$select pg_temp.reserve('a','aaaaaaaa-0000-4000-8000-000000000003',10,10,true)$q$,'PT429','Import attempt quota exhausted','limite include tutti segmenti/retry');
update peppitness_private.import_budget_config set daily_analyses=1,max_active_per_account=100;
select throws_ok($q$select pg_temp.reserve('a2','aaaaaaaa-0000-4000-8000-000000000003')$q$,'PT429','Import daily quota exhausted','retry non è nuova analisi ma altro job sì');
update peppitness_private.import_budget_config set daily_analyses=5,max_active_per_account=1;
update budget_test_state set value=public.complete_import_job('11111111-1111-4111-8111-111111111111',pg_temp.b('a','job.jobId')::uuid,
 pg_temp.b('a','revision')::integer,pg_temp.b('a','leaseToken')::uuid,1,
 jsonb_build_object('extraction',(select extraction from import_fixture),'validationIssues','[]'::jsonb,
 'usageSummary','{"providerCalls":2,"inputTokens":0,"outputTokens":0,"reasoningTokens":0,"cached":false,"costEstimate":null}'::jsonb)) where label='a';
select is(pg_temp.b('a','job.status'),'ready','piani assenti ma risultato recuperabile');
select is(pg_temp.b('a','job.usageSummary.costEstimate.amountMicros'),'13','complete non falsifica usage ledger');
select throws_ok($q$update peppitness_private.import_budget_config set currency='EUR'$q$,'23514','Import ledger currency cannot change','nessuna somma di valute diverse');
-- Cancellation PRIMA dell'invio: nessuna chiamata e zero esplicito.
insert into budget_test_state values ('rb',pg_temp.reserve('b','bbbbbbbb-0000-4000-8000-000000000001'));
update budget_test_state set value=public.reconcile_import_usage('22222222-2222-4222-8222-222222222222','bbbbbbbb-0000-4000-8000-000000000001','not_sent',
 '{"inputTokens":0,"outputTokens":0,"reasoningTokens":0}') where label='rb';
select is(pg_temp.b('rb','job.attemptCount'),'0','annullamento prima invio non è chiamata');
select is(peppitness_private.import_budget_exposure(),13::numeric,'solo riserva mai inviata liberabile');
update budget_test_state set value=public.find_import_job('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where label='b';
insert into budget_test_state values ('rb2',pg_temp.reserve('b','bbbbbbbb-0000-4000-8000-000000000002'));
update budget_test_state set value=public.dispatch_import_attempt('22222222-2222-4222-8222-222222222222','bbbbbbbb-0000-4000-8000-000000000002') where label='rb2';
select is(pg_temp.b('rb2','attempt'),'1','annullamento precedente non consuma tentativo');
update budget_test_state set value=public.reconcile_import_usage('22222222-2222-4222-8222-222222222222','bbbbbbbb-0000-4000-8000-000000000002','uncertain',
 '{"inputTokens":5,"outputTokens":null,"reasoningTokens":null}') where label='rb2';
select is(pg_temp.b('rb2','reservedMicros'),'300','usage parziale non riduce riserva');
update public.import_jobs set expires_at=now()-interval '1 second',lease_expires_at=now()-interval '1 second',revision=revision+1 where id=pg_temp.b('b','job.jobId')::uuid;
update public.import_drafts set expires_at=now()-interval '1 second',revision=revision+1 where job_id=pg_temp.b('b','job.jobId')::uuid;
update budget_test_state set value=public.find_import_job('22222222-2222-4222-8222-222222222222','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where label='b';
select lives_ok($q$select public.expire_import_job('22222222-2222-4222-8222-222222222222',pg_temp.b('b','job.jobId')::uuid,pg_temp.b('b','revision')::integer)$q$,'expiry contenuti indipendente dalla spesa');
select is(peppitness_private.import_budget_exposure(),313::numeric,'TTL non libera incertezza');
update peppitness_private.import_usage_ledger set budget_month=(date_trunc('month',now() at time zone 'UTC')-interval '1 month')::date where owner_id='22222222-2222-4222-8222-222222222222';
set local time zone 'Pacific/Kiritimati';
select is(peppitness_private.import_budget_exposure(),313::numeric,'cambio mese/fuso non libera riserva precedente');
set constraints all immediate;
delete from auth.users where id='11111111-1111-4111-8111-111111111111';
select is((select count(*) from peppitness_private.import_usage_ledger where owner_id='11111111-1111-4111-8111-111111111111'),0::bigint,'account delete elimina ledger personale');
select is(peppitness_private.import_budget_exposure(),313::numeric,'account delete non azzera spesa progetto');
delete from auth.users where id='22222222-2222-4222-8222-222222222222';
select is((select count(*) from peppitness_private.import_usage_ledger),0::bigint,'nessun identificativo personale residuo');
select is(peppitness_private.import_budget_exposure(),313::numeric,'aggregati anonimi conservano spesa nota e incerta');
select * from finish();
rollback;
