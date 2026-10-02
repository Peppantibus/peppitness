-- Task 19. commit_workout_import sul DB locale con rollback finale. Comandi prodotti dai mapper 09
-- (include generato), job reali del proprietario creati con le API server del 14, chiamate come
-- utente autenticato (JWT). Errori tardivi simulati con trigger temporanei annullati dal rollback.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions, pg_catalog;
select no_plan();
\ir import_commit_fixtures.inc

-- ---------------------------------------------------------------------------
-- Privilegi e metadati
-- ---------------------------------------------------------------------------
select ok(has_function_privilege('authenticated', 'public.commit_workout_import(uuid,jsonb,jsonb,jsonb)', 'execute'), 'RPC eseguibile da authenticated');
select ok(not has_function_privilege('anon', 'public.commit_workout_import(uuid,jsonb,jsonb,jsonb)', 'execute')
  and not has_function_privilege('service_role', 'public.commit_workout_import(uuid,jsonb,jsonb,jsonb)', 'execute'), 'RPC negata ad anon e service_role');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'public.commit_workout_import(uuid,jsonb,jsonb,jsonb)'::regprocedure),
  'SECURITY DEFINER con search_path vuoto');
select is((select count(*)::integer from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'peppitness_private' and p.proname in ('import_require', 'import_keys', 'import_text', 'import_integer', 'import_decimal',
    'import_exercise_values', 'import_exercise_matches', 'import_check_provenance', 'import_workout_targets')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
      or has_function_privilege('service_role', p.oid, 'execute'))), 0, 'helper del 19 non invocabili dai ruoli API');
select is((select count(*)::integer from import_commit_fixtures where kind = 'workout'), 7, 'corpus workout del mapping 09 disponibile');

-- ---------------------------------------------------------------------------
-- Fixture: account, catalogo seminato, programma manuale con storico, job pronti
-- ---------------------------------------------------------------------------
insert into auth.users(id, aud, role, email) values
  ('10111111-1111-4111-8111-111111111111', 'authenticated', 'authenticated', 'workout-import-a@example.invalid'),
  ('10222222-2222-4222-8222-222222222222', 'authenticated', 'authenticated', 'workout-import-b@example.invalid');
insert into public.shared_exercises(id, name, variant, equipment, load_convention, load_unit, measurement_mode, per_side, note)
  select (t->>'id')::uuid, t#>>'{values,name}', t#>>'{values,variant}', t#>>'{values,equipment}', t#>>'{values,loadConvention}',
    t#>>'{values,loadUnit}', t#>>'{values,measurementMode}', (t#>>'{values,perSide}')::boolean, t#>>'{values,note}'
  from import_commit_catalog, jsonb_array_elements(seed->'shared') t;
-- Secondo template con gli stessi valori: adozione nuova nella prova di rollback tardivo.
insert into public.shared_exercises(id, name, variant, equipment, load_convention, load_unit, measurement_mode, per_side, note)
  select 'c1900000-0000-4000-8000-000000000003', name, variant, equipment, load_convention, load_unit, measurement_mode, per_side, note
  from public.shared_exercises where id = 'c1900000-0000-4000-8000-000000000001';
insert into public.exercises(id, owner_id, name, variant, equipment, load_convention, load_unit, measurement_mode, per_side, note)
  select (e->>'id')::uuid, '10111111-1111-4111-8111-111111111111', e#>>'{values,name}', e#>>'{values,variant}', e#>>'{values,equipment}',
    e#>>'{values,loadConvention}', e#>>'{values,loadUnit}', e#>>'{values,measurementMode}', (e#>>'{values,perSide}')::boolean, e#>>'{values,note}'
  from import_commit_catalog, jsonb_array_elements(seed->'existing') e;
-- Revisione vista dal comando: 2.
update public.exercises set revision = 2 where id = 'a1900000-0000-4000-8000-000000000001';
insert into public.exercises(id, owner_id, name, measurement_mode) values
  ('a1900000-0000-4000-8000-0000000000aa', '10111111-1111-4111-8111-111111111111', 'Squat manuale', 'reps');

create temporary table commit_state(name text primary key, value jsonb);
create temporary table commit_jobs(fixture text, owner_id uuid, created jsonb, primary key (fixture, owner_id));
grant select, insert, update on commit_state, commit_jobs to authenticated, service_role;

create function pg_temp.as_user(owner_id uuid) returns void language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
$$;
-- Comando del corpus con il job dell'account; `tag` = copia con nuova chiave e nuovi UUID tecnici.
create function pg_temp.cmd(fixture text, owner_id uuid default '10111111-1111-4111-8111-111111111111', tag text default null) returns jsonb
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
  select public.commit_workout_import((command->>'requestId')::uuid, command->'payload', command->'provenance', command->'selectionOptions');
