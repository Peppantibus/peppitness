-- Task 20. commit_diet_import: nuovo meal_plans, selezione opzionale e ricevuta in UNA
-- transazione (specifica §§11.2, 12.1). Schema dieta corrente invariato: il documento resta
-- meal_plans.document (MealPlanDocument V1, trigger validate_meal_plan); nessuna tabella
-- nutrizionale, nessuna migration del vecchio branch, nessuna scrittura su meal_logs.
--
-- Sequenza (primitive del 18, validazione e provenienza generiche del 19):
--   auth -> commandHash -> claim (replay) -> validazione chiusa del MealPlanDraft e della
--   provenienza, job del proprietario -> contentHash -> selezione (lock) -> piano ->
--   apply selezione (solo meal_plan_id) -> finalize ricevuta (ultima scrittura).

-- ---------------------------------------------------------------------------
-- Payload risolto della dieta: resolvedDietImportSchema + resolvedDietErrors di commit.ts,
-- stessi limiti di validateMealPlanDraft/mealPlanTooLarge. Nessuna normalizzazione: il
-- documento si salva esattamente come revisionato. Restituisce i target della provenienza.
-- ---------------------------------------------------------------------------
create function peppitness_private.import_diet_targets(p_payload jsonb) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  plan jsonb; plan_document jsonb; plan_day jsonb; meal jsonb; food jsonb; line jsonb;
begin
  perform peppitness_private.import_require(peppitness_private.import_keys(p_payload, array['protocolVersion', 'kind', 'mode', 'resolved'])
    and p_payload->'protocolVersion' = '"peppitness.import-commit.v1"' and p_payload->'kind' = '"diet"'
    and p_payload->'mode' = '"create_new"' and peppitness_private.import_keys(p_payload->'resolved', array['plan']));
  plan := p_payload #> '{resolved,plan}';
  perform peppitness_private.import_require(peppitness_private.import_keys(plan, array['id', 'name', 'document'])
    and peppitness_private.import_uuid_text(plan->'id') and peppitness_private.import_text(plan->'name', 160, 'trimmed')
    and peppitness_private.import_keys(plan->'document', array['guidance', 'days']));
  plan_document := plan->'document';
  perform peppitness_private.import_require(peppitness_private.import_text(plan_document->'guidance', 16000, 'optional')
    and pg_catalog.jsonb_typeof(plan_document->'days') = 'array');
  -- Almeno una giornata con pasti: un piano vuoto non è un import riuscito.
  perform peppitness_private.import_require(pg_catalog.jsonb_array_length(plan_document->'days') between 1 and 14);
  for plan_day in select value from pg_catalog.jsonb_array_elements(plan_document->'days') loop
    perform peppitness_private.import_require(peppitness_private.import_keys(plan_day, array['id', 'name', 'dayType', 'note', 'meals'])
      and peppitness_private.import_uuid_text(plan_day->'id') and peppitness_private.import_text(plan_day->'name', 120, 'required')
      and plan_day->'dayType' in ('"training"', '"rest"', '"any"')
      and peppitness_private.import_text(plan_day->'note', 4000, 'optional')
      and pg_catalog.jsonb_typeof(plan_day->'meals') = 'array');
    perform peppitness_private.import_require(pg_catalog.jsonb_array_length(plan_day->'meals') between 1 and 20);
    for meal in select value from pg_catalog.jsonb_array_elements(plan_day->'meals') loop
      perform peppitness_private.import_require(peppitness_private.import_keys(meal, array['id', 'name', 'time', 'foods', 'alternatives', 'additions', 'note'])
        and peppitness_private.import_uuid_text(meal->'id') and peppitness_private.import_text(meal->'name', 120, 'required')
        and peppitness_private.import_text(meal->'time', 60, 'optional') and peppitness_private.import_text(meal->'note', 4000, 'optional')
        and pg_catalog.jsonb_typeof(meal->'foods') = 'array' and pg_catalog.jsonb_typeof(meal->'alternatives') = 'array'
        and pg_catalog.jsonb_typeof(meal->'additions') = 'array');
      perform peppitness_private.import_require(pg_catalog.jsonb_array_length(meal->'foods') <= 60
        and pg_catalog.jsonb_array_length(meal->'alternatives') <= 30 and pg_catalog.jsonb_array_length(meal->'additions') <= 30);
      -- Alternative e aggiunte: frasi complete, mai righe vuote o rifilate qui.
      for line in select value from pg_catalog.jsonb_array_elements(meal->'alternatives')
          union all select value from pg_catalog.jsonb_array_elements(meal->'additions') loop
        perform peppitness_private.import_require(peppitness_private.import_text(line, 500, 'required'));
      end loop;
      -- Quantità testuale: '' solo come vuoto confermato (verificato dalla provenienza).
      for food in select value from pg_catalog.jsonb_array_elements(meal->'foods') loop
        perform peppitness_private.import_require(peppitness_private.import_keys(food, array['name', 'quantity'])
          and peppitness_private.import_text(food->'name', 200, 'required') and peppitness_private.import_text(food->'quantity', 60, 'optional'));
      end loop;
    end loop;
  end loop;
  -- UUID tecnici unici: piano, giornate e pasti.
  perform peppitness_private.import_require((select count(*) = count(distinct t.id) from (
    select plan->>'id' as id
    union all select d.value->>'id' from pg_catalog.jsonb_array_elements(plan_document->'days') d
    union all select m.value->>'id' from pg_catalog.jsonb_array_elements(plan_document->'days') d,
      pg_catalog.jsonb_array_elements(d.value->'meals') m) t));
  -- Guard dell'import: JSON compatto UTF-8 (canonico = stessa lunghezza di JSON.stringify) entro
  -- 180000 byte, sotto i 262144 byte della forma testuale jsonb controllati dalla tabella.
  perform peppitness_private.import_require(pg_catalog.octet_length(pg_catalog.convert_to(
    peppitness_private.canonical_json(plan_document), 'UTF8')) <= 180000);

  return (select pg_catalog.jsonb_object_agg(t.id, t.target) from (
    select plan->>'id' as id, '{"role":"plan"}'::jsonb as target
    union all select d.value->>'id', pg_catalog.jsonb_build_object('role', 'day', 'value', d.value - 'meals')
      from pg_catalog.jsonb_array_elements(plan_document->'days') d
    union all select m.value->>'id', pg_catalog.jsonb_build_object('role', 'meal', 'value', m.value)
      from pg_catalog.jsonb_array_elements(plan_document->'days') d, pg_catalog.jsonb_array_elements(d.value->'meals') m) t);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC pubblica. SECURITY DEFINER come le altre RPC: owner solo da auth.uid(), ogni
