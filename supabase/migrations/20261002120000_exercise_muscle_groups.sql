-- Gruppo principale modificabile senza cambiare identità/confronti o storico.
-- Regole riconoscimento allineate a src/domain/muscle-groups.ts.
create function peppitness_private.infer_muscle_group(p_name text, p_variant text default '')
returns text language sql immutable security invoker set search_path = '' as $$
  select case
    when normalized ~ '^(reverse pec deck|face pull|military press|shoulder press|overhead press|arnold press|alzate laterali|alzate posteriori|alzate frontali|lento avanti|lento con|scrollate)( |$)' then 'Spalle'
    when normalized ~ '^(pushdown|push down|triceps|tricipiti|estensioni tricipiti|french press|skull crusher|panca presa stretta)( |$)' then 'Tricipiti'
    when normalized ~ '^dip.* tricipiti( |$)' then 'Tricipiti'
    when normalized ~ '^dip.* petto( |$)' then 'Petto'
    when normalized ~ '^(leg curl|leg extension|squat|front squat|back squat|goblet squat|hack squat|pressa|leg press|affondi|split squat|bulgarian split squat|step up|stacco|deadlift|romanian deadlift|adduzioni)( |$)' then 'Gambe'
    when normalized ~ '^(hip thrust|glute bridge|ponte glutei|abduzioni|glute kickback|slanci glutei)( |$)' then 'Glutei'
    when normalized ~ '^(calf|polpacci|sollevamento polpacci)( |$)' then 'Polpacci'
    when normalized ~ '^(trazioni|pull up|pullup|chin up|lat machine|lat pulldown|rematore|row|seated row|pulley|high row|low row|pulldown|iperestensioni)( |$)' then 'Schiena'
    when normalized ~ '^(panca piana|panca inclinata|panca declinata|bench press|chest press|croci|pec deck|pectoral|piegamenti sulle braccia|push up|pushup)( |$)' then 'Petto'
    when normalized ~ '^(curl|biceps|bicipiti)( |$)' then 'Bicipiti'
    when normalized ~ '^(crunch|plank|pallof press|dead bug|sit up|ab wheel|sollevamento gambe|sollevamento ginocchia)( |$)' then 'Addome'
    when normalized ~ '^(farmer|farmers|carry|suitcase carry|burpee|thruster)( |$)' then 'Full body'
    when normalized ~ '^(camminata|tapis roulant|treadmill|cyclette|bici|bicicletta|vogatore|rowing machine|ellittica|corsa|cardio|air bike|assault bike)( |$)' then 'Cardio'
    else null end
  from (select btrim(regexp_replace(translate(lower(coalesce(p_name, '') || ' ' || coalesce(p_variant, '')),
    'àáâäãåèéêëìíîïòóôöõùúûüñç', 'aaaaaaeeeeiiiiooooouuuunc'), '[^a-z0-9]+', ' ', 'g')) normalized) text;
$$;
revoke all on function peppitness_private.infer_muscle_group(text,text) from public,anon,authenticated;

-- «auto» è solo il default prima del trigger: non può essere persistito.
-- Vecchi client, template e import v1 omettono il campo: il server riconosce i nomi noti.
-- null inviato esplicitamente conserva la scelta «Da classificare».
alter table public.exercises add column muscle_group text;
alter table public.shared_exercises add column muscle_group text;

update public.shared_exercises set muscle_group = peppitness_private.infer_muscle_group(name, variant);
update public.exercises set muscle_group = peppitness_private.infer_muscle_group(name, variant), revision = revision + 1
where peppitness_private.infer_muscle_group(name, variant) is not null;

