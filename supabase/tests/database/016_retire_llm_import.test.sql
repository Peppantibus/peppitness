-- Migrazione reale su fixture sintetiche, rollback finale. Nessun provider/cloud.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();
\ir import_commit_fixtures.inc

select ok((select not enabled from peppitness_private.import_budget_config), 'nuove installazioni: LLM disabilitato');
update peppitness_private.import_budget_config set enabled = true, config_version = 'retirement-test',
  price_version = 'synthetic/1', provider = 'synthetic', model = 'synthetic', currency = 'EUR',
  project_limit_micros = 100000, account_limit_micros = 10000,
  input_micros_per_million = 1, output_micros_per_million = 1;
insert into auth.users(id, aud, role, email) values
  ('16111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'retire@example.invalid');
create temporary table retire_jobs(name text primary key, created jsonb);
create temporary table retire_state(name text primary key, value jsonb);
grant select, insert, update on retire_jobs, retire_state to authenticated, service_role;
create function pg_temp.retire_jid(label text) returns uuid language sql as $$
  select (created#>>'{job,jobId}')::uuid from pg_temp.retire_jobs where name = label;
$$;
grant execute on function pg_temp.retire_jid(text) to authenticated, service_role;
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into retire_jobs select n, public.create_import_job('16111111-1111-4111-8111-111111111111', gen_random_uuid(), f.kind,
    encode(sha256(convert_to(n, 'UTF8')), 'hex'), repeat('b',64),
    jsonb_build_object('reader', f.document->>'readerVersion', 'schema', '1.0', 'prompt', 'test/1', 'provider', 'synthetic', 'model', 'synthetic', 'rules', 'test/1'), f.document)
  from import_commit_fixtures f cross join unnest(array['ready','failed','stale']) n where f.id = 'diet-spec-example';
update retire_jobs j set created = public.complete_import_job('16111111-1111-4111-8111-111111111111', pg_temp.retire_jid(j.name),
    (j.created->>'revision')::integer, (j.created->>'leaseToken')::uuid, (j.created->>'draftRevision')::integer,
    jsonb_build_object('extraction', f.extraction, 'validationIssues', '[]'::jsonb,
      'usageSummary', jsonb_build_object('providerCalls', 0, 'inputTokens', null, 'outputTokens', null, 'reasoningTokens', null, 'cached', false, 'costEstimate', null)))
  from import_commit_fixtures f where f.id = 'diet-spec-example' and j.name = 'ready';
update retire_jobs j set created = public.fail_import_job('16111111-1111-4111-8111-111111111111', pg_temp.retire_jid(j.name),
    (j.created->>'revision')::integer, (j.created->>'leaseToken')::uuid, 'provider_outcome_uncertain') where name = 'failed';
reset role;
select throws_ok($q$ select peppitness_private.retire_llm_import() $q$, 'PT409', 'Import analysis in progress', 'lease attiva: ritiro respinto per intero');
select ok((select enabled from peppitness_private.import_budget_config), 'ritiro respinto: budget invariato');
select is((select count(*)::integer from public.import_drafts), 3, 'ritiro respinto: contenuti ancora presenti');
select ok(not has_function_privilege('authenticated', 'peppitness_private.retire_llm_import()', 'execute')
  and not has_function_privilege('service_role', 'peppitness_private.retire_llm_import()', 'execute')
  and not has_function_privilege('anon', 'peppitness_private.retire_llm_import()', 'execute'), 'ritiro riservato al proprietario amministrativo');
update public.import_jobs set lease_expires_at = clock_timestamp() - interval '1 hour', provider_outcome = 'in_flight',
  attempt_count = 1, revision = revision + 1 where id = pg_temp.retire_jid('stale');
insert into peppitness_private.import_usage_ledger(id, owner_id, job_id, attempt, request_hash, input_bytes, input_upper_tokens, max_output_tokens,
    config_version, price_version, provider, model, currency, input_micros_per_million, output_micros_per_million, reserved_micros, state, lease_token, sent_at)
  select gen_random_uuid(), '16111111-1111-4111-8111-111111111111', pg_temp.retire_jid(v.name), v.attempt, repeat('d',64), 100, 50, 100,
    'test/1', 'test/1', 'synthetic', 'synthetic', 'EUR', 1, 1, 777, v.state, gen_random_uuid(), case when v.attempt is null then null else clock_timestamp() end
  from (values ('stale', 1, 'sent'), ('failed', 1, 'uncertain'), ('ready', null::integer, 'reserved')) v(name, attempt, state);
insert into retire_state select 'command', jsonb_set(command, '{provenance,analysis,jobId}', to_jsonb(pg_temp.retire_jid('ready')))
  from import_commit_fixtures where id = 'diet-spec-example';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"16111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
insert into retire_state select 'receipt', public.commit_diet_import((value->>'requestId')::uuid, value->'payload', value->'provenance', value->'selectionOptions')
  from retire_state where name = 'command';
reset role;
insert into retire_state values
  ('ledger', (select jsonb_agg(to_jsonb(t) order by id) from peppitness_private.import_usage_ledger t)),
  ('receipts', (select jsonb_agg(to_jsonb(t) order by request_id) from public.import_receipts t)),
  ('plans', (select jsonb_agg(to_jsonb(t) order by id) from public.meal_plans t)),
  ('budget', (select to_jsonb(t) - 'enabled' - 'config_version' from peppitness_private.import_budget_config t));

select peppitness_private.retire_llm_import();
select ok((select not enabled and config_version = 'disabled/retired-llm-import' from peppitness_private.import_budget_config), 'kill switch LLM disabilitato');
select is((select count(*)::integer from public.import_drafts), 0, 'documenti ed estrazioni cancellati, anche entro TTL');
select is((select count(*)::integer from public.import_jobs where status <> 'expired'), 0, 'job ready/failed/running con lease scaduta ritirati');
select is((select count(*)::integer from public.import_jobs where id in (select pg_temp.retire_jid(name) from retire_jobs)), 3, 'metadati job conservati');
select is((select jsonb_agg(to_jsonb(t) order by id) from peppitness_private.import_usage_ledger t), (select value from retire_state where name='ledger'), 'ledger immutato: sent, uncertain e reserved non sono azzerati');
select is((select jsonb_agg(to_jsonb(t) order by request_id) from public.import_receipts t), (select value from retire_state where name='receipts'), 'ricevute immutate');
select is((select jsonb_agg(to_jsonb(t) order by id) from public.meal_plans t), (select value from retire_state where name='plans'), 'piano salvato immutato');
select is((select to_jsonb(t) - 'enabled' - 'config_version' from peppitness_private.import_budget_config t), (select value from retire_state where name='budget'), 'prezzi, limiti e altri parametri invariati');
select ok((select provider_outcome = 'in_flight' and attempt_count = 1 from public.import_jobs where id = pg_temp.retire_jid('stale')), 'esito provider e tentativi conservati');
set local role authenticated;
select is((select public.commit_diet_import((value->>'requestId')::uuid, value->'payload', value->'provenance', value->'selectionOptions') from retire_state where name='command'),
  (select value from retire_state where name='receipt'), 'replay di ricevuta legacy valido dopo lo scarto');
select lives_ok($q$ select public.commit_diet_import((command->>'requestId')::uuid, command->'payload', command->'provenance', command->'selectionOptions')
  from (select jsonb_set(jsonb_set(command, '{provenance,analysis,jobId}', 'null'::jsonb), '{provenance,items}',
      (select jsonb_agg(jsonb_set(i, '{sourcePointer}', 'null'::jsonb)) from jsonb_array_elements(command#>'{provenance,items}') i)) as command
    from import_commit_fixtures where id = 'diet-alternatives-additions') f $q$, 'import deterministico jobId null salva ancora con budget spento');
reset role;
insert into retire_state values ('jobs', (select jsonb_agg(to_jsonb(t) order by id) from public.import_jobs t));
select peppitness_private.retire_llm_import();
select is((select jsonb_agg(to_jsonb(t) order by id) from public.import_jobs t), (select value from retire_state where name='jobs'), 'ripetizione idempotente senza nuovi aggiornamenti');
select is((peppitness_private.run_import_retention(500)->>'status'), 'succeeded', 'retention ancora valida dopo la dismissione');
select * from finish();
rollback;
