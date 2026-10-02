/**
 * Confine server del provider di estrazione (specifica §14): interfaccia 01, configurazione
 * consentita e chiamata preparata. Nessun componente frontend importa questo modulo; il
 * provider concreto (openai-provider.ts) è scelto soltanto dalla configurazione server.
 *
 * La chiamata è divisa in `prepare` (body serializzato completo, misurabile e prenotabile dal
 * budget 15 prima dell'invio) e `send` (un solo invio, nessun retry nascosto). `extract` di 01
 * è la composizione dei due, per chi non deve prenotare.
 */
import type {
  ExtractionKind, ExtractionProfile, ExtractionProvider, ExtractionProviderCapabilities, ExtractionProviderResponse,
  ExtractionRequest,
} from './contracts.ts'
import { ExtractionProviderError } from './provider-errors.ts'
import { IMPORT_PROMPT_VERSION } from './prompts.ts'

export type {
  ExtractionKind, ExtractionProfile, ExtractionProvider, ExtractionProviderCapabilities, ExtractionProviderResponse, ExtractionRequest,
}

export const importProviderNames = ['openai'] as const
export type ImportProviderName = typeof importProviderNames[number]
/** Valori documentati dalla API; non tutti i modelli li accettano: si imposta solo se provato (25). */
export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = typeof reasoningEfforts[number]

/** Parametri per profilo: il modello di riserva si sceglie in base al corpus (25), non per prezzo. */
export interface ProviderProfileConfig {
  readonly model: string
  readonly maxOutputTokens: number
  readonly reasoningEffort: ReasoningEffort | null
}
export interface ProviderConfig {
  readonly provider: ImportProviderName
  readonly promptVersion: string
  readonly timeoutMs: number
  readonly profiles: { readonly [P in ExtractionProfile]: ProviderProfileConfig }
  /** Solo in memoria sul server: mai serializzata, loggata o restituita. */
  readonly apiKey: string
}
export type ProviderConfigResult =
  | { enabled: true; config: ProviderConfig }
  | { enabled: false; reason: 'not_configured' | 'invalid'; variable: string | null }

/** Variabili lette: nessun'altra configurazione del provider è accettata (URL, prompt, tools). */
export const providerEnvNames = [
  'IMPORT_PROVIDER', 'IMPORT_MODEL', 'IMPORT_RETRY_MODEL', 'IMPORT_PROMPT_VERSION', 'IMPORT_MAX_OUTPUT_TOKENS',
  'IMPORT_RETRY_MAX_OUTPUT_TOKENS', 'IMPORT_REASONING_EFFORT', 'IMPORT_PROVIDER_TIMEOUT_MS', 'OPENAI_API_KEY',
] as const
export type ProviderEnv = Partial<Record<typeof providerEnvNames[number], string | undefined>>

/** Stessa forma dei valori di profilo accettati dai jobs (14): niente spazi, URL o testo libero. */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@/+:-]{0,199}$/
/** Un nome di modello, mai un URL o un endpoint alternativo. */
const modelName = (value: string) => MODEL_PATTERN.test(value) && !value.includes('//')
export const providerLimits = { maxOutputTokens: 128_000, minTimeoutMs: 1_000, maxTimeoutMs: 300_000, defaultTimeoutMs: 90_000 } as const

function positiveInteger(value: string, max: number): number | null {
  if (!/^[1-9]\d{0,9}$/.test(value)) return null
  const number = Number(value)
  return number <= max ? number : null
}

/**
 * Configurazione disabilitata finché provider, modello, versione dei prompt, tetto di output e
 * chiave non sono tutti presenti e validi. Un valore non valido non ripiega su default.
 */
