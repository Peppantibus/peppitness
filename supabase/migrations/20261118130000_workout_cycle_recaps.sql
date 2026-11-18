create table public.workout_cycle_recaps (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  recap_key text not null,
  payload jsonb not null,
  primary key (owner_id, recap_key),
  check (recap_key ~ '^[0-9a-f-]{36}\.\d{4}-\d{2}-\d{2}\.\d{1,3}$'),
  check (coalesce(
    jsonb_typeof(payload) = 'object'
    and payload ->> 'schema' = '1'
    and payload ->> 'key' = recap_key
    and jsonb_typeof(payload -> 'report') = 'object'
    and octet_length(payload::text) <= 262144,
    false))
);

alter table public.workout_cycle_recaps enable row level security;
alter table public.workout_cycle_recaps force row level security;
revoke all on public.workout_cycle_recaps from public, anon, authenticated;
grant select on public.workout_cycle_recaps to authenticated;
grant insert (recap_key, payload) on public.workout_cycle_recaps to authenticated;

create policy cycle_recaps_read_own on public.workout_cycle_recaps for select to authenticated
  using (owner_id = (select auth.uid()));
create policy cycle_recaps_insert_own on public.workout_cycle_recaps for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy mfa_aal2_required on public.workout_cycle_recaps as restrictive for all to authenticated
  using ((select public.is_mfa_satisfied()))
  with check ((select public.is_mfa_satisfied()));
