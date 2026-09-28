-- Modifica dei programmi pubblicati decisa dal database, in una sola transazione.
--
-- * versione pubblicata mai usata in una seduta: aggiornata direttamente (stesso ID e numero);
-- * versione già usata da almeno una seduta: resta immutabile, il contenuto nuovo diventa vN+1;
-- * contenuto identico: nessuna scrittura; cambiano solo nome e ciclo se diversi.
--
-- Le guardie delle versioni pubblicate restano attive: si aprono soltanto dentro
-- save_workout_revision, per la sola versione indicata e solo se nessuna seduta la usa.
-- Le migrazioni già applicate restano invariate.

-- Ricerca «versione già usata?» per proprietario e versione.
create index if not exists workout_sessions_version_idx on public.workout_sessions(owner_id, version_id);

-- ---------------------------------------------------------------------------
-- Guardie: stessa logica della migrazione 20260927220000, più l'eccezione controllata.
-- ---------------------------------------------------------------------------
create or replace function peppitness_private.guard_workout_version()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.status <> 'draft' then raise exception using errcode = '55000', message = 'Versions must start as drafts'; end if;
    return NEW;
  end if;
  if TG_OP = 'DELETE' then
    if not exists (select 1 from public.workout_plans where owner_id = OLD.owner_id and id = OLD.plan_id)
      or not exists (select 1 from auth.users where id = OLD.owner_id) then return OLD; end if;
    if OLD.status = 'published' then raise exception using errcode = '55000', message = 'Published versions are immutable'; end if;
    return OLD;
  end if;
  -- Una versione pubblicata cambia solo durante una revisione autorizzata e mai usata.
  if OLD.status = 'published' and not (
    NEW.status = 'published'
    and coalesce(pg_catalog.current_setting('peppitness.revise_version', true), '') = OLD.id::text
    and not exists (select 1 from public.workout_sessions s where s.owner_id = OLD.owner_id and s.version_id = OLD.id)
  ) then
    raise exception using errcode = '55000', message = 'Published versions are immutable';
  end if;
  if row(NEW.id, NEW.plan_id, NEW.version_number) is distinct from row(OLD.id, OLD.plan_id, OLD.version_number) then
    raise exception using errcode = '23514', message = 'Version identity cannot change';
  end if;
  return NEW;
end;
$$;

create or replace function peppitness_private.guard_workout_child()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  parent_version uuid;
  parent_status text;
  parent_plan uuid;
  record_owner uuid;
begin
  if TG_OP = 'UPDATE' then raise exception using errcode = '55000', message = 'Replace draft children atomically'; end if;
  if TG_OP = 'DELETE' then
    record_owner := OLD.owner_id;
    if TG_TABLE_NAME = 'workout_days' then parent_version := OLD.version_id;
    else select version_id into parent_version from public.workout_days where owner_id = record_owner and id = OLD.day_id; end if;
  else
    record_owner := NEW.owner_id;
    if TG_TABLE_NAME = 'workout_days' then parent_version := NEW.version_id;
    else select version_id into parent_version from public.workout_days where owner_id = record_owner and id = NEW.day_id; end if;
  end if;
  select status, plan_id into parent_status, parent_plan from public.workout_plan_versions
    where owner_id = record_owner and id = parent_version for update;
  if not FOUND and TG_OP = 'DELETE' then return OLD; end if;
  if TG_OP = 'DELETE' and not exists (select 1 from public.workout_plans where owner_id = record_owner and id = parent_plan) then return OLD; end if;
  if parent_status is distinct from 'draft' and not (
    parent_status = 'published'
    and coalesce(pg_catalog.current_setting('peppitness.revise_version', true), '') = parent_version::text
    and not exists (select 1 from public.workout_sessions s where s.owner_id = record_owner and s.version_id = parent_version)
  ) then
    raise exception using errcode = '55000', message = 'Only draft children can change';
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- Contenuto confrontabile: giorni e prescrizioni senza ID, snapshot o revisioni.
-- ---------------------------------------------------------------------------
create function peppitness_private.normalize_workout_days(p_days jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'label', d.value->>'label', 'title', d.value->>'title', 'note', coalesce(d.value->>'note', ''),
    'exercises', (select coalesce(jsonb_agg(jsonb_build_object(
        'exercise_id', (e.value->>'exercise_id')::uuid, 'sets', (e.value->>'sets')::integer,
        'optional_sets', coalesce((e.value->>'optional_sets')::integer, 0),
        'reps_min', (e.value->>'reps_min')::integer, 'reps_max', (e.value->>'reps_max')::integer,
        'duration_seconds', (e.value->>'duration_seconds')::integer,
        'rest_seconds', coalesce((e.value->>'rest_seconds')::integer, 0),
        'rir', (e.value->>'rir')::numeric, 'rpe', (e.value->>'rpe')::numeric,
        'note', coalesce(e.value->>'note', '')) order by e.ordinality), '[]'::jsonb)
      from jsonb_array_elements(d.value->'exercises') with ordinality e)
  ) order by d.ordinality), '[]'::jsonb)
  from jsonb_array_elements(p_days) with ordinality d
