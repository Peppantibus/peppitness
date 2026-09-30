-- Task 19. commit_workout_import: nuovo programma pubblicato, scelte del catalogo, ciclo,
-- selezione opzionale e ricevuta in UNA transazione (specifica §12.1). Nessuna migration
-- precedente è modificata; guardie e versioni di 20260928120000 restano quelle correnti.
--
-- Sequenza (primitive del 18, stesso ordine dei lock dichiarato in 20260929220035):
--   auth -> commandHash -> claim (replay prima di qualunque lettura/scrittura) ->
--   validazione chiusa di payload e provenienza, job del proprietario -> contentHash ->
--   selezione (lock) -> programma -> versione (bozza) -> catalogo (lock in ordine di id,
--   adozioni per templateId, nuovi) -> sedute/prescrizioni con snapshot server ->
--   pubblicazione + ciclo -> apply selezione -> finalize ricevuta (ultima scrittura).
-- Ogni errore annulla tutto: nessun catch restituisce un successo parziale.
--
-- Le funzioni generiche di questa migration (testi, numeri, provenienza e job) sono usate
-- anche da commit_diet_import (task 20), che segue questa migration.

-- ---------------------------------------------------------------------------
-- Validazione chiusa: 22023 'Invalid import command' per qualsiasi difformità.
-- ---------------------------------------------------------------------------
create function peppitness_private.import_require(p_ok boolean) returns void
language plpgsql immutable security invoker set search_path = '' as $$
begin
  if p_ok is not true then raise exception using errcode = '22023', message = 'Invalid import command'; end if;
end;
$$;

-- Oggetto con esattamente le chiavi indicate (nessuna mancante, nessuna in più).
create function peppitness_private.import_keys(p_value jsonb, p_keys text[]) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select coalesce(pg_catalog.jsonb_typeof(p_value) = 'object' and p_value ?& p_keys and (p_value - p_keys) = '{}'::jsonb, false);
$$;

