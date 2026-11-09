-- Eccezioni del calendario, senza trasferimenti di sedute o modifiche agli snapshot.
create table public.workout_day_swaps (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid not null,
  version_id uuid not null,
  source_date date not null,
  target_date date not null,
  source_day_id uuid not null,
  target_day_id uuid,
  time_zone text not null,
  cancelled boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (owner_id,plan_id,version_id) references public.workout_plan_versions(owner_id,plan_id,id) on delete cascade,
  check (source_date <> target_date),
  check (source_date - (extract(isodow from source_date)::int - 1) = target_date - (extract(isodow from target_date)::int - 1))
);
create index workout_day_swaps_owner_version on public.workout_day_swaps(owner_id,version_id);
alter table public.workout_day_swaps enable row level security;
alter table public.workout_day_swaps force row level security;
revoke all on public.workout_day_swaps from public,anon,authenticated;
grant select on public.workout_day_swaps to authenticated;
create policy own_day_swaps on public.workout_day_swaps for select to authenticated using (owner_id = (select auth.uid()));
create policy mfa_aal2_required on public.workout_day_swaps as restrictive for all to authenticated
  using ((select public.is_mfa_satisfied())) with check ((select public.is_mfa_satisfied()));

create table peppitness_private.day_swap_receipts (
  request_id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  swap_id uuid not null references public.workout_day_swaps(id) on delete cascade,
  command jsonb not null
);
revoke all on peppitness_private.day_swap_receipts from public,anon,authenticated;

-- Usata anche dalla validazione delle sostituzioni: la data effettiva precede l'etichetta.
create function peppitness_private.scheduled_workout_day(p_owner uuid,p_version uuid,p_date date)
returns uuid language plpgsql stable set search_path = '' as $$
declare s public.workout_day_swaps; result uuid;
begin
  select * into s from public.workout_day_swaps where owner_id=p_owner and version_id=p_version and not cancelled
    and p_date in (source_date,target_date);
  if found then return case when p_date=s.source_date then s.target_day_id else s.source_day_id end; end if;
  select id into result from public.workout_days where owner_id=p_owner and version_id=p_version
    and lower(btrim(label))=(array['lun','mar','mer','gio','ven','sab','dom'])[extract(isodow from p_date)::int];
  return result;
end $$;
revoke all on function peppitness_private.scheduled_workout_day(uuid,uuid,date) from public,anon,authenticated;

-- Il chiamante detiene il lock dell'account, lo stesso di start_workout_session e apply_workout_change.
create function peppitness_private.validate_day_swap(s public.workout_day_swaps)
returns void language plpgsql set search_path = '' as $$
declare p public.workout_plans; v public.workout_plan_versions; tz text;
begin
  select * into p from public.workout_plans where owner_id=s.owner_id and id=s.plan_id for share;
  select * into v from public.workout_plan_versions where owner_id=s.owner_id and id=s.version_id and plan_id=s.plan_id for share;
  if v.id is null or v.status <> 'published' or p.archived_at is not null or p.active_version_id is distinct from s.version_id then
    raise exception using errcode='PT409',message='Program version changed'; end if;
  select time_zone into tz from public.user_settings where owner_id=s.owner_id;
  tz := coalesce(tz,'Europe/Rome');
  if s.time_zone is distinct from tz or s.target_date < (clock_timestamp() at time zone tz)::date then
    raise exception using errcode='22023',message='Destination precedes today or account time zone changed'; end if;
  if s.source_date is null or s.target_date is null or s.source_date=s.target_date
    or s.source_date < date '2000-01-01' or s.target_date > date '2200-01-01'
    or s.source_date-(extract(isodow from s.source_date)::int-1) <> s.target_date-(extract(isodow from s.target_date)::int-1)
    or p.cycle_start is not null and (least(s.source_date,s.target_date)<p.cycle_start or greatest(s.source_date,s.target_date)>=p.cycle_start+p.cycle_weeks*7) then
    raise exception using errcode='22023',message='Dates outside week or cycle'; end if;
  if not exists (select 1 from public.workout_days where owner_id=s.owner_id and version_id=s.version_id)
    or exists (select 1 from public.workout_days where owner_id=s.owner_id and version_id=s.version_id
      and lower(btrim(label)) <> all(array['lun','mar','mer','gio','ven','sab','dom'])) or (select count(*)<>count(distinct lower(btrim(label))) from public.workout_days where owner_id=s.owner_id and version_id=s.version_id) then
    raise exception using errcode='22023',message='Weekly program required'; end if;
  if exists (select 1 from public.workout_sessions where owner_id=s.owner_id
    and (version_id=s.version_id or version_id is null and plan_id=s.plan_id) and diary_date in(s.source_date,s.target_date)) then
    raise exception using errcode='PT409',message='Occurrence already started'; end if;
  if exists (select 1 from public.workout_day_swaps where owner_id=s.owner_id and version_id=s.version_id and not cancelled and id<>s.id
    and (source_date in(s.source_date,s.target_date) or target_date in(s.source_date,s.target_date))) then
    raise exception using errcode='PT409',message='Overlapping day swap'; end if;
  if exists (select 1 from public.workout_changes where owner_id=s.owner_id and change_doc->>'versionId'=s.version_id::text and change_doc->>'cancelled'='false'
    and (change_doc->>'sourceDate' in(s.source_date::text,s.target_date::text) or change_doc->'partner'->>'date' in(s.source_date::text,s.target_date::text))) then
    raise exception using errcode='PT409',message='Dated exercise change present'; end if;
