/**
 * Errori tipizzati del provider di estrazione (specifica §§4.5, 14): esterni alla risposta
 * `ExtractionProviderResponse`, che resta riservata a completed/incomplete/refused.
 * Messaggi fissi per codice: mai corpo della risposta, testo del documento, URL o chiavi.
 * `delivery` dice al coordinatore (17) come riconciliare il tentativo nel ledger (15).
 */
import type { ImportErrorCode } from './contracts.ts'
import type { ProviderUsage } from './budget.ts'

export const providerErrorCodes = [
  'configuration', // configurazione server assente o non consentita: nessun invio
  'aborted', // annullamento del chiamante
  'timeout', // tempo massimo dell'adapter superato
  'network', // connessione interrotta o fallita
  'rate_limited', // HTTP 429 o risposta fallita per limite
  'server_error', // HTTP 5xx o risposta fallita lato provider
  'bad_request', // HTTP 400/404/409/413/422: richiesta o schema non accettati
  'auth', // HTTP 401/403: chiave server non valida o senza permessi
  'invalid_response', // busta della risposta non riconosciuta (provider cambiato)
  'invalid_output', // risposta completata ma testo non JSON
  'failed', // risposta con status failed non classificata
] as const
export type ProviderErrorCode = typeof providerErrorCodes[number]

/**
 * - `not_sent`: la richiesta non è partita, costo certamente nullo.
 * - `rejected`: il provider ha risposto con un errore HTTP prima di generare output (nessun usage fatturabile).
 * - `received`: risposta ricevuta con usage eventualmente noto (`usage`).
 * - `uncertain`: la richiesta può essere arrivata e costata; la riserva resta finché non si chiarisce.
 */
export type ProviderDelivery = 'not_sent' | 'rejected' | 'received' | 'uncertain'

const messages: Record<ProviderErrorCode, string> = {
  configuration: 'Import provider configuration unavailable',
  aborted: 'Import provider request aborted',
  timeout: 'Import provider request timed out',
  network: 'Import provider network failure',
  rate_limited: 'Import provider rate limited',
  server_error: 'Import provider server error',
  bad_request: 'Import provider rejected the request',
  auth: 'Import provider authentication failed',
  invalid_response: 'Import provider response not recognized',
  invalid_output: 'Import provider output is not JSON',
  failed: 'Import provider response failed',
}

export interface ProviderErrorDetails {
  delivery: ProviderDelivery
  httpStatus?: number | null
  providerRequestId?: string | null
  retryAfterSeconds?: number | null
  usage?: ProviderUsage | null
}

export class ExtractionProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly delivery: ProviderDelivery
  readonly httpStatus: number | null
  readonly providerRequestId: string | null
  readonly retryAfterSeconds: number | null
  readonly usage: ProviderUsage | null
  constructor(code: ProviderErrorCode, details: ProviderErrorDetails) {
    super(messages[code])
    this.name = 'ExtractionProviderError'
    this.code = code
    this.delivery = details.delivery
    this.httpStatus = details.httpStatus ?? null
    this.providerRequestId = details.providerRequestId ?? null
    this.retryAfterSeconds = details.retryAfterSeconds ?? null
    this.usage = details.usage ?? null
  }
  /** Un secondo tentativo ha senso solo per guasti transitori già chiariti: mai per esiti incerti o configurazione. */
  get retryable(): boolean {
    return this.delivery !== 'uncertain' && (this.code === 'rate_limited' || this.code === 'server_error' || this.code === 'invalid_output')
  }
}

export function isProviderError(value: unknown): value is ExtractionProviderError {
  return value instanceof ExtractionProviderError
}

/** Codice pubblico sicuro (contratto 02) per un errore del provider. */
export function importErrorForProvider(error: ExtractionProviderError): ImportErrorCode {
  if (error.delivery === 'uncertain') return 'provider_outcome_uncertain'
  switch (error.code) {
    case 'invalid_response': case 'invalid_output': return 'provider_invalid_output'
    case 'configuration': case 'auth': case 'bad_request': return 'internal'
    default: return 'provider_unavailable'
  }
}