-- riferimento (piano, job) ricontrollato qui; il client non scrive ricevute.
-- ---------------------------------------------------------------------------
create function public.commit_diet_import(p_request_id uuid, p_resolved_payload jsonb, p_provenance jsonb, p_selection_options jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  command_hash text; content_hash text; receipt jsonb; targets jsonb; new_plan uuid; selection jsonb;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  command_hash := peppitness_private.import_command_hash(p_request_id, p_resolved_payload, p_provenance, p_selection_options);
  -- 1. Richiesta: stesso comando -> stessa ricevuta (anche deleted), senza rileggere altro.
  receipt := peppitness_private.claim_import_receipt(actor, p_request_id, 'diet', command_hash);
  if receipt is not null then return receipt; end if;

  targets := peppitness_private.import_diet_targets(p_resolved_payload);
  perform peppitness_private.import_check_provenance(actor, 'diet', p_provenance, targets);
  content_hash := peppitness_private.import_content_hash(p_resolved_payload);
  new_plan := (p_resolved_payload #>> '{resolved,plan,id}')::uuid;

  -- 2. Selezione (solo con follow): revisione vista verificata subito.
  perform peppitness_private.lock_import_selection(actor, p_selection_options);

  -- Nuovo piano: mai upsert su un ID esistente (di chiunque) o di un import eliminato.
  if exists (select 1 from public.meal_plans where id = new_plan)
    or exists (select 1 from public.import_receipts r where r.owner_id = actor and r.plan_id = new_plan) then
    raise exception using errcode = 'PT409', message = 'Import request conflict';
  end if;
  begin
    -- 3. Piano: documento esattamente come revisionato; il trigger corrente lo ricontrolla.
    insert into public.meal_plans(id, owner_id, name, document)
      values (new_plan, actor, p_resolved_payload #>> '{resolved,plan,name}', p_resolved_payload #> '{resolved,plan,document}');
  exception when unique_violation then
    raise exception using errcode = 'PT409', message = 'Import request conflict';
  end;

  -- 4. Selezione esplicita (solo meal_plan_id, scheda preservata), 5. ricevuta come ultima scrittura.
  selection := peppitness_private.apply_import_selection(actor, 'diet', new_plan, p_selection_options);
  return peppitness_private.finalize_import_receipt(actor, p_request_id, 'diet', command_hash, content_hash,
    new_plan, null, '[]'::jsonb, selection, p_provenance);
end;
$$;

revoke all on function peppitness_private.import_diet_targets(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.commit_diet_import(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.commit_diet_import(uuid, jsonb, jsonb, jsonb) to authenticated;

comment on function public.commit_diet_import(uuid, jsonb, jsonb, jsonb) is
  'Import dieta atomico: nuovo meal_plans, selezione opzionale e ricevuta idempotente; diario invariato.';