end $$;
revoke all on function peppitness_private.validate_day_swap(public.workout_day_swaps) from public,anon,authenticated;

create function public.apply_workout_day_swap(p_request_id uuid,p_swap jsonb)
returns public.workout_day_swaps language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); s public.workout_day_swaps; r peppitness_private.day_swap_receipts;
begin
  perform peppitness_private.require_mfa();
  if actor is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_request_id is null or jsonb_typeof(p_swap) is distinct from 'object' or p_swap->>'id' is distinct from p_request_id::text
    or (p_swap->>'cancelled')::boolean is distinct from false then raise exception using errcode='22023',message='Invalid swap'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,280928));
  select * into r from peppitness_private.day_swap_receipts where request_id=p_request_id;
  if found then
    if r.owner_id<>actor or r.command<>p_swap then raise exception using errcode='PT409',message='Request id reused'; end if;
    select * into strict s from public.workout_day_swaps where id=r.swap_id and owner_id=actor;
    return s;
  end if;
  s.id:=p_request_id; s.owner_id:=actor; s.plan_id:=(p_swap->>'planId')::uuid; s.version_id:=(p_swap->>'versionId')::uuid;
  s.source_date:=(p_swap->>'sourceDate')::date; s.target_date:=(p_swap->>'targetDate')::date; s.time_zone:=p_swap->>'timeZone';
  perform peppitness_private.validate_day_swap(s);
  s.source_day_id:=peppitness_private.scheduled_workout_day(actor,s.version_id,s.source_date);
  s.target_day_id:=peppitness_private.scheduled_workout_day(actor,s.version_id,s.target_date);
  if s.source_day_id is null or s.source_day_id::text is distinct from p_swap->>'sourceDayId'
    or s.target_day_id::text is distinct from p_swap->>'targetDayId' then
    raise exception using errcode='PT409',message='Schedule changed'; end if;
  s.cancelled:=false; s.updated_at:=clock_timestamp();
  insert into public.workout_day_swaps select s.*;
  insert into peppitness_private.day_swap_receipts values(p_request_id,actor,s.id,p_swap);
  return s;
end $$;

create function public.undo_workout_day_swap(p_request_id uuid,p_swap_id uuid)
returns public.workout_day_swaps language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); s public.workout_day_swaps; r peppitness_private.day_swap_receipts;
  cmd jsonb:=jsonb_build_object('undo',p_swap_id);
begin
  perform peppitness_private.require_mfa();
  if actor is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_request_id is null or p_swap_id is null then raise exception using errcode='22023',message='Invalid undo'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,280928));
  select * into r from peppitness_private.day_swap_receipts where request_id=p_request_id;
  if found then
    if r.owner_id<>actor or r.command<>cmd then raise exception using errcode='PT409',message='Request id reused'; end if;
    select * into strict s from public.workout_day_swaps where id=r.swap_id and owner_id=actor;
    return s;
  end if;
  select * into s from public.workout_day_swaps where id=p_swap_id and owner_id=actor for update;
  if not found then raise exception using errcode='42501',message='Swap not available'; end if;
  if s.cancelled then raise exception using errcode='PT409',message='Swap already cancelled'; end if;
  perform peppitness_private.validate_day_swap(s);
  update public.workout_day_swaps set cancelled=true,updated_at=clock_timestamp() where id=s.id returning * into s;
  insert into peppitness_private.day_swap_receipts values(p_request_id,actor,s.id,cmd);
  return s;
end $$;
revoke all on function public.apply_workout_day_swap(uuid,jsonb),public.undo_workout_day_swap(uuid,uuid) from public,anon,authenticated;
grant execute on function public.apply_workout_day_swap(uuid,jsonb),public.undo_workout_day_swap(uuid,uuid) to authenticated;

-- La RPC storica conserva snapshot e MFA, ma diventa una primitiva privata.
alter function public.start_workout_session(uuid,uuid,uuid,date,text) set schema peppitness_private;
alter function peppitness_private.start_workout_session(uuid,uuid,uuid,date,text) rename to start_workout_session_base;
revoke all on function peppitness_private.start_workout_session_base(uuid,uuid,uuid,date,text) from public,anon,authenticated;

create function public.start_workout_session(p_session_id uuid,p_version_id uuid,p_day_id uuid,p_diary_date date,p_time_zone text,
  p_expected_day_id uuid,p_expected_swap_id uuid,p_manual_choice boolean default false)
