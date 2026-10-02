/** Internal provider format. Public/persisted DTOs and their validators stay field-based. */
import { contractLimits, extractionJsonSchema, type Evidence, type ExtractionFor, type ExtractionKind, type JsonObject, type NormalizedDocument } from './contracts.ts'
import { indexSource, resolvePointer } from '../../../../src/import/validation/evidence.ts'

export const PROVIDER_FORMAT_VERSION = 'compact.v2'
export const WORKOUT_RULE_TARGET_PATTERN = '^/sessions/(?:0|[1-9]\\d*)(?:/exercises/(?:0|[1-9]\\d*))?$'
const pointer = /^(?:\/(?:[^~/]|~[01])*)*$/
const relative = /^(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])+)*$/
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const closed = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
interface CompactSpan { blockId: string; quote: string | null }
interface CompactEvidence { at: string; fields: string[]; spans: CompactSpan[] }
const numericRoles: Record<string, readonly string[]> = {
  sets: ['sets', 'scheme'], optionalSets: ['sets', 'scheme'], repetitions: ['repetitions', 'scheme'],
  durationSeconds: ['durationSeconds', 'scheme'], restSeconds: ['restSeconds'], rir: ['rir'], rpe: ['rpe'],
}
const explicitRole: Record<string, RegExp> = {
  sets: /\b(?:serie|sets?)\b|\d\s*[x×]\s*\d/i, optionalSets: /\b(?:serie|sets?)\b|\d\s*[x×]\s*\d/i,
  repetitions: /\b(?:ripetizioni|reps?)\b|\d\s*[x×]\s*\d/i, durationSeconds: /\b(?:durata|tempo di lavoro)\b/i,
  restSeconds: /\b(?:recupero|pausa|riposo|rest)\b/i, rir: /\bRIR\b/i, rpe: /\bRPE\b/i,
}

export function compactExtractionSchema(kind: ExtractionKind): JsonObject {
  const schema = extractionJsonSchema(kind)
  const properties = schema.properties as JsonObject
  if (kind === 'workout') {
    const rules = (properties.complexRules as JsonObject).items as JsonObject
    const targets = ((rules.properties as JsonObject).targetPaths as JsonObject).items as JsonObject
    targets.pattern = WORKOUT_RULE_TARGET_PATTERN
  }
  properties.evidence = {
    type: 'array', maxItems: contractLimits.largeItems,
    items: { type: 'object', additionalProperties: false, required: ['at', 'fields', 'spans'], properties: {
      at: { type: 'string', maxLength: contractLimits.pointerChars, pattern: pointer.source },
      fields: { type: 'array', minItems: 1, maxItems: contractLimits.refsPerItem, items: { type: 'string', maxLength: contractLimits.pointerChars, pattern: relative.source } },
      spans: { type: 'array', minItems: 1, maxItems: contractLimits.refsPerItem, items: {
        type: 'object', additionalProperties: false, required: ['blockId', 'quote'], properties: {
          blockId: { type: 'string', minLength: 1, maxLength: contractLimits.idChars },
          quote: { anyOf: [{ type: 'string', minLength: 1, maxLength: contractLimits.textChars }, { type: 'null' }] },
        },
      } },
    } },
  }
  return schema
}

