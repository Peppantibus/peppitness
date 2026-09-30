-- Task 20. commit_diet_import sul DB locale con rollback finale. Comandi prodotti dal mapper 10
-- (include generato), job reali del proprietario, chiamate come utente autenticato (JWT).
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();
\ir import_commit_fixtures.inc

-- ---------------------------------------------------------------------------
-- Privilegi e metadati
-- ---------------------------------------------------------------------------
select ok(has_function_privilege('authenticated', 'public.commit_diet_import(uuid,jsonb,jsonb,jsonb)', 'execute'), 'RPC eseguibile da authenticated');
select ok(not has_function_privilege('anon', 'public.commit_diet_import(uuid,jsonb,jsonb,jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.commit_diet_import(uuid,jsonb,jsonb,jsonb)', 'execute'), 'RPC negata ad anon e service_role');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.commit_diet_import(uuid,jsonb,jsonb,jsonb)'::regprocedure),
  'SECURITY DEFINER con search_path vuoto');
select ok(not has_function_privilege('authenticated', 'peppitness_private.import_diet_targets(jsonb)', 'execute')
  and not has_function_privilege('service_role', 'peppitness_private.import_diet_targets(jsonb)', 'execute')
  and not has_function_privilege('anon', 'peppitness_private.import_diet_targets(jsonb)', 'execute'), 'validatore privato');
select is((select count(*)::integer from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname ~ '(food|nutri|meal_plan_(day|meal|item))'), 0, 'nessuna nuova tabella nutrizionale');
select is((select count(*)::integer from import_commit_fixtures where kind = 'diet'), 3, 'corpus dieta del mapping 10 disponibile');

-- ---------------------------------------------------------------------------
-- Fixture: account, programma seguito, diario preesistente, job pronti
-- ---------------------------------------------------------------------------
insert into auth.users(id, aud, role, email) values
  ('20111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'diet-import-a@example.invalid'),
  ('20222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'diet-import-b@example.invalid');
insert into public.exercises(id, owner_id, name, measurement_mode) values
  ('2a000000-0000-4000-8000-0000000000aa', '20111111-1111-4111-8111-111111111111', 'Squat', 'reps');

create temporary table commit_state(name text primary key, value jsonb);
create temporary table commit_jobs(fixture text, owner_id uuid, created jsonb, primary key (fixture, owner_id));
grant select, insert, update on commit_state, commit_jobs to authenticated, service_role, anon;

create function pg_temp.as_user(owner_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.cmd(fixture text, owner_id uuid default '20111111-1111-4111-8111-111111111111', tag text default null) returns jsonb
language sql as $$
  select jsonb_set(case when tag is null then f.command
      else regexp_replace(f.command::text, '"(e?)(19|20)([0-9a-f]{5,6}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12})"', '"\1' || tag || '\3"', 'g')::jsonb end,
    '{provenance,analysis,jobId}', to_jsonb((j.created#>>'{job,jobId}')::uuid))
  from pg_temp.import_commit_fixtures f join pg_temp.commit_jobs j on j.fixture = f.id and j.owner_id = $2 where f.id = $1;
$$;
create function pg_temp.opts(command jsonb, follow boolean, expected integer default null) returns jsonb language sql as $$
  select jsonb_set(command, '{selectionOptions}', jsonb_build_object('follow', follow, 'expectedActiveRevision', expected));
$$;
create function pg_temp.commit(command jsonb) returns jsonb language sql as $$
  select public.commit_diet_import((command->>'requestId')::uuid, command->'payload', command->'provenance', command->'selectionOptions');
$$;
-- Documento di dimensione esatta (JSON compatto UTF-8): pasti con note a 4 byte per carattere,
-- poi istruzioni per il resto; `wide` usa caratteri a 2 byte quando possibile.
create function pg_temp.sized(command jsonb, target integer, wide boolean) returns jsonb language plpgsql as $$
declare doc jsonb := command #> '{payload,resolved,plan,document}'; missing integer;
begin
  doc := jsonb_set(doc, '{guidance}', '""');
  doc := jsonb_set(doc, '{days,0,meals}', (doc #> '{days,0,meals}') || (select jsonb_agg(jsonb_build_object('id',
      format('2c000000-0000-4000-8000-%s', lpad(n::text, 12, '0')), 'name', 'Pasto ' || n, 'time', '', 'foods', '[]'::jsonb,
      'alternatives', '["Frutta"]'::jsonb, 'additions', '[]'::jsonb, 'note', repeat(U&'\+01F600', 4000))) from generate_series(1, 11) n));
  missing := target - octet_length(convert_to(peppitness_private.canonical_json(doc), 'UTF8'));
  if missing < 0 or missing > 16000 then raise exception 'sized: %', missing; end if;
  doc := jsonb_set(doc, '{guidance}', to_jsonb(case when wide then repeat(U&'\00E8', missing / 2) || repeat('a', missing % 2) else repeat('a', missing) end));
  return jsonb_set(command, '{payload,resolved,plan,document}', doc);
end;
$$;
create function pg_temp.footprint(owner_id uuid) returns text language sql as $$
  select row((select count(*) from public.meal_plans where owner_id = $1), (select count(*) from public.import_receipts where owner_id = $1),
    (select row(revision, workout_plan_id, meal_plan_id)::text from public.active_plans where owner_id = $1),
    (select md5(coalesce(string_agg(to_jsonb(l)::text, '|' order by l.id), '')) from public.meal_logs l where l.owner_id = $1))::text;
$$;
grant execute on function pg_temp.as_user(uuid), pg_temp.cmd(text, uuid, text), pg_temp.opts(jsonb, boolean, integer), pg_temp.commit(jsonb),
  pg_temp.sized(jsonb, integer, boolean) to authenticated, anon;
grant select on import_commit_fixtures, import_commit_catalog to anon;

-- Programma seguito, piano manuale e un pasto già registrato: il diario non deve cambiare.
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
select lives_ok($q$ select public.save_workout_draft('2a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-000000000002', 0,
  'Programma seguito', '', '[{"id":"2a000000-0000-4000-8000-000000000003","label":"A","title":"Seduta","exercises":[{"id":"2a000000-0000-4000-8000-000000000004",
  "exercise_id":"2a000000-0000-4000-8000-0000000000aa","sets":3,"reps_min":5,"reps_max":5}]}]') $q$, 'programma salvato');
select lives_ok($q$ select public.publish_workout_version('2a000000-0000-4000-8000-000000000002', 1, 1) $q$, 'programma pubblicato');
select lives_ok($q$ insert into public.meal_plans(id, name, document) values ('2a000000-0000-4000-8000-0000000000d1', 'Dieta manuale',
  '{"guidance":"","days":[{"id":"2a000000-0000-4000-8000-0000000000d2","name":"Tutti i giorni","dayType":"any","note":"","meals":[{"id":"2a000000-0000-4000-8000-0000000000d3",
  "name":"Colazione","time":"","foods":[{"name":"Yogurt","quantity":"125 g"}],"alternatives":[],"additions":[],"note":""}]}]}') $q$, 'piano manuale');