$$;
create function pg_temp.program_days(version uuid) returns jsonb language sql as $$
  select coalesce(jsonb_agg(jsonb_build_object('label', d.label, 'title', d.title, 'note', d.note,
    'exercises', (select coalesce(jsonb_agg(jsonb_build_object('name', p.exercise_snapshot->>'name', 'variant', p.exercise_snapshot->>'variant',
        'equipment', p.exercise_snapshot->>'equipment', 'load_convention', p.exercise_snapshot->>'load_convention',
        'load_unit', p.exercise_snapshot->>'load_unit', 'per_side', (p.exercise_snapshot->>'per_side')::boolean,
        'exercise_note', p.exercise_snapshot->>'note', 'mode', p.mode, 'sets', p.sets, 'optional_sets', p.optional_sets,
        'reps_min', p.reps_min, 'reps_max', p.reps_max, 'duration_seconds', p.duration_seconds, 'rest_seconds', p.rest_seconds,
        'rir', p.rir, 'rpe', p.rpe, 'note', p.note) order by p.position), '[]'::jsonb)
      from public.workout_prescriptions p where p.day_id = d.id)) order by d.position), '[]'::jsonb)
  from public.workout_days d where d.version_id = $1;
$$;
create function pg_temp.session_day(snapshot jsonb) returns jsonb language sql as $$
  select jsonb_build_object('label', snapshot->'label', 'title', snapshot->'title', 'note', snapshot->'note',
    'exercises', (select coalesce(jsonb_agg(e.value - 'id' - 'exercise_id' - 'muscle_group' order by e.ordinality), '[]'::jsonb)
      from jsonb_array_elements(snapshot->'exercises') with ordinality e));
$$;
create function pg_temp.session(session_id uuid, version uuid, day uuid) returns jsonb language plpgsql as $$
declare s public.workout_sessions;
begin
  s := public.start_workout_session(session_id, version, day, date '2026-10-06', 'Europe/Rome');
  update public.workout_sessions set status = 'completed', revision = revision + 1 where id = session_id;
  return s.day_snapshot;
end;
$$;
-- Impronta di tutto ciò che un import può creare per l'account (letta come proprietario).
create function pg_temp.footprint(owner_id uuid) returns text language sql as $$
  select row((select count(*) from public.workout_plans where owner_id = $1), (select count(*) from public.workout_plan_versions where owner_id = $1),
    (select count(*) from public.workout_days where owner_id = $1), (select count(*) from public.workout_prescriptions where owner_id = $1),
    (select count(*) from public.exercises where owner_id = $1), (select count(*) from public.import_receipts where owner_id = $1),
    (select row(revision, workout_plan_id, meal_plan_id)::text from public.active_plans where owner_id = $1))::text;
$$;
-- Programma manuale e seduta completata: nessun import deve toccarli.
create function pg_temp.history() returns text language sql as $$
  select md5(concat_ws('|',
    (select (to_jsonb(p) - 'updated_at')::text from public.workout_plans p where p.id = '1a000000-0000-4000-8000-000000000001'),
    (select (to_jsonb(v) - 'updated_at')::text from public.workout_plan_versions v where v.id = '1a000000-0000-4000-8000-000000000002'),
    (select string_agg(to_jsonb(d)::text, ',' order by d.position) from public.workout_days d where d.version_id = '1a000000-0000-4000-8000-000000000002'),
    (select string_agg(to_jsonb(p)::text, ',' order by p.position) from public.workout_prescriptions p
      join public.workout_days d on d.id = p.day_id where d.version_id = '1a000000-0000-4000-8000-000000000002'),
    (select to_jsonb(s)::text from public.workout_sessions s where s.id = '1a000000-0000-4000-8000-000000000005')));
$$;
-- Giorni nel formato delle RPC manuali, letti dal database (ID personali reali).
create function pg_temp.manual_days(version uuid) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('id', d.id, 'label', d.label, 'title', d.title, 'note', d.note,
    'exercises', (select jsonb_agg(jsonb_build_object('id', p.id, 'exercise_id', p.exercise_id, 'sets', p.sets, 'optional_sets', p.optional_sets,
      'reps_min', p.reps_min, 'reps_max', p.reps_max, 'duration_seconds', p.duration_seconds, 'rest_seconds', p.rest_seconds,
      'rir', p.rir, 'rpe', p.rpe, 'note', p.note) order by p.position) from public.workout_prescriptions p where p.day_id = d.id)) order by d.position)
  from public.workout_days d where d.version_id = $1;
$$;
grant execute on function pg_temp.as_user(uuid), pg_temp.cmd(text, uuid, text), pg_temp.opts(jsonb, boolean, integer), pg_temp.commit(jsonb),
  pg_temp.session(uuid, uuid, uuid), pg_temp.program_days(uuid), pg_temp.session_day(jsonb), pg_temp.manual_days(uuid) to authenticated, anon;
grant select on import_commit_fixtures, import_commit_catalog, commit_state, commit_jobs to anon;

-- Programma manuale con una seduta completata: lo storico non deve cambiare.
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select lives_ok($q$ select public.save_workout_draft('1a000000-0000-4000-8000-000000000001', '1a000000-0000-4000-8000-000000000002', 0,
  'Programma manuale', '', '[{"id":"1a000000-0000-4000-8000-000000000003","label":"A","title":"Seduta","exercises":[{"id":"1a000000-0000-4000-8000-000000000004",
  "exercise_id":"a1900000-0000-4000-8000-0000000000aa","sets":3,"reps_min":5,"reps_max":5}]}]') $q$, 'programma manuale salvato');
select lives_ok($q$ select public.publish_workout_version('1a000000-0000-4000-8000-000000000002', 1, 1) $q$, 'programma manuale pubblicato');
select lives_ok($q$ select pg_temp.session('1a000000-0000-4000-8000-000000000005', '1a000000-0000-4000-8000-000000000002',
  '1a000000-0000-4000-8000-000000000003') $q$, 'seduta storica completata');
