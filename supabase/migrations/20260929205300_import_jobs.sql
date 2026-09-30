-- Task 14. Stato durevole di una richiesta sincrona, NON una coda/worker.
-- Solo le API server sotto service_role mutano jobs/drafts; nessun grant sullo
-- schema privato, nessun piano/esercizio/diario e nessuna chiamata provider.
-- I digest sono calcolati da _shared/import/jobs.ts dopo autenticazione e
-- validazione. Non certificano i byte originali rimasti sul dispositivo.

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  analysis_request_id uuid not null,
  kind text not null check (kind in ('workout', 'diet')),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  normalized_hash text not null check (normalized_hash ~ '^[0-9a-f]{64}$'),
  versions jsonb not null check ((jsonb_typeof(versions) = 'object'
    and versions ?& array['reader','schema','prompt','provider','model','rules']
    and versions - array['reader','schema','prompt','provider','model','rules'] = '{}'
    and versions->>'schema' = '1.0') is true),
  status text not null default 'running' check (status in ('running','ready','failed','expired')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  provider_outcome text not null default 'not_started'
    check (provider_outcome in ('not_started','in_flight','known_failure','uncertain','completed','cache_hit')),
  lease_token uuid,
  lease_expires_at timestamptz,
  safe_error jsonb,
  usage_summary jsonb not null default '{"providerCalls":0,"inputTokens":null,"outputTokens":null,"reasoningTokens":null,"cached":false,"costEstimate":null}',
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp() + interval '7 days'),
  unique (owner_id, id),
  unique (owner_id, analysis_request_id),
  check ((status = 'failed') = (safe_error is not null)),
  check ((lease_token is null) = (lease_expires_at is null)),
  check (status <> 'running' or lease_token is not null),
  check (status <> 'ready' or provider_outcome in ('completed','cache_hit'))
);
-- Cache non unique: identica fonte con domini/versioni/account diversi è lecita.
create index import_jobs_cache_idx on public.import_jobs(owner_id, kind, normalized_hash)
  where status = 'ready';
create index import_jobs_expiry_idx on public.import_jobs(expires_at) where status <> 'expired';

create table public.import_drafts (
  job_id uuid primary key,
  owner_id uuid not null,
  normalized_document jsonb not null check (jsonb_typeof(normalized_document) = 'object'),
  extraction jsonb check (jsonb_typeof(extraction) = 'object'),
  validation_issues jsonb not null default '[]' check (jsonb_typeof(validation_issues) = 'array'),
  schema_version text not null check (schema_version = '1.0'),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  foreign key (owner_id, job_id) references public.import_jobs(owner_id, id) on delete cascade,
  check (extraction is not null or validation_issues = '[]')
);

alter table public.import_jobs enable row level security;
alter table public.import_drafts enable row level security;
revoke all on public.import_jobs, public.import_drafts from public, anon, authenticated, service_role;
-- Il browser può recuperare il documento e l'estrazione immutabile, mai la lease.
grant select (id, owner_id, analysis_request_id, kind, status, attempt_count,
  safe_error, usage_summary, revision, created_at, updated_at, expires_at)
  on public.import_jobs to authenticated;
grant select on public.import_drafts to authenticated;
create policy import_jobs_read_own on public.import_jobs for select to authenticated
  using (owner_id = (select auth.uid()) and expires_at > statement_timestamp() and status <> 'expired');
create policy import_drafts_read_own on public.import_drafts for select to authenticated
  using (owner_id = (select auth.uid()) and expires_at > statement_timestamp());

create trigger import_jobs_stamp before insert or update on public.import_jobs
  for each row execute function peppitness_private.stamp_record();
create trigger import_drafts_stamp before insert or update on public.import_drafts
  for each row execute function peppitness_private.stamp_record();

