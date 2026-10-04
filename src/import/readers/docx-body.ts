/**
 * Storie di un documento WordprocessingML → blocchi sorgente, in ordine di documento. Una storia
 * è un flusso di paragrafi e tabelle: il corpo, un'intestazione, un piè di pagina, una nota, una
 * casella di testo. Ogni storia ha un prefisso di ID proprio; il corpo non ne ha.
 *
 * - Paragrafi `<prefisso>p:<n>`: n conta i paragrafi di primo livello della storia (vuoti compresi),
 *   da 1. Titoli dal livello di struttura o dagli stili Titolo/Heading; elementi di elenco dalla
 *   numerazione, con `parentId` verso l'elemento di livello superiore.
 * - Tabelle `<prefisso>t:<n>` numerate in ordine di documento (annidate comprese); righe
 *   `…t:n:r:<riga>` con il testo delle celle che vi originano separato da ` | `; celle
 *   `…t:n:r:<riga>:c:<colonna>` con coordinate logiche della griglia. Una cella unita esiste una
 *   sola volta, con rowSpan e columnSpan; le tabelle annidate hanno righe con `parentId` sulla cella.
 * - Caselle di testo `<prefisso>box:<n>:…`, lette come storie proprie subito dopo il blocco che le
 *   ancora (paragrafo o cella), che diventa il loro `parentId`; nessuna posizione di pagina.
 * - Testo dei run ricomposto senza perdere parole, spazi, tabulazioni e interruzioni, poi reso
 *   canonico e privato dei dati di contatto (`minimize.ts`). I risultati dei campi di pagina
 *   (PAGE, NUMPAGES…) non entrano: dipendono dall'impaginazione. Revisioni, testo nascosto e
 *   componenti non letti diventano constatazioni con riferimento ai blocchi: mai testo inserito ed
 *   eliminato concatenato.
 */
import { contractLimits } from '../contracts/schema.ts'
import { normalizeSourceText, type SourceBlock } from '../contracts/normalized-document.ts'
import { DocumentReaderError } from '../contracts/reader.ts'
import { attribute, integerAttribute, numberingOf, onOff, type ParagraphStyle, type StyleSheet } from './docx-styles.ts'
import { minimizeContactData } from './minimize.ts'
import type { Relationship } from './ooxml-package.ts'
import type { ReadControl } from './read-control.ts'
import { directText, elementChildren, firstChild, type XmlElement } from './xml.ts'

/** Elementi il cui testo serve al lettore delle storie. */
export const storyTextElements: ReadonlySet<string> = new Set(['w:t', 'w:delText', 'w:instrText', 'w:delInstrText', 'm:t'])

export const storyFindingKinds = [
  'tracked_changes', 'hidden_text', 'hidden_row', 'math', 'symbol', 'alt_chunk', 'merged_cell_text', 'table_structure', 'table_continuation',
  'contact_data', 'image', 'external_image', 'broken_image', 'embedded_object',
] as const
export type StoryFinding = typeof storyFindingKinds[number]

/** Voci d'inventario comuni a tutte le storie. */
export const TEXT_BOXES_ENTRY = 'docx:text-boxes'
export const IMAGES_ENTRY = 'docx:images'
export const OBJECTS_ENTRY = 'docx:embedded-objects'
const findingEntry: Partial<Record<StoryFinding, string>> = {
  image: IMAGES_ENTRY, external_image: IMAGES_ENTRY, broken_image: IMAGES_ENTRY, embedded_object: OBJECTS_ENTRY,
}

export interface FindingLog {
  /** Occorrenze, anche in paragrafi senza testo e quindi senza blocco. */
  count: number
  /** Blocchi interessati, in ordine e senza ripetizioni. */
  refs: string[]
  seen: Set<string>
}

/** `noteref`: campo NOTEREF (riferimento incrociato di Word a una nota), con il nome del segnalibro come id. */
export type NoteKind = 'footnote' | 'endnote' | 'comment' | 'noteref'
/** Richiamo di nota o commento, con il blocco che lo contiene (null se il paragrafo non ha testo). */
export interface NoteReference { kind: NoteKind; id: string; block: string | null }
/** Sezione del corpo: proprietà (null se assenti) e primo blocco prodotto dopo l'inizio della sezione. */
export interface SectionMark { properties: XmlElement | null; firstBlock: string | null }

/**
 * Esito di una storia di primo livello e delle sue caselle di testo: entra nel documento solo se
 * la storia è stata letta per intero, così una parte laterale danneggiata non lascia blocchi a metà.
 */
