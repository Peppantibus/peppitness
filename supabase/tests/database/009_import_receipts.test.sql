-- Test locale con rollback: impronte SQL = vettori TypeScript, ricevute, claim/finalize,
-- selezione esplicita e tombstone. Helper privati chiamati come proprietario (postgres),
-- cioè il ruolo delle future RPC SECURITY DEFINER 19/20; letture/eliminazioni come utente.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();
\ir import_hash_vectors.inc

-- ---------------------------------------------------------------------------
-- Privilegi, RLS e vincoli
-- ---------------------------------------------------------------------------
select ok((select relrowsecurity from pg_class where oid = 'public.import_receipts'::regclass), 'ricevute con RLS');
select ok(has_table_privilege('authenticated', 'public.import_receipts', 'select'), 'lettura delle proprie ricevute');
select ok(not has_table_privilege('authenticated', 'public.import_receipts', 'insert')
  and not has_table_privilege('authenticated', 'public.import_receipts', 'update')
  and not has_table_privilege('authenticated', 'public.import_receipts', 'delete'), 'client senza scritture dirette');
select ok(not has_table_privilege('anon', 'public.import_receipts', 'select'), 'anonimo senza ricevute');
select ok(not has_table_privilege('service_role', 'public.import_receipts', 'select')
  and not has_table_privilege('service_role', 'public.import_receipts', 'insert'), 'ruolo server Edge senza accesso alle ricevute');
select ok(has_function_privilege('authenticated', 'public.get_import_receipt(uuid)', 'execute')
  and not has_function_privilege('anon', 'public.get_import_receipt(uuid)', 'execute')
  and not has_function_privilege('service_role', 'public.get_import_receipt(uuid)', 'execute'), 'lookup solo autenticato');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'peppitness_private' and p.proname in ('canonical_json_node', 'canonical_json', 'canonical_hash', 'import_member',
    'import_command_hash', 'import_exercise_identity', 'import_content_hash_input', 'import_content_hash', 'guard_import_receipt',
    'check_import_receipt', 'tombstone_import_receipts', 'import_receipt_result', 'import_request_lock_key', 'claim_import_receipt',
    'import_uuid_text', 'finalize_import_receipt', 'import_follow', 'lock_import_selection', 'apply_import_selection')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
      or has_function_privilege('service_role', p.oid, 'execute'))), 0, 'helper privati non invocabili dai ruoli API');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'peppitness_private' and p.proname in ('claim_import_receipt', 'finalize_import_receipt', 'apply_import_selection',
    'lock_import_selection', 'canonical_json', 'import_command_hash', 'import_content_hash')), 7, 'firme condivise per 19/20 presenti');
select is((select count(*)::integer from pg_constraint where conrelid = 'public.import_receipts'::regclass and contype = 'f'
  and confrelid in ('public.workout_plans'::regclass, 'public.meal_plans'::regclass)), 0, 'nessuna FK dai piani alle ricevute');
select is((select confdeltype::text from pg_constraint where conrelid = 'public.import_receipts'::regclass and contype = 'f'
  and confrelid = 'auth.users'::regclass), 'c', 'ricevute rimosse solo con l''account');
select is((select count(*)::integer from pg_indexes where schemaname = 'public' and tablename = 'import_receipts'
  and indexdef ilike '%unique%' and indexdef ilike '%content_hash%'), 0, 'nessun unique su contentHash');
select is((select count(*)::integer from pg_trigger where tgname = 'import_receipts_tombstone'
  and tgrelid in ('public.workout_plans'::regclass, 'public.meal_plans'::regclass)), 2, 'tombstone su entrambe le sezioni');

-- ---------------------------------------------------------------------------
-- Canonicalizzazione e impronte: stessi file del test TypeScript
-- ---------------------------------------------------------------------------
select is(peppitness_private.canonical_json(input::jsonb), canonical, 'canonico SQL = TS: ' || id) from import_canonical_vectors order by id;
select is(peppitness_private.canonical_hash(input::jsonb), sha256, 'SHA-256 SQL = TS: ' || id) from import_canonical_vectors order by id;
select is(peppitness_private.import_command_hash((command->>'requestId')::uuid, command->'payload', command->'provenance', command->'selectionOptions'),
  command_hash, 'commandHash SQL = TS: ' || id) from import_hash_vectors order by id;
