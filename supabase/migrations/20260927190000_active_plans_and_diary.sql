-- Programma attivo per account, diario allenamenti, piano alimentare e diario pasti.
-- Estende le tre migrazioni gia applicate senza riscriverle. Nessun dato o seed.
-- Convenzioni invariate: owner_id = auth.uid(), relazioni composite per proprietario,
-- revisione letta + 1 tramite stamp_record() (conflitto PT409 -> HTTP 409), RLS forzata,
-- grants espliciti per colonna e funzioni con search_path vuoto.

-- ---------------------------------------------------------------------------
-- Piano alimentare: aggregato unico (giornate, pasti, alimenti, alternative) salvato
-- in una sola riga, quindi sempre atomico. Il diario conserva uno snapshot del pasto:
-- modificare il piano non riscrive le registrazioni passate.
-- ---------------------------------------------------------------------------
create table public.meal_plans (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 160),
  -- Tetto complessivo oltre ai limiti per campo: un piano reale occupa poche decine di KB.
  document jsonb not null check (octet_length(document::text) <= 262144),
  archived_at timestamptz,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id)
);
create index meal_plans_owner_idx on public.meal_plans(owner_id, id);

create function peppitness_private.valid_text(value jsonb, max_length integer, required boolean)
returns boolean language sql immutable set search_path = '' as $$
  select value is not null and jsonb_typeof(value) = 'string'
    and pg_catalog.char_length(value #>> '{}') <= max_length
    and (not required or pg_catalog.btrim(value #>> '{}') <> '')
    and (value #>> '{}') !~ '[\x01-\x08\x0B\x0C\x0E-\x1F]';
$$;

create function peppitness_private.valid_text_list(value jsonb, max_items integer, max_length integer)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(value) = 'array' and jsonb_array_length(value) <= max_items
    and not exists (
      select 1 from jsonb_array_elements(value) as item(v)
      where not peppitness_private.valid_text(item.v, max_length, true)
    );
$$;

create function peppitness_private.valid_uuid(value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select jsonb_typeof(value) = 'string'
    and (value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

-- Struttura V1 del documento. Proprieta sconosciute rifiutate: il client non puo
-- nascondere campi non validati nel piano.
-- SECURITY DEFINER: usa gli helper dello schema privato, non accessibile al client.
-- Legge soltanto NEW, nessuna tabella.
create function peppitness_private.validate_meal_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  doc jsonb := NEW.document;
  day_item jsonb; meal_item jsonb; food_item jsonb;
  ids text[] := '{}';
begin
  if jsonb_typeof(doc) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(doc) k where k not in ('guidance', 'days'))
    or not peppitness_private.valid_text(doc->'guidance', 16000, false)
    or jsonb_typeof(doc->'days') is distinct from 'array'
    or jsonb_array_length(doc->'days') > 14 then
    raise exception using errcode = '23514', message = 'Invalid meal plan document';
  end if;
  for day_item in select value from jsonb_array_elements(doc->'days') loop
    if jsonb_typeof(day_item) is distinct from 'object'
      or exists (select 1 from jsonb_object_keys(day_item) k where k not in ('id', 'name', 'dayType', 'note', 'meals'))
      or not peppitness_private.valid_uuid(day_item->'id')
      or not peppitness_private.valid_text(day_item->'name', 120, true)
      or coalesce(day_item->>'dayType', '') not in ('training', 'rest', 'any')
      or not peppitness_private.valid_text(day_item->'note', 4000, false)
      or jsonb_typeof(day_item->'meals') is distinct from 'array'
      or jsonb_array_length(day_item->'meals') > 20
      or (day_item->>'id') = any(ids) then
      raise exception using errcode = '23514', message = 'Invalid meal plan day';
    end if;
    ids := array_append(ids, day_item->>'id');
    for meal_item in select value from jsonb_array_elements(day_item->'meals') loop
      if jsonb_typeof(meal_item) is distinct from 'object'
        or exists (select 1 from jsonb_object_keys(meal_item) k
          where k not in ('id', 'name', 'time', 'foods', 'alternatives', 'additions', 'note'))
        or not peppitness_private.valid_uuid(meal_item->'id')
        or not peppitness_private.valid_text(meal_item->'name', 120, true)
        or not peppitness_private.valid_text(meal_item->'time', 60, false)
        or not peppitness_private.valid_text(meal_item->'note', 4000, false)
        or not peppitness_private.valid_text_list(meal_item->'alternatives', 30, 500)
        or not peppitness_private.valid_text_list(meal_item->'additions', 30, 500)
        or jsonb_typeof(meal_item->'foods') is distinct from 'array'
        or jsonb_array_length(meal_item->'foods') > 60
        or (meal_item->>'id') = any(ids) then
        raise exception using errcode = '23514', message = 'Invalid meal';
      end if;
      ids := array_append(ids, meal_item->>'id');
      for food_item in select value from jsonb_array_elements(meal_item->'foods') loop
        if jsonb_typeof(food_item) is distinct from 'object'
          or exists (select 1 from jsonb_object_keys(food_item) k where k not in ('name', 'quantity'))
          or not peppitness_private.valid_text(food_item->'name', 200, true)
          or not peppitness_private.valid_text(food_item->'quantity', 60, false) then
          raise exception using errcode = '23514', message = 'Invalid meal food';
        end if;
      end loop;
    end loop;
  end loop;
  if TG_OP = 'UPDATE' and NEW.id is distinct from OLD.id then
    raise exception using errcode = '23514', message = 'Meal plan identity cannot change';
  end if;
  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- Selezione persistente dei piani attivi dell'account (una riga per account).
-- active_version_id resta la versione corrente dentro ciascun programma.
-- ---------------------------------------------------------------------------
create table public.active_plans (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  workout_plan_id uuid,
  meal_plan_id uuid,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, workout_plan_id) references public.workout_plans(owner_id, id),
  foreign key (owner_id, meal_plan_id) references public.meal_plans(owner_id, id)
);

create function peppitness_private.validate_active_plans()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if NEW.workout_plan_id is not null and not exists (
    select 1 from public.workout_plans p
    where p.owner_id = NEW.owner_id and p.id = NEW.workout_plan_id
      and p.archived_at is null and p.active_version_id is not null
  ) then
    raise exception using errcode = '23514', message = 'Active workout plan needs a published version';
  end if;
  if NEW.meal_plan_id is not null and not exists (
    select 1 from public.meal_plans m
    where m.owner_id = NEW.owner_id and m.id = NEW.meal_plan_id and m.archived_at is null
  ) then
    raise exception using errcode = '23514', message = 'Active meal plan is not available';
  end if;
  return NEW;
end;
$$;

-- Riattivazione esplicita di una versione gia pubblicata: nessuna modifica alla versione.
create function public.activate_workout_version(p_version_id uuid, p_expected_plan_revision integer)
returns public.workout_plans
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  selected_version public.workout_plan_versions;
  selected_plan public.workout_plans;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  select * into selected_version from public.workout_plan_versions where id = p_version_id and owner_id = actor;
  if not FOUND then raise exception using errcode = '42501', message = 'Version not available'; end if;
  if selected_version.status <> 'published' then
    raise exception using errcode = '55000', message = 'Only published versions can be activated';
  end if;
  select * into selected_plan from public.workout_plans
    where id = selected_version.plan_id and owner_id = actor for update;
  if selected_plan.revision is distinct from p_expected_plan_revision then
    raise exception using errcode = 'PT409', message = 'Revision conflict';
  end if;
  if selected_plan.archived_at is not null then raise exception using errcode = '55000', message = 'Plan is archived'; end if;
  update public.workout_plans set active_version_id = p_version_id, revision = revision + 1
    where id = selected_plan.id and owner_id = actor returning * into selected_plan;
  return selected_plan;
end;
$$;

-- ---------------------------------------------------------------------------
-- Diario allenamenti. La seduta conserva lo snapshot completo della prescrizione:
-- una nuova versione del programma non modifica le sedute passate.
-- ---------------------------------------------------------------------------
create table public.workout_sessions (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  plan_id uuid not null,
  version_id uuid not null,
  day_id uuid not null,
  diary_date date not null,
  time_zone text not null check (char_length(time_zone) between 1 and 80),
  day_snapshot jsonb not null check (jsonb_typeof(day_snapshot) = 'object'),
  status text not null default 'active' check (status in ('active', 'completed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  note text not null default '' check (char_length(note) <= 4000),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, id),
  foreign key (owner_id, plan_id, version_id) references public.workout_plan_versions(owner_id, plan_id, id),
  foreign key (owner_id, day_id) references public.workout_days(owner_id, id),
  check ((status = 'active' and completed_at is null) or (status = 'completed' and completed_at is not null))
);
-- Una sola seduta in corso per account, anche fra dispositivi diversi.
create unique index workout_sessions_one_active on public.workout_sessions(owner_id) where status = 'active';
create index workout_sessions_owner_date_idx on public.workout_sessions(owner_id, diary_date, started_at);

create function peppitness_private.guard_workout_session()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if row(NEW.id, NEW.plan_id, NEW.version_id, NEW.day_id, NEW.diary_date, NEW.time_zone, NEW.day_snapshot, NEW.started_at)
     is distinct from
     row(OLD.id, OLD.plan_id, OLD.version_id, OLD.day_id, OLD.diary_date, OLD.time_zone, OLD.day_snapshot, OLD.started_at) then
    raise exception using errcode = '23514', message = 'Session context cannot change';
  end if;
  if OLD.status = 'completed' and NEW.status = 'active' then
    raise exception using errcode = '55000', message = 'Completed sessions cannot restart';
  end if;
  if OLD.status = 'active' and NEW.status = 'completed' then
    NEW.completed_at := pg_catalog.clock_timestamp();
  else
    NEW.completed_at := OLD.completed_at;
  end if;
  return NEW;
end;
$$;

create table public.workout_set_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id uuid not null,
  prescription_id uuid not null,
  set_index integer not null check (set_index between 0 and 1999),
  -- Vuoto (null) e zero restano distinti. Unita e convenzione sono nello snapshot.
  load numeric check (load >= 0 and load <= 100000),
  amount numeric check (amount >= 0 and amount <= 100000),
  completed boolean not null default false,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, session_id) references public.workout_sessions(owner_id, id) on delete cascade,
  unique (owner_id, session_id, prescription_id, set_index),
  check (not completed or amount is not null)
);

create function peppitness_private.validate_set_log()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  prescription jsonb;
begin
  if TG_OP = 'UPDATE' and row(NEW.id, NEW.session_id, NEW.prescription_id, NEW.set_index)
    is distinct from row(OLD.id, OLD.session_id, OLD.prescription_id, OLD.set_index) then
    raise exception using errcode = '23514', message = 'Set identity cannot change';
  end if;
  select e.value into prescription
  from public.workout_sessions s, jsonb_array_elements(s.day_snapshot->'exercises') e
  where s.owner_id = NEW.owner_id and s.id = NEW.session_id and e.value->>'id' = NEW.prescription_id::text;
  if prescription is null
    or NEW.set_index >= (prescription->>'sets')::integer + (prescription->>'optional_sets')::integer then
    raise exception using errcode = '23514', message = 'Set is not part of the session';
  end if;
  if prescription->>'mode' = 'reps' and NEW.amount is not null and NEW.amount <> trunc(NEW.amount) then
    raise exception using errcode = '23514', message = 'Repetitions must be integers';
  end if;
  return NEW;
end;
$$;

-- Avvio idempotente: lo stesso ID restituisce la seduta gia creata (risposta persa).
-- Snapshot generato dal server dalla versione pubblicata, non fornito dal client.
create function public.start_workout_session(
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
  select * into selected_version from public.workout_plan_versions where id = p_version_id and owner_id = actor;
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

-- ---------------------------------------------------------------------------
-- Diario alimentare: tipo di giornata e registrazioni dei pasti per data locale.
-- ---------------------------------------------------------------------------
create table public.diary_days (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  diary_date date not null,
  day_type text not null check (day_type in ('training', 'rest')),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, diary_date)
);

create table public.meal_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  diary_date date not null,
  meal_id uuid not null,
  meal_plan_id uuid not null,
  status text not null check (status in ('unrecorded', 'followed', 'modified', 'skipped')),
  note text not null default '' check (char_length(note) <= 1500),
  -- Contesto al momento della registrazione: non segue modifiche future del piano.
  day_type text not null check (day_type in ('training', 'rest')),
  meal_snapshot jsonb not null check (jsonb_typeof(meal_snapshot) = 'object' and octet_length(meal_snapshot::text) <= 65536),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, meal_plan_id) references public.meal_plans(owner_id, id),
  unique (owner_id, diary_date, meal_id)
);

create function peppitness_private.validate_meal_log()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'UPDATE' and row(NEW.id, NEW.diary_date, NEW.meal_id, NEW.meal_plan_id, NEW.day_type, NEW.meal_snapshot)
    is distinct from row(OLD.id, OLD.diary_date, OLD.meal_id, OLD.meal_plan_id, OLD.day_type, OLD.meal_snapshot) then
    raise exception using errcode = '23514', message = 'Meal log context cannot change';
  end if;
  if NEW.meal_snapshot->>'id' is distinct from NEW.meal_id::text
    or not peppitness_private.valid_text(NEW.meal_snapshot->'name', 120, true) then
    raise exception using errcode = '23514', message = 'Invalid meal snapshot';
  end if;
  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- Trigger, privilegi e policy.
-- ---------------------------------------------------------------------------
create trigger a_stamp_record before insert or update on public.meal_plans
for each row execute function peppitness_private.stamp_record();
create trigger b_validate_meal_plan before insert or update on public.meal_plans
for each row execute function peppitness_private.validate_meal_plan();
create trigger a_stamp_record before insert or update on public.active_plans
for each row execute function peppitness_private.stamp_record();
create trigger b_validate_active_plans before insert or update on public.active_plans
for each row execute function peppitness_private.validate_active_plans();
create trigger a_stamp_record before insert or update on public.workout_sessions
for each row execute function peppitness_private.stamp_record();
create trigger b_guard_session before update on public.workout_sessions
for each row execute function peppitness_private.guard_workout_session();
create trigger a_stamp_record before insert or update on public.workout_set_logs
for each row execute function peppitness_private.stamp_record();
create trigger b_validate_set before insert or update on public.workout_set_logs
for each row execute function peppitness_private.validate_set_log();
create trigger a_stamp_record before insert or update on public.diary_days
for each row execute function peppitness_private.stamp_record();
create trigger a_stamp_record before insert or update on public.meal_logs
for each row execute function peppitness_private.stamp_record();
create trigger b_validate_meal_log before insert or update on public.meal_logs
for each row execute function peppitness_private.validate_meal_log();

revoke all on function peppitness_private.valid_text(jsonb, integer, boolean) from public, anon, authenticated;
revoke all on function peppitness_private.valid_text_list(jsonb, integer, integer) from public, anon, authenticated;
revoke all on function peppitness_private.valid_uuid(jsonb) from public, anon, authenticated;
revoke all on function peppitness_private.validate_meal_plan() from public, anon, authenticated;
revoke all on function peppitness_private.validate_active_plans() from public, anon, authenticated;
revoke all on function peppitness_private.guard_workout_session() from public, anon, authenticated;
revoke all on function peppitness_private.validate_set_log() from public, anon, authenticated;
revoke all on function peppitness_private.validate_meal_log() from public, anon, authenticated;

alter table public.meal_plans enable row level security;
alter table public.meal_plans force row level security;
alter table public.active_plans enable row level security;
alter table public.active_plans force row level security;
alter table public.workout_sessions enable row level security;
alter table public.workout_sessions force row level security;
alter table public.workout_set_logs enable row level security;
alter table public.workout_set_logs force row level security;
alter table public.diary_days enable row level security;
alter table public.diary_days force row level security;
alter table public.meal_logs enable row level security;
alter table public.meal_logs force row level security;

revoke all on table public.meal_plans, public.active_plans, public.workout_sessions,
  public.workout_set_logs, public.diary_days, public.meal_logs from public, anon, authenticated;

grant select on public.meal_plans, public.active_plans, public.workout_sessions,
  public.workout_set_logs, public.diary_days, public.meal_logs to authenticated;
grant insert(id, name, document) on public.meal_plans to authenticated;
grant update(name, document, archived_at, revision) on public.meal_plans to authenticated;
grant insert(workout_plan_id, meal_plan_id) on public.active_plans to authenticated;
grant update(workout_plan_id, meal_plan_id, revision) on public.active_plans to authenticated;
-- Le sedute nascono solo dalla RPC (snapshot server). Il client completa o annota.
grant update(status, note, revision) on public.workout_sessions to authenticated;
grant delete on public.workout_sessions to authenticated;
grant insert(session_id, prescription_id, set_index, load, amount, completed) on public.workout_set_logs to authenticated;
grant update(load, amount, completed, revision) on public.workout_set_logs to authenticated;
grant insert(diary_date, day_type) on public.diary_days to authenticated;
grant update(day_type, revision) on public.diary_days to authenticated;
grant insert(diary_date, meal_id, meal_plan_id, status, note, day_type, meal_snapshot) on public.meal_logs to authenticated;
grant update(status, note, revision) on public.meal_logs to authenticated;

create policy meal_plans_select_own on public.meal_plans for select to authenticated using (owner_id = (select auth.uid()));
create policy meal_plans_insert_own on public.meal_plans for insert to authenticated with check (owner_id = (select auth.uid()));
create policy meal_plans_update_own on public.meal_plans for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy active_plans_select_own on public.active_plans for select to authenticated using (owner_id = (select auth.uid()));
create policy active_plans_insert_own on public.active_plans for insert to authenticated with check (owner_id = (select auth.uid()));
create policy active_plans_update_own on public.active_plans for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy workout_sessions_select_own on public.workout_sessions for select to authenticated using (owner_id = (select auth.uid()));
create policy workout_sessions_update_own on public.workout_sessions for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
-- Solo una seduta ancora in corso puo essere annullata; lo storico completato resta.
create policy workout_sessions_discard_active on public.workout_sessions for delete to authenticated
  using (owner_id = (select auth.uid()) and status = 'active');
create policy workout_set_logs_select_own on public.workout_set_logs for select to authenticated using (owner_id = (select auth.uid()));
create policy workout_set_logs_insert_own on public.workout_set_logs for insert to authenticated with check (owner_id = (select auth.uid()));
create policy workout_set_logs_update_own on public.workout_set_logs for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy diary_days_select_own on public.diary_days for select to authenticated using (owner_id = (select auth.uid()));
create policy diary_days_insert_own on public.diary_days for insert to authenticated with check (owner_id = (select auth.uid()));
create policy diary_days_update_own on public.diary_days for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy meal_logs_select_own on public.meal_logs for select to authenticated using (owner_id = (select auth.uid()));
create policy meal_logs_insert_own on public.meal_logs for insert to authenticated with check (owner_id = (select auth.uid()));
create policy meal_logs_update_own on public.meal_logs for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

revoke all on function public.activate_workout_version(uuid, integer) from public, anon;
revoke all on function public.start_workout_session(uuid, uuid, uuid, date, text) from public, anon;
grant execute on function public.activate_workout_version(uuid, integer) to authenticated;
grant execute on function public.start_workout_session(uuid, uuid, uuid, date, text) to authenticated;

comment on table public.active_plans is 'Programma e piano alimentare selezionati per account; update con revisione letta + 1.';
comment on table public.workout_sessions is 'Sedute con snapshot della prescrizione; avvio solo tramite start_workout_session.';
comment on table public.workout_set_logs is 'Risultati per serie, correggibili con revisione; vuoto e zero distinti.';
comment on table public.meal_plans is 'Piano alimentare come documento unico validato; nessun valore nutrizionale calcolato.';
comment on table public.meal_logs is 'Registrazioni dei pasti con snapshot e tipo di giornata al momento della registrazione.';
