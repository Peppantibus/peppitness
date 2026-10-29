-- Personal routine aggregate and dated completions. No seed or personal content.
create function peppitness_private.valid_morning_routine(doc jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare item jsonb; ids text[] := '{}'; total numeric := 0;
begin
  if jsonb_typeof(doc) is distinct from 'object' or not doc ?& array['title','base','extra','strengthDays','note']
    or exists(select 1 from jsonb_object_keys(doc) k where k not in ('title','base','extra','strengthDays','note'))
    or not peppitness_private.valid_text(doc->'title',120,true) or not peppitness_private.valid_text(doc->'note',8000,false)
    or jsonb_typeof(doc->'base') is distinct from 'array' or jsonb_typeof(doc->'extra') is distinct from 'array'
    or jsonb_typeof(doc->'strengthDays') is distinct from 'array' then return false; end if;
  if jsonb_array_length(doc->'base') not between 1 and 30 or jsonb_array_length(doc->'extra')>30 or jsonb_array_length(doc->'strengthDays')>7 then return false; end if;
  if exists(select 1 from jsonb_array_elements(doc->'strengthDays') d where jsonb_typeof(d)<>'number' or d::text !~ '^[1-7]$')
    or (select count(*)<>count(distinct d) from jsonb_array_elements(doc->'strengthDays') d) then return false; end if;
  for item in select value from jsonb_array_elements((doc->'base')||(doc->'extra')) loop
    if jsonb_typeof(item) is distinct from 'object' or not item ?& array['id','name','area','dose','minutes','note']
      or exists(select 1 from jsonb_object_keys(item) k where k not in ('id','name','area','dose','minutes','note'))
      or not peppitness_private.valid_uuid(item->'id') or item->>'id'=any(ids)
      or not peppitness_private.valid_text(item->'name',120,true) or not peppitness_private.valid_text(item->'area',80,false)
      or not peppitness_private.valid_text(item->'dose',80,false) or not peppitness_private.valid_text(item->'note',4000,false)
      or jsonb_typeof(item->'minutes') is distinct from 'number' then return false; end if;
    if (item->>'minutes')::numeric not between .5 and 30 or mod((item->>'minutes')::numeric*2,1)<>0 then return false; end if;
    ids := array_append(ids,item->>'id'); total := total+(item->>'minutes')::numeric;
  end loop;
  return total<=180;
exception when others then return false;
end;
$$;
revoke all on function peppitness_private.valid_morning_routine(jsonb) from public,anon,authenticated;

create table public.morning_routines (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  document jsonb not null check(octet_length(document::text)<=262144 and peppitness_private.valid_morning_routine(document)),
  last_request_id uuid not null,
  revision integer not null default 1 check(revision>0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.morning_routine_days (
  owner_id uuid not null references auth.users(id) on delete cascade,
  date date not null check(date between date '2000-01-01' and date '2200-01-01'),
  snapshot jsonb check(snapshot is null or (octet_length(snapshot::text)<=262144 and peppitness_private.valid_morning_routine(snapshot))),
  completed_at timestamptz,
  last_request_id uuid not null,
  revision integer not null default 1 check(revision>0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(owner_id,date), check((snapshot is null)=(completed_at is null))
);
create trigger a_stamp_record before insert or update on public.morning_routines for each row execute function peppitness_private.stamp_record();
create trigger a_stamp_record before insert or update on public.morning_routine_days for each row execute function peppitness_private.stamp_record();
alter table public.morning_routines enable row level security;
alter table public.morning_routines force row level security;
alter table public.morning_routine_days enable row level security;
alter table public.morning_routine_days force row level security;
revoke all on public.morning_routines,public.morning_routine_days from public,anon,authenticated;
grant select on public.morning_routines,public.morning_routine_days to authenticated;
create policy own_routine on public.morning_routines for select to authenticated using(owner_id=(select auth.uid()));
create policy own_routine_days on public.morning_routine_days for select to authenticated using(owner_id=(select auth.uid()));
create policy mfa_aal2_required on public.morning_routines as restrictive for all to authenticated using((select public.is_mfa_satisfied())) with check((select public.is_mfa_satisfied()));
create policy mfa_aal2_required on public.morning_routine_days as restrictive for all to authenticated using((select public.is_mfa_satisfied())) with check((select public.is_mfa_satisfied()));

create function public.save_morning_routine(p_document jsonb,p_expected_revision integer,p_request_id uuid)
returns public.morning_routines language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); current_row public.morning_routines;
begin
  perform peppitness_private.require_mfa();
  if actor is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_request_id is null or p_expected_revision is null or p_expected_revision<0 or p_document is null
    or not peppitness_private.valid_morning_routine(p_document) then raise exception using errcode='22023',message='Invalid routine'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':morning',0));
  select * into current_row from public.morning_routines where owner_id=actor for update;
  if current_row.last_request_id=p_request_id then
    if current_row.document is distinct from p_document then raise exception using errcode='22023',message='Request identity reused'; end if;
    return current_row;
  end if;
  if coalesce(current_row.revision,0)<>p_expected_revision then raise exception using errcode='PT409',message='Revision conflict'; end if;
  if current_row.owner_id is null then
    insert into public.morning_routines(owner_id,document,last_request_id) values(actor,p_document,p_request_id) returning * into current_row;
  else
    update public.morning_routines set document=p_document,last_request_id=p_request_id,revision=revision+1 where owner_id=actor returning * into current_row;
  end if;
  return current_row;
end;
$$;
create function public.set_morning_routine_day(p_date date,p_snapshot jsonb,p_expected_revision integer,p_request_id uuid)
returns public.morning_routine_days language plpgsql security definer set search_path = '' as $$
declare actor uuid:=auth.uid(); current_row public.morning_routine_days; zone text;
begin
  perform peppitness_private.require_mfa();
  if actor is null then raise exception using errcode='42501',message='Authentication required'; end if;
  if p_request_id is null or p_expected_revision is null or p_expected_revision<0 or p_date is null
    or (p_snapshot is not null and not peppitness_private.valid_morning_routine(p_snapshot)) then raise exception using errcode='22023',message='Invalid routine day'; end if;
  perform pg_advisory_xact_lock(hashtextextended(actor::text||':morning:'||p_date::text,0));
  select * into current_row from public.morning_routine_days where owner_id=actor and date=p_date for update;
  if current_row.last_request_id=p_request_id then
    if current_row.snapshot is distinct from p_snapshot then raise exception using errcode='22023',message='Request identity reused'; end if;
    return current_row;
  end if;
  select time_zone into zone from public.user_settings where owner_id=actor;
  if p_date>(now() at time zone coalesce(zone,'Europe/Rome'))::date then raise exception using errcode='22023',message='Future completion not allowed'; end if;
  if coalesce(current_row.revision,0)<>p_expected_revision then raise exception using errcode='PT409',message='Revision conflict'; end if;
  if current_row.owner_id is null then
    insert into public.morning_routine_days(owner_id,date,snapshot,completed_at,last_request_id)
      values(actor,p_date,p_snapshot,case when p_snapshot is not null then now() end,p_request_id) returning * into current_row;
  else
    update public.morning_routine_days set snapshot=p_snapshot,completed_at=case when p_snapshot is not null then now() end,
      last_request_id=p_request_id,revision=revision+1 where owner_id=actor and date=p_date returning * into current_row;
  end if;
  return current_row;
end;
$$;
revoke all on function public.save_morning_routine(jsonb,integer,uuid),public.set_morning_routine_day(date,jsonb,integer,uuid) from public,anon;
grant execute on function public.save_morning_routine(jsonb,integer,uuid),public.set_morning_routine_day(date,jsonb,integer,uuid) to authenticated;
