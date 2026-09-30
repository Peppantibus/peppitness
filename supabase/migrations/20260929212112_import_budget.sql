-- Task 15: nessuna attivazione implicita. Prezzi e budget NULL, enabled=false.
-- Ogni segmento/retry è una nuova prenotazione PRIMA della sua singola chiamata.
-- Lock: configurazione progetto -> account -> job -> reservation. Solo queste
-- operazioni di budget serializzano il progetto; nessun lock su piani/diario.
create table peppitness_private.import_budget_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  config_version text not null default 'disabled/1',
  price_version text,
  provider text,
  model text,
  currency text check (currency in ('USD','EUR')),
  project_limit_micros bigint check (project_limit_micros between 1 and 9007199254740991),
  account_limit_micros bigint check (account_limit_micros between 1 and 9007199254740991),
  input_micros_per_million bigint check (input_micros_per_million between 0 and 9007199254740991),
  output_micros_per_million bigint check (output_micros_per_million between 0 and 9007199254740991),
  max_active_per_account integer not null default 1 check (max_active_per_account between 1 and 100),
  daily_analyses integer not null default 5 check (daily_analyses between 1 and 10000),
  max_attempts integer not null default 2 check (max_attempts between 1 and 100),
  max_input_tokens integer not null default 100000 check (max_input_tokens > 0),
  max_output_tokens integer not null default 16000 check (max_output_tokens > 0),
  framing_tokens integer not null default 256 check (framing_tokens >= 0),
  check (not enabled or (price_version is not null and length(price_version)>0
    and provider is not null and length(provider)>0 and model is not null and length(model)>0
    and currency is not null and project_limit_micros is not null and account_limit_micros is not null
    and input_micros_per_million is not null and output_micros_per_million is not null))
);
insert into peppitness_private.import_budget_config(singleton) values (true);

create table peppitness_private.import_usage_ledger (
  id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  job_id uuid not null,
  -- Un tentativo è assegnato SOLO all'autorizzazione all'invio; una riserva
  -- annullata prima di dispatch non inventa una chiamata fatturabile.
  attempt integer check (attempt > 0),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  input_bytes integer not null check (input_bytes > 0),
  input_upper_tokens integer not null check (input_upper_tokens > 0),
  max_output_tokens integer not null check (max_output_tokens > 0),
  config_version text not null,
  price_version text not null,
  provider text not null,
  model text not null,
  currency text not null check (currency in ('USD','EUR')),
  input_micros_per_million bigint not null,
  output_micros_per_million bigint not null,
  reserved_micros bigint not null check (reserved_micros >= 0),
  actual_micros bigint check (actual_micros >= 0),
  state text not null default 'reserved' check (state in ('reserved','sent','uncertain','settled','cancelled')),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  reasoning_tokens integer check (reasoning_tokens >= 0),
  retry_after_seconds integer not null default 0 check (retry_after_seconds between 0 and 86400),
  retry_not_before timestamptz,
  lease_token uuid not null,
  budget_month date not null default date_trunc('month', clock_timestamp() at time zone 'UTC')::date,
  created_at timestamptz not null default clock_timestamp(),
  sent_at timestamptz,
  reconciled_at timestamptz,
  foreign key (owner_id,job_id) references public.import_jobs(owner_id,id) on delete cascade,
  unique (owner_id,job_id,attempt),
  check ((state in ('reserved','cancelled')) = (attempt is null)),
  check ((state in ('settled','cancelled')) = (actual_micros is not null)),
  check (state <> 'settled' or (input_tokens is not null and output_tokens is not null)),
  check (reasoning_tokens is null or output_tokens is null or reasoning_tokens <= output_tokens)
);
create unique index import_usage_one_pending_job on peppitness_private.import_usage_ledger(owner_id,job_id)
  where state in ('reserved','sent','uncertain');