select is(peppitness_private.import_content_hash(command->'payload'), content_hash, 'contentHash SQL = TS: ' || id) from import_hash_vectors order by id;
select is((select count(distinct content_hash)::integer from import_hash_vectors where id in ('workout-basic', 'workout-same-content', 'workout-follow')),
  1, 'UUID tecnici, requestId e follow non cambiano il contenuto');
select isnt((select peppitness_private.import_content_hash(command->'payload') from import_hash_vectors where id = 'workout-reordered'),
  (select peppitness_private.import_content_hash(command->'payload') from import_hash_vectors where id = 'workout-basic'), 'ordine significativo');
-- Il digest del client non entra mai: cambia qualsiasi argomento, cambia l'hash del comando.
select isnt((select peppitness_private.import_command_hash((command->>'requestId')::uuid, command->'payload', command->'provenance',
    '{"follow":false,"expectedActiveRevision":null}'::jsonb) from import_hash_vectors where id = 'diet-follow-first-selection'),
  (select command_hash from import_hash_vectors where id = 'diet-follow-first-selection'), 'opzioni incluse nel commandHash');
select is(peppitness_private.canonical_json((repeat('[', 64) || repeat(']', 64))::jsonb), repeat('[', 64) || repeat(']', 64), 'profondità 64 ammessa');
select throws_ok($q$ select peppitness_private.canonical_json((repeat('[', 65) || repeat(']', 65))::jsonb) $q$, '22023', 'Canonical JSON too deep', 'profondità oltre 64 respinta');
select throws_ok($q$ select peppitness_private.import_content_hash(jsonb_set(command->'payload', '{resolved,catalog}', '[]'::jsonb))
  from import_hash_vectors where id = 'workout-basic' $q$, '22023', 'Invalid import command', 'prescrizione senza associazione respinta');
