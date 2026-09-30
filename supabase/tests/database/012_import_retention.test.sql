-- Task 23. Retention reale dei contenuti d'importazione sul DB locale, con rollback finale. Scadenze simulate
-- con timestamp di fixture (nessuna attesa reale); job reali delle API 14, ricevute delle RPC 20, ledger 15.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();
\ir import_commit_fixtures.inc

-- ---------------------------------------------------------------------------
-- Privilegi, job pianificato e installazione idempotente
-- ---------------------------------------------------------------------------
select ok(exists(select 1 from pg_extension where extname = 'pg_cron'), 'pg_cron installato');
select is((select count(*)::integer from cron.job where jobname = 'peppitness-import-retention'), 1, 'un solo job pianificato');
select ok((select schedule = '17 * * * *' and command = 'select peppitness_private.run_import_retention(500)' and active and username = 'postgres' and database = current_database()
  from cron.job where jobname = 'peppitness-import-retention'), 'ogni ora al minuto 17 (UTC), comando e database attesi, attivo');
select is(current_setting('cron.timezone'), 'GMT', 'fuso dello scheduler dichiarato (GMT/UTC)');
select lives_ok($q$ select peppitness_private.schedule_import_retention(); select peppitness_private.schedule_import_retention() $q$, 'reinstallazione ripetuta');
select is((select count(*)::integer from cron.job where jobname = 'peppitness-import-retention'), 1, 'doppia installazione: sempre un solo job');
select ok(bool_and(not has_function_privilege(role, f, 'execute')), 'manutenzione non eseguibile dai ruoli API')
  from unnest(array['peppitness_private.run_import_retention(integer)', 'peppitness_private.expire_import_content(uuid,uuid)',
    'peppitness_private.schedule_import_retention()', 'peppitness_private.import_retention_status()']::regprocedure[]) f
  cross join unnest(array['anon', 'authenticated', 'service_role']) role;
