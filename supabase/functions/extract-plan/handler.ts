/**
 * POST extract-plan (task 17, specifica §13). Handler puro con dipendenze iniettate: autenticazione
 * Supabase, RPC server di jobs (14) e budget (15), provider (16). Nessun import Deno/npm: si prova in
 * Node e gira nel runtime Edge tramite index.ts.
 *
 * Ordine dei controlli: origine → metodo → identità → byte del corpo → JSON/profondità → versione e
 * schema → limiti del documento → configurazione/budget → replay → segmentazione → job → analisi.
 * Il corpo di una risposta con job è sempre ImportJobResult (ready/failed/expired 200, running 202);
 * gli errori senza job usano { error: ImportError }. Nessun testo del documento nei log o negli errori.
 */
import {
  defaultImportLimits, extractionSchemaIds, jsonDepthExceeds, normalizedDocumentLimitViolations, uuidSchema, validate,
  validateExtractPlanRequest,
  type ExtractPlanRequest, type ImportError, type ImportErrorCode, type NormalizedDocument,
} from '../_shared/import/contracts.ts'
import { conservativeInputTokens, type BudgetAdapter } from '../_shared/import/budget.ts'
import type { ServerJob } from '../_shared/import/jobs.ts'
import type { StructuredExtractionProvider } from '../_shared/import/provider.ts'
import { isRpcError, runAnalysis, type AnalysisLogEvent, type JobsAdapter, type ServerRpcError } from '../_shared/import/analysis.ts'
import { planSegments } from '../_shared/import/segments.ts'
import { analysisProfile, type ServerConfig } from '../_shared/import/server-config.ts'

export interface ExtractPlanLogEvent {
  event: 'extract_plan'
  httpStatus: number
  code: string | null
  jobStatus: string | null
  attempts: number | null
  segments: number | null
  cached: boolean | null
  latencyMs: number
}

export interface ExtractPlanDeps {
  config: ServerConfig
  /** Verifica il JWT utente con Supabase Auth; null se non valido, scaduto o senza utente. */
  authenticate(token: string): Promise<string | null>
  jobs: JobsAdapter
  budget: BudgetAdapter
  provider: StructuredExtractionProvider | null
  randomUUID(): string
  now(): number
  sleep(ms: number): Promise<void>
  log?(event: ExtractPlanLogEvent | AnalysisLogEvent): void
}

const allowHeaders = 'authorization, x-client-info, apikey, content-type'
const errorMessages: Record<ImportErrorCode, string> = {
  unauthenticated: 'Accesso richiesto.',
  invalid_request: 'Richiesta non valida.',
  unsupported_schema_version: 'Versione dello schema non supportata.',
  limit_exceeded: 'Limite superato.',
  budget_exhausted: 'Budget delle analisi esaurito.',
  request_conflict: 'Richiesta in conflitto.',
  job_not_found: 'Analisi non trovata.',
  provider_unavailable: 'Servizio di analisi non disponibile.',
  provider_refused: 'Il servizio non ha analizzato il documento.',
  provider_incomplete: 'Analisi incompleta.',
  provider_invalid_output: 'Risultato non valido.',
  provider_outcome_uncertain: 'Esito della chiamata non ancora noto.',
  internal: 'Analisi non completata.',
}

interface BudgetConfig { enabled: boolean; provider: unknown; model: unknown; maxAttempts: number; maxInputTokens: number; maxOutputTokens: number; framingTokens: number }
function budgetConfig(value: Record<string, unknown>): BudgetConfig | null {
  const count = (key: string) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && (value[key] as number) >= 0 ? value[key] as number : null
  const maxAttempts = count('max_attempts'), maxInputTokens = count('max_input_tokens'), maxOutputTokens = count('max_output_tokens'), framingTokens = count('framing_tokens')
  if (maxAttempts === null || maxInputTokens === null || maxOutputTokens === null || framingTokens === null) return null
  return { enabled: value.enabled === true, provider: value.provider, model: value.model, maxAttempts, maxInputTokens, maxOutputTokens, framingTokens }
}

type BodyRead = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'invalid'; actual: number | null }
/** Byte UTF-8 del corpo verificati prima del parsing, anche senza Content-Length affidabile. */
async function readBody(request: Request, max: number): Promise<BodyRead> {
  const declared = request.headers.get('content-length')
  if (declared !== null && /^\d{1,15}$/.test(declared) && Number(declared) > max) return { ok: false, reason: 'too_large', actual: Number(declared) }
  if (!request.body) return { ok: false, reason: 'invalid', actual: null }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) { await reader.cancel().catch(() => {}); return { ok: false, reason: 'too_large', actual: null } }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } }
  catch { return { ok: false, reason: 'invalid', actual: null } }
}

