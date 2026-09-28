/**
 * Protocollo dell'analisi (specifica §§4.1, 4.5, 9.3, 13): richiesta a `extract-plan`, risultato
 * del job (anche alla ripresa), stati server distinti dagli stati locali e limiti configurabili.
 * Solo contratti: endpoint (17), tabelle jobs (14), budget (15) e macchina a stati locale (07)
 * li implementano.
 */
import { dietExtractionSchema, EXTRACTION_SCHEMA_VERSION, extractionKinds, workoutExtractionSchema } from './extraction.ts'
import { normalizedDocumentSchema, validateNormalizedDocument, type NormalizedDocument } from './normalized-document.ts'
import type { ReaderLimitDetail } from './reader.ts'
import { validationIssueSchema } from './review.ts'
import {
  array, boolean, contractLimits, enumeration, errorList, literal, nullable, number, object, refine, string, taggedUnion, uuidSchema, validate,
  type ContractError, type Infer, type ValidationResult,
} from './schema.ts'

export const EXTRACT_PLAN_FUNCTION = 'extract-plan'
/** Lettura di un job proprio per la ripresa: `public.get_import_job(p_job_id uuid) returns jsonb` (ImportJobResult, null se assente). */
export const importJobRpcNames = { read: 'get_import_job' } as const

/** Stati del job sul server: solo lo stato già scritto nel database, nessun worker durevole promesso. */
export const importJobStatuses = ['running', 'ready', 'failed', 'expired'] as const
/**
 * Stati locali della revisione (07), distinti dal job: il server non conosce editing, ready locale,
 * salvataggio o `save_unknown`, e un job `ready` non rende la bozza salvabile.
 */
export const importLocalStates = [
  'selected', 'reading', 'analyzing', 'reviewing', 'ready', 'saving', 'saved', 'failed', 'cancelled', 'expired', 'save_unknown',
] as const
export type ImportJobStatus = typeof importJobStatuses[number]
export type ImportLocalState = typeof importLocalStates[number]

// ---------------------------------------------------------------------------
// Limiti configurabili
// ---------------------------------------------------------------------------

const MiB = 1024 * 1024
/**
 * Valori iniziali (specifica §4.1), da collaudare su iPhone; non sono limiti dei fornitori.
 * Nessun limite tronca: un superamento produce un errore `limit_exceeded` con {limit, max, actual}.
 */
export const defaultImportLimits = {
  /** Byte del file scelto, prima di leggerlo. */
  fileBytes: 10 * MiB,
  pdfPages: 30,
  docxEntries: 2000,
  /** Somma dei byte decompressi dichiarati e letti delle entry DOCX. */
  docxUncompressedBytes: 50 * MiB,
  /** Caratteri Unicode del testo dei blocchi del NormalizedDocument. */
  normalizedTextChars: 200_000,
  /** Blocchi del NormalizedDocument inviati all'endpoint. */
  blocks: 10_000,
  /** Byte UTF-8 del corpo HTTP di extract-plan, verificati prima del parsing JSON. */
  requestBodyBytes: 8 * MiB,
  /** Profondità massima del JSON ricevuto (un NormalizedDocument ne usa 5). */
  jsonDepth: 16,
  /** Chiamate al provider per analisi, segmenti e retry compresi. I token sono misurati a parte (15/16). */
  providerCallsPerAnalysis: 2,
} as const
export type ImportLimitName = keyof typeof defaultImportLimits
export type ImportLimits = { readonly [K in ImportLimitName]: number }

/**
 * Ordine di valutazione: dal controllo più economico al più costoso, fermandosi al primo superato.
 * Browser: file → formato (pagine/entry/decompressi) → testo/blocchi. Server: corpo → profondità →
 * schema → testo/blocchi → budget token e chiamate (15). Il browser anticipa i controlli per dare
 * un errore rapido, ma non li sostituisce.
 */
