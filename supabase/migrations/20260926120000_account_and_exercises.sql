-- Primo incremento: impostazioni ed esercizi personali.
-- Non modifica public.rls_auto_enable o altre funzioni preesistenti.
-- Nessun dato personale o seed viene inserito dalla migrazione.

create schema peppitness_private;
revoke all on schema peppitness_private from public, anon, authenticated;

-- Tutte le future tabelle dell'app richiederanno GRANT espliciti.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

create function peppitness_private.stamp_record()
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
      raise exception using errcode = '40001', message = 'Revision conflict';
    end if;
  end if;
  NEW.updated_at := pg_catalog.clock_timestamp();
  return NEW;
end;
$$;

create function peppitness_private.validate_user_settings()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from pg_catalog.pg_timezone_names where name = NEW.time_zone
  ) then
    raise exception using errcode = '23514', message = 'Unknown time zone';
  end if;
  if pg_catalog.cardinality(NEW.workout_weekdays) <> (
    select count(distinct weekday)
    from pg_catalog.unnest(NEW.workout_weekdays) as weekday
  ) then
    raise exception using errcode = '23514', message = 'Workout weekdays must be unique';
  end if;
  return NEW;
end;
$$;

create function peppitness_private.protect_exercise_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if row(NEW.id, NEW.variant, NEW.equipment, NEW.load_convention,
         NEW.load_unit, NEW.measurement_mode, NEW.per_side)
     is distinct from
     row(OLD.id, OLD.variant, OLD.equipment, OLD.load_convention,
         OLD.load_unit, OLD.measurement_mode, OLD.per_side) then
    raise exception using errcode = '23514', message = 'Create a new exercise for a different comparison identity';
  end if;
  return NEW;
end;
$$;

revoke all on function peppitness_private.stamp_record() from public, anon, authenticated;
revoke all on function peppitness_private.validate_user_settings() from public, anon, authenticated;
revoke all on function peppitness_private.protect_exercise_identity() from public, anon, authenticated;

create table public.user_settings (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 120),
  time_zone text not null default 'Europe/Rome' check (char_length(time_zone) between 1 and 80),
  -- Giorni ISO: lunedi = 1, domenica = 7; nessun giorno obbligatorio.
  workout_weekdays smallint[] not null default '{}'::smallint[],
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint valid_workout_weekdays check (
    workout_weekdays <@ array[1,2,3,4,5,6,7]::smallint[]
    and array_position(workout_weekdays, null) is null
    and cardinality(workout_weekdays) <= 7
    and coalesce(array_ndims(workout_weekdays), 1) = 1
  )
);

create table public.exercises (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  variant text not null default '' check (char_length(variant) <= 120),
  equipment text not null default '' check (char_length(equipment) <= 120),
  load_convention text not null default 'total'
    check (load_convention in ('total', 'single-dumbbell', 'bodyweight')),
  load_unit text not null default 'kg' check (load_unit in ('kg', 'lb')),
  measurement_mode text not null default 'reps' check (measurement_mode in ('reps', 'seconds')),
  per_side boolean not null default false,
  note text not null default '' check (char_length(note) <= 4000),
  -- Archiviazione reversibile: l'ID rimane disponibile per le future relazioni storiche.
  archived_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exercises_owner_id_id_key unique (owner_id, id)
);

create index exercises_owner_updated_idx on public.exercises(owner_id, updated_at, id);

create trigger a_stamp_record before insert or update on public.user_settings
for each row execute function peppitness_private.stamp_record();
create trigger b_validate_settings before insert or update on public.user_settings
for each row execute function peppitness_private.validate_user_settings();
create trigger a_stamp_record before insert or update on public.exercises
for each row execute function peppitness_private.stamp_record();
create trigger b_protect_identity before update on public.exercises
for each row execute function peppitness_private.protect_exercise_identity();

alter table public.user_settings enable row level security;
alter table public.user_settings force row level security;
alter table public.exercises enable row level security;
alter table public.exercises force row level security;

revoke all on table public.user_settings, public.exercises from public, anon, authenticated;
grant select, insert on table public.user_settings, public.exercises to authenticated;
grant update(display_name, time_zone, workout_weekdays, revision)
  on public.user_settings to authenticated;
grant update(name, note, archived_at, revision) on public.exercises to authenticated;

create policy user_settings_select_own on public.user_settings
for select to authenticated using (owner_id = (select auth.uid()));
create policy user_settings_insert_own on public.user_settings
for insert to authenticated with check (owner_id = (select auth.uid()));
create policy user_settings_update_own on public.user_settings
for update to authenticated
using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create policy exercises_select_own on public.exercises
for select to authenticated using (owner_id = (select auth.uid()));
create policy exercises_insert_own on public.exercises
for insert to authenticated with check (owner_id = (select auth.uid()));
create policy exercises_update_own on public.exercises
for update to authenticated
using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

comment on table public.user_settings is 'Impostazioni private; update con revision = revisione letta + 1.';
comment on table public.exercises is 'Esercizi privati con identita di confronto stabile; archiviazione reversibile.';
comment on column public.exercises.owner_id is 'Deve coincidere con auth.uid(); le relazioni future usano la chiave (owner_id, id).';
