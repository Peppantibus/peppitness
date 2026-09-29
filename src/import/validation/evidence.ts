/**
 * Prove della proposta (specifica §7.2). JSON Pointer RFC 6901 risolti sulla proposta immutabile;
 * citazioni cercate nel testo canonico del blocco con la sola normalizzazione dichiarata
 * (`peppitness.text-normalization.v1`, applicata alla citazione), senza ignorare maiuscole, spazi o
 * punteggiatura. Una citazione trovata prova solo che quel testo esiste: righe, colonne, intestazioni
 * e ambito sono giudicati con l'indice della fonte, i valori dalle regole di dominio.
 */
import {
  normalizeSourceText,
  type DietExtraction, type NormalizedDocument, type SourceBlock, type WorkoutExtraction,
} from '../contracts/index.ts'
import type { RuleItem } from './issues.ts'

// ---------------------------------------------------------------------------
// JSON Pointer RFC 6901
// ---------------------------------------------------------------------------

const ARRAY_INDEX = /^(0|[1-9]\d*)$/

/** Token di un JSON Pointer, null se la sintassi non è RFC 6901. */
export function pointerTokens(pointer: string): string[] | null {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) return null
  const tokens = pointer.slice(1).split('/')
  if (tokens.some(token => /~(?![01])/.test(token))) return null
  return tokens.map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
}

/** Valore indicato dal puntatore; `-` e indici con zeri iniziali non indicano mai un elemento. */
export function resolvePointer(root: unknown, pointer: string): { found: true; value: unknown } | { found: false } {
  const tokens = pointerTokens(pointer)
  if (!tokens) return { found: false }
  let current: unknown = root
  for (const token of tokens) {
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(token) || Number(token) >= current.length) return { found: false }
      current = current[Number(token)]
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token]
    } else return { found: false }
  }
  return { found: true, value: current }
}

/** Puntatore padre ('' per un campo di primo livello, null per la radice). */
export const parentPointer = (pointer: string) => pointer === '' ? null : pointer.slice(0, pointer.lastIndexOf('/'))

// ---------------------------------------------------------------------------
// Indice della fonte
// ---------------------------------------------------------------------------

/** Ruolo di una colonna ricavato dall'intestazione della tabella. */
export type ColumnRole = 'sets' | 'repetitions' | 'durationSeconds' | 'restSeconds' | 'rir' | 'rpe' | 'scheme'
const columnRoleRules: readonly [ColumnRole, RegExp][] = [
  ['rir', /\bRIR\b/i],
  ['rpe', /\bRPE\b/i],
  ['restSeconds', /\b(recupero|rec\.?|pausa|riposo|rest)(?=\W|$)/i],
  ['durationSeconds', /\b(durata|secondi|sec|tempo di lavoro)\b/i],
  ['sets', /\b(serie|sets?|series)\b/i],
  ['repetitions', /\b(ripetizioni|rip\.?|ripetiz\w*|reps?)(?=\W|$)/i],
]
const SCHEME_HEADER = /\bschema\b|\b(serie|sets?)\s*[x×]\s*(rip\w*|reps?)\b/i

/** Colonna logica di una riga con la sua posizione nel testo della riga (quando ricostruibile). */
export interface RowColumn { column: number; text: string; start: number; end: number }

export interface SourceIndex {
  readonly document: NormalizedDocument
  readonly blocks: ReadonlyMap<string, SourceBlock>
  readonly order: ReadonlyMap<string, number>
  /** Riga di tabella di un blocco riga o cella; null fuori dalle tabelle. */
  rowOf(block: SourceBlock): SourceBlock | null
  /** La riga e le sue celle, oppure il blocco stesso. */
  family(block: SourceBlock): string[]
  /** Colonne della riga con offset nel testo della riga. */
  columns(row: SourceBlock): RowColumn[]
  /** Righe d'intestazione della tabella (prima riga con parole di colonna e senza cifre). */
  headerRow(tableId: string): SourceBlock | null
  /** Ruoli delle colonne della tabella, dall'intestazione. */
  roles(tableId: string): ReadonlyMap<number, ColumnRole>
}

