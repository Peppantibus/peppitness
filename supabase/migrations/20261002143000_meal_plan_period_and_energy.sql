-- Estensione retrocompatibile: nessun UPDATE ai piani o ai pasti esistenti.
-- Il formato import Word v1 resta chiuso; i metadati si configurano negli editor.
create function peppitness_private.meal_energy_number(value jsonb, low numeric, high numeric, whole boolean)
returns boolean language plpgsql immutable set search_path='' as $$
declare n numeric;
begin
  if jsonb_typeof(value) is distinct from 'number' then return false; end if;
  n := (value#>>'{}')::numeric;
  return n between low and high and (not whole or n=trunc(n));
exception when others then return false;
end; $$;
create function peppitness_private.meal_period_date(value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare d date; t text;
begin
  if jsonb_typeof(value) is distinct from 'string' then return false; end if;
  t := value#>>'{}';
  if t !~ '^\d{4}-\d{2}-\d{2}$' then return false; end if;
  d := t::date;
  return d between date '1900-01-01' and date '2100-12-31' and to_char(d,'YYYY-MM-DD')=t;
exception when others then return false;
end; $$;
revoke all on function peppitness_private.meal_energy_number(jsonb,numeric,numeric,boolean) from public,anon,authenticated;
revoke all on function peppitness_private.meal_period_date(jsonb) from public,anon,authenticated;

create or replace function peppitness_private.validate_meal_plan()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  doc jsonb := NEW.document;
  day_item jsonb; meal_item jsonb; food_item jsonb;
  ids text[] := '{}';
begin
  if jsonb_typeof(doc) is distinct from 'object'
    or exists (select 1 from jsonb_object_keys(doc) k where k not in ('guidance', 'days', 'cycle', 'dailyCalories'))
    or not peppitness_private.valid_text(doc->'guidance', 16000, false)
    or jsonb_typeof(doc->'days') is distinct from 'array'
    or jsonb_array_length(doc->'days') > 14 then
    raise exception using errcode = '23514', message = 'Invalid meal plan document';
  end if;
  if doc ? 'cycle' and doc->'cycle' <> 'null'::jsonb then
    if jsonb_typeof(doc->'cycle') is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(doc->'cycle') k where k not in ('start','weeks'))
      or not peppitness_private.meal_period_date(doc#>'{cycle,start}')
      or not peppitness_private.meal_energy_number(doc#>'{cycle,weeks}',1,52,true) then
      raise exception using errcode='23514', message='Invalid meal plan period';
    end if;
    if (doc#>>'{cycle,start}')::date + ((doc#>>'{cycle,weeks}')::integer * 7 - 1) > date '2100-12-31' then
      raise exception using errcode='23514', message='Invalid meal plan period end';
    end if;
  end if;
  if doc ? 'dailyCalories' and doc->'dailyCalories' <> 'null'::jsonb
    and not peppitness_private.meal_energy_number(doc->'dailyCalories',1,20000,true) then
    raise exception using errcode='23514', message='Invalid daily calorie target';
  end if;
  for day_item in select value from jsonb_array_elements(doc->'days') loop
    if jsonb_typeof(day_item) is distinct from 'object'
      or exists (select 1 from jsonb_object_keys(day_item) k where k not in ('id', 'name', 'dayType', 'note', 'meals'))
      or not peppitness_private.valid_uuid(day_item->'id')
      or not peppitness_private.valid_text(day_item->'name', 120, true)
      or coalesce(day_item->>'dayType', '') not in ('training', 'rest', 'any')
      or not peppitness_private.valid_text(day_item->'note', 4000, false)
      or jsonb_typeof(day_item->'meals') is distinct from 'array'
      or jsonb_array_length(day_item->'meals') > 20
      or (day_item->>'id') = any(ids) then
      raise exception using errcode = '23514', message = 'Invalid meal plan day';
    end if;
    ids := array_append(ids, day_item->>'id');
    for meal_item in select value from jsonb_array_elements(day_item->'meals') loop
      if jsonb_typeof(meal_item) is distinct from 'object'
        or exists (select 1 from jsonb_object_keys(meal_item) k
          where k not in ('id', 'name', 'time', 'foods', 'alternatives', 'additions', 'note'))
        or not peppitness_private.valid_uuid(meal_item->'id')
        or not peppitness_private.valid_text(meal_item->'name', 120, true)
        or not peppitness_private.valid_text(meal_item->'time', 60, false)
        or not peppitness_private.valid_text(meal_item->'note', 4000, false)
        or not peppitness_private.valid_text_list(meal_item->'alternatives', 30, 500)
        or not peppitness_private.valid_text_list(meal_item->'additions', 30, 500)
        or jsonb_typeof(meal_item->'foods') is distinct from 'array'
        or jsonb_array_length(meal_item->'foods') > 60
        or (meal_item->>'id') = any(ids) then
        raise exception using errcode = '23514', message = 'Invalid meal';
      end if;
      ids := array_append(ids, meal_item->>'id');
      for food_item in select value from jsonb_array_elements(meal_item->'foods') loop
        if jsonb_typeof(food_item) is distinct from 'object'
          or exists (select 1 from jsonb_object_keys(food_item) k where k not in ('name', 'quantity', 'kcalPer100g'))
          or not peppitness_private.valid_text(food_item->'name', 200, true)
          or not peppitness_private.valid_text(food_item->'quantity', 60, false) then
          raise exception using errcode = '23514', message = 'Invalid meal food';
        end if;
        if food_item ? 'kcalPer100g' and food_item->'kcalPer100g' <> 'null'::jsonb
          and not peppitness_private.meal_energy_number(food_item->'kcalPer100g',0,1000,false) then
          raise exception using errcode='23514', message='Invalid food energy';
        end if;
      end loop;
    end loop;
  end loop;
  if TG_OP = 'UPDATE' and NEW.id is distinct from OLD.id then
    raise exception using errcode = '23514', message = 'Meal plan identity cannot change';
  end if;
  return NEW;
end;
$$;

create function peppitness_private.validate_meal_energy_snapshot()
returns trigger language plpgsql security definer set search_path='' as $$
declare e jsonb := NEW.meal_snapshot->'energy'; overrides jsonb := NEW.meal_snapshot->'energyOverrides';
begin
  if NEW.meal_snapshot ? 'energy' then
    if jsonb_typeof(e) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(e) k where k not in ('version','kcal','missing'))
      or e->'version' is distinct from '1'::jsonb
      or not (e ? 'kcal')
      or not peppitness_private.meal_energy_number(e->'missing',0,60,true)
      or not (e->'kcal' = 'null'::jsonb or peppitness_private.meal_energy_number(e->'kcal',0,10000000,true)) then
      raise exception using errcode='23514',message='Invalid meal energy snapshot';
    end if;
  end if;
  if NEW.meal_snapshot ? 'energyOverrides' then
    if jsonb_typeof(overrides) is distinct from 'array' or jsonb_typeof(NEW.meal_snapshot->'items') is distinct from 'array'
      or jsonb_array_length(overrides) > 60 or jsonb_array_length(overrides) <> jsonb_array_length(NEW.meal_snapshot->'items') then
      raise exception using errcode='23514',message='Invalid meal energy overrides';
    end if;
    if exists(select 1 from jsonb_array_elements(overrides) v where v <> 'null'::jsonb and not peppitness_private.meal_energy_number(v,0,1000,false)) then
      raise exception using errcode='23514',message='Invalid meal energy override';
    end if;
  end if;
  return NEW;
end; $$;
revoke all on function peppitness_private.validate_meal_energy_snapshot() from public,anon,authenticated;
create trigger c_validate_meal_energy_snapshot before insert or update on public.meal_logs
for each row execute function peppitness_private.validate_meal_energy_snapshot();
comment on table public.meal_plans is 'Piano alimentare validato, periodo e obiettivo energetico facoltativi; stime da riferimenti nel frontend.';
