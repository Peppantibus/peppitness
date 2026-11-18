-- Contestualizzazione esplicita delle serie. Le sedute esistenti partono senza marcature.
alter table public.workout_sessions
  add column different_machines jsonb not null default '{}'::jsonb,
  add column is_trial boolean not null default false,
  add constraint workout_sessions_different_machines_object check (jsonb_typeof(different_machines) = 'object');

grant update(different_machines, is_trial) on public.workout_sessions to authenticated;

create function peppitness_private.guard_workout_session_equipment()
returns trigger language plpgsql set search_path = '' as $$
declare
  allowed jsonb;
begin
  if NEW.day_snapshot is not distinct from OLD.day_snapshot
    and NEW.different_machines is not distinct from OLD.different_machines then
    return NEW;
  end if;
  select coalesce(jsonb_object_agg(item->>'id', item->>'exercise_id'), '{}'::jsonb)
    into allowed from jsonb_array_elements(NEW.day_snapshot->'exercises') item;
  if NEW.day_snapshot is distinct from OLD.day_snapshot then
    -- Rimuove i riferimenti alle occorrenze cancellate o sostituite.
    select coalesce(jsonb_object_agg(key, value), '{}'::jsonb)
      into NEW.different_machines from jsonb_each(OLD.different_machines)
      where allowed->key = value;
  elsif not (allowed @> NEW.different_machines) then
    raise exception using errcode = '23514', message = 'Machine selection must match a session exercise';
  end if;
  return NEW;
end;
$$;

revoke all on function peppitness_private.guard_workout_session_equipment() from public, anon, authenticated;
create trigger c_guard_session_equipment before update on public.workout_sessions
for each row execute function peppitness_private.guard_workout_session_equipment();
