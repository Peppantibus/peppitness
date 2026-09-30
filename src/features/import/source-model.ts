/**
 * Modello di presentazione della fonte letta (task 11), puro e senza React: ordine dei blocchi, sezioni
 * DOCX (corpo, intestazioni, piè di pagina, note), tabelle ricostruite dalle celle con unioni e tabelle
 * annidate, pagine PDF. Ogni blocco compare una volta sola; nessun testo viene riscritto o interpretato.
 */
import type { NormalizedDocument, SourceBlock } from '../../import/contracts/index.ts'

export type SourceSection = 'body' | 'header' | 'footer' | 'footnote' | 'endnote'
export const sourceSectionTitles: Record<SourceSection, string> = {
  body: 'Testo del documento', header: 'Intestazioni', footer: 'Piè di pagina', footnote: 'Note a piè di pagina', endnote: 'Note di chiusura',
}

/** Sezione del blocco dal prefisso dell'ID assegnato dal reader DOCX (`hdr:`, `ftr:`, `fn:`, `en:`). */
export function sectionOf(id: string): SourceSection {
  if (id.startsWith('hdr:')) return 'header'
  if (id.startsWith('ftr:')) return 'footer'
  if (id.startsWith('fn:')) return 'footnote'
  if (id.startsWith('en:')) return 'endnote'
  return 'body'
}
/** Paragrafo di una casella di testo (`box:<n>:…`), mostrato dopo il blocco che la ancora. */
export const isTextBox = (id: string) => /(^|:)box:/.test(id)

export interface CellLayout {
  /** null: posizione della griglia senza cella d'origine (riempimento). */
  block: SourceBlock | null
  rowSpan: number
  columnSpan: number
  /** Tabelle annidate in questa cella, nell'ordine del documento. */
  nested: TableLayout[]
}
export interface RowLayout { index: number; block: SourceBlock | null; cells: CellLayout[] }
export interface TableLayout { id: string; columns: number; rows: RowLayout[] }

export type SourceItem =
  | { type: 'block'; block: SourceBlock; section: SourceSection }
  | { type: 'table'; table: TableLayout; section: SourceSection }

interface TableParts { id: string; rows: SourceBlock[]; cells: SourceBlock[] }

/**
 * Griglia della tabella: le celle stanno nella loro colonna logica, le unioni occupano le posizioni coperte
 * e le posizioni scoperte ricevono una cella vuota, così la tabella HTML non sposta i valori di colonna.
 * Una cella che partirebbe da una posizione già coperta (dato incoerente) resta visibile in coda alla riga.
 */
function layoutTable(parts: TableParts, nestedFor: (cellId: string) => TableLayout[]): TableLayout {
  const rowCount = Math.max(0, ...parts.rows.map(row => (row.row ?? 0) + 1), ...parts.cells.map(cell => (cell.row ?? 0) + (cell.rowSpan ?? 1)))
  const columns = Math.max(1, ...parts.cells.map(cell => (cell.column ?? 0) + (cell.columnSpan ?? 1)))
  const covered = Array.from({ length: rowCount }, () => new Array<boolean>(columns).fill(false))
  const rows: RowLayout[] = []
  for (let index = 0; index < rowCount; index++) {
    const starting = parts.cells.filter(cell => cell.row === index).sort((a, b) => (a.column ?? 0) - (b.column ?? 0))
    const rowBlock = parts.rows.find(row => row.row === index) ?? null
    const cells: CellLayout[] = []
    const placed = new Set<SourceBlock>()
    for (let column = 0; column < columns; column++) {
      if (covered[index]![column]) continue
      const cell = starting.find(item => item.column === column && !placed.has(item))
      const rowSpan = cell ? Math.min(cell.rowSpan ?? 1, rowCount - index) : 1
      const columnSpan = cell ? Math.min(cell.columnSpan ?? 1, columns - column) : 1
      for (let r = index; r < index + rowSpan; r++) for (let c = column; c < column + columnSpan; c++) covered[r]![c] = true
      if (cell) placed.add(cell)
      cells.push({ block: cell ?? null, rowSpan, columnSpan, nested: cell ? nestedFor(cell.id) : [] })
    }
    for (const cell of starting) if (!placed.has(cell)) cells.push({ block: cell, rowSpan: 1, columnSpan: 1, nested: nestedFor(cell.id) })
    // Riga senza celle d'origine ma con testo: il testo della riga resta visibile su tutta la larghezza.
    if (!cells.some(cell => cell.block) && rowBlock?.text) cells.splice(0, cells.length, { block: rowBlock, rowSpan: 1, columnSpan: columns, nested: [] })
    rows.push({ index, block: rowBlock, cells })
  }
  return { id: parts.id, columns, rows }
}

