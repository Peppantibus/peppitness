-- A failed/finished request must not occupy the account's execution slot forever.
-- An uncertain attempt retains its full financial reservation until reconciliation.
-- Fresh leases and running jobs still block concurrent execution; same-job retries
-- remain forbidden while their previous reservation is uncertain.
create or replace function public.reserve_import_budget(p_owner_id uuid,p_job_id uuid,p_reservation_id uuid,p_expected_revision integer,
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
      and ((other.status='running' and other.expires_at>clock_timestamp() and r.state<>'cancelled')
        or (r.state in ('reserved','sent','uncertain') and other.lease_expires_at>clock_timestamp()));
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
