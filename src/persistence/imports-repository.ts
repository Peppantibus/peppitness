/**
 * Repository di rete dell'importazione: ricevute e RPC di conferma (19/20). Tutto sotto la sessione
 * dell'account per cui è creato: Authorization esplicita a ogni chiamata, owner confrontato con la sessione
 * corrente, retry dell'SDK disattivato e segnale sempre esplicito (il timeout globale di 15 s del client non
 * vale qui).
 *
 * Ogni risposta è `unknown` finché non passa il contratto. Esiti:
 * - `ImportsFailure`: sessione assente o di un altro account, annullamento, rete/timeout (`uncertain`:
 *   la richiesta può essere arrivata), servizio non disponibile o risposta non conforme;
 * - `CommitRejected`: rifiuto definitivo di una RPC di conferma (rollback certo, nessuna scrittura).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  commitRpcArgs, commitRpcErrors, importRpcNames, UUID_PATTERN, validateImportReceipt,
  type CommitCommand, type DietCommitCommand, type ImportReceipt, type WorkoutCommitCommand,
} from '../import/contracts/index.ts'

/** Letture e conferme: transazioni brevi, ma più lunghe del timeout globale dell'app. */
export const IMPORT_RPC_TIMEOUT_MS = 30_000

export type ImportsFailureKind = 'session' | 'aborted' | 'uncertain' | 'unavailable' | 'invalid_response'
export class ImportsFailure extends Error {
  readonly kind: ImportsFailureKind
  constructor(kind: ImportsFailureKind, message: string = kind) { super(message); this.name = 'ImportsFailure'; this.kind = kind }
}

export const commitRejections = ['invalid_command', 'not_available', 'request_conflict', 'selection_conflict', 'catalog_conflict', 'analysis_expired'] as const
export type CommitRejection = typeof commitRejections[number]
/** Rifiuto definitivo della RPC: la transazione è stata annullata, nulla è stato scritto. */
export class CommitRejected extends Error {
  readonly reason: CommitRejection
  constructor(reason: CommitRejection) { super(reason); this.name = 'CommitRejected'; this.reason = reason }
}

export interface ImportsRepository {
  readonly ownerId: string
  getReceipt(requestId: string, signal: AbortSignal): Promise<ImportReceipt | null>
  commitWorkout(command: WorkoutCommitCommand, signal: AbortSignal): Promise<ImportReceipt>
  commitDiet(command: DietCommitCommand, signal: AbortSignal): Promise<ImportReceipt>
}

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value)
const invalid = (): never => { throw new ImportsFailure('invalid_response', 'Risposta del server non conforme.') }

/** Segnale del chiamante più timeout; distingue l'annullamento voluto dalla scadenza del tempo. */
function bounded(signal: AbortSignal, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return { signal: AbortSignal.any([signal, timeout]), failure: (): ImportsFailure => signal.aborted ? new ImportsFailure('aborted') : new ImportsFailure('uncertain', 'Tempo scaduto.') }
}

/** Codice/messaggio stabili di una RPC di conferma → rifiuto definitivo, sessione o esito incerto. */
export function commitFailure(error: { code?: string; message?: string } | null | undefined): CommitRejected | ImportsFailure {
  const code = error?.code ?? '', message = error?.message ?? ''
  if (code === commitRpcErrors.analysisExpired.sqlstate) return new CommitRejected('analysis_expired')
  if (code === 'PT409') {
    if (message === commitRpcErrors.selectionConflict.message) return new CommitRejected('selection_conflict')
    if (message === commitRpcErrors.catalogConflict.message) return new CommitRejected('catalog_conflict')
    return new CommitRejected('request_conflict')
  }
  if (code === commitRpcErrors.invalidCommand.sqlstate || code === '22P02') return new CommitRejected('invalid_command')
  if (code === '42501') return message === commitRpcErrors.notAvailable.message ? new CommitRejected('not_available') : new ImportsFailure('session', 'Sessione non valida.')
  // Rete, gateway o errore imprevisto: il commit può essere avvenuto.
  return new ImportsFailure('uncertain', 'Esito del salvataggio non confermato.')
}

export function createImportsRepository(client: SupabaseClient, owner: string): ImportsRepository {
  async function token(signal: AbortSignal) {
    const { data, error } = await client.auth.getSession()
    signal.throwIfAborted()
    if (error || !data.session || data.session.user.id !== owner) throw new ImportsFailure('session', 'Sessione assente o di un altro account.')
    return data.session.access_token
  }
  async function commit(command: CommitCommand, signal: AbortSignal): Promise<ImportReceipt> {
    const limit = bounded(signal, IMPORT_RPC_TIMEOUT_MS)
    const auth = await token(limit.signal).catch(error => { throw limit.signal.aborted ? limit.failure() : error })
    const { data, error } = await client.rpc(importRpcNames[command.payload.kind], commitRpcArgs(command) as unknown as Record<string, unknown>)
      .setHeader('Authorization', `Bearer ${auth}`).abortSignal(limit.signal).retry(false)
    // Annullamento o timeout dopo l'invio: la transazione può essere stata applicata.
    if (limit.signal.aborted) throw signal.aborted ? new ImportsFailure('aborted') : new ImportsFailure('uncertain', 'Tempo scaduto.')
    if (error) throw commitFailure(error)
    const checked = validateImportReceipt(data)
    // Una risposta 2xx non conforme non prova nulla: si verifica con la ricevuta.
    if (!checked.ok) throw new ImportsFailure('uncertain', 'Ricevuta non conforme.')
    return checked.value
  }

  return {
    ownerId: owner,
    async getReceipt(requestId, signal) {
      if (!isUuid(requestId)) throw new ImportsFailure('invalid_response', 'Chiave della richiesta non valida.')
      const limit = bounded(signal, IMPORT_RPC_TIMEOUT_MS)
      const auth = await token(limit.signal).catch(error => { throw limit.signal.aborted ? limit.failure() : error })
      // Lettura: un errore non è mai un esito incerto (nessuna scrittura).
      const { data, error } = await client.rpc(importRpcNames.receipt, { p_request_id: requestId })
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(limit.signal).retry(false)
      if (limit.signal.aborted) throw signal.aborted ? new ImportsFailure('aborted') : new ImportsFailure('unavailable', 'Tempo scaduto.')
      if (error) throw new ImportsFailure(error.code === '42501' ? 'session' : 'unavailable', 'Lettura non riuscita.')
      if (data === null) return null
      const checked = validateImportReceipt(data)
      return checked.ok && checked.value.requestId === requestId ? checked.value : invalid()
    },
    commitWorkout: (command, signal) => commit(command, signal),
    commitDiet: (command, signal) => commit(command, signal),
  }
}
