-- Task 23. Conservazione effettiva dei contenuti d'importazione (specifica §16.1): documento normalizzato,
-- estrazione e problemi (import_drafts) si cancellano davvero dopo 7 giorni di inattività, con un job
-- pianificato pg_cron verificabile; `expires_at` da solo non cancella nulla.
--
-- Politica dei cicli di vita (separati):
-- - import_drafts: contenuti testuali, eliminati alla scadenza (retention) o allo scarto esplicito dell'utente;
-- - import_jobs: restano solo metadati tecnici senza testo (ID, dominio, impronte, versioni, stato `expired`,
--   tentativi, esito provider, usage e tempi) per replay, budget e diagnosi; si eliminano con l'account;
-- - ledger (15): mai toccato dalla scadenza: riserve reserved/sent/uncertain restano contate, la
--   riconciliazione è `reconcile_import_usage`; la cascata dell'account conserva i totali anonimi;
-- - ricevute e tombstone (18): per la vita dell'account, mai toccati; il replay della ricevuta precede ogni
--   lettura del job nelle RPC 19/20, quindi un commit già riuscito resta recuperabile anche dopo la scadenza;
-- - nessun file originale su Storage: nessun bucket o URL firmata.
-- Privilegi: la manutenzione gira come proprietario (pg_cron, ruolo postgres) con funzioni private senza
-- EXECUTE per i ruoli API; scarto esplicito e rinnovo per attività sono RPC `authenticated` limitate ai job propri.
-- Lock: job (FOR UPDATE, SKIP LOCKED nella manutenzione) -> draft, come le API 14; nessun lock su piani o ricevute.

create extension if not exists pg_cron with schema pg_catalog;

-- Esiti delle esecuzioni: solo conteggi, tempi e SQLSTATE, mai testi o ID di account.
create table peppitness_private.import_retention_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz not null default clock_timestamp(),
  status text not null check (status in ('succeeded', 'failed')),
  expired_jobs integer not null default 0 check (expired_jobs >= 0),
  skipped_running integer not null default 0 check (skipped_running >= 0),
  remaining integer not null default 0 check (remaining >= 0),
  error_code text check (error_code is null or error_code ~ '^[0-9A-Z]{5}$'),
  check ((status = 'failed') = (error_code is not null))
);
alter table peppitness_private.import_retention_runs enable row level security;
revoke all on peppitness_private.import_retention_runs from public, anon, authenticated, service_role;

-- Stesso effetto di expire_import_job (14) su un job già bloccato dal chiamante: via i testi, job `expired`.
create function peppitness_private.expire_import_content(p_owner_id uuid, p_job_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  delete from public.import_drafts where owner_id = p_owner_id and job_id = p_job_id;
  update public.import_jobs set status = 'expired', safe_error = null, lease_token = null, lease_expires_at = null,
    revision = revision + 1 where owner_id = p_owner_id and id = p_job_id and status <> 'expired';
  -- attempt_count, usage_summary e provider_outcome (anche in_flight/uncertain) restano: non è spesa zero.
end;
$$;

/**
 * Un'esecuzione: fino a `p_batch` job scaduti, i più vecchi prima, in una sola transazione (un'interruzione
 * annulla tutto e la successiva riprende). SKIP LOCKED: due esecuzioni concorrenti o un job in uso non si
 * bloccano a vicenda. Un'analisi con lease ancora valida non viene toccata. Idempotente: un job già
 * `expired` non è più candidato. `remaining` segnala l'arretrato per il monitoraggio.
 */
create function peppitness_private.run_import_retention(p_batch integer default 500) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  started timestamptz := clock_timestamp();
  j record;
  expired integer := 0;
  skipped integer := 0;
  backlog integer := 0;
  run peppitness_private.import_retention_runs;
begin
  if p_batch is null or p_batch < 1 or p_batch > 5000 then
    raise exception using errcode = '22023', message = 'Invalid retention batch';
  end if;
  begin
    for j in select owner_id, id, status, lease_expires_at from public.import_jobs
      where status <> 'expired' and expires_at <= clock_timestamp()
      order by expires_at, id limit p_batch for update skip locked
    loop
      if j.status = 'running' and j.lease_expires_at > clock_timestamp() then skipped := skipped + 1; continue; end if;
      perform peppitness_private.expire_import_content(j.owner_id, j.id);
      expired := expired + 1;
    end loop;
    -- I vincoli differiti job ⇔ bozza (14) si verificano qui: un errore annulla il lotto e resta registrato.
    set constraints public.import_jobs_result, public.import_drafts_result immediate;
    select count(*) into backlog from public.import_jobs where status <> 'expired' and expires_at <= clock_timestamp();
    insert into peppitness_private.import_retention_runs(started_at, status, expired_jobs, skipped_running, remaining)
      values (started, 'succeeded', expired, skipped, backlog) returning * into run;
  exception when others then
    insert into peppitness_private.import_retention_runs(started_at, status, error_code)
      values (started, 'failed', SQLSTATE) returning * into run;
  end;
  set constraints public.import_jobs_result, public.import_drafts_result deferred;
  -- Monitoraggio limitato nel tempo: esiti propri e dettagli pg_cron di questo job oltre 90 giorni.
  delete from peppitness_private.import_retention_runs where finished_at < clock_timestamp() - interval '90 days';
  delete from cron.job_run_details where end_time < clock_timestamp() - interval '90 days'
    and jobid in (select jobid from cron.job where jobname = 'peppitness-import-retention');
  return jsonb_build_object('status', run.status, 'expiredJobs', run.expired_jobs, 'skippedRunning', run.skipped_running,
    'remaining', run.remaining, 'errorCode', run.error_code, 'finishedAt', run.finished_at);
end;
$$;

-- Installazione idempotente del job pianificato: stesso nome = stesso job, aggiornato (mai un doppione).
-- Ogni ora al minuto 17, fuso di pg_cron (cron.timezone, GMT/UTC): contenuti scaduti eliminati entro un'ora.
create function peppitness_private.schedule_import_retention() returns bigint
language sql security definer set search_path = '' as $$
  select cron.schedule('peppitness-import-retention', '17 * * * *', 'select peppitness_private.run_import_retention(500)');
$$;
select peppitness_private.schedule_import_retention();

/** Stato per il monitoraggio: job pianificato, ultimo esito e arretrato; nessun dato di account. */
create function peppitness_private.import_retention_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'scheduled', (select jsonb_build_object('jobId', jobid, 'schedule', schedule, 'command', command, 'active', active, 'database', database, 'username', username)
      from cron.job where jobname = 'peppitness-import-retention'),
    'lastRun', (select to_jsonb(r) - 'id' from peppitness_private.import_retention_runs r order by r.finished_at desc, r.id desc limit 1),
    'lastScheduledRun', (select jsonb_build_object('status', d.status, 'startTime', d.start_time, 'endTime', d.end_time)
      from cron.job_run_details d join cron.job c on c.jobid = d.jobid where c.jobname = 'peppitness-import-retention' order by d.start_time desc limit 1),
    'overdue', (select count(*) from public.import_jobs where status <> 'expired' and expires_at <= clock_timestamp()));