export class StorySink {
  readonly blocks: SourceBlock[] = []
  /** Constatazioni per voce d'inventario (la storia, le caselle di testo, immagini, oggetti). */
  readonly findings = new Map<string, Map<StoryFinding, FindingLog>>()
  /** Blocchi per voce d'inventario, in ordine. */
  readonly entryBlocks = new Map<string, string[]>()
  readonly references: NoteReference[] = []
  /** Segnalibro → nota richiamata al suo interno, per risolvere i campi NOTEREF. */
  readonly bookmarkNotes = new Map<string, { kind: 'footnote' | 'endnote'; id: string }>()
  readonly sections: SectionMark[] = []
}

export interface StoryContext {
  styles: StyleSheet
  control: ReadControl
  /** Blocchi delle storie già unite al documento, per il limite complessivo. */
  committedBlocks: number
}

export interface StoryOptions {
  /** Prefisso degli ID: '' per il corpo, `hdr:1:`, `fn:3:`, `box:2:`… */
  prefix: string
  /** Voce d'inventario dei blocchi e delle constatazioni della storia. */
  entry: string
  /** Relazioni della parte che contiene la storia (immagini, collegamenti). */
  relationships: Map<string, Relationship>
  sink: StorySink
  /** Genitore dei blocchi di primo livello (blocco d'ancoraggio o richiamo della nota). */
  rootParent?: string | null
  /** Titoli validi all'inizio della storia (caselle di testo del corpo). */
  headings?: { id: string; level: number }[]
  /** Solo per il corpo: registra le sezioni e il loro primo blocco. */
  trackSections?: boolean
}

/** Elementi di servizio senza testo visibile. */
const ignoredInline = new Set([
  'w:pPr', 'w:rPr', 'w:sdtPr', 'w:sdtEndPr', 'w:smartTagPr', 'w:customXmlPr', 'w:bookmarkStart', 'w:bookmarkEnd', 'w:proofErr',
  'w:permStart', 'w:permEnd', 'w:commentRangeStart', 'w:commentRangeEnd', 'w:moveFromRangeStart', 'w:moveFromRangeEnd',
  'w:moveToRangeStart', 'w:moveToRangeEnd', 'w:customXmlInsRangeStart', 'w:customXmlInsRangeEnd', 'w:customXmlDelRangeStart',
  'w:customXmlDelRangeEnd', 'w:customXmlMoveFromRangeStart', 'w:customXmlMoveFromRangeEnd', 'w:customXmlMoveToRangeStart',
  'w:customXmlMoveToRangeEnd', 'w:sectPr', 'w:tblPr', 'w:tblGrid', 'w:trPr', 'w:tcPr', 'w:tblPrEx',
])

/** Campi il cui risultato dipende dall'impaginazione: nessun numero di pagina fittizio. */
const pageFields = /^\s*(PAGE|NUMPAGES|SECTIONPAGES|PAGEREF)\b/i
/** Riferimento incrociato a una nota: il risultato è il numero calcolato della nota, non testo. */
const noteRefField = /^\s*NOTEREF\s+([^\s\\]{1,200})/i

interface Field { page: boolean; noteRef: string | null; instruction: string; result: boolean }

interface InlineContext {
  out: string[]
  found: Map<StoryFinding, number>
  style: ParagraphStyle
  /** Falso dentro il Fallback di mc:AlternateContent, già inventariato una volta. */
  scan: boolean
  notes: { kind: NoteKind; id: string }[]
  boxes: XmlElement[]
  /** Campi complessi aperti nel paragrafo. */
  fields: Field[]
  /** Dentro il risultato di un campo semplice di pagina. */
  pageField: boolean
}

interface CellContent { paragraphs: string[]; nested: XmlElement[]; found: Map<StoryFinding, number>; notes: InlineContext['notes']; boxes: XmlElement[] }
interface CellRecord extends CellContent { id: string; row: number; column: number; rowSpan: number; columnSpan: number }
interface RowRecord { id: string; index: number; cells: CellRecord[]; found: Map<StoryFinding, number> }

const bump = (found: Map<StoryFinding, number>, kind: StoryFinding, count = 1) => found.set(kind, (found.get(kind) ?? 0) + count)
const merge = (into: Map<StoryFinding, number>, from: Map<StoryFinding, number>) => from.forEach((count, kind) => bump(into, kind, count))
const noteIdPattern = /^-?\d{1,9}$/