create function peppitness_private.guard_import_content() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if TG_TABLE_NAME = 'import_jobs' then
    if row(NEW.id, NEW.owner_id, NEW.analysis_request_id, NEW.kind, NEW.input_hash, NEW.normalized_hash, NEW.versions)
      is distinct from row(OLD.id, OLD.owner_id, OLD.analysis_request_id, OLD.kind, OLD.input_hash, OLD.normalized_hash, OLD.versions) then
      raise exception using errcode = '23514', message = 'Import identity is immutable';
    end if;
  else
    if row(NEW.job_id, NEW.owner_id, NEW.normalized_document, NEW.schema_version)
      is distinct from row(OLD.job_id, OLD.owner_id, OLD.normalized_document, OLD.schema_version)
      or (OLD.extraction is not null and row(NEW.extraction, NEW.validation_issues) is distinct from row(OLD.extraction, OLD.validation_issues)) then
      raise exception using errcode = '23514', message = 'Import content is immutable';
    end if;
  end if;
  return NEW;
end;
$$;
create trigger import_jobs_identity before update on public.import_jobs
  for each row execute function peppitness_private.guard_import_content();
create trigger import_drafts_immutable before update on public.import_drafts
  for each row execute function peppitness_private.guard_import_content();

-- Anche una futura API deve pubblicare risultato + ready nella STESSA transazione.
create function peppitness_private.check_import_result() returns trigger
language plpgsql security definer set search_path = '' as $$
declare j public.import_jobs; d public.import_drafts; target uuid;
begin
  if TG_TABLE_NAME = 'import_jobs' then target := coalesce(NEW.id, OLD.id);
  else target := coalesce(NEW.job_id, OLD.job_id); end if;
  select * into j from public.import_jobs where id = target;
  if not FOUND then return null; end if; -- cascata account/job
  select * into d from public.import_drafts where job_id = target and owner_id = j.owner_id;
  if (j.status = 'expired' and FOUND) or (j.status <> 'expired' and not FOUND)
    or ((j.status = 'ready') is distinct from (d.extraction is not null))
    or (j.status <> 'expired' and d.expires_at is distinct from j.expires_at)
    or (d.extraction is not null and (d.extraction->>'kind' is distinct from j.kind
      or d.extraction->>'schemaVersion' is distinct from d.schema_version)) then
    raise exception using errcode = '23514', message = 'Import result and state must be atomic';
  end if;
  return null;
end;
$$;
create constraint trigger import_jobs_result after insert or update or delete on public.import_jobs
  deferrable initially deferred for each row execute function peppitness_private.check_import_result();
create constraint trigger import_drafts_result after insert or update or delete on public.import_drafts
  deferrable initially deferred for each row execute function peppitness_private.check_import_result();

create function peppitness_private.require_import_server() returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'Import server required';
  end if;
end;
$$;