create index import_usage_owner_date on peppitness_private.import_usage_ledger(owner_id,created_at);
create index import_usage_month on peppitness_private.import_usage_ledger(budget_month,state);
-- Dopo account delete non conservare owner/job, ma neppure liberare spesa del
-- progetto già sostenuta o incerta. Solo totali anonimi per mese, senza testi/ID.
create table peppitness_private.import_budget_retired (
  budget_month date primary key,
  known_micros numeric not null default 0 check (known_micros>=0),
  uncertain_micros numeric not null default 0 check (uncertain_micros>=0)
);
alter table peppitness_private.import_budget_config enable row level security;
alter table peppitness_private.import_usage_ledger enable row level security;
alter table peppitness_private.import_budget_retired enable row level security;
revoke all on peppitness_private.import_budget_config, peppitness_private.import_usage_ledger, peppitness_private.import_budget_retired from public,anon,authenticated,service_role;

create function peppitness_private.retain_import_project_usage() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if OLD.state in ('settled','sent','uncertain') then
    insert into peppitness_private.import_budget_retired(budget_month,known_micros,uncertain_micros)
      values(OLD.budget_month,coalesce(OLD.actual_micros,0),case when OLD.actual_micros is null then OLD.reserved_micros else 0 end)
      on conflict (budget_month) do update set
        known_micros=peppitness_private.import_budget_retired.known_micros+excluded.known_micros,
        uncertain_micros=peppitness_private.import_budget_retired.uncertain_micros+excluded.uncertain_micros;
  end if;
  return OLD;
end;
$$;
create trigger import_usage_retire after delete on peppitness_private.import_usage_ledger
  for each row execute function peppitness_private.retain_import_project_usage();

create function peppitness_private.import_cost(p_input bigint,p_output bigint,p_input_price bigint,p_output_price bigint)
returns bigint language plpgsql immutable security invoker set search_path='' as $$
declare total numeric;
begin
  if p_input is null or p_output is null or p_input_price is null or p_output_price is null
    or least(p_input,p_output,p_input_price,p_output_price)<0 then
    raise exception using errcode='22023',message='Invalid import cost';
  end if;
  -- Output include reasoning: non sommarlo nuovamente. Arrotondamento verso l'alto.
  total := ceil(p_input::numeric*p_input_price/1000000) + ceil(p_output::numeric*p_output_price/1000000);
  if total>9007199254740991 then raise exception using errcode='22023',message='Import cost overflow'; end if;
  return total::bigint;
end;
$$;

create function peppitness_private.lock_import_budget(p_owner_id uuid)
returns peppitness_private.import_budget_config language plpgsql security invoker set search_path='' as $$
declare c peppitness_private.import_budget_config;
begin
  perform peppitness_private.require_import_server();
  if p_owner_id is null then raise exception using errcode='42501',message='Import owner required'; end if;
  select * into c from peppitness_private.import_budget_config where singleton for update;
  perform pg_advisory_xact_lock(hashtextextended('peppitness.import-budget.account:'||p_owner_id::text,0));
  return c;
end;
$$;

-- Esposizione del mese UTC corrente + TUTTE le riserve ancora incerte, anche
-- del mese passato. Il calendario e le lease non costituiscono una riconciliazione.
create function peppitness_private.import_budget_exposure(p_owner_id uuid default null)
returns numeric language sql stable security invoker set search_path='' as $$
  select (select coalesce(sum(case when state in ('reserved','sent','uncertain') then reserved_micros
    when budget_month=date_trunc('month',statement_timestamp() at time zone 'UTC')::date then actual_micros else 0 end),0)
    from peppitness_private.import_usage_ledger where p_owner_id is null or owner_id=p_owner_id)
  + case when p_owner_id is null then (select coalesce(sum(uncertain_micros + case
      when budget_month=date_trunc('month',statement_timestamp() at time zone 'UTC')::date then known_micros else 0 end),0)
      from peppitness_private.import_budget_retired) else 0 end;
$$;