select lives_ok($q$ insert into public.active_plans(workout_plan_id, meal_plan_id) values ('2a000000-0000-4000-8000-000000000001', '2a000000-0000-4000-8000-0000000000d1') $q$,
  'selezione di scheda e dieta');
select lives_ok($q$ insert into public.meal_logs(diary_date, meal_id, meal_plan_id, status, note, day_type, meal_snapshot) values ('2026-09-29',
  '2a000000-0000-4000-8000-0000000000d3', '2a000000-0000-4000-8000-0000000000d1', 'followed', '', 'rest', '{"id":"2a000000-0000-4000-8000-0000000000d3","name":"Colazione"}') $q$,
  'pasto già registrato');
reset role;
insert into commit_state values ('logs', to_jsonb((select md5(string_agg(to_jsonb(l)::text, '|' order by l.id)) from public.meal_logs l))),
  ('manual-plan', to_jsonb((select (to_jsonb(m) - 'updated_at')::text from public.meal_plans m where m.id = '2a000000-0000-4000-8000-0000000000d1')));

set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into commit_jobs select f.id, u.owner_id, public.create_import_job(u.owner_id, gen_random_uuid(), f.kind,
    encode(sha256(convert_to('input:' || f.id || u.owner_id, 'UTF8')), 'hex'), encode(sha256(convert_to('document:' || f.id || u.owner_id, 'UTF8')), 'hex'),
    jsonb_build_object('reader', f.document->>'readerVersion', 'schema', '1.0', 'prompt', 'test/1', 'provider', 'synthetic', 'model', 'synthetic', 'rules', 'test/1'),
    f.document)
  from import_commit_fixtures f cross join (values ('20111111-1111-4111-8111-111111111111'::uuid), ('20222222-2222-4222-8222-222222222222'::uuid)) u(owner_id);
