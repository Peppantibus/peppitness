-- Task 18. Ricevute idempotenti, impronte canoniche e primitive condivise dalle
-- RPC commit_workout_import / commit_diet_import (19/20), che NON sono qui.
--
-- Ordine dei lock di import ed eliminazione (19/20 lo riusano, senza inversioni):
--   1. richiesta import: claim_import_receipt -> advisory xact lock per (owner, requestId),
--      mai per tutto il progetto né per tutto l'account;
--   2. selezione, solo con follow: lock_import_selection -> riga active_plans FOR UPDATE;
--   3. programma: workout_plans / meal_plans (riga nuova, o FOR UPDATE se mai esistente);
--   4. versione: workout_plan_versions del programma;
--   5. catalogo: exercises dell'owner FOR UPDATE in ordine di id, template in ordine di id;
--   6. finalize_import_receipt: inserisce la ricevuta, ultima scrittura della transazione.
-- RPC esistenti compatibili: delete_*_plans selezione -> piani (-> tombstone ricevute);
-- save_workout_revision / publish / activate programma -> versione. Il tombstone aggiorna
-- solo ricevute già committed, mai la riga nuova di un import in corso.
-- Le funzioni devono girare in READ COMMITTED: la lettura dopo il lock vede il commit
-- dell'altra transazione. Nessuna ricevuta "pending": claim non scrive, un rollback
-- finale annulla ricevuta e figli insieme.

-- ---------------------------------------------------------------------------
-- peppitness.canonical-json.v1 (tests/fixtures/import/contracts/README.md)
-- ---------------------------------------------------------------------------
-- Nodo ricorsivo: invocato SOLO da canonical_json, che fissa extra_float_digits una volta.
create function peppitness_private.canonical_json_node(p_value jsonb, p_depth integer) returns text
language plpgsql immutable security invoker set search_path = '' as $$
declare
  value_type text := pg_catalog.jsonb_typeof(p_value);
  result text;
