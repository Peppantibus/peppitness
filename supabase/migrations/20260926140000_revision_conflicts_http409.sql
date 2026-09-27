-- I conflitti di revisione sono errori applicativi HTTP 409, non serialization_failure.
-- PostgREST 14 ritenta SQLSTATE 40001: una revisione obsoleta non puo risolversi con retry.
-- Mantiene firme, privilegi, controlli di proprieta e atomicita delle funzioni esistenti.
-- Le migrazioni gia applicate restano invariate.


create or replace function peppitness_private.stamp_record()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.revision <> 1 then
      raise exception using errcode = '23514', message = 'Initial revision must be 1';
    end if;
    NEW.created_at := pg_catalog.clock_timestamp();
  else
    if NEW.owner_id is distinct from OLD.owner_id then
      raise exception using errcode = '42501', message = 'Owner cannot change';
    end if;
    if NEW.created_at is distinct from OLD.created_at then
      raise exception using errcode = '23514', message = 'Creation time cannot change';
    end if;
    -- Il client deve inviare revisione_letta + 1 insieme alla modifica.
    -- Il lock PostgreSQL sulla riga rende il controllo atomico anche tra dispositivi.
    if NEW.revision::bigint <> OLD.revision::bigint + 1 then
      raise exception using errcode = 'PT409', message = 'Revision conflict';
    end if;
  end if;
  NEW.updated_at := pg_catalog.clock_timestamp();
  return NEW;
end;
$$;

