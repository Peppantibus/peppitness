-- Programmi e versioni. Tutte le scritture composte passano dalle due RPC atomiche.
create table public.workout_plans (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 160),
  note text not null default '' check (char_length(note) <= 4000),
  active_version_id uuid,
  archived_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id)
);

create table public.workout_plan_versions (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid not null,
  version_number integer not null check (version_number > 0),
  title text not null check (title = btrim(title) and char_length(title) between 1 and 160),
  guidance text not null default '' check (char_length(guidance) <= 16000),
  status text not null default 'draft' check (status in ('draft', 'published')),
  published_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, plan_id) references public.workout_plans(owner_id, id) on delete cascade,
  unique (owner_id, id),
  unique (owner_id, plan_id, id),
  unique (owner_id, plan_id, version_number),
  check ((status = 'draft' and published_at is null) or (status = 'published' and published_at is not null))
);

alter table public.workout_plans add constraint workout_plans_active_version_fk
foreign key (owner_id, id, active_version_id)
references public.workout_plan_versions(owner_id, plan_id, id);

create table public.workout_days (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  version_id uuid not null,
  position integer not null check (position >= 0),
  label text not null check (label = btrim(label) and char_length(label) between 1 and 40),
  title text not null check (char_length(btrim(title)) between 1 and 160 and char_length(title) <= 160),
  note text not null default '' check (char_length(note) <= 4000),
  foreign key (owner_id, version_id) references public.workout_plan_versions(owner_id, id) on delete cascade,
  unique (owner_id, id),
  unique (owner_id, version_id, position),
  unique (owner_id, version_id, label)
);

create table public.workout_prescriptions (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  day_id uuid not null,
  exercise_id uuid not null,
  position integer not null check (position >= 0),
  -- Fotografia canonica dell'esercizio: la rinomina del catalogo non cambia il piano.
  exercise_snapshot jsonb not null check (jsonb_typeof(exercise_snapshot) = 'object'),
  mode text not null check (mode in ('reps', 'seconds')),
  sets integer not null check (sets between 1 and 1000),
  optional_sets integer not null default 0 check (optional_sets between 0 and 1000),
  reps_min integer check (reps_min between 1 and 10000),
  reps_max integer check (reps_max between 1 and 10000),
  duration_seconds integer check (duration_seconds between 1 and 86400),
  rest_seconds integer not null default 0 check (rest_seconds between 0 and 86400),
  rir numeric check (rir between 0 and 10),
  rpe numeric check (rpe between 1 and 10),
  note text not null default '' check (char_length(note) <= 4000),
  foreign key (owner_id, day_id) references public.workout_days(owner_id, id) on delete cascade,
  foreign key (owner_id, exercise_id) references public.exercises(owner_id, id),
  unique (owner_id, id),
  unique (owner_id, day_id, position),
  check ((mode = 'reps' and reps_min is not null and reps_max is not null and reps_min <= reps_max and duration_seconds is null)
    or (mode = 'seconds' and duration_seconds is not null and reps_min is null and reps_max is null))
);
create index workout_prescriptions_exercise_idx on public.workout_prescriptions(owner_id, exercise_id);
create index workout_plans_owner_updated_idx on public.workout_plans(owner_id, updated_at, id);

create function peppitness_private.guard_workout_version()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.status <> 'draft' then
      raise exception using errcode = '55000', message = 'Versions must start as drafts';
    end if;
  else
    -- La cancellazione amministrativa dell'account puo rimuovere tutto il suo archivio.
    if TG_OP = 'DELETE' and not exists (select 1 from auth.users where id = OLD.owner_id) then return OLD; end if;
    if OLD.status = 'published' then
      raise exception using errcode = '55000', message = 'Published versions are immutable';
    end if;
    if TG_OP = 'DELETE' then return OLD; end if;
    if row(NEW.id, NEW.plan_id, NEW.version_number) is distinct from row(OLD.id, OLD.plan_id, OLD.version_number) then
      raise exception using errcode = '23514', message = 'Version identity cannot change';
    end if;
  end if;
  return NEW;
end;
$$;

create function peppitness_private.guard_workout_child()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  parent_version uuid;
  parent_status text;
  record_owner uuid;
