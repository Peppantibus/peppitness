import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  resolveImportLimits, validateExtraction, validateImportJobResult, validateNormalizedDocument,
  type ImportJobResult, type NormalizedDocument, type SourceBlock, type WorkoutExtraction,
} from '../supabase/functions/_shared/import/contracts.ts'
import { createBudgetAdapter } from '../supabase/functions/_shared/import/budget.ts'
import { createJobsAdapter, type JobServerRpcName } from '../supabase/functions/_shared/import/jobs.ts'
import { ServerRpcError } from '../supabase/functions/_shared/import/analysis.ts'
import { createOpenAIProvider } from '../supabase/functions/_shared/import/openai-provider.ts'
import { IMPORT_PROMPT_VERSION } from '../supabase/functions/_shared/import/prompts.ts'
import type { ProviderTransport } from '../supabase/functions/_shared/import/provider.ts'
import { mergeSegmentExtractions, planSegments, type DocumentSegment } from '../supabase/functions/_shared/import/segments.ts'
import { ANALYSIS_RULES_VERSION, isLocalSupabaseUrl, readServerConfig, type ServerConfig, type ServerEnv } from '../supabase/functions/_shared/import/server-config.ts'
import { createSyntheticTransport, syntheticMarkers } from '../supabase/functions/_shared/import/synthetic-transport.ts'
import { createExtractPlanHandler, type ExtractPlanDeps } from '../supabase/functions/extract-plan/handler.ts'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const TOKENS: Record<string, string> = { 'token-a': A, 'token-b': B }
const API_KEY = 'sk-synthetic-handler-secret'
const MODEL = 'synthetic-edge-2026-01-01'
const readJson = <T>(path: string): T => JSON.parse(readFileSync(`tests/fixtures/import/${path}`, 'utf8')) as T

// ---------------------------------------------------------------------------
// Documenti sintetici
// ---------------------------------------------------------------------------

function block(id: string, kind: SourceBlock['kind'], text: string, extra: Partial<SourceBlock> = {}): SourceBlock {
  return { id, kind, text, page: null, tableId: null, row: null, column: null, rowSpan: null, columnSpan: null, parentId: null, headingIds: [], origin: 'native', bbox: null, ...extra }
}
const hash = 'a'.repeat(64)
/** Titolo, preambolo e N sezioni «Seduta X», ognuna con una tabella di righe e celle. */
function sectionedDocument(sections: number, rowsPerSection = 2, filler = ''): NormalizedDocument {
  const blocks: SourceBlock[] = [block('p:0', 'paragraph', 'Scheda sintetica a sezioni'), block('p:1', 'paragraph', 'Regola generale: recupero 90 secondi salvo diversa indicazione.')]
  for (let s = 0; s < sections; s++) {
    const heading = `h:${s}`
    blocks.push(block(heading, 'heading', `Seduta ${String.fromCharCode(65 + s)}`))
    const table = `t:${s}`
    for (let r = 0; r <= rowsPerSection; r++) {
      const cells = r === 0 ? ['Esercizio', 'Serie'] : [`Esercizio ${s}-${r}${filler}`, '3 x 10']
      const row = `${table}:r:${r}`
      blocks.push(block(row, 'table_row', cells.join(' | '), { tableId: table, row: r, headingIds: [heading] }))
      cells.forEach((text, c) => blocks.push(block(`${row}:c:${c}`, 'table_cell', text, { tableId: table, row: r, column: c, parentId: row, headingIds: [heading] })))
    }
  }
  const document = { readerVersion: 'synthetic-fixture/1', sourceHash: hash, blocks, readingIssues: [] }
  assert.equal(validateNormalizedDocument(document).ok, true)
  return document
}
const request = (document: NormalizedDocument, id = crypto.randomUUID(), kind: 'workout' | 'diet' = 'workout') =>
  ({ analysisRequestId: id, kind, normalizedDocument: document, expectedSchemaVersion: '1.0' })
function marked(marker: string): NormalizedDocument {
  const document = sectionedDocument(1)
  document.blocks[1] = { ...document.blocks[1]!, text: `Nota di prova ${marker}` }
  return document
}

// ---------------------------------------------------------------------------
// Backend RPC in memoria: stesse regole osservabili di jobs (14) e budget (15)
// ---------------------------------------------------------------------------

