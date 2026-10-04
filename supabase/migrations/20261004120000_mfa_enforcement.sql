-- SA-03: la MFA TOTP, quando richiesta, vale anche nel livello dati (aal2 oltre alla proprietà).
-- Richiesta per un account se ha un fattore TOTP verificato, oppure per tutti se
-- peppitness_private.security_settings.mfa_required = true (da attivare prima degli amici).
-- Nessun dato esistente viene modificato; il default lascia invariato il comportamento attuale.

create table peppitness_private.security_settings (
  singleton boolean primary key default true check (singleton),
  mfa_required boolean not null default false
);
insert into peppitness_private.security_settings(singleton) values (true);
alter table peppitness_private.security_settings enable row level security;
alter table peppitness_private.security_settings force row level security;
revoke all on peppitness_private.security_settings from public, anon, authenticated;

-- Esposta al client solo per leggere il proprio stato (policy RLS e interfaccia):
-- restituisce un booleano sull'identità del chiamante, nessun dato di terzi.
create function public.is_mfa_satisfied()
returns boolean language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null then false
    when coalesce(auth.jwt() ->> 'aal', '') = 'aal2' then true
    else not (
      (select s.mfa_required from peppitness_private.security_settings s)
      or exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
    )
  end
$$;
revoke all on function public.is_mfa_satisfied() from public, anon, authenticated;
grant execute on function public.is_mfa_satisfied() to authenticated;

create function peppitness_private.require_mfa()
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  -- Senza identità decide il controllo proprio di ogni funzione ("Authentication required").
  if auth.uid() is not null and not public.is_mfa_satisfied() then
    raise exception using errcode = '42501', message = 'MFA required';
  end if;
end;
$$;
revoke all on function peppitness_private.require_mfa() from public, anon, authenticated;

-- Vincolo restrittivo che si somma alle policy di proprietà su ogni tabella public con RLS.
do $$
declare t record;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity loop
    execute format(
      'create policy mfa_aal2_required on public.%I as restrictive for all to authenticated '
      'using ((select public.is_mfa_satisfied())) with check ((select public.is_mfa_satisfied()))', t.relname);
  end loop;
end $$;

-- Le RPC SECURITY DEFINER aggirano la RLS: il controllo va all'inizio del corpo.
-- Le RPC SECURITY INVOKER sono già coperte dalle policy restrittive.
do $$
declare f record; def text; patched text;
begin
  for f in select p.oid, p.proname, l.lanname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    join pg_language l on l.oid = p.prolang
    where n.nspname = 'public' and p.prosecdef and p.prokind = 'f'
      and p.proname <> 'is_mfa_satisfied'
      and has_function_privilege('authenticated', p.oid, 'execute') loop
    if f.lanname <> 'plpgsql' then
      raise exception 'Funzione % non plpgsql: aggiungere il controllo MFA a mano', f.proname;
    end if;
    def := pg_get_functiondef(f.oid);
    patched := regexp_replace(def, '\mbegin\M', E'begin\n  perform peppitness_private.require_mfa();', 'i');
    if patched = def then raise exception 'Corpo di % senza begin', f.proname; end if;
    execute patched;
  end loop;
end $$;