$$;

/**
 * Scarto esplicito di un'analisi propria: contenuti eliminati subito, job `expired` (come alla scadenza).
 * Un job altrui o inesistente restituisce null (nessuna informazione); un'analisi in corso con lease valida
 * non si scarta (PT409). Un commit già riuscito resta recuperabile con la ricevuta; uno non ancora arrivato
 * riceverà un rifiuto certo (PT410), mai un salvataggio parziale.
 */
create function public.discard_import_job(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); j public.import_jobs;
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  select * into j from public.import_jobs where owner_id = actor and id = p_job_id for update;
  if not FOUND then return null; end if;
  if j.status = 'running' and j.lease_expires_at > clock_timestamp() then
    raise exception using errcode = 'PT409', message = 'Import analysis in progress';
  end if;
  perform peppitness_private.expire_import_content(j.owner_id, j.id);
  select * into strict j from public.import_jobs where owner_id = actor and id = p_job_id;
  return peppitness_private.import_job_result(j);
end;
$$;

/**
 * Attività dell'utente su un'analisi propria pronta (riapertura o revisione in corso sul dispositivo):
 * job e bozza scadono di nuovo fra 7 giorni, come touch_import_job (14). Stesso TTL di inattività della
 * bozza locale (07). Un job altrui o inesistente → null; uno non pronto o già scaduto non si rinnova e
 * restituisce il proprio stato (per un job scaduto: `expired`, senza contenuto).
 */
create function public.renew_import_job(p_job_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare actor uuid := auth.uid(); j public.import_jobs; expiry timestamptz := clock_timestamp() + interval '7 days';
begin
  if actor is null then raise exception using errcode = '42501', message = 'Authentication required'; end if;
  select * into j from public.import_jobs where owner_id = actor and id = p_job_id for update;
  if not FOUND then return null; end if;
  if j.status = 'ready' and j.expires_at > clock_timestamp() then
    update public.import_drafts set expires_at = expiry, revision = revision + 1 where owner_id = j.owner_id and job_id = j.id;
    update public.import_jobs set expires_at = expiry, revision = revision + 1 where owner_id = j.owner_id and id = j.id returning * into j;
  end if;
  return peppitness_private.import_job_result(j);
end;
$$;

do $$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature, n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where (n.nspname = 'peppitness_private' and p.proname in ('expire_import_content', 'run_import_retention', 'schedule_import_retention', 'import_retention_status'))
      or (n.nspname = 'public' and p.proname in ('discard_import_job', 'renew_import_job'))
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', fn.signature);
    if fn.nspname = 'public' then execute format('grant execute on function %s to authenticated', fn.signature); end if;
  end loop;
end;
$$;