interface Job {
  id: string; owner: string; requestId: string; kind: string; inputHash: string; normalizedHash: string; versions: Record<string, string>; document: unknown
  status: ImportJobResult['status']; attempts: number; outcome: string; lease: string | null; leaseExpires: number | null; revision: number; draftRevision: number
  extraction: unknown; issues: unknown[]; error: unknown; cached: boolean
}
interface Ledger { id: string; owner: string; job: string; state: string; attempt: number | null; hash: string; bytes: number; maxOut: number; notBefore: number }
class Backend {
  jobs = new Map<string, Job>()
  ledger = new Map<string, Ledger>()
  config: Record<string, unknown> = { enabled: true, provider: 'openai', model: MODEL, max_attempts: 2, max_input_tokens: 200_000, max_output_tokens: 16_000, framing_tokens: 256 }
  failNext: Record<string, [string, string]> = {}
  clock: { now: number }
  constructor(clock: { now: number }) { this.clock = clock }
  private raise(code: string, message: string): never { throw new ServerRpcError(code, message) }
  private result(job: Job): ImportJobResult {
    return {
      jobId: job.id, analysisRequestId: job.requestId, kind: job.kind as 'workout', status: job.status,
      extraction: job.status === 'ready' ? job.extraction as WorkoutExtraction : null, validationIssues: job.status === 'ready' ? job.issues as [] : [],
      usageSummary: { providerCalls: job.attempts, inputTokens: null, outputTokens: null, reasoningTokens: null, cached: job.cached, costEstimate: null },
      error: job.status === 'failed' ? job.error as ImportJobResult['error'] : null, expiresAt: '2026-10-07T00:00:00.000Z',
    }
  }
  server(job: Job, created = false) {
    return { job: this.result(job), revision: job.revision, draftRevision: job.draftRevision, leaseToken: job.lease,
      leaseExpiresAt: job.leaseExpires === null ? null : new Date(job.leaseExpires).toISOString(), attemptCount: job.attempts, providerOutcome: job.outcome, created }
  }
  private reservation(entry: Ledger, send = false) {
    return { reservationId: entry.id, jobId: entry.job, attempt: entry.attempt, state: entry.state, requestHash: entry.hash, inputUpperTokens: entry.bytes + 256,
      maxOutputTokens: entry.maxOut, provider: 'openai', model: MODEL, currency: 'USD', configVersion: 'test/1', priceVersion: 'price/1', reservedMicros: 1,
      actualMicros: ['settled', 'cancelled'].includes(entry.state) ? 0 : null, sendGranted: send, job: this.server(this.jobs.get(entry.job)!) }
  }
  private job(owner: string, id: string, revision?: number): Job {
    const job = this.jobs.get(id)
    if (!job || job.owner !== owner) this.raise('42501', 'Import job not available')
    if (revision !== undefined && job.revision !== revision) this.raise('PT409', 'Import revision conflict')
    return job
  }
  rpc = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const forced = this.failNext[name]
    if (forced) { delete this.failNext[name]; this.raise(...forced) }
    const a = args as Record<string, never>
    switch (name) {
      case 'create_import_job': {
        const existing = [...this.jobs.values()].find(job => job.owner === a.p_owner_id && job.requestId === a.p_request_id)
        if (existing) {
          if (existing.inputHash !== a.p_input_hash || existing.normalizedHash !== a.p_normalized_hash || existing.kind !== a.p_kind) this.raise('PT409', 'Import request conflict')
          return this.server(existing)
        }
        const job: Job = { id: crypto.randomUUID(), owner: a.p_owner_id, requestId: a.p_request_id, kind: a.p_kind, inputHash: a.p_input_hash, normalizedHash: a.p_normalized_hash,
          versions: a.p_versions, document: a.p_document, status: 'running', attempts: 0, outcome: 'not_started', lease: crypto.randomUUID(), leaseExpires: this.clock.now + 120_000,
          revision: 1, draftRevision: 1, extraction: null, issues: [], error: null, cached: false }
        const cache = [...this.jobs.values()].find(other => other.owner === job.owner && other.kind === job.kind && other.normalizedHash === job.normalizedHash
          && JSON.stringify(other.versions) === JSON.stringify(job.versions) && other.status === 'ready' && JSON.stringify(other.document) === JSON.stringify(job.document))
        if (cache) Object.assign(job, { status: 'ready', outcome: 'cache_hit', lease: null, leaseExpires: null, extraction: cache.extraction, issues: cache.issues, cached: true, revision: 2 })
        this.jobs.set(job.id, job)
        return this.server(job, true)
      }
      case 'find_import_job': {
        const job = [...this.jobs.values()].find(entry => entry.owner === a.p_owner_id && entry.requestId === a.p_request_id)
        return job ? this.server(job) : null
      }
      case 'complete_import_job': {
        const job = this.job(a.p_owner_id, a.p_job_id, a.p_expected_revision)
        if ((job.status !== 'running' && !(job.status === 'failed' && job.outcome === 'uncertain')) || job.lease !== a.p_lease_token) this.raise('PT409', 'Import lease conflict')
        const result = a.p_result as { extraction: { kind: string }; validationIssues: unknown[]; usageSummary: { providerCalls: number; cached: boolean } }
        if (result.extraction.kind !== job.kind || result.usageSummary.providerCalls !== job.attempts || result.usageSummary.cached) this.raise('22023', 'Invalid analysis result')
        if (job.draftRevision !== a.p_expected_draft_revision) this.raise('PT409', 'Import draft revision conflict')
        Object.assign(job, { status: 'ready', outcome: 'completed', lease: null, leaseExpires: null, extraction: result.extraction, issues: result.validationIssues, error: null,
          revision: job.revision + 1, draftRevision: job.draftRevision + 1 })
        return this.server(job)
      }
      case 'fail_import_job': {
        const job = this.job(a.p_owner_id, a.p_job_id, a.p_expected_revision)
        if (job.status !== 'running' || job.lease !== a.p_lease_token) this.raise('PT409', 'Import lease conflict')
        const uncertain = a.p_code === 'provider_outcome_uncertain'
        Object.assign(job, { status: 'failed', outcome: uncertain ? 'uncertain' : 'known_failure', error: { code: a.p_code, message: 'Errore sintetico.', retryable: false, limit: null },
          lease: uncertain ? job.lease : null, leaseExpires: uncertain ? job.leaseExpires : null, revision: job.revision + 1 })
        return this.server(job)
      }
      case 'get_import_budget_config': return structuredClone(this.config)
      case 'reserve_import_budget': {
        const existing = this.ledger.get(a.p_reservation_id)
        if (existing) return this.reservation(existing)
        if (this.config.enabled !== true) this.raise('PT503', 'Import analysis disabled')
        const job = this.job(a.p_owner_id, a.p_job_id, a.p_expected_revision)
        if (job.status === 'ready' || job.status === 'expired') this.raise('PT409', 'Import job not reservable')
        const entries = [...this.ledger.values()].filter(entry => entry.job === job.id)
        if (entries.some(entry => ['reserved', 'sent', 'uncertain'].includes(entry.state))) this.raise('PT409', 'Import analysis already active')
        if (job.attempts >= (this.config.max_attempts as number)) this.raise('PT429', 'Import attempt quota exhausted')
        if (entries.some(entry => entry.notBefore > this.clock.now)) this.raise('PT429', 'Import retry deferred')
        if (job.attempts > 0 && !a.p_retry) this.raise('PT409', 'Import explicit retry required')
        if ((a.p_input_bytes as number) + 256 > (this.config.max_input_tokens as number) || (a.p_max_output_tokens as number) > (this.config.max_output_tokens as number)) this.raise('PT413', 'Import token limit exceeded')
        const entry: Ledger = { id: a.p_reservation_id, owner: a.p_owner_id, job: job.id, state: 'reserved', attempt: null, hash: a.p_request_hash, bytes: a.p_input_bytes, maxOut: a.p_max_output_tokens, notBefore: 0 }
        this.ledger.set(entry.id, entry)
        Object.assign(job, { status: 'running', error: null, outcome: 'not_started', lease: crypto.randomUUID(), leaseExpires: this.clock.now + 120_000, revision: job.revision + 1 })
        return this.reservation(entry)
      }
      case 'dispatch_import_attempt': {
        const entry = this.ledger.get(a.p_reservation_id)!
        if (entry.state !== 'reserved') return this.reservation(entry)
        const job = this.jobs.get(entry.job)!
        Object.assign(job, { attempts: job.attempts + 1, outcome: 'in_flight', revision: job.revision + 1 })
        Object.assign(entry, { state: 'sent', attempt: job.attempts })
        return this.reservation(entry, true)
      }
      case 'reconcile_import_usage': {
        const entry = this.ledger.get(a.p_reservation_id)!
        const job = this.jobs.get(entry.job)!
        entry.state = a.p_outcome === 'known' ? 'settled' : a.p_outcome === 'not_sent' ? 'cancelled' : 'uncertain'
        entry.notBefore = this.clock.now + (a.p_retry_after_seconds as number) * 1000
        job.revision++
        return this.reservation(entry)
      }
      default: throw new Error(`RPC non prevista ${name}`)
    }
  }
  count(state?: string) { return [...this.ledger.values()].filter(entry => state === undefined || entry.state === state).length }
}