/** Caselle di testo di primo livello in un elemento, in ordine di documento, senza scendere in una casella. */
function collectBoxes(element: XmlElement, into: XmlElement[]): void {
  if (element.name === 'w:txbxContent') { into.push(element); return }
  if (element.name === 'mc:AlternateContent') {
    // Una sola rappresentazione: il primo Choice che contiene caselle, altrimenti il Fallback.
    const branches = elementChildren(element)
    const withBoxes = (branch: XmlElement) => { const found: XmlElement[] = []; collectBoxes(branch, found); return found }
    for (const branch of branches) {
      if (branch.name !== 'mc:Choice') continue
      const found = withBoxes(branch)
      if (found.length) { into.push(...found); return }
    }
    const fallback = branches.find(branch => branch.name === 'mc:Fallback')
    if (fallback) into.push(...withBoxes(fallback))
    return
  }
  for (const child of elementChildren(element)) collectBoxes(child, into)
}

export class StoryReader {
  private readonly ctx: StoryContext
  private readonly styles: StyleSheet
  private readonly control: ReadControl
  private readonly prefix: string
  private readonly entry: string
  private readonly relationships: Map<string, Relationship>
  private readonly sink: StorySink
  private readonly rootParent: string | null
  private readonly trackSections: boolean
  private paragraphs = 0
  private tables = 0
  private boxCount = 0
  private headings: { id: string; level: number }[]
  private list: { id: string; level: number }[] = []
  private sectionFirst: string | null = null
  /** Segnalibri aperti (id → nome) nel punto di lettura corrente. */
  private readonly bookmarks = new Map<string, string>()

  constructor(ctx: StoryContext, options: StoryOptions) {
    this.ctx = ctx
    this.styles = ctx.styles
    this.control = ctx.control
    this.prefix = options.prefix
    this.entry = options.entry
    this.relationships = options.relationships
    this.sink = options.sink
    this.rootParent = options.rootParent ?? null
    this.headings = options.headings?.map(heading => ({ ...heading })) ?? []
    this.trackSections = options.trackSections ?? false
  }

  /** Corpo del documento principale, con le sezioni. */
  async readDocument(documentRoot: XmlElement): Promise<void> {
    if (documentRoot.name !== 'w:document') throw new DocumentReaderError('corrupt', 'Il documento principale non è un documento Word valido.')
    const body = firstChild(documentRoot, 'w:body')
    if (body) await this.container(body)
    if (this.trackSections) this.sink.sections.push({ properties: (body && firstChild(body, 'w:sectPr')) ?? null, firstBlock: this.sectionFirst })
  }

  // --- constatazioni ------------------------------------------------------------------------

  private record(found: Map<StoryFinding, number>, ref: string | null) {
    found.forEach((count, kind) => {
      const entry = findingEntry[kind] ?? this.entry
      let logs = this.sink.findings.get(entry)
      if (!logs) { logs = new Map(); this.sink.findings.set(entry, logs) }
      const log = logs.get(kind) ?? { count: 0, refs: [], seen: new Set<string>() }
      log.count += count
      if (ref !== null && !log.seen.has(ref)) { log.seen.add(ref); log.refs.push(ref) }
      logs.set(kind, log)
    })
  }

  private references(notes: InlineContext['notes'], block: string | null) {
    for (const note of notes) this.sink.references.push({ ...note, block })
  }

  // --- blocchi ------------------------------------------------------------------------------

  /** Testo canonico senza dati di contatto; `contacts` conta le sostituzioni. */
  private canonical(raw: string): { text: string; contacts: number } {
    const minimized = minimizeContactData(normalizeSourceText(raw))
    const text = minimized.text
    if (text.length > contractLimits.textChars) {
      const length = [...text].length
      if (length > contractLimits.textChars) throw new DocumentReaderError('limit_exceeded', 'Un paragrafo o una cella supera la lunghezza massima.', { limit: 'blockTextChars', max: contractLimits.textChars, actual: length })
    }
    return { text, contacts: minimized.replaced }
  }

  private push(block: Omit<SourceBlock, 'page' | 'origin' | 'bbox'>) {
    const total = this.ctx.committedBlocks + this.sink.blocks.length
    if (total >= contractLimits.largeItems) {
      throw new DocumentReaderError('limit_exceeded', 'Il documento contiene troppi blocchi di testo.', { limit: 'documentBlocks', max: contractLimits.largeItems, actual: total + 1 })
    }
    this.sink.blocks.push({ ...block, parentId: block.parentId ?? this.rootParent, page: null, origin: 'native', bbox: null })
    const ids = this.sink.entryBlocks.get(this.entry) ?? []
    ids.push(block.id)
    this.sink.entryBlocks.set(this.entry, ids)
    if (this.trackSections) this.sectionFirst ??= block.id
  }

