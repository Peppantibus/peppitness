begin;
set local search_path = public, extensions, pg_catalog;
select plan(1);
-- Stesso controllo eseguibile dall'agente tramite db query --local.
\ir workout_plans_smoke.inc
select pass('Programmi: RLS, FK, atomicita, revisioni, snapshot, pubblicazione e pulizia account');
select * from finish();
rollback;