// ---------------------------------------------------------------------------
// Harness del handler
// ---------------------------------------------------------------------------

const baseEnv: ServerEnv = {
  IMPORT_PROVIDER: 'openai', IMPORT_MODEL: MODEL, IMPORT_PROMPT_VERSION, IMPORT_MAX_OUTPUT_TOKENS: '4000', IMPORT_RETRY_MAX_OUTPUT_TOKENS: '6000',
  IMPORT_PROVIDER_TIMEOUT_MS: '1000', OPENAI_API_KEY: API_KEY, IMPORT_ALLOWED_ORIGINS: 'http://127.0.0.1:4173', SUPABASE_URL: 'http://kong:8000',
  IMPORT_TEST_TRANSPORT: 'synthetic',
}
function harness(options: { env?: ServerEnv; config?: Partial<ServerConfig>; transport?: ProviderTransport; budget?: Record<string, unknown> } = {}) {
  const clock = { now: Date.parse('2026-09-30T10:00:00Z') }
  const backend = new Backend(clock)
  Object.assign(backend.config, options.budget ?? {})
  const config = { ...readServerConfig({ ...baseEnv, ...options.env }), ...options.config } as ServerConfig
  const calls: string[] = []
  const sleeps: number[] = []
  const logs: object[] = []
  const base = config.provider.enabled ? (options.transport ?? createSyntheticTransport(config.provider.config)) : null
  const transport: ProviderTransport = async (url, init) => { calls.push(init.body); return base!(url, init) }
  const provider = config.provider.enabled && config.invalid === null ? createOpenAIProvider(config.provider.config, { transport }) : null
  const rpc = (name: string, args: Record<string, unknown>) => backend.rpc(name, args)
  const deps: ExtractPlanDeps = {
    config, provider,
    authenticate: async token => { if (token === 'token-throws') throw new Error('auth down'); return TOKENS[token] ?? null },
    jobs: createJobsAdapter(rpc as (name: JobServerRpcName, args: Record<string, unknown>) => Promise<unknown>), budget: createBudgetAdapter(rpc as never),
    randomUUID: () => crypto.randomUUID(), now: () => clock.now, sleep: async ms => { sleeps.push(ms); clock.now += ms },
    log: event => logs.push(event),
  }
  const handler = createExtractPlanHandler(deps)
  const post = (body: unknown, token: string | null = 'token-a', headers: Record<string, string> = {}) => handler(new Request('http://edge.local/extract-plan', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  }))
  return { handler, post, backend, calls, sleeps, logs, clock, config }
}
async function json<T = Record<string, unknown>>(response: Response): Promise<T> { return await response.json() as T }
async function jobOf(response: Response): Promise<ImportJobResult> {
  const body = await json<ImportJobResult>(response)
  assert.equal(validateImportJobResult(body).ok, true, JSON.stringify(body).slice(0, 300))
  return body
}
const keepAlive = () => setTimeout(() => {}, 10_000)

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

