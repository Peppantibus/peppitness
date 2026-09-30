import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { prepareImportJob, parseServerJob } from '../../supabase/functions/_shared/import/jobs.ts'
import { importRpcNames, commitRpcArgs, validateImportJobResult } from '../../supabase/functions/_shared/import/contracts.ts'
import { commitFixtureRows, instantiateCommand } from './import-commit-fixtures.mjs'
import { importLocalSql, sqlLiteral as lit } from './import-local-db.mjs'

/**
 * Task 23. Retention reale sullo stack locale: scarto esplicito via HTTP con sessioni A/B e anonimo, lookup
 * di un job scaduto, cleanup mentre un commit reale è in volo (idempotenza e replay intatti) ed esecuzione del
 * job pg_cron registrato (pianificazione accelerata per la prova e poi ripristinata). SQL locale solo per
 * simulare il tempo trascorso, tenere aperta una transazione e leggere i metadati del job pianificato.
 */
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const profile = { promptVersion: 'fixture/1', provider: 'synthetic', model: 'synthetic', rulesVersion: 'retention-23/1' }
async function settle(promise) { try { return { ok: true, value: await promise } } catch (error) { return { ok: false, message: error.message } } }

export async function importRetentionApiChecks(context, a, b) {
  const { request, check, expectOk, expectDenied } = context
  const rpc = (name, body, token, admin = false) => request(`/rest/v1/rpc/${name}`, { method: 'POST', body, token, admin })
  const server = (name, body) => rpc(name, body, undefined, true)
  const row = (await commitFixtureRows()).find(item => item.id === 'diet-spec-example')

  async function readyJob(actor) {
    const args = await prepareImportJob(actor.id, { analysisRequestId: randomUUID(), kind: 'diet', expectedSchemaVersion: '1.0', normalizedDocument: row.document }, { ...profile, model: `m-${randomUUID()}` })
    let job = parseServerJob(expectOk(await server('create_import_job', args), 'import 23: job server'))
    job = parseServerJob(expectOk(await server('complete_import_job', { p_owner_id: actor.id, p_job_id: job.job.jobId, p_expected_revision: job.revision,
      p_lease_token: job.leaseToken, p_expected_draft_revision: job.draftRevision, p_result: { extraction: row.extraction, validationIssues: [],
        usageSummary: { providerCalls: 0, inputTokens: null, outputTokens: null, reasoningTokens: null, cached: false, costEstimate: null } } }), 'import 23: job pronto'))
    return job.job.jobId
  }
  const drafts = async (actor, jobId) => expectOk(await request(`/rest/v1/import_drafts?select=job_id&job_id=eq.${jobId}`, { token: actor.token }), 'import 23: lettura bozza').length
  const storedDrafts = async jobId => (await importLocalSql(`select count(*)::int as n from public.import_drafts where job_id = ${lit(jobId)}::uuid`))[0].n
  /** 7 giorni di inattività trascorsi: job e bozza con lo stesso istante (solo SQL locale, nessuna attesa). */
  const age = jobId => importLocalSql(`with t as materialized (select clock_timestamp() - interval '1 minute' as at),
    d as (update public.import_drafts set expires_at = (select at from t), revision = revision + 1 where job_id = ${lit(jobId)}::uuid returning 1),
    j as (update public.import_jobs set expires_at = (select at from t), revision = revision + 1 where id = ${lit(jobId)}::uuid returning 1)
    select (select count(*) from d)::int + (select count(*) from j)::int as done`)

  // 1. Scarto esplicito: B e anonimo non vedono né toccano il job di A; A lo scarta davvero, ripetibile.
  const discardable = await readyJob(a)
  check(expectOk(await rpc('discard_import_job', { p_job_id: discardable }, b.token), 'import 23: scarto di B') === null, 'import 23: B non scarta né riconosce il job di A')
  expectDenied(await rpc('discard_import_job', { p_job_id: discardable }), 'import 23: scarto anonimo respinto')
  check(await drafts(a, discardable) === 1, 'import 23: contenuto di A intatto dopo i tentativi altrui')
  const discarded = expectOk(await rpc('discard_import_job', { p_job_id: discardable }, a.token), 'import 23: scarto di A')
  check(validateImportJobResult(discarded).ok && discarded.status === 'expired' && discarded.extraction === null, 'import 23: scarto = job expired senza contenuto')
  check(expectOk(await rpc('discard_import_job', { p_job_id: discardable }, a.token), 'import 23: scarto ripetuto').status === 'expired', 'import 23: scarto idempotente')
  check(await storedDrafts(discardable) === 0 && await drafts(a, discardable) === 0, 'import 23: testi eliminati davvero dal database')
  check(expectOk(await rpc('get_import_job', { p_job_id: discardable }, a.token), 'import 23: lookup A').status === 'expired'
    && expectOk(await rpc('get_import_job', { p_job_id: discardable }, b.token), 'import 23: lookup B') === null, 'import 23: lookup expired per A, nulla per B')

  // 1b. Rinnovo per attività: solo A sul proprio job pronto, B non ottiene nulla, anonimo respinto.
  const renewable = await readyJob(a)
  await importLocalSql(`with t as materialized (select clock_timestamp() + interval '1 hour' as at),
    d as (update public.import_drafts set expires_at = (select at from t), revision = revision + 1 where job_id = ${lit(renewable)}::uuid returning 1),
    j as (update public.import_jobs set expires_at = (select at from t), revision = revision + 1 where id = ${lit(renewable)}::uuid returning 1)
    select (select count(*) from d)::int + (select count(*) from j)::int as done`)
  check(expectOk(await rpc('renew_import_job', { p_job_id: renewable }, b.token), 'import 23: rinnovo di B') === null, 'import 23: B non rinnova il job di A')
  expectDenied(await rpc('renew_import_job', { p_job_id: renewable }), 'import 23: rinnovo anonimo respinto')
  const renewed = expectOk(await rpc('renew_import_job', { p_job_id: renewable }, a.token), 'import 23: rinnovo di A')
  check(validateImportJobResult(renewed).ok && renewed.status === 'ready' && Date.parse(renewed.expiresAt) > Date.now() + 6 * 86_400_000, 'import 23: attività di A → scadenza fra 7 giorni')
  check(expectOk(await rpc('renew_import_job', { p_job_id: discardable }, a.token), 'import 23: rinnovo di un job scartato').status === 'expired', 'import 23: un job scartato non torna disponibile')

  // 2. Cleanup mentre un commit reale è in volo: la transazione aperta termina, il replay resta identico.
  const jobId = await readyJob(a)
  const command = instantiateCommand(row.command, { [row.command.provenance.analysis.jobId]: jobId })
  const held = settle(importLocalSql(`do $fixture$ begin
    perform set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: a.id, role: 'authenticated' }))}, true);
    perform public.commit_diet_import(${lit(command.requestId)}::uuid, ${lit(JSON.stringify(command.payload))}::jsonb,
      ${lit(JSON.stringify(command.provenance))}::jsonb, ${lit(JSON.stringify(command.selectionOptions))}::jsonb);
    perform pg_sleep(3);
  end $fixture$`))
  await pause(1200)
  await age(jobId)
  const [cleanup] = await importLocalSql('select peppitness_private.run_import_retention(500) as result')
  const committed = await held
  check(committed.ok && cleanup.result.status === 'succeeded', 'import 23: cleanup e commit concorrenti entrambi conclusi')
  check(await storedDrafts(jobId) === 0 && (await importLocalSql(`select status from public.import_jobs where id = ${lit(jobId)}::uuid`))[0].status === 'expired', 'import 23: contenuti del job eliminati')
  const receipt = expectOk(await rpc(importRpcNames.receipt, { p_request_id: command.requestId }, a.token), 'import 23: ricevuta dopo il cleanup')
  check(receipt?.resultState === 'committed', 'import 23: ricevuta conservata')
  check(isDeepStrictEqual(expectOk(await rpc(importRpcNames.diet, commitRpcArgs(command), a.token), 'import 23: replay dopo il cleanup'), receipt), 'import 23: replay = stessa ricevuta, nessuna copia')
  const late = await rpc(importRpcNames.diet, commitRpcArgs(instantiateCommand(row.command, { [row.command.provenance.analysis.jobId]: jobId })), a.token)
  check(late.status === 410 && late.data?.code === 'PT410', 'import 23: nuovo comando sul job scaduto → 410, nessuna scrittura')

  // 3. Job pianificato reale: registrato, eseguito da pg_cron (qui ogni 5 s) con esito tracciato, poi ripristinato.
  const [job] = await importLocalSql(`select jobid, schedule, command, active from cron.job where jobname = 'peppitness-import-retention'`)
  check(job?.active && job.schedule === '17 * * * *' && job.command === 'select peppitness_private.run_import_retention(500)', 'import 23: job pg_cron registrato e attivo')
  const overdue = await readyJob(b)
  await age(overdue)
  const [mark] = await importLocalSql('select clock_timestamp() as at')
  try {
    await importLocalSql(`select cron.alter_job(${Number(job.jobid)}, schedule := '5 seconds') as altered`)
    let run = null
    for (let attempt = 0; attempt < 30 && !run; attempt++) {
      await pause(1000)
      ;[run] = await importLocalSql(`select d.status, r.status as outcome, r.expired_jobs from cron.job_run_details d
        join peppitness_private.import_retention_runs r on r.started_at >= d.start_time and r.finished_at <= coalesce(d.end_time, clock_timestamp())
        where d.jobid = ${Number(job.jobid)} and d.start_time > ${lit(mark.at)}::timestamptz and d.status = 'succeeded' order by d.start_time limit 1`)
    }
    check(run?.status === 'succeeded' && run.outcome === 'succeeded', 'import 23: esecuzione pianificata reale tracciata (pg_cron + esito)')
    check(await storedDrafts(overdue) === 0, 'import 23: contenuto scaduto eliminato dal job pianificato')
  } finally {
    await importLocalSql('select peppitness_private.schedule_import_retention() as restored')
  }
  const [restored] = await importLocalSql(`select schedule, (select count(*)::int from cron.job where jobname = 'peppitness-import-retention') as jobs from cron.job where jobname = 'peppitness-import-retention'`)
  check(restored.schedule === '17 * * * *' && restored.jobs === 1, 'import 23: pianificazione oraria ripristinata, un solo job')
  const [status] = await importLocalSql('select peppitness_private.import_retention_status() as value')
  check(status.value.lastRun?.status === 'succeeded' && status.value.lastScheduledRun?.status === 'succeeded', 'import 23: stato di monitoraggio con ultimo esito')
}
