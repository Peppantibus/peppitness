-- Solo database locale di test. Include nella stessa cartella montata dal runner pgTAP.
-- Singolo statement eseguibile anche con `db query --local --file`.
-- Account sintetici casuali, rimossi alla fine; ogni errore annulla l'intero statement.
-- Nessuna chiave, password o dato personale. Le verifiche RLS usano SET ROLE.
do $test$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid();
  ex_a uuid := gen_random_uuid(); ex_b uuid := gen_random_uuid();
  plan_a uuid := gen_random_uuid(); plan_b uuid := gen_random_uuid(); invalid_plan uuid := gen_random_uuid();
  v1 uuid := gen_random_uuid(); v2 uuid := gen_random_uuid(); vb uuid := gen_random_uuid(); empty_v uuid := gen_random_uuid();
  day_a uuid := gen_random_uuid(); day_b uuid := gen_random_uuid(); day_v2 uuid := gen_random_uuid();
  prescription_a uuid := gen_random_uuid();
  document jsonb; bad_document jsonb; document_b jsonb;
  saved public.workout_plan_versions;
  table_name text;
  row_count integer;
begin
  insert into auth.users(id, aud, role, email) values
    (a, 'authenticated', 'authenticated', a::text || '@example.invalid'),
    (b, 'authenticated', 'authenticated', b::text || '@example.invalid');
  insert into public.exercises(id, owner_id, name) values (ex_a, a, 'Nome originale'), (ex_b, b, 'Esercizio B');
  document := jsonb_build_array(jsonb_build_object('id', day_a, 'label', 'A', 'title', 'Seduta A', 'exercises',
    jsonb_build_array(jsonb_build_object('id', prescription_a, 'exercise_id', ex_a,
      'sets', 2, 'optional_sets', 1, 'reps_min', 8, 'reps_max', 10, 'rest_seconds', 90, 'rir', 2, 'note', 'Serie facoltativa separata'))));
  document_b := jsonb_build_array(jsonb_build_object('id', day_b, 'label', 'B', 'title', 'Seduta B', 'exercises',
    jsonb_build_array(jsonb_build_object('id', gen_random_uuid(), 'exercise_id', ex_b, 'sets', 2, 'reps_min', 8, 'reps_max', 10))));

  set local role authenticated;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', a, 'role', 'authenticated')::text, true);
  insert into public.user_settings(display_name) values ('Impostazioni originali');
  -- Lo stesso trigger protegge settings/esercizi/programmi e deve fallire senza retry.
  for row_count in 1..2 loop
    begin
      update public.user_settings set display_name = 'Obsoleto', revision = 1 where owner_id = a;
      raise exception 'Revisione impostazioni obsoleta accettata';
    exception when sqlstate 'PT409' then null; end;
  end loop;
  if (select display_name from public.user_settings where owner_id = a) <> 'Impostazioni originali' then
    raise exception 'Conflitto impostazioni non atomico'; end if;
  saved := public.save_workout_draft(plan_a, v1, 0, 'Versione uno', 'Istruzioni globali', document);
  if saved.revision <> 1 or saved.status <> 'draft' then raise exception 'Bozza iniziale errata'; end if;
  if (select count(*) from public.workout_prescriptions where owner_id = a and sets = 2 and optional_sets = 1) <> 1 then
    raise exception 'Prescrizioni o serie facoltative perse'; end if;
  begin
    perform public.save_workout_draft(plan_a, v1, 0, 'Obsoleto', '', document);
    raise exception 'Revisione obsoleta accettata';
  exception when sqlstate 'PT409' then null; end;
  bad_document := jsonb_set(document, '{0,exercises,0,exercise_id}', to_jsonb(ex_b));
  begin
    perform public.save_workout_draft(plan_a, v1, 1, 'Tentativo cross-owner', '', bad_document);
    raise exception 'Esercizio altrui accettato';
  exception when insufficient_privilege then null; end;
  if (select revision from public.workout_plan_versions where id = v1) <> 1
    or (select title from public.workout_plan_versions where id = v1) <> 'Versione uno'
    or (select count(*) from public.workout_prescriptions where id = prescription_a) <> 1 then
    raise exception 'Salvataggio fallito non atomico'; end if;
  bad_document := jsonb_set(document, '{0,exercises,0,sets}', '0'::jsonb);
  bad_document := jsonb_set(jsonb_set(bad_document, '{0,id}', to_jsonb(gen_random_uuid())),
    '{0,exercises,0,id}', to_jsonb(gen_random_uuid()));
  begin
    perform public.save_workout_draft(invalid_plan, gen_random_uuid(), 0, 'Piano invalido', '', bad_document);
    raise exception 'Prescrizione invalida accettata';
  exception when check_violation then null; end;
  if exists (select 1 from public.workout_plans where id = invalid_plan) then raise exception 'Creato mezzo programma'; end if;

  saved := public.save_workout_draft(plan_a, empty_v, 0, 'Bozza vuota', '', '[]'::jsonb);
  begin
    perform public.publish_workout_version(empty_v, 1, 1);
    raise exception 'Pubblicata bozza vuota';
  exception when check_violation then null; end;
  begin
    perform public.publish_workout_version(v1, 1, 9);
    raise exception 'Pubblicazione con programma obsoleto accettata';
  exception when sqlstate 'PT409' then null; end;
  saved := public.publish_workout_version(v1, 1, 1);
  if saved.status <> 'published' or saved.revision <> 2
    or (select active_version_id from public.workout_plans where id = plan_a) <> v1 then
    raise exception 'Pubblicazione non completa'; end if;
  begin
    perform public.save_workout_draft(plan_a, v1, 2, 'Riscrittura', '', document);
    raise exception 'Versione pubblicata riscritta tramite RPC';
  exception when object_not_in_prerequisite_state then null; end;
  update public.exercises set name = 'Nome nuovo', revision = 2 where id = ex_a;
  if (select exercise_snapshot->>'name' from public.workout_prescriptions where id = prescription_a) <> 'Nome originale' then
    raise exception 'Rinomina catalogo modifica snapshot'; end if;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', b, 'role', 'authenticated')::text, true);
  foreach table_name in array array['workout_plans', 'workout_plan_versions', 'workout_days', 'workout_prescriptions'] loop
    execute format('select count(*) from public.%I where owner_id = $1', table_name) into row_count using a;
    if row_count <> 0 then raise exception 'B vede A in %', table_name; end if;
    begin
      execute format('insert into public.%I default values', table_name);
      raise exception 'Inserimento diretto consentito in %', table_name;
    exception when insufficient_privilege then null; end;
    begin
      execute format('delete from public.%I where owner_id = $1', table_name) using a;
      raise exception 'Cancellazione diretta consentita in %', table_name;
    exception when insufficient_privilege then null; end;
  end loop;
  update public.workout_plans set name = 'Attacco B', revision = 3 where id = plan_a;
  get diagnostics row_count = ROW_COUNT;
  if row_count <> 0 then raise exception 'B modifica programma A'; end if;
  begin
    perform public.save_workout_draft(plan_a, v1, 2, 'Attacco B', '', document);
    raise exception 'RPC B modifica A';
  exception when insufficient_privilege then null; end;
  begin
    perform public.publish_workout_version(v1, 2, 2);
    raise exception 'B pubblica versione A';
  exception when insufficient_privilege then null; end;
  saved := public.save_workout_draft(plan_b, vb, 0, 'Programma B', '', document_b);

  reset role;
  -- Vincoli verificati anche con RLS bypassata dall'amministratore del test.
  begin
    insert into public.workout_plan_versions(id, owner_id, plan_id, version_number, title)
    values (gen_random_uuid(), b, plan_a, 99, 'Padre altrui');
    raise exception 'FK programma cross-owner non verificata';
  exception when foreign_key_violation then null; end;
  begin
    insert into public.workout_prescriptions(id, owner_id, day_id, exercise_id, position, exercise_snapshot, mode, sets, reps_min, reps_max)
    values (gen_random_uuid(), b, day_b, ex_a, 99, '{}'::jsonb, 'reps', 2, 8, 10);
    raise exception 'FK esercizio cross-owner non verificata';
  exception when foreign_key_violation then null; end;
  begin
    update public.workout_plan_versions set title = 'Modifica diretta', revision = 3 where id = v1;
    raise exception 'Trigger non protegge versione pubblicata';
  exception when object_not_in_prerequisite_state then null; end;
  begin
    delete from public.workout_days where id = day_a;
    raise exception 'Seduta pubblicata eliminabile';
  exception when object_not_in_prerequisite_state then null; end;
  begin
    delete from public.workout_prescriptions where id = prescription_a;
    raise exception 'Prescrizione pubblicata eliminabile';
  exception when object_not_in_prerequisite_state then null; end;
  begin
    update public.workout_prescriptions set sets = 99 where id = prescription_a;
    raise exception 'Prescrizione pubblicata modificabile';
  exception when object_not_in_prerequisite_state then null; end;

  set local role authenticated;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', a, 'role', 'authenticated')::text, true);
  document := jsonb_set(jsonb_set(document, '{0,id}', to_jsonb(day_v2)), '{0,exercises,0,id}', to_jsonb(gen_random_uuid()));
  saved := public.save_workout_draft(plan_a, v2, 0, 'Versione successiva', '', document);
  saved := public.publish_workout_version(v2, 1, 2);
  if (select active_version_id from public.workout_plans where id = plan_a) <> v2
    or (select count(*) from public.workout_days where version_id = v1) <> 1
    or (select exercise_snapshot->>'name' from public.workout_prescriptions where id = prescription_a) <> 'Nome originale' then
    raise exception 'Nuova versione altera quella precedente'; end if;
  update public.workout_plans set archived_at = now(), revision = 4 where id = plan_a;
  begin
    perform public.save_workout_draft(plan_a, gen_random_uuid(), 0, 'Piano archiviato', '', '[]'::jsonb);
    raise exception 'Piano archiviato accetta nuove versioni';
  exception when object_not_in_prerequisite_state then null; end;

  perform set_config('request.jwt.claims', '{}', true);
  begin
    perform public.save_workout_draft(gen_random_uuid(), gen_random_uuid(), 0, 'Nessuna identita', '', '[]'::jsonb);
    raise exception 'RPC accetta identita assente';
  exception when insufficient_privilege then null; end;
  reset role;
  set local role anon;
  foreach table_name in array array['workout_plans', 'workout_plan_versions', 'workout_days', 'workout_prescriptions'] loop
    begin
      execute format('select count(*) from public.%I', table_name) into row_count;
      raise exception 'Anon legge %', table_name;
    exception when insufficient_privilege then null; end;
  end loop;
  begin
    perform public.save_workout_draft(gen_random_uuid(), gen_random_uuid(), 0, 'Anon', '', '[]'::jsonb);
    raise exception 'Anon chiama RPC save';
  exception when insufficient_privilege then null; end;
  begin
    perform public.publish_workout_version(v1, 2, 4);
    raise exception 'Anon chiama RPC publish';
  exception when insufficient_privilege then null; end;

  reset role;
  delete from auth.users where id = a;
  if exists (select 1 from public.workout_plans where owner_id = a)
    or exists (select 1 from public.workout_prescriptions where owner_id = a)
    or not exists (select 1 from public.workout_plans where owner_id = b) then
    raise exception 'Pulizia account non isolata'; end if;
  delete from auth.users where id = b;
  raise notice 'PASS: programmi, RLS, FK, atomicita, revisioni, snapshot e versioni immutabili';
end;
$test$;
