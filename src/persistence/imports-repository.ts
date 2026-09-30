/**
 * Repository di rete dell'importazione (task 21): endpoint `extract-plan`, job e bozze private (14),
 * ricevute (18) e RPC di conferma (19/20). Tutto sotto la sessione dell'account per cui è creato:
 * Authorization esplicita a ogni chiamata, owner confrontato con la sessione corrente, retry dell'SDK
 * disattivato e segnale sempre esplicito (il timeout globale di 15 s del client non vale qui).
 *
 * Ogni risposta è `unknown` finché non passa il contratto 01/02. Esiti:
 * - `ImportsFailure`: sessione assente o di un altro account, annullamento, rete/timeout (`uncertain`:
 *   la richiesta può essere arrivata), servizio non disponibile o risposta non conforme;
 * - `CommitRejected`: rifiuto definitivo di una RPC di conferma (rollback certo, nessuna scrittura);
 * - errore dell'endpoint con corpo `{ error }` restituito come valore, non lanciato.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  commitRpcArgs, commitRpcErrors, EXTRACT_PLAN_FUNCTION, importJobRpcNames, importRpcNames, UUID_PATTERN,
  validateImportJobResult, validateImportReceipt, validateNormalizedDocument, validate, extractPlanErrorBodySchema,
  type CommitCommand, type DietCommitCommand, type ExtractionKind, type ExtractPlanRequest, type ImportError, type ImportJobResult,
  type ImportReceipt, type NormalizedDocument, type WorkoutCommitCommand,
} from '../import/contracts/index.ts'

/** Oltre `IMPORT_ANALYSIS_DEADLINE_MS` (140 s di default sul server): la risposta arriva prima del timeout del client. */
export const IMPORT_ANALYSIS_TIMEOUT_MS = 170_000
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

export type AnalyzeResult =
  | { ok: true; job: ImportJobResult }
  /** Errore dell'endpoint senza job (401, 400, 409, 413, 429, 503, 500), già validato. */
  | { ok: false; status: number; error: ImportError }

export interface StoredAnalysisDraft { jobId: string; document: NormalizedDocument; expiresAt: string }
export interface DuplicateImport { requestId: string; planId: string; versionId: string | null; createdAt: string }

export interface ImportsRepository {
  readonly ownerId: string
  /** POST extract-plan. Rete/timeout → `ImportsFailure('uncertain')`: prima di altro si cerca il job. */
  analyze(request: ExtractPlanRequest, signal: AbortSignal): Promise<AnalyzeResult>
  /** `get_import_job`: job proprio non scaduto, altrimenti null. */
  readJob(jobId: string, signal: AbortSignal): Promise<ImportJobResult | null>
  /** Ricerca per chiave della richiesta (risposta persa): sola lettura, mai una nuova analisi. */
  findJob(analysisRequestId: string, signal: AbortSignal): Promise<ImportJobResult | null>
  /** Documento normalizzato conservato con il job (fonte della proposta). */
  readDraft(jobId: string, signal: AbortSignal): Promise<StoredAnalysisDraft | null>
  /** Analisi pronte e non scadute dello stesso account, dominio, fonte e reader: riaprirle non costa nulla. */
  findCompatibleAnalysis(input: { kind: ExtractionKind; sourceHash: string; readerVersion: string }, signal: AbortSignal): Promise<ImportJobResult[]>
  getReceipt(requestId: string, signal: AbortSignal): Promise<ImportReceipt | null>
  /** Importazioni confermate con lo stesso contenuto: si propone di riaprirle, la copia resta possibile. */
  findDuplicate(input: { kind: ExtractionKind; contentHash: string }, signal: AbortSignal): Promise<DuplicateImport[]>
  commitWorkout(command: WorkoutCommitCommand, signal: AbortSignal): Promise<ImportReceipt>
  commitDiet(command: DietCommitCommand, signal: AbortSignal): Promise<ImportReceipt>
}