/** Sharing a span never certifies a field: all expanded fields go through the original validator. */
export function expandCompactExtraction(kind: ExtractionKind, document: NormalizedDocument, value: unknown): unknown {
  if (!object(value) || !Array.isArray(value.evidence)) return value
  // Existing recordings and persisted DTOs keep their original quotes and validation behavior.
  if (value.evidence.every(e => object(e) && Object.hasOwn(e, 'path'))) return value
  if (value.kind !== kind || value.evidence.length > contractLimits.largeItems) throw new TypeError('Invalid compact extraction')
  const blocks = new Map(document.blocks.map(block => [block.id, block]))
  const source = indexSource(document)
  const evidence: Evidence[] = []
  for (const entry of value.evidence) {
    if (!object(entry) || !closed(entry, ['at', 'fields', 'spans']) || typeof entry.at !== 'string' || entry.at.length > contractLimits.pointerChars || !pointer.test(entry.at)
      || !Array.isArray(entry.fields) || !entry.fields.length || entry.fields.length > contractLimits.refsPerItem
      || !Array.isArray(entry.spans) || !entry.spans.length || entry.spans.length > contractLimits.refsPerItem) throw new TypeError('Invalid compact evidence')
    for (const span of entry.spans) {
      if (!object(span) || !closed(span, ['blockId', 'quote']) || typeof span.blockId !== 'string' || !blocks.has(span.blockId)
        || !(span.quote === null || (typeof span.quote === 'string' && span.quote.length > 0 && span.quote.length <= contractLimits.textChars))) throw new TypeError('Invalid compact source')
    }
    for (const field of entry.fields) {
      if (typeof field !== 'string' || !relative.test(field)) throw new TypeError('Invalid compact field')
      const path = `${entry.at}/${field}`
      if (path.length > contractLimits.pointerChars || evidence.length >= contractLimits.largeItems) throw new TypeError('Compact evidence limit')
      const target = resolvePointer(value, path)
      const spans = (entry.spans as CompactSpan[]).map(span => {
        const block = blocks.get(span.blockId)!, text = block.text
        const name = path.slice(path.lastIndexOf('/') + 1), allowed = numericRoles[name]
        if (kind === 'workout' && allowed && block.kind === 'table_cell' && block.tableId !== null && block.column !== null) {
          const role = source.roles(block.tableId).get(block.column)
          const header = source.headerRow(block.tableId)
          const headerText = header ? source.columns(header).find(c => c.column === block.column)?.text ?? '' : ''
          const timeInReps = name === 'durationSeconds' && role === 'repetitions' && /\d\s*(?:s|sec|secondi)\b/i.test(span.quote ?? text)
          // A coincidentally equal number in another known column is not evidence for this field.
          // An explicit label in the quote can override a generic header (e.g. RPE in a RIR column).
          if (role && !allowed.includes(role) && !explicitRole[name]!.test(headerText) && !explicitRole[name]!.test(span.quote ?? text) && !timeInReps) throw new TypeError('Compact source column does not match field')
        }
        // Narrow string evidence to the actual occurrence. This preserves alternative/addition
        // regions: quoting the entire paragraph for a food name would conceal its condition.
        const quoted = target.found && typeof target.value === 'string' && target.value !== '' && text.includes(target.value) ? target.value : text
        return { blockId: span.blockId, quote: span.quote ?? quoted }
      })
      evidence.push({ path, spans })
    }
  }
  return { ...value, evidence }
}

/** Exact, lossless encoding of existing evidence for synthetic transports and comparisons. */
export function compactExtraction<K extends ExtractionKind>(value: ExtractionFor<K>): Omit<ExtractionFor<K>, 'evidence'> & { evidence: CompactEvidence[] } {
  const evidence: CompactEvidence[] = []
  let previousKey: string | null = null
  for (const entry of value.evidence) {
    const split = entry.path.lastIndexOf('/')
    const at = entry.path.slice(0, split), field = entry.path.slice(split + 1)
    const key = JSON.stringify([at, entry.spans])
    let group = key === previousKey ? evidence.at(-1) : undefined
    if (!group) { group = { at, fields: [], spans: structuredClone(entry.spans) }; evidence.push(group) }
    group.fields.push(field)
    previousKey = key
  }
  return { ...value, evidence }
}

/** Omit only structural defaults; text, identifiers, order, and non-default geometry remain intact. */
export function compactDocumentPayload(document: NormalizedDocument): string {
  return JSON.stringify({
    blocks: document.blocks.map(block => ({ id: block.id, kind: block.kind, text: block.text,
      ...(block.page === null ? {} : { page: block.page }),
      ...(block.tableId === null ? {} : { tableId: block.tableId, row: block.row, column: block.column, rowSpan: block.rowSpan, columnSpan: block.columnSpan }),
      ...(block.parentId === null ? {} : { parentId: block.parentId }), headingIds: block.headingIds,
    })),
    readingIssues: document.readingIssues.map(({ code, sourceRefs, message }) => ({ code, sourceRefs, message })),
  })
}
