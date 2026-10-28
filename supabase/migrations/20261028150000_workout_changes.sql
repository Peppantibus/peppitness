-- Variazioni di occorrenze datate, senza modificare la settimana tipo o creare sedute future.
-- Le ricevute annullate sono tombstone; il replay precede le verifiche temporali.
create table public.workout_changes (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  command jsonb not null,
  change_doc jsonb not null,
  undo_request_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, session_id) references public.workout_sessions(owner_id, id) on delete cascade
);
create index workout_changes_owner on public.workout_changes(owner_id, id);
alter table public.workout_changes enable row level security;
alter table public.workout_changes force row level security;
revoke all on public.workout_changes from public, anon, authenticated;
grant select(id,owner_id,change_doc,updated_at) on public.workout_changes to authenticated;
create policy own_changes on public.workout_changes for select to authenticated using (owner_id = (select auth.uid()));
create policy mfa_aal2_required on public.workout_changes as restrictive for all to authenticated
  using ((select public.is_mfa_satisfied())) with check ((select public.is_mfa_satisfied()));

-- Permesso esatto, transazionale e privato: nessun GUC falsificabile dal client.
create table peppitness_private.session_change_permits (
  session_id uuid primary key, transaction_id bigint not null, before_snapshot jsonb not null, after_snapshot jsonb not null
);
revoke all on peppitness_private.session_change_permits from public,anon,authenticated;

create or replace function peppitness_private.guard_workout_session()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if row(NEW.id, NEW.plan_id, NEW.version_id, NEW.day_id, NEW.diary_date, NEW.time_zone, NEW.started_at)
    is distinct from row(OLD.id, OLD.plan_id, OLD.version_id, OLD.day_id, OLD.diary_date, OLD.time_zone, OLD.started_at) then
    raise exception using errcode = '23514', message = 'Session context cannot change';
  end if;
  if NEW.day_snapshot is distinct from OLD.day_snapshot and (OLD.status <> 'active' or not exists (
    select 1 from peppitness_private.session_change_permits p where p.session_id = OLD.id
      and p.transaction_id = pg_catalog.txid_current() and p.before_snapshot = OLD.day_snapshot and p.after_snapshot = NEW.day_snapshot
  )) then raise exception using errcode = '23514', message = 'Session context cannot change'; end if;
  if OLD.status = 'completed' and NEW.status = 'active' then
    raise exception using errcode = '55000', message = 'Completed sessions cannot restart';
  end if;
  if OLD.status = 'active' and NEW.status = 'completed' then NEW.completed_at := pg_catalog.clock_timestamp();
  else NEW.completed_at := OLD.completed_at; end if;
  return NEW;
end;
$$;
revoke all on function peppitness_private.guard_workout_session() from public,anon,authenticated;

create function peppitness_private.prescription_snapshot(p_owner uuid, p_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'exercise_id', p.exercise_id, 'name', p.exercise_snapshot->>'name',
    'variant', p.exercise_snapshot->>'variant', 'equipment', p.exercise_snapshot->>'equipment',
    'load_convention', p.exercise_snapshot->>'load_convention', 'load_unit', p.exercise_snapshot->>'load_unit',
    'per_side', p.exercise_snapshot->'per_side', 'exercise_note', p.exercise_snapshot->>'note',
    'muscle_group', e.muscle_group, 'mode', p.mode, 'sets', p.sets, 'optional_sets', p.optional_sets,
    'reps_min', p.reps_min, 'reps_max', p.reps_max, 'duration_seconds', p.duration_seconds,
    'rest_seconds', p.rest_seconds, 'rir', p.rir, 'rpe', p.rpe, 'note', p.note)
  from public.workout_prescriptions p join public.exercises e on e.id = p.exercise_id and e.owner_id = p.owner_id
  where p.owner_id = p_owner and p.id = p_id;
$$;