create or replace function public.save_workout_draft(
  p_plan_id uuid, p_version_id uuid, p_expected_revision integer,
  p_title text, p_guidance text, p_days jsonb
) returns public.workout_plan_versions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  selected_plan public.workout_plans;
  saved_version public.workout_plan_versions;
  selected_exercise public.exercises;
  day_item record;
  prescription_item record;
  day_id uuid;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_plan_id is null or p_version_id is null or p_expected_revision is null or p_expected_revision < 0
    or jsonb_typeof(p_days) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid draft document';
  end if;
  if jsonb_array_length(p_days) > 50 then raise exception using errcode = '22023', message = 'Too many workout days'; end if;
  select * into selected_plan from public.workout_plans where id = p_plan_id and owner_id = actor for update;
  if not FOUND then
    if p_expected_revision <> 0 then raise exception using errcode = '42501', message = 'Plan not available'; end if;
    insert into public.workout_plans(id, owner_id, name) values (p_plan_id, actor, p_title) returning * into selected_plan;
  end if;
  if selected_plan.archived_at is not null then raise exception using errcode = '55000', message = 'Plan is archived'; end if;
  select * into saved_version from public.workout_plan_versions
    where id = p_version_id and owner_id = actor and plan_id = p_plan_id for update;
  if FOUND then
    if saved_version.revision <> p_expected_revision then raise exception using errcode = 'PT409', message = 'Revision conflict'; end if;
    if saved_version.status <> 'draft' then raise exception using errcode = '55000', message = 'Published versions are immutable'; end if;
    update public.workout_plan_versions set title = p_title, guidance = p_guidance, revision = revision + 1
    where id = p_version_id and owner_id = actor returning * into saved_version;
    delete from public.workout_days where version_id = p_version_id and owner_id = actor;
  else
    if p_expected_revision <> 0 then raise exception using errcode = 'PT409', message = 'Revision conflict'; end if;
    insert into public.workout_plan_versions(id, owner_id, plan_id, version_number, title, guidance)
    values (p_version_id, actor, p_plan_id,
      (select coalesce(max(version_number), 0) + 1 from public.workout_plan_versions where plan_id = p_plan_id and owner_id = actor),
      p_title, p_guidance) returning * into saved_version;
  end if;
  for day_item in select value, ordinality from jsonb_array_elements(p_days) with ordinality loop
    if jsonb_typeof(day_item.value) is distinct from 'object'
      or jsonb_typeof(day_item.value->'exercises') is distinct from 'array' then
      raise exception using errcode = '22023', message = 'Invalid workout day';
    end if;
    if jsonb_array_length(day_item.value->'exercises') > 200 then raise exception using errcode = '22023', message = 'Too many prescriptions'; end if;
    day_id := (day_item.value->>'id')::uuid;
    insert into public.workout_days(id, owner_id, version_id, position, label, title, note)
    values (day_id, actor, p_version_id, day_item.ordinality - 1,
      day_item.value->>'label', day_item.value->>'title', coalesce(day_item.value->>'note', ''));
    for prescription_item in select value, ordinality from jsonb_array_elements(day_item.value->'exercises') with ordinality loop
      if jsonb_typeof(prescription_item.value) is distinct from 'object' then raise exception using errcode = '22023', message = 'Invalid prescription'; end if;
      select * into selected_exercise from public.exercises
      where id = (prescription_item.value->>'exercise_id')::uuid and owner_id = actor and archived_at is null;
      if not FOUND then raise exception using errcode = '42501', message = 'Exercise not available'; end if;
      insert into public.workout_prescriptions(id, owner_id, day_id, exercise_id, position, exercise_snapshot,
        mode, sets, optional_sets, reps_min, reps_max, duration_seconds, rest_seconds, rir, rpe, note)
      values ((prescription_item.value->>'id')::uuid, actor, day_id, selected_exercise.id, prescription_item.ordinality - 1,
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
  return saved_version;
end;
$$;

create or replace function public.publish_workout_version(p_version_id uuid, p_expected_revision integer, p_expected_plan_revision integer)
returns public.workout_plan_versions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  selected_version public.workout_plan_versions;
  selected_plan public.workout_plans;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  select * into selected_version from public.workout_plan_versions where id = p_version_id and owner_id = actor;
  if not FOUND then raise exception using errcode = '42501', message = 'Version not available'; end if;
  -- Stesso ordine di lock del salvataggio: programma, poi versione.
  select * into selected_plan from public.workout_plans where id = selected_version.plan_id and owner_id = actor for update;
  select * into selected_version from public.workout_plan_versions where id = p_version_id and owner_id = actor for update;
  if selected_version.revision is distinct from p_expected_revision or selected_plan.revision is distinct from p_expected_plan_revision then
    raise exception using errcode = 'PT409', message = 'Revision conflict';
  end if;
  if selected_plan.archived_at is not null then raise exception using errcode = '55000', message = 'Plan is archived'; end if;
  if selected_version.status <> 'draft' then raise exception using errcode = '55000', message = 'Version already published'; end if;
  if not exists (select 1 from public.workout_days where version_id = p_version_id and owner_id = actor)
    or exists (select 1 from public.workout_days d where d.version_id = p_version_id and d.owner_id = actor
      and not exists (select 1 from public.workout_prescriptions p where p.day_id = d.id and p.owner_id = actor)) then
    raise exception using errcode = '23514', message = 'Each published workout day needs prescriptions';
  end if;
  update public.workout_plan_versions set status = 'published', published_at = now(), revision = revision + 1
    where id = p_version_id and owner_id = actor returning * into selected_version;
  update public.workout_plans set active_version_id = p_version_id, revision = revision + 1
    where id = selected_plan.id and owner_id = actor;
  return selected_version;
end;
$$;

-- CREATE OR REPLACE conserva gli ACL; ribadire il confine pubblico delle RPC.
revoke all on function peppitness_private.stamp_record() from public, anon, authenticated;
revoke all on function public.save_workout_draft(uuid, uuid, integer, text, text, jsonb) from public, anon;
revoke all on function public.publish_workout_version(uuid, integer, integer) from public, anon;
grant execute on function public.save_workout_draft(uuid, uuid, integer, text, text, jsonb) to authenticated;
grant execute on function public.publish_workout_version(uuid, integer, integer) to authenticated;