create function peppitness_private.guard_import_currency() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
  if NEW.currency is distinct from OLD.currency and (exists(select 1 from peppitness_private.import_usage_ledger)
    or exists(select 1 from peppitness_private.import_budget_retired)) then
    raise exception using errcode='23514',message='Import ledger currency cannot change';
  end if;
  return NEW;
end;
$$;
create trigger import_budget_currency before update on peppitness_private.import_budget_config
  for each row execute function peppitness_private.guard_import_currency();

create function peppitness_private.import_ledger_usage(p_owner_id uuid,p_job_id uuid,p_calls integer)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('providerCalls',p_calls,'cached',false,
    'inputTokens',case when bool_and(state in ('settled','cancelled')) then sum(coalesce(input_tokens,0)) else null end,
    'outputTokens',case when bool_and(state in ('settled','cancelled')) then sum(coalesce(output_tokens,0)) else null end,
    'reasoningTokens',case when bool_and(state in ('settled','cancelled') and (reasoning_tokens is not null or state='cancelled'))
      then sum(coalesce(reasoning_tokens,0)) else null end,
    'costEstimate',jsonb_build_object('amountMicros',sum(coalesce(actual_micros,reserved_micros)),'currency',min(currency)))
  from peppitness_private.import_usage_ledger where owner_id=p_owner_id and job_id=p_job_id;
$$;
create function peppitness_private.stamp_import_usage() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from peppitness_private.import_usage_ledger where owner_id=NEW.owner_id and job_id=NEW.id) then
    NEW.usage_summary:=peppitness_private.import_ledger_usage(NEW.owner_id,NEW.id,NEW.attempt_count);
  end if;
  return NEW;
end;
$$;
-- Anche complete/fail/expire non possono sovrascrivere usage con stime del chiamante.
create trigger import_jobs_usage before update on public.import_jobs
  for each row execute function peppitness_private.stamp_import_usage();

create function peppitness_private.import_reservation_result(l peppitness_private.import_usage_ledger,p_send boolean default false)
returns jsonb language sql stable security invoker set search_path='' as $$
  select jsonb_build_object('reservationId',l.id,'jobId',l.job_id,'attempt',l.attempt,'state',l.state,
    'requestHash',l.request_hash,'inputUpperTokens',l.input_upper_tokens,'maxOutputTokens',l.max_output_tokens,
    'provider',l.provider,'model',l.model,'currency',l.currency,'configVersion',l.config_version,'priceVersion',l.price_version,
    'reservedMicros',l.reserved_micros,'actualMicros',l.actual_micros,'sendGranted',p_send,
    'job',peppitness_private.import_server_result(j)) from public.import_jobs j where j.owner_id=l.owner_id and j.id=l.job_id;
$$;

create function public.get_import_budget_config() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c peppitness_private.import_budget_config;
begin
  perform peppitness_private.require_import_server();
  select * into c from peppitness_private.import_budget_config where singleton;
  if not FOUND then return jsonb_build_object('enabled',false); end if;
  return to_jsonb(c)-'singleton';
