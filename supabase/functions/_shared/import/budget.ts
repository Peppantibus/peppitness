/** Nessun provider qui. Il coordinatore 17 deve passare OGNI chiamata (segmenti e
 * retry inclusi) da runBudgetedAttempt, con il body effettivo completo serializzato.
 * La riserva copre il massimo di questa chiamata; un retry ne richiede una nuova.
 * Nessun numero di segmenti è nascosto in un singolo tentativo.
 */
import { sha256Hex } from './canonical.ts'
import { validate, uuidSchema } from './contracts.ts'
import { parseServerJob, type ServerJob } from './jobs.ts'

export const budgetRpcNames = {
  config: 'get_import_budget_config', lookup: 'get_import_reservation', reserve: 'reserve_import_budget',
  dispatch: 'dispatch_import_attempt', reconcile: 'reconcile_import_usage',
} as const
export type BudgetRpc = (name: typeof budgetRpcNames[keyof typeof budgetRpcNames], args: Record<string, unknown>) => Promise<unknown>
export const budgetFailures = {
  disabled: ['PT503', 'Import analysis disabled'],
  project: ['PT429', 'Import project budget exhausted'],
  account: ['PT429', 'Import account budget exhausted'],
  reduced: ['PT429', 'Import budget reduced'],
  daily: ['PT429', 'Import daily quota exhausted'],
  attempts: ['PT429', 'Import attempt quota exhausted'],
  retryAfter: ['PT429', 'Import retry deferred'],
  concurrency: ['PT409', 'Import account concurrency limit'],
  active: ['PT409', 'Import analysis already active'],
  tokens: ['PT413', 'Import token limit exceeded'],
} as const

function integer(value: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new RangeError('Invalid import budget number')
  return value
}
function uuid(value: string): string {
  if (!validate(uuidSchema, value).ok) throw new TypeError('Invalid import budget identity')
  return value
}
/** Interi micro-valuta: ceil separato input/output, stessi vettori del DB. */
export function estimateCostMicros(inputTokens: number, outputTokens: number, inputMicrosPerMillion: number, outputMicrosPerMillion: number): number {
  const input = BigInt(integer(inputTokens)) * BigInt(integer(inputMicrosPerMillion))
  const output = BigInt(integer(outputTokens)) * BigInt(integer(outputMicrosPerMillion))
  const total = (input + 999999n) / 1000000n + (output + 999999n) / 1000000n
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('Import cost overflow')
  return Number(total)
}
/** Upper bound sul body intero (prompt/schema/documento/segmenti), non sul solo testo. */
export function conservativeInputTokens(serializedRequest: string, framingTokens: number): number {
  if (typeof serializedRequest !== 'string' || !serializedRequest) throw new TypeError('Empty import provider request')
  return integer(new TextEncoder().encode(serializedRequest).length + integer(framingTokens), 2147483647)
}

export interface ProviderUsage { inputTokens: number | null; outputTokens: number | null; reasoningTokens: number | null }
export const unknownUsage: Readonly<ProviderUsage> = Object.freeze({ inputTokens: null, outputTokens: null, reasoningTokens: null })
/** Il provider adapter normalizza outputTokens INCLUSIVI del reasoning. Il campo
 * reasoningTokens è un dettaglio, non un secondo addebito. Null resta ignoto. */
export function normalizeUsage(value: ProviderUsage | null): ProviderUsage {
  if (value === null) return { ...unknownUsage }
  for (const key of ['inputTokens', 'outputTokens', 'reasoningTokens'] as const) {
    if (value[key] !== null) integer(value[key], 2147483647)
  }
  if (value.outputTokens !== null && value.reasoningTokens !== null && value.reasoningTokens > value.outputTokens) {
    throw new RangeError('Reasoning exceeds total output')
  }
  return { inputTokens: value.inputTokens, outputTokens: value.outputTokens, reasoningTokens: value.reasoningTokens }
}
export function usageKnown(value: ProviderUsage): boolean { return value.inputTokens !== null && value.outputTokens !== null }