begin
  -- L'app modifica i figli soltanto sostituendo atomicamente una bozza tramite RPC.
  if TG_OP = 'UPDATE' then
    raise exception using errcode = '55000', message = 'Replace draft children atomically';
  end if;
  if TG_OP = 'DELETE' then
    record_owner := OLD.owner_id;
    if TG_TABLE_NAME = 'workout_days' then parent_version := OLD.version_id;
    else select version_id into parent_version from public.workout_days where owner_id = record_owner and id = OLD.day_id; end if;
  else
    record_owner := NEW.owner_id;
    if TG_TABLE_NAME = 'workout_days' then parent_version := NEW.version_id;
    else select version_id into parent_version from public.workout_days where owner_id = record_owner and id = NEW.day_id; end if;
  end if;
  select status into parent_status from public.workout_plan_versions
    where owner_id = record_owner and id = parent_version for update;
  if not FOUND and TG_OP = 'DELETE' then return OLD; end if; -- cascata del padre gia rimosso
  if parent_status is distinct from 'draft' then
    raise exception using errcode = '55000', message = 'Only draft children can change';
  end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;

create function peppitness_private.guard_active_workout_version()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' and NEW.id is distinct from OLD.id then
    raise exception using errcode = '23514', message = 'Plan identity cannot change';
  end if;
  if NEW.active_version_id is not null and not exists (
    select 1 from public.workout_plan_versions
    where id = NEW.active_version_id and owner_id = NEW.owner_id and plan_id = NEW.id and status = 'published'
  ) then raise exception using errcode = '23514', message = 'Active version must be published'; end if;
  return NEW;
end;
$$;

create trigger a_stamp_record before insert or update on public.workout_plans
for each row execute function peppitness_private.stamp_record();
create trigger b_guard_active before insert or update on public.workout_plans
for each row execute function peppitness_private.guard_active_workout_version();
create trigger a_stamp_record before insert or update on public.workout_plan_versions
for each row execute function peppitness_private.stamp_record();
create trigger b_guard_version before insert or update or delete on public.workout_plan_versions
for each row execute function peppitness_private.guard_workout_version();
create trigger guard_child before insert or update or delete on public.workout_days
for each row execute function peppitness_private.guard_workout_child();
create trigger guard_child before insert or update or delete on public.workout_prescriptions
for each row execute function peppitness_private.guard_workout_child();

revoke all on function peppitness_private.guard_workout_version() from public, anon, authenticated;
revoke all on function peppitness_private.guard_workout_child() from public, anon, authenticated;
revoke all on function peppitness_private.guard_active_workout_version() from public, anon, authenticated;

alter table public.workout_plans enable row level security;
alter table public.workout_plans force row level security;
alter table public.workout_plan_versions enable row level security;
alter table public.workout_plan_versions force row level security;
alter table public.workout_days enable row level security;
alter table public.workout_days force row level security;
alter table public.workout_prescriptions enable row level security;
alter table public.workout_prescriptions force row level security;
revoke all on table public.workout_plans, public.workout_plan_versions, public.workout_days, public.workout_prescriptions from public, anon, authenticated;
grant select on public.workout_plans, public.workout_plan_versions, public.workout_days, public.workout_prescriptions to authenticated;
grant update(name, note, archived_at, revision) on public.workout_plans to authenticated;
create policy workout_plans_read_own on public.workout_plans for select to authenticated using (owner_id = (select auth.uid()));
create policy workout_plans_update_own on public.workout_plans for update to authenticated
using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy workout_versions_read_own on public.workout_plan_versions for select to authenticated using (owner_id = (select auth.uid()));
create policy workout_days_read_own on public.workout_days for select to authenticated using (owner_id = (select auth.uid()));
create policy workout_prescriptions_read_own on public.workout_prescriptions for select to authenticated using (owner_id = (select auth.uid()));

-- SECURITY DEFINER necessario per scrivere i figli senza concedere al client scritture
-- che aggirerebbero revisione aggregata, snapshot e salvataggio atomico. Nessun SQL dinamico.
create function public.save_workout_draft(
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
    if saved_version.revision <> p_expected_revision then raise exception using errcode = '40001', message = 'Revision conflict'; end if;
    if saved_version.status <> 'draft' then raise exception using errcode = '55000', message = 'Published versions are immutable'; end if;
    update public.workout_plan_versions set title = p_title, guidance = p_guidance, revision = revision + 1
    where id = p_version_id and owner_id = actor returning * into saved_version;
    delete from public.workout_days where version_id = p_version_id and owner_id = actor;
  else
    if p_expected_revision <> 0 then raise exception using errcode = '40001', message = 'Revision conflict'; end if;
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

create function public.publish_workout_version(p_version_id uuid, p_expected_revision integer, p_expected_plan_revision integer)
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
    raise exception using errcode = '40001', message = 'Revision conflict';
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

revoke all on function public.save_workout_draft(uuid, uuid, integer, text, text, jsonb) from public, anon;
revoke all on function public.publish_workout_version(uuid, integer, integer) from public, anon;
grant execute on function public.save_workout_draft(uuid, uuid, integer, text, text, jsonb) to authenticated;
grant execute on function public.publish_workout_version(uuid, integer, integer) to authenticated;
