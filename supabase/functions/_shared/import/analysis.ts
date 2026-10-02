/**
 * Coordinatore dell'analisi sincrona (task 17, specifica §§4.5, 7.6, 13). Ogni chiamata al provider,
 * segmenti e retry compresi, passa da runBudgetedAttempt (15) con una nuova prenotazione; il numero
 * totale non supera il limite dell'analisi. Il risultato è validato (06) sul documento completo e
 * persistito (14) prima di rispondere. Nessuna promise in background, nessun retry nascosto: un esito
 * incerto resta incerto e blocca nuove chiamate sul job.
 */
import {
  extractionSchemaIds, validateExtraction,
  type ExtractionFor, type ExtractionKind, type ExtractionProviderResponse, type ExtractionRequest, type ExtractPlanRequest,
  type ImportErrorCode, type ValidationIssue,
} from './contracts.ts'
import { validateProposal, type RejectionReason } from './validation.ts'
import { runBudgetedAttempt, type BudgetAdapter, type BudgetedCallResult, type ProviderUsage } from './budget.ts'
import type { createJobsAdapter, ServerJob } from './jobs.ts'
import type { StructuredExtractionProvider } from './provider.ts'
import { importErrorForProvider, isProviderError, type ExtractionProviderError } from './provider-errors.ts'
import { mergeSegmentExtractions, type DocumentSegment, type SegmentResult } from './segments.ts'

export type JobsAdapter = ReturnType<typeof createJobsAdapter>

/** Errore SQL/PostgREST propagato dal trasporto RPC: solo codice e messaggio applicativo stabili. */
export class ServerRpcError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'ServerRpcError'
    this.code = code
  }
}
export const isRpcError = (value: unknown): value is ServerRpcError => value instanceof ServerRpcError

/** Esiti di rifiuto che sono comunque una risposta valida: nessun piano, ma un risultato recuperabile. */
export const recoverableOutcomes: readonly RejectionReason[] = ['wrong_document_type', 'no_relevant_content', 'unreadable']

export interface AnalysisLogEvent {
  event: 'analysis_call' | 'analysis_result'
  segment: number | null
  profile: 'standard' | 'retry' | null
  outcome: string
  attempts: number
  counts?: { sessions: number; exercises: number; days: number; meals: number; foods: number; uncoveredSections: number }
}

export interface AnalysisDeps {
  jobs: JobsAdapter
  budget: BudgetAdapter
  provider: StructuredExtractionProvider
  promptVersion: string
  randomUUID(): string
  now(): number
  sleep(ms: number): Promise<void>
  log?(event: AnalysisLogEvent): void
}
export interface AnalysisInput {
  ownerId: string
  job: ServerJob
  request: ExtractPlanRequest
  segments: readonly DocumentSegment[]
  /** Chiamate totali ammesse per l'analisi (segmenti + retry). */
  maxCalls: number
  /** Istante (ms) oltre il quale non si avvia un'altra chiamata né un'attesa. */
  deadline: number
  maxRetryWaitSeconds: number
}
export type AnalysisResult =
  | { status: 'job'; job: ServerJob }
  | { status: 'budget_error'; job: ServerJob; error: ServerRpcError }

type CallValue = { response: ExtractionProviderResponse } | { error: ExtractionProviderError }
/** Sotto questa soglia non si avvia una chiamata: servirebbe comunque un esito incerto. */
const MIN_CALL_MS = 2_000

const zero: ProviderUsage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }

