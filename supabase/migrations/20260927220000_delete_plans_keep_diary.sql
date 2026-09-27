-- I diari conservano snapshot completi: i riferimenti ai piani eliminati restano
-- identificatori storici, mentre i nuovi inserimenti devono usare piani esistenti.
alter table public.workout_sessions
  drop constraint if exists workout_sessions_owner_id_plan_id_version_id_fkey,
  drop constraint if exists workout_sessions_owner_id_day_id_fkey;
alter table public.meal_logs
  drop constraint if exists meal_logs_owner_id_meal_plan_id_fkey;

create function peppitness_private.require_meal_plan_for_new_log()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.meal_plans where owner_id = NEW.owner_id and id = NEW.meal_plan_id) then
    raise exception using errcode = '23503', message = 'Meal plan not available';
  end if;
  return NEW;
end;
$$;
revoke all on function peppitness_private.require_meal_plan_for_new_log() from public, anon, authenticated;
create trigger c_require_meal_plan before insert on public.meal_logs
for each row execute function peppitness_private.require_meal_plan_for_new_log();

-- Le versioni pubblicate e i loro figli restano immutabili finché il programma
-- esiste. Si ammette solo la cascata quando la riga padre è stata eliminata.
create or replace function peppitness_private.guard_workout_version()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if TG_OP = 'INSERT' then
    if NEW.status <> 'draft' then raise exception using errcode = '55000', message = 'Versions must start as drafts'; end if;
    return NEW;
  end if;
  if TG_OP = 'DELETE' then
    if not exists (select 1 from public.workout_plans where owner_id = OLD.owner_id and id = OLD.plan_id)
      or not exists (select 1 from auth.users where id = OLD.owner_id) then return OLD; end if;
    if OLD.status = 'published' then raise exception using errcode = '55000', message = 'Published versions are immutable'; end if;
    return OLD;
  end if;
  if OLD.status = 'published' then raise exception using errcode = '55000', message = 'Published versions are immutable'; end if;
  if row(NEW.id, NEW.plan_id, NEW.version_number) is distinct from row(OLD.id, OLD.plan_id, OLD.version_number) then
    raise exception using errcode = '23514', message = 'Version identity cannot change';
  end if;
  return NEW;
end;
$$;

create or replace function peppitness_private.guard_workout_child()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  parent_version uuid;
  parent_status text;
  parent_plan uuid;
  record_owner uuid;
begin
  if TG_OP = 'UPDATE' then raise exception using errcode = '55000', message = 'Replace draft children atomically'; end if;
  if TG_OP = 'DELETE' then
    record_owner := OLD.owner_id;
    if TG_TABLE_NAME = 'workout_days' then parent_version := OLD.version_id;
    else select version_id into parent_version from public.workout_days where owner_id = record_owner and id = OLD.day_id; end if;
  else
    record_owner := NEW.owner_id;
    if TG_TABLE_NAME = 'workout_days' then parent_version := NEW.version_id;
    else select version_id into parent_version from public.workout_days where owner_id = record_owner and id = NEW.day_id; end if;
  end if;
  select status, plan_id into parent_status, parent_plan from public.workout_plan_versions
    where owner_id = record_owner and id = parent_version for update;
  if not FOUND and TG_OP = 'DELETE' then return OLD; end if;
  if TG_OP = 'DELETE' and not exists (select 1 from public.workout_plans where owner_id = record_owner and id = parent_plan) then return OLD; end if;
  if parent_status is distinct from 'draft' then raise exception using errcode = '55000', message = 'Only draft children can change'; end if;
  if TG_OP = 'DELETE' then return OLD; end if;
  return NEW;
end;
$$;

-- p_plan_id nullo elimina tutti i piani della sezione. Ogni RPC e atomica.
create function public.delete_workout_plans(p_plan_id uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  deleted_count integer;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  update public.active_plans set workout_plan_id = null, revision = revision + 1
    where owner_id = actor and workout_plan_id is not null
      and (p_plan_id is null or workout_plan_id = p_plan_id);
  delete from public.workout_plans where owner_id = actor and (p_plan_id is null or id = p_plan_id);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

create function public.delete_meal_plans(p_plan_id uuid default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  deleted_count integer;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  update public.active_plans set meal_plan_id = null, revision = revision + 1
    where owner_id = actor and meal_plan_id is not null
      and (p_plan_id is null or meal_plan_id = p_plan_id);
  delete from public.meal_plans where owner_id = actor and (p_plan_id is null or id = p_plan_id);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
revoke all on function public.delete_workout_plans(uuid), public.delete_meal_plans(uuid) from public, anon;
grant execute on function public.delete_workout_plans(uuid), public.delete_meal_plans(uuid) to authenticated;
