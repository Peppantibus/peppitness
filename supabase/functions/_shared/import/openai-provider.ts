/**
 * Primo adapter concreto (specifica §14): OpenAI Responses API con Structured Outputs strict.
 * Riferimenti ufficiali consultati il 30/09/2026: guida Structured Outputs (sottoinsieme JSON
 * Schema, rifiuti, incompleti), `POST /v1/responses` (store, truncation, max_output_tokens,
 * usage con reasoning dentro output_tokens) e panoramica API (Bearer, x-request-id,
 * X-Client-Request-Id). Modello e snapshot restano configurazione server (25).
 *
 * Una chiamata preparata = un invio. Nessun retry, nessun fallback di modello, nessuno strumento.
 * Il risultato resta `unknown` finché validateProposal (06) non lo accetta.
 */
import {
  extractionJsonSchema, extractionSchemaIds,
  type ExtractionKind, type ExtractionProviderResponse, type ExtractionRequest, type JsonObject, type JsonValue,
} from './contracts.ts'
import type { ProviderUsage } from './budget.ts'
import { DOCUMENT_MESSAGE_HEADER, extractionPrompts } from './prompts.ts'
import { compactDocumentPayload, compactExtractionSchema, expandCompactExtraction, PROVIDER_FORMAT_VERSION, WORKOUT_RULE_TARGET_PATTERN } from './compact.ts'
import {
  onceOnly,
  type PreparedProviderCall, type PrepareOptions, type ProviderConfig, type ProviderLogger, type ProviderTransport,
  type StructuredExtractionProvider,
} from './provider.ts'
import { ExtractionProviderError, type ProviderDelivery, type ProviderErrorCode } from './provider-errors.ts'

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses'

// ---------------------------------------------------------------------------
// Schema strict
// ---------------------------------------------------------------------------

/** Limiti documentati di Structured Outputs. */
export const strictSchemaLimits = { properties: 5000, nesting: 10, enumValues: 1000, stringChars: 120_000 } as const
/**
 * Parole chiave tradotte. Omesse perché non supportate in strict mode ($schema, $id, title,
 * $comment, minLength, maxLength) o non necessarie (pattern, maxItems): i vincoli restano applicati
 * da validateExtraction/validateProposal sul risultato. `const` diventa `enum` di un valore.
 */
const dropped = new Set(['$schema', '$id', 'title', '$comment', 'minLength', 'maxLength', 'pattern', 'maxItems'])
const kept = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'anyOf', 'enum', 'minimum', 'maximum', 'minItems'])

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function translate(node: JsonObject, path: string): JsonObject {
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(node)) {
    if (dropped.has(key)) continue
    if (key === 'const') { out.enum = [value]; continue }
    if (!kept.has(key)) throw new TypeError(`Unsupported strict schema keyword at ${path || '/'}: ${key}`)
    if (key === 'properties') {
      out.properties = Object.fromEntries(Object.entries(value as JsonObject).map(([name, child]) => [name, translate(child as JsonObject, `${path}/properties/${name}`)]))
    } else if (key === 'items') {
      if (!isObject(value)) throw new TypeError(`Unsupported strict schema items at ${path || '/'}`)
      out.items = translate(value as JsonObject, `${path}/items`)
    } else if (key === 'anyOf') {
      out.anyOf = (value as JsonObject[]).map((child, index) => translate(child, `${path}/anyOf/${index}`))
    } else out[key] = value as JsonValue
  }
  if (out.type === 'object') {
    const names = Object.keys((out.properties ?? {}) as JsonObject)
    const required = (out.required ?? []) as string[]
    if (out.additionalProperties !== false || required.length !== names.length || names.some(name => !required.includes(name))) {
      throw new TypeError(`Strict schema object must be closed with every key required at ${path || '/'}`)
    }
  }
  return out
}

/** Radice oggetto distinta per dominio, oggetti chiusi, tutte le chiavi required, null tramite anyOf. */
export function strictExtractionSchema(kind: ExtractionKind): JsonObject {
  const schema = translate(extractionJsonSchema(kind), '')
  if (schema.type !== 'object' || 'anyOf' in schema) throw new TypeError('Strict schema root must be an object')
  return schema
}