const rowKey = (tableId: string, row: number) => `${tableId}\u0000${row}`

export function indexSource(document: NormalizedDocument): SourceIndex {
  const blocks = new Map<string, SourceBlock>()
  const order = new Map<string, number>()
  const rows = new Map<string, SourceBlock>()
  const cells = new Map<string, SourceBlock[]>()
  const tableRows = new Map<string, SourceBlock[]>()
  document.blocks.forEach((block, index) => {
    blocks.set(block.id, block)
    order.set(block.id, index)
    if (block.tableId === null || block.row === null) return
    const key = rowKey(block.tableId, block.row)
    if (block.kind === 'table_row') {
      rows.set(key, block)
      const list = tableRows.get(block.tableId) ?? []
      list.push(block)
      tableRows.set(block.tableId, list)
    } else if (block.kind === 'table_cell') {
      const list = cells.get(key) ?? []
      list.push(block)
      cells.set(key, list)
    }
  })
  for (const list of cells.values()) list.sort((a, b) => (a.column ?? 0) - (b.column ?? 0))
  for (const list of tableRows.values()) list.sort((a, b) => (a.row ?? 0) - (b.row ?? 0))

  const columnCache = new Map<string, RowColumn[]>()
  const columns = (row: SourceBlock): RowColumn[] => {
    const cached = columnCache.get(row.id)
    if (cached) return cached
    const result: RowColumn[] = []
    const own = row.tableId !== null && row.row !== null ? cells.get(rowKey(row.tableId, row.row)) ?? [] : []
    if (own.length) {
      // Celle presenti: posizione di ogni testo nella riga, in ordine, come nei reader (` | `).
      let cursor = 0
      for (const cell of own) {
        if (cell.text === '') { result.push({ column: cell.column ?? 0, text: '', start: cursor, end: cursor }); continue }
        const at = row.text.indexOf(cell.text, cursor)
        if (at < 0) { result.push({ column: cell.column ?? 0, text: cell.text, start: -1, end: -1 }); continue }
        result.push({ column: cell.column ?? 0, text: cell.text, start: at, end: at + cell.text.length })
        cursor = at + cell.text.length
      }
    } else {
      // Solo la riga: colonne separate da ` | ` come le producono i reader.
      const separator = / ?\| ?/g
      let start = 0
      let column = 0
      for (let match = separator.exec(row.text); match; match = separator.exec(row.text)) {
        result.push({ column: column++, text: row.text.slice(start, match.index), start, end: match.index })
        start = match.index + match[0].length
      }
      result.push({ column, text: row.text.slice(start), start, end: row.text.length })
    }
    columnCache.set(row.id, result)
    return result
  }

  const headerCache = new Map<string, SourceBlock | null>()
  const headerRow = (tableId: string) => {
    if (headerCache.has(tableId)) return headerCache.get(tableId)!
    const found = (tableRows.get(tableId) ?? []).find(row => !/\d/.test(row.text)
      && columns(row).some(column => SCHEME_HEADER.test(column.text) || columnRoleRules.some(([, pattern]) => pattern.test(column.text)))) ?? null
    headerCache.set(tableId, found)
    return found
  }
  const roleCache = new Map<string, Map<number, ColumnRole>>()
  const roles = (tableId: string) => {
    const cached = roleCache.get(tableId)
    if (cached) return cached
    const result = new Map<number, ColumnRole>()
    const header = headerRow(tableId)
    if (header) {
      for (const column of columns(header)) {
        if (SCHEME_HEADER.test(column.text)) { result.set(column.column, 'scheme'); continue }
        const matched = columnRoleRules.filter(([, pattern]) => pattern.test(column.text)).map(([role]) => role)
        if (matched.includes('sets') && matched.includes('repetitions')) result.set(column.column, 'scheme')
        else if (matched.length) result.set(column.column, matched[0]!)
      }
    }
    roleCache.set(tableId, result)
    return result
  }

  const rowOf = (block: SourceBlock) => {
    if (block.tableId === null || block.row === null) return null
    return block.kind === 'table_row' ? block : rows.get(rowKey(block.tableId, block.row)) ?? null
  }
  const family = (block: SourceBlock) => {
    const row = rowOf(block)
    if (!row || row.tableId === null || row.row === null) return [block.id]
    return [row.id, ...(cells.get(rowKey(row.tableId, row.row)) ?? []).map(cell => cell.id)]
  }
  return { document, blocks, order, rowOf, family, columns, headerRow, roles }
}