test('server config: trasporto sintetico solo su stack locale, origini esatte, modello di riserva non prenotabile', () => {
  assert.equal(readServerConfig(baseEnv).testTransport, 'synthetic')
  assert.equal(readServerConfig({ ...baseEnv, SUPABASE_URL: 'https://abc.supabase.co' }).invalid, 'IMPORT_TEST_TRANSPORT')
  assert.equal(readServerConfig({ ...baseEnv, SUPABASE_URL: 'https://abc.supabase.co' }).testTransport, null)
  assert.equal(readServerConfig({ ...baseEnv, IMPORT_TEST_TRANSPORT: 'real' }).invalid, 'IMPORT_TEST_TRANSPORT')
  assert.equal(readServerConfig({ ...baseEnv, IMPORT_TEST_TRANSPORT: undefined }).testTransport, null)
  assert.equal(readServerConfig({ ...baseEnv, IMPORT_ALLOWED_ORIGINS: 'http://127.0.0.1:4173/path' }).invalid, 'IMPORT_ALLOWED_ORIGINS')
  assert.equal(readServerConfig({ ...baseEnv, IMPORT_RETRY_MODEL: 'other-model' }).invalid, 'IMPORT_RETRY_MODEL')
  assert.equal(readServerConfig({ ...baseEnv, IMPORT_ANALYSIS_DEADLINE_MS: '1' }).invalid, 'IMPORT_ANALYSIS_DEADLINE_MS')
  for (const url of ['http://kong:8000', 'http://127.0.0.1:54321', 'http://supabase_kong_peppitness:8000']) assert.equal(isLocalSupabaseUrl(url), true, url)
  for (const url of ['https://kong:8000', 'http://abc.supabase.co', 'http://user:pw@127.0.0.1:54321', undefined]) assert.equal(isLocalSupabaseUrl(url), false, String(url))
  assert.equal(ANALYSIS_RULES_VERSION, 'peppitness.import-validation.v2+segments.v1')
})

// ---------------------------------------------------------------------------
// HTTP: origine, metodo, identità, corpo
// ---------------------------------------------------------------------------

test('handler: CORS configurato, metodi, JWT obbligatorio verificato prima di leggere il corpo', async () => {
  const { handler, post, backend } = harness()
  const preflight = await handler(new Request('http://edge.local/extract-plan', { method: 'OPTIONS', headers: { origin: 'http://127.0.0.1:4173' } }))
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173')
  assert.match(preflight.headers.get('access-control-allow-headers')!, /authorization/)
  const foreign = await handler(new Request('http://edge.local/extract-plan', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }))
  assert.equal(foreign.status, 403)
  assert.equal(foreign.headers.get('access-control-allow-origin'), null)
  const get = await handler(new Request('http://edge.local/extract-plan', { headers: { authorization: 'Bearer token-a' } }))
  assert.equal(get.status, 405)
  assert.equal(get.headers.get('allow'), 'POST, OPTIONS')
  let read = false
  for (const token of [null, 'token-unknown', 'token-throws']) {
    // highWaterMark 0: il flusso viene letto solo se il handler consuma il corpo.
    const spy = new ReadableStream({ pull() { read = true; throw new Error('non deve leggere') } }, { highWaterMark: 0 })
    const response = await handler(new Request('http://edge.local/extract-plan', { method: 'POST', body: spy, duplex: 'half', headers: token ? { authorization: `Bearer ${token}` } : {} } as RequestInit))
    assert.equal(response.status, 401)
    assert.equal((await json<{ error: { code: string } }>(response)).error.code, 'unauthenticated')
  }
  assert.equal((await post(request(sectionedDocument(1)), 'Basic abc')).status, 401)
  assert.equal(read, false)
  assert.equal(backend.jobs.size, 0)
})

test('handler: limiti di byte, profondità, schema e documento prima di qualsiasi job o chiamata', async () => {
  const { post, backend, calls, handler, config } = harness({ config: { limits: resolveImportLimits({ requestBodyBytes: 20_000, blocks: 30 }) } })
  const big = request(sectionedDocument(1, 2, 'x'.repeat(30_000)))
  const declared = await post(big, 'token-a', { 'content-length': String(JSON.stringify(big).length) })
  assert.equal(declared.status, 413)
  assert.deepEqual((await json<{ error: { limit: unknown } }>(declared)).error.limit, { limit: 'requestBodyBytes', max: 20_000, actual: JSON.stringify(big).length })
  // Senza Content-Length affidabile: lettura a flusso interrotta al superamento.
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < 30; i++) controller.enqueue(new TextEncoder().encode('x'.repeat(1000))); controller.close() } })
  const streamed = await handler(new Request('http://edge.local/extract-plan', { method: 'POST', body: stream, duplex: 'half', headers: { authorization: 'Bearer token-a' } } as RequestInit))
  assert.equal(streamed.status, 413)
  assert.equal((await post('{not json')).status, 400)
  assert.equal((await post(new Uint8Array([0xff, 0xfe]) as never)).status, 400)
  let deep: unknown = 1
  for (let i = 0; i < 20; i++) deep = [deep]
  assert.equal((await json<{ error: { limit: { limit: string } } }>(await post({ deep }))).error.limit.limit, 'jsonDepth')
  const version = await post({ ...request(sectionedDocument(1)), expectedSchemaVersion: '2.0' })
  assert.deepEqual([version.status, (await json<{ error: { code: string } }>(version)).error.code], [400, 'unsupported_schema_version'])
  // Nessun owner, provider, modello o prompt dal client: chiavi extra respinte.
  for (const extra of [{ ownerId: B }, { model: 'expensive' }, { providerUrl: 'https://evil.example' }, { systemPrompt: 'x' }]) {
    const response = await post({ ...request(sectionedDocument(1)), ...extra })
    assert.deepEqual([response.status, (await json<{ error: { code: string } }>(response)).error.code], [400, 'invalid_request'])
  }
  const blocks = await post(request(sectionedDocument(3)))
  assert.deepEqual((await json<{ error: { limit: unknown } }>(blocks)).error.limit, { limit: 'blocks', max: 30, actual: 32 })
  assert.equal(config.limits.blocks, 30)
  assert.equal(backend.jobs.size, 0)
  assert.equal(calls.length, 0)
})