export function strictProviderSchema(kind: ExtractionKind): JsonObject {
  const schema = translate(compactExtractionSchema(kind), '')
  if (kind === 'workout') {
    // Structured Outputs supports string patterns on base models. Keep this
    // wire-only constraint without changing the legacy DTO schema translation.
    const rules = (schema.properties as JsonObject).complexRules as JsonObject
    const targets = ((rules.items as JsonObject).properties as JsonObject).targetPaths as JsonObject
    ;(targets.items as JsonObject).pattern = WORKOUT_RULE_TARGET_PATTERN
  }
  return schema
}

export interface StrictSchemaStats { properties: number; nesting: number; enumValues: number; stringChars: number }
export function strictSchemaStats(schema: JsonObject): StrictSchemaStats {
  const stats: StrictSchemaStats = { properties: 0, nesting: 0, enumValues: 0, stringChars: 0 }
  const visit = (node: JsonObject, depth: number) => {
    if (node.type === 'object') {
      stats.nesting = Math.max(stats.nesting, depth)
      for (const [name, child] of Object.entries(node.properties as JsonObject)) {
        stats.properties++
        stats.stringChars += name.length
        visit(child as JsonObject, depth + 1)
      }
    }
    if (Array.isArray(node.enum)) for (const value of node.enum) { stats.enumValues++; stats.stringChars += String(value).length }
    if (isObject(node.items)) visit(node.items as JsonObject, depth)
    if (Array.isArray(node.anyOf)) for (const child of node.anyOf) visit(child as JsonObject, depth)
  }
  visit(schema, 1)
  return stats
}