returns public.workout_sessions language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); expected uuid; actual_swap uuid;
begin
  perform peppitness_private.require_mfa();
  if actor is null then raise exception using errcode='42501',message='Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,280928));
  -- Retry di un avvio già applicato: l'identità viene verificata dalla primitiva originale.
  if not exists(select 1 from public.workout_sessions where id=p_session_id and owner_id=actor) then
    perform 1 from public.workout_plan_versions where id=p_version_id and owner_id=actor for share;
    expected:=peppitness_private.scheduled_workout_day(actor,p_version_id,p_diary_date);
    select id into actual_swap from public.workout_day_swaps where owner_id=actor and version_id=p_version_id and not cancelled
      and p_diary_date in(source_date,target_date);
    if p_expected_day_id is distinct from expected or p_expected_swap_id is distinct from actual_swap
      or (p_manual_choice is distinct from true and p_day_id is distinct from expected) then
      raise exception using errcode='PT409',message='Schedule changed before start'; end if;
  end if;
  return peppitness_private.start_workout_session_base(p_session_id,p_version_id,p_day_id,p_diary_date,p_time_zone);
end $$;

-- Client precedenti: nessuna scrittura silenziosa con calendario superato.
create function public.start_workout_session(p_session_id uuid,p_version_id uuid,p_day_id uuid,p_diary_date date,p_time_zone text)
returns public.workout_sessions language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid();
begin
  perform peppitness_private.require_mfa();
  if actor is null then raise exception using errcode='42501',message='Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,280928));
  if not exists(select 1 from public.workout_sessions where id=p_session_id and owner_id=actor)
    and exists(select 1 from public.workout_day_swaps where owner_id=actor and version_id=p_version_id and not cancelled and p_diary_date in(source_date,target_date)) then
    raise exception using errcode='PT409',message='Reload schedule before start'; end if;
  return peppitness_private.start_workout_session_base(p_session_id,p_version_id,p_day_id,p_diary_date,p_time_zone);
end $$;
revoke all on function public.start_workout_session(uuid,uuid,uuid,date,text),public.start_workout_session(uuid,uuid,uuid,date,text,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.start_workout_session(uuid,uuid,uuid,date,text),public.start_workout_session(uuid,uuid,uuid,date,text,uuid,uuid,boolean) to authenticated;

-- Le sostituzioni successive allo spostamento devono verificare l'occorrenza effettiva.
do $$
declare def text; patched text;
begin
  def:=pg_get_functiondef('public.apply_workout_change(uuid,jsonb,integer)'::regprocedure);
  patched:=replace(def,$old$lower(btrim(d.label)) = (array['lun','mar','mer','gio','ven','sab','dom'])[extract(isodow from partner_date)::int]$old$,
    'd.id = peppitness_private.scheduled_workout_day(actor,s.version_id,partner_date)');
  if patched=def then raise exception 'Exercise occurrence guard not found'; end if;
  execute patched;
end $$;

-- Una versione con eccezioni è già usata: le revisioni generano una versione nuova.
-- Il lock FOR SHARE della validazione impedisce una revisione concorrente della versione.
do $$
declare def text; patched text;
begin
  def:=pg_get_functiondef('public.save_workout_revision(uuid,uuid,integer,integer,uuid,text,text,jsonb,date,integer)'::regprocedure);
  patched:=replace(def,'used := exists (select 1 from public.workout_sessions where owner_id = actor and version_id = base_version.id);',
    'used := exists (select 1 from public.workout_sessions where owner_id = actor and version_id = base_version.id) or exists (select 1 from public.workout_day_swaps where owner_id=actor and version_id=base_version.id);');
  if patched=def then raise exception 'Revision usage guard not found'; end if;
  execute patched;
end $$;

notify pgrst,'reload schema';

-- Cambiare il periodo non deve invalidare eccezioni ancora attive. Il lock della riga
-- programma serializza questa guardia con la creazione e l'annullamento degli scambi.
create function peppitness_private.guard_day_swap_cycle()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if row(NEW.cycle_start,NEW.cycle_weeks) is distinct from row(OLD.cycle_start,OLD.cycle_weeks)
    and NEW.cycle_start is not null and exists(select 1 from public.workout_day_swaps s
      where s.owner_id=OLD.owner_id and s.plan_id=OLD.id and not s.cancelled
        and s.version_id=NEW.active_version_id
        and (least(s.source_date,s.target_date)<NEW.cycle_start or greatest(s.source_date,s.target_date)>=NEW.cycle_start+NEW.cycle_weeks*7)) then
    raise exception using errcode='PT409',message='Undo day swaps before changing cycle';
  end if;
  return NEW;
end $$;
revoke all on function peppitness_private.guard_day_swap_cycle() from public,anon,authenticated;
create trigger c_day_swap_cycle before update on public.workout_plans for each row execute function peppitness_private.guard_day_swap_cycle();
