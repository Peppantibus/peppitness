/**
 * Persistenza dell'analisi, non esecuzione in background. Nessun provider o piano.
 * Il chiamante verifica l'identità (getUser) PRIMA di passare ownerId; rpc deve usare
 * il client server riservato ai jobs. Non passare mai body/profilo/hash del client alle RPC.
 */
import {
  EXTRACTION_SCHEMA_VERSION, validateExtractPlanRequest, validateImportJobResult,
  validate, uuidSchema, type ExtractPlanRequest, type ImportJobResult, type ImportErrorCode,
} from './contracts.ts'
import { canonicalHash, normalizedHash } from './canonical.ts'

export interface AnalysisProfile {
  readonly promptVersion: string
  readonly provider: string
  readonly model: string
  readonly rulesVersion: string
}
export const jobServerRpcNames = {
  create: 'create_import_job', find: 'find_import_job', complete: 'complete_import_job',
  fail: 'fail_import_job', touch: 'touch_import_job', expire: 'expire_import_job',
} as const
export type JobServerRpcName = typeof jobServerRpcNames[keyof typeof jobServerRpcNames]
/** Trasporto iniettato: deve propagare errori SQL, senza loggare argomenti o dati. */
export type JobRpc = (name: JobServerRpcName, args: Record<string, unknown>) => Promise<unknown>
export const providerOutcomes = ['not_started', 'in_flight', 'known_failure', 'uncertain', 'completed', 'cache_hit'] as const
export interface ServerJob {
  job: ImportJobResult
  revision: number
  draftRevision: number | null
  leaseToken: string | null
  leaseExpiresAt: string | null
  attemptCount: number
  providerOutcome: typeof providerOutcomes[number]
  created: boolean
}
function id(value: string): void {
  if (!validate(uuidSchema, value).ok) throw new TypeError('Invalid job identity')
}
function profileValue(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._@/+:-]{0,199}$/.test(value)) {
    throw new TypeError('Invalid analysis profile')
  }
  return value
}
/** Hash dell'input completo, indipendente dal profilo corrente e distinto dalla chiave di cache. */
export async function prepareImportJob(ownerId: string, value: unknown, profile: AnalysisProfile) {
  id(ownerId)
  const checked = validateExtractPlanRequest(value)
  if (!checked.ok) throw new TypeError('Invalid analysis request')
  // Snapshot prima del primo await: il chiamante non può cambiare input/profilo durante l'hash.
  const request: ExtractPlanRequest = structuredClone(checked.value)
  const versions = {
    reader: request.normalizedDocument.readerVersion, schema: EXTRACTION_SCHEMA_VERSION,
    prompt: profileValue(profile.promptVersion), provider: profileValue(profile.provider),
    model: profileValue(profile.model), rules: profileValue(profile.rulesVersion),
  }
  const inputHash = await canonicalHash({ hash: 'peppitness.analysis-input.v1', request })
  const documentHash = await normalizedHash(request.normalizedDocument)
  return {
    p_owner_id: ownerId, p_request_id: request.analysisRequestId, p_kind: request.kind,
    p_input_hash: inputHash, p_normalized_hash: documentHash, p_versions: versions,
    p_document: request.normalizedDocument,
  }
}
/** Il risultato pubblico resta esattamente ImportJobResult; metadati della lease solo server. */
export function parseServerJob(value: unknown): ServerJob {
  const x = value as ServerJob | null
  if (!x || !validateImportJobResult(x.job).ok || !Number.isSafeInteger(x.revision) || x.revision < 1
    || !(x.draftRevision === null || (Number.isSafeInteger(x.draftRevision) && x.draftRevision >= 1))
    || !(x.leaseToken === null || validate(uuidSchema, x.leaseToken).ok)
    || !(x.leaseExpiresAt === null || (typeof x.leaseExpiresAt === 'string' && Number.isFinite(Date.parse(x.leaseExpiresAt))))
    || !Number.isSafeInteger(x.attemptCount) || x.attemptCount < 0
    || !providerOutcomes.includes(x.providerOutcome) || typeof x.created !== 'boolean') {
    throw new TypeError('Invalid stored analysis job')
  }
  return x
}
function mutationArgs(ownerId: string, value: ServerJob) {
  id(ownerId)
  const current = parseServerJob(value)
  return { p_owner_id: ownerId, p_job_id: current.job.jobId, p_expected_revision: current.revision }
}
export function createJobsAdapter(rpc: JobRpc) {
  return {
    async create(ownerId: string, request: unknown, profile: AnalysisProfile): Promise<ServerJob> {
      return parseServerJob(await rpc(jobServerRpcNames.create, await prepareImportJob(ownerId, request, profile)))
    },
    async find(ownerId: string, requestId: string): Promise<ServerJob | null> {
      id(ownerId); id(requestId)
      const result = await rpc(jobServerRpcNames.find, { p_owner_id: ownerId, p_request_id: requestId })
      return result === null ? null : parseServerJob(result)
    },
    async complete(ownerId: string, current: ServerJob, result: Pick<ImportJobResult, 'extraction' | 'validationIssues' | 'usageSummary'>): Promise<ServerJob> {
      const args = mutationArgs(ownerId, current)
      const snapshot = structuredClone(result)
      if (!validateImportJobResult({ ...current.job, ...snapshot, status: 'ready', error: null }).ok) {
        throw new TypeError('Invalid analysis result')
      }
      return parseServerJob(await rpc(jobServerRpcNames.complete, {
        ...args, p_lease_token: current.leaseToken, p_expected_draft_revision: current.draftRevision,
        p_result: snapshot,
      }))
    },
    /** Errore codificato: nessun messaggio/provider body/documento viene passato al DB. */
    async fail(ownerId: string, current: ServerJob, code: ImportErrorCode): Promise<ServerJob> {
      if (!['provider_unavailable', 'provider_refused', 'provider_incomplete', 'provider_invalid_output', 'provider_outcome_uncertain', 'internal'].includes(code)) {
        throw new TypeError('Invalid analysis failure')
      }
      return parseServerJob(await rpc(jobServerRpcNames.fail, { ...mutationArgs(ownerId, current), p_lease_token: current.leaseToken, p_code: code }))
    },
    /** Attività esplicita; la semplice lettura/poll non prolunga la conservazione dei contenuti. */
    async touch(ownerId: string, current: ServerJob): Promise<ServerJob> {
      return parseServerJob(await rpc(jobServerRpcNames.touch, mutationArgs(ownerId, current)))
    },
    /** Solo contenuti già scaduti; schedulazione e purge a lotti sono il task 23. */
    async expire(ownerId: string, current: ServerJob): Promise<ServerJob> {
      return parseServerJob(await rpc(jobServerRpcNames.expire, mutationArgs(ownerId, current)))
    },
  }
}