-- Testi del dominio come src/import/contracts/domain-limits.ts: code point (char_length),
-- controlli di valid_text; 'required' = non vuoto dopo String.prototype.trim(),
-- 'trimmed' = anche senza spazi ai bordi. Gli spazi sono quelli di trim() in JavaScript,
-- non solo lo spazio ASCII di btrim().
create function peppitness_private.import_text(p_value jsonb, p_max integer, p_rule text) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select case when pg_catalog.jsonb_typeof(p_value) = 'string' then
    pg_catalog.char_length(p_value #>> '{}') <= p_max
    and (p_value #>> '{}') !~ '[\x01-\x08\x0B\x0C\x0E-\x1F]'
    and (p_rule = 'optional'
      or (p_value #>> '{}') !~ '^[\t\n\v\f\r    -     　﻿]*$')
    and (p_rule <> 'trimmed'
      or (p_value #>> '{}') !~ '^[\t\n\v\f\r    -     　﻿]|[\t\n\v\f\r    -     　﻿]$')
  else false end;
$$;

create function peppitness_private.import_integer(p_value jsonb, p_min numeric, p_max numeric) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select case when pg_catalog.jsonb_typeof(p_value) = 'number' then
    (p_value #>> '{}')::numeric between p_min and p_max and (p_value #>> '{}')::numeric % 1 = 0
  else false end;
$$;

-- Decimale semplice del contratto (niente esponente in String(n) di JavaScript: 0 oppure >= 1e-6).
create function peppitness_private.import_decimal(p_value jsonb, p_min numeric, p_max numeric) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select case when pg_catalog.jsonb_typeof(p_value) = 'number' then
    (p_value #>> '{}')::numeric between p_min and p_max
    and ((p_value #>> '{}')::numeric = 0 or (p_value #>> '{}')::numeric >= 0.000001)
  else false end;
$$;

-- Valori di un esercizio visti o confermati (catalogExerciseValuesSchema).
create function peppitness_private.import_exercise_values(p_values jsonb) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select coalesce(peppitness_private.import_keys(p_values,
      array['name', 'variant', 'equipment', 'loadConvention', 'loadUnit', 'measurementMode', 'perSide', 'note'])
    and peppitness_private.import_text(p_values->'name', 120, 'trimmed')
    and peppitness_private.import_text(p_values->'variant', 120, 'optional')
    and peppitness_private.import_text(p_values->'equipment', 120, 'optional')
    and p_values->'loadConvention' in ('"total"', '"single-dumbbell"', '"bodyweight"')
    and p_values->'loadUnit' in ('"kg"', '"lb"')
    and p_values->'measurementMode' in ('"reps"', '"seconds"')
    and pg_catalog.jsonb_typeof(p_values->'perSide') = 'boolean'
    and peppitness_private.import_text(p_values->'note', 4000, 'optional'), false);
$$;

-- Riga del catalogo (to_jsonb di exercises/shared_exercises) identica ai valori visti:
-- identità, nome e note. Una rinomina o una nota cambiata è una deriva, non un dettaglio.
create function peppitness_private.import_exercise_matches(p_row jsonb, p_values jsonb) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select row(p_row->>'name', p_row->>'variant', p_row->>'equipment', p_row->>'load_convention', p_row->>'load_unit',
      p_row->>'measurement_mode', (p_row->>'per_side')::boolean, p_row->>'note')
    is not distinct from row(p_values->>'name', p_values->>'variant', p_values->>'equipment', p_values->>'loadConvention',
      p_values->>'loadUnit', p_values->>'measurementMode', (p_values->>'perSide')::boolean, p_values->>'note');
$$;

-- ---------------------------------------------------------------------------
-- Provenienza: formato chiuso, job/fonte del proprietario, puntatori reali della proposta.
-- p_targets: UUID tecnico -> {role, value} dell'elemento salvato (piano, seduta,
-- prescrizione, giornata, pasto). Un valore senza decisione dello stesso campo deve essere
-- quello estratto: nessun "estratto" per un valore cambiato o completato dal client.
-- ---------------------------------------------------------------------------
create function peppitness_private.import_check_provenance(p_owner_id uuid, p_kind text, p_provenance jsonb, p_targets jsonb)
returns void language plpgsql stable security invoker set search_path = '' as $$
declare
  analysis jsonb; origin jsonb; analysis_job uuid; job public.import_jobs; extraction jsonb;
  item jsonb; target jsonb; node jsonb; pointer text; item_role text; fields text[]; saved jsonb; field text; extracted_range jsonb;
begin
  perform peppitness_private.import_require(peppitness_private.import_keys(p_provenance, array['formatVersion', 'kind', 'analysis', 'items'])
    and p_provenance->'formatVersion' = '"peppitness.import-provenance.v1"' and p_provenance->'kind' = pg_catalog.to_jsonb(p_kind));
  analysis := p_provenance->'analysis';
  perform peppitness_private.import_require(peppitness_private.import_keys(analysis, array['jobId', 'proposalId', 'proposalVersion', 'schemaId', 'source'])
    and (analysis->'jobId' = 'null'::jsonb or peppitness_private.import_uuid_text(analysis->'jobId'))
    and peppitness_private.import_uuid_text(analysis->'proposalId')
    and peppitness_private.import_integer(analysis->'proposalVersion', 1, 9007199254740991)
    and analysis->'schemaId' = pg_catalog.to_jsonb(case p_kind when 'workout' then 'peppitness.workout-extraction.v1' else 'peppitness.diet-extraction.v1' end));
  origin := analysis->'source';
  perform peppitness_private.import_require(peppitness_private.import_keys(origin, array['sourceHash', 'readerVersion', 'textNormalizationVersion'])
    and pg_catalog.jsonb_typeof(origin->'sourceHash') = 'string' and (origin->>'sourceHash') ~ '^[0-9a-f]{64}$'
    and pg_catalog.jsonb_typeof(origin->'readerVersion') = 'string' and pg_catalog.char_length(origin->>'readerVersion') <= 100
    and (origin->>'readerVersion') ~ '^[A-Za-z0-9][A-Za-z0-9._@/+-]*$'
    and origin->'textNormalizationVersion' = '"peppitness.text-normalization.v1"'
    and pg_catalog.jsonb_typeof(p_provenance->'items') = 'array');
  perform peppitness_private.import_require(pg_catalog.jsonb_array_length(p_provenance->'items') <= 200000);
  perform peppitness_private.import_require((select count(*) = count(distinct i.value->>'localId')
    from pg_catalog.jsonb_array_elements(p_provenance->'items') i));

  -- Job dell'analisi: solo del proprietario, stesso dominio e fonte, ancora pronto.
  if analysis->'jobId' <> 'null'::jsonb then
    analysis_job := (analysis->>'jobId')::uuid;
    select * into job from public.import_jobs j where j.owner_id = p_owner_id and j.id = analysis_job;
    if not FOUND then raise exception using errcode = '42501', message = 'Import reference not available'; end if;
    if job.status = 'expired' or job.expires_at <= pg_catalog.clock_timestamp() then
      raise exception using errcode = 'PT410', message = 'Import analysis expired';
    end if;
    perform peppitness_private.import_require(job.kind = p_kind and job.status = 'ready'
      and job.versions->>'schema' = '1.0' and job.versions->>'reader' = origin->>'readerVersion');
    select d.extraction into extraction from public.import_drafts d
      where d.owner_id = p_owner_id and d.job_id = analysis_job and d.normalized_document->>'sourceHash' = origin->>'sourceHash';
    perform peppitness_private.import_require(extraction->>'outcome' = 'extracted' and extraction->>'kind' = p_kind);
  end if;

  for item in select value from pg_catalog.jsonb_array_elements(p_provenance->'items') loop
    perform peppitness_private.import_require(peppitness_private.import_keys(item, array['localId', 'targetId', 'sourcePointer', 'decisions'])
      and pg_catalog.jsonb_typeof(item->'localId') = 'string' and pg_catalog.char_length(item->>'localId') between 1 and 200
      and (item->>'localId') ~ '^[A-Za-z0-9][A-Za-z0-9:._-]*$'
      and (item->'targetId' = 'null'::jsonb or peppitness_private.import_uuid_text(item->'targetId'))
      and (item->'sourcePointer' = 'null'::jsonb or (pg_catalog.jsonb_typeof(item->'sourcePointer') = 'string'
        and pg_catalog.char_length(item->>'sourcePointer') <= 1000 and (item->>'sourcePointer') ~ '^(/([^~/]|~[01])*)*$'))
      and pg_catalog.jsonb_typeof(item->'decisions') = 'array');
    perform peppitness_private.import_require(pg_catalog.jsonb_array_length(item->'decisions') <= 2000
      and not exists (select 1 from pg_catalog.jsonb_array_elements(item->'decisions') d(decision)
        where not coalesce(peppitness_private.import_keys(d.decision, array['field', 'reason'])
          and (d.decision->'field' = 'null'::jsonb or (pg_catalog.jsonb_typeof(d.decision->'field') = 'string'
            and pg_catalog.char_length(d.decision->>'field') <= 64 and (d.decision->>'field') ~ '^[a-z][A-Za-z0-9]*$'))
          and d.decision->'reason' in ('"user_edit"', '"catalog_choice"', '"timer_choice"', '"confirmed_missing"', '"scope_choice"'), false)));
    target := null;
    if item->'targetId' <> 'null'::jsonb then
      target := p_targets->(item->>'targetId');
      perform peppitness_private.import_require(target is not null);
    end if;
    -- Elemento aggiunto in revisione: nessuna fonte da verificare.
    if item->'sourcePointer' = 'null'::jsonb then continue; end if;
    -- Un elemento "dalla fonte" richiede l'analisi del proprietario che lo contiene.
    perform peppitness_private.import_require(extraction is not null);
    pointer := item->>'sourcePointer';
    item_role := case
      when pointer = '' then 'root'
      when p_kind = 'workout' and pointer ~ '^/sessions/(0|[1-9][0-9]*)$' then 'day'
      when p_kind = 'workout' and pointer ~ '^/sessions/(0|[1-9][0-9]*)/exercises/(0|[1-9][0-9]*)$' then 'prescription'
      when p_kind = 'workout' and pointer ~ '^/complexRules/(0|[1-9][0-9]*)$' then 'rule'
      when p_kind = 'diet' and pointer ~ '^/days/(0|[1-9][0-9]*)$' then 'day'
      when p_kind = 'diet' and pointer ~ '^/days/(0|[1-9][0-9]*)/meals/(0|[1-9][0-9]*)$' then 'meal'
      when p_kind = 'diet' and pointer ~ '^/days/(0|[1-9][0-9]*)/meals/(0|[1-9][0-9]*)/foods/(0|[1-9][0-9]*)$' then 'food'
      when p_kind = 'diet' and pointer ~ '^/globalRules/(0|[1-9][0-9]*)$' then 'rule'
    end;
    perform peppitness_private.import_require(item_role is not null);
    -- Puntatori ammessi: soli nomi e indici, nessun escape da decodificare.
    node := extraction #> pg_catalog.string_to_array(pg_catalog.substr(pointer, 2), '/');
    perform peppitness_private.import_require(pg_catalog.jsonb_typeof(node) = 'object'
      and case item_role
        when 'root' then target is null or target->>'role' = 'plan'
        when 'rule' then target is null
        when 'food' then target->>'role' = 'meal'
        else target->>'role' = item_role end);
    fields := array(select d.decision->>'field' from pg_catalog.jsonb_array_elements(item->'decisions') d(decision)
      where d.decision->'field' <> 'null'::jsonb);
    saved := target->'value';
    if item_role = 'root' then
      perform peppitness_private.import_require(node->'title' <> 'null'::jsonb or 'title' = any(fields));
    elsif item_role = 'day' and p_kind = 'workout' then
      perform peppitness_private.import_require(node->'title' <> 'null'::jsonb or 'title' = any(fields));
    elsif item_role = 'day' then
      perform peppitness_private.import_require((node->'name' <> 'null'::jsonb or 'name' = any(fields))
        and (node->'dayType' <> 'null'::jsonb or 'dayType' = any(fields)));
    elsif item_role = 'meal' then
      perform peppitness_private.import_require(node->'name' <> 'null'::jsonb or 'name' = any(fields));
    elsif item_role = 'food' then
      -- Quantità null diventa '' solo se confermata o modificata esplicitamente.
      perform peppitness_private.import_require((node->'name' <> 'null'::jsonb or 'name' = any(fields))
        and (node->'quantityText' <> 'null'::jsonb or 'quantityText' = any(fields)));
      if not ('name' = any(fields) or 'quantityText' = any(fields)) then
        perform peppitness_private.import_require(exists (select 1 from pg_catalog.jsonb_array_elements(saved->'foods') f(food)
          where f.food = pg_catalog.jsonb_build_object('name', node->'name', 'quantity', node->'quantityText')));
      end if;
    elsif item_role = 'prescription' then
      foreach field in array array['sets', 'optionalSets'] loop
        if not field = any(fields) then perform peppitness_private.import_require(node->field = saved->field); end if;
      end loop;
      if not 'repetitions' = any(fields) then
        perform peppitness_private.import_require((node->'repetitions' = 'null'::jsonb and saved->'repsMin' = 'null'::jsonb and saved->'repsMax' = 'null'::jsonb)
          or (node #> '{repetitions,min}' = saved->'repsMin' and node #> '{repetitions,max}' = saved->'repsMax'));
      end if;
      -- Un intervallo estratto (min <> max) richiede sempre una scelta esplicita.
      foreach field in array array['durationSeconds', 'restSeconds', 'rir', 'rpe'] loop
        if not field = any(fields) then
          extracted_range := node->field;
          perform peppitness_private.import_require((extracted_range = 'null'::jsonb and saved->field = 'null'::jsonb)
            or (extracted_range->'min' = extracted_range->'max' and extracted_range->'min' = saved->field));
        end if;
      end loop;
    end if;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Payload risolto della scheda: stessa forma e stesse regole di commit.ts
-- (resolvedWorkoutImportSchema + resolvedWorkoutErrors). Restituisce i target della provenienza.
-- ---------------------------------------------------------------------------
create function peppitness_private.import_workout_targets(p_payload jsonb) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  resolved jsonb; plan_cycle jsonb; cycle_date date; binding jsonb; choice jsonb; workout_day jsonb; prescription jsonb;
begin
  perform peppitness_private.import_require(peppitness_private.import_keys(p_payload, array['protocolVersion', 'kind', 'mode', 'resolved'])
    and p_payload->'protocolVersion' = '"peppitness.import-commit.v1"' and p_payload->'kind' = '"workout"'
    and p_payload->'mode' = '"create_new"');
  resolved := p_payload->'resolved';
  perform peppitness_private.import_require(peppitness_private.import_keys(resolved, array['planId', 'versionId', 'title', 'guidance', 'cycle', 'days', 'catalog'])
    and peppitness_private.import_uuid_text(resolved->'planId') and peppitness_private.import_uuid_text(resolved->'versionId')
    and peppitness_private.import_text(resolved->'title', 160, 'trimmed') and peppitness_private.import_text(resolved->'guidance', 16000, 'optional')
    and pg_catalog.jsonb_typeof(resolved->'days') = 'array' and pg_catalog.jsonb_typeof(resolved->'catalog') = 'array');
  perform peppitness_private.import_require(pg_catalog.jsonb_array_length(resolved->'days') between 1 and 50
    and pg_catalog.jsonb_array_length(resolved->'catalog') between 1 and 10000);

  -- Ciclo completo oppure null, mai una metà; data reale nell'intervallo del dominio.
  plan_cycle := resolved->'cycle';
  if plan_cycle <> 'null'::jsonb then
    perform peppitness_private.import_require(peppitness_private.import_keys(plan_cycle, array['start', 'weeks'])
      and pg_catalog.jsonb_typeof(plan_cycle->'start') = 'string' and (plan_cycle->>'start') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and peppitness_private.import_integer(plan_cycle->'weeks', 1, 52));
    begin
      cycle_date := (plan_cycle->>'start')::date;
    exception when others then
      perform peppitness_private.import_require(false);
    end;
    perform peppitness_private.import_require(pg_catalog.to_char(cycle_date, 'YYYY-MM-DD') = plan_cycle->>'start'
      and cycle_date between date '2000-01-01' and date '2200-01-01');
  end if;

  for binding in select value from pg_catalog.jsonb_array_elements(resolved->'catalog') loop
    perform peppitness_private.import_require(peppitness_private.import_keys(binding, array['ref', 'choice'])
      and peppitness_private.import_uuid_text(binding->'ref') and pg_catalog.jsonb_typeof(binding->'choice') = 'object');
    choice := binding->'choice';
    if choice->'source' = '"existing"' then
      -- Per un esercizio esistente il ref è l'ID personale reale.
      perform peppitness_private.import_require(peppitness_private.import_keys(choice, array['source', 'personalId', 'revision', 'seen'])
        and peppitness_private.import_uuid_text(choice->'personalId') and choice->'personalId' = binding->'ref'
        and peppitness_private.import_integer(choice->'revision', 1, 2147483647)
        and peppitness_private.import_exercise_values(choice->'seen'));
    elsif choice->'source' = '"shared"' then
      perform peppitness_private.import_require(peppitness_private.import_keys(choice, array['source', 'templateId', 'seen'])
        and peppitness_private.import_uuid_text(choice->'templateId') and peppitness_private.import_exercise_values(choice->'seen'));
    elsif choice->'source' = '"new"' then
      perform peppitness_private.import_require(peppitness_private.import_keys(choice, array['source', 'localKey', 'values'])
        and pg_catalog.jsonb_typeof(choice->'localKey') = 'string' and pg_catalog.char_length(choice->>'localKey') between 1 and 200
        and (choice->>'localKey') ~ '^[A-Za-z0-9][A-Za-z0-9:._-]*$'
        and peppitness_private.import_exercise_values(choice->'values'));
    else
      perform peppitness_private.import_require(false);
    end if;
  end loop;

  for workout_day in select value from pg_catalog.jsonb_array_elements(resolved->'days') loop
    perform peppitness_private.import_require(peppitness_private.import_keys(workout_day, array['id', 'label', 'title', 'note', 'prescriptions'])
      and peppitness_private.import_uuid_text(workout_day->'id')
      and peppitness_private.import_text(workout_day->'label', 40, 'trimmed')
      and peppitness_private.import_text(workout_day->'title', 160, 'trimmed')
      and peppitness_private.import_text(workout_day->'note', 4000, 'optional')
      and pg_catalog.jsonb_typeof(workout_day->'prescriptions') = 'array');
    -- Una seduta pubblicata ha almeno una prescrizione.
    perform peppitness_private.import_require(pg_catalog.jsonb_array_length(workout_day->'prescriptions') between 1 and 200);
    for prescription in select value from pg_catalog.jsonb_array_elements(workout_day->'prescriptions') loop
      -- Nessun valore mancante: recupero, serie facoltative e serie sono sempre risolti.
      perform peppitness_private.import_require(peppitness_private.import_keys(prescription, array['id', 'exerciseRef', 'sets',
          'optionalSets', 'repsMin', 'repsMax', 'durationSeconds', 'restSeconds', 'rir', 'rpe', 'note'])
        and peppitness_private.import_uuid_text(prescription->'id') and peppitness_private.import_uuid_text(prescription->'exerciseRef')
        and peppitness_private.import_integer(prescription->'sets', 1, 1000)
        and peppitness_private.import_integer(prescription->'optionalSets', 0, 1000)
        and (prescription->'repsMin' = 'null'::jsonb or peppitness_private.import_integer(prescription->'repsMin', 1, 10000))
        and (prescription->'repsMax' = 'null'::jsonb or peppitness_private.import_integer(prescription->'repsMax', 1, 10000))
        and (prescription->'durationSeconds' = 'null'::jsonb or peppitness_private.import_integer(prescription->'durationSeconds', 1, 86400))
        and peppitness_private.import_integer(prescription->'restSeconds', 0, 86400)
        and (prescription->'rir' = 'null'::jsonb or peppitness_private.import_decimal(prescription->'rir', 0, 10))
        and (prescription->'rpe' = 'null'::jsonb or peppitness_private.import_decimal(prescription->'rpe', 1, 10))
        and peppitness_private.import_text(prescription->'note', 4000, 'optional'));
    end loop;
  end loop;

  -- Riferimenti del catalogo unici (un ref provvisorio non coincide con un ID personale scelto),
  -- una sola associazione per template e per localKey.
  perform peppitness_private.import_require((select count(*) = count(distinct b.value->>'ref')
      from pg_catalog.jsonb_array_elements(resolved->'catalog') b)
    and (select count(*) = count(distinct coalesce(b.value #>> '{choice,templateId}', b.value #>> '{choice,localKey}'))
      from pg_catalog.jsonb_array_elements(resolved->'catalog') b where b.value #>> '{choice,source}' <> 'existing'));
  -- UUID tecnici unici: piano, versione, sedute, prescrizioni e riferimenti provvisori.
  perform peppitness_private.import_require((select count(*) = count(distinct t.id) from (
    select resolved->>'planId' as id
    union all select resolved->>'versionId'
    union all select d.value->>'id' from pg_catalog.jsonb_array_elements(resolved->'days') d
    union all select p.value->>'id' from pg_catalog.jsonb_array_elements(resolved->'days') d,
      pg_catalog.jsonb_array_elements(d.value->'prescriptions') p
    union all select b.value->>'ref' from pg_catalog.jsonb_array_elements(resolved->'catalog') b
      where b.value #>> '{choice,source}' <> 'existing') t));
  perform peppitness_private.import_require((select count(*) = count(distinct d.value->>'label')
    from pg_catalog.jsonb_array_elements(resolved->'days') d));
  -- Ogni prescrizione ha un'associazione; modalità dall'esercizio scelto; reps in ordine.
  perform peppitness_private.import_require(not exists (
    with bound as (
      select b.value->>'ref' as ref,
        case when b.value #>> '{choice,source}' = 'new' then b.value #>> '{choice,values,measurementMode}'
          else b.value #>> '{choice,seen,measurementMode}' end as mode
      from pg_catalog.jsonb_array_elements(resolved->'catalog') b)
    select 1 from pg_catalog.jsonb_array_elements(resolved->'days') d
      cross join lateral pg_catalog.jsonb_array_elements(d.value->'prescriptions') p
      left join bound on bound.ref = p.value->>'exerciseRef'
    where bound.ref is null
      or case when bound.mode = 'reps'
        then p.value->'repsMin' = 'null'::jsonb or p.value->'repsMax' = 'null'::jsonb or p.value->'durationSeconds' <> 'null'::jsonb
          or (p.value->>'repsMin')::numeric > (p.value->>'repsMax')::numeric
        else p.value->'durationSeconds' = 'null'::jsonb or p.value->'repsMin' <> 'null'::jsonb or p.value->'repsMax' <> 'null'::jsonb end));
  -- Nessuna associazione inutilizzata: creerebbe o adotterebbe un esercizio mai usato.
  perform peppitness_private.import_require(not exists (
    select b.value->>'ref' from pg_catalog.jsonb_array_elements(resolved->'catalog') b
    except
    select p.value->>'exerciseRef' from pg_catalog.jsonb_array_elements(resolved->'days') d,
      pg_catalog.jsonb_array_elements(d.value->'prescriptions') p));

  return (select pg_catalog.jsonb_object_agg(t.id, t.target) from (
    select resolved->>'planId' as id, '{"role":"plan"}'::jsonb as target
    union all select d.value->>'id', pg_catalog.jsonb_build_object('role', 'day', 'value', d.value - 'prescriptions')
      from pg_catalog.jsonb_array_elements(resolved->'days') d
    union all select p.value->>'id', pg_catalog.jsonb_build_object('role', 'prescription', 'value', p.value)
      from pg_catalog.jsonb_array_elements(resolved->'days') d, pg_catalog.jsonb_array_elements(d.value->'prescriptions') p) t);
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC pubblica. SECURITY DEFINER: scrive figli, catalogo e ricevuta senza concedere al
-- client scritture dirette; owner solo da auth.uid(), ogni ID ricontrollato qui.
-- ---------------------------------------------------------------------------
create function public.commit_workout_import(p_request_id uuid, p_resolved_payload jsonb, p_provenance jsonb, p_selection_options jsonb)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  command_hash text; content_hash text; receipt jsonb; targets jsonb; resolved jsonb;
  new_plan uuid; new_version uuid; binding jsonb; choice jsonb; exercise public.exercises; template public.shared_exercises;
  resolutions jsonb := '{}'::jsonb; bindings jsonb; program_days jsonb; selection jsonb;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  command_hash := peppitness_private.import_command_hash(p_request_id, p_resolved_payload, p_provenance, p_selection_options);
  -- 1. Richiesta: stesso comando -> stessa ricevuta (anche deleted), senza rileggere altro.
  receipt := peppitness_private.claim_import_receipt(actor, p_request_id, 'workout', command_hash);
  if receipt is not null then return receipt; end if;

  -- Validazione completa prima di ogni scrittura: il "pronto" del browser non conta.
  targets := peppitness_private.import_workout_targets(p_resolved_payload);
  perform peppitness_private.import_check_provenance(actor, 'workout', p_provenance, targets);
  content_hash := peppitness_private.import_content_hash(p_resolved_payload);
  resolved := p_resolved_payload->'resolved';
  new_plan := (resolved->>'planId')::uuid;
  new_version := (resolved->>'versionId')::uuid;

  -- 2. Selezione (solo con follow): revisione vista verificata subito.
  perform peppitness_private.lock_import_selection(actor, p_selection_options);

  -- Identità sempre nuove: un UUID già usato (di chiunque, o di un import eliminato)
  -- non diventa mai un aggiornamento né una ricreazione.
  if exists (select 1 from public.workout_plans where id = new_plan)
    or exists (select 1 from public.workout_plan_versions where id = new_version)
    or exists (select 1 from public.import_receipts r where r.owner_id = actor and r.plan_id = new_plan)
    or exists (select 1 from public.workout_days w join pg_catalog.jsonb_array_elements(resolved->'days') d
      on w.id = (d.value->>'id')::uuid)
    or exists (select 1 from public.workout_prescriptions w join (select p.value from pg_catalog.jsonb_array_elements(resolved->'days') d,
      pg_catalog.jsonb_array_elements(d.value->'prescriptions') p) q on w.id = (q.value->>'id')::uuid) then
    raise exception using errcode = 'PT409', message = 'Import request conflict';
  end if;

  begin
    -- 3. Programma e 4. versione, come bozza (le guardie ammettono solo bozze all'inserimento).
    insert into public.workout_plans(id, owner_id, name) values (new_plan, actor, resolved->>'title');
    insert into public.workout_plan_versions(id, owner_id, plan_id, version_number, title, guidance)
      values (new_version, actor, new_plan, 1, resolved->>'title', resolved->>'guidance');

    -- 5. Catalogo: esercizi dell'owner coinvolti bloccati in ordine di id.
    perform 1 from public.exercises e
      where e.owner_id = actor and (e.id in (select (b.value #>> '{choice,personalId}')::uuid
          from pg_catalog.jsonb_array_elements(resolved->'catalog') b where b.value #>> '{choice,source}' = 'existing')
        or e.source_template_id in (select (b.value #>> '{choice,templateId}')::uuid
          from pg_catalog.jsonb_array_elements(resolved->'catalog') b where b.value #>> '{choice,source}' = 'shared'))
      order by e.id for update;
    -- existing: esercizio proprio, attivo, con la revisione e i valori visti.
    for binding in select b.value from pg_catalog.jsonb_array_elements(resolved->'catalog') b
        where b.value #>> '{choice,source}' = 'existing' loop
      choice := binding->'choice';
      select * into exercise from public.exercises e where e.owner_id = actor and e.id = (choice->>'personalId')::uuid;
      if not FOUND then raise exception using errcode = '42501', message = 'Import reference not available'; end if;
      if exercise.archived_at is not null or exercise.revision <> (choice->>'revision')::integer
        or not peppitness_private.import_exercise_matches(pg_catalog.to_jsonb(exercise), choice->'seen') then
        raise exception using errcode = 'PT409', message = 'Catalog changed';
      end if;
      resolutions := resolutions || pg_catalog.jsonb_build_object(binding->>'ref',
        pg_catalog.jsonb_build_object('exerciseId', exercise.id, 'resolution', 'existing'));
    end loop;
    -- shared: adozione in questa transazione, per templateId crescente. Una copia già
    -- presente vale solo se attiva e identica: mai riattivata o rinominata.
    for binding in select b.value from pg_catalog.jsonb_array_elements(resolved->'catalog') b
        where b.value #>> '{choice,source}' = 'shared' order by (b.value #>> '{choice,templateId}')::uuid loop
      choice := binding->'choice';
      select * into template from public.shared_exercises s where s.id = (choice->>'templateId')::uuid;
      if not FOUND then raise exception using errcode = '42501', message = 'Import reference not available'; end if;
      if not peppitness_private.import_exercise_matches(pg_catalog.to_jsonb(template), choice->'seen') then
        raise exception using errcode = 'PT409', message = 'Catalog changed';
      end if;
      insert into public.exercises(owner_id, name, variant, equipment, load_convention, load_unit, measurement_mode, per_side, note, source_template_id)
        values (actor, template.name, template.variant, template.equipment, template.load_convention, template.load_unit,
          template.measurement_mode, template.per_side, template.note, template.id)
        on conflict (owner_id, source_template_id) do nothing returning * into exercise;
      if FOUND then
        resolutions := resolutions || pg_catalog.jsonb_build_object(binding->>'ref',
          pg_catalog.jsonb_build_object('exerciseId', exercise.id, 'resolution', 'adopted'));
      else
        -- Adottata da un'altra transazione ormai confermata: nuovo snapshot, riga bloccata.
        select * into exercise from public.exercises e where e.owner_id = actor and e.source_template_id = template.id for update;
        if not FOUND or exercise.archived_at is not null
          or not peppitness_private.import_exercise_matches(pg_catalog.to_jsonb(exercise), choice->'seen') then
          raise exception using errcode = 'PT409', message = 'Catalog changed';
        end if;
        resolutions := resolutions || pg_catalog.jsonb_build_object(binding->>'ref',
          pg_catalog.jsonb_build_object('exerciseId', exercise.id, 'resolution', 'already_adopted'));
      end if;
    end loop;
    -- new: un esercizio per localKey con i soli valori confermati; ID generato dal server.
    for binding in select b.value from pg_catalog.jsonb_array_elements(resolved->'catalog') with ordinality b(value, position)
        where b.value #>> '{choice,source}' = 'new' order by b.position loop
      choice := binding #> '{choice,values}';
      insert into public.exercises(owner_id, name, variant, equipment, load_convention, load_unit, measurement_mode, per_side, note)
        values (actor, choice->>'name', choice->>'variant', choice->>'equipment', choice->>'loadConvention', choice->>'loadUnit',
          choice->>'measurementMode', (choice->>'perSide')::boolean, choice->>'note')
        returning * into exercise;
      resolutions := resolutions || pg_catalog.jsonb_build_object(binding->>'ref',
        pg_catalog.jsonb_build_object('exerciseId', exercise.id, 'resolution', 'created'));
    end loop;

    -- Sedute e prescrizioni con gli ID del comando e lo snapshot generato dal catalogo
    -- (write_workout_days della migration 20260928120000). I valori sono già tutti
    -- espliciti e validati: i coalesce dell'helper non completano nulla.
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', d.value->'id', 'label', d.value->'label',
        'title', d.value->'title', 'note', d.value->'note',
        'exercises', (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id', p.value->'id',
            'exercise_id', resolutions #> array[p.value->>'exerciseRef', 'exerciseId'],
            'sets', p.value->'sets', 'optional_sets', p.value->'optionalSets', 'reps_min', p.value->'repsMin',
            'reps_max', p.value->'repsMax', 'duration_seconds', p.value->'durationSeconds', 'rest_seconds', p.value->'restSeconds',
            'rir', p.value->'rir', 'rpe', p.value->'rpe', 'note', p.value->'note') order by p.position)
          from pg_catalog.jsonb_array_elements(d.value->'prescriptions') with ordinality p(value, position))) order by d.position)
      into program_days
      from pg_catalog.jsonb_array_elements(resolved->'days') with ordinality d(value, position);
    perform peppitness_private.write_workout_days(actor, new_version, program_days, true);

    -- 6. Pubblicazione con le regole correnti e ciclo completo o assente.
    update public.workout_plan_versions set status = 'published', published_at = now(), revision = revision + 1
      where id = new_version and owner_id = actor;
    update public.workout_plans set active_version_id = new_version,
        cycle_start = case when resolved->'cycle' = 'null'::jsonb then null else (resolved #>> '{cycle,start}')::date end,
        cycle_weeks = case when resolved->'cycle' = 'null'::jsonb then null else (resolved #>> '{cycle,weeks}')::smallint end,
        revision = revision + 1
      where id = new_plan and owner_id = actor;
  exception when unique_violation then
    -- ID concorrente confermato da un'altra transazione: nessun esito parziale.
    raise exception using errcode = 'PT409', message = 'Import request conflict';
  end;

  -- 7. Selezione esplicita (preserva la dieta), poi 8. ricevuta come ultima scrittura.
  selection := peppitness_private.apply_import_selection(actor, 'workout', new_plan, p_selection_options);
  select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('ref', b.value->'ref',
      'exerciseId', resolutions #> array[b.value->>'ref', 'exerciseId'],
      'resolution', resolutions #> array[b.value->>'ref', 'resolution']) order by b.position)
    into bindings from pg_catalog.jsonb_array_elements(resolved->'catalog') with ordinality b(value, position);
  return peppitness_private.finalize_import_receipt(actor, p_request_id, 'workout', command_hash, content_hash,
    new_plan, new_version, bindings, selection, p_provenance);
end;
$$;

-- Helper privati: nessun ruolo API li esegue. RPC solo per utenti autenticati.
do $$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'peppitness_private' and p.proname in ('import_require', 'import_keys', 'import_text', 'import_integer',
      'import_decimal', 'import_exercise_values', 'import_exercise_matches', 'import_check_provenance', 'import_workout_targets')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn.signature);
  end loop;
end;
$$;
revoke all on function public.commit_workout_import(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.commit_workout_import(uuid, jsonb, jsonb, jsonb) to authenticated;

comment on function public.commit_workout_import(uuid, jsonb, jsonb, jsonb) is
  'Import scheda atomico: programma pubblicato nuovo, catalogo, ciclo, selezione opzionale e ricevuta idempotente.';
