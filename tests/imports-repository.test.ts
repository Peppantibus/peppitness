import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { commitFixtureCases } from '../scripts/lib/import-commit-fixtures.mjs'
import type { CommitCommand, ImportJobResult, ImportReceipt } from '../src/import/contracts/index.ts'
import { commandHash, contentHash } from '../src/import/mapping/canonical.ts'
import {
  commitFailure, CommitRejected, createImportsRepository, IMPORT_ANALYSIS_TIMEOUT_MS, ImportsFailure,
} from '../src/persistence/imports-repository.ts'

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const JOB = '33333333-3333-4333-8333-333333333333'
const REQUEST = '44444444-4444-4444-8444-444444444444'
const fixture = (path: string) => JSON.parse(readFileSync(new URL(`./fixtures/import/${path}`, import.meta.url), 'utf8'))
const document = fixture('documents/workout-incomplete.json')
const extraction = fixture('extractions/workout-incomplete.json')
const cases = commitFixtureCases() as { id: string; kind: 'workout' | 'diet'; command: CommitCommand }[]
const workoutCommand = cases.find(item => item.id === 'workout-catalog')!.command
const dietCommand = cases.find(item => item.kind === 'diet')!.command

const readyJob = (patch: Partial<ImportJobResult> = {}): ImportJobResult => ({
  jobId: JOB, analysisRequestId: REQUEST, kind: 'workout', status: 'ready', extraction, validationIssues: [],
  usageSummary: { providerCalls: 1, inputTokens: 10, outputTokens: 10, reasoningTokens: null, cached: false, costEstimate: null },
  error: null, expiresAt: '2026-10-07T10:00:00.000Z', ...patch,
})
async function receiptFor(command: CommitCommand, patch: Partial<ImportReceipt> = {}): Promise<ImportReceipt> {
  const planId = command.payload.kind === 'workout' ? command.payload.resolved.planId : command.payload.resolved.plan.id
  return {
    requestId: command.requestId, kind: command.payload.kind, commandHash: await commandHash(command), contentHash: await contentHash(command.payload),
    resultState: 'committed', planId, versionId: command.payload.kind === 'workout' ? command.payload.resolved.versionId : null,
    exerciseBindings: command.payload.kind === 'workout' ? command.payload.resolved.catalog.map(binding => ({
      ref: binding.ref, exerciseId: binding.choice.source === 'existing' ? binding.ref : '55555555-5555-4555-8555-555555555555',
      resolution: binding.choice.source === 'existing' ? 'existing' as const : binding.choice.source === 'shared' ? 'adopted' as const : 'created' as const,
    })) : [],
    selection: null, ...patch,
  }
}

interface Call { kind: 'rpc' | 'from' | 'invoke'; name: string; args?: unknown; filters: [string, string, unknown][]; headers: Record<string, string>; retry: boolean | null; signal: AbortSignal | null }
type Reply = { data: unknown; error: { code?: string; message?: string } | null } | Promise<{ data: unknown; error: { code?: string; message?: string } | null }>

/** Client Supabase simulato: registra intestazioni, retry, segnale e filtri; risponde con `reply`. */
function fakeClient(options: { user?: string | null; reply?: (call: Call) => Reply; invoke?: (call: Call) => Promise<unknown> }) {
  const calls: Call[] = []
  const builder = (call: Call) => {
    const chain: Record<string, unknown> = {
      setHeader(name: string, value: string) { call.headers[name] = value; return chain },
      abortSignal(signal: AbortSignal) { call.signal = signal; return chain },
      retry(value: boolean) { call.retry = value; return chain },
      then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
        return Promise.resolve(options.reply?.(call) ?? { data: null, error: null }).then(resolve, reject)
      },
    }
    for (const method of ['select', 'order', 'limit', 'maybeSingle']) chain[method] = () => chain
    for (const method of ['eq', 'not']) chain[method] = (column: string, ...rest: unknown[]) => { call.filters.push([method, column, rest.at(-1)]); return chain }
    return chain
  }
  const client = {
    auth: { getSession: async () => ({ data: { session: options.user === null ? null : { access_token: 'token-a', user: { id: options.user ?? OWNER } } }, error: null }) },
    rpc: (name: string, args: unknown) => { const call: Call = { kind: 'rpc', name, args, filters: [], headers: {}, retry: null, signal: null }; calls.push(call); return builder(call) },
    from: (name: string) => { const call: Call = { kind: 'from', name, filters: [], headers: {}, retry: null, signal: null }; calls.push(call); return builder(call) },
    functions: {
      invoke: (name: string, invoke: { body: unknown; headers: Record<string, string>; signal: AbortSignal }) => {
        const call: Call = { kind: 'invoke', name, args: invoke.body, filters: [], headers: invoke.headers, retry: null, signal: invoke.signal }
        calls.push(call)
        return options.invoke!(call)
      },
    },
  }
  return { client: client as unknown as SupabaseClient, calls }
}
const signal = () => new AbortController().signal
const httpError = (status: number, body: unknown) => ({
  data: null, error: Object.assign(new Error('http'), { name: 'FunctionsHttpError' }),
  response: new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
})