const schemaCache = new Map<ExtractionKind, JsonObject>()
function cachedSchema(kind: ExtractionKind): JsonObject {
  let schema = schemaCache.get(kind)
  if (!schema) { schema = strictProviderSchema(kind); schemaCache.set(kind, schema) }
  return schema
}
/** Nome del formato: [A-Za-z0-9_-], massimo 64 caratteri. */
export const strictSchemaName = (kind: ExtractionKind) => `${extractionSchemaIds[kind]}_${PROVIDER_FORMAT_VERSION}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)

// ---------------------------------------------------------------------------
// Richiesta
// ---------------------------------------------------------------------------

/** Body completo della chiamata: soltanto parametri autorizzati dalla configurazione server. */
export function buildOpenAIRequestBody(config: ProviderConfig, request: ExtractionRequest): JsonObject {
  if (request.promptVersion !== config.promptVersion || request.schemaId !== extractionSchemaIds[request.kind]) {
    throw new ExtractionProviderError('configuration', { delivery: 'not_sent' })
  }
  const profile = config.profiles[request.profile]
  return {
    model: profile.model,
    instructions: extractionPrompts[request.kind],
    input: [{ role: 'user', content: [{ type: 'input_text', text: `${DOCUMENT_MESSAGE_HEADER}\n${compactDocumentPayload(request.document)}` }] }],
    text: { format: { type: 'json_schema', name: strictSchemaName(request.kind), schema: structuredClone(cachedSchema(request.kind)), strict: true } },
    max_output_tokens: profile.maxOutputTokens,
    // Nessuna conservazione applicativa della risposta; non equivale a Zero Data Retention.
    store: false,
    // Nessuno strumento (web, file, codice, MCP): il documento non può richiederne.
    tools: [],
    // Input oltre il contesto = errore 400, mai troncamento silenzioso.
    truncation: 'disabled',
    ...(profile.reasoningEffort === null ? {} : { reasoning: { effort: profile.reasoningEffort } }),
  }
}

// ---------------------------------------------------------------------------
// Risposta
// ---------------------------------------------------------------------------

const MAX_TOKENS = 2147483647
const tokenCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : null

/** output_tokens comprende già il reasoning: reasoning_tokens è solo un dettaglio, mai sommato. */
export function openAIUsage(value: unknown): ProviderUsage | null {
  if (!isObject(value)) return null
  const outputTokens = tokenCount(value.output_tokens)
  let reasoningTokens = isObject(value.output_tokens_details) ? tokenCount(value.output_tokens_details.reasoning_tokens) : null
  if (reasoningTokens !== null && outputTokens !== null && reasoningTokens > outputTokens) reasoningTokens = null
  return { inputTokens: tokenCount(value.input_tokens), outputTokens, reasoningTokens }
}
const zeroUsage: ProviderUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, reasoningTokens: 0 })

/** ID diagnostici solo se ASCII stampabili e brevi: niente contenuti riflessi dal trasporto. */
const safeId = (value: string | null) => value !== null && /^[\x21-\x7E]{1,200}$/.test(value) ? value : null
function retryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,6}$/.test(value.trim())) return null
  return Math.min(Number(value.trim()), 86400)
}
function httpErrorCode(status: number): ProviderErrorCode {
  if (status === 429) return 'rate_limited'
  if (status === 401 || status === 403) return 'auth'
  if (status >= 500 || status === 408) return 'server_error'
  return 'bad_request'
}

export interface OpenAIProviderOptions {
  transport?: ProviderTransport
  logger?: ProviderLogger
  now?: () => number
}

export function createOpenAIProvider(config: ProviderConfig, options: OpenAIProviderOptions = {}): StructuredExtractionProvider {
  if (config.provider !== 'openai') throw new ExtractionProviderError('configuration', { delivery: 'not_sent' })
  const transport: ProviderTransport = options.transport ?? ((url, init) => fetch(url, init))
  const now = options.now ?? (() => Date.now())
  const logger = options.logger

  function prepare(request: ExtractionRequest, prepareOptions: PrepareOptions = {}): PreparedProviderCall {
    const clientRequestId = prepareOptions.clientRequestId
    if (clientRequestId !== undefined && !/^[\x21-\x7E]{1,512}$/.test(clientRequestId)) {
      throw new ExtractionProviderError('configuration', { delivery: 'not_sent' })
    }
    const profile = config.profiles[request.profile]
    const serializedRequest = JSON.stringify(buildOpenAIRequestBody(config, request))
    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      ...(clientRequestId === undefined ? {} : { 'X-Client-Request-Id': clientRequestId }),
    }

    async function perform(signal: AbortSignal, timeout: AbortSignal): Promise<ExtractionProviderResponse> {
      const started = now()
      let phase: 'not_sent' | 'headers' | 'body' | 'decode' = 'not_sent'
      let responseBytes: number | null = null
      const log = (entry: { status: ExtractionProviderResponse['status'] | null; code: string | null; httpStatus: number | null; requestId: string | null; usage: ProviderUsage | null }) => {
        try {
          logger?.({
            event: entry.code === null ? 'provider_response' : 'provider_error', provider: 'openai', model: profile.model, profile: request.profile,
            status: entry.status, code: entry.code, httpStatus: entry.httpStatus, providerRequestId: entry.requestId, latencyMs: Math.max(0, now() - started),
            clientRequestId: clientRequestId ?? null, phase,
            promptVersion: config.promptVersion, formatVersion: PROVIDER_FORMAT_VERSION, reasoningEffort: profile.reasoningEffort,
            maxOutputTokens: profile.maxOutputTokens, requestBytes: new TextEncoder().encode(serializedRequest).length, responseBytes,
            inputTokens: entry.usage?.inputTokens ?? null, outputTokens: entry.usage?.outputTokens ?? null, reasoningTokens: entry.usage?.reasoningTokens ?? null,
          })
        } catch { /* il log non cambia l'esito */ }
      }
      const fail = (code: ProviderErrorCode, delivery: ProviderDelivery, details: { httpStatus?: number | null; requestId?: string | null; retryAfterSeconds?: number | null; usage?: ProviderUsage | null } = {}): never => {
        log({ status: null, code, httpStatus: details.httpStatus ?? null, requestId: details.requestId ?? null, usage: details.usage ?? null })
        throw new ExtractionProviderError(code, {
          delivery, httpStatus: details.httpStatus ?? null, providerRequestId: details.requestId ?? null,
          retryAfterSeconds: details.retryAfterSeconds ?? null, usage: details.usage ?? null,
        })
      }
      if (signal.aborted) fail('aborted', 'not_sent')
      const combined = AbortSignal.any([signal, timeout])
      // Dopo l'avvio del trasporto la richiesta può essere arrivata: abort, timeout e rete sono incerti.
      let httpStatus: number | null = null
      let requestId: string | null = null
      const interrupted = (): never => fail(timeout.aborted ? 'timeout' : signal.aborted ? 'aborted' : 'network', 'uncertain', { httpStatus, requestId })

      let response: Response
      let text: string
      phase = 'headers'
      try {
        response = await transport(OPENAI_RESPONSES_URL, { method: 'POST', headers, body: serializedRequest, signal: combined })
        // Conservare i metadati subito: response.text() può interrompersi anche dopo HTTP 200.
        httpStatus = response.status
        requestId = safeId(response.headers.get('x-request-id'))
        phase = 'body'
        text = await response.text()
        responseBytes = new TextEncoder().encode(text).length
      } catch { return interrupted() }
      phase = 'decode'
      if (!response.ok) {
        // Errore HTTP del provider prima di un oggetto Response: nessun output generato né usage.
        return fail(httpErrorCode(response.status), 'rejected', {
          httpStatus: response.status, requestId, usage: zeroUsage,
          retryAfterSeconds: response.status === 429 || response.status >= 500 ? retryAfter(response.headers.get('retry-after')) : null,
        })
      }
      let body: unknown
      try { body = JSON.parse(text) } catch { return fail('invalid_response', 'uncertain', { httpStatus: response.status, requestId }) }
      const usage = isObject(body) ? openAIUsage(body.usage) : null
      const received = (code: ProviderErrorCode): never => fail(code, usage === null ? 'uncertain' : 'received', { httpStatus: response.status, requestId, usage })
      if (!isObject(body) || typeof body.status !== 'string' || !Array.isArray(body.output)) return received('invalid_response')
      const providerRequestId = requestId ?? (typeof body.id === 'string' ? safeId(body.id) : null)
      const model = typeof body.model === 'string' && body.model ? body.model : profile.model
      const done = (status: ExtractionProviderResponse['status'], data: unknown): ExtractionProviderResponse => {
        log({ status, code: null, httpStatus: response.status, requestId: providerRequestId, usage })
        return {
          data, providerRequestId, model, status,
          inputTokens: usage?.inputTokens ?? null, outputTokens: usage?.outputTokens ?? null, reasoningTokens: usage?.reasoningTokens ?? null,
        }
      }

      switch (body.status) {
        case 'completed': {
          const parts = body.output.filter(isObject).filter(item => item.type === 'message').flatMap(item => Array.isArray(item.content) ? item.content : [])
          if (parts.some(part => isObject(part) && part.type === 'refusal')) return done('refused', null)
          const texts = parts.filter(part => isObject(part) && part.type === 'output_text' && typeof part.text === 'string') as { text: string }[]
          if (texts.length !== 1) return received('invalid_response')
          try { return done('completed', expandCompactExtraction(request.kind, request.document, JSON.parse(texts[0]!.text))) }
          catch { return received('invalid_output') }
        }
        case 'incomplete': {
          // Mai una bozza da output troncato: data resta null. Il filtro contenuti è un rifiuto.
          const reason = isObject(body.incomplete_details) ? body.incomplete_details.reason : null
          return done(reason === 'content_filter' ? 'refused' : 'incomplete', null)
        }
        case 'failed': {
          const code = isObject(body.error) ? body.error.code : null
          return received(code === 'rate_limit_exceeded' ? 'rate_limited' : code === 'server_error' ? 'server_error' : 'failed')
        }
        default: return received('invalid_response')
      }
    }

    async function send(signal: AbortSignal): Promise<ExtractionProviderResponse> {
      // Own and clear the timeout even when the transport has only a pending Promise.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new DOMException('Provider deadline exceeded', 'TimeoutError')), config.timeoutMs)
      try { return await perform(signal, controller.signal) }
      finally { clearTimeout(timer) }
    }

    return Object.freeze({
      kind: request.kind, profile: request.profile, model: profile.model, promptVersion: config.promptVersion,
      serializedRequest, maxOutputTokens: profile.maxOutputTokens, send: onceOnly(send),
    })
  }

  return Object.freeze({
    name: 'openai' as const,
    capabilities: Object.freeze({ structuredOutput: true, images: false, directPdf: false }),
    prepare,
    extract(request: ExtractionRequest) { return prepare(request).send(request.signal) },
  })
}
