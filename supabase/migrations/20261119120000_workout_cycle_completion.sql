alter table public.workout_cycle_recaps add column viewed boolean not null default true;
grant insert(viewed), update(viewed) on public.workout_cycle_recaps to authenticated;
create policy cycle_recaps_mark_viewed on public.workout_cycle_recaps for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()) and viewed);

create function peppitness_private.guard_cycle_completion()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  plan public.workout_plans;
  today date;
begin
  if new.viewed then return new; end if; -- Client precedenti: archiviano solo dopo la visione.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.owner_id::text,280928));
  select * into plan from public.workout_plans p
    where p.owner_id = new.owner_id and p.id::text = split_part(new.recap_key, '.', 1)
    for update;
  today := (pg_catalog.statement_timestamp() at time zone
    coalesce((select s.time_zone from public.user_settings s where s.owner_id = new.owner_id), 'Europe/Rome'))::date;
  if plan.cycle_start is null or plan.archived_at is not null
    or new.recap_key <> concat(plan.id, '.', plan.cycle_start, '.', plan.cycle_weeks)
    or today < plan.cycle_start + plan.cycle_weeks * 7
    or exists (select 1 from public.workout_sessions s where s.owner_id = new.owner_id and s.plan_id = plan.id and s.status = 'active') then
    raise exception using errcode = '22023', message = 'Workout cycle changed or still open';
  end if;
  return new;
end;
$$;
revoke all on function peppitness_private.guard_cycle_completion() from public, anon, authenticated;
create trigger guard_cycle_completion before insert on public.workout_cycle_recaps
for each row execute function peppitness_private.guard_cycle_completion();

create function public.extend_workout_cycle(p_plan_id uuid, p_cycle_start date, p_cycle_weeks integer,
  p_new_weeks integer, p_expected_revision integer)
returns public.workout_plans language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  plan public.workout_plans;
  today date;
begin
  perform peppitness_private.require_mfa();
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(actor::text,280928));
  select * into plan from public.workout_plans p where p.id = p_plan_id and p.owner_id = actor for update;
  if not found then raise exception using errcode = '42501', message = 'Workout plan not available'; end if;
  if p_cycle_start is null or p_cycle_weeks is null or p_new_weeks is null or p_expected_revision is null
    or p_new_weeks <= p_cycle_weeks or p_new_weeks > 52 then
    raise exception using errcode = '22023', message = 'Invalid cycle extension';
  end if;
  -- Permette di ritentare la stessa estensione dopo una risposta persa.
  if plan.cycle_start = p_cycle_start and plan.cycle_weeks = p_new_weeks and plan.revision = p_expected_revision + 1 then
    return plan;
  end if;
  today := (pg_catalog.statement_timestamp() at time zone
    coalesce((select s.time_zone from public.user_settings s where s.owner_id = actor), 'Europe/Rome'))::date;
  if plan.archived_at is not null or plan.cycle_start is distinct from p_cycle_start
    or plan.cycle_weeks is distinct from p_cycle_weeks or plan.revision <> p_expected_revision
    or exists (select 1 from public.workout_cycle_recaps r where r.owner_id = actor
      and r.recap_key = concat(p_plan_id, '.', p_cycle_start, '.', p_cycle_weeks)) then
    raise exception using errcode = 'PT409', message = 'Workout cycle changed or already closed';
  end if;
  if today < p_cycle_start + p_cycle_weeks * 7 or today >= p_cycle_start + p_new_weeks * 7 then
    raise exception using errcode = '22023', message = 'Extension must continue an expired cycle through today';
  end if;
  update public.workout_plans p set cycle_weeks = p_new_weeks, revision = p.revision + 1
    where p.id = p_plan_id and p.owner_id = actor returning * into plan;
  update public.workout_sessions s set cycle_weeks = p_new_weeks, revision = s.revision + 1
    where s.owner_id = actor and s.plan_id = p_plan_id and s.cycle_start = p_cycle_start and s.cycle_weeks = p_cycle_weeks;
  delete from public.workout_cycle_interruptions i
    where i.owner_id = actor and i.plan_id = p_plan_id and i.cycle_start = p_cycle_start and i.cycle_weeks = p_cycle_weeks;
  return plan;
end;
$$;
revoke all on function public.extend_workout_cycle(uuid,date,integer,integer,integer) from public, anon, authenticated;
grant execute on function public.extend_workout_cycle(uuid,date,integer,integer,integer) to authenticated;
