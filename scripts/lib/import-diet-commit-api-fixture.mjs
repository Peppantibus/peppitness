import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { prepareImportJob, parseServerJob } from '../../supabase/functions/_shared/import/jobs.ts'
import { validateImportReceipt, receiptMismatches, importRpcNames, commitRpcArgs } from '../../supabase/functions/_shared/import/contracts.ts'
import { commandHash } from '../../supabase/functions/_shared/import/canonical.ts'
import { commitFixtureRows, instantiateCommand } from './import-commit-fixtures.mjs'
import { importLocalSql, sqlLiteral as lit } from './import-local-db.mjs'

/**
 * Task 20. commit_diet_import via HTTP con sessioni reali A/B e anonimo; comandi del mapper 10 con
 * UUID nuovi a ogni esecuzione e job pronti creati dalle API server 14. Solo per tenere aperta una
 * transazione concorrente la RPC reale è invocata via SQL locale con il JWT dell'utente.
 */
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const profile = { promptVersion: 'fixture/1', provider: 'synthetic', model: 'synthetic', rulesVersion: 'commit-diet/1' }
const bytes = value => new TextEncoder().encode(JSON.stringify(value)).length

async function settle(promise) {
  try { return { ok: true, value: await promise } } catch (error) { return { ok: false, message: error.message } }
}

/** Documento con JSON compatto UTF-8 di esattamente `target` byte (pasti con note a 4 byte per carattere). */
function sized(command, target) {
  const copy = structuredClone(command), document = copy.payload.resolved.plan.document
  document.guidance = ''
  for (let n = 1; n <= 11; n++) {
    document.days[0].meals.push({ id: randomUUID(), name: `Pasto ${n}`, time: '', foods: [], alternatives: ['Frutta'], additions: [], note: '😀'.repeat(4000) })
  }
  const missing = target - bytes(document)
  if (missing < 0 || missing > 16000) throw new Error('Documento di prova fuori misura.')
  document.guidance = 'è'.repeat(Math.floor(missing / 2)) + 'a'.repeat(missing % 2)
  return copy
}