select throws_ok($q$ select peppitness_private.import_content_hash((command->'payload') #- '{resolved,title}')
  from import_hash_vectors where id = 'workout-basic' $q$, '22023', 'Invalid import command', 'membro assente non diventa null');

-- ---------------------------------------------------------------------------
-- Fixture: piani sintetici creati con le API correnti, come utente
-- ---------------------------------------------------------------------------
insert into auth.users(id, aud, role, email) values
  ('91111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'receipts-a@example.invalid'),
  ('92222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'receipts-b@example.invalid');
insert into public.exercises(id, owner_id, name, measurement_mode) values
  ('9aaaaaaa-0000-4000-8000-000000000001', '91111111-1111-4111-8111-111111111111', 'Squat', 'reps');

create function pg_temp.as_user(owner_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
$$;
grant execute on function pg_temp.as_user(uuid) to authenticated, anon;

set local role authenticated;
select pg_temp.as_user('91111111-1111-4111-8111-111111111111');
select lives_ok(format($q$ select public.save_workout_draft('9bbbbbbb-0000-4000-8000-00000000000%1$s', '9ccccccc-0000-4000-8000-00000000000%1$s', 0,
  'Programma %1$s', '', jsonb_build_array(jsonb_build_object('id', '9ddddddd-0000-4000-8000-00000000000%1$s', 'label', 'A', 'title', 'Seduta',
    'exercises', jsonb_build_array(jsonb_build_object('id', '9eeeeeee-0000-4000-8000-00000000000%1$s',
      'exercise_id', '9aaaaaaa-0000-4000-8000-000000000001', 'sets', 1, 'reps_min', 8, 'reps_max', 8))))) $q$, n), 'programma creato ' || n)
  from generate_series(1, 2) n;
select lives_ok(format($q$ select public.publish_workout_version('9ccccccc-0000-4000-8000-00000000000%s', 1, 1) $q$, n), 'programma pubblicato ' || n)
  from generate_series(1, 2) n;
select lives_ok(format($q$ insert into public.meal_plans(id, name, document) values
  ('99999999-0000-4000-8000-00000000000%1$s', 'Dieta %1$s', '{"guidance":"","days":[]}'::jsonb) $q$, n), 'piano alimentare ' || n)
  from generate_series(1, 3) n;
select pg_temp.as_user('92222222-2222-4222-8222-222222222222');
select lives_ok($q$ insert into public.meal_plans(id, name, document) values
  ('99999999-0000-4000-8000-0000000000b1', 'Dieta B', '{"guidance":"","days":[]}'::jsonb) $q$, 'piano alimentare B');
reset role;

-- Sequenza delle future RPC con i soli helper: claim -> selezione -> (piano) -> finalize.
create function pg_temp.prov(kind text) returns jsonb language sql as $$
  select jsonb_build_object('formatVersion', 'peppitness.import-provenance.v1', 'kind', kind,
    'analysis', jsonb_build_object('jobId', null, 'proposalId', '90000000-0000-4000-8000-000000000001', 'proposalVersion', 1),
    'items', '[]'::jsonb);
$$;
create function pg_temp.opts(follow boolean, expected integer default null) returns jsonb language sql as $$
  select jsonb_build_object('follow', follow, 'expectedActiveRevision', expected);
$$;
create function pg_temp.commit_diet(owner_id uuid, request_id uuid, command_hash text, plan_id uuid,
  options jsonb default pg_temp.opts(false), content_hash text default repeat('c', 64)) returns jsonb language plpgsql as $$
declare receipt jsonb; selection jsonb;
begin
  receipt := peppitness_private.claim_import_receipt(owner_id, request_id, 'diet', command_hash);
  if receipt is not null then return receipt; end if;
  perform peppitness_private.lock_import_selection(owner_id, options);
  selection := peppitness_private.apply_import_selection(owner_id, 'diet', plan_id, options);
  return peppitness_private.finalize_import_receipt(owner_id, request_id, 'diet', command_hash, content_hash, plan_id, null,
    '[]'::jsonb, selection, pg_temp.prov('diet'));
end;
$$;
create function pg_temp.commit_workout(owner_id uuid, request_id uuid, command_hash text, n integer,
  options jsonb default pg_temp.opts(false)) returns jsonb language plpgsql as $$
declare receipt jsonb; selection jsonb; plan uuid := ('9bbbbbbb-0000-4000-8000-00000000000' || n)::uuid;
begin
  receipt := peppitness_private.claim_import_receipt(owner_id, request_id, 'workout', command_hash);
  if receipt is not null then return receipt; end if;
  perform peppitness_private.lock_import_selection(owner_id, options);
  selection := peppitness_private.apply_import_selection(owner_id, 'workout', plan, options);
  return peppitness_private.finalize_import_receipt(owner_id, request_id, 'workout', command_hash, repeat('d', 64), plan,
    ('9ccccccc-0000-4000-8000-00000000000' || n)::uuid,
    '[{"ref":"9aaaaaaa-0000-4000-8000-000000000001","exerciseId":"9aaaaaaa-0000-4000-8000-000000000001","resolution":"existing"}]'::jsonb,
    selection, pg_temp.prov('workout'));
end;
$$;
-- Rollback finale dopo la ricevuta: piano, ricevuta e claim spariscono insieme.
create function pg_temp.commit_then_fail(owner_id uuid, request_id uuid) returns jsonb language plpgsql as $$
begin
  perform peppitness_private.claim_import_receipt(owner_id, request_id, 'diet', repeat('7', 64));
  insert into public.meal_plans(id, owner_id, name, document)
    values ('99999999-0000-4000-8000-000000000099', owner_id, 'Dieta annullata', '{"guidance":"","days":[]}');
  perform peppitness_private.finalize_import_receipt(owner_id, request_id, 'diet', repeat('7', 64), repeat('c', 64),
    '99999999-0000-4000-8000-000000000099', null, '[]', null, pg_temp.prov('diet'));
  raise exception using errcode = 'P0001', message = 'Simulated failure after receipt';
end;
$$;
create function pg_temp.receipt(owner_id uuid, request_id uuid) returns public.import_receipts language sql as $$
  select * from public.import_receipts r where r.owner_id = $1 and r.request_id = $2;
$$;

-- ---------------------------------------------------------------------------
-- Claim, replay, conflitto, isolamento
-- ---------------------------------------------------------------------------
select is(peppitness_private.claim_import_receipt('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000001', 'diet', repeat('1', 64)),
  null, 'richiesta nuova: claim senza scritture');
select is((select count(*)::integer from public.import_receipts), 0, 'nessuna ricevuta pending dopo il claim');
select is(pg_temp.commit_diet('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000001', repeat('1', 64),
  '99999999-0000-4000-8000-000000000001')->>'resultState', 'committed', 'ricevuta committed');
select is((select array_agg(k order by k) from jsonb_object_keys(peppitness_private.import_receipt_result(
    pg_temp.receipt('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000001'))) k),
  array['commandHash', 'contentHash', 'exerciseBindings', 'kind', 'planId', 'requestId', 'resultState', 'selection', 'versionId'],
  'forma ImportReceipt senza owner né provenienza');
select is(pg_temp.commit_diet('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000001', repeat('1', 64),
  '99999999-0000-4000-8000-000000000002'),
  peppitness_private.import_receipt_result(pg_temp.receipt('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000001')),
  'replay: stesso risultato, nessun secondo piano');
select is((select count(*)::integer from public.import_receipts), 1, 'replay senza duplicati');
select throws_ok($q$ select pg_temp.commit_diet('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000001', repeat('2', 64),
  '99999999-0000-4000-8000-000000000001') $q$, 'PT409', 'Import request conflict', 'stessa chiave, comando diverso: PT409');
select throws_ok($q$ select peppitness_private.claim_import_receipt('91111111-1111-4111-8111-111111111111',
  'e9000000-0000-4000-8000-000000000001', 'workout', repeat('1', 64)) $q$, 'PT409', 'Import request conflict', 'stessa chiave, altro dominio: PT409');
select is(pg_temp.commit_diet('92222222-2222-4222-8222-222222222222', 'e9000000-0000-4000-8000-000000000001', repeat('1', 64),
  '99999999-0000-4000-8000-0000000000b1')->>'planId', '99999999-0000-4000-8000-0000000000b1', 'stessa chiave in un altro account: operazione distinta');
select is(pg_temp.commit_diet('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000002', repeat('3', 64),
  '99999999-0000-4000-8000-000000000002')->>'contentHash', repeat('c', 64), 'stesso contenuto con nuova chiave: copia ammessa');
select is((select count(*)::integer from public.import_receipts where owner_id = '91111111-1111-4111-8111-111111111111'
  and content_hash = repeat('c', 64)), 2, 'contentHash propone duplicati, non li vieta');
select throws_ok($q$ select peppitness_private.finalize_import_receipt('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000009',
  'diet', repeat('9', 64), repeat('c', 64), '99999999-0000-4000-8000-000000000003', null, '[]', null, pg_temp.prov('diet')) $q$,
  '55000', 'Import request not claimed', 'finalize senza claim respinto');
select throws_ok($q$ select peppitness_private.claim_import_receipt('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000008', 'diet', repeat('8', 64)),
  peppitness_private.finalize_import_receipt('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000008',
    'diet', repeat('8', 64), repeat('c', 64), '99999999-0000-4000-8000-000000000098', null, '[]', null, pg_temp.prov('diet')) $q$,
  '23514', 'Import receipt needs its committed plan', 'ricevuta senza piano respinta');
select throws_ok($q$ select peppitness_private.claim_import_receipt('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000007', 'workout', repeat('8', 64)),
  peppitness_private.finalize_import_receipt('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000007',
    'workout', repeat('8', 64), repeat('d', 64), '9bbbbbbb-0000-4000-8000-000000000001', '9ccccccc-0000-4000-8000-000000000001',
    '[{"ref":"9aaaaaaa-0000-4000-8000-0000000000ff","exerciseId":"9aaaaaaa-0000-4000-8000-0000000000ff","resolution":"existing"}]', null, pg_temp.prov('workout')) $q$,
  '42501', 'Import reference not available', 'binding verso esercizio non proprio respinto');
select throws_ok($q$ select pg_temp.commit_then_fail('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000003') $q$,
  'P0001', 'Simulated failure after receipt', 'errore dopo finalize');
select is((select count(*)::integer from public.import_receipts where request_id = 'e9000000-0000-4000-8000-000000000003'), 0, 'rollback: nessuna ricevuta');
select is((select count(*)::integer from public.meal_plans where id = '99999999-0000-4000-8000-000000000099'), 0, 'rollback: nessun piano');
-- Anche un insert diretto del proprietario (fuori da finalize) non arriva al commit senza piano.
select throws_ok($q$ do $d$ begin
  insert into public.import_receipts(owner_id, request_id, kind, command_hash, content_hash, plan_id, provenance)
    values ('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-0000000000e6', 'diet', repeat('6', 64), repeat('c', 64),
      '99999999-0000-4000-8000-000000000097', pg_temp.prov('diet'));
  set constraints public.import_receipts_committed_plan immediate;
end $d$ $q$, '23514', 'Import receipt needs its committed plan', 'vincolo differito: committed solo con piano reale');

-- ---------------------------------------------------------------------------
-- Selezione esplicita
-- ---------------------------------------------------------------------------
select throws_ok($q$ select peppitness_private.import_follow('{"follow":false,"expectedActiveRevision":1}') $q$, '22023', 'Invalid import command', 'senza follow nessuna revisione');
select throws_ok($q$ select peppitness_private.import_follow('{"follow":true}') $q$, '22023', 'Invalid import command', 'opzioni incomplete');
select throws_ok($q$ select peppitness_private.import_follow('{"follow":true,"expectedActiveRevision":0}') $q$, '22023', 'Invalid import command', 'revisione non positiva');
select throws_ok($q$ select peppitness_private.import_follow('{"follow":true,"expectedActiveRevision":null,"extra":1}') $q$, '22023', 'Invalid import command', 'opzioni chiuse');
select is(peppitness_private.apply_import_selection('91111111-1111-4111-8111-111111111111', 'diet', '99999999-0000-4000-8000-000000000003', pg_temp.opts(false)),
  null, 'follow=false non tocca la selezione');
select is((select count(*)::integer from public.active_plans where owner_id = '91111111-1111-4111-8111-111111111111'), 0, 'selezione ancora assente');
select throws_ok($q$ select pg_temp.commit_diet('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000004', repeat('4', 64),
  '99999999-0000-4000-8000-000000000003', pg_temp.opts(true, 1)) $q$, 'PT409', 'Active selection conflict', 'revisione vista ma selezione assente');
select is((pg_temp.receipt('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000004')).request_id, null, 'conflitto dopo claim: nessuna ricevuta');
select is(pg_temp.commit_diet('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000004', repeat('4', 64),
  '99999999-0000-4000-8000-000000000003', pg_temp.opts(true))->'selection',
  '{"revision":1,"workoutPlanId":null,"mealPlanId":"99999999-0000-4000-8000-000000000003"}'::jsonb, 'prima selezione creata con follow');
select is(pg_temp.commit_workout('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000005', repeat('5', 64), 1,
  pg_temp.opts(true, 1))->'selection',
  '{"revision":2,"workoutPlanId":"9bbbbbbb-0000-4000-8000-000000000001","mealPlanId":"99999999-0000-4000-8000-000000000003"}'::jsonb,
  'follow scheda: revisione +1, dieta preservata');
select throws_ok($q$ select pg_temp.commit_workout('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000006', repeat('6', 64), 2,
  pg_temp.opts(true, 1)) $q$, 'PT409', 'Active selection conflict', 'revisione obsoleta: conflitto');
select throws_ok($q$ select pg_temp.commit_workout('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000006', repeat('6', 64), 2,
  pg_temp.opts(true)) $q$, 'PT409', 'Active selection conflict', 'selezione esistente non vista: conflitto');
select is((select row(revision, workout_plan_id, meal_plan_id)::text from public.active_plans where owner_id = '91111111-1111-4111-8111-111111111111'),
  row(2, '9bbbbbbb-0000-4000-8000-000000000001'::uuid, '99999999-0000-4000-8000-000000000003'::uuid)::text, 'conflitti senza effetti sulla selezione');
select is(pg_temp.commit_workout('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000006', repeat('6', 64), 2)->'selection',
  'null'::jsonb, 'follow=false: ricevuta senza selezione');
select is((select revision from public.active_plans where owner_id = '91111111-1111-4111-8111-111111111111'), 2, 'follow=false non incrementa la revisione');

-- ---------------------------------------------------------------------------
-- Lettura come utente: proprie ricevute, deleted esplicito, nessuna scrittura
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('91111111-1111-4111-8111-111111111111');
select is(public.get_import_receipt('e9000000-0000-4000-8000-000000000001')->>'planId', '99999999-0000-4000-8000-000000000001', 'A legge la propria ricevuta');
select is(public.get_import_receipt('e9000000-0000-4000-8000-0000000000ff'), null, 'ricevuta assente: null');
select is((select count(*)::integer from public.import_receipts), 5, 'RLS: solo le ricevute di A');
select throws_ok($q$ insert into public.import_receipts(owner_id, request_id, kind, command_hash, content_hash, plan_id, provenance)
  values ('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-0000000000f1', 'diet', repeat('f', 64), repeat('f', 64),
    '99999999-0000-4000-8000-000000000001', '{}') $q$, '42501', null, 'client non crea ricevute');
select throws_ok($q$ update public.import_receipts set result_state = 'deleted' $q$, '42501', null, 'client non modifica ricevute');
select throws_ok($q$ delete from public.import_receipts $q$, '42501', null, 'client non elimina ricevute');
select pg_temp.as_user('92222222-2222-4222-8222-222222222222');
select is(public.get_import_receipt('e9000000-0000-4000-8000-000000000001')->>'planId', '99999999-0000-4000-8000-0000000000b1', 'B legge solo la propria con la stessa chiave');
select is(public.get_import_receipt('e9000000-0000-4000-8000-000000000004'), null, 'B non vede ricevute di A');
select is((select count(*)::integer from public.import_receipts), 1, 'RLS: solo la ricevuta di B');
set local role anon;
select throws_ok($q$ select public.get_import_receipt('e9000000-0000-4000-8000-000000000001') $q$, '42501', null, 'anonimo respinto');
reset role;

-- ---------------------------------------------------------------------------
-- Tombstone: eliminazione singola, tutti, percorso server; vecchi retry
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('91111111-1111-4111-8111-111111111111');
select is(public.delete_meal_plans('99999999-0000-4000-8000-000000000003'), 1, 'delete RPC singola invariata');
select is(public.get_import_receipt('e9000000-0000-4000-8000-000000000004')->>'resultState', 'deleted', 'lettura espone deleted');
select is(public.get_import_receipt('e9000000-0000-4000-8000-000000000004')->'selection',
  '{"revision":1,"workoutPlanId":null,"mealPlanId":"99999999-0000-4000-8000-000000000003"}'::jsonb, 'storico della ricevuta conservato');
select is((select meal_plan_id from public.active_plans), null::uuid, 'selezione dieta svuotata dalla RPC esistente');
reset role;
select is((select row(provenance is null, deleted_at is not null)::text from public.import_receipts
  where request_id = 'e9000000-0000-4000-8000-000000000004'), '(t,t)', 'tombstone minimo: provenienza rimossa');
select is(pg_temp.commit_diet('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000004', repeat('4', 64),
  '99999999-0000-4000-8000-000000000003', pg_temp.opts(true, 3))->>'resultState', 'deleted', 'vecchio retry riceve deleted');
select is((select count(*)::integer from public.meal_plans where id = '99999999-0000-4000-8000-000000000003'), 0, 'vecchio retry non ricrea il piano');
select is((select revision from public.active_plans where owner_id = '91111111-1111-4111-8111-111111111111'), 3, 'vecchio retry non tocca la selezione');
select throws_ok($q$ select pg_temp.commit_diet('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000004', repeat('5', 64),
  '99999999-0000-4000-8000-000000000003') $q$, 'PT409', 'Import request conflict', 'dopo tombstone il payload diverso resta conflitto');
set local role authenticated;
select pg_temp.as_user('91111111-1111-4111-8111-111111111111');
select is(public.delete_workout_plans(null), 2, 'delete di tutti i programmi');
reset role;
select is((select array_agg(result_state order by request_id) from public.import_receipts where owner_id = '91111111-1111-4111-8111-111111111111'
  and kind = 'workout'), array['deleted', 'deleted'], 'tombstone per ogni programma eliminato');
select is((select version_id from public.import_receipts where request_id = 'e9000000-0000-4000-8000-000000000005'),
  '9ccccccc-0000-4000-8000-000000000001'::uuid, 'versione conservata nel tombstone');
select is((select array_agg(result_state order by request_id) from public.import_receipts where owner_id = '91111111-1111-4111-8111-111111111111'
  and kind = 'diet' and request_id in ('e9000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000002')),
  array['committed', 'committed'], 'altra sezione invariata');
delete from public.meal_plans where id = '99999999-0000-4000-8000-000000000002';
select is((pg_temp.receipt('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000002')).result_state, 'deleted',
  'tombstone anche fuori dalle RPC');
set local role authenticated;
select pg_temp.as_user('91111111-1111-4111-8111-111111111111');
select is(public.delete_meal_plans(null), 1, 'delete di tutti i piani alimentari');
reset role;
select is((pg_temp.receipt('91111111-1111-4111-8111-111111111111', 'e9000000-0000-4000-8000-000000000001')).result_state, 'deleted', 'delete all: tombstone');
select is((pg_temp.receipt('92222222-2222-4222-8222-222222222222', 'e9000000-0000-4000-8000-000000000001')).result_state, 'committed', 'ricevuta di B intatta');
select is((select count(*)::integer from public.workout_sessions), 0, 'nessun record di diario creato');

select throws_ok($q$ update public.import_receipts set command_hash = repeat('0', 64) where request_id = 'e9000000-0000-4000-8000-000000000001'
  and owner_id = '92222222-2222-4222-8222-222222222222' $q$, '23514', 'Import receipt is immutable', 'identità della ricevuta immutabile');
select throws_ok($q$ update public.import_receipts set result_state = 'committed', deleted_at = null, provenance = '{}'
  where request_id = 'e9000000-0000-4000-8000-000000000004' $q$, '23514', 'Import receipt is immutable', 'tombstone non riattivabile');
select throws_ok($q$ delete from public.import_receipts where request_id = 'e9000000-0000-4000-8000-000000000004' $q$,
  '55000', 'Import receipts are kept for the account lifetime', 'tombstone non eliminabile finché esiste l''account');
select lives_ok($q$ set constraints all immediate $q$, 'vincoli differiti rispettati da tutte le ricevute');

-- ---------------------------------------------------------------------------
-- Cancellazione account: dati personali e ricevute rimossi
-- ---------------------------------------------------------------------------
delete from auth.users where id = '91111111-1111-4111-8111-111111111111';
select is((select count(*)::integer from public.import_receipts where owner_id = '91111111-1111-4111-8111-111111111111'), 0, 'account eliminato: ricevute rimosse');
select is((select count(*)::integer from public.import_receipts where owner_id = '92222222-2222-4222-8222-222222222222'), 1, 'altro account intatto');

select * from finish();
rollback;
