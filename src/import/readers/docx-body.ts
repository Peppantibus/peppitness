/**
 * Corpo di un documento WordprocessingML → blocchi sorgente, in ordine di documento.
 *
 * - Paragrafi `p:<n>`: n conta i paragrafi di primo livello del corpo (vuoti compresi), da 1.
 *   Titoli dal livello di struttura o dagli stili Titolo/Heading; elementi di elenco dalla
 *   numerazione, con `parentId` verso l'elemento di livello superiore.
 * - Tabelle `t:<n>` numerate in ordine di documento (annidate comprese); righe `t:n:r:<riga>`
 *   con il testo delle celle che vi originano separato da ` | `; celle `t:n:r:<riga>:c:<colonna>`
 *   con coordinate logiche della griglia. Una cella unita esiste una sola volta, con rowSpan e
 *   columnSpan; le tabelle annidate hanno righe con `parentId` sulla cella che le contiene.
 * - Testo dei run ricomposto senza perdere parole, spazi, tabulazioni e interruzioni, poi reso
 *   canonico. Revisioni, testo nascosto e componenti non letti diventano constatazioni con
 *   riferimento ai blocchi: mai testo inserito ed eliminato concatenato.
 */
import { contractLimits } from '../contracts/schema.ts'
import { normalizeSourceText, type SourceBlock } from '../contracts/normalized-document.ts'
import { DocumentReaderError } from '../contracts/reader.ts'
import { attribute, integerAttribute, numberingOf, onOff, type ParagraphStyle, type StyleSheet } from './docx-styles.ts'
import type { Relationship } from './ooxml-package.ts'
import type { ReadControl } from './read-control.ts'
import { directText, elementChildren, firstChild, type XmlElement } from './xml.ts'

/** Elementi il cui testo serve al reader del corpo. */
export const bodyTextElements: ReadonlySet<string> = new Set(['w:t', 'w:delText', 'w:instrText', 'w:delInstrText', 'm:t'])

export const bodyFindingKinds = [
  'tracked_changes', 'hidden_text', 'hidden_row', 'math', 'symbol', 'alt_chunk', 'merged_cell_text',
  'text_box', 'image', 'external_image', 'embedded_object',
] as const
export type BodyFinding = typeof bodyFindingKinds[number]

export interface BodyFindingSummary {
  kind: BodyFinding
  /** Occorrenze, anche in paragrafi senza testo e quindi senza blocco. */
  count: number
  /** Blocchi interessati, in ordine e senza ripetizioni. */
  refs: string[]
}

export interface BodyReadResult { blocks: SourceBlock[]; findings: BodyFindingSummary[] }

/** Elementi di servizio senza testo visibile. */
const ignoredInline = new Set([
  'w:pPr', 'w:rPr', 'w:sdtPr', 'w:sdtEndPr', 'w:smartTagPr', 'w:customXmlPr', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:proofErr',
  'w:permStart', 'w:permEnd', 'w:commentRangeStart', 'w:commentRangeEnd', 'w:moveFromRangeStart', 'w:moveFromRangeEnd',
  'w:moveToRangeStart', 'w:moveToRangeEnd', 'w:customXmlInsRangeStart', 'w:customXmlInsRangeEnd', 'w:customXmlDelRangeStart',
  'w:customXmlDelRangeEnd', 'w:customXmlMoveFromRangeStart', 'w:customXmlMoveFromRangeEnd', 'w:customXmlMoveToRangeStart',
  'w:customXmlMoveToRangeEnd', 'w:sectPr', 'w:tblPr', 'w:tblGrid', 'w:trPr', 'w:tcPr', 'w:tblPrEx',
])

interface InlineContext {
  out: string[]
  found: Map<BodyFinding, number>
  style: ParagraphStyle
  /** Falso dentro il Fallback di mc:AlternateContent, già inventariato una volta. */
  scan: boolean
}

interface CellRecord {
  id: string
  row: number
  column: number
  rowSpan: number
  columnSpan: number
  paragraphs: string[]
  nested: XmlElement[]
  found: Map<BodyFinding, number>
}
interface RowRecord { id: string; index: number; cells: CellRecord[]; found: Map<BodyFinding, number> }

const bump = (found: Map<BodyFinding, number>, kind: BodyFinding, count = 1) => found.set(kind, (found.get(kind) ?? 0) + count)
const merge = (into: Map<BodyFinding, number>, from: Map<BodyFinding, number>) => from.forEach((count, kind) => bump(into, kind, count))