// ---------------------------------------------------------------------------
// Unità di campo e citazioni
// ---------------------------------------------------------------------------

/** Valore della proposta che richiede una prova: un campo, un elemento di una lista di testi o metà del ciclo. */
export interface FieldUnit { item: RuleItem; field: string; path: string; value: unknown }

/** Campi che non richiedono citazioni: classificazioni e riferimenti delle regole. */
const exempt = new Set(['kind', 'sourceRefs', 'targetPaths'])

export function fieldUnits(items: readonly RuleItem[]): FieldUnit[] {
  const units: FieldUnit[] = []
  for (const item of items) {
    if (item.pointer === null) continue
    for (const [field, value] of Object.entries(item.values)) {
      if (value === null || exempt.has(field)) continue
      const path = item.pointer + '/' + field
      if (field === 'schedule' && value === 'unknown') continue
      if (field === 'cycle') {
        const cycle = value as { startDate: unknown; weeks: unknown }
        if (cycle.startDate !== null) units.push({ item, field, path: `${path}/startDate`, value: cycle.startDate })
        if (cycle.weeks !== null) units.push({ item, field, path: `${path}/weeks`, value: cycle.weeks })
        continue
      }
      if (Array.isArray(value)) { value.forEach((entry, index) => { if (entry !== '') units.push({ item, field, path: `${path}/${index}`, value: entry }) }); continue }
      if (value === '') continue
      units.push({ item, field, path, value })
    }
  }
  return units
}

export interface VerifiedSpan { blockId: string; quote: string; block: SourceBlock; offsets: number[] }
export interface InvalidSpan { blockId: string; quote: string; reason: 'unknown_block' | 'quote_not_found' }
export interface UnitEvidence { unit: FieldUnit; spans: VerifiedSpan[]; invalid: InvalidSpan[]; cited: boolean }

/** Occorrenze della citazione normalizzata nel testo canonico del blocco (al massimo 64). */
export function quoteOffsets(blockText: string, quote: string): { quote: string; offsets: number[] } {
  const normalized = normalizeSourceText(quote)
  const offsets: number[] = []
  if (normalized === '') return { quote: normalized, offsets }
  for (let at = blockText.indexOf(normalized); at >= 0 && offsets.length < 64; at = blockText.indexOf(normalized, at + 1)) offsets.push(at)
  return { quote: normalized, offsets }
}

export interface EvidenceProblem { kind: 'dangling_path' | 'for_null' | 'too_coarse'; path: string; refs: string[] }

/**
 * Collega ogni evidence all'unità di campo che prova: stesso percorso o un suo discendente (`/min`
 * di un intervallo). Un percorso su un elemento intero non prova alcun campo.
 */
