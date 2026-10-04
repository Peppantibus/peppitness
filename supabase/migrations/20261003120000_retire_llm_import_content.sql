-- Dismissione del vecchio import LLM (audit docs/SUPABASE_CLEANUP_AUDIT.md, fase 1: contenuti e servizio).
-- L'import Word strutturato non usa job, bozze, budget né Edge `extract-plan`: legge sul dispositivo e salva
-- con le RPC commit_*_import (jobId null). Questa migrazione NON elimina tabelle, RPC o cron:
-- - scarta i contenuti rimasti (documenti normalizzati/estrazioni) con la stessa funzione della retention;
-- - disabilita il budget, cosi' nessuna nuova analisi puo' essere prenotata (reserve_import_budget -> PT503);
-- - conserva job (solo metadati), ledger (anche gli `uncertain`, non sono spesa zero) e ricevute.
-- Ritirare prima Edge extract-plan. Un'analisi con lease valida blocca la migrazione intera:
-- non dichiarare completata una pulizia parziale e non interrompere una richiesta al provider.
-- Idempotente. Lo schema legacy resta per contabilità/provenance (vedi audit).
-- Helper amministrativo privato, riutilizzabile per verificare scarto e guardia senza duplicare la logica.
create or replace function peppitness_private.retire_llm_import() returns void
language plpgsql security invoker set search_path = '' as $$
declare j record;
begin
  lock table public.import_jobs, public.import_drafts in share row exclusive mode;
  if exists (select 1 from public.import_jobs where status = 'running' and lease_expires_at > clock_timestamp()) then
    raise exception using errcode = 'PT409', message = 'Import analysis in progress';
  end if;
  update peppitness_private.import_budget_config
    set enabled = false, config_version = 'disabled/retired-llm-import'
    where singleton and (enabled or config_version <> 'disabled/retired-llm-import');
  for j in select owner_id, id from public.import_jobs where status <> 'expired'
    order by created_at, id for update
  loop
    perform peppitness_private.expire_import_content(j.owner_id, j.id);
  end loop;
  -- Vincoli differiti job <=> bozza verificati qui, come nella retention.
  set constraints public.import_jobs_result, public.import_drafts_result immediate;
  set constraints public.import_jobs_result, public.import_drafts_result deferred;
end;
$$;
revoke all on function peppitness_private.retire_llm_import() from public, anon, authenticated, service_role;
select peppitness_private.retire_llm_import();