  private headingIds() { return this.headings.map(heading => heading.id) }

  // --- contenitori di blocchi ---------------------------------------------------------------

  /** Paragrafi e tabelle di un contenitore (corpo, intestazione, nota, casella di testo). */
  async container(container: XmlElement): Promise<void> {
    // Tabella precedente separata solo da paragrafi vuoti: possibile tabella interrotta.
    let previousTable: { columns: number } | null = null
    for (const child of elementChildren(container)) {
      await this.control.pause()
      switch (child.name) {
        case 'w:p': if (!(await this.paragraph(child))) previousTable = null; break
        case 'w:tbl': {
          this.list = []
          const table = await this.table(child, null)
          if (previousTable && table.columns > 0 && table.columns === previousTable.columns && table.firstRow) {
            this.record(new Map([['table_continuation', 1]]), table.firstRow)
          }
          previousTable = table
          break
        }
        case 'w:sdt': { previousTable = null; const content = firstChild(child, 'w:sdtContent'); if (content) await this.container(content); break }
        case 'mc:AlternateContent': {
          previousTable = null
          const branch = firstChild(child, 'mc:Fallback') ?? firstChild(child, 'mc:Choice')
          if (branch) await this.container(branch)
          break
        }
        case 'w:altChunk': previousTable = null; this.record(new Map([['alt_chunk', 1]]), null); break
        case 'w:bookmarkStart': case 'w:bookmarkEnd': this.bookmark(child); break
        default: if (!ignoredInline.has(child.name)) { previousTable = null; await this.container(child) }
      }
    }
  }

  /** Segnalibri, anche a cavallo di più paragrafi: servono solo a risolvere i campi NOTEREF. */
  private bookmark(element: XmlElement) {
    const id = attribute(element, 'w:id')
    if (id === undefined) return
    if (element.name === 'w:bookmarkEnd') { this.bookmarks.delete(id); return }
    const name = attribute(element, 'w:name')
    if (name !== undefined && this.bookmarks.size < 1000) this.bookmarks.set(id, name)
  }

  private paragraphStyle(pPr: XmlElement | undefined): ParagraphStyle {
    return this.styles.paragraph(attribute(pPr && firstChild(pPr, 'w:pStyle')))
  }

  /** Testo grezzo di un paragrafo e constatazioni, senza creare blocchi. */
  private paragraphText(p: XmlElement, style: ParagraphStyle) {
    const context: InlineContext = { out: [], found: new Map(), style, scan: true, notes: [], boxes: [], fields: [], pageField: false }
    const pPr = firstChild(p, 'w:pPr')
    const markRPr = pPr && firstChild(pPr, 'w:rPr')
    if (markRPr && (firstChild(markRPr, 'w:ins') || firstChild(markRPr, 'w:del'))) bump(context.found, 'tracked_changes')
    this.inline(p, context)
    return { raw: context.out.join(''), found: context.found, notes: context.notes, boxes: context.boxes }
  }

  /** Vero se il paragrafo non contiene nulla: né testo, né caselle, né componenti o richiami. */
  private async paragraph(p: XmlElement): Promise<boolean> {
    const id = `${this.prefix}p:${++this.paragraphs}`
    const pPr = firstChild(p, 'w:pPr')
    const style = this.paragraphStyle(pPr)
    const { raw, found, notes, boxes } = this.paragraphText(p, style)
    const { text, contacts } = this.canonical(raw)
    const empty = !text && !boxes.length && !found.size && !notes.length
    let block: string | null = null

    if (text) {
      block = id
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
    }
    if (contacts) bump(found, 'contact_data', contacts)
    this.record(found, block)
    this.references(notes, block)
    for (const box of boxes) await this.textBox(box, block)
    const sectPr = this.trackSections && pPr ? firstChild(pPr, 'w:sectPr') : undefined
    if (sectPr) {
      this.sink.sections.push({ properties: sectPr, firstBlock: this.sectionFirst })
      this.sectionFirst = null
    }
    return empty
  }

