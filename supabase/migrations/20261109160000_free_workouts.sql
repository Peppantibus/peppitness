-- Sedute libere senza programmi fittizi e senza riscrivere il diario preesistente.
alter table public.workout_sessions
  add column session_kind text not null default 'program' check(session_kind in ('program','free')),
  alter column plan_id drop not null,
  alter column version_id drop not null,
  alter column day_id drop not null,
  add constraint workout_session_kind_context check(
    (session_kind='program' and plan_id is not null and version_id is not null and day_id is not null)
    or (session_kind='free' and plan_id is null and version_id is null and day_id is null));
grant select(session_kind) on public.workout_sessions to authenticated;

-- I vecchi bundle richiedono riferimenti al programma non nulli. Finché non si
-- aggiornano vedono il diario programmato, senza righe libere o serie orfane.
-- La capability è solo negoziazione del formato: owner e MFA restano obbligatori.
create policy free_workout_client_format on public.workout_sessions as restrictive
  for select to authenticated using (session_kind='program' or
    coalesce(current_setting('request.headers',true),'{}')::jsonb->>'x-peppitness-diary'='free-v1');
create policy free_workout_client_format on public.workout_set_logs as restrictive
  for select to authenticated using (exists(select 1 from public.workout_sessions s where s.id=workout_set_logs.session_id and s.owner_id=workout_set_logs.owner_id));

-- Una seduta scartata non viene ricreata dal retry di un dispositivo rimasto offline.
create table peppitness_private.free_workout_starts (
  id uuid primary key, owner_id uuid not null references auth.users(id) on delete cascade,
  diary_date date not null, time_zone text not null
);
revoke all on peppitness_private.free_workout_starts from public,anon,authenticated;

create function public.start_free_workout_session(p_session_id uuid,p_diary_date date,p_time_zone text)
returns public.workout_sessions language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); s public.workout_sessions; tz text;
begin
  perform peppitness_private.require_mfa();
  if actor is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_session_id is null or p_diary_date is null or p_diary_date<date '2000-01-01' or p_diary_date>date '2200-01-01' then
    raise exception using errcode='22023',message='Invalid session'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,280928));
  select * into s from public.workout_sessions where id=p_session_id;
  if found then
    if s.owner_id<>actor then raise exception using errcode='42501',message='Session not available'; end if;
    if s.session_kind<>'free' or s.diary_date<>p_diary_date or s.time_zone is distinct from p_time_zone then
      raise exception using errcode='PT409',message='Session id already used'; end if;
    return s;
  end if;
  if exists(select 1 from peppitness_private.free_workout_starts where id=p_session_id) then raise exception using errcode='PT409',message='Free session discarded'; end if;
  select time_zone into tz from public.user_settings where owner_id=actor;
  if p_time_zone is distinct from coalesce(tz,'Europe/Rome') then raise exception using errcode='22023',message='Account time zone changed'; end if;
  if exists(select 1 from public.workout_sessions where owner_id=actor and status='active') then
    raise exception using errcode='PT409',message='Another session is active'; end if;
  insert into public.workout_sessions(id,owner_id,session_kind,diary_date,time_zone,day_snapshot)
    values(p_session_id,actor,'free',p_diary_date,p_time_zone,jsonb_build_object('label','Libero','title','Allenamento libero','note','','plan_title','','version_number',0,'exercises','[]'::jsonb)) returning * into s;
  insert into peppitness_private.free_workout_starts values(s.id,actor,p_diary_date,p_time_zone);
  return s;
end $$;
revoke all on function public.start_free_workout_session(uuid,date,text) from public,anon,authenticated;
grant execute on function public.start_free_workout_session(uuid,date,text) to authenticated;

create function peppitness_private.guard_free_workout()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if NEW.session_kind is distinct from OLD.session_kind then raise exception using errcode='23514',message='Session kind cannot change'; end if;
  if NEW.session_kind='free' and OLD.status='active' and NEW.status='completed' and jsonb_array_length(NEW.day_snapshot->'exercises')=0 then
    raise exception using errcode='23514',message='Free session has no exercises'; end if;
  return NEW;
end $$;
revoke all on function peppitness_private.guard_free_workout() from public,anon,authenticated;
create trigger b_guard_free_workout before update on public.workout_sessions for each row execute function peppitness_private.guard_free_workout();

-- Il retry dell'avvio di un programma non può adottare l'ID di una seduta libera.
do $$
declare def text; patched text;
begin
  def:=pg_get_functiondef('peppitness_private.start_workout_session_base(uuid,uuid,uuid,date,text)'::regprocedure);
  patched:=replace(def,$old$if existing.owner_id <> actor then raise exception using errcode = '42501', message = 'Session not available'; end if;$old$,$new$if existing.owner_id <> actor then raise exception using errcode = '42501', message = 'Session not available'; end if;
    if existing.session_kind <> 'program' then raise exception using errcode='PT409',message='Session id already used'; end if;$new$);
  if patched=def then raise exception 'Session identity guard not found'; end if;
  execute patched;
end $$;
notify pgrst,'reload schema';