update commit_jobs j set created = public.complete_import_job(j.owner_id, (j.created#>>'{job,jobId}')::uuid, (j.created->>'revision')::integer,
    (j.created->>'leaseToken')::uuid, (j.created->>'draftRevision')::integer, jsonb_build_object('extraction', f.extraction, 'validationIssues', '[]'::jsonb,
      'usageSummary', jsonb_build_object('providerCalls', 0, 'inputTokens', null, 'outputTokens', null, 'reasoningTokens', null, 'cached', false, 'costEstimate', null)))
  from import_commit_fixtures f where f.id = j.fixture;
select is((select count(*)::integer from commit_jobs where created#>>'{job,status}' = 'ready'), (select 2 * count(*)::integer from import_commit_fixtures), 'job pronti');
reset role;

-- ---------------------------------------------------------------------------
-- Autenticazione
-- ---------------------------------------------------------------------------
set local role anon;
select throws_ok($q$ select pg_temp.commit(pg_temp.cmd('diet-spec-example')) $q$, '42501', null, 'anonimo senza privilegio');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($q$ select pg_temp.commit(pg_temp.cmd('diet-spec-example')) $q$, '42501', 'Authentication required', 'JWT senza utente respinto');
reset role;

-- ---------------------------------------------------------------------------
-- Corpus 10: piano salvato identico al mapping, nessun effetto sul diario
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
insert into commit_state select 'receipt:' || f.id, pg_temp.commit(pg_temp.cmd(f.id)) from import_commit_fixtures f where f.kind = 'diet';
reset role;
select ok(r.value->>'resultState' = 'committed' and r.value->>'kind' = 'diet' and r.value->'versionId' = 'null'::jsonb
    and r.value->'exerciseBindings' = '[]'::jsonb and r.value->'selection' = 'null'::jsonb
    and r.value->>'planId' = f.command#>>'{payload,resolved,plan,id}', 'ricevuta dieta: piano prenotato, nessuna versione o selezione: ' || f.id)
  from import_commit_fixtures f join commit_state r on r.name = 'receipt:' || f.id order by f.id;
select is(r.value->>'contentHash', f.content_hash, 'contentHash SQL = TypeScript: ' || f.id)
  from import_commit_fixtures f join commit_state r on r.name = 'receipt:' || f.id order by f.id;
select is(r.value->>'commandHash', peppitness_private.import_command_hash((c->>'requestId')::uuid, c->'payload', c->'provenance', c->'selectionOptions'),
    'commandHash dei quattro argomenti: ' || f.id)
  from import_commit_fixtures f join commit_state r on r.name = 'receipt:' || f.id, pg_temp.cmd(f.id) c order by f.id;
select is(jsonb_build_object('name', m.name, 'document', m.document), f.expected, 'nome e documento identici al mapping 10: ' || f.id)
  from import_commit_fixtures f join public.meal_plans m on m.id = (f.command#>>'{payload,resolved,plan,id}')::uuid order by f.id;
select ok(m.owner_id = '20111111-1111-4111-8111-111111111111' and m.revision = 1 and m.archived_at is null, 'piano nuovo dell''account: ' || f.id)
  from import_commit_fixtures f join public.meal_plans m on m.id = (f.command#>>'{payload,resolved,plan,id}')::uuid order by f.id;
-- Alternative, aggiunte con condizione e quantità vuote confermate restano testo intatto.
select ok((select bool_or(meal->'alternatives' <> '[]'::jsonb) and bool_or(meal->'additions' <> '[]'::jsonb)
    from import_commit_fixtures f, jsonb_array_elements(f.expected#>'{document,days}') d, jsonb_array_elements(d->'meals') meal where f.kind = 'diet'),
  'corpus con alternative e aggiunte');
select ok((select bool_or(food->>'quantity' = '') from import_commit_fixtures f, jsonb_array_elements(f.expected#>'{document,days}') d,
    jsonb_array_elements(d->'meals') meal, jsonb_array_elements(meal->'foods') food where f.id = 'diet-reviewed-conditions'), 'quantità confermata vuota salvata come stringa vuota');
select is((select md5(string_agg(to_jsonb(l)::text, '|' order by l.id)) from public.meal_logs l), (select value #>> '{}' from commit_state where name = 'logs'),
  'diario pasti invariato');
select is((select row(revision, workout_plan_id, meal_plan_id)::text from public.active_plans where owner_id = '20111111-1111-4111-8111-111111111111'),
  row(1, '2a000000-0000-4000-8000-000000000001'::uuid, '2a000000-0000-4000-8000-0000000000d1'::uuid)::text, 'follow=false: selezione invariata');
select is((select (to_jsonb(m) - 'updated_at')::text from public.meal_plans m where m.id = '2a000000-0000-4000-8000-0000000000d1'),
  (select value #>> '{}' from commit_state where name = 'manual-plan'), 'piano manuale invariato');

-- ---------------------------------------------------------------------------
-- Replay, conflitti e copie esplicite
-- ---------------------------------------------------------------------------
insert into commit_state values ('after-corpus', to_jsonb(pg_temp.footprint('20111111-1111-4111-8111-111111111111')));
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
select is(pg_temp.commit(pg_temp.cmd('diet-reviewed-conditions')), (select value from commit_state where name = 'receipt:diet-reviewed-conditions'),
  'stesso comando: stessa ricevuta');
select throws_ok($q$ select pg_temp.commit(jsonb_set(pg_temp.cmd('diet-reviewed-conditions'), '{payload,resolved,plan,name}', '"Altro nome"')) $q$,
  'PT409', 'Import request conflict', 'stessa chiave, payload diverso: PT409');
select throws_ok($q$ select pg_temp.commit(jsonb_set(pg_temp.cmd('diet-reviewed-conditions'), '{requestId}', '"e9999999-0000-4000-8000-000000000011"')) $q$,
  'PT409', 'Import request conflict', 'nuova chiave con piano esistente: nessun upsert');
select throws_ok($q$ select pg_temp.commit((select replace(c::text, c#>>'{payload,resolved,plan,id}', '2a000000-0000-4000-8000-0000000000d1')::jsonb
  from pg_temp.cmd('diet-spec-example', tag => '31') c)) $q$, 'PT409', 'Import request conflict', 'ID di un piano manuale: nessuna sovrascrittura');
reset role;
select is(pg_temp.footprint('20111111-1111-4111-8111-111111111111'), (select value #>> '{}' from commit_state where name = 'after-corpus'),
  'replay e conflitti: nessuna scrittura');
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
insert into commit_state values ('copy', pg_temp.commit(pg_temp.cmd('diet-spec-example', tag => '32')));
reset role;
select ok((select value->>'contentHash' = (select value->>'contentHash' from commit_state where name = 'receipt:diet-spec-example')
    and value->>'planId' <> (select value->>'planId' from commit_state where name = 'receipt:diet-spec-example') from commit_state where name = 'copy'),
  'stesso sourceHash e contenuto con nuova chiave: copia esplicita ammessa');
select is((select count(*)::integer from public.meal_plans where owner_id = '20111111-1111-4111-8111-111111111111'
  and name = (select command#>>'{payload,resolved,plan,name}' from import_commit_fixtures where id = 'diet-spec-example')),
  (select count(*)::integer + 1 from import_commit_fixtures where command#>>'{payload,resolved,plan,name}' =
    (select command#>>'{payload,resolved,plan,name}' from import_commit_fixtures where id = 'diet-spec-example')), 'stesso titolo, piani diversi');

-- ---------------------------------------------------------------------------
-- Limiti reali: guard import sul JSON compatto, tetto jsonb testuale della tabella
-- ---------------------------------------------------------------------------
insert into commit_state select 'size:' || x.label, pg_temp.sized(pg_temp.cmd('diet-spec-example', tag => x.tag), x.bytes, x.wide)
  from (values ('ascii-180000', '41', 180000, false), ('ascii-180001', '42', 180001, false), ('wide-180000', '43', 180000, true), ('wide-180001', '44', 180001, true)) x(label, tag, bytes, wide);
select is((select octet_length(convert_to(peppitness_private.canonical_json(value #> '{payload,resolved,plan,document}'), 'UTF8')) from commit_state where name = 'size:' || x),
    b, 'documento di prova ' || x)
  from (values ('ascii-180000', 180000), ('ascii-180001', 180001), ('wide-180000', 180000), ('wide-180001', 180001)) v(x, b);
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
select is(pg_temp.commit((select value from commit_state where name = 'size:ascii-180000'))->>'resultState', 'committed', '180000 byte compatti accettati');
select is(pg_temp.commit((select value from commit_state where name = 'size:wide-180000'))->>'resultState', 'committed', '180000 byte con Unicode multibyte accettati');
select throws_ok($q$ select pg_temp.commit((select value from commit_state where name = 'size:ascii-180001')) $q$, '22023', 'Invalid import command', '180001 byte respinti');
select throws_ok($q$ select pg_temp.commit((select value from commit_state where name = 'size:wide-180001')) $q$, '22023', 'Invalid import command', '180001 byte multibyte respinti');
reset role;
select ok((select octet_length(m.document::text) between 180001 and 262144 from public.meal_plans m
    where m.id = (select (value #>> '{payload,resolved,plan,id}')::uuid from commit_state where name = 'size:ascii-180000')),
  'jsonb testuale più lungo del compatto, entro i 262144 byte della tabella');
select is((select m.document from public.meal_plans m where m.id = (select (value #>> '{payload,resolved,plan,id}')::uuid from commit_state where name = 'size:wide-180000')),
  (select value #> '{payload,resolved,plan,document}' from commit_state where name = 'size:wide-180000'), 'documento grande salvato identico');

-- ---------------------------------------------------------------------------
-- Comando non conforme: 22023 prima di ogni scrittura
-- ---------------------------------------------------------------------------
insert into commit_state values ('before-invalid', to_jsonb(pg_temp.footprint('20111111-1111-4111-8111-111111111111')));
create temporary table invalid_commands(label text, command jsonb);
grant select on invalid_commands to authenticated;
insert into invalid_commands select label, command from (values
  ('chiave sconosciuta nel documento', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,calories}', '1800')),
  ('chiave sconosciuta nel pasto', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,days,0,meals,0,evidence}', '[]')),
  ('chiave sconosciuta nell''alimento', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,days,0,meals,0,foods,0,grams}', '30')),
  ('provenienza dentro il documento', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,provenance}', '{}')),
  ('campo mancante', pg_temp.cmd('diet-reviewed-conditions', tag => '51') #- '{payload,resolved,plan,document,days,0,meals,0,time}'),
  ('mode diverso da create_new', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,mode}', '"update"')),
  ('dominio sbagliato', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,kind}', '"workout"')),
  ('protocollo sconosciuto', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,protocolVersion}', '"peppitness.import-commit.v0"')),
  -- Senza toccare la provenienza: il solo controllo che respinge è quello del documento.
  ('piano senza giornate', (select jsonb_set(jsonb_set(c, '{payload,resolved,plan,document,days}', '[]'), '{provenance,items}',
    (select jsonb_agg(i) from jsonb_array_elements(c#>'{provenance,items}') i where i->'targetId' = 'null'::jsonb))
    from pg_temp.cmd('diet-reviewed-conditions', tag => '51') c)),
  ('giornata senza pasti', jsonb_insert(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,days,-1}',
    '{"id":"51000000-0000-4000-8000-0000000000e1","name":"Giornata vuota","dayType":"any","note":"","meals":[]}', true)),
  ('tipo di giornata ignoto', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,days,0,dayType}', 'null')),
  ('tipo di giornata fuori elenco', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,days,0,dayType}', '"weekend"')),
  ('nome con spazio iniziale', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,name}', '" Dieta"')),
  ('nome del pasto solo spazi Unicode', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,days,0,meals,0,name}',
    to_jsonb(U&'\3000\00A0'::text))),
  ('alternativa vuota', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,days,0,meals,0,alternatives}', '[" "]')),
  ('alternativa oltre 500 caratteri', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,days,0,meals,0,alternatives}',
    jsonb_build_array(repeat('x', 501)))),
  ('quantità oltre 60 caratteri', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,days,0,meals,0,foods,0,quantity}',
    to_jsonb(repeat('1', 61)))),
  ('quantità numerica', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,days,0,meals,0,foods,0,quantity}', '30')),
  ('carattere di controllo', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{payload,resolved,plan,document,guidance}', to_jsonb(E'a\u0008b'::text))),
  ('più di 60 alimenti', (select jsonb_set(c, '{payload,resolved,plan,document,days,0,meals,0,foods}',
    (select jsonb_agg(jsonb_build_object('name', 'Alimento ' || n, 'quantity', '')) from generate_series(1, 61) n)) from pg_temp.cmd('diet-reviewed-conditions', tag => '51') c)),
  ('più di 14 giornate', (select jsonb_set(c, '{payload,resolved,plan,document,days}', (select jsonb_agg(jsonb_set(c#>'{payload,resolved,plan,document,days,0}', '{id}',
    to_jsonb(format('51000000-0000-4000-8000-%s', lpad(n::text, 12, '0'))))) from generate_series(1, 15) n)) from pg_temp.cmd('diet-reviewed-conditions', tag => '51') c)),
  ('ID di giornata ripetuto', (select jsonb_set(c, '{payload,resolved,plan,document,days,0,meals,0,id}', c#>'{payload,resolved,plan,document,days,0,id}')
    from pg_temp.cmd('diet-reviewed-conditions', tag => '51') c)),
  ('provenienza di un altro dominio', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{provenance,analysis,schemaId}', '"peppitness.workout-extraction.v1"')),
  ('fonte senza job', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{provenance,analysis,jobId}', 'null')),
  ('lettore diverso dal job', jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '51'), '{provenance,analysis,source,readerVersion}', '"altro-lettore/2"')),
  ('alimento verso una giornata', (select jsonb_set(c, array['provenance', 'items', (x.i0 - 1)::text, 'targetId'], c#>'{payload,resolved,plan,document,days,0,id}')
    from pg_temp.cmd('diet-reviewed-conditions', tag => '51') c, jsonb_array_elements(c#>'{provenance,items}') with ordinality x(item, i0)
    where x.item->>'sourcePointer' ~ '/foods/' limit 1)),
  ('quantità svuotata senza decisione', (select jsonb_set(c, array['provenance', 'items', (x.i0 - 1)::text, 'decisions'], '[]')
    from pg_temp.cmd('diet-reviewed-conditions', tag => '51') c, jsonb_array_elements(c#>'{provenance,items}') with ordinality x(item, i0)
    where x.item->'decisions' @> '[{"field":"quantityText"}]' limit 1)),
  ('alimento cambiato senza decisione', (select jsonb_set(c, '{payload,resolved,plan,document,days,0,meals,0,foods,0,quantity}', '"999 g"')
    from pg_temp.cmd('diet-spec-example', tag => '51') c))
) v(label, command);
select ok((select count(*) = 28 and bool_and(command is not null) from invalid_commands), 'comandi non conformi preparati (corpus)');
-- Quantità assente nella fonte: '' solo con una decisione sullo stesso campo. Job con la stessa fonte
-- e l'estrazione in cui la quantità del primo alimento è null (nessun alimento così nel corpus).
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into commit_jobs select 'diet-null-quantity', '20111111-1111-4111-8111-111111111111', public.create_import_job('20111111-1111-4111-8111-111111111111',
    gen_random_uuid(), 'diet', repeat('1', 64), repeat('2', 64), jsonb_build_object('reader', f.document->>'readerVersion', 'schema', '1.0', 'prompt', 'test/1',
      'provider', 'synthetic', 'model', 'synthetic', 'rules', 'test/1'), f.document)
  from import_commit_fixtures f where f.id = 'diet-spec-example';
update commit_jobs j set created = public.complete_import_job(j.owner_id, (j.created#>>'{job,jobId}')::uuid, (j.created->>'revision')::integer,
    (j.created->>'leaseToken')::uuid, (j.created->>'draftRevision')::integer, jsonb_build_object('extraction',
      jsonb_set(f.extraction, '{days,0,meals,0,foods,0,quantityText}', 'null'), 'validationIssues', '[]'::jsonb,
      'usageSummary', jsonb_build_object('providerCalls', 0, 'inputTokens', null, 'outputTokens', null, 'reasoningTokens', null, 'cached', false, 'costEstimate', null)))
  from import_commit_fixtures f where f.id = 'diet-spec-example' and j.fixture = 'diet-null-quantity';
reset role;
insert into commit_state select 'null-quantity:' || x.label, jsonb_set(jsonb_set(jsonb_set(pg_temp.cmd('diet-spec-example', tag => x.tag),
    '{provenance,analysis,jobId}', to_jsonb((select (created#>>'{job,jobId}')::uuid from commit_jobs where fixture = 'diet-null-quantity'))),
    '{payload,resolved,plan,document,days,0,meals,0,foods,0,quantity}', '""'),
    array['provenance', 'items', (select (x2.i - 1)::text from import_commit_fixtures f, jsonb_array_elements(f.command#>'{provenance,items}') with ordinality x2(item, i)
      where f.id = 'diet-spec-example' and x2.item->>'sourcePointer' = '/days/0/meals/0/foods/0'), 'decisions'], x.decisions)
  from (values ('unconfirmed', '53', '[{"field":"name","reason":"user_edit"}]'::jsonb),
    ('confirmed', '54', '[{"field":"quantityText","reason":"confirmed_missing"}]'::jsonb)) x(label, tag, decisions);
insert into invalid_commands select 'quantità assente senza conferma', value from commit_state where name = 'null-quantity:unconfirmed';
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
select throws_ok(format('select pg_temp.commit(%L::jsonb)', command), '22023', 'Invalid import command', 'respinto: ' || label) from invalid_commands order by label;
-- Riferimenti altrui e job scaduto.
select throws_ok($q$ select pg_temp.commit(jsonb_set(pg_temp.cmd('diet-reviewed-conditions', tag => '52'), '{provenance,analysis,jobId}',
  to_jsonb((select (created#>>'{job,jobId}')::uuid from commit_jobs where fixture = 'diet-reviewed-conditions' and owner_id = '20222222-2222-4222-8222-222222222222')))) $q$,
  '42501', 'Import reference not available', 'job di B respinto');
select pg_temp.as_user('20222222-2222-4222-8222-222222222222');
select throws_ok($q$ select pg_temp.commit(pg_temp.cmd('diet-reviewed-conditions', tag => '52')) $q$, '42501', 'Import reference not available', 'B non usa il job di A');
select is((select count(*)::integer from public.meal_plans), 0, 'RLS: B non vede i piani di A');
select is(public.get_import_receipt((select (value->>'requestId')::uuid from commit_state where name = 'receipt:diet-spec-example')), null, 'B non vede la ricevuta di A');
reset role;
update public.import_drafts set expires_at = now() - interval '1 second', revision = revision + 1
  where job_id = (select (created#>>'{job,jobId}')::uuid from commit_jobs where fixture = 'diet-alternatives-additions' and owner_id = '20111111-1111-4111-8111-111111111111');
update public.import_jobs set expires_at = now() - interval '1 second', revision = revision + 1
  where id = (select (created#>>'{job,jobId}')::uuid from commit_jobs where fixture = 'diet-alternatives-additions' and owner_id = '20111111-1111-4111-8111-111111111111');
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
select throws_ok($q$ select pg_temp.commit(pg_temp.cmd('diet-alternatives-additions', tag => '52')) $q$, 'PT410', 'Import analysis expired', 'job scaduto: errore chiaro prima delle scritture');
select is(pg_temp.commit(pg_temp.cmd('diet-alternatives-additions')), (select value from commit_state where name = 'receipt:diet-alternatives-additions'),
  'risposta persa dopo la scadenza del job: stessa ricevuta, nessuna nuova analisi');
reset role;
select is(pg_temp.footprint('20111111-1111-4111-8111-111111111111'), (select value #>> '{}' from commit_state where name = 'before-invalid'),
  'comandi respinti: nessun piano, ricevuta o selezione');
select is(pg_temp.footprint('20222222-2222-4222-8222-222222222222'), row(0, 0, null::text, md5(''))::text, 'B senza effetti');
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
select is(pg_temp.commit((select value from commit_state where name = 'null-quantity:confirmed'))->>'resultState', 'committed',
  'quantità assente confermata: accettata');
reset role;
select is((select m.document #> '{days,0,meals,0,foods,0,quantity}' from public.meal_plans m where m.id = (select (value #>> '{payload,resolved,plan,id}')::uuid
  from commit_state where name = 'null-quantity:confirmed')), '""'::jsonb, 'quantità confermata salvata come stringa vuota');
update commit_state set value = to_jsonb(pg_temp.footprint('20111111-1111-4111-8111-111111111111')) where name = 'before-invalid';

-- ---------------------------------------------------------------------------
-- Selezione esplicita e rollback tardivi
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
select throws_ok($q$ select pg_temp.commit(pg_temp.opts(pg_temp.cmd('diet-spec-example', tag => '61'), true)) $q$, 'PT409', 'Active selection conflict',
  'selezione esistente non vista: conflitto');
select throws_ok($q$ select pg_temp.commit(pg_temp.opts(pg_temp.cmd('diet-spec-example', tag => '61'), true, 9)) $q$, 'PT409', 'Active selection conflict',
  'revisione obsoleta: conflitto');
reset role;
create function public.test_011_late_failure() returns trigger language plpgsql as $$
begin raise exception using errcode = 'P0001', message = 'Simulated late failure'; end;
$$;
create trigger test_011_selection before update on public.active_plans for each row execute function public.test_011_late_failure();
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
select throws_ok($q$ select pg_temp.commit(pg_temp.opts(pg_temp.cmd('diet-spec-example', tag => '62'), true, 1)) $q$, 'P0001', 'Simulated late failure',
  'errore sulla selezione dopo l''inserimento del piano');
reset role;
drop trigger test_011_selection on public.active_plans;
create trigger test_011_receipt before insert on public.import_receipts for each row execute function public.test_011_late_failure();
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
select throws_ok($q$ select pg_temp.commit(pg_temp.opts(pg_temp.cmd('diet-spec-example', tag => '63'), true, 1)) $q$, 'P0001', 'Simulated late failure',
  'errore sulla ricevuta, ultima scrittura');
reset role;
drop trigger test_011_receipt on public.import_receipts;
select is(pg_temp.footprint('20111111-1111-4111-8111-111111111111'), (select value #>> '{}' from commit_state where name = 'before-invalid'),
  'rollback tardivi: piano, selezione e ricevuta annullati insieme');
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
insert into commit_state values ('follow', pg_temp.commit(pg_temp.opts(pg_temp.cmd('diet-spec-example', tag => '64'), true, 1)));
reset role;
select is((select value->'selection' from commit_state where name = 'follow'),
  jsonb_build_object('revision', 2, 'workoutPlanId', '2a000000-0000-4000-8000-000000000001', 'mealPlanId', (select value->'planId' from commit_state where name = 'follow')),
  'follow: solo meal_plan_id, revisione +1, programma seguito preservato');
select is((select md5(string_agg(to_jsonb(l)::text, '|' order by l.id)) from public.meal_logs l), (select value #>> '{}' from commit_state where name = 'logs'),
  'nuova selezione: pasti già registrati invariati');

-- Registrazione futura sul piano importato; l'eliminazione del piano conserva il diario.
set local role authenticated;
select pg_temp.as_user('20111111-1111-4111-8111-111111111111');
select lives_ok(format($q$ insert into public.meal_logs(diary_date, meal_id, meal_plan_id, status, note, day_type, meal_snapshot) values ('2026-10-01', %L, %L,
  'followed', '', 'training', %L) $q$, m->>'id', f.value->>'planId', jsonb_build_object('id', m->'id', 'name', m->'name', 'alternatives', m->'alternatives', 'additions', m->'additions')),
  'pasto registrato sul piano importato')
  from commit_state f, public.meal_plans p, jsonb_array_elements(p.document #> '{days,0,meals}') with ordinality x(m, i)
  where f.name = 'follow' and p.id = (f.value->>'planId')::uuid and x.i = 1;
select is(public.delete_meal_plans((select (value->>'planId')::uuid from commit_state where name = 'follow')), 1, 'piano importato eliminato');
select is(pg_temp.commit(pg_temp.opts(pg_temp.cmd('diet-spec-example', tag => '64'), true, 1))->>'resultState', 'deleted', 'vecchio retry: deleted');
select throws_ok($q$ select pg_temp.commit(jsonb_set(pg_temp.cmd('diet-spec-example', tag => '64'), '{requestId}',
  '"e9999999-0000-4000-8000-000000000012"')) $q$, 'PT409', 'Import request conflict', 'nuova chiave con l''ID del piano eliminato: nessuna ricreazione');
reset role;
select is((select count(*)::integer from public.meal_plans where id = (select (value->>'planId')::uuid from commit_state where name = 'follow')), 0, 'piano non ricreato');
select is((select count(*)::integer from public.meal_logs where meal_plan_id = (select (value->>'planId')::uuid from commit_state where name = 'follow')), 1,
  'registrazione conservata dopo l''eliminazione del piano');
select is((select row(revision, workout_plan_id, meal_plan_id)::text from public.active_plans where owner_id = '20111111-1111-4111-8111-111111111111'),
  row(3, '2a000000-0000-4000-8000-000000000001'::uuid, null::uuid)::text, 'selezione dieta svuotata dalla RPC di eliminazione, scheda preservata');
select is((select row(result_state, provenance is null, selection->>'mealPlanId')::text from public.import_receipts
    where request_id = (select (value->>'requestId')::uuid from commit_state where name = 'follow')),
  row('deleted', true, (select value->>'planId' from commit_state where name = 'follow'))::text, 'tombstone: selezione conservata, provenienza rimossa');
select is((select provenance #>> '{analysis,jobId}' from public.import_receipts
    where request_id = (select (value->>'requestId')::uuid from commit_state where name = 'receipt:diet-reviewed-conditions')),
  (select created#>>'{job,jobId}' from commit_jobs where fixture = 'diet-reviewed-conditions' and owner_id = '20111111-1111-4111-8111-111111111111'),
  'provenienza essenziale collegata al job del proprietario');
select lives_ok($q$ set constraints all immediate $q$, 'vincoli differiti rispettati');

-- Eliminazione dell'account: piani, ricevute e tombstone rimossi in cascata.
delete from auth.users where id = '20111111-1111-4111-8111-111111111111';
select is((select count(*)::integer from public.import_receipts where owner_id = '20111111-1111-4111-8111-111111111111')
  + (select count(*)::integer from public.meal_plans where owner_id = '20111111-1111-4111-8111-111111111111'), 0, 'account eliminato: piani e ricevute rimossi');

select * from finish();
rollback;
