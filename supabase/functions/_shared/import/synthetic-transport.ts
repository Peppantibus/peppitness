/**
 * Trasporto HTTP sintetico dell'adapter OpenAI, SOLO per lo stack locale (IMPORT_TEST_TRANSPORT=synthetic
 * con SUPABASE_URL locale, verificato da server-config.ts): nessuna rete, nessun costo. Esercita il vero
 * adapter, budget, validazione e persistenza. Lo scenario dipende dal testo sintetico del documento
 * (marcatori SINTETICO:*), mai da un campo della richiesta; il profilo retry si riconosce dal tetto di output.
 */
import { DOCUMENT_MESSAGE_HEADER } from './prompts.ts'
import { e2eExtraction } from './synthetic-e2e.ts'
import { compactExtraction } from './compact.ts'
import type { WorkoutExtraction, DietExtraction } from './contracts.ts'
import type { ProviderConfig, ProviderTransport } from './provider.ts'

interface PayloadBlock { id: string; kind: string; text: string; row: number | null; headingIds: string[] }

export const syntheticMarkers = {
  refuse: 'SINTETICO:RIFIUTO',
  incomplete: 'SINTETICO:INCOMPLETO',
  hang: 'SINTETICO:ATTESA',
  rateLimitedOnce: 'SINTETICO:429-UNA-VOLTA',
  invalidOnce: 'SINTETICO:NON-VALIDO-UNA-VOLTA',
  wrongDomain: 'SINTETICO:DOMINIO',
} as const

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'x-request-id': `req_synthetic_${crypto.randomUUID()}`, ...headers } })
}
const namePart = (text: string) => text.split(' | ')[0]!.trim()

/** Proposta minima ma verificabile: titolo, sedute/giornate dai titoli, esercizi dalle righe. */
function extraction(kind: 'workout' | 'diet', blocks: readonly PayloadBlock[]) {
  const evidence: { path: string; spans: { blockId: string; quote: string }[] }[] = []
  const first = blocks.find(block => block.kind === 'heading' && block.text) ?? blocks.find(block => block.text)
  const title = first ? first.text : null
  if (first) evidence.push({ path: '/title', spans: [{ blockId: first.id, quote: first.text }] })
  const common = { schemaVersion: '1.0', kind, outcome: 'extracted', title, guidance: [] as string[] }
  const tail = () => ({ evidence, issues: [], unassigned: [] })
  if (kind === 'workout') {
    const sessions = blocks.filter(block => block.kind === 'heading' && /^Seduta\b/.test(block.text)).map((heading, index) => {
      evidence.push({ path: `/sessions/${index}/label`, spans: [{ blockId: heading.id, quote: heading.text }] })
      const rows = blocks.filter(block => block.kind === 'table_row' && (block.row ?? 0) > 0 && block.headingIds.includes(heading.id))
      return {
        label: heading.text, title: null, weekday: null, notes: [],
        exercises: rows.map((row, position) => {
          evidence.push({ path: `/sessions/${index}/exercises/${position}/name`, spans: [{ blockId: row.id, quote: namePart(row.text) }] })
          evidence.push({ path: `/sessions/${index}/exercises/${position}/prescriptionText`, spans: [{ blockId: row.id, quote: row.text }] })
          return {
            name: namePart(row.text), variant: null, equipment: null, measurementMode: null, sets: null, optionalSets: null, repetitions: null,
            durationSeconds: null, restSeconds: null, rir: null, rpe: null, perSide: null, loadUnit: null, loadConvention: null,
            loadInstruction: null, tempoInstruction: null, prescriptionText: row.text, notes: [],
          }
        }),
      }
    })
    return { ...common, schedule: 'unknown', cycle: { startDate: null, weeks: null }, sessions, complexRules: [], ...tail() }
  }
  const days = blocks.filter(block => block.kind === 'heading' && /^Giorno\b/.test(block.text)).map((heading, index) => {
    evidence.push({ path: `/days/${index}/name`, spans: [{ blockId: heading.id, quote: heading.text }] })
    return { name: heading.text, dayType: null, notes: [], meals: [] }
  })
  return { ...common, days, globalRules: [], ...tail() }
}

function response(status: 'completed' | 'incomplete', content: unknown[], usage: { input: number; output: number }, extra: Record<string, unknown> = {}) {
  return {
    id: `resp_synthetic_${crypto.randomUUID()}`, object: 'response', status, model: 'synthetic-edge', error: null, incomplete_details: null,
    output: content.length ? [{ type: 'message', role: 'assistant', status: 'completed', content }] : [],
    usage: { input_tokens: usage.input, output_tokens: usage.output, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: usage.input + usage.output },
    ...extra,
  }
}

export function createSyntheticTransport(config: ProviderConfig): ProviderTransport {
  const { standard, retry } = config.profiles
  return async (_url, init) => {
    if (init.signal.aborted) throw init.signal.reason
    const body = JSON.parse(init.body) as { max_output_tokens: number; text: { format: { name: string } }; input: { content: { text: string }[] }[] }
    const kind = body.text.format.name.includes('diet') ? 'diet' : 'workout'
    const isRetry = retry.maxOutputTokens !== standard.maxOutputTokens && body.max_output_tokens === retry.maxOutputTokens
    const text = body.input[0]!.content[0]!.text
    const payload = JSON.parse(text.slice(DOCUMENT_MESSAGE_HEADER.length + 1)) as { blocks: PayloadBlock[] }
    const all = payload.blocks.map(block => block.text).join('\n')
    const has = (marker: string) => all.includes(marker)
    const usage = { input: Math.ceil(init.body.length / 4), output: 200 }

    if (has(syntheticMarkers.hang)) {
      return new Promise<Response>((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
    }
    if (has(syntheticMarkers.rateLimitedOnce) && !isRetry) return json(429, { error: { message: 'synthetic', type: 'requests', code: 'rate_limit_exceeded' } }, { 'retry-after': '1' })
    if (has(syntheticMarkers.refuse)) return json(200, response('completed', [{ type: 'refusal', refusal: 'synthetic refusal' }], usage))
    if (has(syntheticMarkers.incomplete)) return json(200, response('incomplete', [], usage, { incomplete_details: { reason: 'max_output_tokens' } }))
    let value: unknown = e2eExtraction(kind, payload.blocks) ?? extraction(kind, payload.blocks)
    if (has(syntheticMarkers.invalidOnce) && !isRetry) value = { ...(value as object), confidence: 0.99 }
    if (has(syntheticMarkers.wrongDomain)) {
      value = kind === 'workout'
        ? { schemaVersion: '1.0', kind, outcome: 'wrong_document_type', title: null, guidance: [], schedule: 'unknown', cycle: { startDate: null, weeks: null }, sessions: [], complexRules: [], evidence: [], issues: [], unassigned: [] }
        : { schemaVersion: '1.0', kind, outcome: 'wrong_document_type', title: null, guidance: [], days: [], globalRules: [], evidence: [], issues: [], unassigned: [] }
    }
    return json(200, response('completed', [{ type: 'output_text', text: JSON.stringify(compactExtraction(value as WorkoutExtraction | DietExtraction)), annotations: [] }], usage))
  }
}