export function collectEvidence(extraction: WorkoutExtraction | DietExtraction, units: readonly FieldUnit[], itemPointers: ReadonlySet<string>, index: SourceIndex) {
  const byPath = new Map<string, UnitEvidence>(units.map(unit => [unit.path, { unit, spans: [], invalid: [], cited: false }]))
  const problems: EvidenceProblem[] = []
  for (const entry of extraction.evidence) {
    const refs = entry.spans.map(span => span.blockId).filter(id => index.blocks.has(id))
    const resolved = resolvePointer(extraction, entry.path)
    const top = pointerTokens(entry.path)?.[0]
    if (!resolved.found || top === undefined || ['schemaVersion', 'kind', 'outcome', 'evidence', 'issues', 'unassigned'].includes(top)) {
      problems.push({ kind: 'dangling_path', path: entry.path, refs }); continue
    }
    let target: UnitEvidence | undefined
    for (let path: string | null = entry.path; path !== null && !target; path = parentPointer(path)) {
      target = byPath.get(path)
      if (!target && itemPointers.has(path)) break
    }
    if (!target) {
      const value = resolved.value
      const empty = value === null || value === '' || (Array.isArray(value) && value.length === 0) || (entry.path === '/schedule' && value === 'unknown')
      problems.push({ kind: empty ? 'for_null' : 'too_coarse', path: entry.path, refs })
      continue
    }
    target.cited = true
    for (const span of entry.spans) {
      const block = index.blocks.get(span.blockId)
      if (!block) { target.invalid.push({ blockId: span.blockId, quote: span.quote, reason: 'unknown_block' }); continue }
      const found = quoteOffsets(block.text, span.quote)
      if (!found.offsets.length) target.invalid.push({ blockId: span.blockId, quote: span.quote, reason: 'quote_not_found' })
      else target.spans.push({ blockId: block.id, quote: found.quote, block, offsets: found.offsets })
    }
  }
  return { byPath, problems }
}

// ---------------------------------------------------------------------------
// Testo citato e ambito
// ---------------------------------------------------------------------------

const fold = (value: string) => normalizeSourceText(value).toLocaleLowerCase('it')

/**
 * Il valore testuale è contenuto nelle citazioni verificate (maiuscole ignorate, stessa normalizzazione):
 * un nome o una quantità completati o riformulati non passano.
 */
export function textInQuotes(value: string, spans: readonly VerifiedSpan[]): boolean {
  const target = fold(value)
  if (target === '') return true
  const quotes = spans.map(span => fold(span.quote))
  return quotes.some(quote => quote.includes(target)) || quotes.join(' ').includes(target)
}

/** Colonne della riga in cui cade la citazione (tutte le occorrenze). */
export function spanColumns(index: SourceIndex, span: VerifiedSpan): Set<number> | null {
  const row = index.rowOf(span.block)
  if (!row) return null
  if (span.block.kind === 'table_cell') return new Set(span.block.column === null ? [] : [span.block.column])
  const result = new Set<number>()
  const columns = index.columns(row)
  for (const offset of span.offsets) {
    const end = offset + span.quote.length
    for (const column of columns) if (column.start >= 0 && offset < Math.max(column.end, column.start + 1) && end > column.start) result.add(column.column)
  }
  return result
}

/** Testo della cella di una colonna nella riga del blocco. */
export function columnText(index: SourceIndex, row: SourceBlock, column: number): string | null {
  return index.columns(row).find(entry => entry.column === column)?.text ?? null
}

/** Testo potenzialmente rivolto all'interprete: resta un dato, ma non può fondare un valore. */
const SUSPICIOUS = /\b(ignora|ignorate|ignore|disregard|dimentica)\b[^.]{0,60}\b(istruzion\w*|instructions?|prompt|regole)\b|\bsystem prompt\b|\b(sei|you are) (un|an?|the) (modello|assistente|assistant|ai|language model)\b|<\s*\/?\s*(script|system)\b|\bassistant\s*:|###\s*(istruzion|instruction)/i
export const isSuspiciousText = (text: string) => SUSPICIOUS.test(text)

/** Citazioni verificate per elemento e campo: tutti gli elementi di una lista e le due metà del ciclo insieme. */
export function groupSpans(evidence: ReadonlyMap<string, UnitEvidence>) {
  const grouped = new Map<string, VerifiedSpan[]>()
  for (const entry of evidence.values()) {
    const key = `${entry.unit.item.pointer}\u0000${entry.unit.field}`
    grouped.set(key, [...grouped.get(key) ?? [], ...entry.spans])
  }
  return (item: RuleItem, field: string) => grouped.get(`${item.pointer}\u0000${field}`) ?? []
}
