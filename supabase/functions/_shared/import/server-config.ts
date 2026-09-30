/**
 * Configurazione server di extract-plan (task 17): solo variabili d'ambiente del runtime Edge,
 * mai valori dal body. Disabilitata finché provider (16) e budget (15) non sono configurati.
 * Il trasporto sintetico del provider esiste solo per lo stack locale riconoscibile e non è
 * attivabile dalla richiesta.
 */
import { resolveImportLimits, type ImportLimits } from './contracts.ts'
import { VALIDATION_RULES_VERSION } from './validation.ts'
import type { AnalysisProfile } from './jobs.ts'
import { providerEnvNames, readProviderConfig, type ProviderConfig, type ProviderConfigResult, type ProviderEnv } from './provider.ts'

/** Versione delle regole server nella chiave di cache: validazione 06 + segmentazione/ricomposizione. */
export const ANALYSIS_RULES_VERSION = `${VALIDATION_RULES_VERSION}+segments.v1`

export const serverEnvNames = [
  ...providerEnvNames, 'IMPORT_ALLOWED_ORIGINS', 'IMPORT_ANALYSIS_DEADLINE_MS', 'IMPORT_MAX_RETRY_WAIT_SECONDS', 'IMPORT_TEST_TRANSPORT', 'SUPABASE_URL',
] as const
export type ServerEnv = Partial<Record<typeof serverEnvNames[number], string | undefined>>

export interface ServerConfig {
  readonly provider: ProviderConfigResult
  readonly limits: ImportLimits
  /** Origini browser esatte ammesse (CORS); richieste senza Origin restano soggette all'autenticazione. */
  readonly allowedOrigins: readonly string[]
  /** Tempo massimo dell'intera analisi sincrona, chiamate e attese comprese. */
  readonly deadlineMs: number
  /** Attesa massima per un Retry-After prima del secondo tentativo. */
  readonly maxRetryWaitSeconds: number
  readonly testTransport: 'synthetic' | null
  /** Motivo per cui la configurazione server è inutilizzabile (oltre al provider). */
  readonly invalid: string | null
}

const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', 'kong', 'host.docker.internal'])

/** Stack locale della CLI: http verso loopback o rete Docker della CLI, mai un progetto cloud. */
export function isLocalSupabaseUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && (LOCAL_HOSTS.has(url.hostname) || /^supabase_kong_[A-Za-z0-9_-]+$/.test(url.hostname))
      && !url.username && !url.password
  } catch { return false }
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value.trim() === '') return fallback
  if (!/^\d{1,7}$/.test(value.trim())) return null
  const number = Number(value.trim())
  return number >= min && number <= max ? number : null
}

export function readServerConfig(env: ServerEnv): ServerConfig {
  const providerEnv: ProviderEnv = Object.fromEntries(providerEnvNames.map(name => [name, env[name]]))
  const provider = readProviderConfig(providerEnv)
  let invalid: string | null = null
  const origins = (env.IMPORT_ALLOWED_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean)
  if (origins.some(origin => !ORIGIN.test(origin))) invalid = 'IMPORT_ALLOWED_ORIGINS'
  const deadlineMs = integer(env.IMPORT_ANALYSIS_DEADLINE_MS, 140_000, 5_000, 400_000)
  if (deadlineMs === null) invalid ??= 'IMPORT_ANALYSIS_DEADLINE_MS'
  const maxRetryWaitSeconds = integer(env.IMPORT_MAX_RETRY_WAIT_SECONDS, 10, 0, 60)
  if (maxRetryWaitSeconds === null) invalid ??= 'IMPORT_MAX_RETRY_WAIT_SECONDS'
  const requested = env.IMPORT_TEST_TRANSPORT?.trim() || null
  if (requested !== null && (requested !== 'synthetic' || !isLocalSupabaseUrl(env.SUPABASE_URL))) invalid ??= 'IMPORT_TEST_TRANSPORT'
  // Il ledger (15) ha un solo prezzo/modello: un modello di riserva diverso non è ancora prenotabile.
  if (provider.enabled && provider.config.profiles.retry.model !== provider.config.profiles.standard.model) invalid ??= 'IMPORT_RETRY_MODEL'
  return Object.freeze({
    provider, limits: resolveImportLimits(), allowedOrigins: Object.freeze(origins),
    deadlineMs: deadlineMs ?? 140_000, maxRetryWaitSeconds: maxRetryWaitSeconds ?? 10,
    testTransport: invalid === null && requested === 'synthetic' ? 'synthetic' : null, invalid,
  })
}

/** Profilo del job (14): solo configurazione server. */
export function analysisProfile(config: ProviderConfig): AnalysisProfile {
  return { promptVersion: config.promptVersion, provider: config.provider, model: config.profiles.standard.model, rulesVersion: ANALYSIS_RULES_VERSION }
}
