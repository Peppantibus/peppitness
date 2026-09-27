-- Controllo iniziale da eseguire nel SQL Editor del progetto peppitness.
-- Legge soltanto metadati: nessuna tabella o registrazione viene modificata.
-- Non legge utenti, password, chiavi o contenuti dei piani.
-- Non e una migrazione e non costituisce una verifica di isolamento RLS.
-- Se migration_history_present e true, controllare anche:
-- npx.cmd supabase migration list --linked

select pg_catalog.jsonb_build_object(
  'server_version', pg_catalog.current_setting('server_version'),
  'public_relations', coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'name', c.relname,
        'kind', case c.relkind
          when 'r' then 'table'
          when 'p' then 'partitioned_table'
          when 'v' then 'view'
          when 'm' then 'materialized_view'
          when 'f' then 'foreign_table'
        end,
        'rls_enabled', c.relrowsecurity
      ) order by c.relname
    )
    from pg_catalog.pg_class as c
    join pg_catalog.pg_namespace as n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
  ), '[]'::jsonb),
  'public_routines', coalesce((
    select pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'name', p.proname,
        'argument_types', pg_catalog.oidvectortypes(p.proargtypes),
        'security_definer', p.prosecdef
      ) order by p.proname, p.oid
    )
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n on n.oid = p.pronamespace
    where n.nspname = 'public'
  ), '[]'::jsonb),
  'migration_history_present',
    pg_catalog.to_regclass('supabase_migrations.schema_migrations') is not null
) as preflight;