type Row = Record<string, unknown>
const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value)
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID_PATTERN.test(value)
const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
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
  /** Lettura: un errore non è mai un esito incerto (nessuna scrittura). */
  async function read<T>(signal: AbortSignal, run: (auth: string, signal: AbortSignal) => PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>, parse: (data: unknown) => T): Promise<T> {
    const limit = bounded(signal, IMPORT_RPC_TIMEOUT_MS)
    const auth = await token(limit.signal).catch(error => { throw limit.signal.aborted ? limit.failure() : error })
    const { data, error } = await run(auth, limit.signal)
    if (limit.signal.aborted) throw signal.aborted ? new ImportsFailure('aborted') : new ImportsFailure('unavailable', 'Tempo scaduto.')
    if (error) throw new ImportsFailure(error.code === '42501' ? 'session' : 'unavailable', 'Lettura non riuscita.')
    return parse(data)
  }
  const parseJob = (data: unknown) => {
    if (data === null) return null
    const checked = validateImportJobResult(data)
    return checked.ok ? checked.value : invalid()
  }
  const readJob = (jobId: string, signal: AbortSignal) => {
    if (!isUuid(jobId)) throw new ImportsFailure('invalid_response', 'ID del job non valido.')
    return read(signal, (auth, bounded) => client.rpc(importJobRpcNames.read, { p_job_id: jobId })
      .setHeader('Authorization', `Bearer ${auth}`).abortSignal(bounded).retry(false), parseJob)
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
    async analyze(request, signal) {
      const limit = bounded(signal, IMPORT_ANALYSIS_TIMEOUT_MS)
      const auth = await token(limit.signal).catch(error => { throw limit.signal.aborted ? limit.failure() : error })
      const { data, error, response } = await client.functions.invoke(EXTRACT_PLAN_FUNCTION, {
        body: request, headers: { Authorization: `Bearer ${auth}` }, signal: limit.signal,
      })
      if (limit.signal.aborted) throw limit.failure()
      if (!error) {
        const checked = validateImportJobResult(data)
        if (!checked.ok) throw new ImportsFailure('uncertain', 'Risposta dell’analisi non conforme.')
        return { ok: true, job: checked.value }
      }
      // Solo una risposta HTTP con il corpo del contratto è un esito certo; relay, rete e corpi estranei no.
      if ((error as { name?: string }).name === 'FunctionsHttpError' && response) {
        let body: unknown = null
        try { body = await response.json() } catch { /* corpo assente o non JSON */ }
        const checked = validate(extractPlanErrorBodySchema, body)
        if (checked.ok) return { ok: false, status: response.status, error: checked.value.error }
      }
      throw new ImportsFailure('uncertain', 'Esito dell’analisi non confermato.')
    },
    readJob,
    async findJob(analysisRequestId, signal) {
      if (!isUuid(analysisRequestId)) throw new ImportsFailure('invalid_response', 'Chiave della richiesta non valida.')
      const id = await read(signal, (auth, bounded) => client.from('import_jobs').select('id,owner_id,analysis_request_id')
        .eq('owner_id', owner).eq('analysis_request_id', analysisRequestId)
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(bounded).retry(false).maybeSingle(), data => {
        if (data === null) return null
        if (!isRow(data) || data.owner_id !== owner || data.analysis_request_id !== analysisRequestId || !isUuid(data.id)) return invalid()
        return data.id as string
      })
      if (id === null) return null
      const job = await readJob(id, signal)
      return job && job.analysisRequestId === analysisRequestId ? job : job === null ? null : invalid()
    },
    readDraft(jobId, signal) {
      if (!isUuid(jobId)) throw new ImportsFailure('invalid_response', 'ID del job non valido.')
      return read(signal, (auth, bounded) => client.from('import_drafts').select('job_id,owner_id,normalized_document,expires_at')
        .eq('owner_id', owner).eq('job_id', jobId)
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(bounded).retry(false).maybeSingle(), data => {
        if (data === null) return null
        if (!isRow(data) || data.owner_id !== owner || data.job_id !== jobId || !isTime(data.expires_at)) return invalid()
        const document = validateNormalizedDocument(data.normalized_document)
        return document.ok ? { jobId, document: document.value, expiresAt: data.expires_at as string } : invalid()
      })
    },
    async findCompatibleAnalysis({ kind, sourceHash, readerVersion }, signal) {
      if (!/^[0-9a-f]{64}$/.test(sourceHash)) throw new ImportsFailure('invalid_response', 'Impronta non valida.')
      // Fonte e reader sono nel documento conservato; dominio e stato nel job (RLS: solo propri e non scaduti).
      const ids = await read(signal, (auth, bounded) => client.from('import_drafts').select('job_id,owner_id')
        .eq('owner_id', owner).eq('normalized_document->>sourceHash', sourceHash).eq('normalized_document->>readerVersion', readerVersion)
        .not('extraction', 'is', null).order('updated_at', { ascending: false }).limit(5)
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(bounded).retry(false), data => {
        if (!Array.isArray(data)) return invalid()
        return data.map(row => isRow(row) && row.owner_id === owner && isUuid(row.job_id) ? row.job_id as string : invalid())
      })
      const jobs: ImportJobResult[] = []
      for (const id of ids) {
        const job = await readJob(id, signal)
        if (job && job.kind === kind && job.status === 'ready') jobs.push(job)
      }
      return jobs
    },
    getReceipt(requestId, signal) {
      if (!isUuid(requestId)) throw new ImportsFailure('invalid_response', 'Chiave della richiesta non valida.')
      return read(signal, (auth, bounded) => client.rpc(importRpcNames.receipt, { p_request_id: requestId })
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(bounded).retry(false), data => {
        if (data === null) return null
        const checked = validateImportReceipt(data)
        return checked.ok && checked.value.requestId === requestId ? checked.value : invalid()
      })
    },
    findDuplicate({ kind, contentHash }, signal) {
      if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new ImportsFailure('invalid_response', 'Impronta non valida.')
      return read(signal, (auth, bounded) => client.from('import_receipts').select('owner_id,request_id,kind,plan_id,version_id,result_state,created_at')
        .eq('owner_id', owner).eq('kind', kind).eq('content_hash', contentHash).eq('result_state', 'committed')
        .order('created_at', { ascending: false }).limit(10)
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(bounded).retry(false), data => {
        if (!Array.isArray(data)) return invalid()
        return data.map((row): DuplicateImport => {
          if (!isRow(row) || row.owner_id !== owner || row.kind !== kind || row.result_state !== 'committed' || !isUuid(row.request_id) || !isUuid(row.plan_id)
            || !(row.version_id === null || isUuid(row.version_id)) || !isTime(row.created_at)) return invalid()
          return { requestId: row.request_id as string, planId: row.plan_id as string, versionId: row.version_id as string | null, createdAt: row.created_at as string }
        })
      })
    },
    commitWorkout: (command, signal) => commit(command, signal),
    commitDiet: (command, signal) => commit(command, signal),
  }
}