select ok(has_function_privilege('authenticated', 'public.discard_import_job(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.discard_import_job(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.discard_import_job(uuid)', 'execute'), 'scarto solo authenticated');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'peppitness_private.run_import_retention(integer)'::regprocedure)
  and (select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.discard_import_job(uuid)'::regprocedure), 'SECURITY DEFINER con search_path vuoto');
select ok((select relrowsecurity from pg_class where oid = 'peppitness_private.import_retention_runs'::regclass)
  and not has_table_privilege('service_role', 'peppitness_private.import_retention_runs', 'select,insert,update,delete')
  and not has_table_privilege('authenticated', 'peppitness_private.import_retention_runs', 'select,insert,update,delete'), 'esiti privati');
select throws_ok($q$ select peppitness_private.run_import_retention(0) $q$, '22023', 'Invalid retention batch', 'lotto non valido');

-- ---------------------------------------------------------------------------
-- Fixture: due account, job reali in ogni stato, ledger, ricevuta di un import confermato
-- ---------------------------------------------------------------------------
insert into auth.users(id, aud, role, email) values
  ('23111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'retention-a@example.invalid'),
  ('23222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'retention-b@example.invalid');
create temporary table jobs23(name text primary key, owner_id uuid not null, created jsonb);
create temporary table state23(name text primary key, value jsonb);
grant select, insert, update on jobs23, state23 to authenticated, service_role;
create function pg_temp.jid(name text) returns uuid language sql as $$ select (created#>>'{job,jobId}')::uuid from pg_temp.jobs23 where jobs23.name = $1 $$;
create function pg_temp.as_user(owner_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.jid(text), pg_temp.as_user(uuid) to authenticated, service_role;

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into jobs23 select n.name, n.owner_id, public.create_import_job(n.owner_id, gen_random_uuid(), f.kind,
    encode(sha256(convert_to('input:' || n.name, 'UTF8')), 'hex'), encode(sha256(convert_to('document:' || n.name, 'UTF8')), 'hex'),
    jsonb_build_object('reader', f.document->>'readerVersion', 'schema', '1.0', 'prompt', 'test/1', 'provider', 'synthetic', 'model', 'synthetic', 'rules', 'retention/1'), f.document)
  from import_commit_fixtures f cross join (values
    ('ready-old', '23111111-1111-4111-8111-111111111111'::uuid), ('ready-new', '23111111-1111-4111-8111-111111111111'::uuid),
    ('committed', '23111111-1111-4111-8111-111111111111'::uuid), ('running-live', '23111111-1111-4111-8111-111111111111'::uuid),
    ('running-stale', '23111111-1111-4111-8111-111111111111'::uuid), ('uncertain', '23111111-1111-4111-8111-111111111111'::uuid),
    ('discard-a', '23111111-1111-4111-8111-111111111111'::uuid), ('b-old', '23222222-2222-4222-8222-222222222222'::uuid)) n(name, owner_id)
  where f.id = 'diet-spec-example';
update jobs23 j set created = public.complete_import_job(j.owner_id, pg_temp.jid(j.name), (j.created->>'revision')::integer,
    (j.created->>'leaseToken')::uuid, (j.created->>'draftRevision')::integer, jsonb_build_object('extraction', f.extraction, 'validationIssues', '[]'::jsonb,
      'usageSummary', jsonb_build_object('providerCalls', 0, 'inputTokens', null, 'outputTokens', null, 'reasoningTokens', null, 'cached', false, 'costEstimate', null)))
  from import_commit_fixtures f where f.id = 'diet-spec-example' and j.name in ('ready-old', 'ready-new', 'committed', 'discard-a', 'b-old');
update jobs23 j set created = public.fail_import_job(j.owner_id, pg_temp.jid(j.name), (j.created->>'revision')::integer,
    (j.created->>'leaseToken')::uuid, 'provider_outcome_uncertain') where j.name = 'uncertain';
reset role;
select is((select count(*)::integer from jobs23 where created#>>'{job,status}' = 'ready'), 5, 'job pronti');

-- Import confermato sul job `committed` (RPC 20 sotto l'utente), prima della scadenza.
insert into state23 select 'command', jsonb_set(f.command, '{provenance,analysis,jobId}', to_jsonb(pg_temp.jid('committed')))
  from import_commit_fixtures f where f.id = 'diet-spec-example';
set local role authenticated;
select pg_temp.as_user('23111111-1111-4111-8111-111111111111');
insert into state23 select 'receipt', public.commit_diet_import((value->>'requestId')::uuid, value->'payload', value->'provenance', value->'selectionOptions')
  from state23 where name = 'command';
reset role;
select is((select value->>'resultState' from state23 where name = 'receipt'), 'committed', 'import confermato prima della scadenza');

-- Chiamate provider partite e mai chiuse: `in_flight` con lease scaduta; esito incerto; lease ancora valida.
update public.import_jobs set provider_outcome = 'in_flight', attempt_count = 1, lease_expires_at = clock_timestamp() - interval '1 hour', revision = revision + 1
  where id = pg_temp.jid('running-stale');
update public.import_jobs set attempt_count = 1, revision = revision + 1 where id = pg_temp.jid('uncertain');
update public.import_jobs set lease_expires_at = clock_timestamp() + interval '1 hour', revision = revision + 1 where id = pg_temp.jid('running-live');
insert into peppitness_private.import_usage_ledger(id, owner_id, job_id, attempt, request_hash, input_bytes, input_upper_tokens, max_output_tokens,
    config_version, price_version, provider, model, currency, input_micros_per_million, output_micros_per_million, reserved_micros, state, lease_token, sent_at)
  select gen_random_uuid(), '23111111-1111-4111-8111-111111111111', pg_temp.jid(v.name), v.attempt, repeat('d', 64), 100, 50, 100,
    'test/1', 'test/1', 'synthetic', 'synthetic', 'EUR', 1, 1, 777, v.state, gen_random_uuid(), case when v.attempt is null then null else clock_timestamp() end
  from (values ('running-stale', 1, 'sent'), ('uncertain', 1, 'uncertain'), ('ready-old', null::integer, 'reserved')) v(name, attempt, state);
insert into state23 values ('ledger', (select jsonb_agg(to_jsonb(l) order by l.id) from peppitness_private.import_usage_ledger l
  where owner_id = '23111111-1111-4111-8111-111111111111'));

-- Scadenza simulata: 7 giorni di inattività trascorsi; job e bozza con lo stesso istante, come touch/complete.
update public.import_drafts set expires_at = now() - interval '1 minute', revision = revision + 1
  where job_id in (select pg_temp.jid(name) from jobs23 where name not in ('ready-new', 'discard-a', 'running-live'));
update public.import_jobs set expires_at = now() - interval '1 minute', revision = revision + 1
  where id in (select pg_temp.jid(name) from jobs23 where name not in ('ready-new', 'discard-a', 'running-live'));
-- L'analisi ancora in corso scade per ultima: il primo lotto contiene solo job da pulire (ordine deterministico).
update public.import_drafts set expires_at = now() - interval '30 seconds', revision = revision + 1 where job_id = pg_temp.jid('running-live');
update public.import_jobs set expires_at = now() - interval '30 seconds', revision = revision + 1 where id = pg_temp.jid('running-live');
select is((select count(*)::integer from public.import_drafts where job_id in (select pg_temp.jid(name) from jobs23)), 8, 'prima del cleanup: le bozze ci sono ancora');

-- La scadenza da sola non cancella: senza cleanup i testi esistono ancora, ma nessun client li vede.
set local role authenticated;
select pg_temp.as_user('23111111-1111-4111-8111-111111111111');
select is(public.get_import_job(pg_temp.jid('ready-old'))->>'status', 'expired', 'lookup: proiezione expired prima del cleanup');
select is((select count(*)::integer from public.import_drafts where job_id = pg_temp.jid('ready-old')), 0, 'RLS: contenuto scaduto invisibile');
reset role;

-- ---------------------------------------------------------------------------
-- Cleanup a lotti: interrotto, ripreso, idempotente
-- ---------------------------------------------------------------------------
select is((select count(*)::integer from public.import_jobs where status <> 'expired' and expires_at <= clock_timestamp()), 6, 'sei job scaduti da pulire');
insert into state23 values ('run1', peppitness_private.run_import_retention(2));
select is((select value->>'expiredJobs' from state23 where name = 'run1'), '2', 'primo lotto di 2');
select ok((select (value->>'remaining')::integer >= 3 from state23 where name = 'run1'), 'arretrato dichiarato');
-- Lotto interrotto: nulla di parziale resta (sottotransazione annullata), poi ripreso.
savepoint interrupted;
select lives_ok($q$ select peppitness_private.run_import_retention(1) $q$, 'lotto poi annullato');
rollback to savepoint interrupted;
insert into state23 values ('run2', peppitness_private.run_import_retention(500));
select is((select value->>'status' from state23 where name = 'run2'), 'succeeded', 'lotto completo riuscito');
select is((select value->>'skippedRunning' from state23 where name = 'run2'), '1', 'analisi con lease valida non toccata');
select is((select value->>'remaining' from state23 where name = 'run2'), '1', 'resta solo il job con lease valida');
insert into state23 values ('run3', peppitness_private.run_import_retention(500));
select is((select value->>'expiredJobs' from state23 where name = 'run3'), '0', 'idempotente: nulla da rifare');
select is((select count(*)::integer from peppitness_private.import_retention_runs where status = 'succeeded' and started_at >= (select min(started_at) from peppitness_private.import_retention_runs)),
  (select count(*)::integer from peppitness_private.import_retention_runs), 'esiti registrati');
select ok((peppitness_private.import_retention_status()#>>'{lastRun,status}') = 'succeeded' and (peppitness_private.import_retention_status()->>'overdue') = '1'
  and (peppitness_private.import_retention_status()#>>'{scheduled,schedule}') = '17 * * * *', 'stato per il monitoraggio');
select ok(not exists(select 1 from peppitness_private.import_retention_runs r where to_jsonb(r)::text ~ '(23111111|Colazione|yogurt)'), 'esiti senza account né testi');

-- Contenuti realmente eliminati, metadati conservati, nulla fuori dai job scaduti toccato.
select is((select count(*)::integer from public.import_drafts where job_id in (select pg_temp.jid(name) from jobs23 where name in ('ready-old', 'committed', 'running-stale', 'uncertain', 'b-old'))), 0,
  'testi normalizzati ed estrazioni eliminati');
select ok(bool_and(j.status = 'expired' and j.safe_error is null and j.lease_token is null), 'job scaduti marcati expired senza errori né lease')
  from public.import_jobs j where j.id in (select pg_temp.jid(name) from jobs23 where name in ('ready-old', 'committed', 'running-stale', 'uncertain', 'b-old'));
select ok((select provider_outcome = 'in_flight' and attempt_count = 1 from public.import_jobs where id = pg_temp.jid('running-stale'))
  and (select provider_outcome = 'uncertain' and attempt_count = 1 from public.import_jobs where id = pg_temp.jid('uncertain')), 'esito provider e tentativi conservati: scadenza ≠ spesa zero');
select ok((select status = 'running' from public.import_jobs where id = pg_temp.jid('running-live'))
  and exists(select 1 from public.import_drafts where job_id = pg_temp.jid('running-live')), 'analisi in corso intatta');
select ok((select status = 'ready' from public.import_jobs where id = pg_temp.jid('ready-new'))
  and exists(select 1 from public.import_drafts where job_id = pg_temp.jid('ready-new') and extraction is not null), 'job non scaduto intatto');
select is((select jsonb_agg(to_jsonb(l) order by l.id) from peppitness_private.import_usage_ledger l where owner_id = '23111111-1111-4111-8111-111111111111'),
  (select value from state23 where name = 'ledger'), 'ledger identico: riserve reserved/sent/uncertain non liberate');

-- Ricevuta e replay: il commit riuscito resta recuperabile; uno nuovo sul job scaduto è un rifiuto certo.
select is((select result_state from public.import_receipts where owner_id = '23111111-1111-4111-8111-111111111111'), 'committed', 'ricevuta conservata');
set local role authenticated;
select pg_temp.as_user('23111111-1111-4111-8111-111111111111');
select is((select public.commit_diet_import((value->>'requestId')::uuid, value->'payload', value->'provenance', value->'selectionOptions') from state23 where name = 'command'),
  (select value from state23 where name = 'receipt'), 'replay dopo il cleanup: stessa ricevuta');
select throws_ok($q$ select public.commit_diet_import(gen_random_uuid(), value->'payload', value->'provenance', value->'selectionOptions') from state23 where name = 'command' $q$,
  'PT410', 'Import analysis expired', 'nuova chiave sul job scaduto: PT410, nessuna scrittura');
select is(public.get_import_job(pg_temp.jid('committed'))->'extraction', 'null'::jsonb, 'lookup: expired senza contenuto');

-- ---------------------------------------------------------------------------
-- Scarto esplicito: solo i propri job, subito, senza informazioni sugli altri account
-- ---------------------------------------------------------------------------
select pg_temp.as_user('23222222-2222-4222-8222-222222222222');
select is(public.discard_import_job(pg_temp.jid('discard-a')), null, 'B non scarta né vede il job di A');
select pg_temp.as_user('23111111-1111-4111-8111-111111111111');
select throws_ok($q$ select public.discard_import_job(pg_temp.jid('running-live')) $q$, 'PT409', 'Import analysis in progress', 'analisi in corso non scartabile');
select ok((select public.discard_import_job(pg_temp.jid('discard-a'))->>'status' = 'expired'), 'scarto proprio: expired');
select is(public.discard_import_job(pg_temp.jid('discard-a'))->>'status', 'expired', 'scarto ripetuto idempotente');
set local role anon;
select throws_ok($q$ select public.discard_import_job(gen_random_uuid()) $q$, '42501', null, 'anonimo respinto');
reset role;
select is((select count(*)::integer from public.import_drafts where job_id = pg_temp.jid('discard-a')), 0, 'contenuti scartati eliminati davvero');
select is((select status from public.import_jobs where id = pg_temp.jid('discard-a')), 'expired', 'job scartato expired');

-- ---------------------------------------------------------------------------
-- Rinnovo per attività dell'utente: solo job propri pronti e non scaduti
-- ---------------------------------------------------------------------------
select ok(has_function_privilege('authenticated', 'public.renew_import_job(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.renew_import_job(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.renew_import_job(uuid)', 'execute'), 'rinnovo solo authenticated');
update public.import_drafts set expires_at = now() + interval '1 hour', revision = revision + 1 where job_id = pg_temp.jid('ready-new');
update public.import_jobs set expires_at = now() + interval '1 hour', revision = revision + 1 where id = pg_temp.jid('ready-new');
set local role authenticated;
select pg_temp.as_user('23222222-2222-4222-8222-222222222222');
select is(public.renew_import_job(pg_temp.jid('ready-new')), null, 'B non rinnova né vede il job di A');
select pg_temp.as_user('23111111-1111-4111-8111-111111111111');
select is(public.renew_import_job(pg_temp.jid('ready-new'))->>'status', 'ready', 'A rinnova la propria analisi pronta');
select is(public.renew_import_job(pg_temp.jid('ready-old'))->>'status', 'expired', 'un job scaduto non torna disponibile');
select lives_ok($q$ select public.renew_import_job(pg_temp.jid('running-live')) $q$, 'rinnovo di un''analisi non pronta senza errori');
reset role;
select ok((select status = 'running' and expires_at <= clock_timestamp() from public.import_jobs where id = pg_temp.jid('running-live')), 'analisi non pronta non rinnovata');
select ok((select expires_at > clock_timestamp() + interval '6 days' from public.import_jobs where id = pg_temp.jid('ready-new'))
  and (select d.expires_at = j.expires_at from public.import_drafts d join public.import_jobs j on j.id = d.job_id where j.id = pg_temp.jid('ready-new')), 'job e bozza scadono di nuovo fra 7 giorni, insieme');
select is((select status from public.import_jobs where id = pg_temp.jid('ready-old')), 'expired', 'nessuna resurrezione dopo il cleanup');
set local role anon;
select throws_ok($q$ select public.renew_import_job(gen_random_uuid()) $q$, '42501', null, 'rinnovo anonimo respinto');
reset role;

-- ---------------------------------------------------------------------------
-- Eliminazione del piano (tombstone) e dell'account
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('23111111-1111-4111-8111-111111111111');
select lives_ok($q$ select public.delete_meal_plans((select value->>'planId' from state23 where name = 'receipt')::uuid) $q$, 'piano importato eliminato');
reset role;
select is((select result_state from public.import_receipts where owner_id = '23111111-1111-4111-8111-111111111111'), 'deleted', 'tombstone conservata');
select lives_ok($q$ select peppitness_private.run_import_retention(500) $q$, 'cleanup dopo l''eliminazione');
select is((select count(*)::integer from public.import_receipts where owner_id = '23111111-1111-4111-8111-111111111111'), 1, 'cleanup non tocca ricevute/tombstone');
insert into state23 values ('retired-before', coalesce((select to_jsonb(r) from peppitness_private.import_budget_retired r where budget_month = date_trunc('month', clock_timestamp() at time zone 'UTC')::date), '{}'));
delete from auth.users where id = '23111111-1111-4111-8111-111111111111';
select ok(not exists(select 1 from public.import_jobs where owner_id = '23111111-1111-4111-8111-111111111111')
  and not exists(select 1 from public.import_drafts where owner_id = '23111111-1111-4111-8111-111111111111')
  and not exists(select 1 from public.import_receipts where owner_id = '23111111-1111-4111-8111-111111111111')
  and not exists(select 1 from peppitness_private.import_usage_ledger where owner_id = '23111111-1111-4111-8111-111111111111'), 'account eliminato: nessun dato d''importazione resta');
select ok((select uncertain_micros >= 777 * 2 from peppitness_private.import_budget_retired where budget_month = date_trunc('month', clock_timestamp() at time zone 'UTC')::date),
  'consumo incerto ancora contato in forma anonima');

select * from finish();
rollback;