  /** Casella di testo: storia propria, ancorata al blocco che la contiene. */
  private async textBox(content: XmlElement, anchor: string | null) {
    const reader = new StoryReader(this.ctx, {
      prefix: `${this.prefix}box:${++this.boxCount}:`,
      entry: TEXT_BOXES_ENTRY,
      relationships: this.relationships,
      sink: this.sink,
      rootParent: anchor ?? this.rootParent,
      headings: this.headings,
    })
    await reader.container(content)
  }

  // --- contenuto in linea -------------------------------------------------------------------

  private inline(element: XmlElement, context: InlineContext): void {
    for (const child of elementChildren(element)) {
      switch (child.name) {
        case 'w:r': this.run(child, context); break
        // Revisioni: il testo inserito resta, quello eliminato o spostato via non entra mai.
        // Il lettore rifiuta comunque il documento finché restano revisioni aperte.
        case 'w:ins': case 'w:moveTo': bump(context.found, 'tracked_changes'); this.inline(child, context); break
        case 'w:del': case 'w:moveFrom': bump(context.found, 'tracked_changes'); break
        case 'w:sdt': { const content = firstChild(child, 'w:sdtContent'); if (content) this.inline(content, context); break }
        case 'w:fldSimple': {
          const outer = context.pageField
          const instruction = attribute(child, 'w:instr') ?? ''
          const noteRef = noteRefField.exec(instruction)?.[1] ?? null
          if (pageFields.test(instruction) || noteRef !== null) context.pageField = true
          this.inline(child, context)
          context.pageField = outer
          if (noteRef !== null) context.notes.push({ kind: 'noteref', id: noteRef })
          break
        }
        case 'w:bookmarkStart': case 'w:bookmarkEnd': this.bookmark(child); break
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

  /** Vero dentro il risultato di un campo calcolato (pagina, numero di nota), il cui testo non entra nei blocchi. */
  private inPageField(context: InlineContext) {
    return context.pageField || context.fields.some(field => field.result && (field.page || field.noteRef !== null))
  }

  private runChild(child: XmlElement, hidden: boolean, context: InlineContext) {
    const emit = (text: string) => { if (!hidden && !this.inPageField(context)) context.out.push(text) }
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
      case 'w:fldChar': {
        const type = attribute(child, 'w:fldCharType')
        if (type === 'begin') context.fields.push({ page: false, noteRef: null, instruction: '', result: false })
        else if (type === 'separate') { const field = context.fields[context.fields.length - 1]; if (field) field.result = true }
        else if (type === 'end') {
          const field = context.fields.pop()
          if (field?.noteRef) context.notes.push({ kind: 'noteref', id: field.noteRef })
        }
        break
      }
      case 'w:instrText': {
        const field = context.fields[context.fields.length - 1]
        if (field && !field.result && field.instruction.length < 1000) {
          field.instruction += directText(child)
          field.page = pageFields.test(field.instruction)
          field.noteRef = noteRefField.exec(field.instruction)?.[1] ?? null
        }
        break
      }
      case 'w:footnoteReference': case 'w:endnoteReference': case 'w:commentReference': {
        const id = attribute(child, 'w:id')
        const kind: NoteKind = child.name === 'w:footnoteReference' ? 'footnote' : child.name === 'w:endnoteReference' ? 'endnote' : 'comment'
        if (id === undefined || !noteIdPattern.test(id)) break
        context.notes.push({ kind, id })
        if (kind !== 'comment') for (const name of this.bookmarks.values()) this.sink.bookmarkNotes.set(name, { kind: kind, id })
        break
      }
      case 'w:delText': case 'w:delInstrText': bump(context.found, 'tracked_changes'); break
      case 'w:drawing': case 'w:pict': case 'w:object': this.components(child, context); break
      case 'mc:AlternateContent': this.alternate(child, context, true, hidden); break
      case 'w:ruby': { const base = firstChild(child, 'w:rubyBase'); if (base) this.inline(base, context); break }
      default: break // proprietà, riferimenti a note/commenti, interruzioni di pagina calcolate
    }
  }

  /** Una sola constatazione per blocco alternativo; il testo viene dal Fallback, altrimenti dal primo Choice. */
  private alternate(element: XmlElement, context: InlineContext, inRun: boolean, hidden = false) {
    this.components(element, context)
    const branch = firstChild(element, 'mc:Fallback') ?? firstChild(element, 'mc:Choice')
    if (!branch) return
    const nested: InlineContext = { ...context, scan: false }
    if (inRun) for (const child of elementChildren(branch)) this.runChild(child, hidden, nested)
    else this.inline(branch, nested)
  }

  private imageKind(embed: string | undefined, linked: boolean): StoryFinding {
    if (linked) return 'external_image'
    const relationship = embed === undefined ? undefined : this.relationships.get(embed)
    if (!relationship) return 'broken_image'
    if (relationship.external) return 'external_image'
    return relationship.part === null ? 'broken_image' : 'image'
  }

  /** Inventario di disegni e oggetti (immagini, oggetti incorporati) e raccolta delle caselle di testo. */
  private components(element: XmlElement, context: InlineContext) {
    if (!context.scan) return
    const kinds = new Set<StoryFinding>()
    const stack = [element]
    while (stack.length) {
      const node = stack.pop()!
      switch (node.name) {
        case 'w:txbxContent': continue // letta come storia propria
        case 'w:object': case 'o:OLEObject': case 'c:chart': case 'dgm:relIds': kinds.add('embedded_object'); continue
        case 'a:blip': kinds.add(this.imageKind(node.attributes['r:embed'], node.attributes['r:link'] !== undefined)); break
        case 'v:imagedata': {
          const id = node.attributes['r:id'] ?? node.attributes['o:relid']
          kinds.add(id === undefined ? (node.attributes.src !== undefined ? 'external_image' : 'broken_image') : this.imageKind(id, false))
          break
        }
      }
      stack.push(...elementChildren(node))
    }
    kinds.forEach(kind => bump(context.found, kind))
    collectBoxes(element, context.boxes)
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

  private cellContent(container: XmlElement, cell: CellContent) {
    for (const child of elementChildren(container)) {
      switch (child.name) {
        case 'w:p': {
          const { raw, found, notes, boxes } = this.paragraphText(child, this.paragraphStyle(firstChild(child, 'w:pPr')))
          cell.paragraphs.push(raw)
          merge(cell.found, found)
          cell.notes.push(...notes)
          cell.boxes.push(...boxes)
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

  private async table(tbl: XmlElement, parentId: string | null): Promise<{ columns: number; firstRow: string | null }> {
    const tableId = `${this.prefix}t:${++this.tables}`
    const headingIds = this.headingIds()
    const grid = firstChild(tbl, 'w:tblGrid')
    const gridColumns = grid ? elementChildren(grid).filter(child => child.name === 'w:gridCol').length : 0
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
        const content: CellContent = { paragraphs: [], nested: [], found: new Map(), notes: [], boxes: [] }
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
          target.notes.push(...content.notes)
          target.boxes.push(...content.boxes)
          merge(target.found, content.found)
        } else {
          const cell: CellRecord = { id: `${rowId}:c:${column}`, row: index, column, rowSpan: 1, columnSpan, ...content }
          // Unione senza cella d'origine compatibile: cella propria, struttura da controllare.
          if (vertical === 'continue' || horizontal === 'continue') bump(cell.found, 'table_structure')
          row.cells.push(cell)
          if (vertical !== null) next.set(column, cell)
        }
        column += columnSpan
      }
      const width = column + Math.max(integerAttribute(trPr && firstChild(trPr, 'w:gridAfter')) ?? 0, 0)
      if (gridColumns > 0 && width !== gridColumns) bump(row.found, 'table_structure')
      open = next
      rows.push(row)
    }

    for (const row of rows) {
      const texts = row.cells.map(cell => this.canonical(cell.paragraphs.join('\n')))
      const joined = texts.map(item => item.text)
      this.push({
        id: row.id, kind: 'table_row', text: joined.some(Boolean) ? this.canonical(joined.join(' | ')).text : '',
        tableId, row: row.index, column: null, rowSpan: null, columnSpan: null, parentId, headingIds,
      })
      this.record(row.found, row.id)
      for (const [position, cell] of row.cells.entries()) {
        await this.control.pause()
        this.push({
          id: cell.id, kind: 'table_cell', text: joined[position]!, tableId, row: cell.row, column: cell.column,
          rowSpan: cell.rowSpan, columnSpan: cell.columnSpan, parentId: row.id, headingIds,
        })
        if (texts[position]!.contacts) bump(cell.found, 'contact_data', texts[position]!.contacts)
        this.record(cell.found, cell.id)
        this.references(cell.notes, cell.id)
        for (const box of cell.boxes) await this.textBox(box, cell.id)
        for (const nested of cell.nested) await this.table(nested, cell.id)
      }
    }
    return { columns: gridColumns, firstRow: rows[0]?.id ?? null }
  }
}