$$;

create function peppitness_private.workout_version_content(p_owner uuid, p_version uuid)
returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'label', d.label, 'title', d.title, 'note', d.note,
    'exercises', (select coalesce(jsonb_agg(jsonb_build_object(
        'exercise_id', p.exercise_id, 'sets', p.sets, 'optional_sets', p.optional_sets,
        'reps_min', p.reps_min, 'reps_max', p.reps_max, 'duration_seconds', p.duration_seconds,
        'rest_seconds', p.rest_seconds, 'rir', p.rir, 'rpe', p.rpe, 'note', p.note) order by p.position), '[]'::jsonb)
      from public.workout_prescriptions p where p.owner_id = p_owner and p.day_id = d.id)
  ) order by d.position), '[]'::jsonb)
  from public.workout_days d where d.owner_id = p_owner and d.version_id = p_version
$$;

-- Scrive giorni e prescrizioni di una versione, con snapshot degli esercizi generato dal server.
-- p_keep_ids: aggiornamento della stessa versione (ID del documento); altrimenti ID nuovi,
-- perché i figli della versione precedente restano con i propri.
create function peppitness_private.write_workout_days(p_owner uuid, p_version uuid, p_days jsonb, p_keep_ids boolean)
returns void language plpgsql set search_path = '' as $$
declare
  day_item record;
  prescription_item record;
  new_day uuid;
  selected_exercise public.exercises;
begin
  if jsonb_array_length(p_days) = 0 then
    raise exception using errcode = '23514', message = 'Each published workout day needs prescriptions';
  end if;
  for day_item in select value, ordinality from jsonb_array_elements(p_days) with ordinality loop
    if jsonb_array_length(day_item.value->'exercises') = 0 then
      raise exception using errcode = '23514', message = 'Each published workout day needs prescriptions';
    end if;
    new_day := case when p_keep_ids then (day_item.value->>'id')::uuid else gen_random_uuid() end;
    insert into public.workout_days(id, owner_id, version_id, position, label, title, note)
    values (new_day, p_owner, p_version, day_item.ordinality - 1,
      day_item.value->>'label', day_item.value->>'title', coalesce(day_item.value->>'note', ''));
    for prescription_item in select value, ordinality from jsonb_array_elements(day_item.value->'exercises') with ordinality loop
      select * into selected_exercise from public.exercises
      where id = (prescription_item.value->>'exercise_id')::uuid and owner_id = p_owner and archived_at is null;
      if not FOUND then raise exception using errcode = '42501', message = 'Exercise not available'; end if;
      insert into public.workout_prescriptions(id, owner_id, day_id, exercise_id, position, exercise_snapshot,
        mode, sets, optional_sets, reps_min, reps_max, duration_seconds, rest_seconds, rir, rpe, note)
      values (case when p_keep_ids then (prescription_item.value->>'id')::uuid else gen_random_uuid() end,
        p_owner, new_day, selected_exercise.id, prescription_item.ordinality - 1,
        jsonb_build_object('id', selected_exercise.id, 'name', selected_exercise.name, 'variant', selected_exercise.variant,
          'equipment', selected_exercise.equipment, 'load_convention', selected_exercise.load_convention,
          'load_unit', selected_exercise.load_unit, 'mode', selected_exercise.measurement_mode,
          'per_side', selected_exercise.per_side, 'note', selected_exercise.note),
        selected_exercise.measurement_mode, (prescription_item.value->>'sets')::integer,
        coalesce((prescription_item.value->>'optional_sets')::integer, 0),
        (prescription_item.value->>'reps_min')::integer, (prescription_item.value->>'reps_max')::integer,
        (prescription_item.value->>'duration_seconds')::integer, coalesce((prescription_item.value->>'rest_seconds')::integer, 0),
        (prescription_item.value->>'rir')::numeric, (prescription_item.value->>'rpe')::numeric,
        coalesce(prescription_item.value->>'note', ''));
    end loop;
  end loop;