export async function runAnalysis(deps: AnalysisDeps, input: AnalysisInput): Promise<AnalysisResult> {
  const { jobs, budget, provider } = deps
  const kind: ExtractionKind = input.request.kind
  let current = input.job
  const log = (event: AnalysisLogEvent) => { try { deps.log?.(event) } catch { /* log non bloccante */ } }

  const fail = async (code: ImportErrorCode): Promise<AnalysisResult> => {
    log({ event: 'analysis_result', segment: null, profile: null, outcome: code, attempts: current.attemptCount })
    try { return { status: 'job', job: await jobs.fail(input.ownerId, current, code) } }
    catch (error) {
      if (!isRpcError(error) || error.code !== 'PT409') throw error
      const latest = await jobs.find(input.ownerId, input.request.analysisRequestId)
      if (!latest) throw error
      return { status: 'job', job: latest }
    }
  }

  const results: SegmentResult<ExtractionKind>[] = []
  for (const [position, segment] of input.segments.entries()) {
    const callsAfter = input.segments.length - position - 1
    let profile: 'standard' | 'retry' = 'standard'
    let lastFailure: ImportErrorCode = 'provider_unavailable'
    for (;;) {
      if (current.attemptCount + 1 + callsAfter > input.maxCalls) return fail(lastFailure)
      const remaining = input.deadline - deps.now()
      if (remaining < MIN_CALL_MS) return fail(lastFailure)
      const reservationId = deps.randomUUID()
      const request = {
        kind, document: segment.document, schemaId: extractionSchemaIds[kind], promptVersion: deps.promptVersion,
        profile, signal: AbortSignal.timeout(remaining),
      } as ExtractionRequest
      const prepared = provider.prepare(request, { clientRequestId: reservationId })
      let attempt: BudgetedCallResult<CallValue>
      try {
        attempt = await runBudgetedAttempt<CallValue>(budget, {
          ownerId: input.ownerId, job: current, reservationId, serializedRequest: prepared.serializedRequest,
          maxOutputTokens: prepared.maxOutputTokens, retry: current.attemptCount > 0,
        }, async () => {
          try {
            const response = await prepared.send(request.signal)
            return { value: { response }, usage: { inputTokens: response.inputTokens, outputTokens: response.outputTokens, reasoningTokens: response.reasoningTokens } }
          } catch (error) {
            // Solo un esito certo si riconcilia come noto; timeout/rete dopo l'invio restano incerti.
            if (!isProviderError(error) || error.delivery === 'uncertain') throw error
            return {
              value: { error }, usage: error.delivery === 'received' ? error.usage : zero,
              retryAfterSeconds: error.retryAfterSeconds ?? 0,
            }
          }
        })
      } catch (error) {
        if (!isRpcError(error)) throw error
        // Prenotazione o permesso rifiutati dal budget: nessuna chiamata inviata da questa prenotazione.
        const failed = await fail(current.attemptCount > 0 ? lastFailure : 'provider_unavailable')
        return { status: 'budget_error', job: failed.job, error }
      }
      current = attempt.reservation.job
      if (attempt.status !== 'completed') {
        if (attempt.status === 'not_dispatched') return { status: 'job', job: current }
        log({ event: 'analysis_call', segment: position, profile, outcome: 'uncertain', attempts: current.attemptCount })
        return fail('provider_outcome_uncertain')
      }
      const value = attempt.value
      // Usage non riconciliato: la riserva resta incerta e nessuna nuova chiamata è prenotabile sul job.
      const settled = attempt.reservation.state === 'settled'
      let retry = false
      let waitSeconds = 0
      if ('error' in value) {
        lastFailure = importErrorForProvider(value.error)
        retry = value.error.retryable
        waitSeconds = value.error.retryAfterSeconds ?? 0
        log({ event: 'analysis_call', segment: position, profile, outcome: value.error.code, attempts: current.attemptCount })
      } else {
        const response = value.response
        log({ event: 'analysis_call', segment: position, profile, outcome: response.status, attempts: current.attemptCount })
        if (response.status === 'refused') return fail('provider_refused')
        if (response.status === 'incomplete') {
          lastFailure = 'provider_incomplete'
          // Un secondo tentativo ha senso solo con un tetto di output diverso (profilo retry).
          retry = profile === 'standard' && provider.prepare({ ...request, profile: 'retry' }).maxOutputTokens > prepared.maxOutputTokens
        } else {
          const checked = validateProposal(kind, segment.document, response.data)
          if (checked.status === 'draft') { results.push({ segment, extraction: checked.extraction }); break }
          const shape = validateExtraction(kind, response.data)
          if (recoverableOutcomes.includes(checked.reason) && shape.ok) { results.push({ segment, extraction: shape.value }); break }
          lastFailure = 'provider_invalid_output'
          retry = true
        }
      }
      if (!retry || !settled || current.attemptCount + 1 + callsAfter > input.maxCalls) return fail(lastFailure)
      if (waitSeconds > input.maxRetryWaitSeconds || deps.now() + waitSeconds * 1000 + MIN_CALL_MS > input.deadline) return fail(lastFailure)
      if (waitSeconds > 0) await deps.sleep(waitSeconds * 1000 + 250)
      // Controllo del job prima del retry: se è cambiato altrove non si chiama di nuovo.
      const latest = await jobs.find(input.ownerId, input.request.analysisRequestId)
      if (!latest || latest.job.status !== 'running' || latest.revision !== current.revision) return { status: 'job', job: latest ?? current }
      current = latest
      profile = 'retry'
    }
  }

  const merged = mergeSegmentExtractions(kind, results as SegmentResult<typeof kind>[]) as ExtractionFor<ExtractionKind>
  const final = validateProposal(kind, input.request.normalizedDocument, merged)
  let extraction: ExtractionFor<ExtractionKind>
  let validationIssues: ValidationIssue[]
  if (final.status === 'draft') { extraction = final.extraction; validationIssues = final.issues }
  else if (recoverableOutcomes.includes(final.reason)) { extraction = merged; validationIssues = [] }
  else return fail('provider_invalid_output')
  const counts = extraction.kind === 'workout'
    ? { sessions: extraction.sessions.length, exercises: extraction.sessions.reduce((n, s) => n + s.exercises.length, 0), days: 0, meals: 0, foods: 0 }
    : { sessions: 0, exercises: 0, days: extraction.days.length, meals: extraction.days.reduce((n, d) => n + d.meals.length, 0), foods: extraction.days.reduce((n, d) => n + d.meals.reduce((m, meal) => m + meal.foods.length, 0), 0) }
  log({ event: 'analysis_result', segment: null, profile: null, outcome: extraction.outcome, attempts: current.attemptCount,
    counts: { ...counts, uncoveredSections: validationIssues.filter(i => i.code === 'section_not_covered').length } })
  try {
    const job = await jobs.complete(input.ownerId, current, {
      extraction, validationIssues,
      // Il trigger del ledger (15) riscrive token e costo: qui solo il conteggio atteso dal DB.
      usageSummary: { providerCalls: current.attemptCount, inputTokens: null, outputTokens: null, reasoningTokens: null, cached: false, costEstimate: null },
    })
    return { status: 'job', job }
  } catch (error) {
    if (!isRpcError(error) || error.code !== 'PT409') throw error
    const latest = await jobs.find(input.ownerId, input.request.analysisRequestId)
    if (!latest) throw error
    return { status: 'job', job: latest }
  }
}