test('handler: analisi disattivata senza provider o budget, nessun job creato', async () => {
  for (const setup of [
    { env: { IMPORT_PROVIDER: undefined } }, { env: { OPENAI_API_KEY: '' } }, { budget: { enabled: false } },
    { budget: { model: 'another-model' } }, { budget: { max_output_tokens: 5000 } }, { env: { IMPORT_TEST_TRANSPORT: 'bogus' } },
  ]) {
    const { post, backend, calls } = harness(setup as never)
    const response = await post(request(sectionedDocument(1)))
    assert.equal(response.status, 503, JSON.stringify(setup))
    assert.equal((await json<{ error: { code: string } }>(response)).error.code, 'provider_unavailable')
    assert.equal(backend.jobs.size + calls.length, 0)
  }
})

// ---------------------------------------------------------------------------
// Analisi, replay, cache e isolamento
// ---------------------------------------------------------------------------

test('handler: analisi completa validata e persistita prima della risposta; replay, conflitto, cache e isolamento senza nuove chiamate', async () => {
  const { post, backend, calls, logs } = harness()
  const document = sectionedDocument(2)
  const body = request(document)
  const response = await post(body, 'token-a', { origin: 'http://127.0.0.1:4173' })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:4173')
  const text = await response.clone().text()
  for (const secret of [API_KEY, 'Sei l\'estrattore', 'resp_synthetic', 'req_synthetic']) assert.ok(!text.includes(secret), secret)
  const job = await jobOf(response)
  assert.equal(job.status, 'ready')
  assert.equal(job.extraction?.kind, 'workout')
  assert.equal((job.extraction as WorkoutExtraction).sessions.length, 2)
  assert.ok(Array.isArray(job.validationIssues))
  assert.equal(job.usageSummary.providerCalls, 1)
  const stored = backend.jobs.get(job.jobId)!
  assert.deepEqual([stored.status, stored.owner, stored.extraction], ['ready', A, job.extraction], 'persistito sul job del proprietario autenticato')
  assert.deepEqual(stored.versions, { reader: 'synthetic-fixture/1', schema: '1.0', prompt: IMPORT_PROMPT_VERSION, provider: 'openai', model: MODEL, rules: ANALYSIS_RULES_VERSION })
  assert.equal(backend.count('settled'), 1)

  const replay = await jobOf(await post(body))
  assert.deepEqual([replay.jobId, replay.status, calls.length], [job.jobId, 'ready', 1])
  const changed = structuredClone(body)
  changed.normalizedDocument.blocks[0]!.text = 'Altro titolo'
  const conflict = await post(changed)
  assert.deepEqual([conflict.status, (await json<{ error: { code: string } }>(conflict)).error.code, calls.length], [409, 'request_conflict', 1])

  const cached = await jobOf(await post(request(document)))
  assert.deepEqual([cached.status, cached.usageSummary.cached, cached.usageSummary.providerCalls, calls.length], ['ready', true, 0, 1])
  // B con lo stesso documento non riusa la cache di A e non vede il job di A.
  const other = await jobOf(await post(request(document), 'token-b'))
  assert.deepEqual([other.usageSummary.cached, calls.length], [false, 2])
  assert.notEqual(other.jobId, job.jobId)
  const sameKeyB = await jobOf(await post(body, 'token-b'))
  assert.notEqual(sameKeyB.jobId, job.jobId, 'chiave uguale per account diverso: job distinti')
  for (const event of logs) {
    const serialized = JSON.stringify(event)
    assert.ok(!serialized.includes('Esercizio') && !serialized.includes(API_KEY) && !serialized.includes('Scheda sintetica'), serialized)
  }
  assert.ok(logs.some(event => (event as { event: string }).event === 'extract_plan'))
})

test('handler: due POST concorrenti con la stessa chiave producono un job e una chiamata; disconnessione del client non annulla', async () => {
  const { handler, backend, calls } = harness()
  const body = JSON.stringify(request(sectionedDocument(1)))
  const controller = new AbortController()
  const make = () => handler(new Request('http://edge.local/extract-plan', { method: 'POST', body, signal: controller.signal, headers: { authorization: 'Bearer token-a' } }))
  const pending = [make(), make()]
  controller.abort()
  const results = await Promise.all(pending)
  const jobs = await Promise.all(results.map(jobOf))
  assert.equal(new Set(jobs.map(job => job.jobId)).size, 1)
  assert.equal(calls.length, 1)
  assert.equal(backend.jobs.size, 1)
  assert.equal([...backend.jobs.values()][0]!.status, 'ready', 'risultato salvato anche se il client si è disconnesso')
  // Il secondo POST trova il job del primo: ready (200) o ancora running (202), mai una seconda analisi.
  assert.ok(results.some(result => result.status === 200) && results.every(result => result.status === 200 || result.status === 202))
})

// ---------------------------------------------------------------------------
// Terminazioni del provider e tentativi
// ---------------------------------------------------------------------------

