-- Catalogo comune leggibile dagli utenti autenticati; gli esercizi personali restano privati.
-- Nessun esercizio personale o programma esistente viene modificato.

create table public.shared_exercises (
  id uuid primary key,
  name text not null check (name = btrim(name) and char_length(name) between 1 and 120),
  variant text not null default '' check (char_length(variant) <= 120),
  equipment text not null default '' check (char_length(equipment) <= 120),
  load_convention text not null check (load_convention in ('total', 'single-dumbbell', 'bodyweight')),
  load_unit text not null default 'kg' check (load_unit in ('kg', 'lb')),
  measurement_mode text not null check (measurement_mode in ('reps', 'seconds')),
  per_side boolean not null default false,
  note text not null default '' check (char_length(note) <= 4000),
  created_at timestamptz not null default now()
);

alter table public.shared_exercises enable row level security;
alter table public.shared_exercises force row level security;
revoke all on public.shared_exercises from public, anon, authenticated;
grant select on public.shared_exercises to authenticated;
create policy shared_exercises_read on public.shared_exercises
  for select to authenticated using (true);

alter table public.exercises
  add column source_template_id uuid references public.shared_exercises(id);
alter table public.exercises
  add constraint exercises_owner_source_template_key unique (owner_id, source_template_id);

create function peppitness_private.validate_exercise_source()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare template public.shared_exercises%rowtype;
begin
  if TG_OP = 'UPDATE' then
    if NEW.source_template_id is distinct from OLD.source_template_id then
      raise exception using errcode = '23514', message = 'Exercise source cannot change';
    end if;
    return NEW;
  end if;
  if NEW.source_template_id is null then return NEW; end if;
  select * into template from public.shared_exercises where id = NEW.source_template_id;
  if not found or row(NEW.name, NEW.variant, NEW.equipment, NEW.load_convention,
      NEW.load_unit, NEW.measurement_mode, NEW.per_side, NEW.note)
    is distinct from row(template.name, template.variant, template.equipment, template.load_convention,
      template.load_unit, template.measurement_mode, template.per_side, template.note) then
    raise exception using errcode = '23514', message = 'Exercise source does not match template';
  end if;
  return NEW;
end;
$$;
revoke all on function peppitness_private.validate_exercise_source() from public, anon, authenticated;
create trigger c_validate_exercise_source before insert or update on public.exercises
  for each row execute function peppitness_private.validate_exercise_source();

create function public.adopt_shared_exercise(p_template_id uuid)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare
  actor uuid := auth.uid();
  template public.shared_exercises%rowtype;
  adopted uuid;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Sign in required'; end if;
  select * into template from public.shared_exercises where id = p_template_id;
  if not found then raise exception using errcode = '22023', message = 'Exercise not available'; end if;

  insert into public.exercises (owner_id, name, variant, equipment, load_convention,
    load_unit, measurement_mode, per_side, note, source_template_id)
  values (actor, template.name, template.variant, template.equipment, template.load_convention,
    template.load_unit, template.measurement_mode, template.per_side, template.note, template.id)
  on conflict (owner_id, source_template_id) do nothing;

  select id into adopted from public.exercises
    where owner_id = actor and source_template_id = p_template_id;
  if adopted is null then raise exception using errcode = 'PT409', message = 'Exercise adoption not confirmed'; end if;
  return adopted;
end;
$$;
revoke all on function public.adopt_shared_exercise(uuid) from public, anon, authenticated;
grant execute on function public.adopt_shared_exercise(uuid) to authenticated;