create function peppitness_private.replace_session_exercise(p_session uuid, p_exercise jsonb)
returns void language plpgsql set search_path = '' as $$
declare s public.workout_sessions; snapshot jsonb;
begin
  select * into strict s from public.workout_sessions where id = p_session for update;
  if s.status <> 'active' then raise exception using errcode = 'PT409', message = 'Session completed'; end if;
  select jsonb_set(s.day_snapshot, '{exercises}', jsonb_agg(case when e->>'id' = p_exercise->>'id' then p_exercise else e end order by n))
    into snapshot from jsonb_array_elements(s.day_snapshot->'exercises') with ordinality a(e,n);
  insert into peppitness_private.session_change_permits values (s.id, pg_catalog.txid_current(), s.day_snapshot, snapshot);
  update public.workout_sessions set day_snapshot = snapshot, revision = revision + 1 where id = s.id;
  delete from public.workout_set_logs where session_id = s.id and prescription_id = (p_exercise->>'id')::uuid
    and load is null and amount is null and not completed;
  delete from peppitness_private.session_change_permits where session_id = s.id;
end;
$$;

create function peppitness_private.check_change_slot(p_owner uuid, p_version uuid, p_date date, p_day uuid, p_id uuid, p_ignore uuid default null)
returns void language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.workout_changes c where c.owner_id = p_owner and c.id is distinct from p_ignore
    and c.change_doc->>'cancelled' = 'false' and c.change_doc->>'versionId' = p_version::text and (
      (c.change_doc->>'sourceDate' = p_date::text and c.change_doc->>'sourceDayId' = p_day::text and c.change_doc->>'sourceId' = p_id::text)
      or (c.change_doc->'partner'->>'date' = p_date::text and c.change_doc->'partner'->>'dayId' = p_day::text and c.change_doc->'partner'->>'prescriptionId' = p_id::text)
    )) then raise exception using errcode = 'PT409', message = 'Occurrence already changed'; end if;
  if exists (select 1 from public.workout_sessions s where s.owner_id = p_owner and s.version_id = p_version
    and s.diary_date = p_date and s.day_id = p_day and (s.status = 'completed' or exists (
      select 1 from public.workout_set_logs l where l.session_id = s.id and l.prescription_id = p_id
      and (l.load is not null or l.amount is not null or l.completed)))) then
    raise exception using errcode = 'PT409', message = 'Occurrence has results';
  end if;
end;
$$;

create function peppitness_private.valid_change_number(v jsonb, lo numeric, hi numeric, whole boolean default true)
returns boolean language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric between lo and hi
    and (not whole or (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric)) else false end;
$$;

create function public.apply_workout_change(p_request_id uuid, p_change jsonb, p_exercise_revision integer)
returns public.workout_changes language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); receipt public.workout_changes; s public.workout_sessions; plan public.workout_plans;
  selected public.exercises; base jsonb; target jsonb; other jsonb; canonical jsonb; partner jsonb := p_change->'partner';
  source_id uuid := (p_change->>'sourceId')::uuid; partner_id uuid; partner_day uuid; partner_date date;
  source_date date := (p_change->>'sourceDate')::date; created timestamptz := (p_change->>'createdAt')::timestamptz;
  other_session record; actual jsonb; source_group text; target_group text;