test('handler: rifiuto, incompleto, output non valido e dominio sbagliato; nessun piano inventato', async () => {
  const refusal = harness()
  const refused = await jobOf(await refusal.post(request(marked(syntheticMarkers.refuse))))
  assert.deepEqual([refused.status, refused.error?.code, refusal.calls.length, refused.extraction], ['failed', 'provider_refused', 1, null])

  const incomplete = harness()
  const truncated = await jobOf(await incomplete.post(request(marked(syntheticMarkers.incomplete))))
  assert.deepEqual([truncated.status, truncated.error?.code, incomplete.calls.length], ['failed', 'provider_incomplete', 2])
  assert.equal(JSON.parse(incomplete.calls[1]!).max_output_tokens, 6000, 'il secondo tentativo usa il profilo retry')
  const sameCap = harness({ env: { IMPORT_RETRY_MAX_OUTPUT_TOKENS: undefined } })
  await sameCap.post(request(marked(syntheticMarkers.incomplete)))
  assert.equal(sameCap.calls.length, 1, 'senza un tetto diverso un secondo tentativo non ha senso')

  const invalid = harness()
  const recovered = await jobOf(await invalid.post(request(marked(syntheticMarkers.invalidOnce))))
  assert.deepEqual([recovered.status, recovered.usageSummary.providerCalls, invalid.calls.length], ['ready', 2, 2])

  const wrong = harness()
  const domain = await jobOf(await wrong.post(request(marked(syntheticMarkers.wrongDomain))))
  assert.deepEqual([domain.status, domain.extraction?.outcome, domain.validationIssues, wrong.calls.length], ['ready', 'wrong_document_type', [], 1])
  assert.equal((domain.extraction as WorkoutExtraction).sessions.length, 0)
})

test('handler: 429 con Retry-After attende e riprova entro il limite; attesa troppo lunga e 5xx esauriti falliscono', async () => {
  const limited = harness()
  const job = await jobOf(await limited.post(request(marked(syntheticMarkers.rateLimitedOnce))))
  assert.deepEqual([job.status, job.usageSummary.providerCalls, limited.calls.length], ['ready', 2, 2])
  assert.deepEqual(limited.sleeps, [1250])

  const slow = harness({ transport: async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } }) })
  const deferred = await jobOf(await slow.post(request(sectionedDocument(1))))
  assert.deepEqual([deferred.status, deferred.error?.code, slow.calls.length, slow.sleeps.length], ['failed', 'provider_unavailable', 1, 0])

  const down = harness({ transport: async () => new Response('{}', { status: 503 }) })
  const unavailable = await jobOf(await down.post(request(sectionedDocument(1))))
  assert.deepEqual([unavailable.status, unavailable.error?.code, unavailable.usageSummary.providerCalls, down.calls.length], ['failed', 'provider_unavailable', 2, 2])
  const third = await jobOf(await down.post(request(sectionedDocument(1), unavailable.analysisRequestId)))
  assert.deepEqual([third.status, down.calls.length], ['failed', 2], 'replay di un job fallito: nessuna terza chiamata')
})

test('handler: timeout dopo l’invio resta incerto, riserva mantenuta, replay senza nuova chiamata', async () => {
  const timer = keepAlive()
  const { post, backend, calls } = harness()
  const body = request(marked(syntheticMarkers.hang))
  const job = await jobOf(await post(body))
  clearTimeout(timer)
  assert.deepEqual([job.status, job.error?.code, calls.length], ['failed', 'provider_outcome_uncertain', 1])
  assert.equal(backend.count('uncertain'), 1)
  const replay = await jobOf(await post(body))
  assert.deepEqual([replay.status, calls.length], ['failed', 1])
})

test('handler: errori del budget restituiti come errori sicuri e job chiuso senza chiamate', async () => {
  for (const [forced, status, code] of [
    [['PT429', 'Import daily quota exhausted'], 429, 'budget_exhausted'],
    [['PT429', 'Import project budget exhausted'], 429, 'budget_exhausted'],
    [['PT409', 'Import account concurrency limit'], 409, 'request_conflict'],
    [['PT503', 'Import analysis disabled'], 503, 'provider_unavailable'],
    [['PT413', 'Import token limit exceeded'], 413, 'limit_exceeded'],
  ] as const) {
    const { post, backend, calls } = harness()
    backend.failNext.reserve_import_budget = [...forced]
    const response = await post(request(sectionedDocument(1)))
    assert.deepEqual([response.status, (await json<{ error: { code: string } }>(response)).error.code], [status, code], forced[1])
    assert.equal(calls.length, 0)
    assert.deepEqual([...backend.jobs.values()].map(job => [job.status, (job.error as { code: string }).code]), [['failed', 'provider_unavailable']])
  }
})

test('handler: job rimasto running oltre lease e scadenza viene chiuso al replay senza chiamare il provider', async () => {
  const { post, backend, calls, clock } = harness()
  backend.failNext.reserve_import_budget = ['XX000', 'crash simulato dopo la creazione']
  const body = request(sectionedDocument(1))
  assert.equal((await post(body)).status, 500)
  const job = [...backend.jobs.values()][0]!
  Object.assign(job, { status: 'running', error: null, lease: crypto.randomUUID(), leaseExpires: clock.now + 120_000 })
  const early = await jobOf(await post(body))
  assert.equal(early.status, 'running')
  clock.now += 120_000 + 140_000 + 1
  const settled = await jobOf(await post(body))
  assert.deepEqual([settled.status, settled.error?.code, calls.length], ['failed', 'internal', 0])
})

// ---------------------------------------------------------------------------
// Segmentazione
// ---------------------------------------------------------------------------