end;
$$;

revoke all on function peppitness_private.normalize_workout_days(jsonb) from public, anon, authenticated;
revoke all on function peppitness_private.workout_version_content(uuid, uuid) from public, anon, authenticated;
revoke all on function peppitness_private.write_workout_days(uuid, uuid, jsonb, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Salvataggio di una modifica a partire da una versione pubblicata.
-- Esiti: unchanged, metadata (solo nome/ciclo), updated (stessa versione), created (vN+1).
-- SECURITY DEFINER come le altre RPC dei programmi: il client non scrive direttamente i figli.
-- ---------------------------------------------------------------------------
create function public.save_workout_revision(
  p_plan_id uuid, p_base_version_id uuid, p_expected_plan_revision integer, p_expected_version_revision integer,
  p_new_version_id uuid, p_title text, p_guidance text, p_days jsonb, p_cycle_start date, p_cycle_weeks integer
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  selected_plan public.workout_plans;
  base_version public.workout_plan_versions;
  target public.workout_plan_versions;
  day_item record;
  content_changed boolean;
  name_changed boolean;
  cycle_changed boolean;
  used boolean;
  outcome text;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_plan_id is null or p_base_version_id is null or p_new_version_id is null or p_new_version_id = p_base_version_id
    or p_expected_plan_revision is null or p_expected_version_revision is null
    or p_title is null or p_guidance is null or jsonb_typeof(p_days) is distinct from 'array'
    or (p_cycle_start is null) <> (p_cycle_weeks is null) then
    raise exception using errcode = '22023', message = 'Invalid revision';
  end if;
  if jsonb_array_length(p_days) > 50 then raise exception using errcode = '22023', message = 'Too many workout days'; end if;
  for day_item in select value from jsonb_array_elements(p_days) loop
    if jsonb_typeof(day_item.value) is distinct from 'object' or jsonb_typeof(day_item.value->'exercises') is distinct from 'array'
      or exists (select 1 from jsonb_array_elements(day_item.value->'exercises') e where jsonb_typeof(e.value) is distinct from 'object') then
      raise exception using errcode = '22023', message = 'Invalid workout day';
    end if;
    if jsonb_array_length(day_item.value->'exercises') > 200 then raise exception using errcode = '22023', message = 'Too many prescriptions'; end if;
  end loop;

  -- Ordine dei lock come nelle altre RPC: programma, poi versione. Due salvataggi dello
  -- stesso programma si serializzano qui: niente numeri di versione duplicati.
  select * into selected_plan from public.workout_plans where id = p_plan_id and owner_id = actor for update;
  if not FOUND then raise exception using errcode = '42501', message = 'Plan not available'; end if;

  -- Riprova dopo una risposta persa: la nuova versione esiste già, stesso esito senza riscrivere.
  select * into target from public.workout_plan_versions where id = p_new_version_id and owner_id = actor;
  if FOUND then
    if target.plan_id <> p_plan_id then raise exception using errcode = '42501', message = 'Version not available'; end if;
    return jsonb_build_object('outcome', 'created', 'version_id', target.id, 'version_number', target.version_number,
      'version_revision', target.revision, 'plan_revision', selected_plan.revision);
  end if;

  if selected_plan.archived_at is not null then raise exception using errcode = '55000', message = 'Plan is archived'; end if;
  select * into base_version from public.workout_plan_versions
    where id = p_base_version_id and owner_id = actor and plan_id = p_plan_id for update;
  if not FOUND then raise exception using errcode = '42501', message = 'Version not available'; end if;
  if base_version.status <> 'published' then raise exception using errcode = '55000', message = 'Only published versions can be revised'; end if;
  if selected_plan.revision <> p_expected_plan_revision or base_version.revision <> p_expected_version_revision then
    raise exception using errcode = 'PT409', message = 'Revision conflict';
  end if;

  content_changed := base_version.guidance is distinct from p_guidance
    or peppitness_private.workout_version_content(actor, base_version.id) is distinct from peppitness_private.normalize_workout_days(p_days);
  name_changed := selected_plan.name is distinct from p_title;
  cycle_changed := row(selected_plan.cycle_start, selected_plan.cycle_weeks::integer) is distinct from row(p_cycle_start, p_cycle_weeks);
  -- Con la versione bloccata, una seduta concorrente attende (start_workout_session la legge FOR SHARE):
  -- l'esito di questo controllo resta valido fino alla fine della transazione.
  used := exists (select 1 from public.workout_sessions where owner_id = actor and version_id = base_version.id);
  target := base_version;

  if not content_changed then
    if not name_changed and not cycle_changed and (used or base_version.title = p_title) then
      return jsonb_build_object('outcome', 'unchanged', 'version_id', base_version.id, 'version_number', base_version.version_number,
        'version_revision', base_version.revision, 'plan_revision', selected_plan.revision);
    end if;
    outcome := 'metadata';
    -- Il titolo di una versione mai usata segue il nome; una versione usata non cambia.
    if not used and base_version.title <> p_title then
      perform pg_catalog.set_config('peppitness.revise_version', base_version.id::text, true);
      update public.workout_plan_versions set title = p_title, revision = revision + 1
        where id = base_version.id and owner_id = actor returning * into target;
      perform pg_catalog.set_config('peppitness.revise_version', '', true);
    end if;
  elsif not used then
    outcome := 'updated';
    perform pg_catalog.set_config('peppitness.revise_version', base_version.id::text, true);
    update public.workout_plan_versions set title = p_title, guidance = p_guidance, revision = revision + 1
      where id = base_version.id and owner_id = actor returning * into target;
    delete from public.workout_days where version_id = base_version.id and owner_id = actor;
    perform peppitness_private.write_workout_days(actor, base_version.id, p_days, true);
    perform pg_catalog.set_config('peppitness.revise_version', '', true);
  else
    outcome := 'created';
    insert into public.workout_plan_versions(id, owner_id, plan_id, version_number, title, guidance)
    values (p_new_version_id, actor, p_plan_id,
      (select coalesce(max(version_number), 0) + 1 from public.workout_plan_versions where plan_id = p_plan_id and owner_id = actor),
      p_title, p_guidance) returning * into target;
    perform peppitness_private.write_workout_days(actor, target.id, p_days, false);
    update public.workout_plan_versions set status = 'published', published_at = now(), revision = revision + 1
      where id = target.id and owner_id = actor returning * into target;
  end if;

  if name_changed or cycle_changed or selected_plan.active_version_id is distinct from target.id then
    update public.workout_plans set name = p_title, cycle_start = p_cycle_start, cycle_weeks = p_cycle_weeks,
      active_version_id = target.id, revision = revision + 1
      where id = selected_plan.id and owner_id = actor returning * into selected_plan;
  end if;
  return jsonb_build_object('outcome', outcome, 'version_id', target.id, 'version_number', target.version_number,
    'version_revision', target.revision, 'plan_revision', selected_plan.revision);
end;
$$;

revoke all on function public.save_workout_revision(uuid, uuid, integer, integer, uuid, text, text, jsonb, date, integer) from public, anon;
grant execute on function public.save_workout_revision(uuid, uuid, integer, integer, uuid, text, text, jsonb, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Avvio seduta: identico alla versione originale, ma legge la versione FOR SHARE.
-- Così non può partire a metà di un aggiornamento della stessa versione, e un
-- aggiornamento successivo vede la seduta e crea vN+1.
-- ---------------------------------------------------------------------------
create or replace function public.start_workout_session(
  p_session_id uuid, p_version_id uuid, p_day_id uuid, p_diary_date date, p_time_zone text
) returns public.workout_sessions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  existing public.workout_sessions;
  selected_version public.workout_plan_versions;
  selected_day public.workout_days;
  snapshot jsonb;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_session_id is null or p_version_id is null or p_day_id is null or p_diary_date is null
    or p_diary_date < date '2000-01-01' or p_diary_date > date '2200-01-01' then
    raise exception using errcode = '22023', message = 'Invalid session';
  end if;
  -- Serializza gli avvii dello stesso account: due retry concorrenti con lo stesso ID
  -- restituiscono la stessa seduta invece di un errore di unicita. Nessun lock fra account.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text, 280928));
  select * into existing from public.workout_sessions where id = p_session_id;
  if FOUND then
    if existing.owner_id <> actor then raise exception using errcode = '42501', message = 'Session not available'; end if;
    if existing.version_id <> p_version_id or existing.day_id <> p_day_id or existing.diary_date <> p_diary_date then
      raise exception using errcode = 'PT409', message = 'Session id already used';
    end if;
    return existing;
  end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = p_time_zone) then
    raise exception using errcode = '23514', message = 'Unknown time zone';
  end if;
  select * into selected_version from public.workout_plan_versions where id = p_version_id and owner_id = actor for share;
  if not FOUND then raise exception using errcode = '42501', message = 'Version not available'; end if;
  if selected_version.status <> 'published' then
    raise exception using errcode = '55000', message = 'Sessions need a published version';
  end if;
  select * into selected_day from public.workout_days where id = p_day_id and owner_id = actor and version_id = p_version_id;
  if not FOUND then raise exception using errcode = '42501', message = 'Workout day not available'; end if;
  if exists (select 1 from public.workout_sessions where owner_id = actor and status = 'active') then
    raise exception using errcode = 'PT409', message = 'Another session is active';
  end if;
  select jsonb_build_object(
    'label', selected_day.label, 'title', selected_day.title, 'note', selected_day.note,
    'plan_title', selected_version.title, 'version_number', selected_version.version_number,
    'exercises', coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'exercise_id', p.exercise_id, 'name', p.exercise_snapshot->>'name',
      'variant', p.exercise_snapshot->>'variant', 'equipment', p.exercise_snapshot->>'equipment',
      'load_convention', p.exercise_snapshot->>'load_convention', 'load_unit', p.exercise_snapshot->>'load_unit',
      'per_side', (p.exercise_snapshot->>'per_side')::boolean, 'exercise_note', p.exercise_snapshot->>'note',
      'mode', p.mode, 'sets', p.sets, 'optional_sets', p.optional_sets,
      'reps_min', p.reps_min, 'reps_max', p.reps_max, 'duration_seconds', p.duration_seconds,
      'rest_seconds', p.rest_seconds, 'rir', p.rir, 'rpe', p.rpe, 'note', p.note
    ) order by p.position), '[]'::jsonb))
  into snapshot
  from public.workout_prescriptions p where p.owner_id = actor and p.day_id = p_day_id;
  insert into public.workout_sessions(id, owner_id, plan_id, version_id, day_id, diary_date, time_zone, day_snapshot)
  values (p_session_id, actor, selected_version.plan_id, p_version_id, p_day_id, p_diary_date, p_time_zone, snapshot)
  returning * into existing;
  return existing;
end;
$$;

-- CREATE OR REPLACE conserva gli ACL; si ribadisce il confine pubblico.
revoke all on function peppitness_private.guard_workout_version() from public, anon, authenticated;
revoke all on function peppitness_private.guard_workout_child() from public, anon, authenticated;
revoke all on function public.start_workout_session(uuid, uuid, uuid, date, text) from public, anon;
grant execute on function public.start_workout_session(uuid, uuid, uuid, date, text) to authenticated;