alter table public.exercises alter column muscle_group set default 'auto';
alter table public.shared_exercises alter column muscle_group set default 'auto';
alter table public.exercises add constraint exercises_muscle_group_check check (muscle_group in ('Petto', 'Schiena', 'Spalle', 'Bicipiti', 'Tricipiti', 'Gambe', 'Glutei', 'Polpacci', 'Addome', 'Full body', 'Cardio'));
alter table public.shared_exercises add constraint shared_exercises_muscle_group_check check (muscle_group in ('Petto', 'Schiena', 'Spalle', 'Bicipiti', 'Tricipiti', 'Gambe', 'Glutei', 'Polpacci', 'Addome', 'Full body', 'Cardio'));

create function peppitness_private.set_initial_muscle_group() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if NEW.muscle_group = 'auto' then
    NEW.muscle_group := peppitness_private.infer_muscle_group(NEW.name, NEW.variant);
  end if;
  return NEW;
end;
$$;
revoke all on function peppitness_private.set_initial_muscle_group() from public,anon,authenticated;
create trigger d_initial_muscle_group before insert on public.exercises
  for each row execute function peppitness_private.set_initial_muscle_group();
create trigger d_initial_muscle_group before insert on public.shared_exercises
  for each row execute function peppitness_private.set_initial_muscle_group();
grant update(muscle_group) on public.exercises to authenticated;
comment on column public.exercises.muscle_group is 'Gruppo principale modificabile; null = da classificare. Non appartiene all’identità di confronto.';
comment on column public.shared_exercises.muscle_group is 'Gruppo principale del template comune.';

create or replace function public.adopt_shared_exercise(p_template_id uuid)
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
    load_unit, measurement_mode, per_side, note, source_template_id, muscle_group)
  values (actor, template.name, template.variant, template.equipment, template.load_convention,
    template.load_unit, template.measurement_mode, template.per_side, template.note, template.id, template.muscle_group)
  on conflict (owner_id, source_template_id) do nothing;

  select id into adopted from public.exercises
    where owner_id = actor and source_template_id = p_template_id;
  if adopted is null then raise exception using errcode = 'PT409', message = 'Exercise adoption not confirmed'; end if;
  return adopted;
end;
$$;
revoke all on function public.adopt_shared_exercise(uuid) from public, anon, authenticated;
grant execute on function public.adopt_shared_exercise(uuid) to authenticated;

-- Solo INSERT: categoria dal catalogo del proprietario nello snapshot delle nuove
-- prescrizioni e delle nuove sedute; nessuna riscrittura di programmi/sedute esistenti.
create function peppitness_private.snapshot_prescription_muscle_group() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare category text;
begin
  select e.muscle_group into category from public.exercises e
    where e.id = NEW.exercise_id and e.owner_id = NEW.owner_id;
  -- La FK composita esistente rifiuta riferimenti assenti o di altri account.
  if not found then return NEW; end if;
  NEW.exercise_snapshot := NEW.exercise_snapshot || jsonb_build_object('muscle_group', category);
  return NEW;
end;
$$;
revoke all on function peppitness_private.snapshot_prescription_muscle_group() from public,anon,authenticated;
create trigger z_snapshot_muscle_group before insert on public.workout_prescriptions
  for each row execute function peppitness_private.snapshot_prescription_muscle_group();

create function peppitness_private.snapshot_session_muscle_groups() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare items jsonb;
begin
  select coalesce(jsonb_agg(item.value || jsonb_build_object('muscle_group', e.muscle_group) order by item.ordinality), '[]'::jsonb)
    into items from jsonb_array_elements(NEW.day_snapshot->'exercises') with ordinality item
    left join public.exercises e on e.id = (item.value->>'exercise_id')::uuid and e.owner_id = NEW.owner_id;
  NEW.day_snapshot := jsonb_set(NEW.day_snapshot, '{exercises}', items);
  return NEW;
end;
$$;
revoke all on function peppitness_private.snapshot_session_muscle_groups() from public,anon,authenticated;
create trigger z_snapshot_muscle_groups before insert on public.workout_sessions
  for each row execute function peppitness_private.snapshot_session_muscle_groups();