export function createExtractPlanHandler(deps: ExtractPlanDeps): (request: Request) => Promise<Response> {
  const { config } = deps
  const limits = config.limits
  const allowed = new Set(config.allowedOrigins)

  return async function handle(request: Request): Promise<Response> {
    const started = deps.now()
    const origin = request.headers.get('origin')
    const cors: Record<string, string> = origin !== null && allowed.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
    const meta: Omit<ExtractPlanLogEvent, 'event' | 'httpStatus' | 'code' | 'latencyMs'> = { jobStatus: null, attempts: null, segments: null, cached: null }
    const respond = (status: number, body: unknown, code: string | null, extra: Record<string, string> = {}) => {
      try { deps.log?.({ event: 'extract_plan', httpStatus: status, code, ...meta, latencyMs: Math.max(0, deps.now() - started) }) } catch { /* log non bloccante */ }
      return new Response(body === null ? null : JSON.stringify(body), {
        status, headers: { ...cors, ...(body === null ? {} : { 'Content-Type': 'application/json' }), 'Cache-Control': 'no-store', ...extra },
      })
    }
    const error = (status: number, code: ImportErrorCode, options: { retryable?: boolean; limit?: ImportError['limit']; message?: string; headers?: Record<string, string> } = {}) =>
      respond(status, { error: { code, message: options.message ?? errorMessages[code], retryable: options.retryable ?? false, limit: options.limit ?? null } }, code, options.headers)
    const jobResponse = (job: ServerJob) => {
      meta.jobStatus = job.job.status
      meta.attempts = job.attemptCount
      meta.cached = job.job.usageSummary.cached
      return respond(job.job.status === 'running' ? 202 : 200, job.job, job.job.error?.code ?? null)
    }
    const rpcError = (failure: ServerRpcError, maxInputTokens: number | null) => {
      const message = failure.message
      if (failure.code === 'PT503') return error(503, 'provider_unavailable', { message: 'Analisi dei documenti disattivata.' })
      if (failure.code === 'PT429') {
        return message === 'Import retry deferred'
          ? error(429, 'provider_unavailable', { retryable: true })
          : error(429, 'budget_exhausted', { message: message === 'Import daily quota exhausted' ? 'Limite giornaliero delle analisi raggiunto.' : errorMessages.budget_exhausted })
      }
      if (failure.code === 'PT413') return error(413, 'limit_exceeded', { limit: { limit: 'inputTokens', max: maxInputTokens ?? 0, actual: null } })
      if (failure.code === 'PT409' && (message === 'Import account concurrency limit' || message === 'Import analysis already active')) {
        return error(409, 'request_conflict', { retryable: true, message: 'Un’altra analisi è già in corso.' })
      }
      if (failure.code === 'PT409' && message === 'Import request conflict') return error(409, 'request_conflict', { message: 'La stessa richiesta è già stata usata con un altro documento.' })
      if (failure.code === 'PT409' && message === 'Import analysis profile changed') return error(503, 'provider_unavailable')
      return error(500, 'internal')
    }

    try {
      if (origin !== null && !allowed.has(origin)) return error(403, 'invalid_request', { message: 'Origine non consentita.' })
      if (request.method === 'OPTIONS') {
        return respond(204, null, null, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': allowHeaders, 'Access-Control-Max-Age': '600' })
      }
      if (request.method !== 'POST') return error(405, 'invalid_request', { headers: { Allow: 'POST, OPTIONS' } })

      // Identità: solo il JWT utente verificato da Supabase Auth; owner mai dal corpo.
      const authorization = request.headers.get('authorization') ?? ''
      const token = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(authorization)?.[1] ?? null
      if (token === null) return error(401, 'unauthenticated')
      let ownerId: string | null = null
      try { ownerId = await deps.authenticate(token) } catch { ownerId = null }
      if (ownerId === null || !validate(uuidSchema, ownerId).ok) return error(401, 'unauthenticated')

      const body = await readBody(request, limits.requestBodyBytes)
      if (!body.ok) {
        return body.reason === 'too_large'
          ? error(413, 'limit_exceeded', { limit: { limit: 'requestBodyBytes', max: limits.requestBodyBytes, actual: body.actual } })
          : error(400, 'invalid_request')
      }
      let value: unknown
      try { value = JSON.parse(body.text) } catch { return error(400, 'invalid_request') }
      if (jsonDepthExceeds(value, limits.jsonDepth)) return error(413, 'limit_exceeded', { limit: { limit: 'jsonDepth', max: limits.jsonDepth, actual: null } })
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'expectedSchemaVersion')
        && (value as { expectedSchemaVersion: unknown }).expectedSchemaVersion !== '1.0') return error(400, 'unsupported_schema_version')
      const checked = validateExtractPlanRequest(value)
      if (!checked.ok) return error(400, 'invalid_request')
      const input: ExtractPlanRequest = checked.value
      const violation = normalizedDocumentLimitViolations(input.normalizedDocument, limits)[0]
      if (violation) return error(413, 'limit_exceeded', { limit: violation })

      // Configurazione: senza provider/modello/budget l'analisi è disattivata (kill switch).
      const provider = deps.provider
      if (!config.provider.enabled || config.invalid !== null || provider === null) return error(503, 'provider_unavailable', { message: 'Analisi dei documenti disattivata.' })
      const providerConfig = config.provider.config
      let budget: BudgetConfig | null
      try { budget = budgetConfig(await deps.budget.config()) } catch { return error(503, 'provider_unavailable') }
      const standard = providerConfig.profiles.standard
      if (!budget || !budget.enabled || budget.provider !== providerConfig.provider || budget.model !== standard.model
        || Math.max(standard.maxOutputTokens, providerConfig.profiles.retry.maxOutputTokens) > budget.maxOutputTokens) {
        return error(503, 'provider_unavailable', { message: 'Analisi dei documenti disattivata.' })
      }
      const profile = analysisProfile(providerConfig)

      const replay = async (): Promise<Response> => {
        try { return jobResponse(await settleStale(deps, ownerId!, await deps.jobs.create(ownerId!, input, profile))) }
        catch (failure) { if (isRpcError(failure)) return rpcError(failure, budget!.maxInputTokens); throw failure }
      }
      // Job già esistente per questa chiave: stesso input → stesso job, input diverso → conflitto. Nessuna chiamata.
      if (await deps.jobs.find(ownerId, input.analysisRequestId)) return replay()

      const maxCalls = Math.min(limits.providerCallsPerAnalysis ?? defaultImportLimits.providerCallsPerAnalysis, budget.maxAttempts)
      const measure = (document: NormalizedDocument) => conservativeInputTokens(provider.prepare({
        kind: input.kind, document, schemaId: extractionSchemaIds[input.kind], promptVersion: providerConfig.promptVersion,
        profile: 'standard', signal: new AbortController().signal,
      } as Parameters<StructuredExtractionProvider['prepare']>[0]).serializedRequest, budget.framingTokens)
      const plan = planSegments(input.normalizedDocument, document => measure(document) <= budget!.maxInputTokens, maxCalls)
      if (plan.status === 'selection_required') {
        return error(413, 'limit_exceeded', {
          message: 'Documento troppo grande per un’unica analisi: seleziona le sezioni o le pagine da importare.',
          limit: plan.reason === 'too_many_segments'
            ? { limit: 'providerCallsPerAnalysis', max: maxCalls, actual: plan.segmentsNeeded }
            : { limit: 'inputTokens', max: budget.maxInputTokens, actual: measure(input.normalizedDocument) },
        })
      }
      meta.segments = plan.segments.length

      let job: ServerJob
      try { job = await deps.jobs.create(ownerId, input, profile) }
      catch (failure) { if (isRpcError(failure)) return rpcError(failure, budget.maxInputTokens); throw failure }
      // Replay concorrente o cache privata dell'account: nessuna nuova chiamata.
      if (!job.created) return jobResponse(await settleStale(deps, ownerId, job))
      if (job.job.status !== 'running') return jobResponse(job)

      const result = await runAnalysis({
        jobs: deps.jobs, budget: deps.budget, provider, promptVersion: providerConfig.promptVersion,
        randomUUID: deps.randomUUID, now: deps.now, sleep: deps.sleep, log: deps.log,
      }, {
        ownerId, job, request: input, segments: plan.segments, maxCalls,
        // La disconnessione del client non annulla l'analisi né il salvataggio: solo la scadenza server.
        deadline: started + config.deadlineMs, maxRetryWaitSeconds: config.maxRetryWaitSeconds,
      })
      if (result.status === 'budget_error') {
        meta.jobStatus = result.job.job.status
        meta.attempts = result.job.attemptCount
        return rpcError(result.error, budget.maxInputTokens)
      }
      return jobResponse(result.job)
    } catch {
      return error(500, 'internal')
    }
  }
}

/**
 * Job rimasto `running` oltre lease e scadenza dell'analisi (funzione terminata): chiuso senza nuove
 * chiamate. Inviato ma senza esito → incerto (la riserva resta); mai inviato → errore interno.
 */
async function settleStale(deps: ExtractPlanDeps, ownerId: string, job: ServerJob): Promise<ServerJob> {
  if (job.job.status !== 'running' || job.leaseExpiresAt === null) return job
  if (deps.now() <= Date.parse(job.leaseExpiresAt) + deps.config.deadlineMs) return job
  try { return await deps.jobs.fail(ownerId, job, job.providerOutcome === 'in_flight' ? 'provider_outcome_uncertain' : 'internal') }
  catch (failure) {
    if (!isRpcError(failure) || failure.code !== 'PT409') throw failure
    return (await deps.jobs.find(ownerId, job.job.analysisRequestId)) ?? job
  }
}