const hasVisibleText = (element: XmlElement): boolean => {
  const stack = [element]
  while (stack.length) {
    const node = stack.pop()!
    if (node.name === 'w:t' && /\S/.test(directText(node))) return true
    stack.push(...elementChildren(node))
  }
  return false
}

export class BodyReader {
  private readonly styles: StyleSheet
  private readonly relationships: Map<string, Relationship>
  private readonly control: ReadControl
  private readonly blocks: SourceBlock[] = []
  private readonly log = new Map<BodyFinding, { count: number; refs: string[]; seen: Set<string> }>()
  private paragraphs = 0
  private tables = 0
  private headings: { id: string; level: number }[] = []
  private list: { id: string; level: number }[] = []

  constructor(styles: StyleSheet, relationships: Map<string, Relationship>, control: ReadControl) {
    this.styles = styles
    this.relationships = relationships
    this.control = control
  }

  async read(documentRoot: XmlElement): Promise<BodyReadResult> {
    if (documentRoot.name !== 'w:document') throw new DocumentReaderError('corrupt', 'Il documento principale non è un documento Word valido.')
    const body = firstChild(documentRoot, 'w:body')
    if (body) await this.container(body)
    return {
      blocks: this.blocks,
      findings: bodyFindingKinds.flatMap(kind => {
        const entry = this.log.get(kind)
        return entry ? [{ kind, count: entry.count, refs: entry.refs }] : []
      }),
    }
  }

  // --- constatazioni ------------------------------------------------------------------------

  private record(found: Map<BodyFinding, number>, ref: string | null) {
    found.forEach((count, kind) => {
      const entry = this.log.get(kind) ?? { count: 0, refs: [], seen: new Set<string>() }
      entry.count += count
      if (ref !== null && !entry.seen.has(ref)) { entry.seen.add(ref); entry.refs.push(ref) }
      this.log.set(kind, entry)
    })
  }

  // --- blocchi ------------------------------------------------------------------------------

  private canonical(raw: string): string {
    const text = normalizeSourceText(raw)
    if (text.length > contractLimits.textChars) {
      const length = [...text].length
      if (length > contractLimits.textChars) throw new DocumentReaderError('limit_exceeded', 'Un paragrafo o una cella supera la lunghezza massima.', { limit: 'blockTextChars', max: contractLimits.textChars, actual: length })
    }
    return text
  }

  private push(block: Omit<SourceBlock, 'page' | 'origin' | 'bbox'>) {
    if (this.blocks.length >= contractLimits.largeItems) {
      throw new DocumentReaderError('limit_exceeded', 'Il documento contiene troppi blocchi di testo.', { limit: 'documentBlocks', max: contractLimits.largeItems, actual: this.blocks.length + 1 })
    }
    this.blocks.push({ ...block, page: null, origin: 'native', bbox: null })
  }

  private headingIds() { return this.headings.map(heading => heading.id) }

  // --- contenitori di blocchi ---------------------------------------------------------------

  private async container(container: XmlElement): Promise<void> {
    for (const child of elementChildren(container)) {
      await this.control.pause()
      switch (child.name) {
        case 'w:p': this.paragraph(child); break
        case 'w:tbl': this.list = []; await this.table(child, null); break
        case 'w:sdt': { const content = firstChild(child, 'w:sdtContent'); if (content) await this.container(content); break }
        case 'mc:AlternateContent': { const fallback = firstChild(child, 'mc:Fallback'); if (fallback) await this.container(fallback); break }
        case 'w:altChunk': this.record(new Map([['alt_chunk', 1]]), null); break
        default: if (!ignoredInline.has(child.name)) await this.container(child)
      }
    }
  }

  private paragraphStyle(pPr: XmlElement | undefined): ParagraphStyle {
    return this.styles.paragraph(attribute(pPr && firstChild(pPr, 'w:pStyle')))
  }

  /** Testo grezzo di un paragrafo e constatazioni, senza creare blocchi. */
  private paragraphText(p: XmlElement, style: ParagraphStyle) {
    const context: InlineContext = { out: [], found: new Map(), style, scan: true }
    const pPr = firstChild(p, 'w:pPr')
    const markRPr = pPr && firstChild(pPr, 'w:rPr')
    if (markRPr && (firstChild(markRPr, 'w:ins') || firstChild(markRPr, 'w:del'))) bump(context.found, 'tracked_changes')
    this.inline(p, context)
    return { raw: context.out.join(''), found: context.found }
  }