test('segmenti: sezioni complete con contesto ripetuto, riferimenti validi, tabelle mai spezzate, manifest completo', () => {
  const document = sectionedDocument(3, 3)
  const size = (doc: NormalizedDocument) => JSON.stringify(doc.blocks).length
  assert.equal(planSegments(document, () => true, 2).status, 'single')
  const oneSection = size({ ...document, blocks: document.blocks.filter(block => block.id.startsWith('p:') || block.id === 'h:0' || block.id.startsWith('t:0')) })
  const plan = planSegments(document, doc => size(doc) <= oneSection + 50, 3)
  assert.equal(plan.status, 'segmented')
  const segments = (plan as { segments: DocumentSegment[] }).segments
  assert.equal(segments.length, 3)
  const owned = segments.flatMap(segment => segment.ownBlockIds)
  assert.equal(new Set(owned).size, owned.length, 'nessun blocco proprio duplicato')
  assert.deepEqual([...owned, 'p:0', 'p:1'].sort(), document.blocks.map(block => block.id).sort())
  for (const [index, segment] of segments.entries()) {
    assert.equal(validateNormalizedDocument(segment.document).ok, true)
    assert.deepEqual(segment.contextBlockIds, ['p:0', 'p:1'])
    const tables = new Set(segment.document.blocks.filter(block => block.tableId !== null).map(block => block.tableId))
    assert.deepEqual([...tables], [`t:${index}`])
    const rows = document.blocks.filter(block => block.tableId === `t:${index}`).map(block => block.id)
    assert.ok(rows.every(id => segment.ownBlockIds.includes(id)), 'tabella intera nello stesso segmento')
    assert.ok(segment.document.blocks.every((block, position, all) => position === 0 || document.blocks.findIndex(b => b.id === all[position - 1]!.id) < document.blocks.findIndex(b => b.id === block.id)), 'ordine di fonte')
  }
  // Accorpamento: due sezioni per segmento se entrano.
  const packed = planSegments(document, doc => size(doc) <= oneSection * 2, 3)
  assert.equal(packed.status === 'segmented' && packed.segments.length, 2)
  // Troppi segmenti per le chiamate disponibili, o un'unità che da sola non entra: selezione esplicita.
  assert.deepEqual(planSegments(document, doc => size(doc) <= oneSection + 50, 2), { status: 'selection_required', reason: 'too_many_segments', segmentsNeeded: 3, maxSegments: 2 })
  assert.equal((planSegments(document, doc => size(doc) < 500, 5) as { reason: string }).reason, 'unit_too_large')
  // Senza titoli di sezione non esiste un confine sicuro.
  const flat = { ...document, blocks: document.blocks.filter(block => block.kind !== 'heading').map(block => ({ ...block, headingIds: [] })) }
  assert.equal((planSegments(flat, () => false, 5) as { reason: string }).reason, 'unit_too_large')
})

test('segmenti: sottosezioni usate come confine quando una sezione da sola non entra', () => {
  const blocks: SourceBlock[] = [block('p:0', 'paragraph', 'Titolo'), block('h:0', 'heading', 'Settimana 1')]
  for (let s = 0; s < 2; s++) {
    blocks.push(block(`h:0:${s}`, 'heading', `Seduta ${s}`, { headingIds: ['h:0'] }))
    for (let r = 0; r < 3; r++) blocks.push(block(`p:${s}:${r}`, 'paragraph', `Esercizio ${s}.${r} ${'x'.repeat(200)}`, { headingIds: ['h:0', `h:0:${s}`] }))
  }
  const document: NormalizedDocument = { readerVersion: 'synthetic-fixture/1', sourceHash: hash, blocks, readingIssues: [] }
  const plan = planSegments(document, doc => JSON.stringify(doc.blocks).length < 2600, 2)
  assert.equal(plan.status, 'segmented')
  for (const segment of (plan as { segments: DocumentSegment[] }).segments) {
    assert.equal(validateNormalizedDocument(segment.document).ok, true)
    assert.ok(segment.document.blocks.some(b => b.id === 'h:0'), 'titolo antenato ripetuto come contesto')
  }
})

test('ricomposizione: ordine di fonte, puntatori rimappati, duplicati di contesto rimossi, numeri uguali conservati, regole contraddittorie segnalate', () => {
  const document = sectionedDocument(2)
  const plan = planSegments(document, doc => doc.blocks.length <= 12, 2) as { segments: DocumentSegment[] }
  assert.equal(plan.segments.length, 2)
  const base = (segment: number): WorkoutExtraction => ({
    schemaVersion: '1.0', kind: 'workout', outcome: 'extracted', title: 'Scheda sintetica a sezioni', guidance: ['Regola generale: recupero 90 secondi salvo diversa indicazione.'],
    schedule: 'unknown', cycle: { startDate: null, weeks: null },
    sessions: [{ label: `Seduta ${segment ? 'B' : 'A'}`, title: null, weekday: null, notes: [], exercises: [{
      name: 'Stesso nome', variant: null, equipment: null, measurementMode: null, sets: 3, optionalSets: null, repetitions: { min: 10, max: 10 }, durationSeconds: null,
      restSeconds: null, rir: null, rpe: null, perSide: null, loadUnit: null, loadConvention: null, loadInstruction: null, tempoInstruction: null, prescriptionText: '3 x 10', notes: [],
    }] }],
    complexRules: [{ kind: 'other', text: segment ? 'Recupero 90 secondi ovunque.' : 'Recupero 90 secondi salvo eccezioni.', sourceRefs: ['p:1'], targetPaths: ['/sessions/0/exercises/0/restSeconds'] }],
    evidence: [
      { path: '/title', spans: [{ blockId: 'p:0', quote: 'Scheda sintetica a sezioni' }] },
      { path: '/guidance/0', spans: [{ blockId: 'p:1', quote: 'Regola generale' }] },
      { path: '/sessions/0/label', spans: [{ blockId: `h:${segment}`, quote: `Seduta ${segment ? 'B' : 'A'}` }] },
      { path: '/sessions/0/exercises/0/sets', spans: [{ blockId: `t:${segment}:r:1`, quote: '3 x 10' }] },
    ],
    issues: [{ code: 'missing', path: '/sessions/0/exercises/0/restSeconds', sourceRefs: [`t:${segment}:r:1`], message: 'Recupero non indicato.' }],
    unassigned: [],
  })
  const merged = mergeSegmentExtractions('workout', plan.segments.map((segment, index) => ({ segment, extraction: base(index) })))
  assert.equal(validateExtraction('workout', merged).ok, true)
  assert.deepEqual(merged.sessions.map(session => session.label), ['Seduta A', 'Seduta B'])
  assert.equal(merged.sessions[1]!.exercises[0]!.sets, 3, 'numeri uguali in righe diverse restano due fatti distinti')
  assert.deepEqual(merged.guidance, ['Regola generale: recupero 90 secondi salvo diversa indicazione.'], 'guida del contesto una sola volta')
  assert.deepEqual(merged.evidence.map(entry => entry.path), ['/title', '/guidance/0', '/sessions/0/label', '/sessions/0/exercises/0/sets', '/sessions/1/label', '/sessions/1/exercises/0/sets'])
  assert.equal(merged.evidence.find(entry => entry.path === '/sessions/1/label')!.spans[0]!.blockId, 'h:1')
  assert.deepEqual(merged.issues.map(issue => [issue.code, issue.path]), [
    ['missing', '/sessions/0/exercises/0/restSeconds'], ['conflicting', '/complexRules/0'], ['missing', '/sessions/1/exercises/0/restSeconds'],
  ])
  assert.equal(merged.complexRules.length, 1, 'la regola contraddittoria non viene duplicata')
  assert.deepEqual(merged.complexRules[0]!.targetPaths, ['/sessions/0/exercises/0/restSeconds'])
  // Segmento di dominio diverso fra segmenti estratti: problema dichiarato, nessun contenuto inventato.
  const wrong = { ...base(1), outcome: 'wrong_document_type' as const, title: null, guidance: [], sessions: [], complexRules: [], evidence: [], issues: [] }
  const partial = mergeSegmentExtractions('workout', [{ segment: plan.segments[0]!, extraction: base(0) }, { segment: plan.segments[1]!, extraction: wrong }])
  assert.equal(partial.sessions.length, 1)
  assert.deepEqual(partial.issues.at(-1)!.sourceRefs, plan.segments[1]!.ownBlockIds)
})