begin
  if p_value is null or p_depth is null then
    raise exception using errcode = '22023', message = 'Invalid canonical JSON';
  end if;
  if value_type in ('object', 'array') and p_depth >= 64 then
    raise exception using errcode = '22023', message = 'Canonical JSON too deep';
  end if;
  if value_type = 'object' then
    select '{' || coalesce(string_agg(pg_catalog.to_jsonb(e.key)::text || ':' || peppitness_private.canonical_json_node(e.value, p_depth + 1),
      ',' order by e.key collate "C"), '') || '}' into result from pg_catalog.jsonb_each(p_value) e;
  elsif value_type = 'array' then
    select '[' || coalesce(string_agg(peppitness_private.canonical_json_node(e.value, p_depth + 1), ',' order by e.position), '') || ']'
      into result from pg_catalog.jsonb_array_elements(p_value) with ordinality as e(value, position);
  elsif value_type = 'number' then
    -- Passaggio da float8 = arrotondamento IEEE-754 del client; extra_float_digits=1 = forma più corta.
    result := pg_catalog.trim_scale(((p_value #>> '{}')::float8)::text::numeric)::text;
  else
    result := p_value::text; -- string (escape_json), boolean, null
  end if;
  return result;
end;
$$;

create function peppitness_private.canonical_json(p_value jsonb) returns text
language sql immutable security invoker set search_path = '' set extra_float_digits = 1 as $$
  select peppitness_private.canonical_json_node(p_value, 0);
$$;

create function peppitness_private.canonical_hash(p_value jsonb) returns text
language sql immutable security invoker set search_path = '' as $$
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(peppitness_private.canonical_json(p_value), 'UTF8')), 'hex');
$$;

-- Membro obbligatorio: una chiave assente NON diventa null (in TypeScript sarebbe undefined -> errore).
create function peppitness_private.import_member(p_object jsonb, p_key text) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
begin
  if pg_catalog.jsonb_typeof(p_object) is distinct from 'object' or not (p_object ? p_key) then
    raise exception using errcode = '22023', message = 'Invalid import command';
  end if;
  return p_object -> p_key;
end;
$$;

-- Ingresso di commandHash: esattamente i quattro argomenti ricevuti dalla RPC, mai un digest del client.
create function peppitness_private.import_command_hash(p_request_id uuid, p_payload jsonb, p_provenance jsonb, p_selection_options jsonb)
returns text language plpgsql immutable security invoker set search_path = '' as $$
begin
  if p_request_id is null or p_payload is null or p_provenance is null or p_selection_options is null then
    raise exception using errcode = '22023', message = 'Invalid import command';
  end if;
  return peppitness_private.canonical_hash(pg_catalog.jsonb_build_object('hash', 'peppitness.command-hash.v1',
    'requestId', p_request_id, 'payload', p_payload, 'provenance', p_provenance, 'selectionOptions', p_selection_options));
end;
$$;

-- Identità significativa dell'esercizio (exerciseChoiceValues): nessun ID, fonte, revisione o nota.
create function peppitness_private.import_exercise_identity(p_choice jsonb) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare choice_values jsonb;
begin
  if pg_catalog.jsonb_typeof(p_choice) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Invalid import command';
  end if;
  choice_values := peppitness_private.import_member(p_choice, case when p_choice->>'source' = 'new' then 'values' else 'seen' end);
  return pg_catalog.jsonb_build_object('name', peppitness_private.import_member(choice_values, 'name'),
    'variant', peppitness_private.import_member(choice_values, 'variant'),
    'equipment', peppitness_private.import_member(choice_values, 'equipment'),
    'loadConvention', peppitness_private.import_member(choice_values, 'loadConvention'),
    'loadUnit', peppitness_private.import_member(choice_values, 'loadUnit'),
    'measurementMode', peppitness_private.import_member(choice_values, 'measurementMode'),
    'perSide', peppitness_private.import_member(choice_values, 'perSide'));
end;
$$;

-- Equivalente di contentHashInput (src/import/mapping/canonical.ts): senza UUID tecnici,
-- ref, provenienza, opzioni o metadati; ordine e valori inclusi.
create function peppitness_private.import_content_hash_input(p_payload jsonb) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare
  payload_kind jsonb := peppitness_private.import_member(p_payload, 'kind');
  resolved jsonb := peppitness_private.import_member(p_payload, 'resolved');
  plan jsonb; plan_document jsonb; content jsonb; choices jsonb;
begin
  if payload_kind = '"workout"'::jsonb then
    if pg_catalog.jsonb_typeof(peppitness_private.import_member(resolved, 'days')) is distinct from 'array'
      or pg_catalog.jsonb_typeof(peppitness_private.import_member(resolved, 'catalog')) is distinct from 'array'
      or exists (select 1 from pg_catalog.jsonb_array_elements(resolved -> 'catalog') b(binding)
        where pg_catalog.jsonb_typeof(b.binding -> 'ref') is distinct from 'string') then
      raise exception using errcode = '22023', message = 'Invalid import command';
    end if;
    -- Come new Map(catalog): ref -> choice, a parità di ref vince l'ultima associazione.
    select pg_catalog.jsonb_object_agg(b.binding ->> 'ref', b.binding -> 'choice' order by b.position) into choices
      from pg_catalog.jsonb_array_elements(resolved -> 'catalog') with ordinality as b(binding, position);
    content := pg_catalog.jsonb_build_object('title', peppitness_private.import_member(resolved, 'title'),
      'guidance', peppitness_private.import_member(resolved, 'guidance'),
      'cycle', peppitness_private.import_member(resolved, 'cycle'),
      'days', coalesce((select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'label', peppitness_private.import_member(d.day, 'label'),
          'title', peppitness_private.import_member(d.day, 'title'),
          'note', peppitness_private.import_member(d.day, 'note'),
          'prescriptions', coalesce((select pg_catalog.jsonb_agg(
              -- { exercise, ...values }: i valori della prescrizione restano a destra.
              pg_catalog.jsonb_build_object('exercise', peppitness_private.import_exercise_identity(
                coalesce(choices, '{}'::jsonb) -> (peppitness_private.import_member(p.prescription, 'exerciseRef') #>> '{}')))
              || (p.prescription - 'id' - 'exerciseRef') order by p.position)
            from pg_catalog.jsonb_array_elements(peppitness_private.import_member(d.day, 'prescriptions')) with ordinality as p(prescription, position)),
            '[]'::jsonb)) order by d.position)
        from pg_catalog.jsonb_array_elements(resolved -> 'days') with ordinality as d(day, position)), '[]'::jsonb));
  elsif payload_kind = '"diet"'::jsonb then
    plan := peppitness_private.import_member(resolved, 'plan');
    plan_document := peppitness_private.import_member(plan, 'document');
    if pg_catalog.jsonb_typeof(peppitness_private.import_member(plan_document, 'days')) is distinct from 'array' then
      raise exception using errcode = '22023', message = 'Invalid import command';
    end if;
    content := pg_catalog.jsonb_build_object('name', peppitness_private.import_member(plan, 'name'),
      'guidance', peppitness_private.import_member(plan_document, 'guidance'),
      'days', coalesce((select pg_catalog.jsonb_agg(
          (d.day - 'id' - 'meals') || pg_catalog.jsonb_build_object('meals', coalesce((select pg_catalog.jsonb_agg(m.meal - 'id' order by m.position)
            from pg_catalog.jsonb_array_elements(peppitness_private.import_member(d.day, 'meals')) with ordinality as m(meal, position)), '[]'::jsonb))
          order by d.position)
        from pg_catalog.jsonb_array_elements(plan_document -> 'days') with ordinality as d(day, position)), '[]'::jsonb));
  else
    raise exception using errcode = '22023', message = 'Invalid import command';
  end if;
  return pg_catalog.jsonb_build_object('hash', 'peppitness.content-hash.v1', 'kind', payload_kind, 'content', content);
end;
$$;

create function peppitness_private.import_content_hash(p_payload jsonb) returns text
language sql immutable security invoker set search_path = '' as $$
  select peppitness_private.canonical_hash(peppitness_private.import_content_hash_input(p_payload));
$$;

-- ---------------------------------------------------------------------------
-- Ricevute: una per (owner, requestId), per la vita dell'account.
-- ---------------------------------------------------------------------------
create table public.import_receipts (
  owner_id uuid not null references auth.users(id) on delete cascade,
  request_id uuid not null,
  kind text not null check (kind in ('workout', 'diet')),
  command_hash text not null check (command_hash ~ '^[0-9a-f]{64}$'),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  command_hash_version text not null default 'peppitness.command-hash.v1' check (command_hash_version = 'peppitness.command-hash.v1'),
  content_hash_version text not null default 'peppitness.content-hash.v1' check (content_hash_version = 'peppitness.content-hash.v1'),
  result_state text not null default 'committed' check (result_state in ('committed', 'deleted')),
  -- Nessuna FK verso i piani: l'eliminazione del piano non deve cancellare la ricevuta.
  plan_id uuid not null,
  version_id uuid,
  exercise_bindings jsonb not null default '[]' check (jsonb_typeof(exercise_bindings) = 'array'),
  selection jsonb check (selection is null or jsonb_typeof(selection) = 'object'),
  -- Provenienza essenziale, separata dalle tabelle del dominio; rimossa dal tombstone.
  provenance jsonb check (provenance is null or jsonb_typeof(provenance) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz,
  primary key (owner_id, request_id),
  check ((kind = 'workout') = (version_id is not null)),
  check (kind = 'workout' or exercise_bindings = '[]'::jsonb),
  check ((result_state = 'deleted') = (deleted_at is not null)),
  check ((result_state = 'committed') = (provenance is not null))
);
-- Nessun unique su contentHash: una copia voluta è lecita. Un solo risultato vivo per piano.
create unique index import_receipts_live_plan on public.import_receipts(owner_id, kind, plan_id) where result_state = 'committed';
create index import_receipts_content on public.import_receipts(owner_id, kind, content_hash);

alter table public.import_receipts enable row level security;
revoke all on public.import_receipts from public, anon, authenticated, service_role;
grant select on public.import_receipts to authenticated;
create policy import_receipts_read_own on public.import_receipts for select to authenticated
  using (owner_id = (select auth.uid()));

-- SECURITY DEFINER: la cascata dell'account gira sotto il ruolo Auth, che non vede le tabelle.
create function peppitness_private.guard_import_receipt() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'DELETE' then
    -- Solo la cancellazione dell'account (cascata) rimuove ricevute e tombstone; mai un TTL.
    if exists (select 1 from auth.users where id = OLD.owner_id) then
      raise exception using errcode = '55000', message = 'Import receipts are kept for the account lifetime';
    end if;
    return OLD;
  end if;
  if row(NEW.owner_id, NEW.request_id, NEW.kind, NEW.command_hash, NEW.content_hash, NEW.command_hash_version,
      NEW.content_hash_version, NEW.plan_id, NEW.version_id, NEW.exercise_bindings, NEW.selection, NEW.created_at)
    is distinct from row(OLD.owner_id, OLD.request_id, OLD.kind, OLD.command_hash, OLD.content_hash, OLD.command_hash_version,
      OLD.content_hash_version, OLD.plan_id, OLD.version_id, OLD.exercise_bindings, OLD.selection, OLD.created_at)
    or not (OLD.result_state = 'committed' and NEW.result_state = 'deleted' and NEW.provenance is null and NEW.deleted_at is not null) then
    raise exception using errcode = '23514', message = 'Import receipt is immutable';
  end if;
  NEW.updated_at := pg_catalog.clock_timestamp();
  return NEW;
end;
$$;
create trigger import_receipts_guard before update or delete on public.import_receipts
  for each row execute function peppitness_private.guard_import_receipt();

-- Al commit una ricevuta committed indica un piano realmente esistente (e la sua versione pubblicata).
create function peppitness_private.check_import_receipt() returns trigger
language plpgsql security definer set search_path = '' as $$
declare r public.import_receipts;
begin
  select * into r from public.import_receipts where owner_id = NEW.owner_id and request_id = NEW.request_id;
  if not FOUND or r.result_state <> 'committed' then return null; end if;
  if (r.kind = 'workout' and not exists (select 1 from public.workout_plans p join public.workout_plan_versions v
        on v.owner_id = p.owner_id and v.plan_id = p.id
      where p.owner_id = r.owner_id and p.id = r.plan_id and v.id = r.version_id and v.status = 'published'))
    or (r.kind = 'diet' and not exists (select 1 from public.meal_plans m where m.owner_id = r.owner_id and m.id = r.plan_id)) then
    raise exception using errcode = '23514', message = 'Import receipt needs its committed plan';
  end if;
  return null;
end;
$$;
create constraint trigger import_receipts_committed_plan after insert or update on public.import_receipts
  deferrable initially deferred for each row execute function peppitness_private.check_import_receipt();

-- Tombstone su QUALSIASI percorso di eliminazione del piano (RPC singola/tutti, cascata,
-- operazioni server): il vecchio retry riceve 'deleted' e non ricrea il piano.
create function peppitness_private.tombstone_import_receipts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.import_receipts r set result_state = 'deleted', deleted_at = pg_catalog.clock_timestamp(), provenance = null
    from deleted_plans d
    where r.owner_id = d.owner_id and r.plan_id = d.id and r.kind = TG_ARGV[0] and r.result_state = 'committed';
  return null;
end;
$$;
create trigger import_receipts_tombstone after delete on public.workout_plans
  referencing old table as deleted_plans for each statement execute function peppitness_private.tombstone_import_receipts('workout');
create trigger import_receipts_tombstone after delete on public.meal_plans
  referencing old table as deleted_plans for each statement execute function peppitness_private.tombstone_import_receipts('diet');

-- ---------------------------------------------------------------------------
-- Lookup / claim / finalize
-- ---------------------------------------------------------------------------
create function peppitness_private.import_receipt_result(r public.import_receipts) returns jsonb
language sql stable security invoker set search_path = '' as $$
  -- ImportReceipt: nessun owner, nessuna provenienza.
  select pg_catalog.jsonb_build_object('requestId', r.request_id, 'kind', r.kind, 'commandHash', r.command_hash,
    'contentHash', r.content_hash, 'resultState', r.result_state, 'planId', r.plan_id, 'versionId', r.version_id,
    'exerciseBindings', r.exercise_bindings, 'selection', r.selection);
$$;

create function peppitness_private.import_request_lock_key(p_owner_id uuid, p_request_id uuid) returns bigint
language sql immutable security invoker set search_path = '' as $$
  select pg_catalog.hashtextextended('peppitness.import.request:' || p_owner_id::text || ':' || p_request_id::text, 0);
$$;

-- Livello 1 dell'ordine dei lock. null = richiesta nuova, riservata a questa transazione
-- fino a commit/rollback; ricevuta = replay (committed o deleted) da restituire così com'è.
create function peppitness_private.claim_import_receipt(p_owner_id uuid, p_request_id uuid, p_kind text, p_command_hash text)
returns jsonb language plpgsql volatile security invoker set search_path = '' as $$
declare r public.import_receipts;
begin
  if p_owner_id is null or p_request_id is null or p_kind is null or p_kind not in ('workout', 'diet')
    or p_command_hash is null or p_command_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Invalid import command';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(peppitness_private.import_request_lock_key(p_owner_id, p_request_id));
  select * into r from public.import_receipts where owner_id = p_owner_id and request_id = p_request_id;
  if not FOUND then return null; end if;
  if r.kind <> p_kind or r.command_hash <> p_command_hash then
    raise exception using errcode = 'PT409', message = 'Import request conflict';
  end if;
  return peppitness_private.import_receipt_result(r);
end;
$$;

create function peppitness_private.import_uuid_text(p_value jsonb) returns boolean
language sql immutable security invoker set search_path = '' as $$
  select pg_catalog.jsonb_typeof(p_value) = 'string'
    and (p_value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

-- Ultima scrittura della RPC, nella stessa transazione del claim e dei figli.
create function peppitness_private.finalize_import_receipt(p_owner_id uuid, p_request_id uuid, p_kind text,
  p_command_hash text, p_content_hash text, p_plan_id uuid, p_version_id uuid,
  p_exercise_bindings jsonb, p_selection jsonb, p_provenance jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  r public.import_receipts;
  lock_key bigint;
  binding jsonb;
  refs text[] := '{}';
  section uuid;
begin
  if p_owner_id is null or p_request_id is null or p_kind is null or p_kind not in ('workout', 'diet')
    or p_command_hash is null or p_command_hash !~ '^[0-9a-f]{64}$' or p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$'
    or p_plan_id is null or (p_kind = 'workout') <> (p_version_id is not null)
    or pg_catalog.jsonb_typeof(p_exercise_bindings) is distinct from 'array'
    or (p_kind = 'workout') <> (pg_catalog.jsonb_array_length(p_exercise_bindings) > 0)
    or pg_catalog.jsonb_typeof(p_provenance) is distinct from 'object'
    or p_provenance->>'formatVersion' is distinct from 'peppitness.import-provenance.v1'
    or p_provenance->>'kind' is distinct from p_kind then
    raise exception using errcode = '22023', message = 'Invalid import receipt';
  end if;
  lock_key := peppitness_private.import_request_lock_key(p_owner_id, p_request_id);
  if not exists (select 1 from pg_catalog.pg_locks l where l.locktype = 'advisory' and l.pid = pg_catalog.pg_backend_pid() and l.granted
      and l.database = (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database())
      and l.classid = ((lock_key >> 32) & 4294967295)::oid and l.objid = (lock_key & 4294967295)::oid and l.objsubid = 1) then
    raise exception using errcode = '55000', message = 'Import request not claimed';
  end if;
  for binding in select value from pg_catalog.jsonb_array_elements(p_exercise_bindings) loop
    if pg_catalog.jsonb_typeof(binding) is distinct from 'object'
      or binding - array['ref', 'exerciseId', 'resolution'] <> '{}'::jsonb
      or not peppitness_private.import_uuid_text(binding->'ref') or not peppitness_private.import_uuid_text(binding->'exerciseId')
      or binding->>'resolution' is null or binding->>'resolution' not in ('existing', 'adopted', 'already_adopted', 'created')
      or (binding->>'resolution' = 'existing') <> (binding->>'ref' = binding->>'exerciseId')
      or binding->>'ref' = any(refs) then
      raise exception using errcode = '22023', message = 'Invalid import receipt';
    end if;
    refs := refs || (binding->>'ref');
    if not exists (select 1 from public.exercises where owner_id = p_owner_id and id = (binding->>'exerciseId')::uuid) then
      raise exception using errcode = '42501', message = 'Import reference not available';
    end if;
  end loop;
  if p_selection is not null then
    if pg_catalog.jsonb_typeof(p_selection) is distinct from 'object'
      or p_selection - array['revision', 'workoutPlanId', 'mealPlanId'] <> '{}'::jsonb
      or not (p_selection ?& array['revision', 'workoutPlanId', 'mealPlanId'])
      or pg_catalog.jsonb_typeof(p_selection->'revision') is distinct from 'number'
      or (p_selection->>'revision') !~ '^[1-9][0-9]{0,8}$'
      or not (p_selection->'workoutPlanId' = 'null'::jsonb or peppitness_private.import_uuid_text(p_selection->'workoutPlanId'))
      or not (p_selection->'mealPlanId' = 'null'::jsonb or peppitness_private.import_uuid_text(p_selection->'mealPlanId')) then
      raise exception using errcode = '22023', message = 'Invalid import receipt';
    end if;
    section := (p_selection->>(case p_kind when 'workout' then 'workoutPlanId' else 'mealPlanId' end))::uuid;
    if section is distinct from p_plan_id then
      raise exception using errcode = '22023', message = 'Invalid import receipt';
    end if;
  end if;
  if (p_kind = 'workout' and not exists (select 1 from public.workout_plan_versions v
        where v.owner_id = p_owner_id and v.plan_id = p_plan_id and v.id = p_version_id and v.status = 'published'))
    or (p_kind = 'diet' and not exists (select 1 from public.meal_plans where owner_id = p_owner_id and id = p_plan_id)) then
    raise exception using errcode = '23514', message = 'Import receipt needs its committed plan';
  end if;
  begin
    insert into public.import_receipts(owner_id, request_id, kind, command_hash, content_hash, plan_id, version_id,
      exercise_bindings, selection, provenance)
    values (p_owner_id, p_request_id, p_kind, p_command_hash, p_content_hash, p_plan_id, p_version_id,
      p_exercise_bindings, p_selection, p_provenance)
    returning * into r;
  exception when unique_violation then
    raise exception using errcode = 'PT409', message = 'Import request conflict';
  end;
  return peppitness_private.import_receipt_result(r);
end;
$$;

-- ---------------------------------------------------------------------------
-- Selezione esplicita (follow). follow=false non tocca active_plans.
-- ---------------------------------------------------------------------------
create function peppitness_private.import_follow(p_options jsonb) returns boolean
language plpgsql immutable security invoker set search_path = '' as $$
begin
  if pg_catalog.jsonb_typeof(p_options) is distinct from 'object'
    or not (p_options ?& array['follow', 'expectedActiveRevision'])
    or p_options - array['follow', 'expectedActiveRevision'] <> '{}'::jsonb
    or pg_catalog.jsonb_typeof(p_options->'follow') is distinct from 'boolean'
    or not (p_options->'expectedActiveRevision' = 'null'::jsonb
      or (pg_catalog.jsonb_typeof(p_options->'expectedActiveRevision') = 'number'
        and (p_options->>'expectedActiveRevision') ~ '^[1-9][0-9]{0,8}$'))
    or ((p_options->'follow') = 'false'::jsonb and p_options->'expectedActiveRevision' <> 'null'::jsonb) then
    raise exception using errcode = '22023', message = 'Invalid import command';
  end if;
  return (p_options->>'follow')::boolean;
end;
$$;

-- Livello 2: blocca la riga esistente e verifica subito la revisione vista. L'assenza non
-- si blocca: la crea apply_import_selection e un inserimento concorrente diventa conflitto.
create function peppitness_private.lock_import_selection(p_owner_id uuid, p_options jsonb) returns boolean
language plpgsql volatile security invoker set search_path = '' as $$
declare current_revision integer; expected integer;
begin
  if not peppitness_private.import_follow(p_options) then return false; end if;
  expected := (p_options->>'expectedActiveRevision')::integer;
  select revision into current_revision from public.active_plans where owner_id = p_owner_id for update;
  if current_revision is distinct from expected then
    raise exception using errcode = 'PT409', message = 'Active selection conflict';
  end if;
  return true;
end;
$$;

-- Dopo la pubblicazione del piano: aggiorna SOLO la sezione del dominio, revisione +1 una volta.
create function peppitness_private.apply_import_selection(p_owner_id uuid, p_kind text, p_plan_id uuid, p_options jsonb) returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare selected public.active_plans; expected integer;
begin
  if p_owner_id is null or p_plan_id is null or p_kind is null or p_kind not in ('workout', 'diet') then
    raise exception using errcode = '22023', message = 'Invalid import command';
  end if;
  if not peppitness_private.import_follow(p_options) then return null; end if;
  expected := (p_options->>'expectedActiveRevision')::integer;
  select * into selected from public.active_plans where owner_id = p_owner_id for update;
  if FOUND then
    if selected.revision is distinct from expected then
      raise exception using errcode = 'PT409', message = 'Active selection conflict';
    end if;
    if p_kind = 'workout' then
      update public.active_plans set workout_plan_id = p_plan_id, revision = revision + 1
        where owner_id = p_owner_id returning * into selected;
    else
      update public.active_plans set meal_plan_id = p_plan_id, revision = revision + 1
        where owner_id = p_owner_id returning * into selected;
    end if;
  else
    if expected is not null then
      raise exception using errcode = 'PT409', message = 'Active selection conflict';
    end if;
    if p_kind = 'workout' then
      insert into public.active_plans(owner_id, workout_plan_id) values (p_owner_id, p_plan_id)
        on conflict (owner_id) do nothing returning * into selected;
    else
      insert into public.active_plans(owner_id, meal_plan_id) values (p_owner_id, p_plan_id)
        on conflict (owner_id) do nothing returning * into selected;
    end if;
    -- Un'altra sessione ha creato la selezione nel frattempo: mai sovrascriverla.
    if not FOUND then raise exception using errcode = 'PT409', message = 'Active selection conflict'; end if;
  end if;
  return pg_catalog.jsonb_build_object('revision', selected.revision,
    'workoutPlanId', selected.workout_plan_id, 'mealPlanId', selected.meal_plan_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Lettura pubblica: solo ricevute proprie, 'deleted' esplicito, null se assente.
-- SECURITY DEFINER per usare il formato privato; owner solo da auth.uid().
-- ---------------------------------------------------------------------------
create function public.get_import_receipt(p_request_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare actor uuid := auth.uid(); r public.import_receipts;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  select * into r from public.import_receipts where owner_id = actor and request_id = p_request_id;
  if not FOUND then return null; end if;
  return peppitness_private.import_receipt_result(r);
end;
$$;

-- Helper privati: nessun ruolo API li esegue; solo le RPC SECURITY DEFINER di 19/20.
do $$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature, n.nspname, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'peppitness_private' and p.proname in ('canonical_json_node', 'canonical_json', 'canonical_hash', 'import_member',
      'import_command_hash', 'import_exercise_identity', 'import_content_hash_input', 'import_content_hash',
      'guard_import_receipt', 'check_import_receipt', 'tombstone_import_receipts', 'import_receipt_result',
      'import_request_lock_key', 'claim_import_receipt', 'import_uuid_text', 'finalize_import_receipt',
      'import_follow', 'lock_import_selection', 'apply_import_selection'))
      or (n.nspname = 'public' and p.proname = 'get_import_receipt')
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn.signature);
    if fn.nspname = 'public' then execute format('grant execute on function %s to authenticated', fn.signature); end if;
  end loop;
end;
$$;

comment on table public.import_receipts is
  'Ricevute import idempotenti per (owner, request_id); tombstone deleted alla cancellazione del piano, rimosse solo con l''account.';