end;
$$;
create function public.get_import_reservation(p_owner_id uuid,p_reservation_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare l peppitness_private.import_usage_ledger;
begin
  perform peppitness_private.require_import_server();
  select * into l from peppitness_private.import_usage_ledger where owner_id=p_owner_id and id=p_reservation_id;
  if not FOUND then return null; end if;
  return peppitness_private.import_reservation_result(l);
end;
$$;

create function public.reserve_import_budget(p_owner_id uuid,p_job_id uuid,p_reservation_id uuid,p_expected_revision integer,
  p_request_hash text,p_input_bytes integer,p_max_output_tokens integer,p_retry boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c peppitness_private.import_budget_config; j public.import_jobs; l peppitness_private.import_usage_ledger;
  input_upper bigint; amount bigint; active_count integer; daily_count integer; next_lease uuid:=gen_random_uuid();
begin
  c:=peppitness_private.lock_import_budget(p_owner_id);
  select * into j from public.import_jobs where owner_id=p_owner_id and id=p_job_id for update;
  if not FOUND then raise exception using errcode='42501',message='Import job not available'; end if;
  if p_reservation_id is null or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_input_bytes is null or p_input_bytes<1 or p_max_output_tokens is null or p_max_output_tokens<1 or p_retry is null then
    raise exception using errcode='22023',message='Invalid import reservation';
  end if;
  select * into l from peppitness_private.import_usage_ledger where id=p_reservation_id for update;
  if FOUND then
    if l.owner_id<>p_owner_id then raise exception using errcode='42501',message='Import reservation not available'; end if;
    if l.job_id<>p_job_id or l.request_hash<>p_request_hash or l.input_bytes<>p_input_bytes or l.max_output_tokens<>p_max_output_tokens then
      raise exception using errcode='PT409',message='Import reservation conflict';
    end if;
    return peppitness_private.import_reservation_result(l); -- replay non ri-autorizza invio
  end if;
  if c.enabled is distinct from true then raise exception using errcode='PT503',message='Import analysis disabled'; end if;
  if j.revision is distinct from p_expected_revision then raise exception using errcode='PT409',message='Import revision conflict'; end if;
  if j.versions->>'provider' is distinct from c.provider or j.versions->>'model' is distinct from c.model then
    raise exception using errcode='PT409',message='Import analysis profile changed';
  end if;
  if j.expires_at<=clock_timestamp() or j.status in ('ready','expired') then
    raise exception using errcode='PT409',message='Import job not reservable';
  end if;
  if exists(select 1 from peppitness_private.import_usage_ledger where owner_id=p_owner_id and job_id=p_job_id and state in ('reserved','sent','uncertain')) then
    raise exception using errcode='PT409',message='Import analysis already active';
  end if;
  if j.attempt_count>=c.max_attempts then raise exception using errcode='PT429',message='Import attempt quota exhausted'; end if;
  if exists(select 1 from peppitness_private.import_usage_ledger where owner_id=p_owner_id and job_id=p_job_id and retry_not_before>clock_timestamp()) then
    raise exception using errcode='PT429',message='Import retry deferred';
  end if;
  if (j.attempt_count>0 or j.status='failed') and not p_retry then
    raise exception using errcode='PT409',message='Import explicit retry required';
  end if;
  if (j.provider_outcome='uncertain' and not exists(select 1 from peppitness_private.import_usage_ledger
      where owner_id=p_owner_id and job_id=p_job_id and state='settled'))
    or (j.attempt_count=0 and j.status='running' and j.lease_expires_at<=clock_timestamp()) then
    raise exception using errcode='PT409',message='Import lease conflict';
  end if;
  select count(distinct other.id) into active_count from public.import_jobs other
    join peppitness_private.import_usage_ledger r on r.owner_id=other.owner_id and r.job_id=other.id
    where other.owner_id=p_owner_id and other.id<>p_job_id
      and (r.state in ('reserved','sent','uncertain') or (other.status='running' and other.expires_at>clock_timestamp() and r.state<>'cancelled'));
  if active_count>=c.max_active_per_account then raise exception using errcode='PT409',message='Import account concurrency limit'; end if;
  if not exists(select 1 from peppitness_private.import_usage_ledger where owner_id=p_owner_id and job_id=p_job_id) then
    select count(*) into daily_count from (select job_id from peppitness_private.import_usage_ledger where owner_id=p_owner_id
      group by job_id having min(created_at) at time zone 'UTC'>=date_trunc('day',clock_timestamp() at time zone 'UTC')) as first_reservations;
    if daily_count>=c.daily_analyses then raise exception using errcode='PT429',message='Import daily quota exhausted'; end if;
  end if;
  -- Tutto il body serializzato (prompt/schema/segmenti inclusi), 1 token per byte
  -- UTF-8 come upper bound conservativo + framing configurato SOLO sul server.
  input_upper:=p_input_bytes::bigint+c.framing_tokens;
  if input_upper>c.max_input_tokens or p_max_output_tokens>c.max_output_tokens then
    raise exception using errcode='PT413',message='Import token limit exceeded';
  end if;
  amount:=peppitness_private.import_cost(input_upper,p_max_output_tokens,c.input_micros_per_million,c.output_micros_per_million);
  if peppitness_private.import_budget_exposure()+amount>c.project_limit_micros then
    raise exception using errcode='PT429',message='Import project budget exhausted';
  end if;
  if peppitness_private.import_budget_exposure(p_owner_id)+amount>c.account_limit_micros then
    raise exception using errcode='PT429',message='Import account budget exhausted';
  end if;
  insert into peppitness_private.import_usage_ledger(id,owner_id,job_id,request_hash,input_bytes,input_upper_tokens,max_output_tokens,
    config_version,price_version,provider,model,currency,input_micros_per_million,output_micros_per_million,reserved_micros,lease_token)
  values(p_reservation_id,p_owner_id,p_job_id,p_request_hash,p_input_bytes,input_upper,p_max_output_tokens,
    c.config_version,c.price_version,c.provider,c.model,c.currency,c.input_micros_per_million,c.output_micros_per_million,amount,next_lease)
  returning * into l;
  update public.import_jobs set status='running',safe_error=null,provider_outcome='not_started',
    lease_token=next_lease,lease_expires_at=clock_timestamp()+interval '2 minutes',revision=revision+1
    where owner_id=p_owner_id and id=p_job_id;
  return peppitness_private.import_reservation_result(l);
end;
$$;

create function public.dispatch_import_attempt(p_owner_id uuid,p_reservation_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c peppitness_private.import_budget_config; j public.import_jobs; l peppitness_private.import_usage_ledger; target uuid;
begin
  c:=peppitness_private.lock_import_budget(p_owner_id);
  select job_id into target from peppitness_private.import_usage_ledger where owner_id=p_owner_id and id=p_reservation_id;
  if not FOUND then raise exception using errcode='42501',message='Import reservation not available'; end if;
  select * into strict j from public.import_jobs where owner_id=p_owner_id and id=target for update;
  select * into strict l from peppitness_private.import_usage_ledger where owner_id=p_owner_id and id=p_reservation_id for update;
  if l.state<>'reserved' then return peppitness_private.import_reservation_result(l); end if;
  if c.enabled is distinct from true then raise exception using errcode='PT503',message='Import analysis disabled'; end if;
  if j.attempt_count>=c.max_attempts then raise exception using errcode='PT429',message='Import attempt quota exhausted'; end if;
  if peppitness_private.import_budget_exposure()>c.project_limit_micros or peppitness_private.import_budget_exposure(p_owner_id)>c.account_limit_micros then
    raise exception using errcode='PT429',message='Import budget reduced';
  end if;
  j:=peppitness_private.record_import_attempt(p_owner_id,j.id,j.revision,l.lease_token);
  update peppitness_private.import_usage_ledger set state='sent',attempt=j.attempt_count,sent_at=clock_timestamp()
    where id=l.id returning * into l;
  -- Concessione monouso. Risposta persa => nessun reinvio, lookup/uncertain.
  return peppitness_private.import_reservation_result(l,true);
end;
$$;

create function public.reconcile_import_usage(p_owner_id uuid,p_reservation_id uuid,p_outcome text,
  p_usage jsonb,p_retry_after_seconds integer default 0) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j public.import_jobs; l peppitness_private.import_usage_ledger; target uuid; input_count integer; output_count integer;
  reasoning_count integer; amount bigint; final_state text; key text; token jsonb;
begin
  perform peppitness_private.lock_import_budget(p_owner_id); -- kill switch non blocca riconciliazione
  select job_id into target from peppitness_private.import_usage_ledger where owner_id=p_owner_id and id=p_reservation_id;
  if not FOUND then raise exception using errcode='42501',message='Import reservation not available'; end if;
  select * into strict j from public.import_jobs where owner_id=p_owner_id and id=target for update;
  select * into strict l from peppitness_private.import_usage_ledger where owner_id=p_owner_id and id=p_reservation_id for update;
  if p_outcome is null or p_outcome not in ('known','uncertain','not_sent') or jsonb_typeof(p_usage) is distinct from 'object'
    or not(p_usage ?& array['inputTokens','outputTokens','reasoningTokens'])
    or p_usage-array['inputTokens','outputTokens','reasoningTokens']<>'{}'
    or p_retry_after_seconds is null or p_retry_after_seconds not between 0 and 86400 then
    raise exception using errcode='22023',message='Invalid import usage';
  end if;
  foreach key in array array['inputTokens','outputTokens','reasoningTokens'] loop
    token:=p_usage->key;
    if token<>'null'::jsonb then
      if jsonb_typeof(token)<>'number' or token::text !~ '^[0-9]+$' then
        raise exception using errcode='22023',message='Invalid import usage';
      end if;
      if (token::text)::numeric>2147483647 then
        raise exception using errcode='22023',message='Invalid import usage';
      end if;
    end if;
  end loop;
  input_count:=(p_usage->>'inputTokens')::integer; output_count:=(p_usage->>'outputTokens')::integer; reasoning_count:=(p_usage->>'reasoningTokens')::integer;
  if reasoning_count>output_count or (p_outcome='known' and (input_count is null or output_count is null)) then
    raise exception using errcode='22023',message='Invalid import usage';
  end if;
  final_state:=case p_outcome when 'known' then 'settled' when 'not_sent' then 'cancelled' else 'uncertain' end;
  if l.state in ('settled','cancelled') then
    if l.state<>final_state or row(l.input_tokens,l.output_tokens,l.reasoning_tokens,l.retry_after_seconds)
      is distinct from row(input_count,output_count,reasoning_count,p_retry_after_seconds) then
      raise exception using errcode='PT409',message='Import usage conflict';
    end if;
    return peppitness_private.import_reservation_result(l);
  end if;
  if (p_outcome='not_sent' and (l.state<>'reserved' or input_count is distinct from 0 or output_count is distinct from 0 or reasoning_count is distinct from 0))
    or (p_outcome<>'not_sent' and l.state='reserved') then
    raise exception using errcode='PT409',message='Import dispatch state conflict';
  end if;
  amount:=peppitness_private.import_cost(coalesce(input_count,0),coalesce(output_count,reasoning_count,0),l.input_micros_per_million,l.output_micros_per_million);
  -- I null qui servono solo al LOWER bound parziale: NON diventano consumo noto zero.
  update peppitness_private.import_usage_ledger set state=final_state,input_tokens=input_count,output_tokens=output_count,reasoning_tokens=reasoning_count,
    actual_micros=case when final_state in ('settled','cancelled') then amount else null end,
    reserved_micros=case when final_state='uncertain' then greatest(reserved_micros,amount) else reserved_micros end,
    retry_after_seconds=p_retry_after_seconds,retry_not_before=clock_timestamp()+make_interval(secs=>p_retry_after_seconds),reconciled_at=clock_timestamp()
    where id=l.id returning * into l;
  update public.import_jobs set revision=revision+1 where owner_id=j.owner_id and id=j.id;
  return peppitness_private.import_reservation_result(l);
end;
$$;

do $$
declare fn record;
begin
  for fn in select p.oid::regprocedure as signature,n.nspname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where (n.nspname='peppitness_private' and p.proname in ('import_cost','lock_import_budget','import_budget_exposure',
      'guard_import_currency','import_ledger_usage','stamp_import_usage','import_reservation_result','retain_import_project_usage'))
      or (n.nspname='public' and p.proname in ('get_import_budget_config','get_import_reservation','reserve_import_budget','dispatch_import_attempt','reconcile_import_usage'))
  loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',fn.signature);
    if fn.nspname='public' then execute format('grant execute on function %s to service_role',fn.signature); end if;
  end loop;
end;
$$;
