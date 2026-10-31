-- Modifiche alla sola seduta: identità per occorrenza e ricevute transazionali permanenti.
-- Nessuna scrittura alle prescrizioni o alle variazioni datate del programma.
create table peppitness_private.session_exercise_receipts (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null,
  occurrence_id uuid,
  command jsonb not null,
  foreign key (owner_id, session_id) references public.workout_sessions(owner_id,id) on delete cascade,
  unique (occurrence_id)
);
revoke all on peppitness_private.session_exercise_receipts from public,anon,authenticated;

create function public.edit_workout_session_exercises(
  p_request_id uuid, p_session_id uuid, p_edit jsonb, p_expected_order jsonb, p_set_revisions jsonb default '{}'::jsonb
) returns public.workout_sessions
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid(); s public.workout_sessions; receipt peppitness_private.session_exercise_receipts;
  command jsonb := jsonb_build_object('sessionId',p_session_id,'edit',p_edit,'order',p_expected_order);
  action text := p_edit->>'action'; item jsonb; target uuid; selected public.exercises;
  items jsonb; snapshot jsonb; actual_order jsonb; actual_sets jsonb; canonical jsonb;
  pos jsonb := p_edit->'position'; insertion bigint; nitems bigint; reference_id uuid;
begin
  perform peppitness_private.require_mfa();
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  if p_request_id is null or p_session_id is null or jsonb_typeof(p_edit) is distinct from 'object'
    or action is null or action not in ('add','move','remove') or jsonb_typeof(p_expected_order) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid session edit';
  end if;
  -- Stesso ordine di lock di avvio e sostituzioni; le serie bloccano la seduta.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,280928));
  select * into receipt from peppitness_private.session_exercise_receipts where id = p_request_id;
  if found then
    if receipt.owner_id <> actor then raise exception using errcode = '42501', message = 'Request not available'; end if;
    if receipt.command is distinct from command then raise exception using errcode = 'PT409', message = 'Request already used'; end if;
    select * into strict s from public.workout_sessions where owner_id = actor and id = p_session_id;
    return s;
  end if;
  select * into s from public.workout_sessions where owner_id = actor and id = p_session_id for update;
  if not found then raise exception using errcode = '42501', message = 'Session not available'; end if;
  if s.status <> 'active' then raise exception using errcode = 'PT409', message = 'Session completed'; end if;
  select coalesce(jsonb_agg(e->'id' order by n),'[]'::jsonb) into actual_order
    from jsonb_array_elements(s.day_snapshot->'exercises') with ordinality a(e,n);
  if actual_order is distinct from p_expected_order then raise exception using errcode = 'PT409', message = 'Session order changed'; end if;
  if action = 'add' then
    item := p_edit->'exercise'; target := (item->>'id')::uuid;
    if target is null or target = (item->>'exercise_id')::uuid or item->'session_added' is distinct from 'true'::jsonb
      or jsonb_typeof(p_edit->'allowDuplicate') is distinct from 'boolean' then
      raise exception using errcode = '22023', message = 'Invalid occurrence'; end if;
    if exists (select 1 from jsonb_array_elements(s.day_snapshot->'exercises') e where e->>'id' = target::text)
      or exists (select 1 from public.workout_prescriptions where id = target)
      or exists (select 1 from peppitness_private.session_exercise_receipts where occurrence_id = target) then
      raise exception using errcode = 'PT409', message = 'Occurrence already used'; end if;
    if jsonb_array_length(s.day_snapshot->'exercises') >= 200 then raise exception using errcode = '23514', message = 'Too many exercises'; end if;
    select * into selected from public.exercises where owner_id = actor and id = (item->>'exercise_id')::uuid for share;
    if not found or selected.archived_at is not null then raise exception using errcode = '42501', message = 'Exercise not available'; end if;
    if p_edit->'allowDuplicate' = 'false'::jsonb and exists (
      select 1 from jsonb_array_elements(s.day_snapshot->'exercises') e where e->>'exercise_id' = selected.id::text
    ) then raise exception using errcode = 'PT409', message = 'Explicit duplicate choice required'; end if;
    if not coalesce(peppitness_private.valid_change_number(item->'sets',1,1000),false)
      or not coalesce(peppitness_private.valid_change_number(item->'optional_sets',0,1000),false)
      or not coalesce(peppitness_private.valid_change_number(item->'rest_seconds',0,86400),false)
      or item->'rir' is distinct from 'null'::jsonb or item->'rpe' is distinct from 'null'::jsonb then
      raise exception using errcode = '23514', message = 'Invalid dose'; end if;
    if selected.measurement_mode = 'reps' then
      if not coalesce(peppitness_private.valid_change_number(item->'reps_min',1,10000),false)
        or not coalesce(peppitness_private.valid_change_number(item->'reps_max',1,10000),false)
        or (item->>'reps_min')::numeric > (item->>'reps_max')::numeric or item->'duration_seconds' is distinct from 'null'::jsonb then
        raise exception using errcode = '23514', message = 'Invalid repetitions'; end if;
    else
      if not coalesce(peppitness_private.valid_change_number(item->'duration_seconds',1,86400),false)
        or item->'reps_min' is distinct from 'null'::jsonb or item->'reps_max' is distinct from 'null'::jsonb then
        raise exception using errcode = '23514', message = 'Invalid duration'; end if;
    end if;
    canonical := jsonb_build_object('id',target,'exercise_id',selected.id,'name',selected.name,'variant',selected.variant,'equipment',selected.equipment,
      'load_convention',selected.load_convention,'load_unit',selected.load_unit,'per_side',selected.per_side,'exercise_note',selected.note,
      'muscle_group',selected.muscle_group,'mode',selected.measurement_mode,'note','','session_added',true,
      'sets',item->'sets','optional_sets',item->'optional_sets','reps_min',item->'reps_min','reps_max',item->'reps_max',
      'duration_seconds',item->'duration_seconds','rest_seconds',item->'rest_seconds','rir',item->'rir','rpe',item->'rpe');
    if canonical is distinct from item then raise exception using errcode = 'PT409', message = 'Catalog snapshot changed'; end if;
  else
    target := (p_edit->>'id')::uuid;
    select e into item from jsonb_array_elements(s.day_snapshot->'exercises') e where e->>'id' = target::text;
    if item is null or item->'session_added' is distinct from 'true'::jsonb then
      raise exception using errcode = '23514', message = 'Only added exercises can be moved or removed'; end if;
  end if;
  select coalesce(jsonb_agg(e order by n),'[]'::jsonb) into items
    from jsonb_array_elements(s.day_snapshot->'exercises') with ordinality a(e,n) where e->>'id' <> target::text;
  if action = 'remove' then
    if jsonb_typeof(p_edit->'confirmed') is distinct from 'boolean' then raise exception using errcode = '22023', message = 'Confirmation required'; end if;
    select coalesce(jsonb_object_agg(set_index::text,revision),'{}'::jsonb) into actual_sets
      from public.workout_set_logs where owner_id = actor and session_id = s.id and prescription_id = target;
    if actual_sets is distinct from p_set_revisions then raise exception using errcode = 'PT409', message = 'Exercise results changed'; end if;
    if p_edit->'confirmed' = 'false'::jsonb and exists (select 1 from public.workout_set_logs where owner_id = actor and session_id = s.id
      and prescription_id = target and (load is not null or amount is not null or completed)) then
      raise exception using errcode = 'PT409', message = 'Removal confirmation required'; end if;
    delete from public.workout_set_logs where owner_id = actor and session_id = s.id and prescription_id = target;
  else
    nitems := jsonb_array_length(items);
    if pos->>'kind' = 'start' then insertion := 0;
    elsif pos->>'kind' = 'end' then insertion := nitems;
    elsif pos->>'kind' = 'after' then
      reference_id := (pos->>'id')::uuid;
      select n into insertion from jsonb_array_elements(items) with ordinality a(e,n) where e->>'id' = reference_id::text;
      if insertion is null then raise exception using errcode = 'PT409', message = 'Position not available'; end if;
    else raise exception using errcode = '22023', message = 'Invalid position'; end if;
    select jsonb_agg(e order by position) into items from (
      select e, n * 2 as position from jsonb_array_elements(items) with ordinality a(e,n)
      union all select item, insertion * 2 + 1
    ) ordered;
  end if;
  snapshot := jsonb_set(s.day_snapshot,'{exercises}',items);
  insert into peppitness_private.session_change_permits values(s.id,pg_catalog.txid_current(),s.day_snapshot,snapshot);
  update public.workout_sessions set day_snapshot = snapshot, revision = revision + 1 where id = s.id returning * into s;
  delete from peppitness_private.session_change_permits where session_id = s.id;
  insert into peppitness_private.session_exercise_receipts(id,owner_id,session_id,occurrence_id,command)
    values(p_request_id,actor,s.id,case when action = 'add' then target else null end,command);
  return s;
end;
$$;
revoke all on function public.edit_workout_session_exercises(uuid,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.edit_workout_session_exercises(uuid,uuid,jsonb,jsonb,jsonb) to authenticated;