export async function importDietCommitApiChecks(context, a, b) {
  const { request, check, expectOk, expectDenied, concurrentRequests, isRevisionConflict } = context
  const rpc = (name, body, token, admin = false) => request(`/rest/v1/rpc/${name}`, { method: 'POST', body, token, admin })
  const server = (name, body) => rpc(name, body, undefined, true)
  const commit = (command, token) => rpc(importRpcNames.diet, commitRpcArgs(command), token)
  const receipt = (requestId, token) => rpc(importRpcNames.receipt, { p_request_id: requestId }, token)
  const rows = Object.fromEntries((await commitFixtureRows()).map(row => [row.id, row]))
  const isCode = (result, sqlstate, message) => !result.ok && result.data?.code === sqlstate && (message === undefined || result.data?.message === message)
  const list = async (path, actor) => expectOk(await request(path, { token: actor.token }), `import 20: lettura ${path.split('?')[0]}`)
  const plans = async actor => (await list('/rest/v1/meal_plans?select=id', actor)).map(row => row.id)
  const selection = async actor => (await list('/rest/v1/active_plans?select=revision,workout_plan_id,meal_plan_id', actor))[0] ?? null
  const logs = async actor => list('/rest/v1/meal_logs?select=id,meal_id,meal_plan_id,status,note,day_type,meal_snapshot,revision&order=id', actor)

  async function readyJob(actor, row) {
    const args = await prepareImportJob(actor.id, { analysisRequestId: randomUUID(), kind: row.kind, expectedSchemaVersion: '1.0', normalizedDocument: row.document }, profile)
    let job = parseServerJob(expectOk(await server('create_import_job', args), 'import 20: job server'))
    if (job.job.status !== 'ready') {
      job = parseServerJob(expectOk(await server('complete_import_job', { p_owner_id: actor.id, p_job_id: job.job.jobId, p_expected_revision: job.revision,
        p_lease_token: job.leaseToken, p_expected_draft_revision: job.draftRevision, p_result: { extraction: row.extraction, validationIssues: [],
          usageSummary: { providerCalls: job.attemptCount, inputTokens: null, outputTokens: null, reasoningTokens: null, cached: false, costEstimate: null } } }),
      'import 20: job pronto'))
    }
    return job.job.jobId
  }
  const held = (actor, command, seconds) => settle(importLocalSql(`do $fixture$ begin
    perform set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: actor.id, role: 'authenticated' }))}, true);
    perform public.commit_diet_import(${lit(command.requestId)}::uuid, ${lit(JSON.stringify(command.payload))}::jsonb,
      ${lit(JSON.stringify(command.provenance))}::jsonb, ${lit(JSON.stringify(command.selectionOptions))}::jsonb);
    perform pg_sleep(${Number(seconds)});
  end $fixture$`))

  const row = rows['diet-reviewed-conditions'], other = rows['diet-alternatives-additions']
  const jobs = { a: { row: await readyJob(a, row), other: await readyJob(a, other) }, b: { row: await readyJob(b, row) } }
  const commandFor = (actor, source = row, options) => {
    const command = instantiateCommand(source.command, { [source.command.provenance.analysis.jobId]: jobs[actor][source === row ? 'row' : 'other'] })
    if (options) command.selectionOptions = options
    return command
  }
  const logsBefore = await logs(a)

  // Anonimo, account altrui e comandi non conformi: nessuna scrittura.
  const first = commandFor('a')
  expectDenied(await commit(first), 'import 20: anonimo respinto')
  expectDenied(await commit(first, b.token), 'import 20: B non usa il job di A')
  const extra = commandFor('a'); extra.payload.resolved.plan.document.calories = 1800
  check(isCode(await commit(extra, a.token), '22023', 'Invalid import command'), 'import 20: documento con proprietà estranea 22023')
  const unresolved = commandFor('a'); unresolved.payload.resolved.plan.document.days[0].dayType = null
  check(isCode(await commit(unresolved, a.token), '22023', 'Invalid import command'), 'import 20: tipo di giornata non risolto 22023')
  check(!(await plans(a)).some(id => [first, extra, unresolved].some(c => c.payload.resolved.plan.id === id)), 'import 20: rifiuti senza piani')

  // Commit reale: ricevuta valida, documento salvato identico al mapping 10.
  const hash = await commandHash(first)
  const saved = expectOk(await commit(first, a.token), 'import 20: commit A')
  check(validateImportReceipt(saved).ok && receiptMismatches(saved, first, hash).length === 0 && saved.resultState === 'committed'
    && saved.contentHash === row.contentHash && saved.selection === null, 'import 20: ricevuta valida, hash coerenti col comando')
  const [plan] = await list(`/rest/v1/meal_plans?select=name,document,revision&id=eq.${first.payload.resolved.plan.id}`, a)
  // row.expected = golden 10 (UUID del corpus); la copia per l'account cambia solo gli UUID.
  check(plan && isDeepStrictEqual({ name: plan.name, document: plan.document }, { name: first.payload.resolved.plan.name, document: first.payload.resolved.plan.document })
    && isDeepStrictEqual(JSON.parse(JSON.stringify(plan.document).replace(/[0-9a-f-]{36}/g, '')), JSON.parse(JSON.stringify(row.expected.document).replace(/[0-9a-f-]{36}/g, '')))
    && plan.revision === 1,
    'import 20: alternative, aggiunte, condizioni e quantità identiche al mapping')
  check(isDeepStrictEqual(expectOk(await receipt(first.requestId, a.token), 'import 20: lookup'), saved), 'import 20: risposta persa, lookup = stessa ricevuta')
  check(expectOk(await receipt(first.requestId, b.token), 'import 20: lookup B') === null
    && (await list(`/rest/v1/meal_plans?select=id&id=eq.${first.payload.resolved.plan.id}`, b)).length === 0, 'import 20: B non vede ricevuta e piano di A')

  // Replay concorrente e stessa chiave con comando diverso.
  const count = (await plans(a)).length
  const replays = await concurrentRequests([commit(first, a.token), commit(first, a.token)])
  check(replays.every(x => x.ok && isDeepStrictEqual(x.data, saved)) && (await plans(a)).length === count, 'import 20: doppio invio, stessa ricevuta e un solo piano')
  const changed = structuredClone(first); changed.payload.resolved.plan.name = 'Nome diverso'
  check(isRevisionConflict(await commit(changed, a.token)), 'import 20: stessa chiave, payload diverso HTTP 409')
  const copy = expectOk(await commit(commandFor('a'), a.token), 'import 20: copia esplicita')
  check(copy.contentHash === saved.contentHash && copy.planId !== saved.planId, 'import 20: stesso contenuto con nuova chiave, nuovo piano')

  // Limiti reali: 180000 byte compatti accettati, 180001 respinti; jsonb testuale entro 256 KiB.
  const large = sized(commandFor('a'), 180_000), tooLarge = sized(commandFor('a'), 180_001)
  check(bytes(large.payload.resolved.plan.document) === 180_000 && bytes(tooLarge.payload.resolved.plan.document) === 180_001, 'import 20: documenti di prova misurati')
  expectOk(await commit(large, a.token), 'import 20: 180000 byte accettati')
  check(isCode(await commit(tooLarge, a.token), '22023', 'Invalid import command') && !(await plans(a)).includes(tooLarge.payload.resolved.plan.id), 'import 20: 180001 byte respinti')
  const [stored] = await list(`/rest/v1/meal_plans?select=document&id=eq.${large.payload.resolved.plan.id}`, a)
  check(isDeepStrictEqual(stored.document, large.payload.resolved.plan.document), 'import 20: documento grande salvato identico')

  // Selezione: revisione vista, sezione scheda preservata; due follow concorrenti, uno solo vince.
  const before = await selection(a)
  const follower = commandFor('a', row, { follow: true, expectedActiveRevision: before?.revision ?? null })
  const rival = commandFor('a', other, { follow: true, expectedActiveRevision: before?.revision ?? null })
  const race = await concurrentRequests([commit(follower, a.token), commit(rival, a.token)])
  const winner = race[0].ok ? follower : rival, loser = race[0].ok ? rival : follower
  const after = await selection(a)
  check(race.filter(x => x.ok).length === 1 && race.some(x => isCode(x, 'PT409', 'Active selection conflict'))
    && after.revision === (before?.revision ?? 0) + 1 && after.meal_plan_id === winner.payload.resolved.plan.id
    && after.workout_plan_id === (before?.workout_plan_id ?? null) && !(await plans(a)).includes(loser.payload.resolved.plan.id),
    'import 20: follow concorrenti, uno solo cambia meal_plan_id e la scheda resta')
  check(isDeepStrictEqual(expectOk(await commit(winner, a.token), 'import 20: replay follow'), race.find(x => x.ok).data), 'import 20: replay dopo il follow, stessa ricevuta')

  // Selezione assente creata in concorrenza: il perdente fallisce dopo l'inserimento del piano.
  await importLocalSql(`do $fixture$ begin delete from public.active_plans where owner_id = ${lit(b.id)}; end $fixture$`)
  const bFollowers = [commandFor('b', row, { follow: true, expectedActiveRevision: null }), commandFor('b', row, { follow: true, expectedActiveRevision: null })]
  const holdFollow = held(b, bFollowers[0], 2)
  await pause(900)
  const late = await commit(bFollowers[1], b.token)
  const bSelection = await selection(b)
  check((await holdFollow).ok && isCode(late, 'PT409', 'Active selection conflict') && bSelection?.revision === 1
    && bSelection.meal_plan_id === bFollowers[0].payload.resolved.plan.id && bSelection.workout_plan_id === null
    && !(await plans(b)).includes(bFollowers[1].payload.resolved.plan.id)
    && expectOk(await receipt(bFollowers[1].requestId, b.token), 'import 20: lookup perdente') === null, 'import 20: conflitto tardivo annulla piano e ricevuta')

  // Diario: registrazione sul piano importato; storico precedente intatto; eliminazione e tombstone.
  const meal = winner.payload.resolved.plan.document.days[0].meals[0]
  expectOk(await request('/rest/v1/meal_logs', { method: 'POST', token: a.token, body: { diary_date: '2026-10-02', meal_id: meal.id,
    meal_plan_id: winner.payload.resolved.plan.id, status: 'followed', note: '', day_type: 'training', meal_snapshot: { id: meal.id, name: meal.name } } }),
  'import 20: pasto registrato sul piano importato')
  const [deleted, looked] = await concurrentRequests([rpc('delete_meal_plans', { p_plan_id: winner.payload.resolved.plan.id }, a.token), receipt(winner.requestId, a.token)])
  check(expectOk(deleted, 'import 20: piano importato eliminato') === 1 && ['committed', 'deleted'].includes(expectOk(looked, 'import 20: lookup concorrente')?.resultState),
    'import 20: lookup durante l\'eliminazione vede committed o deleted')
  check(expectOk(await commit(winner, a.token), 'import 20: vecchio retry').resultState === 'deleted' && !(await plans(a)).includes(winner.payload.resolved.plan.id),
    'import 20: tombstone, vecchio retry senza ricreazione')
  const logsAfter = await logs(a)
  check(logsAfter.length === logsBefore.length + 1 && logsBefore.every(log => logsAfter.some(x => isDeepStrictEqual(x, log)))
    && logsAfter.some(log => log.meal_plan_id === winner.payload.resolved.plan.id), 'import 20: diario precedente intatto, registrazione conservata dopo l\'eliminazione')

  // Job scaduto dopo la preparazione del comando (bootstrap SQL della scadenza): errore chiaro, nessun piano.
  const stale = commandFor('a', other)
  await importLocalSql(`do $fixture$ begin
    update public.import_drafts set expires_at = now() - interval '1 second', revision = revision + 1 where job_id = ${lit(jobs.a.other)};
    update public.import_jobs set expires_at = now() - interval '1 second', revision = revision + 1 where id = ${lit(jobs.a.other)};
  end $fixture$`)
  const expired = await commit(stale, a.token)
  check(isCode(expired, 'PT410', 'Import analysis expired') && expired.status === 410 && !(await plans(a)).includes(stale.payload.resolved.plan.id),
    'import 20: job scaduto, HTTP 410 senza scritture')

  // Eliminazione di tutti i piani con un import in corso: committed se e solo se il piano esiste.
  const racing = commandFor('a')
  const holdRacing = held(a, racing, 2)
  await pause(900)
  const removed = await rpc('delete_meal_plans', { p_plan_id: null }, a.token)
  check((await holdRacing).ok && removed.ok, 'import 20: eliminazione e import concorrenti completati')
  const alive = new Set(await plans(a))
  const receipts = expectOk(await request('/rest/v1/import_receipts?select=result_state,plan_id&kind=eq.diet', { token: a.token }), 'import 20: ricevute A')
  check(receipts.length > 0 && receipts.every(r => (r.result_state === 'committed') === alive.has(r.plan_id)) && alive.has(racing.payload.resolved.plan.id),
    'import 20: committed se e solo se il piano esiste')
}