begin
  perform peppitness_private.require_mfa();
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text, 280928));
  select * into receipt from public.workout_changes where id = p_request_id;
  if found then
    if receipt.owner_id <> actor then raise exception using errcode = '42501', message = 'Change not available'; end if;
    if receipt.command is distinct from jsonb_build_object('change',p_change,'exerciseRevision',p_exercise_revision) then
      raise exception using errcode = 'PT409', message = 'Request already used'; end if;
    return receipt;
  end if;
  if p_request_id is null or p_change->>'id' is distinct from p_request_id::text or p_change->>'cancelled' is distinct from 'false'
    or created is null or source_date is null or source_id is null or source_date < date '2000-01-01' or source_date > date '2200-01-01'
    or created > clock_timestamp() + interval '5 minutes' or created < clock_timestamp() - interval '7 days' then
    raise exception using errcode = '22023', message = 'Invalid change'; end if;
  -- Ordine lock: account → selezione → programma → sedute (id) → catalogo. Le serie bloccano la propria seduta.
  perform 1 from public.active_plans where owner_id = actor for update;
  if exists (select 1 from public.active_plans where owner_id = actor and workout_plan_id is distinct from (p_change->>'planId')::uuid) then
    raise exception using errcode = 'PT409', message = 'Followed program changed'; end if;
  select * into plan from public.workout_plans where owner_id = actor and id = (p_change->>'planId')::uuid for update;
  if not found or plan.active_version_id is distinct from (p_change->>'versionId')::uuid or plan.archived_at is not null then
    raise exception using errcode = 'PT409', message = 'Program changed'; end if;
  perform 1 from public.workout_sessions where owner_id = actor order by id for update;
  select * into s from public.workout_sessions where owner_id = actor and id = (p_change->>'sessionId')::uuid;
  if not found then raise exception using errcode = '42501', message = 'Session not available'; end if;
  if s.status <> 'active' or s.plan_id <> plan.id or s.version_id <> plan.active_version_id
    or s.diary_date <> source_date or s.day_id::text is distinct from p_change->>'sourceDayId'
    or s.time_zone is distinct from p_change->>'timeZone' or (created at time zone s.time_zone)::date <> source_date then
    raise exception using errcode = 'PT409', message = 'Session changed'; end if;
  if exists (select 1 from public.workout_days d where d.owner_id = actor and d.version_id = s.version_id
    and lower(btrim(d.label)) not in ('lun','mar','mer','gio','ven','sab','dom')) then
    raise exception using errcode = '22023', message = 'Weekly program required'; end if;
  select e into base from jsonb_array_elements(s.day_snapshot->'exercises') e where e->>'id' = source_id::text;
  if base is null or base is distinct from p_change->'before' then raise exception using errcode = 'PT409', message = 'Source changed'; end if;
  perform peppitness_private.check_change_slot(actor,s.version_id,source_date,s.day_id,source_id);
  select * into selected from public.exercises where owner_id = actor and id = (p_change->'after'->>'exercise_id')::uuid for share;
  if not found or selected.archived_at is not null then raise exception using errcode = '42501', message = 'Exercise not available'; end if;
  if selected.revision is distinct from p_exercise_revision then raise exception using errcode = 'PT409', message = 'Exercise changed'; end if;
  if selected.id::text = base->>'exercise_id' then raise exception using errcode = '22023', message = 'Same exercise'; end if;
  source_group := case when base ? 'muscle_group' then base->>'muscle_group' else peppitness_private.infer_muscle_group(base->>'name',base->>'variant') end;
  target_group := selected.muscle_group;
  if partner is distinct from 'null'::jsonb then
    if partner is null or (base->>'mode' = 'seconds' and source_group = 'Cardio' and selected.measurement_mode = 'seconds' and target_group = 'Cardio') then
      raise exception using errcode = '22023', message = 'Cardio only replaces today'; end if;
    partner_id := (partner->>'prescriptionId')::uuid; partner_day := (partner->>'dayId')::uuid; partner_date := (partner->>'date')::date;
    if partner_date is null or partner_date <= source_date or partner_date >= source_date - (extract(isodow from source_date)::int - 1) + 7
      or not exists (select 1 from public.workout_prescriptions p join public.workout_days d on d.id = p.day_id
        where p.owner_id = actor and p.id = partner_id and p.day_id = partner_day and d.version_id = s.version_id
        and p.exercise_id = selected.id and lower(btrim(d.label)) = (array['lun','mar','mer','gio','ven','sab','dom'])[extract(isodow from partner_date)::int]) then
      raise exception using errcode = '22023', message = 'Invalid future occurrence'; end if;
    perform peppitness_private.check_change_slot(actor,s.version_id,partner_date,partner_day,partner_id);
    other := peppitness_private.prescription_snapshot(actor,partner_id);
    -- Se esiste una seduta futura intatta, il suo snapshot è l'autorità.
    select e into actual from public.workout_sessions x, jsonb_array_elements(x.day_snapshot->'exercises') e
      where x.owner_id = actor and x.version_id = s.version_id and x.day_id = partner_day and x.diary_date = partner_date and e->>'id' = partner_id::text;
    other := coalesce(actual,other);
    if other is distinct from partner->'before' then raise exception using errcode = 'PT409', message = 'Partner changed'; end if;
    target := other || jsonb_build_object('id',source_id);
    partner := jsonb_build_object('date',partner_date,'dayId',partner_day,'prescriptionId',partner_id,'before',other,'after',base || jsonb_build_object('id',partner_id));
  else
    target := p_change->'after';
    if not peppitness_private.valid_change_number(target->'sets',1,1000)
      or not peppitness_private.valid_change_number(target->'optional_sets',0,1000)
      or not peppitness_private.valid_change_number(target->'rest_seconds',0,86400)
      or (target->'rir' <> 'null'::jsonb and not peppitness_private.valid_change_number(target->'rir',0,10,false))
      or (target->'rpe' <> 'null'::jsonb and not peppitness_private.valid_change_number(target->'rpe',1,10,false))
      or target->'rir' is null or target->'rpe' is null then raise exception using errcode = '23514', message = 'Invalid dose'; end if;
    if selected.measurement_mode = 'reps' then
      if not peppitness_private.valid_change_number(target->'reps_min',1,10000) or not peppitness_private.valid_change_number(target->'reps_max',1,10000)
        or (target->>'reps_min')::numeric > (target->>'reps_max')::numeric or target->'duration_seconds' is distinct from 'null'::jsonb then
        raise exception using errcode = '23514', message = 'Invalid repetitions'; end if;
    else
      if not peppitness_private.valid_change_number(target->'duration_seconds',1,86400) or target->'reps_min' is distinct from 'null'::jsonb or target->'reps_max' is distinct from 'null'::jsonb then
        raise exception using errcode = '23514', message = 'Invalid duration'; end if;
    end if;
    target := jsonb_build_object('id',source_id,'exercise_id',selected.id,'name',selected.name,'variant',selected.variant,'equipment',selected.equipment,
      'load_convention',selected.load_convention,'load_unit',selected.load_unit,'per_side',selected.per_side,'exercise_note',selected.note,
      'muscle_group',selected.muscle_group,'mode',selected.measurement_mode,'note','',
      'sets',target->'sets','optional_sets',target->'optional_sets','reps_min',target->'reps_min','reps_max',target->'reps_max',
      'duration_seconds',target->'duration_seconds','rest_seconds',target->'rest_seconds','rir',target->'rir','rpe',target->'rpe');
  end if;
  canonical := jsonb_build_object('id',p_request_id,'sessionId',s.id,'planId',s.plan_id,'versionId',s.version_id,'sourceDate',source_date,
    'sourceDayId',s.day_id,'sourceId',source_id,'timeZone',s.time_zone,'createdAt',p_change->>'createdAt','before',base,'after',target,'partner',partner,'cancelled',false);
  if canonical is distinct from p_change then raise exception using errcode = '23514', message = 'Invalid change content'; end if;
  insert into public.workout_changes(id,owner_id,session_id,command,change_doc)
    values(p_request_id,actor,s.id,jsonb_build_object('change',p_change,'exerciseRevision',p_exercise_revision),canonical) returning * into receipt;
  perform peppitness_private.replace_session_exercise(s.id,target);
  if partner_id is not null then
    for other_session in select id from public.workout_sessions where owner_id = actor and version_id = s.version_id and day_id = partner_day and diary_date = partner_date loop
      perform peppitness_private.replace_session_exercise(other_session.id,partner->'after');
    end loop;
  end if;
  return receipt;