export function readProviderConfig(env: ProviderEnv): ProviderConfigResult {
  const value = (name: typeof providerEnvNames[number]) => env[name]?.trim() || null
  const invalid = (variable: string): ProviderConfigResult => ({ enabled: false, reason: 'invalid', variable })
  const provider = value('IMPORT_PROVIDER')
  if (provider === null) return { enabled: false, reason: 'not_configured', variable: 'IMPORT_PROVIDER' }
  if (!(importProviderNames as readonly string[]).includes(provider)) return invalid('IMPORT_PROVIDER')
  for (const required of ['IMPORT_MODEL', 'IMPORT_PROMPT_VERSION', 'IMPORT_MAX_OUTPUT_TOKENS', 'OPENAI_API_KEY'] as const) {
    if (value(required) === null) return { enabled: false, reason: 'not_configured', variable: required }
  }
  const model = value('IMPORT_MODEL')!
  const retryModel = value('IMPORT_RETRY_MODEL') ?? model
  if (!modelName(model)) return invalid('IMPORT_MODEL')
  if (!modelName(retryModel)) return invalid('IMPORT_RETRY_MODEL')
  if (value('IMPORT_PROMPT_VERSION') !== IMPORT_PROMPT_VERSION) return invalid('IMPORT_PROMPT_VERSION')
  const maxOutputTokens = positiveInteger(value('IMPORT_MAX_OUTPUT_TOKENS')!, providerLimits.maxOutputTokens)
  if (maxOutputTokens === null) return invalid('IMPORT_MAX_OUTPUT_TOKENS')
  const retryText = value('IMPORT_RETRY_MAX_OUTPUT_TOKENS')
  const retryMaxOutputTokens = retryText === null ? maxOutputTokens : positiveInteger(retryText, providerLimits.maxOutputTokens)
  if (retryMaxOutputTokens === null) return invalid('IMPORT_RETRY_MAX_OUTPUT_TOKENS')
  const effortText = value('IMPORT_REASONING_EFFORT')
  if (effortText !== null && !(reasoningEfforts as readonly string[]).includes(effortText)) return invalid('IMPORT_REASONING_EFFORT')
  const reasoningEffort = effortText as ReasoningEffort | null
  const timeoutText = value('IMPORT_PROVIDER_TIMEOUT_MS')
  const timeoutMs = timeoutText === null ? providerLimits.defaultTimeoutMs : positiveInteger(timeoutText, providerLimits.maxTimeoutMs)
  if (timeoutMs === null || timeoutMs < providerLimits.minTimeoutMs) return invalid('IMPORT_PROVIDER_TIMEOUT_MS')
  const apiKey = value('OPENAI_API_KEY')!
  if (/\s/.test(apiKey)) return invalid('OPENAI_API_KEY')
  return {
    enabled: true,
    config: Object.freeze({
      provider: provider as ImportProviderName, promptVersion: IMPORT_PROMPT_VERSION, timeoutMs, apiKey,
      profiles: Object.freeze({
        standard: Object.freeze({ model, maxOutputTokens, reasoningEffort }),
        retry: Object.freeze({ model: retryModel, maxOutputTokens: retryMaxOutputTokens, reasoningEffort }),
      }),
    }),
  }
}

/** Solo metadati: nessuna chiave, nessun testo. */
export interface ProviderLogEvent {
  event: 'provider_response' | 'provider_error'
  provider: ImportProviderName
  model: string
  profile: ExtractionProfile
  status: ExtractionProviderResponse['status'] | null
  code: string | null
  httpStatus: number | null
  providerRequestId: string | null
  /** ID locale già passato al provider (reservationId), utile anche prima degli header. */
  clientRequestId: string | null
  /** Ultima fase raggiunta: nessun corpo o dettaglio libero del trasporto. */
  phase: 'not_sent' | 'headers' | 'body' | 'decode'
  promptVersion: string
  formatVersion: string
  reasoningEffort: ProviderProfileConfig['reasoningEffort']
  maxOutputTokens: number
  requestBytes: number
  responseBytes: number | null
  latencyMs: number
  inputTokens: number | null
  outputTokens: number | null
  reasoningTokens: number | null
}
export type ProviderLogger = (event: ProviderLogEvent) => void
/** Trasporto HTTP iniettabile (fetch nativo in Deno, stub nei test). */
export type ProviderTransport = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>

export interface PrepareOptions {
  /** Identificatore ASCII della chiamata (es. reservationId del ledger) per rintracciare esiti incerti. */
  clientRequestId?: string
}
export interface PreparedProviderCall {
  readonly kind: ExtractionKind
  readonly profile: ExtractionProfile
  readonly model: string
  readonly promptVersion: string
  /** Body HTTP completo: istruzioni, schema e documento. Da passare al budget prima di `send`. */
  readonly serializedRequest: string
  readonly maxOutputTokens: number
  /** Un solo invio per chiamata preparata: un secondo `send` è rifiutato senza rete. */
  send(signal: AbortSignal): Promise<ExtractionProviderResponse>
}
export interface StructuredExtractionProvider extends ExtractionProvider {
  readonly name: ImportProviderName
  prepare(request: ExtractionRequest, options?: PrepareOptions): PreparedProviderCall
}

/** Il body è preparato una volta: qualsiasi riuso è un secondo tentativo e passa dal budget. */
export function onceOnly(send: (signal: AbortSignal) => Promise<ExtractionProviderResponse>): (signal: AbortSignal) => Promise<ExtractionProviderResponse> {
  let used = false
  return signal => {
    if (used) return Promise.reject(new ExtractionProviderError('configuration', { delivery: 'not_sent' }))
    used = true
    return send(signal)
  }
}