reset role;
insert into commit_state values ('history', to_jsonb(pg_temp.history()));

-- Job pronti di A e B per ogni caso, con le API server (nessun provider: 0 chiamate).
set local role service_role;
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
insert into commit_jobs select f.id, u.owner_id, public.create_import_job(u.owner_id, gen_random_uuid(), f.kind,
    encode(sha256(convert_to('input:' || f.id || u.owner_id, 'UTF8')), 'hex'), encode(sha256(convert_to('document:' || f.id || u.owner_id, 'UTF8')), 'hex'),
    jsonb_build_object('reader', f.document->>'readerVersion', 'schema', '1.0', 'prompt', 'test/1', 'provider', 'synthetic', 'model', 'synthetic', 'rules', 'test/1'),
    f.document)
  from import_commit_fixtures f cross join (values ('10111111-1111-4111-8111-111111111111'::uuid), ('10222222-2222-4222-8222-222222222222'::uuid)) u(owner_id);
select is((select count(*)::integer from commit_jobs where created#>>'{job,status}' = 'running'), (select 2 * count(*)::integer from import_commit_fixtures), 'job creati in running');
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
select throws_ok($q$ select pg_temp.commit(pg_temp.cmd('workout-incomplete')) $q$, '42501', null, 'anonimo senza privilegio');
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select throws_ok($q$ select pg_temp.commit(pg_temp.cmd('workout-incomplete')) $q$, '42501', 'Authentication required', 'JWT senza utente respinto');
reset role;

-- ---------------------------------------------------------------------------
-- Corpus 09: tutto creato in una transazione, valori identici alla preview
-- ---------------------------------------------------------------------------
insert into commit_state values ('before-corpus', to_jsonb(pg_temp.footprint('10111111-1111-4111-8111-111111111111')));
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
insert into commit_state select 'receipt:' || f.id, pg_temp.commit(pg_temp.cmd(f.id)) from import_commit_fixtures f where f.kind = 'workout';
reset role;
select is(r.value->>'resultState', 'committed', 'ricevuta committed: ' || f.id)
  from import_commit_fixtures f join commit_state r on r.name = 'receipt:' || f.id order by f.id;
select is(r.value->>'contentHash', f.content_hash, 'contentHash SQL = TypeScript: ' || f.id)
  from import_commit_fixtures f join commit_state r on r.name = 'receipt:' || f.id order by f.id;
select is(r.value->>'commandHash', peppitness_private.import_command_hash((c->>'requestId')::uuid, c->'payload', c->'provenance', c->'selectionOptions'),
    'commandHash dei quattro argomenti: ' || f.id)
  from import_commit_fixtures f join commit_state r on r.name = 'receipt:' || f.id, pg_temp.cmd(f.id) c order by f.id;
select ok((r.value->>'planId') = (f.command#>>'{payload,resolved,planId}') and (r.value->>'versionId') = (f.command#>>'{payload,resolved,versionId}')
    and r.value->'selection' = 'null'::jsonb, 'piano e versione prenotati, nessuna selezione: ' || f.id)
  from import_commit_fixtures f join commit_state r on r.name = 'receipt:' || f.id order by f.id;
select is(pg_temp.program_days((f.command#>>'{payload,resolved,versionId}')::uuid), f.expected, 'righe salvate = preview del mapping 09: ' || f.id)
  from import_commit_fixtures f where f.kind = 'workout' order by f.id;
select ok(p.name = f.command#>>'{payload,resolved,title}' and p.active_version_id = v.id and v.status = 'published' and v.version_number = 1
    and v.revision = 2 and p.revision = 2 and v.title = p.name and v.guidance = f.command#>>'{payload,resolved,guidance}'
    and row(p.cycle_start::text, p.cycle_weeks::integer) is not distinct from row(f.command#>>'{payload,resolved,cycle,start}', (f.command#>>'{payload,resolved,cycle,weeks}')::integer),
    'pubblicato con titolo, istruzioni e ciclo: ' || f.id)
  from import_commit_fixtures f join public.workout_plans p on p.id = (f.command#>>'{payload,resolved,planId}')::uuid
    join public.workout_plan_versions v on v.id = (f.command#>>'{payload,resolved,versionId}')::uuid where f.kind = 'workout' order by f.id;
select is((select array_agg(b->>'resolution' order by o) from jsonb_array_elements(r.value->'exerciseBindings') with ordinality x(b, o)),
    (select array_agg(case c#>>'{choice,source}' when 'existing' then 'existing' when 'shared' then 'adopted' else 'created' end order by o)
      from jsonb_array_elements(f.command#>'{payload,resolved,catalog}') with ordinality y(c, o)), 'binding definitivi nell''ordine del catalogo: ' || f.id)
  from import_commit_fixtures f join commit_state r on r.name = 'receipt:' || f.id order by f.id;
select ok(not exists (select 1 from jsonb_array_elements(r.value->'exerciseBindings') b
    left join public.exercises e on e.id = (b->>'exerciseId')::uuid and e.owner_id = '10111111-1111-4111-8111-111111111111'
    where e.id is null or ((b->>'resolution') = 'existing') <> ((b->>'ref') = (b->>'exerciseId'))), 'esercizi definitivi dell''account: ' || f.id)
  from import_commit_fixtures f join commit_state r on r.name = 'receipt:' || f.id order by f.id;
select is((select count(*)::integer from public.exercises where owner_id = '10111111-1111-4111-8111-111111111111' and source_template_id is null
    and created_at >= (select min(created_at) from public.workout_plans where name <> 'Programma manuale')),
  (select count(*)::integer from import_commit_fixtures f, jsonb_array_elements(f.command#>'{payload,resolved,catalog}') c where c#>>'{choice,source}' = 'new'),
  'un esercizio nuovo per localKey');
select is((select row(e.name, e.note, e.source_template_id, e.revision)::text from public.exercises e
    where e.owner_id = '10111111-1111-4111-8111-111111111111' and e.source_template_id is not null),
  row('Rematore con manubrio', 'Template comune.', 'c1900000-0000-4000-8000-000000000001'::uuid, 1)::text, 'template adottato nella stessa transazione');
select is((select row(name, revision, archived_at)::text from public.exercises where id = 'a1900000-0000-4000-8000-000000000001'),
  row('Panca piana', 2, null::timestamptz)::text, 'esercizio personale usato così com''è');

-- Diario: lo snapshot della seduta è quello revisionato.
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
insert into commit_state select 'session:' || f.id, pg_temp.session(gen_random_uuid(), (f.command#>>'{payload,resolved,versionId}')::uuid,
    (f.command#>>'{payload,resolved,days,0,id}')::uuid) from import_commit_fixtures f where f.kind = 'workout';
reset role;
select is(pg_temp.session_day(s.value), f.expected->0, 'seduta dal diario = prima seduta revisionata: ' || f.id)
  from import_commit_fixtures f join commit_state s on s.name = 'session:' || f.id order by f.id;
select is(s.value->>'plan_title', f.command#>>'{payload,resolved,title}', 'titolo del piano nello snapshot: ' || f.id)
  from import_commit_fixtures f join commit_state s on s.name = 'session:' || f.id order by f.id;

-- ---------------------------------------------------------------------------
-- Replay, conflitti di chiave e copie esplicite
-- ---------------------------------------------------------------------------
insert into commit_state values ('after-corpus', to_jsonb(pg_temp.footprint('10111111-1111-4111-8111-111111111111')));
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select is(pg_temp.commit(pg_temp.cmd('workout-catalog')), (select value from commit_state where name = 'receipt:workout-catalog'),
  'stesso comando: stessa ricevuta');
select throws_ok($q$ select pg_temp.commit(jsonb_set(pg_temp.cmd('workout-catalog'), '{payload,resolved,title}', '"Titolo cambiato"')) $q$,
  'PT409', 'Import request conflict', 'stessa chiave, payload diverso: PT409');
select throws_ok($q$ select pg_temp.commit(jsonb_set(pg_temp.cmd('workout-catalog'), '{requestId}', '"e9999999-0000-4000-8000-000000000001"')) $q$,
  'PT409', 'Import request conflict', 'nuova chiave con piano già esistente: mai aggiornamento');
select throws_ok($q$ select pg_temp.commit((select replace(c::text, c#>>'{payload,resolved,days,0,prescriptions,0,id}',
  '1a000000-0000-4000-8000-000000000004')::jsonb from pg_temp.cmd('workout-spec-example', tag => '31') c)) $q$,
  'PT409', 'Import request conflict', 'ID di prescrizione esistente (anche nella provenienza): conflitto');
reset role;
select is(pg_temp.footprint('10111111-1111-4111-8111-111111111111'), (select value #>> '{}' from commit_state where name = 'after-corpus'),
  'replay e conflitti: nessun record creato');
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
insert into commit_state values ('copy', pg_temp.commit(pg_temp.cmd('workout-catalog', tag => '32')));
reset role;
select ok((select value->>'resultState' = 'committed' and value->>'contentHash' = (select value->>'contentHash' from commit_state where name = 'receipt:workout-catalog')
    and value->>'planId' <> (select value->>'planId' from commit_state where name = 'receipt:workout-catalog') from commit_state where name = 'copy'),
  'copia esplicita: nuova chiave, stesso contenuto, nuovo piano');
select is((select array_agg(b->>'resolution' order by b->>'resolution') from commit_state, jsonb_array_elements(value->'exerciseBindings') b where name = 'copy'),
  array['already_adopted', 'existing'], 'copia: template già adottato e identico, esercizio esistente');
select is((select count(*)::integer from public.exercises where owner_id = '10111111-1111-4111-8111-111111111111' and source_template_id is not null), 1,
  'nessuna seconda adozione');

-- ---------------------------------------------------------------------------
-- Catalogo: deriva, archiviazione, riferimenti altrui
-- ---------------------------------------------------------------------------
insert into commit_state values ('before-catalog', to_jsonb(pg_temp.footprint('10111111-1111-4111-8111-111111111111')));
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
update public.exercises set note = 'Nota rivista.', revision = 3 where id = 'a1900000-0000-4000-8000-000000000001';
select throws_ok($q$ select pg_temp.commit(pg_temp.cmd('workout-catalog', tag => '33')) $q$, 'PT409', 'Catalog changed', 'esercizio personale cambiato dopo la preview');
update public.exercises set note = 'Nota personale.', revision = 4 where id = 'a1900000-0000-4000-8000-000000000001';
select throws_ok($q$ select pg_temp.commit(pg_temp.cmd('workout-catalog', tag => '33')) $q$, 'PT409', 'Catalog changed', 'revisione diversa da quella vista');
update public.exercises set revision = 5 where id = 'a1900000-0000-4000-8000-000000000001';
reset role;
-- Riallinea il comando alla revisione 5 per isolare i casi del template.
insert into commit_state values ('catalog-command', jsonb_set(pg_temp.cmd('workout-catalog', tag => '34'), '{payload,resolved,catalog,0,choice,revision}', '5'));
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
update public.exercises set name = 'Rematore rinominato', revision = revision + 1
  where owner_id = '10111111-1111-4111-8111-111111111111' and source_template_id = 'c1900000-0000-4000-8000-000000000001';
select throws_ok($q$ select pg_temp.commit((select value from commit_state where name = 'catalog-command')) $q$, 'PT409', 'Catalog changed',
  'copia adottata rinominata: conflitto, nessuna nuova adozione');
update public.exercises set name = 'Rematore con manubrio', archived_at = now(), revision = revision + 1
  where owner_id = '10111111-1111-4111-8111-111111111111' and source_template_id = 'c1900000-0000-4000-8000-000000000001';
select throws_ok($q$ select pg_temp.commit((select value from commit_state where name = 'catalog-command')) $q$, 'PT409', 'Catalog changed',
  'copia adottata archiviata: conflitto');
reset role;
select ok((select archived_at is not null from public.exercises where source_template_id = 'c1900000-0000-4000-8000-000000000001'
  and owner_id = '10111111-1111-4111-8111-111111111111'), 'copia archiviata mai riattivata');
update public.shared_exercises set note = 'Template aggiornato.' where id = 'c1900000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
update public.exercises set archived_at = null, revision = revision + 1
  where owner_id = '10111111-1111-4111-8111-111111111111' and source_template_id = 'c1900000-0000-4000-8000-000000000001';
select throws_ok($q$ select pg_temp.commit((select value from commit_state where name = 'catalog-command')) $q$, 'PT409', 'Catalog changed',
  'template comune cambiato dopo la preview');
select throws_ok($q$ select pg_temp.commit(jsonb_set((select value from commit_state where name = 'catalog-command'),
  '{payload,resolved,catalog,1,choice,templateId}', '"c1900000-0000-4000-8000-0000000000ff"')) $q$, '42501', 'Import reference not available', 'template inesistente');
select throws_ok($q$ select pg_temp.commit(jsonb_set(jsonb_set(jsonb_set((select value from commit_state where name = 'catalog-command'),
  '{payload,resolved,catalog,0,ref}', '"a1900000-0000-4000-8000-0000000000ff"'), '{payload,resolved,catalog,0,choice,personalId}', '"a1900000-0000-4000-8000-0000000000ff"'),
  '{payload,resolved,days,0,prescriptions,0,exerciseRef}', '"a1900000-0000-4000-8000-0000000000ff"')) $q$, '42501', 'Import reference not available', 'esercizio personale inesistente');
-- B usa l'ID personale di A con il proprio job: nessun dettaglio sui dati altrui.
select pg_temp.as_user('10222222-2222-4222-8222-222222222222');
select throws_ok($q$ select pg_temp.commit(jsonb_set((select value from commit_state where name = 'catalog-command'), '{provenance,analysis,jobId}',
  to_jsonb((select (created#>>'{job,jobId}')::uuid from commit_jobs where fixture = 'workout-catalog' and owner_id = '10222222-2222-4222-8222-222222222222')))) $q$,
  '42501', 'Import reference not available', 'B non usa esercizi di A');
select throws_ok($q$ select pg_temp.commit((select value from commit_state where name = 'catalog-command')) $q$,
  '42501', 'Import reference not available', 'B non usa il job di A');
select is((select count(*)::integer from public.workout_plans), 0, 'RLS: B non vede i programmi di A');
select is(public.get_import_receipt((select (value->>'requestId')::uuid from commit_state where name = 'receipt:workout-catalog')), null, 'B non vede la ricevuta di A');
reset role;
update public.shared_exercises set note = 'Template comune.' where id = 'c1900000-0000-4000-8000-000000000001';
select is(pg_temp.footprint('10111111-1111-4111-8111-111111111111'), (select value #>> '{}' from commit_state where name = 'before-catalog'),
  'conflitti di catalogo: nessun programma, esercizio o ricevuta');
select is(pg_temp.footprint('10222222-2222-4222-8222-222222222222'), row(0, 0, 0, 0, 0, 0, null::text)::text, 'B senza effetti');

-- ---------------------------------------------------------------------------
-- Comando non conforme: 22023 prima di ogni scrittura
-- ---------------------------------------------------------------------------
create temporary table invalid_commands(label text, command jsonb);
grant select on invalid_commands to authenticated;
insert into invalid_commands select label, command from (values
  ('chiave sconosciuta nel payload', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,extra}', 'true')),
  ('protocollo diverso', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,protocolVersion}', '"peppitness.import-commit.v2"')),
  ('mode diverso da create_new', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,mode}', '"new_version"')),
  ('dominio sbagliato', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,kind}', '"diet"')),
  ('campo mancante', pg_temp.cmd('workout-incomplete', tag => '41') #- '{payload,resolved,guidance}'),
  ('recupero mancante', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,days,0,prescriptions,0,restSeconds}', 'null')),
  ('serie facoltative assenti', pg_temp.cmd('workout-incomplete', tag => '41') #- '{payload,resolved,days,0,prescriptions,0,optionalSets}'),
  ('chiave extra nella prescrizione', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,days,0,prescriptions,0,loadKg}', '80')),
  ('serie oltre limite', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,days,0,prescriptions,0,sets}', '1001')),
  ('serie decimali', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,days,0,prescriptions,0,sets}', '3.5')),
  ('numero come stringa', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,days,0,prescriptions,0,sets}', '"4"')),
  ('RIR con esponente', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,days,0,prescriptions,0,rir}', '0.0000001')),
  ('modalità reps con durata', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,days,0,prescriptions,0,durationSeconds}', '30')),
  ('ripetizioni invertite', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,days,0,prescriptions,0,repsMin}', '99')),
  ('ciclo a metà', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,cycle}', '{"start":"2026-10-05"}')),
  ('data inesistente', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,cycle}', '{"start":"2026-02-30","weeks":4}')),
  ('titolo con spazio non separabile', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,title}', to_jsonb(E'Scheda '::text))),
  ('carattere di controllo', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,guidance}', to_jsonb(E'a\u0007b'::text))),
  ('etichette ripetute', jsonb_set(pg_temp.cmd('workout-abc-no-days', tag => '41'), '{payload,resolved,days,1,label}',
    (select command#>'{payload,resolved,days,0,label}' from import_commit_fixtures where id = 'workout-abc-no-days'))),
  ('UUID tecnico ripetuto', (select jsonb_set(c, '{payload,resolved,days,0,prescriptions,1,id}', c#>'{payload,resolved,days,0,prescriptions,0,id}')
    from pg_temp.cmd('workout-incomplete', tag => '41') c)),
  ('seduta vuota', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,days,0,prescriptions}', '[]')),
  ('prescrizione senza associazione', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,days,0,prescriptions,0,exerciseRef}',
    '"19999999-0000-4000-8000-000000000001"')),
  ('associazione inutilizzata', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,catalog,2}',
    '{"ref":"41999999-0000-4000-8000-000000000001","choice":{"source":"new","localKey":"extra","values":{"name":"Extra","variant":"","equipment":"","loadConvention":"total","loadUnit":"kg","measurementMode":"reps","perSide":false,"note":""}}}')),
  ('provenienza di un altro dominio', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{provenance,kind}', '"diet"')),
  ('provenienza con chiave extra', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{provenance,analysis,model}', '"x"')),
  ('fonte senza job', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{provenance,analysis,jobId}', 'null')),
  ('fonte diversa dal job', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{provenance,analysis,source,sourceHash}', to_jsonb(repeat('0', 64)))),
  ('puntatore inesistente', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{provenance,items,1,sourcePointer}', '"/sessions/9"')),
  ('target di un altro tipo', (select jsonb_set(c, '{provenance,items,1,targetId}', c#>'{payload,resolved,days,0,prescriptions,0,id}')
    from pg_temp.cmd('workout-incomplete', tag => '41') c)),
  ('target provvisorio', (select jsonb_set(c, '{provenance,items,2,targetId}', c#>'{payload,resolved,catalog,0,ref}')
    from pg_temp.cmd('workout-incomplete', tag => '41') c)),
  ('valore diverso dall''estratto senza decisione', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{payload,resolved,days,0,prescriptions,1,sets}', '5')),
  ('decisione generica al posto del campo', jsonb_set(pg_temp.cmd('workout-incomplete', tag => '41'), '{provenance,items,2,decisions}',
    '[{"field":null,"reason":"catalog_choice"},{"field":null,"reason":"user_edit"}]'))
) v(label, command);
select ok((select count(*) = 32 and bool_and(command is not null) from invalid_commands), 'comandi non conformi preparati');
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select throws_ok(format('select pg_temp.commit(%L::jsonb)', command), '22023', 'Invalid import command', 'respinto: ' || label) from invalid_commands order by label;
reset role;
select is(pg_temp.footprint('10111111-1111-4111-8111-111111111111'), (select value #>> '{}' from commit_state where name = 'before-catalog'),
  'comandi non conformi: nessuna scrittura');

-- Job: altrui, di un altro dominio, scaduto dopo la preparazione del comando.
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select throws_ok($q$ select pg_temp.commit(jsonb_set(pg_temp.cmd('workout-incomplete', tag => '42'), '{provenance,analysis,jobId}',
  to_jsonb((select (created#>>'{job,jobId}')::uuid from commit_jobs where fixture = 'workout-incomplete' and owner_id = '10222222-2222-4222-8222-222222222222')))) $q$,
  '42501', 'Import reference not available', 'job di B respinto');
select throws_ok($q$ select pg_temp.commit(jsonb_set(pg_temp.cmd('workout-incomplete', tag => '42'), '{provenance,analysis,jobId}',
  to_jsonb((select (created#>>'{job,jobId}')::uuid from commit_jobs where fixture = 'diet-spec-example' and owner_id = '10111111-1111-4111-8111-111111111111')))) $q$,
  '22023', 'Invalid import command', 'job della dieta respinto');
reset role;
update public.import_drafts set expires_at = now() - interval '1 second', revision = revision + 1
  where job_id = (select (created#>>'{job,jobId}')::uuid from commit_jobs where fixture = 'workout-incomplete' and owner_id = '10111111-1111-4111-8111-111111111111');
update public.import_jobs set expires_at = now() - interval '1 second', revision = revision + 1
  where id = (select (created#>>'{job,jobId}')::uuid from commit_jobs where fixture = 'workout-incomplete' and owner_id = '10111111-1111-4111-8111-111111111111');
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select throws_ok($q$ select pg_temp.commit(pg_temp.cmd('workout-incomplete', tag => '42')) $q$, 'PT410', 'Import analysis expired', 'job scaduto: errore chiaro prima delle scritture');
select is(pg_temp.commit(pg_temp.cmd('workout-incomplete'))->>'resultState', 'committed', 'replay dopo la scadenza del job: ricevuta, nessuna nuova analisi');
reset role;
select is(pg_temp.footprint('10111111-1111-4111-8111-111111111111'), (select value #>> '{}' from commit_state where name = 'before-catalog'),
  'job non validi: nessuna scrittura');

-- ---------------------------------------------------------------------------
-- Selezione esplicita e rollback tardivi
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select lives_ok($q$ insert into public.meal_plans(id, name, document) values ('1a000000-0000-4000-8000-0000000000d1', 'Dieta seguita', '{"guidance":"","days":[]}') $q$, 'dieta di A');
select lives_ok($q$ insert into public.active_plans(meal_plan_id) values ('1a000000-0000-4000-8000-0000000000d1') $q$, 'selezione dieta esistente');
select throws_ok($q$ select pg_temp.commit(pg_temp.opts(pg_temp.cmd('workout-spec-example', tag => '51'), true)) $q$, 'PT409', 'Active selection conflict',
  'selezione esistente non vista: conflitto');
select throws_ok($q$ select pg_temp.commit(pg_temp.opts(pg_temp.cmd('workout-spec-example', tag => '51'), true, 7)) $q$, 'PT409', 'Active selection conflict',
  'revisione obsoleta: conflitto');
reset role;
insert into commit_state values ('before-late', to_jsonb(pg_temp.footprint('10111111-1111-4111-8111-111111111111')));

create function public.test_010_late_failure() returns trigger language plpgsql as $$
begin raise exception using errcode = 'P0001', message = 'Simulated late failure'; end;
$$;
-- Ultimo figlio: l'ultima prescrizione dell'ultima seduta, dopo l'adozione di un template nuovo.
insert into commit_state select 'late-child', pg_temp.opts(jsonb_set(jsonb_set(pg_temp.cmd('workout-catalog', tag => '51'),
  '{payload,resolved,catalog,0,choice,revision}', '5'), '{payload,resolved,catalog,1,choice,templateId}', '"c1900000-0000-4000-8000-000000000003"'), true, 1);
do $d$ begin
  execute format('create trigger test_010_last_child before insert on public.workout_prescriptions for each row when (NEW.id = %L) '
    'execute function public.test_010_late_failure()', (select p.value->>'id' from commit_state s,
      jsonb_array_elements(s.value#>'{payload,resolved,days}') with ordinality d(value, i),
      jsonb_array_elements(d.value->'prescriptions') with ordinality p(value, j) where s.name = 'late-child' order by d.i desc, p.j desc limit 1));
end $d$;
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select throws_ok($q$ select pg_temp.commit((select value from commit_state where name = 'late-child')) $q$,
  'P0001', 'Simulated late failure', 'errore all''ultimo figlio dopo adozione, programma e versione');
reset role;
drop trigger test_010_last_child on public.workout_prescriptions;
select is((select count(*)::integer from public.exercises where source_template_id = 'c1900000-0000-4000-8000-000000000003'), 0,
  'adozione annullata con il programma');
select is(pg_temp.footprint('10111111-1111-4111-8111-111111111111'), (select value #>> '{}' from commit_state where name = 'before-late'),
  'rollback all''ultimo figlio: nessun piano, esercizio, adozione o selezione');

create trigger test_010_selection before update on public.active_plans for each row execute function public.test_010_late_failure();
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select throws_ok($q$ select pg_temp.commit(pg_temp.opts(pg_temp.cmd('workout-ranges-unicode', tag => '52'), true, 1)) $q$,
  'P0001', 'Simulated late failure', 'errore sulla selezione dopo la pubblicazione');
reset role;
drop trigger test_010_selection on public.active_plans;
select is(pg_temp.footprint('10111111-1111-4111-8111-111111111111'), (select value #>> '{}' from commit_state where name = 'before-late'),
  'rollback sulla selezione: programma ed esercizi nuovi annullati');

create trigger test_010_receipt before insert on public.import_receipts for each row execute function public.test_010_late_failure();
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select throws_ok($q$ select pg_temp.commit(pg_temp.opts(pg_temp.cmd('workout-ranges-unicode', tag => '53'), true, 1)) $q$,
  'P0001', 'Simulated late failure', 'errore sulla ricevuta, ultima scrittura');
reset role;
drop trigger test_010_receipt on public.import_receipts;
select is(pg_temp.footprint('10111111-1111-4111-8111-111111111111'), (select value #>> '{}' from commit_state where name = 'before-late'),
  'rollback sulla ricevuta: selezione e programma annullati');

set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
insert into commit_state values ('follow', pg_temp.commit(pg_temp.opts(pg_temp.cmd('workout-ranges-unicode', tag => '54'), true, 1)));
reset role;
select is((select value->'selection' from commit_state where name = 'follow'),
  jsonb_build_object('revision', 2, 'workoutPlanId', (select value->'planId' from commit_state where name = 'follow'), 'mealPlanId', '1a000000-0000-4000-8000-0000000000d1'),
  'follow: solo la sezione scheda, revisione +1, dieta preservata');
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select is(pg_temp.commit(pg_temp.opts(pg_temp.cmd('workout-ranges-unicode', tag => '54'), true, 1)), (select value from commit_state where name = 'follow'),
  'replay dopo il follow: stessa ricevuta anche con selezione ormai cambiata');
reset role;
select is((select revision from public.active_plans where owner_id = '10111111-1111-4111-8111-111111111111'), 2, 'replay non incrementa la selezione');

-- ---------------------------------------------------------------------------
-- Versioni: l'import segue le regole correnti di revisione, lo storico resta
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select is((public.save_workout_revision((f.command#>>'{payload,resolved,planId}')::uuid, (f.command#>>'{payload,resolved,versionId}')::uuid, 2, 2,
    '1b000000-0000-4000-8000-000000000001', f.command#>>'{payload,resolved,title}', 'Istruzioni riviste',
    pg_temp.manual_days((f.command#>>'{payload,resolved,versionId}')::uuid), null, null))->>'outcome', 'created',
  'versione importata già usata: la modifica crea v2') from import_commit_fixtures f where f.id = 'workout-spec-example';
reset role;
select is(pg_temp.program_days((f.command#>>'{payload,resolved,versionId}')::uuid), f.expected, 'v1 importata intatta dopo la revisione')
  from import_commit_fixtures f where f.id = 'workout-spec-example';
select is(pg_temp.session_day(s.value), f.expected->0, 'snapshot della seduta intatto')
  from import_commit_fixtures f join commit_state s on s.name = 'session:' || f.id where f.id = 'workout-spec-example';

-- ---------------------------------------------------------------------------
-- Eliminazione: tombstone e vecchio retry senza ricreazione
-- ---------------------------------------------------------------------------
set local role authenticated;
select pg_temp.as_user('10111111-1111-4111-8111-111111111111');
select is(public.delete_workout_plans((select (value->>'planId')::uuid from commit_state where name = 'receipt:workout-abc-no-days')), 1, 'programma importato eliminato');
select is(pg_temp.commit(pg_temp.cmd('workout-abc-no-days'))->>'resultState', 'deleted', 'vecchio retry: ricevuta deleted');
select throws_ok($q$ select pg_temp.commit(jsonb_set(pg_temp.cmd('workout-abc-no-days'), '{requestId}', '"e9999999-0000-4000-8000-000000000002"')) $q$,
  'PT409', 'Import request conflict', 'nuova chiave con l''ID di un programma eliminato: nessuna ricreazione');
select is(public.get_import_receipt((select (value->>'requestId')::uuid from commit_state where name = 'receipt:workout-abc-no-days'))->>'resultState', 'deleted',
  'lookup: deleted');
reset role;
select is((select count(*)::integer from public.workout_plans where id = (select (value->>'planId')::uuid from commit_state where name = 'receipt:workout-abc-no-days')), 0,
  'vecchio retry non ricrea il programma');
select is((select row(result_state, provenance is null, version_id::text)::text from public.import_receipts
    where request_id = (select (value->>'requestId')::uuid from commit_state where name = 'receipt:workout-abc-no-days')),
  row('deleted', true, (select value->>'versionId' from commit_state where name = 'receipt:workout-abc-no-days'))::text, 'tombstone: versione conservata, provenienza rimossa');
select is((select provenance from public.import_receipts where request_id = (select (value->>'requestId')::uuid from commit_state where name = 'receipt:workout-catalog')),
  (select command->'provenance' from import_commit_fixtures where id = 'workout-catalog') || jsonb_build_object('analysis',
    (select command#>'{provenance,analysis}' from import_commit_fixtures where id = 'workout-catalog') || jsonb_build_object('jobId',
      (select (created#>>'{job,jobId}')::uuid from commit_jobs where fixture = 'workout-catalog' and owner_id = '10111111-1111-4111-8111-111111111111'))),
  'provenienza essenziale conservata nella ricevuta');
select lives_ok($q$ set constraints all immediate $q$, 'vincoli differiti rispettati');

-- Storico manuale e seduta completata invariati da tutti gli import.
select is(pg_temp.history(), (select value #>> '{}' from commit_state where name = 'history'), 'programma manuale e seduta storica invariati');
select is((select day_snapshot->>'plan_title' from public.workout_sessions where id = '1a000000-0000-4000-8000-000000000005'), 'Programma manuale',
  'seduta storica intatta');
select is((select row(status, revision, title)::text from public.workout_plan_versions where id = '1a000000-0000-4000-8000-000000000002'),
  row('published', 2, 'Programma manuale')::text, 'versione manuale intatta');

select * from finish();
rollback;
