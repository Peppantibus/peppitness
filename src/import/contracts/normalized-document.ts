/**
 * Documento intermedio prodotto dai reader (specifica §4.4): fonte strutturata, separata
 * dai DTO di estrazione. Nessun reader qui: forma, controlli strutturali e testo canonico.
 */
import {
  array, contractLimits, enumeration, errorList, nullable, number, object, refine, string, tuple, validate,
  type Infer, type ValidationResult,
} from './schema.ts'

/**
 * Regole di normalizzazione V1 del testo canonico dei blocchi, su cui si verificano le citazioni.
 * Cambiarle richiede una nuova versione: gli ID e le citazioni esistenti dipendono da questo testo.
 */
export const TEXT_NORMALIZATION_VERSION = 'peppitness.text-normalization.v1'

const lineBreaks = /[\u000B\u000C\u0085\u2028\u2029]/g
const invisible = /[\u00AD\u200B\u2060\uFEFF]/g
const controls = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g

/**
 * A capo uniformi, spazi orizzontali (tab e spazi Unicode compresi) ridotti a uno, al massimo
 * una riga vuota, nessuno spazio ai bordi, NFC finale. Non tocca segni prescrittivi come
 * `+ / – ’ ′ ″ ' "`, intestazioni o condizioni; niente NFKC, che cambierebbe `½` o `″`.
 */
export function normalizeSourceText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(lineBreaks, '\n')
    .replace(invisible, '')
    .replace(controls, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .normalize('NFC')
}

export const sourceBlockKinds = ['heading', 'paragraph', 'table_row', 'table_cell', 'list_item', 'image_text'] as const
export const sourceOrigins = ['native', 'ocr'] as const

/** Codici noti dei problemi di lettura; readingIssues accetta altri codici snake_case dichiarati dai reader. */
export const knownReadingIssueCodes = [
  'component_not_read', // componente presente ma non letto (header, footer, note, caselle di testo…)
  'no_text_layer', // pagina senza testo estraibile: servirebbe lettura da immagine
  'image_without_text', // immagine potenzialmente significativa senza testo associato
  'tracked_changes', // revisioni aperte: inserimenti ed eliminazioni non vanno uniti
  'hidden_text',
  'unsupported_content',
  'reading_order_uncertain',
] as const

/** Esempi: `p:17`, `t:2:r:3:c:1`, `pdf:4:b:12`. Assegnati dal reader, mai dal modello. */
export const SOURCE_BLOCK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/
export const sourceBlockIdSchema = string({ minLength: 1, maxLength: contractLimits.idChars, pattern: SOURCE_BLOCK_ID_PATTERN })
export const readingIssueCodeSchema = string({ minLength: 1, maxLength: contractLimits.codeChars, pattern: /^[a-z][a-z0-9_]*$/ })
export const readerVersionSchema = string({ minLength: 1, maxLength: contractLimits.versionChars, pattern: /^[A-Za-z0-9][A-Za-z0-9._@/+-]*$/ })
export const sourceRefsSchema = array(sourceBlockIdSchema, { maxItems: contractLimits.refsPerItem })

const unit = number({ minimum: 0, maximum: 1 })
// Tolleranza per l'arrotondamento dei reader, non per riquadri che escono davvero dalla pagina.
const BBOX_EPSILON = 1e-9
/** `[x, y, width, height]` normalizzati alla pagina, origine in alto a sinistra. */
const bboxSchema = refine(tuple(unit, unit, unit, unit), [{
  code: 'bbox_bounds',
  description: 'x + width <= 1 e y + height <= 1.',
  check([x, y, width, height], report) {
    if (x + width > 1 + BBOX_EPSILON || y + height > 1 + BBOX_EPSILON) report('', 'Il riquadro esce dalla pagina.')
  },
}])
const span = number({ integer: true, minimum: 1, maximum: contractLimits.cellSpan })

export const sourceBlockSchema = object({
  id: sourceBlockIdSchema,
  kind: enumeration(sourceBlockKinds),
  text: string({ maxLength: contractLimits.textChars }),
  page: nullable(number({ integer: true, minimum: 1 })),
  tableId: nullable(sourceBlockIdSchema),
  row: nullable(number({ integer: true, minimum: 0 })),
  column: nullable(number({ integer: true, minimum: 0 })),
  rowSpan: nullable(span),
  columnSpan: nullable(span),
  parentId: nullable(sourceBlockIdSchema),
  headingIds: array(sourceBlockIdSchema, { maxItems: contractLimits.refsPerItem }),
  origin: enumeration(sourceOrigins),
  bbox: nullable(bboxSchema),
})

export const readingIssueSchema = object({
  code: readingIssueCodeSchema,
  sourceRefs: sourceRefsSchema,
  message: string({ minLength: 1, maxLength: contractLimits.textChars }),
})

export const normalizedDocumentSchema = object({
  readerVersion: readerVersionSchema,
  /** SHA-256 esadecimale minuscolo dei byte del file originale. */
  sourceHash: string({ minLength: 64, maxLength: 64, pattern: /^[0-9a-f]{64}$/ }),
  blocks: array(sourceBlockSchema, { maxItems: contractLimits.largeItems }),
  readingIssues: array(readingIssueSchema, { maxItems: contractLimits.items }),
})

export type SourceBlock = Infer<typeof sourceBlockSchema>
export type SourceBlockKind = SourceBlock['kind']
export type ReadingIssue = Infer<typeof readingIssueSchema>
export type NormalizedDocument = Infer<typeof normalizedDocumentSchema>