  private paragraph(p: XmlElement) {
    const id = `p:${++this.paragraphs}`
    const pPr = firstChild(p, 'w:pPr')
    const style = this.paragraphStyle(pPr)
    const { raw, found } = this.paragraphText(p, style)
    const text = this.canonical(raw)
    if (!text) { this.record(found, null); return }

    const directOutline = integerAttribute(pPr && firstChild(pPr, 'w:outlineLvl'))
    const outline = directOutline ?? style.outlineLevel
    const namedLevel = /^heading ([1-9])$/.exec(style.name)
    const level = outline !== null ? (outline >= 0 && outline <= 8 ? outline + 1 : null)
      : style.name === 'title' ? 0
      : namedLevel ? Number(namedLevel[1]) : null
    const numbered = numberingOf(pPr) ?? style.numbered

    if (level !== null) {
      while (this.headings.length && this.headings[this.headings.length - 1]!.level >= level) this.headings.pop()
      this.push({ id, kind: 'heading', text, tableId: null, row: null, column: null, rowSpan: null, columnSpan: null, parentId: null, headingIds: this.headingIds() })
      this.headings.push({ id, level })
      this.list = []
    } else if (numbered) {
      const numPr = pPr && firstChild(pPr, 'w:numPr')
      const ilvl = Math.min(Math.max(integerAttribute(numPr && firstChild(numPr, 'w:ilvl')) ?? 0, 0), 8)
      while (this.list.length && this.list[this.list.length - 1]!.level >= ilvl) this.list.pop()
      const parentId = this.list[this.list.length - 1]?.id ?? null
      this.push({ id, kind: 'list_item', text, tableId: null, row: null, column: null, rowSpan: null, columnSpan: null, parentId, headingIds: this.headingIds() })
      this.list.push({ id, level: ilvl })
    } else {
      this.push({ id, kind: 'paragraph', text, tableId: null, row: null, column: null, rowSpan: null, columnSpan: null, parentId: null, headingIds: this.headingIds() })
      this.list = []
    }
    this.record(found, id)
  }

  // --- contenuto in linea -------------------------------------------------------------------

  private inline(element: XmlElement, context: InlineContext): void {
    for (const child of elementChildren(element)) {
      switch (child.name) {
        case 'w:r': this.run(child, context); break
        // Revisioni: il testo inserito resta, quello eliminato o spostato via non entra mai.
        case 'w:ins': case 'w:moveTo': bump(context.found, 'tracked_changes'); this.inline(child, context); break
        case 'w:del': case 'w:moveFrom': bump(context.found, 'tracked_changes'); break
        case 'w:sdt': { const content = firstChild(child, 'w:sdtContent'); if (content) this.inline(content, context); break }
        case 'mc:AlternateContent': this.alternate(child, context, false); break
        case 'm:oMath': case 'm:oMathPara': bump(context.found, 'math'); break
        case 'w:subDoc': bump(context.found, 'alt_chunk'); break
        default: if (!ignoredInline.has(child.name)) this.inline(child, context)
      }
    }
  }

  private runHidden(rPr: XmlElement | undefined, style: ParagraphStyle): boolean {
    const direct = onOff(rPr && firstChild(rPr, 'w:vanish'))
    if (direct !== null) return direct
    return this.styles.characterHidden(attribute(rPr && firstChild(rPr, 'w:rStyle'))) ?? style.hidden
  }

  private run(run: XmlElement, context: InlineContext) {
    const hidden = this.runHidden(firstChild(run, 'w:rPr'), context.style)
    for (const child of elementChildren(run)) this.runChild(child, hidden, context)
  }

