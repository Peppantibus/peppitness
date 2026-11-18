-- Snapshot del periodo del ciclo nelle nuove sedute. Le sedute storiche mantengono
-- i loro dati originali: il client le associa solo a un periodo noto e univoco.
alter table public.workout_sessions
  add column cycle_recorded boolean not null default false,
  add column cycle_start date,
  add column cycle_weeks smallint check (cycle_weeks between 1 and 52),
  add constraint workout_sessions_cycle_complete check ((cycle_start is null) = (cycle_weeks is null)),
  add constraint workout_sessions_cycle_contains_date check (
    cycle_start is null or (plan_id is not null and diary_date >= cycle_start and diary_date < cycle_start + cycle_weeks * 7)
  );

create function peppitness_private.snapshot_workout_session_cycle()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.cycle_recorded := true;
  select p.cycle_start, p.cycle_weeks into new.cycle_start, new.cycle_weeks
    from public.workout_plans p
    where p.id = new.plan_id and p.owner_id = new.owner_id
      and new.diary_date >= p.cycle_start and new.diary_date < p.cycle_start + p.cycle_weeks * 7;
  return new;
end;
$$;
revoke all on function peppitness_private.snapshot_workout_session_cycle() from public, anon, authenticated;
create trigger z_snapshot_cycle before insert on public.workout_sessions
for each row execute function peppitness_private.snapshot_workout_session_cycle();

-- Segna la scelta effettiva di abbandonare un ciclo prima della fine, senza
-- inferirla dalla mancanza di sedute. Una ripresa rimuove la marcatura.
create table public.workout_cycle_interruptions (
  owner_id uuid not null references auth.users(id) on delete cascade,
  plan_id uuid not null,
  cycle_start date not null,
  cycle_weeks smallint not null check (cycle_weeks between 1 and 52),
  primary key (owner_id, plan_id, cycle_start, cycle_weeks)
);
alter table public.workout_cycle_interruptions enable row level security;
alter table public.workout_cycle_interruptions force row level security;
revoke all on public.workout_cycle_interruptions from public, anon, authenticated;
grant select on public.workout_cycle_interruptions to authenticated;
create policy cycle_interruptions_read_own on public.workout_cycle_interruptions for select to authenticated
  using (owner_id = (select auth.uid()));
create policy mfa_aal2_required on public.workout_cycle_interruptions as restrictive for select to authenticated
  using ((select public.is_mfa_satisfied()));

create function peppitness_private.track_workout_cycle_interruption()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  local_today date;
begin
  if tg_op = 'UPDATE' and old.workout_plan_id is not distinct from new.workout_plan_id then return new; end if;
  local_today := (pg_catalog.statement_timestamp() at time zone
    coalesce((select s.time_zone from public.user_settings s where s.owner_id = new.owner_id), 'Europe/Rome'))::date;

  if tg_op = 'UPDATE' and old.workout_plan_id is not null then
    insert into public.workout_cycle_interruptions(owner_id, plan_id, cycle_start, cycle_weeks)
    select p.owner_id, p.id, p.cycle_start, p.cycle_weeks from public.workout_plans p
      where p.owner_id = old.owner_id and p.id = old.workout_plan_id
        and local_today >= p.cycle_start and local_today < p.cycle_start + p.cycle_weeks * 7
    on conflict do nothing;
  end if;

  delete from public.workout_cycle_interruptions i using public.workout_plans p
    where i.owner_id = new.owner_id and p.owner_id = i.owner_id and p.id = new.workout_plan_id
      and i.plan_id = p.id and i.cycle_start = p.cycle_start and i.cycle_weeks = p.cycle_weeks
      and local_today < p.cycle_start + p.cycle_weeks * 7;
  return new;
end;
$$;
revoke all on function peppitness_private.track_workout_cycle_interruption() from public, anon, authenticated;
create trigger track_workout_cycle after insert or update of workout_plan_id on public.active_plans
for each row execute function peppitness_private.track_workout_cycle_interruption();