create function peppitness_private.import_job_result(j public.import_jobs) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare d public.import_drafts; effective_status text := j.status;
begin
  if j.expires_at <= statement_timestamp() then effective_status := 'expired'; end if;
  if effective_status = 'ready' then
    select * into strict d from public.import_drafts where owner_id = j.owner_id and job_id = j.id;
  end if;
  return jsonb_build_object('jobId', j.id, 'analysisRequestId', j.analysis_request_id,
    'kind', j.kind, 'status', effective_status, 'extraction', d.extraction,
    'validationIssues', coalesce(d.validation_issues, '[]'::jsonb), 'usageSummary', j.usage_summary,
    'error', case when effective_status = 'failed' then j.safe_error else null end,
    'expiresAt', to_char(j.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;

create function peppitness_private.import_server_result(j public.import_jobs, created boolean default false) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object('job', peppitness_private.import_job_result(j), 'revision', j.revision,
    'draftRevision', (select revision from public.import_drafts where owner_id = j.owner_id and job_id = j.id),
    'leaseToken', j.lease_token, 'leaseExpiresAt', j.lease_expires_at,
    'attemptCount', j.attempt_count, 'providerOutcome', j.provider_outcome, 'created', created);
$$;

-- SECURITY DEFINER necessario: il ruolo server NON ha DML sulle tabelle.
-- Tutte le mutazioni usano (owner,id), poi lock job -> draft; PT409, mai 40001.
create function peppitness_private.lock_import_job(p_owner_id uuid, p_job_id uuid, p_expected_revision integer)
returns public.import_jobs language plpgsql security invoker set search_path = '' as $$
declare j public.import_jobs;
begin
  perform peppitness_private.require_import_server();
  select * into j from public.import_jobs where owner_id = p_owner_id and id = p_job_id for update;
  if not FOUND then raise exception using errcode = '42501', message = 'Import job not available'; end if;
  if j.revision is distinct from p_expected_revision then
    raise exception using errcode = 'PT409', message = 'Import revision conflict';
  end if;
  return j;
end;
$$;

create function public.get_import_job(p_job_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare j public.import_jobs; actor uuid := auth.uid();
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  select * into j from public.import_jobs where owner_id = actor and id = p_job_id;
  if not FOUND then return null; end if;
  return peppitness_private.import_job_result(j);
end;
$$;

create function public.find_import_job(p_owner_id uuid, p_request_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare j public.import_jobs;
begin
  perform peppitness_private.require_import_server();
  select * into j from public.import_jobs where owner_id = p_owner_id and analysis_request_id = p_request_id;
  if not FOUND then return null; end if;
  return peppitness_private.import_server_result(j);
end;
$$;

create function public.create_import_job(p_owner_id uuid, p_request_id uuid, p_kind text,
  p_input_hash text, p_normalized_hash text, p_versions jsonb, p_document jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.import_jobs; cached public.import_drafts; new_id uuid; v text;
begin
  perform peppitness_private.require_import_server();
  if p_owner_id is null or p_request_id is null or p_kind is null or p_kind not in ('workout','diet')
    or p_input_hash is null or p_input_hash !~ '^[0-9a-f]{64}$'
    or p_normalized_hash is null or p_normalized_hash !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_versions) is distinct from 'object'
    or not (p_versions ?& array['reader','schema','prompt','provider','model','rules'])
    or p_versions - array['reader','schema','prompt','provider','model','rules'] <> '{}'
    or p_versions->>'schema' is distinct from '1.0'
    or jsonb_typeof(p_document) is distinct from 'object'
    or p_document->>'readerVersion' is distinct from p_versions->>'reader'
    or jsonb_typeof(p_document->'blocks') is distinct from 'array'
    or jsonb_typeof(p_document->'readingIssues') is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Invalid analysis input';
  end if;
  for v in select value from jsonb_each_text(p_versions) loop
    if v is null or v !~ '^[A-Za-z0-9][A-Za-z0-9._@/+:-]{0,199}$' then
      raise exception using errcode = '22023', message = 'Invalid analysis profile';
    end if;
  end loop;
  insert into public.import_jobs(owner_id, analysis_request_id, kind, input_hash, normalized_hash, versions, lease_token, lease_expires_at)
    values (p_owner_id, p_request_id, p_kind, p_input_hash, p_normalized_hash, p_versions, gen_random_uuid(), clock_timestamp() + interval '2 minutes')
    on conflict (owner_id, analysis_request_id) do nothing returning id into new_id;
  select * into strict j from public.import_jobs where owner_id = p_owner_id and analysis_request_id = p_request_id for update;
  if j.input_hash <> p_input_hash or j.normalized_hash <> p_normalized_hash or j.kind <> p_kind then
    raise exception using errcode = 'PT409', message = 'Import request conflict';
  end if;
  -- Profilo aggiornato non invalida l'idempotenza: il job conserva il suo profilo originale.
  if new_id is null then return peppitness_private.import_server_result(j); end if;
  select d.* into cached from public.import_jobs c join public.import_drafts d on d.job_id = c.id and d.owner_id = c.owner_id
    where c.owner_id = p_owner_id and c.kind = p_kind and c.normalized_hash = p_normalized_hash
      and c.versions = p_versions and c.status = 'ready' and c.expires_at > clock_timestamp()
      and d.expires_at > clock_timestamp() and d.normalized_document = p_document
    order by c.created_at desc, c.id limit 1;
  insert into public.import_drafts(job_id, owner_id, normalized_document, extraction, validation_issues, schema_version, expires_at)
    values (j.id, j.owner_id, p_document, cached.extraction, coalesce(cached.validation_issues, '[]'::jsonb), '1.0', j.expires_at);
  if cached.job_id is not null then
    update public.import_jobs set status = 'ready', provider_outcome = 'cache_hit', lease_token = null, lease_expires_at = null,
      usage_summary = jsonb_set(usage_summary, '{cached}', 'true'), revision = revision + 1
      where id = j.id and owner_id = j.owner_id returning * into j;
  end if;
  return peppitness_private.import_server_result(j, true);
end;
$$;

-- Primitiva interna per registrare UNA chiamata. Non è invocabile da service_role
-- né dal browser: il task 15 dovrà chiamarla nella transazione di prenotazione.
-- Nessuna riacquisizione implicita di lease, nessun retry o chiamata da questo task.
create function peppitness_private.record_import_attempt(p_owner_id uuid, p_job_id uuid, p_expected_revision integer, p_lease_token uuid)
returns public.import_jobs language plpgsql security invoker set search_path = '' as $$
declare j public.import_jobs;
begin
  j := peppitness_private.lock_import_job(p_owner_id, p_job_id, p_expected_revision);
  if j.status <> 'running' or j.provider_outcome <> 'not_started' or p_lease_token is null
    or j.lease_token is distinct from p_lease_token or j.lease_expires_at <= clock_timestamp() or j.expires_at <= clock_timestamp() then
    raise exception using errcode = 'PT409', message = 'Import lease conflict';
  end if;
  update public.import_jobs set attempt_count = attempt_count + 1, provider_outcome = 'in_flight',
    usage_summary = jsonb_set(usage_summary, '{providerCalls}', to_jsonb(attempt_count + 1)), revision = revision + 1
    where id = j.id and owner_id = j.owner_id returning * into j;
  return j;
end;
$$;

create function public.complete_import_job(p_owner_id uuid, p_job_id uuid, p_expected_revision integer,
  p_lease_token uuid, p_expected_draft_revision integer, p_result jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.import_jobs; expiry timestamptz := clock_timestamp() + interval '7 days';
begin
  j := peppitness_private.lock_import_job(p_owner_id, p_job_id, p_expected_revision);
  -- Risposta tardiva ammessa per la STESSA lease anche oltre i 2 minuti; mai oltre TTL.
  -- Esito incerto può diventare noto senza una nuova chiamata provider.
  if (j.status <> 'running' and not (j.status = 'failed' and j.provider_outcome = 'uncertain'))
    or p_lease_token is null or j.lease_token is distinct from p_lease_token or j.expires_at <= clock_timestamp() then
    raise exception using errcode = 'PT409', message = 'Import lease conflict';
  end if;
  if jsonb_typeof(p_result) is distinct from 'object' or p_result - array['extraction','validationIssues','usageSummary'] <> '{}'
    or jsonb_typeof(p_result->'extraction') is distinct from 'object'
    or p_result->'extraction'->>'kind' is distinct from j.kind
    or p_result->'extraction'->>'schemaVersion' is distinct from '1.0'
    or jsonb_typeof(p_result->'validationIssues') is distinct from 'array'
    or jsonb_typeof(p_result->'usageSummary') is distinct from 'object'
    or p_result->'usageSummary'->'providerCalls' is distinct from to_jsonb(j.attempt_count)
    or p_result->'usageSummary'->'cached' is distinct from 'false'::jsonb then
    raise exception using errcode = '22023', message = 'Invalid analysis result';
  end if;
  update public.import_drafts set extraction = p_result->'extraction', validation_issues = p_result->'validationIssues',
    expires_at = expiry, revision = revision + 1
    where owner_id = j.owner_id and job_id = j.id and revision = p_expected_draft_revision;
  if not FOUND then raise exception using errcode = 'PT409', message = 'Import draft revision conflict'; end if;
  update public.import_jobs set status = 'ready', safe_error = null, provider_outcome = 'completed',
    lease_token = null, lease_expires_at = null, usage_summary = p_result->'usageSummary',
    expires_at = expiry, revision = revision + 1 where owner_id = j.owner_id and id = j.id returning * into j;
  return peppitness_private.import_server_result(j);
end;
$$;

create function public.fail_import_job(p_owner_id uuid, p_job_id uuid, p_expected_revision integer, p_lease_token uuid, p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j public.import_jobs; uncertain boolean := p_code = 'provider_outcome_uncertain'; safe_message text;
begin
  j := peppitness_private.lock_import_job(p_owner_id, p_job_id, p_expected_revision);
  if j.status <> 'running' or p_lease_token is null or j.lease_token is distinct from p_lease_token or j.expires_at <= clock_timestamp() then
    raise exception using errcode = 'PT409', message = 'Import lease conflict';
  end if;
  safe_message := case p_code
    when 'provider_unavailable' then 'Servizio di analisi non disponibile.'
    when 'provider_refused' then 'Il servizio non ha analizzato il documento.'
    when 'provider_incomplete' then 'Analisi incompleta.'
    when 'provider_invalid_output' then 'Risultato non valido.'
    when 'provider_outcome_uncertain' then 'Esito della chiamata non ancora noto.'
    when 'internal' then 'Analisi non completata.' end;
  if safe_message is null then raise exception using errcode = '22023', message = 'Invalid analysis failure'; end if;
  update public.import_jobs set status = 'failed', provider_outcome = case when uncertain then 'uncertain' else 'known_failure' end,
    safe_error = jsonb_build_object('code', p_code, 'message', safe_message, 'retryable', false, 'limit', null),
    lease_token = case when uncertain then lease_token else null end,
    lease_expires_at = case when uncertain then lease_expires_at else null end,
    revision = revision + 1 where owner_id = j.owner_id and id = j.id returning * into j;
  return peppitness_private.import_server_result(j);
end;
$$;

create function public.touch_import_job(p_owner_id uuid, p_job_id uuid, p_expected_revision integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.import_jobs; expiry timestamptz := clock_timestamp() + interval '7 days';
begin
  j := peppitness_private.lock_import_job(p_owner_id, p_job_id, p_expected_revision);
  if j.status = 'expired' or j.expires_at <= clock_timestamp() then
    raise exception using errcode = 'PT409', message = 'Import content expired';
  end if;
  update public.import_drafts set expires_at = expiry, revision = revision + 1 where owner_id = j.owner_id and job_id = j.id;
  update public.import_jobs set expires_at = expiry, revision = revision + 1 where owner_id = j.owner_id and id = j.id returning * into j;
  return peppitness_private.import_server_result(j);
end;
$$;

create function public.expire_import_job(p_owner_id uuid, p_job_id uuid, p_expected_revision integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare j public.import_jobs;
begin
  j := peppitness_private.lock_import_job(p_owner_id, p_job_id, p_expected_revision);
  if j.status = 'expired' then return peppitness_private.import_server_result(j); end if;
  if j.expires_at > clock_timestamp() then raise exception using errcode = 'PT409', message = 'Import content not expired'; end if;
  delete from public.import_drafts where owner_id = j.owner_id and job_id = j.id;
  update public.import_jobs set status = 'expired', safe_error = null, lease_token = null, lease_expires_at = null,
    revision = revision + 1 where owner_id = j.owner_id and id = j.id returning * into j;
  -- attempt_count, usage e outcome incerto restano: scadenza contenuti NON è spesa zero.
  return peppitness_private.import_server_result(j);
end;
$$;

-- Revoche esplicite anche dei default PostgreSQL PUBLIC EXECUTE.
do $$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature, n.nspname, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'peppitness_private' and p.proname in
      ('guard_import_content','check_import_result','require_import_server','import_job_result','import_server_result','lock_import_job','record_import_attempt'))
      or (n.nspname = 'public' and p.proname in
      ('get_import_job','find_import_job','create_import_job','complete_import_job','fail_import_job','touch_import_job','expire_import_job'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn.signature);
    if fn.nspname = 'public' then
      execute format('grant execute on function %s to %I', fn.signature,
        case when fn.proname = 'get_import_job' then 'authenticated' else 'service_role' end);
    end if;
  end loop;
end;
$$;