  private runChild(child: XmlElement, hidden: boolean, context: InlineContext) {
    const emit = (text: string) => { if (!hidden) context.out.push(text) }
    switch (child.name) {
      case 'w:t': {
        const text = directText(child)
        if (hidden && /\S/.test(text)) bump(context.found, 'hidden_text')
        emit(text)
        break
      }
      case 'w:tab': case 'w:ptab': emit('\t'); break
      case 'w:br': case 'w:cr': emit('\n'); break
      case 'w:noBreakHyphen': emit('-'); break
      case 'w:sym': {
        const code = Number.parseInt(attribute(child, 'w:char') ?? '', 16)
        // Carattere di un font simbolo (area privata F000–F0FF): il significato dipende dal font.
        if (!Number.isInteger(code) || (code >= 0xf000 && code <= 0xf0ff) || code < 0x20 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) bump(context.found, 'symbol')
        else emit(String.fromCodePoint(code))
        break
      }
      case 'w:delText': case 'w:delInstrText': bump(context.found, 'tracked_changes'); break
      case 'w:drawing': case 'w:pict': case 'w:object': this.components(child, context); break
      case 'mc:AlternateContent': this.alternate(child, context, true, hidden); break
      case 'w:ruby': { const base = firstChild(child, 'w:rubyBase'); if (base) this.inline(base, context); break }
      default: break // proprietà, istruzioni di campo, riferimenti a note/commenti, interruzioni di pagina calcolate
    }
  }

  /** Una sola constatazione per blocco alternativo; il testo viene dal Fallback, se esiste. */
  private alternate(element: XmlElement, context: InlineContext, inRun: boolean, hidden = false) {
    this.components(element, context)
    const fallback = firstChild(element, 'mc:Fallback')
    if (!fallback) return
    const nested: InlineContext = { ...context, scan: false }
    if (inRun) for (const child of elementChildren(fallback)) this.runChild(child, hidden, nested)
    else this.inline(fallback, nested)
  }

  /** Inventario di disegni e oggetti: caselle di testo, immagini, oggetti incorporati. */
  private components(element: XmlElement, context: InlineContext) {
    if (!context.scan) return
    const kinds = new Set<BodyFinding>()
    const stack = [element]
    while (stack.length) {
      const node = stack.pop()!
      switch (node.name) {
        case 'w:txbxContent': if (hasVisibleText(node)) kinds.add('text_box'); continue
        case 'w:object': case 'o:OLEObject': case 'c:chart': case 'dgm:relIds': kinds.add('embedded_object'); continue
        case 'a:blip': {
          const embed = node.attributes['r:embed']
          const external = node.attributes['r:link'] !== undefined || (embed !== undefined && this.relationships.get(embed)?.external === true)
          kinds.add(external ? 'external_image' : 'image')
          break
        }
        case 'v:imagedata': {
          const id = node.attributes['r:id'] ?? node.attributes['o:relid']
          const external = id === undefined ? node.attributes.src !== undefined : this.relationships.get(id)?.external === true
          kinds.add(external ? 'external_image' : 'image')
          break
        }
      }
      stack.push(...elementChildren(node))
    }
    kinds.forEach(kind => bump(context.found, kind))
  }

  // --- tabelle ------------------------------------------------------------------------------

  /** Figli con un certo nome, attraverso controlli contenuto e XML personalizzato. */
  private collect(container: XmlElement, name: string, into: XmlElement[] = []): XmlElement[] {
    for (const child of elementChildren(container)) {
      if (child.name === name) into.push(child)
      else if (child.name === 'w:sdt') { const content = firstChild(child, 'w:sdtContent'); if (content) this.collect(content, name, into) }
      else if (child.name === 'w:customXml') this.collect(child, name, into)
    }
    return into
  }

  private cellContent(container: XmlElement, cell: Pick<CellRecord, 'paragraphs' | 'nested' | 'found'>) {
    for (const child of elementChildren(container)) {
      switch (child.name) {
        case 'w:p': {
          const { raw, found } = this.paragraphText(child, this.paragraphStyle(firstChild(child, 'w:pPr')))
          cell.paragraphs.push(raw)
          merge(cell.found, found)
          break
        }
        case 'w:tbl': cell.nested.push(child); break
        case 'w:sdt': { const content = firstChild(child, 'w:sdtContent'); if (content) this.cellContent(content, cell); break }
        case 'w:altChunk': bump(cell.found, 'alt_chunk'); break
        default: if (!ignoredInline.has(child.name)) this.cellContent(child, cell)
      }
    }
  }

  private span(value: number | null, what: string): number {
    if (value === null || value < 1) return 1
    if (value > contractLimits.cellSpan) throw new DocumentReaderError('limit_exceeded', `Tabella con ${what} troppo estesa.`, { limit: 'cellSpan', max: contractLimits.cellSpan, actual: value })
    return value
  }