export interface BudgetReservation {
  reservationId: string; jobId: string; attempt: number | null
  state: 'reserved' | 'sent' | 'uncertain' | 'settled' | 'cancelled'
  requestHash: string; inputUpperTokens: number; maxOutputTokens: number
  provider: string; model: string; currency: 'EUR' | 'USD'; configVersion: string; priceVersion: string
  reservedMicros: number; actualMicros: number | null; sendGranted: boolean; job: ServerJob
}
export function parseBudgetReservation(value: unknown): BudgetReservation {
  const x = value as BudgetReservation | null
  if (!x || !['reserved', 'sent', 'uncertain', 'settled', 'cancelled'].includes(x.state)
    || typeof x.sendGranted !== 'boolean' || !/^[0-9a-f]{64}$/.test(x.requestHash)
    || !['EUR', 'USD'].includes(x.currency)
    || [x.provider, x.model, x.configVersion, x.priceVersion].some(v => typeof v !== 'string' || !v)
    || (x.sendGranted && x.state !== 'sent')) throw new TypeError('Invalid import reservation response')
  uuid(x.reservationId); uuid(x.jobId)
  integer(x.inputUpperTokens, 2147483647); integer(x.maxOutputTokens, 2147483647); integer(x.reservedMicros)
  if (x.actualMicros !== null) integer(x.actualMicros)
  if (x.attempt !== null && integer(x.attempt) < 1) throw new TypeError('Invalid import attempt')
  if ((['reserved', 'cancelled'].includes(x.state)) !== (x.attempt === null)
    || (['settled', 'cancelled'].includes(x.state)) !== (x.actualMicros !== null)) throw new TypeError('Invalid import reservation state')
  if (parseServerJob(x.job).job.jobId !== x.jobId) throw new TypeError('Invalid import reservation job')
  return x
}
export interface BudgetCall {
  ownerId: string; job: ServerJob; reservationId: string
  serializedRequest: string; maxOutputTokens: number; retry?: boolean
}
export function createBudgetAdapter(rpc: BudgetRpc) {
  return {
    async config(): Promise<Record<string, unknown>> {
      const result = await rpc(budgetRpcNames.config, {}) as Record<string, unknown> | null
      if (!result || typeof result.enabled !== 'boolean') throw new TypeError('Invalid import budget config')
      return result
    },
    async lookup(ownerId: string, reservationId: string): Promise<BudgetReservation | null> {
      const result = await rpc(budgetRpcNames.lookup, { p_owner_id: uuid(ownerId), p_reservation_id: uuid(reservationId) })
      return result === null ? null : parseBudgetReservation(result)
    },
    async reserve(call: BudgetCall): Promise<BudgetReservation> {
      // Snapshot prima dell'hash: nessuna mutazione del body durante gli await.
      const body = call.serializedRequest
      const args = { p_owner_id: uuid(call.ownerId), p_job_id: parseServerJob(call.job).job.jobId,
        p_reservation_id: uuid(call.reservationId), p_expected_revision: call.job.revision,
        p_input_bytes: conservativeInputTokens(body, 0), p_max_output_tokens: integer(call.maxOutputTokens, 2147483647), p_retry: call.retry ?? false }
      if (args.p_max_output_tokens === 0) throw new RangeError('Output token cap required')
      return parseBudgetReservation(await rpc(budgetRpcNames.reserve, { ...args, p_request_hash: await sha256Hex(body) }))
    },
    async dispatch(ownerId: string, reservationId: string): Promise<BudgetReservation> {
      return parseBudgetReservation(await rpc(budgetRpcNames.dispatch, { p_owner_id: uuid(ownerId), p_reservation_id: uuid(reservationId) }))
    },
    async reconcile(ownerId: string, reservationId: string, outcome: 'known' | 'uncertain' | 'not_sent', usage: ProviderUsage | null, retryAfterSeconds = 0): Promise<BudgetReservation> {
      const normalized = normalizeUsage(usage)
      if (outcome === 'known' && !usageKnown(normalized)) throw new TypeError('Unknown usage cannot settle')
      if (outcome === 'not_sent' && Object.values(normalized).some(v => v !== 0)) throw new TypeError('Cancellation requires known zero before dispatch')
      return parseBudgetReservation(await rpc(budgetRpcNames.reconcile, { p_owner_id: uuid(ownerId), p_reservation_id: uuid(reservationId),
        p_outcome: outcome, p_usage: normalized, p_retry_after_seconds: integer(retryAfterSeconds, 86400) }))
    },
  }
}
export type BudgetAdapter = ReturnType<typeof createBudgetAdapter>
export interface BudgetedProviderResult<T> { value: T; usage: ProviderUsage | null; retryAfterSeconds?: number }
export type BudgetedCallResult<T> = { status: 'completed'; value: T; reservation: BudgetReservation }
  | { status: 'uncertain' | 'not_dispatched'; reservation: BudgetReservation }

/** Unico invio, nessun retry nascosto. Se il permesso va perso in rete, lookup e
 * riserva persistono: il chiamante NON può interpretare il timeout come zero. */
export async function runBudgetedAttempt<T>(adapter: BudgetAdapter, call: BudgetCall,
  invoke: (permit: Readonly<BudgetReservation>, serializedRequest: string) => Promise<BudgetedProviderResult<T>>): Promise<BudgetedCallResult<T>> {
  const frozen = structuredClone(call)
  const reservation = await adapter.reserve(frozen)
  if (reservation.requestHash !== await sha256Hex(frozen.serializedRequest)) throw new TypeError('Import request changed')
  const permit = await adapter.dispatch(frozen.ownerId, reservation.reservationId)
  if (!permit.sendGranted) return { status: 'not_dispatched', reservation: permit }
  if (permit.reservationId !== reservation.reservationId || permit.jobId !== frozen.job.job.jobId
    || permit.requestHash !== reservation.requestHash || permit.maxOutputTokens !== frozen.maxOutputTokens) {
    throw new TypeError('Import dispatch permit mismatch')
  }
  let result: BudgetedProviderResult<T>
  try { result = await invoke(permit, frozen.serializedRequest) }
  catch {
    return { status: 'uncertain', reservation: await adapter.reconcile(frozen.ownerId, permit.reservationId, 'uncertain', null) }
  }
  let usage: ProviderUsage
  try { usage = normalizeUsage(result.usage) }
  catch { usage = { ...unknownUsage } }
  const reconciled = await adapter.reconcile(frozen.ownerId, permit.reservationId, usageKnown(usage) ? 'known' : 'uncertain', usage, result.retryAfterSeconds)
  return { status: 'completed', value: result.value, reservation: reconciled }
}