/** Sequenza da mostrare: blocchi e tabelle nell'ordine del documento, tabelle annidate dentro la loro cella. */
export function buildSourceItems(blocks: readonly SourceBlock[]): SourceItem[] {
  const tables = new Map<string, TableParts>()
  const cellIds = new Set<string>()
  for (const block of blocks) {
    if (block.kind !== 'table_row' && block.kind !== 'table_cell') continue
    const id = block.tableId ?? block.id
    const parts = tables.get(id) ?? { id, rows: [], cells: [] }
    ;(block.kind === 'table_row' ? parts.rows : parts.cells).push(block)
    tables.set(id, parts)
    if (block.kind === 'table_cell') cellIds.add(block.id)
  }
  // Tabella annidata: le sue righe hanno come genitore una cella di un'altra tabella.
  const parentCell = new Map<string, string>()
  for (const parts of tables.values()) {
    const parent = parts.rows.find(row => row.parentId !== null)?.parentId
    if (parent && cellIds.has(parent) && !parts.cells.some(cell => cell.id === parent)) parentCell.set(parts.id, parent)
  }
  const nestedByCell = new Map<string, string[]>()
  for (const [table, cell] of parentCell) nestedByCell.set(cell, [...(nestedByCell.get(cell) ?? []), table])
  const built = new Map<string, TableLayout>()
  const building = new Set<string>()
  const tableFor = (id: string): TableLayout | null => {
    if (built.has(id)) return built.get(id)!
    if (building.has(id)) return null // ciclo impossibile per contratto: non ripetere il contenuto
    building.add(id)
    const layout = layoutTable(tables.get(id)!, cellId => (nestedByCell.get(cellId) ?? []).map(tableFor).filter((table): table is TableLayout => table !== null))
    built.set(id, layout)
    return layout
  }

  const items: SourceItem[] = []
  const emitted = new Set<string>()
  for (const block of blocks) {
    if (block.kind === 'table_row' || block.kind === 'table_cell') {
      const id = block.tableId ?? block.id
      if (emitted.has(id) || parentCell.has(id)) continue
      emitted.add(id)
      const table = tableFor(id)
      if (table) items.push({ type: 'table', table, section: sectionOf(id) })
      continue
    }
    items.push({ type: 'block', block, section: sectionOf(block.id) })
  }
  return items
}

/** Blocco → codici dei problemi di lettura che lo citano. */
export function issuesByBlock(document: NormalizedDocument): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const issue of document.readingIssues) for (const id of issue.sourceRefs) map.set(id, [...(map.get(id) ?? []), issue.code])
  return map
}

/**
 * Pagine del PDF da proporre: tutte quelle note (dal reader o dalla vista dell'originale); senza questi dati,
 * dopo una ripresa, almeno quelle che hanno blocchi. Le pagine senza testo restano descritte nei problemi.
 */
export function pageNumbers(document: NormalizedDocument, pageCount: number | null | undefined): number[] {
  const known = Math.max(pageCount ?? 0, ...document.blocks.map(block => block.page ?? 0))
  return Array.from({ length: known }, (_, index) => index + 1)
}

/** Blocchi di una pagina PDF (per l'elenco e i riquadri), nell'ordine di lettura del reader. */
export const blocksOnPage = (blocks: readonly SourceBlock[], page: number) => blocks.filter(block => block.page === page)

/** Blocco più piccolo che contiene il punto normalizzato (celle prima delle righe che le contengono). */
export function blockAtPoint(blocks: readonly SourceBlock[], x: number, y: number): SourceBlock | null {
  let found: SourceBlock | null = null
  let area = Infinity
  for (const block of blocks) {
    if (!block.bbox) continue
    const [left, top, width, height] = block.bbox
    if (x < left || x > left + width || y < top || y > top + height) continue
    const size = width * height
    if (size < area) { area = size; found = block }
  }
  return found
}

