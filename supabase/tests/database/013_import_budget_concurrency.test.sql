-- A failed request releases only the execution slot after its lease expires.
-- Unknown provider spend is neither erased nor converted to known zero.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pg_catalog;
select no_plan();
\ir import_jobs_fixture.inc
create temporary table concurrency_state(label text primary key, value jsonb);
create function pg_temp.c(label text, path text) returns text language sql as $$
 select value#>>string_to_array(path,'.') from pg_temp.concurrency_state where label=$1;
$$;
create function pg_temp.new_job(request_id uuid) returns jsonb language sql as $$
 select public.create_import_job('61111111-1111-4111-8111-111111111111',request_id,'workout',repeat('a',64),repeat('b',64),
 jsonb_build_object('reader','synthetic-fixture/1','schema','1.0','prompt','test/1','provider','synthetic','model','synthetic','rules','test/1'),document)
 from pg_temp.import_fixture;
$$;
create function pg_temp.new_reservation(label text, reservation_id uuid, retry boolean default false) returns jsonb language sql as $$
 select public.reserve_import_budget('61111111-1111-4111-8111-111111111111',pg_temp.c(label,'job.jobId')::uuid,
 reservation_id,pg_temp.c(label,'revision')::integer,repeat('c',64),10,10,retry);
$$;
insert into auth.users(id,aud,role,email) values
 ('61111111-1111-4111-8111-111111111111','authenticated','authenticated','concurrency@example.invalid');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
update peppitness_private.import_budget_config set enabled=true,config_version='concurrency-test/1',price_version='synthetic/1',
 provider='synthetic',model='synthetic',currency='USD',project_limit_micros=1000,account_limit_micros=1000,
 input_micros_per_million=1000000,output_micros_per_million=2000000,framing_tokens=0,
 max_active_per_account=1,daily_analyses=20,max_attempts=2;
insert into concurrency_state values
 ('a',pg_temp.new_job('61111111-0000-4000-8000-000000000001')),
 ('b',pg_temp.new_job('61111111-0000-4000-8000-000000000002')),
 ('c',pg_temp.new_job('61111111-0000-4000-8000-000000000003'));
insert into concurrency_state values ('ra',pg_temp.new_reservation('a','61111111-0000-4000-8000-000000000011'));
select throws_ok($q$select pg_temp.new_reservation('b','61111111-0000-4000-8000-000000000012')$q$,
 'PT409','Import account concurrency limit','a live reservation still occupies the account slot');
update concurrency_state set value=public.dispatch_import_attempt('61111111-1111-4111-8111-111111111111',
 '61111111-0000-4000-8000-000000000011') where label='ra';
update concurrency_state set value=public.reconcile_import_usage('61111111-1111-4111-8111-111111111111',
 '61111111-0000-4000-8000-000000000011','uncertain','{"inputTokens":null,"outputTokens":null,"reasoningTokens":null}') where label='ra';
update concurrency_state set value=public.find_import_job('61111111-1111-4111-8111-111111111111',
 '61111111-0000-4000-8000-000000000001') where label='a';
update concurrency_state set value=public.fail_import_job('61111111-1111-4111-8111-111111111111',
 pg_temp.c('a','job.jobId')::uuid,pg_temp.c('a','revision')::integer,pg_temp.c('a','leaseToken')::uuid,
 'provider_outcome_uncertain') where label='a';
select throws_ok($q$select pg_temp.new_reservation('b','61111111-0000-4000-8000-000000000012')$q$,
 'PT409','Import account concurrency limit','failed uncertain work retains its slot while the lease is fresh');
update public.import_jobs set lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1
 where id=pg_temp.c('a','job.jobId')::uuid;
update concurrency_state set value=public.find_import_job('61111111-1111-4111-8111-111111111111',
 '61111111-0000-4000-8000-000000000001') where label='a';
select throws_ok($q$select pg_temp.new_reservation('a','61111111-0000-4000-8000-000000000014',true)$q$,
 'PT409','Import analysis already active','an expired lease never authorizes retrying the uncertain job');
select lives_ok($q$insert into concurrency_state values
 ('rb',pg_temp.new_reservation('b','61111111-0000-4000-8000-000000000012'))$q$,
 'a different explicitly requested job may reserve after the failed lease expires');
select is((select state from peppitness_private.import_usage_ledger where id='61111111-0000-4000-8000-000000000011'),
 'uncertain','the old uncertain ledger entry is preserved');
select is((select reserved_micros from peppitness_private.import_usage_ledger where id='61111111-0000-4000-8000-000000000011'),
 30::bigint,'the full old financial reservation is preserved');
select is((select actual_micros from peppitness_private.import_usage_ledger where id='61111111-0000-4000-8000-000000000011'),
 null::bigint,'unknown spend is not marked as known zero');
select is(peppitness_private.import_budget_exposure(),60::numeric,'project exposure includes both the old and new reservations');
select is(peppitness_private.import_budget_exposure('61111111-1111-4111-8111-111111111111'),60::numeric,
 'account exposure includes both reservations');
select is(pg_temp.c('rb','job.attemptCount'),'0','the new reservation does not dispatch a provider call');
select is((select attempt_count from public.import_jobs where id=pg_temp.c('a','job.jobId')::uuid),1,
 'the failed job is never redispatched');
select throws_ok($q$select pg_temp.new_reservation('c','61111111-0000-4000-8000-000000000013')$q$,
 'PT409','Import account concurrency limit','the replacement job still blocks a third concurrent analysis');
update concurrency_state set value=public.reconcile_import_usage('61111111-1111-4111-8111-111111111111',
 '61111111-0000-4000-8000-000000000012','not_sent','{"inputTokens":0,"outputTokens":0,"reasoningTokens":0}') where label='rb';
update peppitness_private.import_budget_config set account_limit_micros=50;
select throws_ok($q$select pg_temp.new_reservation('c','61111111-0000-4000-8000-000000000013')$q$,
 'PT429','Import account budget exhausted','old uncertain spend still enforces the account cap');
update peppitness_private.import_budget_config set account_limit_micros=1000,project_limit_micros=50;
select throws_ok($q$select pg_temp.new_reservation('c','61111111-0000-4000-8000-000000000013')$q$,
 'PT429','Import project budget exhausted','old uncertain spend still enforces the project cap');
select is((select count(*) from peppitness_private.import_usage_ledger),2::bigint,'rejected requests add no reservations');
select is(peppitness_private.import_budget_exposure(),30::numeric,'only the never-dispatched reservation was released');
update peppitness_private.import_budget_config set project_limit_micros=1000;
update public.import_jobs set expires_at=clock_timestamp()-interval '1 second',revision=revision+1 where id=pg_temp.c('a','job.jobId')::uuid;
update public.import_drafts set expires_at=clock_timestamp()-interval '1 second',revision=revision+1 where job_id=pg_temp.c('a','job.jobId')::uuid;
update concurrency_state set value=public.find_import_job('61111111-1111-4111-8111-111111111111',
 '61111111-0000-4000-8000-000000000001') where label='a';
update concurrency_state set value=public.expire_import_job('61111111-1111-4111-8111-111111111111',
 pg_temp.c('a','job.jobId')::uuid,pg_temp.c('a','revision')::integer) where label='a';
select lives_ok($q$insert into concurrency_state values
 ('rc',pg_temp.new_reservation('c','61111111-0000-4000-8000-000000000013'))$q$,
 'content expiry does not resurrect the old execution lock');
select is(peppitness_private.import_budget_exposure(),60::numeric,'expired content still retains uncertain spend');
select * from finish();
rollback;