end;
$$;

create function public.undo_workout_change(p_request_id uuid, p_change_id uuid)
returns public.workout_changes language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); c public.workout_changes; d jsonb; p jsonb; s public.workout_sessions; other record;
begin
  perform peppitness_private.require_mfa();
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_request_id is null then raise exception using errcode = '22023', message = 'Request required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,280928));
  select * into c from public.workout_changes where id = p_change_id and owner_id = actor for update;
  if not found then raise exception using errcode = '42501', message = 'Change not available'; end if;
  if c.undo_request_id = p_request_id then return c; end if;
  if c.undo_request_id is not null then raise exception using errcode = 'PT409', message = 'Already undone'; end if;
  d := c.change_doc; p := d->'partner';
  perform 1 from public.active_plans where owner_id = actor for update;
  perform 1 from public.workout_plans where id = (d->>'planId')::uuid and owner_id = actor for update;
  if not exists (select 1 from public.workout_plans where id = (d->>'planId')::uuid and active_version_id = (d->>'versionId')::uuid) then
    raise exception using errcode = 'PT409', message = 'Program changed'; end if;
  perform 1 from public.workout_sessions where owner_id = actor order by id for update;
  select * into s from public.workout_sessions where id = c.session_id and owner_id = actor;
  if not found or s.status <> 'active' then raise exception using errcode = 'PT409', message = 'Session completed'; end if;
  perform peppitness_private.check_change_slot(actor,s.version_id,s.diary_date,s.day_id,(d->>'sourceId')::uuid,c.id);
  if p <> 'null'::jsonb then
    perform peppitness_private.check_change_slot(actor,s.version_id,(p->>'date')::date,(p->>'dayId')::uuid,(p->>'prescriptionId')::uuid,c.id);
  end if;
  perform peppitness_private.replace_session_exercise(s.id,d->'before');
  if p <> 'null'::jsonb then
    for other in select id from public.workout_sessions where owner_id = actor and version_id = s.version_id and day_id = (p->>'dayId')::uuid and diary_date = (p->>'date')::date loop
      perform peppitness_private.replace_session_exercise(other.id,p->'before');
    end loop;
  end if;
  update public.workout_changes set change_doc = jsonb_set(change_doc,'{cancelled}','true'), undo_request_id = p_request_id, updated_at = clock_timestamp()
    where id = c.id returning * into c;
  return c;