// ---------------------------------------------------------------------------
// Selezione esplicita di parti (22): quando il server chiede di ridurre il documento
// ---------------------------------------------------------------------------

/** Codice del problema di lettura che dichiara le parti escluse per scelta (classificato come parte non letta). */
export const EXCLUDED_BY_USER = 'excluded_by_user'
export interface DocumentUnit { id: string; label: string; blockIds: string[] }

const clip = (text: string, max = 60) => [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text

/**
 * Parti selezionabili, in ordine di fonte: pagine per il PDF; per il DOCX le sezioni del primo livello di titoli
 * che divide davvero il documento (un titolo unico in testa non basta), con il testo che precede i sottotitoli
 * come parte propria. Ogni blocco appartiene a una sola parte.
 */
export function documentUnits(document: NormalizedDocument, format: 'docx' | 'pdf'): DocumentUnit[] {
  const byId = new Map(document.blocks.map(block => [block.id, block]))
  const chain = (block: SourceBlock) => block.kind === 'heading' ? [...block.headingIds, block.id] : block.headingIds
  const keyAt = (block: SourceBlock, depth: number) => {
    if (format === 'pdf') return `page:${block.page ?? 0}`
    const headings = chain(block)
    return headings[depth] ?? (depth > 0 && headings[depth - 1] ? `pre:${headings[depth - 1]}` : 'start')
  }
  let depth = 0
  while (format === 'docx' && depth < 3 && new Set(document.blocks.map(block => keyAt(block, depth))).size < 2) depth++
  const units = new Map<string, DocumentUnit>()
  for (const block of document.blocks) {
    const key = keyAt(block, depth)
    let unit = units.get(key)
    if (!unit) {
      const heading = byId.get(key.startsWith('pre:') ? key.slice(4) : key)
      const label = key.startsWith('page:') ? `Pagina ${key.slice(5)}` : key === 'start' ? 'Parte iniziale e testo fuori dalle sezioni'
        : key.startsWith('pre:') ? `Introduzione di «${clip(heading?.text || 'sezione senza titolo')}»` : clip(heading?.text || 'Sezione senza titolo')
      unit = { id: key, label, blockIds: [] }
      units.set(key, unit)
    }
    unit.blockIds.push(block.id)
  }
  return [...units.values()]
}

/**
 * Documento con le sole parti scelte: blocchi nell'ordine originale, chiusi su genitori e titoli richiamati
 * (nessun riferimento pendente), problemi di lettura conservati sui blocchi rimasti e un problema che
 * elenca le parti escluse. Stessa fonte e stesso reader: nessun testo riscritto, nessun troncamento nascosto.
 */
export function narrowDocument(document: NormalizedDocument, units: readonly DocumentUnit[], chosen: ReadonlySet<string>): NormalizedDocument {
  const byId = new Map(document.blocks.map(block => [block.id, block]))
  const keep = new Set<string>()
  const stack = units.filter(unit => chosen.has(unit.id)).flatMap(unit => unit.blockIds)
  while (stack.length) {
    const id = stack.pop()!
    if (keep.has(id)) continue
    const block = byId.get(id)
    if (!block) continue
    keep.add(id)
    if (block.parentId) stack.push(block.parentId)
    stack.push(...block.headingIds)
  }
  const excluded = units.filter(unit => !chosen.has(unit.id)).map(unit => unit.label)
  const readingIssues = document.readingIssues.flatMap(issue => {
    const refs = issue.sourceRefs.filter(id => keep.has(id))
    return issue.sourceRefs.length && !refs.length ? [] : [{ ...issue, sourceRefs: refs }]
  })
  if (excluded.length) readingIssues.push({ code: EXCLUDED_BY_USER, sourceRefs: [], message: `Parti escluse dall’analisi per scelta: ${excluded.join('; ')}.` })
  return { ...document, blocks: document.blocks.filter(block => keep.has(block.id)), readingIssues }
}