function structureErrors(document: NormalizedDocument) {
  const errors = errorList()
  const indexById = new Map<string, number>()
  const blockAt = (id: string) => { const index = indexById.get(id); return index === undefined ? undefined : document.blocks[index] }

  document.blocks.forEach((block, index) => {
    const at = `/blocks/${index}`
    if (indexById.has(block.id)) errors.add(`${at}/id`, 'duplicate_id', `ID di blocco ripetuto: ${block.id}.`)
    else indexById.set(block.id, index)
    if (block.text !== normalizeSourceText(block.text)) errors.add(`${at}/text`, 'non_canonical_text', `Testo non conforme a ${TEXT_NORMALIZATION_VERSION}.`)
    const tableKind = block.kind === 'table_row' || block.kind === 'table_cell'
    const coordinates = tableKind && (block.tableId === null || block.row === null) ? 'Righe e celle richiedono tabella e riga.'
      : block.kind === 'table_cell' && block.column === null ? 'Una cella richiede la colonna.'
      : !tableKind && block.row !== null ? 'La riga vale solo per righe e celle di tabella.'
      : block.kind !== 'table_cell' && (block.column !== null || block.rowSpan !== null || block.columnSpan !== null) ? 'Colonna ed estensioni valgono solo per le celle.'
      : null
    if (coordinates) errors.add(at, 'table_coordinates', coordinates)
    if (block.bbox !== null && block.page === null) errors.add(`${at}/bbox`, 'bbox_without_page', 'Un riquadro richiede la pagina reale.')
  })

  const reference = (path: string, id: string, owner: string | null, seen: Set<string>) => {
    if (seen.has(id)) { errors.add(path, 'duplicate_ref', `Riferimento ripetuto: ${id}.`); return false }
    seen.add(id)
    if (id === owner) { errors.add(path, 'self_ref', 'Un blocco non può riferirsi a sé stesso.'); return false }
    if (!indexById.has(id)) { errors.add(path, 'dangling_ref', `Blocco inesistente: ${id}.`); return false }
    return true
  }
  document.blocks.forEach((block, index) => {
    const at = `/blocks/${index}`
    if (block.parentId !== null) reference(`${at}/parentId`, block.parentId, block.id, new Set())
    const seen = new Set<string>()
    block.headingIds.forEach((id, position) => {
      const path = `${at}/headingIds/${position}`
      if (reference(path, id, block.id, seen) && blockAt(id)?.kind !== 'heading') errors.add(path, 'heading_ref', `Il blocco ${id} non è un titolo.`)
    })
  })
  document.readingIssues.forEach((issue, index) => {
    const seen = new Set<string>()
    issue.sourceRefs.forEach((id, position) => reference(`/readingIssues/${index}/sourceRefs/${position}`, id, null, seen))
  })

  // Parentela senza cicli: visita iterativa, ogni blocco una volta sola.
  const state = new Map<string, 'visiting' | 'done'>()
  const inCycle = new Set<string>()
  for (const block of document.blocks) {
    const chain: string[] = []
    let id: string | null = block.id
    while (id !== null && !state.has(id)) {
      state.set(id, 'visiting')
      chain.push(id)
      const parent: string | null = blockAt(id)?.parentId ?? null
      id = parent !== null && parent !== id && indexById.has(parent) ? parent : null
    }
    if (id !== null && state.get(id) === 'visiting') chain.slice(chain.indexOf(id)).forEach(member => inCycle.add(member))
    chain.forEach(member => state.set(member, 'done'))
  }
  document.blocks.forEach((block, index) => {
    if (inCycle.has(block.id) && indexById.get(block.id) === index) errors.add(`/blocks/${index}/parentId`, 'parent_cycle', 'La parentela dei blocchi forma un ciclo.')
  })

  // Celle unite presenti una sola volta: nessuna posizione logica coperta da due celle.
  const rows = new Set<string>()
  const covered = new Set<string>()
  let tooManyCells = false
  document.blocks.forEach((block, index) => {
    if (tooManyCells || block.tableId === null || block.row === null) return
    if (block.kind === 'table_row') {
      const key = `${block.tableId}\u0000${block.row}`
      if (rows.has(key)) errors.add(`/blocks/${index}`, 'duplicate_table_row', 'Riga di tabella ripetuta.')
      rows.add(key)
    }
    if (block.kind !== 'table_cell' || block.column === null) return
    let overlap = false
    for (let row = block.row; row < block.row + (block.rowSpan ?? 1); row++) {
      for (let column = block.column; column < block.column + (block.columnSpan ?? 1); column++) {
        const key = `${block.tableId}\u0000${row}\u0000${column}`
        if (covered.has(key)) overlap = true
        else if (covered.size >= contractLimits.tableCells) { errors.add(`/blocks/${index}`, 'table_coordinates', 'Troppe celle logiche nel documento.'); tooManyCells = true; return }
        else covered.add(key)
      }
    }
    if (overlap) errors.add(`/blocks/${index}`, 'overlapping_cells', 'La cella si sovrappone a un’altra cella della tabella.')
  })
  return errors.errors
}

/** Forma chiusa più controlli strutturali: ID unici, riferimenti esistenti, coordinate valide, niente cicli. */
export function validateNormalizedDocument(value: unknown): ValidationResult<NormalizedDocument> {
  const shape = validate(normalizedDocumentSchema, value)
  if (!shape.ok) return shape
  const errors = structureErrors(shape.value)
  return errors.length ? { ok: false, errors } : shape
}