  private async table(tbl: XmlElement, parentId: string | null): Promise<void> {
    const tableId = `t:${++this.tables}`
    const headingIds = this.headingIds()
    const rows: RowRecord[] = []
    let open = new Map<number, CellRecord>()

    for (const [index, tr] of this.collect(tbl, 'w:tr').entries()) {
      await this.control.pause()
      const rowId = `${tableId}:r:${index}`
      const row: RowRecord = { id: rowId, index, cells: [], found: new Map() }
      const trPr = firstChild(tr, 'w:trPr')
      if (trPr && (firstChild(trPr, 'w:ins') || firstChild(trPr, 'w:del'))) bump(row.found, 'tracked_changes')
      if (onOff(trPr && firstChild(trPr, 'w:hidden'))) bump(row.found, 'hidden_row')
      let column = integerAttribute(trPr && firstChild(trPr, 'w:gridBefore')) ?? 0
      if (column < 0) column = 0
      if (column > contractLimits.cellSpan) throw new DocumentReaderError('limit_exceeded', 'Tabella con troppe colonne.', { limit: 'cellSpan', max: contractLimits.cellSpan, actual: column })
      const next = new Map<number, CellRecord>()

      for (const tc of this.collect(tr, 'w:tc')) {
        const tcPr = firstChild(tc, 'w:tcPr')
        const columnSpan = this.span(integerAttribute(tcPr && firstChild(tcPr, 'w:gridSpan')), 'celle unite')
        const vMerge = tcPr && firstChild(tcPr, 'w:vMerge')
        const vertical = vMerge === undefined ? null : attribute(vMerge) === 'restart' ? 'restart' : 'continue'
        const hMergeElement = tcPr && firstChild(tcPr, 'w:hMerge')
        const horizontal = hMergeElement === undefined ? null : attribute(hMergeElement) === 'restart' ? 'restart' : 'continue'
        const content = { paragraphs: [] as string[], nested: [] as XmlElement[], found: new Map<BodyFinding, number>() }
        if (tcPr && (firstChild(tcPr, 'w:cellIns') || firstChild(tcPr, 'w:cellDel') || firstChild(tcPr, 'w:cellMerge'))) bump(content.found, 'tracked_changes')
        this.cellContent(tc, content)

        const above = vertical === 'continue' ? open.get(column) : undefined
        const previous = row.cells[row.cells.length - 1]
        const target = above && above.columnSpan === columnSpan ? above
          : horizontal === 'continue' && previous && previous.rowSpan === 1 && previous.column + previous.columnSpan === column ? previous
          : null

        if (target) {
          // Continuazione di una cella unita: stessa cella, nessun nuovo blocco.
          if (target === above) {
            target.rowSpan = this.span(target.rowSpan + 1, 'righe unite')
            next.set(column, target)
          } else target.columnSpan = this.span(target.columnSpan + columnSpan, 'celle unite')
          if (normalizeSourceText(content.paragraphs.join('\n'))) { target.paragraphs.push(...content.paragraphs); bump(target.found, 'merged_cell_text') }
          target.nested.push(...content.nested)
          merge(target.found, content.found)
        } else {
          const cell: CellRecord = { id: `${rowId}:c:${column}`, row: index, column, rowSpan: 1, columnSpan, ...content }
          row.cells.push(cell)
          if (vertical !== null) next.set(column, cell)
        }
        column += columnSpan
      }
      open = next
      rows.push(row)
    }

    for (const row of rows) {
      const texts = row.cells.map(cell => this.canonical(cell.paragraphs.join('\n')))
      this.push({
        id: row.id, kind: 'table_row', text: texts.some(Boolean) ? this.canonical(texts.join(' | ')) : '',
        tableId, row: row.index, column: null, rowSpan: null, columnSpan: null, parentId, headingIds,
      })
      this.record(row.found, row.id)
      for (const [position, cell] of row.cells.entries()) {
        await this.control.pause()
        this.push({
          id: cell.id, kind: 'table_cell', text: texts[position]!, tableId, row: cell.row, column: cell.column,
          rowSpan: cell.rowSpan, columnSpan: cell.columnSpan, parentId: row.id, headingIds,
        })
        this.record(cell.found, cell.id)
        for (const nested of cell.nested) await this.table(nested, cell.id)
      }
    }
  }
}