test('21: sessione catturata per account; Authorization esplicita, retry SDK spento e segnale sempre passato', async () => {
  const { client, calls } = fakeClient({ user: OTHER })
  const repository = createImportsRepository(client, OWNER)
  await assert.rejects(repository.getReceipt(REQUEST, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'session')
  await assert.rejects(repository.commitWorkout(workoutCommand as never, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'session')
  assert.equal(calls.length, 0, 'nessuna richiesta con la sessione di un altro account')

  const receipt = await receiptFor(workoutCommand)
  const ok = fakeClient({ reply: call => call.name === 'commit_workout_import' ? { data: receipt, error: null } : { data: null, error: null } })
  const own = createImportsRepository(ok.client, OWNER)
  assert.deepEqual(await own.commitWorkout(workoutCommand as never, signal()), receipt)
  const [call] = ok.calls
  assert.deepEqual([call!.name, call!.headers.Authorization, call!.retry, call!.signal instanceof AbortSignal], ['commit_workout_import', 'Bearer token-a', false, true])
  assert.deepEqual(call!.args, { p_request_id: workoutCommand.requestId, p_resolved_payload: workoutCommand.payload, p_provenance: workoutCommand.provenance, p_selection_options: workoutCommand.selectionOptions })
  assert.equal(await own.getReceipt(REQUEST, signal()), null)
  assert.deepEqual([ok.calls[1]!.name, ok.calls[1]!.args, ok.calls[1]!.retry], ['get_import_receipt', { p_request_id: REQUEST }, false])
})

test('21: esiti delle RPC di conferma — rifiuti certi, sessione, esito incerto', async () => {
  const cases: [{ code?: string; message?: string } | null, string][] = [
    [{ code: 'PT410', message: 'Import analysis expired' }, 'analysis_expired'],
    [{ code: 'PT409', message: 'Import request conflict' }, 'request_conflict'],
    [{ code: 'PT409', message: 'Active selection conflict' }, 'selection_conflict'],
    [{ code: 'PT409', message: 'Catalog changed' }, 'catalog_conflict'],
    [{ code: '22023', message: 'Invalid import command' }, 'invalid_command'],
    [{ code: '42501', message: 'Import reference not available' }, 'not_available'],
    [{ code: '42501', message: 'Authentication required' }, 'session'],
    [{ code: '', message: 'TypeError: fetch failed' }, 'uncertain'],
    [{ code: 'PGRST301', message: 'gateway' }, 'uncertain'],
    [null, 'uncertain'],
  ]
  for (const [error, expected] of cases) {
    const failure = commitFailure(error)
    assert.equal(failure instanceof CommitRejected ? failure.reason : failure.kind, expected, JSON.stringify(error))
  }
  // Una 2xx con una ricevuta non conforme non vale come salvato: si verifica con la ricevuta.
  const { client } = fakeClient({ reply: () => ({ data: { requestId: REQUEST }, error: null }) })
  await assert.rejects(createImportsRepository(client, OWNER).commitDiet(dietCommand as never, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'uncertain')
  // Annullamento voluto (logout) ≠ tempo scaduto (esito incerto).
  const hanging = fakeClient({ reply: call => new Promise(resolve => call.signal!.addEventListener('abort', () => resolve({ data: null, error: { code: '20', message: 'AbortError' } }))) })
  const controller = new AbortController()
  const pending = createImportsRepository(hanging.client, OWNER).commitDiet(dietCommand as never, controller.signal)
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(pending, (error: unknown) => error instanceof ImportsFailure && error.kind === 'aborted')
})

test('21: analisi — job 200/202 validati, errori del contratto come valori, rete/relay/corpo estraneo incerti', async () => {
  const request = { analysisRequestId: REQUEST, kind: 'workout' as const, normalizedDocument: document, expectedSchemaVersion: '1.0' as const }
  let reply: (call: Call) => Promise<unknown> = async () => ({ data: readyJob(), error: null, response: new Response(null, { status: 200 }) })
  const { client, calls } = fakeClient({ invoke: call => reply(call) })
  const repository = createImportsRepository(client, OWNER)
  assert.deepEqual(await repository.analyze(request, signal()), { ok: true, job: readyJob() })
  assert.deepEqual([calls[0]!.name, calls[0]!.headers.Authorization, calls[0]!.args], ['extract-plan', 'Bearer token-a', request])
  assert.ok(IMPORT_ANALYSIS_TIMEOUT_MS > 140_000, 'timeout del client oltre la scadenza del server')

  reply = async () => ({ data: readyJob({ status: 'running', extraction: null, usageSummary: { ...readyJob().usageSummary, providerCalls: 0 } }), error: null })
  assert.equal(((await repository.analyze(request, signal())) as { job: ImportJobResult }).job.status, 'running')
  for (const [status, code] of [[429, 'budget_exhausted'], [413, 'limit_exceeded'], [503, 'provider_unavailable'], [409, 'request_conflict'], [401, 'unauthenticated']] as const) {
    const error = { code, message: 'Messaggio sicuro.', retryable: false, limit: code === 'limit_exceeded' ? { limit: 'providerCallsPerAnalysis', max: 2, actual: 3 } : null }
    reply = async () => httpError(status, { error })
    assert.deepEqual(await repository.analyze(request, signal()), { ok: false, status, error })
  }
  for (const uncertain of [
    async () => httpError(502, '<html>bad gateway</html>'),
    async () => ({ data: null, error: Object.assign(new Error('relay'), { name: 'FunctionsRelayError' }), response: new Response('{}', { status: 200 }) }),
    async () => ({ data: null, error: Object.assign(new Error('fetch'), { name: 'FunctionsFetchError' }) }),
    async () => ({ data: { jobId: JOB }, error: null }),
  ]) {
    reply = uncertain
    await assert.rejects(repository.analyze(request, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'uncertain')
  }
})

test('21: letture di job, fonte, compatibili e duplicati validate e limitate all’account', async () => {
  const job = readyJob()
  const receipt = await receiptFor(workoutCommand)
  const { client, calls } = fakeClient({
    reply: call => {
      if (call.name === 'get_import_job') return { data: (call.args as { p_job_id: string }).p_job_id === JOB ? job : null, error: null }
      if (call.name === 'import_jobs') return { data: { id: JOB, owner_id: OWNER, analysis_request_id: REQUEST }, error: null }
      if (call.name === 'import_drafts' && call.filters.some(([, column]) => column === 'job_id')) return { data: { job_id: JOB, owner_id: OWNER, normalized_document: document, expires_at: job.expiresAt }, error: null }
      if (call.name === 'import_drafts') return { data: [{ job_id: JOB, owner_id: OWNER }], error: null }
      if (call.name === 'import_receipts') return { data: [{ owner_id: OWNER, request_id: receipt.requestId, kind: 'workout', plan_id: receipt.planId, version_id: receipt.versionId, result_state: 'committed', created_at: '2026-09-30T10:00:00Z' }], error: null }
      return { data: null, error: null }
    },
  })
  const repository = createImportsRepository(client, OWNER)
  assert.deepEqual(await repository.findJob(REQUEST, signal()), job)
  assert.deepEqual(calls[0]!.filters, [['eq', 'owner_id', OWNER], ['eq', 'analysis_request_id', REQUEST]])
  assert.equal((await repository.readDraft(JOB, signal()))?.document.sourceHash, document.sourceHash)
  assert.deepEqual((await repository.findCompatibleAnalysis({ kind: 'workout', sourceHash: document.sourceHash, readerVersion: document.readerVersion }, signal())).map(item => item.jobId), [JOB])
  const compatible = calls.find(call => call.name === 'import_drafts' && call.filters.some(([, column]) => column === 'normalized_document->>sourceHash'))!
  assert.deepEqual(compatible.filters.map(([, column]) => column), ['owner_id', 'normalized_document->>sourceHash', 'normalized_document->>readerVersion', 'extraction'])
  assert.deepEqual(await repository.findCompatibleAnalysis({ kind: 'diet', sourceHash: document.sourceHash, readerVersion: document.readerVersion }, signal()), [], 'stessa fonte, altro dominio: nessuna riapertura')
  assert.deepEqual(await repository.findDuplicate({ kind: 'workout', contentHash: receipt.contentHash }, signal()), [{ requestId: receipt.requestId, planId: receipt.planId, versionId: receipt.versionId, createdAt: '2026-09-30T10:00:00Z' }])
  assert.ok(calls.every(call => call.headers.Authorization === 'Bearer token-a' && call.retry === false && call.signal))

  // Righe di un altro account o risposte fuori contratto: mai accettate.
  const foreign = fakeClient({ reply: call => call.name === 'import_receipts' ? { data: [{ owner_id: OTHER, request_id: REQUEST, kind: 'workout', plan_id: JOB, version_id: JOB, result_state: 'committed', created_at: '2026-09-30T10:00:00Z' }], error: null }
    : call.name === 'get_import_receipt' ? { data: { ...receipt, requestId: JOB }, error: null } : { data: { ...job, status: 'ready', extraction: null }, error: null } })
  const guarded = createImportsRepository(foreign.client, OWNER)
  await assert.rejects(guarded.findDuplicate({ kind: 'workout', contentHash: receipt.contentHash }, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'invalid_response')
  await assert.rejects(guarded.getReceipt(REQUEST, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'invalid_response')
  await assert.rejects(guarded.readJob(JOB, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'invalid_response')
  const failing = createImportsRepository(fakeClient({ reply: () => ({ data: null, error: { code: '', message: 'fetch failed' } }) }).client, OWNER)
  await assert.rejects(failing.getReceipt(REQUEST, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'unavailable', 'una lettura fallita non è un esito incerto')
})

test('23: scarto esplicito — job proprio expired, analisi in corso non scartabile, sessione di un altro account rifiutata', async () => {
  const expired = readyJob({ status: 'expired', extraction: null, usageSummary: readyJob().usageSummary })
  let reply: Reply = { data: expired, error: null }
  const { client, calls } = fakeClient({ reply: () => reply })
  const repository = createImportsRepository(client, OWNER)
  assert.equal(await repository.discardAnalysis(JOB, signal()), true)
  assert.deepEqual([calls[0]!.name, calls[0]!.args, calls[0]!.headers.Authorization, calls[0]!.retry], ['discard_import_job', { p_job_id: JOB }, 'Bearer token-a', false])
  reply = { data: null, error: { code: 'PT409', message: 'Import analysis in progress' } }
  assert.equal(await repository.discardAnalysis(JOB, signal()), false)
  reply = { data: null, error: null }
  assert.equal(await repository.discardAnalysis(JOB, signal()), true, 'già assente: nulla da scartare')
  reply = { data: readyJob(), error: null }
  await assert.rejects(repository.discardAnalysis(JOB, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'invalid_response', 'un job ancora pronto non vale come scartato')
  await assert.rejects(createImportsRepository(fakeClient({ user: OTHER }).client, OWNER).discardAnalysis(JOB, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'session')
})

test('23: rinnovo per attività — job proprio validato, altrui null, risposta di un altro job rifiutata', async () => {
  let reply: Reply = { data: readyJob(), error: null }
  const { client, calls } = fakeClient({ reply: () => reply })
  const repository = createImportsRepository(client, OWNER)
  assert.deepEqual(await repository.renewAnalysis(JOB, signal()), readyJob())
  assert.deepEqual([calls[0]!.name, calls[0]!.args, calls[0]!.retry], ['renew_import_job', { p_job_id: JOB }, false])
  reply = { data: null, error: null }
  assert.equal(await repository.renewAnalysis(JOB, signal()), null)
  reply = { data: readyJob({ jobId: REQUEST }), error: null }
  await assert.rejects(repository.renewAnalysis(JOB, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'invalid_response')
})