export const importLimitOrder: readonly ImportLimitName[] = [
  'fileBytes', 'pdfPages', 'docxEntries', 'docxUncompressedBytes',
  'requestBodyBytes', 'jsonDepth', 'normalizedTextChars', 'blocks', 'providerCallsPerAnalysis',
]

/**
 * Precedenza delle fonti: configurazione server > valori predefiniti. La configurazione può alzare
 * o abbassare un limite (documenti lunghi richiedono selezione esplicita o limite configurato), mai
 * annullarlo; il client non sceglie i limiti del server. Valori non interi positivi sono rifiutati.
 */
export function resolveImportLimits(configured: Partial<Record<ImportLimitName, unknown>> = {}): ImportLimits {
  const limits: Record<string, number> = { ...defaultImportLimits }
  for (const [name, value] of Object.entries(configured)) {
    if (!Object.hasOwn(defaultImportLimits, name)) throw new RangeError(`Limite import sconosciuto: ${name}.`)
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new RangeError(`Limite import non valido: ${name}.`)
    limits[name] = value
  }
  return Object.freeze(limits) as ImportLimits
}

/** Profondità del valore JSON (scalare = 0), calcolata senza ricorsione e interrotta appena supera `max`. */
export function jsonDepthExceeds(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]]
  while (stack.length) {
    const [current, depth] = stack.pop()!
    if (current === null || typeof current !== 'object') continue
    if (depth + 1 > max) return true
    for (const child of Array.isArray(current) ? current : Object.values(current)) stack.push([child, depth + 1])
  }
  return false
}

/** Limiti del documento normalizzato: stessa verifica nel browser prima dell'invio e sul server. */
export function normalizedDocumentLimitViolations(document: NormalizedDocument, limits: ImportLimits = defaultImportLimits): ReaderLimitDetail[] {
  const violations: ReaderLimitDetail[] = []
  if (document.blocks.length > limits.blocks) violations.push({ limit: 'blocks', max: limits.blocks, actual: document.blocks.length })
  const chars = document.blocks.reduce((total, block) => total + [...block.text].length, 0)
  if (chars > limits.normalizedTextChars) violations.push({ limit: 'normalizedTextChars', max: limits.normalizedTextChars, actual: chars })
  return violations
}

// ---------------------------------------------------------------------------
// Richiesta e risultato
// ---------------------------------------------------------------------------

/**
 * POST extract-plan, Authorization: Bearer <sessione utente>. Nessun provider, modello, prompt o
 * hash fidato dal browser: normalizedHash e chiave di cache sono calcolati dal server.
 * analysisRequestId identifica il tentativo logico: stessa chiave e stesso input → stesso job
 * (anche come ripresa dopo risposta persa), input diverso → request_conflict.
 */
export const extractPlanRequestSchema = object({
  analysisRequestId: uuidSchema,
  kind: enumeration(extractionKinds),
  normalizedDocument: normalizedDocumentSchema,
  expectedSchemaVersion: literal(EXTRACTION_SCHEMA_VERSION),
})
export type ExtractPlanRequest = Infer<typeof extractPlanRequestSchema>

export function validateExtractPlanRequest(value: unknown): ValidationResult<ExtractPlanRequest> {
  const shape = validate(extractPlanRequestSchema, value)
  if (!shape.ok) return shape
  const document = validateNormalizedDocument(shape.value.normalizedDocument)
  return document.ok ? shape : { ok: false, errors: document.errors.map(error => ({ ...error, path: `/normalizedDocument${error.path}` })) }
}

export const importErrorCodes = [
  'unauthenticated', 'invalid_request', 'unsupported_schema_version', 'limit_exceeded', 'budget_exhausted',
  'request_conflict', 'job_not_found', 'provider_unavailable', 'provider_refused', 'provider_incomplete',
  'provider_invalid_output', 'provider_outcome_uncertain', 'internal',
] as const
/**
 * Errore sicuro, senza testo del documento o dettagli del provider. `provider_outcome_uncertain`:
 * la chiamata può essere già costata; prima di un retry si rilegge il job.
 */