end;
$$;

-- L'avvio futuro legge le variazioni datate nella stessa transazione dello snapshot.
create function peppitness_private.apply_dated_workout_changes()
returns trigger language plpgsql security definer set search_path = '' as $$
declare c record; items jsonb;
begin
  for c in select change_doc d from public.workout_changes where owner_id = NEW.owner_id
    and change_doc->>'cancelled' = 'false' and change_doc->>'versionId' = NEW.version_id::text
    and change_doc->'partner'->>'date' = NEW.diary_date::text and change_doc->'partner'->>'dayId' = NEW.day_id::text loop
    select jsonb_agg(case when e->>'id' = c.d->'partner'->>'prescriptionId' then c.d->'partner'->'after' else e end order by n)
      into items from jsonb_array_elements(NEW.day_snapshot->'exercises') with ordinality a(e,n);
    NEW.day_snapshot := jsonb_set(NEW.day_snapshot,'{exercises}',items);
  end loop;
  return NEW;
end;
$$;
create trigger zz_dated_changes before insert on public.workout_sessions for each row execute function peppitness_private.apply_dated_workout_changes();

-- Verifica l'identità eseguita anche quando una vecchia scheda invia risultati dopo uno scambio.
alter table public.workout_set_logs add column exercise_id uuid;
alter table public.workout_set_logs add column change_id uuid;
grant select(exercise_id,change_id), insert(exercise_id,change_id), update(exercise_id,change_id) on public.workout_set_logs to authenticated;
create function peppitness_private.lock_set_exercise()
returns trigger language plpgsql security definer set search_path = '' as $$
declare s public.workout_sessions; item jsonb; context_id uuid;
begin
  select * into s from public.workout_sessions where id = NEW.session_id and owner_id = NEW.owner_id for update;
  select e into item from jsonb_array_elements(s.day_snapshot->'exercises') e where e->>'id' = NEW.prescription_id::text;
  select c.id into context_id from public.workout_changes c where c.owner_id = NEW.owner_id and c.change_doc->>'cancelled' = 'false'
      and c.change_doc->>'versionId' = s.version_id::text and (
      (c.change_doc->>'sourceDate' = s.diary_date::text and c.change_doc->>'sourceDayId' = s.day_id::text and c.change_doc->>'sourceId' = NEW.prescription_id::text)
      or (c.change_doc->'partner'->>'date' = s.diary_date::text and c.change_doc->'partner'->>'dayId' = s.day_id::text and c.change_doc->'partner'->>'prescriptionId' = NEW.prescription_id::text));
  if item is not null and (NEW.change_id is distinct from context_id
    or (NEW.exercise_id is not null and NEW.exercise_id::text <> item->>'exercise_id') or (NEW.exercise_id is null and context_id is not null)) then
    raise exception using errcode = 'PT409', message = 'Exercise context changed'; end if;
  return NEW;
end;
$$;
create trigger a_lock_set_exercise before insert or update on public.workout_set_logs for each row execute function peppitness_private.lock_set_exercise();

revoke all on function public.apply_workout_change(uuid,jsonb,integer), public.undo_workout_change(uuid,uuid) from public,anon,authenticated;
grant execute on function public.apply_workout_change(uuid,jsonb,integer), public.undo_workout_change(uuid,uuid) to authenticated;
revoke all on function peppitness_private.prescription_snapshot(uuid,uuid), peppitness_private.replace_session_exercise(uuid,jsonb),
  peppitness_private.check_change_slot(uuid,uuid,date,uuid,uuid,uuid), peppitness_private.valid_change_number(jsonb,numeric,numeric,boolean),
  peppitness_private.apply_dated_workout_changes(), peppitness_private.lock_set_exercise() from public,anon,authenticated;