test('handler: documento oltre budget analizzato per segmenti (due chiamate totali) o respinto con richiesta di selezione', async () => {
  const document = sectionedDocument(2, 2)
  // Tetto calibrato: il documento intero non entra, ogni sezione con il contesto sì.
  const probe = harness()
  const provider = createOpenAIProvider((probe.config.provider as { config: never }).config)
  const measure = (doc: NormalizedDocument) => new TextEncoder().encode(provider.prepare({ kind: 'workout', document: doc, schemaId: 'peppitness.workout-extraction.v1', promptVersion: IMPORT_PROMPT_VERSION, profile: 'standard', signal: new AbortController().signal }).serializedRequest).length + 256
  const plan = planSegments(document, () => false, 2)
  assert.equal(plan.status, 'selection_required')
  const whole = measure(document)
  const limit = whole - 200
  const segmented = harness({ budget: { max_input_tokens: limit } })
  const job = await jobOf(await segmented.post(request(document)))
  assert.deepEqual([job.status, job.usageSummary.providerCalls, segmented.calls.length], ['ready', 2, 2])
  const extraction = job.extraction as WorkoutExtraction
  assert.deepEqual(extraction.sessions.map(session => session.label), ['Seduta A', 'Seduta B'])
  assert.equal(extraction.evidence.find(entry => entry.path === '/sessions/1/label')!.spans[0]!.blockId, 'h:1')
  assert.equal(extraction.title, 'Seduta A', 'titolo dal primo segmento soltanto')
  for (const body of segmented.calls) assert.ok(measure({ ...document, blocks: [] }) < limit && new TextEncoder().encode(body).length + 256 <= limit)

  // Tre sezioni con due chiamate: selezione esplicita, nessun job, nessuna chiamata.
  const tooMany = harness({ budget: { max_input_tokens: limit } })
  const response = await tooMany.post(request(sectionedDocument(3, 2)))
  assert.equal(response.status, 413)
  const error = (await json<{ error: { code: string; limit: { limit: string; max: number; actual: number } } }>(response)).error
  assert.deepEqual([error.code, error.limit.limit, error.limit.max, error.limit.actual], ['limit_exceeded', 'providerCallsPerAnalysis', 2, 3])
  assert.equal(tooMany.backend.jobs.size + tooMany.calls.length, 0)

  // Due segmenti e output non valido nel primo: nessun retry disponibile senza sacrificare il secondo.
  const invalidFirst = sectionedDocument(2, 2)
  invalidFirst.blocks[4] = { ...invalidFirst.blocks[4]!, text: `Esercizio | ${syntheticMarkers.invalidOnce}` }
  invalidFirst.blocks[5] = { ...invalidFirst.blocks[5]!, text: 'Esercizio' }
  invalidFirst.blocks[6] = { ...invalidFirst.blocks[6]!, text: syntheticMarkers.invalidOnce }
  assert.equal(validateNormalizedDocument(invalidFirst).ok, true)
  const aggregate = harness({ budget: { max_input_tokens: measure(invalidFirst) - 200 } })
  const failed = await jobOf(await aggregate.post(request(invalidFirst)))
  assert.deepEqual([failed.status, failed.error?.code, aggregate.calls.length], ['failed', 'provider_invalid_output', 1])
})

test('fixture 01 attraverso l’endpoint: dieta e scheda del corpus producono bozze con problemi applicativi', async () => {
  for (const [kind, id] of [['workout', 'workout-spec-example'], ['diet', 'diet-spec-example']] as const) {
    const { post } = harness()
    const job = await jobOf(await post(request(readJson<NormalizedDocument>(`documents/${id}.json`), crypto.randomUUID(), kind)))
    assert.equal(job.status, 'ready')
    assert.equal(job.extraction?.kind, kind)
  }
})