export const importErrorSchema = refine(object({
  code: enumeration(importErrorCodes),
  message: string({ minLength: 1, maxLength: 1000 }),
  retryable: boolean(),
  limit: nullable(object({ limit: string({ minLength: 1, maxLength: contractLimits.codeChars }), max: number(), actual: nullable(number()) })),
}), [{
  code: 'status_mismatch', description: 'limit presente solo con limit_exceeded.',
  check(error, report) { if ((error.code === 'limit_exceeded') !== (error.limit !== null)) report('/limit', 'Il dettaglio del limite accompagna solo limit_exceeded.') },
}])
/** Corpo delle risposte HTTP di errore che non riguardano un job esistente (401, 400, 409, 413…). */
export const extractPlanErrorBodySchema = object({ error: importErrorSchema })

export const usageSummarySchema = object({
  providerCalls: number({ integer: true, minimum: 0 }),
  inputTokens: nullable(number({ integer: true, minimum: 0 })),
  outputTokens: nullable(number({ integer: true, minimum: 0 })),
  reasoningTokens: nullable(number({ integer: true, minimum: 0 })),
  /** Risultato riusato dalla cache privata dell'account: nessuna nuova chiamata. */
  cached: boolean(),
  /** Stima del ledger (15), null se non disponibile. */
  costEstimate: nullable(object({ amountMicros: number({ integer: true, minimum: 0 }), currency: enumeration(['EUR', 'USD']) })),
})

/**
 * Risultato del job: risposta del POST e della lettura per la ripresa, solo per i job propri.
 * ready → estrazione validata del dominio richiesto e problemi applicativi (06); running → niente
 * risultato; failed → errore; expired → contenuti eliminati, serve una nuova analisi.
 */
export const importJobResultSchema = object({
  jobId: uuidSchema,
  analysisRequestId: uuidSchema,
  kind: enumeration(extractionKinds),
  status: enumeration(importJobStatuses),
  extraction: nullable(taggedUnion('kind', [workoutExtractionSchema, dietExtractionSchema])),
  validationIssues: array(validationIssueSchema, { maxItems: contractLimits.items }),
  usageSummary: usageSummarySchema,
  error: nullable(importErrorSchema),
  /** Scadenza dei contenuti (ISO 8601 con fuso), 7 giorni di inattività per impostazione iniziale. */
  expiresAt: string({ minLength: 20, maxLength: 40, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/ }),
})
export type ImportError = Infer<typeof importErrorSchema>
export type ImportErrorCode = typeof importErrorCodes[number]
export type UsageSummary = Infer<typeof usageSummarySchema>
export type ImportJobResult = Infer<typeof importJobResultSchema>

function jobResultErrors(result: ImportJobResult): ContractError[] {
  const errors = errorList()
  const ready = result.status === 'ready'
  if (ready !== (result.extraction !== null)) errors.add('/extraction', 'status_mismatch', 'Solo un job pronto ha un’estrazione.')
  if ((result.status === 'failed') !== (result.error !== null)) errors.add('/error', 'status_mismatch', 'Solo un job fallito ha un errore.')
  if (!ready && result.validationIssues.length) errors.add('/validationIssues', 'status_mismatch', 'Problemi applicativi solo su un risultato pronto.')
  if (result.extraction !== null && result.extraction.kind !== result.kind) errors.add('/extraction/kind', 'kind_mismatch', 'Estrazione di un altro dominio.')
  if (!Number.isFinite(Date.parse(result.expiresAt))) errors.add('/expiresAt', 'invalid_date', 'Data di scadenza non valida.')
  return errors.errors
}

export function validateImportJobResult(value: unknown): ValidationResult<ImportJobResult> {
  const shape = validate(importJobResultSchema, value)
  if (!shape.ok) return shape
  const errors = jobResultErrors(shape.value)
  return errors.length ? { ok: false, errors } : shape
}
