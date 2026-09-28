/**
 * Ricostruzione geometrica deterministica delle pagine PDF (task 05): frammenti di testo con
 * coordinate → righe, segmenti, colonne, tabelle e paragrafi, con bbox normalizzate e problemi di
 * lettura per pagina. Modulo puro: nessuna dipendenza da PDF.js, testato direttamente.
 *
 * Layout supportati:
 * - testo a una colonna, con titoli (corpo ≥ 1,2 volte il testo ordinario), elementi di elenco
 *   (marcatore iniziale) e paragrafi su più righe, in ordine visivo anche se il PDF li disegna in
 *   un altro ordine;
 * - tabelle con colonne allineate a sinistra (inizi dei segmenti raggruppati): righe `table_row`
 *   e celle `table_cell` con coordinate logiche; celle che si toccano separate solo se l'inizio
 *   della colonna è confermato da altre righe (con avviso);
 * - due colonne di testo (spazio vuoto verticale fra le colonne): colonna sinistra poi destra;
 *   elenchi affiancati riga per riga diventano una tabella a due colonne, così ogni valore resta
 *   nella propria colonna;
 * - pagine ruotate: il testo è letto nella direzione prevalente, le bbox restano quelle della
 *   pagina visualizzata.
 * Quando la geometria non basta (colonne ambigue, testo in altra direzione, sovrapposizioni,
 * numeri fuori riga) i frammenti restano blocchi separati e la pagina ha un avviso: mai colonne
 * fuse presentate come lettura sicura. Nessun OCR: pagine senza testo o con immagini estese senza
 * testo sono segnalate come da leggere a vista.
 */
import { contractLimits } from '../contracts/schema.ts'
import { normalizeSourceText, type ReadingIssue, type SourceBlock } from '../contracts/normalized-document.ts'
import type { ReaderInventoryEntry } from '../contracts/reader.ts'
import { DocumentReaderError } from '../contracts/reader.ts'
import { minimizeContactData, CONTACT_MINIMIZATION_VERSION } from './minimize.ts'

/** Frammento di testo nella pagina visualizzata: origine in alto a sinistra, unità della viewport. */
export interface LayoutItem {
  text: string
  /** Inizio della linea di base. */
  x: number
  y: number
  /** Lunghezza lungo la direzione del testo. */
  width: number
  /** Corpo del carattere. */
  size: number
  /** Direzione del testo in radianti (0 = da sinistra a destra, asse y verso il basso). */
  angle: number
}

/** Rettangolo di un'immagine disegnata nella pagina visualizzata. */
export interface LayoutImage { x0: number; y0: number; x1: number; y1: number }

export interface PageInput {
  page: number
  width: number
  height: number
  items: LayoutItem[]
  images: LayoutImage[]
  /** Operazioni di testo con modalità invisibile (Tr 3 o 7), tipiche di un OCR fatto da altri. */
  invisibleText: number
  /** Annotazioni o campi modulo con testo, non letti. */
  annotations: number
  /**
   * Qualcosa è disegnato (testo, immagini, tracciati). Una pagina senza alcun segno è vuota oppure
   * ha un contenuto danneggiato che PDF.js ha scartato: i due casi non sono distinguibili.
   */
  drawn: boolean
}

/** Pagina che non è stato possibile interpretare: resta nell'inventario come non letta. */
export interface DamagedPage { page: number; damaged: true }

// --- soglie, tutte relative al corpo del carattere (em) o alla pagina -------------------------

const LINE_TOLERANCE = 0.35
const JOIN_WITHOUT_SPACE = 0.15
const COLUMN_GAP = 0.9
const ALIGN_TOLERANCE = 0.3
const COLUMN_CLUSTER = 1.0
const GUTTER_MIN = 0.02
/** Segmenti più larghi di questa frazione della pagina attraversano le colonne (titoli, note a tutta pagina). */
const WIDE_SEGMENT = 0.45
/** Una riga di prosa ha almeno questi caratteri e riempie buona parte della colonna. */
const PROSE_CHARS = 18
const IMAGE_AREA = 0.1
const IMAGE_TEXT_CHARS = 20
const ANGLE_SNAP = (3 * Math.PI) / 180

const listMarker = /^([•◦▪▫‣∙·*]|[-–—](?=\s)|\d{1,2}[.)](?=\s)|[a-z][.)](?=\s))/
const numericOnly = /^[\d\s.,:;/'"′″×x%+–-]+$/
/** Caratteri che indicano un'estrazione anomala: controlli, sostituzione, area privata. */
const suspicious = /[\u0000-\u0008\u000B\u000C\u000E-\u001F�-]|[\u{F0000}-\u{10FFFF}]/gu

export const PDF_BLOCK_ID = (page: number) => `pdf:${page}:`

/**
 * Codici dei readingIssues del reader PDF. `partial`: una parte della pagina non è letta come
 * testo; `info`: tutto è letto, ma ordine o associazioni vanno verificati.
 */
export const pdfReadingIssueCodes = {
  no_text_layer: 'partial',
  empty_page: 'partial',
  image_without_text: 'partial',
  unreadable_text: 'partial',
  hidden_text: 'partial',
  component_not_read: 'partial',
  damaged_page: 'partial',
  reading_order_uncertain: 'info',
  misaligned_numbers: 'info',
  overlapping_text: 'info',
  contact_data_removed: 'info',
} as const
type IssueCode = keyof typeof pdfReadingIssueCodes

// --- geometria nel riferimento di lettura ------------------------------------------------------

interface Box { x0: number; x1: number; top: number; bottom: number }
interface Item extends Box { text: string; baseline: number; size: number; order: number }
interface Segment extends Box { text: string; baseline: number; size: number; items: Item[]; line: number }
interface Line { baseline: number; size: number; segments: Segment[]; index: number }

/** Rotazione dal riferimento della pagina a quello di lettura (testo orizzontale). */
class Frame {
  readonly width: number
  readonly height: number
  private readonly cos: number
  private readonly sin: number
  private readonly dx: number
  private readonly dy: number
  private readonly pageWidth: number
  private readonly pageHeight: number

  constructor(width: number, height: number, angle: number) {
    this.pageWidth = width
    this.pageHeight = height
    this.cos = Math.round(Math.cos(angle) * 1e12) / 1e12
    this.sin = Math.round(Math.sin(angle) * 1e12) / 1e12
    const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => this.rotate(x!, y!))
    this.dx = -Math.min(...corners.map(([x]) => x))
    this.dy = -Math.min(...corners.map(([, y]) => y))
    this.width = Math.max(...corners.map(([x]) => x)) + this.dx
    this.height = Math.max(...corners.map(([, y]) => y)) + this.dy
  }

  private rotate(x: number, y: number): [number, number] { return [x * this.cos + y * this.sin, -x * this.sin + y * this.cos] }
  toFrame(x: number, y: number): [number, number] { const [rx, ry] = this.rotate(x, y); return [rx + this.dx, ry + this.dy] }
  fromFrame(x: number, y: number): [number, number] {
    const fx = x - this.dx, fy = y - this.dy
    return [fx * this.cos - fy * this.sin, fx * this.sin + fy * this.cos]
  }

  /** Riquadro nel riferimento di lettura → bbox normalizzata della pagina visualizzata. */
  bbox(box: Box): [number, number, number, number] {
    const points = [[box.x0, box.top], [box.x1, box.top], [box.x0, box.bottom], [box.x1, box.bottom]].map(([x, y]) => this.fromFrame(x!, y!))
    const clamp = (value: number) => Math.min(Math.max(value, 0), 1)
    const x0 = clamp(Math.min(...points.map(([x]) => x)) / this.pageWidth)
    const y0 = clamp(Math.min(...points.map(([, y]) => y)) / this.pageHeight)
    const x1 = clamp(Math.max(...points.map(([x]) => x)) / this.pageWidth)
    const y1 = clamp(Math.max(...points.map(([, y]) => y)) / this.pageHeight)
    const round = (value: number) => Math.round(value * 1e4) / 1e4
    const x = round(x0), y = round(y0)
    return [x, y, Math.max(0, Math.min(round(x1 - x0), 1 - x)), Math.max(0, Math.min(round(y1 - y0), 1 - y))]
  }
}

const union = (boxes: Box[]): Box => ({
  x0: Math.min(...boxes.map(box => box.x0)), x1: Math.max(...boxes.map(box => box.x1)),
  top: Math.min(...boxes.map(box => box.top)), bottom: Math.max(...boxes.map(box => box.bottom)),
})
const snapAngle = (angle: number) => {
  const quarter = Math.round(angle / (Math.PI / 2))
  return Math.abs(angle - quarter * (Math.PI / 2)) <= ANGLE_SNAP ? ((quarter % 4) + 4) % 4 : null
}
const suspiciousCount = (text: string) => text.match(suspicious)?.length ?? 0
const visibleLength = (text: string) => text.replace(/\s/g, '').length

// --- risultato intermedio della pagina -------------------------------------------------------

type Unit =
  | { type: 'text'; lines: Line[]; kind: 'paragraph' | 'list_item'; indent: number }
  | { type: 'table'; rows: TableRow[]; columns: number }
  | { type: 'loose'; segment: Segment }

/** Cella di tabella: segmento e colonne logiche che occupa (più di una se il testo attraversa l'inizio di una colonna). */
interface TableCell { segment: Segment; span: number }
interface TableRow { cells: (TableCell | null)[]; line: Line }

interface PageFinding { code: IssueCode; message: string; refs: Box[] }

export interface PageLayout {
  page: number
  frame: Frame
  units: Unit[]
  findings: PageFinding[]
  /** Frammenti letti come testo (dopo la pulizia), per distinguere pagine senza testo. */
  textItems: number
  unreadableItems: number
}

// --- analisi di una pagina --------------------------------------------------------------------

export function layoutPage(input: PageInput): PageLayout {
  const findings: PageFinding[] = []
  const add = (code: IssueCode, message: string, refs: Box[] = []) => findings.push({ code, message, refs })
  const pageArea = input.width * input.height
  const label = `Pagina ${input.page}`

  // Frammenti con testo; quelli illeggibili (font senza mappa Unicode) sono contati e mai letti.
  let unreadableItems = 0
  let suspiciousChars = 0
  const candidates = input.items.filter(item => {
    const chars = visibleLength(item.text)
    if (!chars) return false
    const bad = suspiciousCount(item.text)
    if (bad * 2 >= chars) { unreadableItems++; return false }
    suspiciousChars += bad
    return Number.isFinite(item.x + item.y + item.width + item.size + item.angle) && item.size > 0
  })

  // Direzione prevalente, pesata sui caratteri; il resto è testo in altra direzione.
  const weights = new Map<number, number>()
  for (const item of candidates) {
    const quarter = snapAngle(item.angle)
    if (quarter !== null) weights.set(quarter, (weights.get(quarter) ?? 0) + visibleLength(item.text))
  }
  const dominant = [...weights].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0
  const frame = new Frame(input.width, input.height, dominant * (Math.PI / 2))
  const offAxis: Item[] = []
  const items: Item[] = []
  candidates.forEach((item, order) => {
    const [x, y] = frame.toFrame(item.x, item.y)
    const quarter = snapAngle(item.angle)
    const target = quarter === dominant ? items : offAxis
    if (quarter !== dominant) {
      // Riquadro approssimato del frammento ruotato, nel riferimento di lettura.
      const [ex, ey] = frame.toFrame(item.x + Math.cos(item.angle) * item.width, item.y + Math.sin(item.angle) * item.width)
      target.push({ text: item.text, baseline: y, size: item.size, order, x0: Math.min(x, ex) - item.size * 0.2, x1: Math.max(x, ex) + item.size * 0.2, top: Math.min(y, ey) - item.size, bottom: Math.max(y, ey) + item.size * 0.2 })
    } else {
      target.push({ text: item.text, baseline: y, size: item.size, order, x0: x, x1: x + Math.max(item.width, 0), top: y - item.size * 0.8, bottom: y + item.size * 0.2 })
    }
  })

  // Stesso testo nella stessa posizione (grassetto simulato): una sola volta.
  const unique: Item[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const key = `${item.text}\u0000${Math.round(item.x0 / (item.size * 0.1))}\u0000${Math.round(item.baseline / (item.size * 0.1))}`
    if (!seen.has(key)) { seen.add(key); unique.push(item) }
  }

  // Righe: frammenti con la stessa linea di base, in ordine visivo.
  unique.sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0 || a.order - b.order)
  const rawLines: Item[][] = []
  for (const item of unique) {
    const line = rawLines.find(candidate => Math.abs(candidate[0]!.baseline - item.baseline) <= LINE_TOLERANCE * Math.min(candidate[0]!.size, item.size))
    if (line) line.push(item)
    else rawLines.push([item])
  }
  const lines: Line[] = rawLines
    .map(line => line.sort((a, b) => a.x0 - b.x0 || a.order - b.order))
    .sort((a, b) => a[0]!.baseline - b[0]!.baseline)
    .map((line, index) => ({ baseline: line[0]!.baseline, size: Math.max(...line.map(item => item.size)), segments: segmentsOf(line, index), index }))

  // Sovrapposizioni: frammenti diversi che occupano lo stesso spazio.
  const overlaps: Box[] = []
  for (const line of lines) {
    for (const segment of line.segments) {
      for (let index = 1; index < segment.items.length; index++) {
        const previous = segment.items[index - 1]!, current = segment.items[index]!
        if (current.x0 < previous.x1 - 0.3 * Math.max(previous.size, current.size) && current.text !== previous.text) overlaps.push(previous, current)
      }
    }
  }
  if (overlaps.length) add('overlapping_text', `${label}: testo sovrapposto (${overlaps.length / 2}): l’ordine delle parole può essere errato, controlla la pagina originale.`, overlaps)

  // Colonne senza spazio: separazione confermata dagli inizi di colonna di altre righe.
  const splits = splitTouchingColumns(lines)
  if (splits.length) add('reading_order_uncertain', `${label}: colonne senza spazio fra loro (${splits.length}) separate in base all’allineamento delle altre righe: verifica che ogni valore sia nella colonna giusta.`, splits)

  // Numeri fuori riga: riga di soli numeri troppo vicina a un'altra riga per esserne distinta.
  const misaligned: Box[] = []
  lines.forEach((line, index) => {
    if (!line.segments.every(segment => numericOnly.test(segment.text))) return
    for (const neighbour of [lines[index - 1], lines[index + 1]]) {
      if (!neighbour) continue
      const distance = Math.abs(neighbour.baseline - line.baseline)
      const size = Math.min(neighbour.size, line.size)
      if (distance > LINE_TOLERANCE * size && distance < 0.9 * size) { misaligned.push(...line.segments); break }
    }
  })
  if (misaligned.length) add('misaligned_numbers', `${label}: numeri non allineati alla riga del testo (${misaligned.length}): potrebbero riferirsi alla riga sopra o sotto, verifica la pagina originale.`, misaligned)

  const units = arrange(lines, frame, label, add)
  for (const item of offAxis) units.push({ type: 'loose', segment: { ...item, items: [item], line: -1 } })
  if (offAxis.length) add('reading_order_uncertain', `${label}: testo in un’altra direzione (${offAxis.length}): letto a parte, fuori dall’ordine della pagina.`, offAxis)

  // Qualità: immagini estese senza testo, testo invisibile, caratteri illeggibili, annotazioni.
  const textItems = unique.length + offAxis.length
  for (const picture of textItems ? input.images : []) {
    const area = Math.max(0, picture.x1 - picture.x0) * Math.max(0, picture.y1 - picture.y0)
    if (area < IMAGE_AREA * pageArea) continue
    const inside = input.items.filter(item => item.x >= picture.x0 && item.x <= picture.x1 && item.y >= picture.y0 && item.y <= picture.y1)
      .reduce((total, item) => total + visibleLength(item.text), 0)
    if (inside >= IMAGE_TEXT_CHARS) continue
    const percent = Math.round((area / pageArea) * 100)
    add('image_without_text', `${label}: immagine senza testo leggibile (circa ${percent}% della pagina): può contenere indicazioni, come una tabella fotografata, da leggere a vista.`)
  }
  if (input.invisibleText) add('hidden_text', `${label}: testo invisibile sovrapposto (${input.invisibleText}), tipico di un riconoscimento del testo fatto da altri programmi: incluso nella lettura ma non verificato.`)
  if (unreadableItems || suspiciousChars) {
    add('unreadable_text', `${label}: testo con caratteri non riconoscibili (${unreadableItems} frammenti esclusi${suspiciousChars ? `, ${suspiciousChars} caratteri dubbi` : ''}), tipico di un font senza mappa Unicode: controlla la pagina originale.`)
  }
  if (input.annotations) add('component_not_read', `${label}: annotazioni o campi modulo con testo (${input.annotations}) non letti.`)
  if (!textItems && !input.drawn && !unreadableItems) {
    add('empty_page', `${label}: nessun contenuto visibile: la pagina è vuota oppure il suo contenuto è danneggiato. Controlla la pagina nel documento originale.`)
  } else if (!textItems) {
    const largest = Math.max(0, ...input.images.map(picture => (picture.x1 - picture.x0) * (picture.y1 - picture.y0) / pageArea))
    const scan = largest >= 0.8 ? ' (immagine a pagina intera: probabile scansione)' : largest >= IMAGE_AREA ? ' (contiene un’immagine estesa)' : input.images.length ? '' : ' (solo grafica: il testo potrebbe essere disegnato come tracciati)'
    add('no_text_layer', `${label}: nessun testo ${unreadableItems ? 'leggibile' : 'estraibile'}${scan}. Serve la lettura da immagine, non disponibile in questa versione: la pagina resta esclusa dall’analisi.`)
  }
  return { page: input.page, frame, units, findings, textItems, unreadableItems }
}

/** Frammenti di una riga → segmenti separati da spazi ampi (possibili colonne). */
function segmentsOf(line: Item[], lineIndex: number): Segment[] {
  const segments: Segment[] = []
  for (const item of line) {
    const last = segments[segments.length - 1]
    const previous = last?.items[last.items.length - 1]
    const em = previous ? Math.max(previous.size, item.size) : item.size
    const gap = previous ? item.x0 - previous.x1 : Number.POSITIVE_INFINITY
    if (last && previous && gap <= COLUMN_GAP * em) {
      const space = gap > JOIN_WITHOUT_SPACE * em && !/\s$/.test(last.text) && !/^\s/.test(item.text) ? ' ' : ''
      last.text += space + item.text
      last.items.push(item)
      last.x1 = Math.max(last.x1, item.x1)
      last.top = Math.min(last.top, item.top)
      last.bottom = Math.max(last.bottom, item.bottom)
      last.size = Math.max(last.size, item.size)
    } else {
      segments.push({ text: item.text, baseline: item.baseline, size: item.size, items: [item], line: lineIndex, x0: item.x0, x1: item.x1, top: item.top, bottom: item.bottom })
    }
  }
  return segments
}

/**
 * Un frammento attaccato al precedente ma che inizia dove altre due righe iniziano una colonna è
 * l'inizio di una colonna: il segmento viene diviso lì.
 */
function splitTouchingColumns(lines: Line[]): Box[] {
  const starts = lines.map(line => line.segments.slice(1).map(segment => segment.x0))
  const splits: Box[] = []
  lines.forEach((line, lineIndex) => {
    const result: Segment[] = []
    for (const segment of line.segments) {
      let current: Item[] = []
      const flush = () => { if (current.length) result.push(rebuild(current, lineIndex)) }
      segment.items.forEach((item, index) => {
        if (index > 0) {
          const tolerance = ALIGN_TOLERANCE * item.size
          const confirmations = starts.filter((xs, other) => other !== lineIndex && xs.some(x => Math.abs(x - item.x0) <= tolerance)).length
          if (confirmations >= 2) { flush(); current = []; splits.push(item) }
        }
        current.push(item)
      })
      flush()
    }
    line.segments = result
  })
  return splits
}

function rebuild(items: Item[], lineIndex: number): Segment {
  return segmentsOf(items, lineIndex).reduce((joined, segment) => {
    if (joined === null) return segment
    joined.text += ' ' + segment.text
    joined.items.push(...segment.items)
    Object.assign(joined, { x1: Math.max(joined.x1, segment.x1), top: Math.min(joined.top, segment.top), bottom: Math.max(joined.bottom, segment.bottom), size: Math.max(joined.size, segment.size) })
    return joined
  }, null as Segment | null)!
}

// --- ordine di lettura: colonne di testo, tabelle, paragrafi ---------------------------------

type AddFinding = (code: IssueCode, message: string, refs?: Box[]) => void

function arrange(lines: Line[], frame: Frame, label: string, add: AddFinding): Unit[] {
  const gutter = findGutter(lines, frame)
  const flowUnits = (flow: Line[]) => flowOf(flow, label, add)
  if (!gutter) return flowUnits(lines)

  // Zone separate dai segmenti che attraversano lo spazio fra le colonne.
  const crosses = (segment: Segment) => segment.x0 < gutter.end && segment.x1 > gutter.start
  const units: Unit[] = []
  let zone: Line[] = []
  const flushZone = () => {
    if (!zone.length) return
    const left: Line[] = [], right: Line[] = []
    let aligned = 0, rightLines = 0, prose = 0, total = 0
    for (const line of zone) {
      const l = line.segments.filter(segment => segment.x1 <= gutter.start)
      const r = line.segments.filter(segment => segment.x0 >= gutter.end)
      if (l.length) left.push({ ...line, segments: l })
      if (r.length) { right.push({ ...line, segments: r }); rightLines++; if (l.length) aligned++ }
      for (const segment of [...l, ...r]) {
        total++
        const width = segment.x0 >= gutter.end ? gutter.rightEdge - gutter.end : gutter.start - gutter.leftEdge
        if (visibleLength(segment.text) >= PROSE_CHARS && segment.x1 - segment.x0 >= 0.5 * width) prose++
      }
    }
    const alignedRatio = rightLines ? aligned / rightLines : 0
    const isProse = total > 0 && prose * 2 >= total
    if (!isProse && alignedRatio >= 0.7) units.push(...flowUnits(zone))
    else {
      if (!isProse && alignedRatio > 0.3) {
        add('reading_order_uncertain', `${label}: due colonne solo in parte allineate: lette una colonna dopo l’altra, controlla che righe affiancate non vadano lette insieme.`, zone.flatMap(line => line.segments))
      }
      units.push(...flowUnits(left), ...flowUnits(right))
    }
    zone = []
  }
  for (const line of lines) {
    if (line.segments.some(crosses)) { flushZone(); units.push(...flowUnits([line])) }
    else zone.push(line)
  }
  flushZone()
  return units
}

interface Gutter { start: number; end: number; leftEdge: number; rightEdge: number }

/** Spazio verticale vuoto fra due colonne di testo, con almeno tre segmenti per lato. */
function findGutter(lines: Line[], frame: Frame): Gutter | null {
  const segments = lines.flatMap(line => line.segments).filter(segment => segment.x1 - segment.x0 < WIDE_SEGMENT * frame.width)
  if (segments.length < 6) return null
  const bins = 400
  const covered = new Uint8Array(bins)
  for (const segment of segments) {
    const from = Math.max(0, Math.floor((segment.x0 / frame.width) * bins))
    const to = Math.min(bins - 1, Math.ceil((segment.x1 / frame.width) * bins))
    for (let bin = from; bin <= to; bin++) covered[bin] = 1
  }
  let best: { from: number; to: number } | null = null
  for (let bin = Math.floor(bins * 0.25); bin < bins * 0.75; bin++) {
    if (covered[bin]) continue
    let end = bin
    while (end + 1 < bins * 0.75 && !covered[end + 1]) end++
    if (!best || end - bin > best.to - best.from) best = { from: bin, to: end }
    bin = end
  }
  if (!best || (best.to - best.from + 1) / bins < GUTTER_MIN) return null
  const start = (best.from / bins) * frame.width
  const end = ((best.to + 1) / bins) * frame.width
  const left = segments.filter(segment => segment.x1 <= start)
  const right = segments.filter(segment => segment.x0 >= end)
  if (left.length < 3 || right.length < 3) return null
  // Le due colonne devono condividere un tratto verticale, non essere una sopra l'altra.
  const overlap = Math.min(Math.max(...left.map(s => s.bottom)), Math.max(...right.map(s => s.bottom))) - Math.max(Math.min(...left.map(s => s.top)), Math.min(...right.map(s => s.top)))
  if (overlap <= 0) return null
  return { start, end, leftEdge: Math.min(...left.map(s => s.x0)), rightEdge: Math.max(...right.map(s => s.x1)) }
}

/** Flusso di righe di una colonna: tabelle dove più segmenti si allineano, altrimenti paragrafi. */
function flowOf(lines: Line[], label: string, add: AddFinding): Unit[] {
  const units: Unit[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.segments.length >= 2) {
      const run = tableRun(lines, index)
      if (!run) {
        // Nessuna struttura coerente: segmenti come blocchi separati, mai fusi.
        for (const segment of line.segments) units.push({ type: 'loose', segment })
        add('reading_order_uncertain', `${label}: riga con parti distanziate che non formano colonne regolari: lette come blocchi separati, verifica a cosa si riferiscono.`, line.segments)
        index++
        continue
      }
      units.push(run.unit)
      const spanning = run.unit.rows.flatMap(row => row.cells.filter((cell): cell is TableCell => cell !== null && cell.span > 1).map(cell => cell.segment))
      if (spanning.length) add('reading_order_uncertain', `${label}: celle di tabella il cui testo occupa più colonne (${spanning.length}): potrebbero unire valori di colonne diverse, verifica la pagina originale.`, spanning)
      index = run.next
      continue
    }
    units.push(...textUnits(line))
    index++
  }
  return mergeParagraphs(units)
}

/**
 * Colonne dagli inizi dei segmenti, raggruppati entro un em. Un inizio vale come colonna solo se
 * le righe che lo usano sono più di quelle con un segmento che lo attraversa: testo allineato a
 * destra o celle unite non creano colonne spurie.
 */
function columnStarts(rows: Line[]): number[] {
  const starts = rows.flatMap(row => row.segments.map(segment => ({ x: segment.x0, size: segment.size }))).sort((a, b) => a.x - b.x)
  const clusters: { x: number; size: number }[] = []
  let last = Number.NEGATIVE_INFINITY
  for (const start of starts) {
    if (start.x - last > COLUMN_CLUSTER * start.size) clusters.push({ ...start })
    last = start.x
  }
  return clusters.filter(({ x, size }) => {
    const tolerance = COLUMN_CLUSTER * size
    const support = rows.filter(row => row.segments.some(segment => Math.abs(segment.x0 - x) <= tolerance)).length
    const crossing = rows.filter(row => row.segments.some(segment => segment.x0 < x - tolerance && segment.x1 > x + 0.2 * segment.size)).length
    return support > crossing
  }).map(cluster => cluster.x)
}

/**
 * Righe → celle. Un segmento che oltrepassa l'inizio della colonna successiva occupa più colonne
 * (può unire valori di colonne diverse: avviso); null se due segmenti cadono nella stessa colonna.
 */
function assign(rows: Line[], columns: number[]): TableRow[] | null {
  const result: TableRow[] = []
  for (const row of rows) {
    const cells: (TableCell | null)[] = columns.map(() => null)
    const taken = columns.map(() => false)
    for (const segment of row.segments) {
      let column = -1
      for (let index = columns.length - 1; index >= 0; index--) {
        if (segment.x0 >= columns[index]! - COLUMN_CLUSTER * segment.size) { column = index; break }
      }
      if (column < 0) return null
      let last = column
      while (last + 1 < columns.length && segment.x1 > columns[last + 1]! + 0.2 * segment.size) last++
      for (let index = column; index <= last; index++) { if (taken[index]) return null; taken[index] = true }
      cells[column] = { segment, span: last - column + 1 }
    }
    result.push({ cells, line: row })
  }
  return result
}

/** Righe consecutive con più segmenti allineati; una riga con un solo segmento fuori dalla prima colonna resta nella tabella. */
function tableRun(lines: Line[], from: number): { unit: Extract<Unit, { type: 'table' }>; next: number } | null {
  let rows = [lines[from]!]
  let columns = columnStarts(rows)
  let assigned = assign(rows, columns)
  if (!assigned || columns.length < 2) return null
  let next = from + 1
  while (next < lines.length) {
    const candidate = lines[next]!
    const previous = rows[rows.length - 1]!
    if (candidate.baseline - previous.baseline > 2.2 * Math.max(candidate.size, previous.size)) break
    const trial = [...rows, candidate]
    const trialColumns = columnStarts(trial)
    const trialAssigned = assign(trial, trialColumns)
    if (!trialAssigned || trialColumns.length < 2) break
    const single = candidate.segments.length === 1
    if (single && (trialAssigned[trialAssigned.length - 1]!.cells[0] !== null || trialColumns.length !== columns.length)) break
    rows = trial
    columns = trialColumns
    assigned = trialAssigned
    next++
  }
  return { unit: { type: 'table', rows: assigned, columns: columns.length }, next }
}

function textUnits(line: Line): Unit[] {
  const segment = line.segments[0]!
  return [{ type: 'text', lines: [line], kind: listMarker.test(segment.text.trimStart()) ? 'list_item' : 'paragraph', indent: segment.x0 }]
}

/** Righe consecutive dello stesso paragrafo: stesso corpo, interlinea regolare, stesso rientro. */
function mergeParagraphs(units: Unit[]): Unit[] {
  const result: Unit[] = []
  for (const unit of units) {
    const previous = result[result.length - 1]
    if (unit.type === 'text' && unit.kind === 'paragraph' && previous?.type === 'text') {
      const last = previous.lines[previous.lines.length - 1]!
      const line = unit.lines[0]!
      const size = Math.max(last.size, line.size)
      const sameSize = Math.abs(last.size - line.size) <= 0.1 * size
      const spacing = line.segments[0]!.baseline - last.segments[0]!.baseline
      const segment = line.segments[0]!
      const indentOk = previous.kind === 'list_item' ? segment.x0 > previous.indent : Math.abs(segment.x0 - previous.indent) <= 1.5 * size
      if (sameSize && spacing > 0 && spacing <= 1.6 * size && indentOk) { previous.lines.push(line); continue }
    }
    result.push(unit)
  }
  return result
}

// --- documento: ID, titoli, blocchi, problemi, inventario -----------------------------------

export interface AssembledPdf {
  blocks: SourceBlock[]
  readingIssues: ReadingIssue[]
  inventory: ReaderInventoryEntry[]
}

/** Blocchi e problemi di tutte le pagine, con titoli riconosciuti sul corpo prevalente del documento. */
export function assembleDocument(pages: (PageLayout | DamagedPage)[]): AssembledPdf {
  const layouts = pages.filter((page): page is PageLayout => 'units' in page)
  // Corpo del testo ordinario: il corpo con più caratteri nel documento (a parità, il minore).
  const weights = new Map<number, number>()
  const count = (segment: Segment) => { const size = Math.round(segment.size * 10) / 10; weights.set(size, (weights.get(size) ?? 0) + visibleLength(segment.text)) }
  for (const layout of layouts) {
    for (const unit of layout.units) {
      if (unit.type === 'text') unit.lines.forEach(line => line.segments.forEach(count))
      else if (unit.type === 'table') unit.rows.forEach(row => row.cells.forEach(cell => { if (cell) count(cell.segment) }))
      else count(unit.segment)
    }
  }
  const body = [...weights].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? 0
  const isHeading = (unit: Unit) => unit.type === 'text' && unit.kind === 'paragraph' && unit.lines.every(line => line.size >= 1.2 * body)
    && visibleLength(unit.lines.map(line => line.segments[0]!.text).join('')) <= 150
  const headingSizes = [...new Set(layouts.flatMap(layout => layout.units.filter(isHeading).map(unit => Math.round((unit as Extract<Unit, { type: 'text' }>).lines[0]!.size * 10) / 10)))].sort((a, b) => b - a)

  const blocks: SourceBlock[] = []
  const readingIssues: ReadingIssue[] = []
  const inventory: ReaderInventoryEntry[] = []
  const headings: { id: string; level: number }[] = []
  let contacts: string[] = []
  let contactCount = 0

  const canonical = (raw: string): { text: string; contacts: number } => {
    const minimized = minimizeContactData(normalizeSourceText(raw))
    if ([...minimized.text].length > contractLimits.textChars) throw new DocumentReaderError('limit_exceeded', 'Un blocco di testo supera la lunghezza massima.', { limit: 'blockTextChars', max: contractLimits.textChars, actual: [...minimized.text].length })
    return { text: minimized.text, contacts: minimized.replaced }
  }
  const push = (item: SourceBlock, found: number) => {
    if (blocks.length >= contractLimits.largeItems) throw new DocumentReaderError('limit_exceeded', 'Il documento contiene troppi blocchi di testo.', { limit: 'documentBlocks', max: contractLimits.largeItems, actual: blocks.length + 1 })
    blocks.push(item)
    if (found) { contacts.push(item.id); contactCount += found }
  }

  for (const page of pages) {
    if (!('units' in page)) {
      readingIssues.push({ code: 'damaged_page', sourceRefs: [], message: `Pagina ${page.page}: contenuto danneggiato, non letto. Controlla la pagina nel documento originale.` })
      inventory.push({ id: `pdf:page:${page.page}`, kind: 'page', page: page.page, status: 'not_read', blockIds: [], issueCodes: ['damaged_page'] })
      continue
    }
    const prefix = PDF_BLOCK_ID(page.page)
    const frame = page.frame
    const pageBlocks: string[] = []
    const refsByBox = new Map<Box, string>()
    let paragraphs = 0
    let tables = 0
    const list: { indent: number; id: string }[] = []
    contacts = []
    contactCount = 0
    // Stesso ordine delle chiavi del contratto e del reader DOCX, per golden leggibili.
    const block = (fields: Pick<SourceBlock, 'id' | 'kind' | 'text' | 'parentId' | 'headingIds' | 'bbox'> & Partial<Pick<SourceBlock, 'tableId' | 'row' | 'column' | 'rowSpan' | 'columnSpan'>>): SourceBlock => ({
      id: fields.id, kind: fields.kind, text: fields.text, tableId: fields.tableId ?? null, row: fields.row ?? null, column: fields.column ?? null,
      rowSpan: fields.rowSpan ?? null, columnSpan: fields.columnSpan ?? null, parentId: fields.parentId, headingIds: fields.headingIds, page: page.page, origin: 'native', bbox: fields.bbox,
    })

    for (const unit of page.units) {
      if (unit.type === 'table') {
        const tableId = `${prefix}t:${++tables}`
        list.length = 0
        unit.rows.forEach((row, rowIndex) => {
          const rowId = `${tableId}:r:${rowIndex}`
          const texts = row.cells.map(cell => cell ? canonical(cell.segment.text) : { text: '', contacts: 0 })
          // Colonne coperte da una cella che ne occupa più d'una: non ripetute nel testo della riga.
          const covered = new Set(row.cells.flatMap((cell, column) => cell ? Array.from({ length: cell.span - 1 }, (_, offset) => column + offset + 1) : []))
          const present = row.cells.map((cell, column) => ({ cell, column })).filter((entry): entry is { cell: TableCell; column: number } => entry.cell !== null)
          push(block({ id: rowId, kind: 'table_row', text: canonical(texts.filter((_, column) => !covered.has(column)).map(item => item.text).join(' | ')).text, tableId, row: rowIndex, parentId: null, headingIds: headings.map(h => h.id), bbox: frame.bbox(union(present.map(entry => entry.cell.segment))) }), 0)
          pageBlocks.push(rowId)
          for (const { cell, column } of present) {
            const cellId = `${rowId}:c:${column}`
            push(block({ id: cellId, kind: 'table_cell', text: texts[column]!.text, tableId, row: rowIndex, column, rowSpan: 1, columnSpan: cell.span, parentId: rowId, headingIds: headings.map(h => h.id), bbox: frame.bbox(cell.segment) }), texts[column]!.contacts)
            pageBlocks.push(cellId)
            refsByBox.set(cell.segment, cellId)
            for (const item of cell.segment.items) refsByBox.set(item, cellId)
          }
        })
        continue
      }
      const segments = unit.type === 'loose' ? [unit.segment] : unit.lines.flatMap(line => line.segments)
      const { text, contacts: found } = canonical(segments.map(segment => segment.text).join('\n'))
      if (!text) continue
      const id = `${prefix}b:${++paragraphs}`
      let kind: SourceBlock['kind'] = unit.type === 'text' ? unit.kind : 'paragraph'
      let parentId: string | null = null
      if (unit.type === 'text' && isHeading(unit)) {
        kind = 'heading'
        const level = headingSizes.indexOf(Math.round(unit.lines[0]!.size * 10) / 10) + 1
        while (headings.length && headings[headings.length - 1]!.level >= level) headings.pop()
        push(block({ id, kind, text, parentId: null, headingIds: headings.map(h => h.id), bbox: frame.bbox(union(segments)) }), found)
        headings.push({ id, level })
        list.length = 0
      } else {
        if (kind === 'list_item' && unit.type === 'text') {
          while (list.length && list[list.length - 1]!.indent >= unit.indent - 0.5 * unit.lines[0]!.size) list.pop()
          parentId = list[list.length - 1]?.id ?? null
          list.push({ indent: unit.indent, id })
        } else list.length = 0
        push(block({ id, kind, text, parentId, headingIds: headings.map(h => h.id), bbox: frame.bbox(union(segments)) }), found)
      }
      pageBlocks.push(id)
      for (const segment of segments) { refsByBox.set(segment, id); for (const item of segment.items) refsByBox.set(item, id) }
    }

    const codes: string[] = []
    const addIssue = (code: string, message: string, refs: string[]) => {
      const unique = [...new Set(refs)]
      const limited = unique.slice(0, contractLimits.refsPerItem)
      readingIssues.push({ code, sourceRefs: limited, message: unique.length > limited.length ? `${message} Elencati i primi ${limited.length} blocchi su ${unique.length}.` : message })
      if (!codes.includes(code)) codes.push(code)
    }
    for (const finding of page.findings) addIssue(finding.code, finding.message, finding.refs.flatMap(box => refsByBox.get(box) ?? []))
    if (contacts.length) addIssue('contact_data_removed', `Pagina ${page.page}: dati di contatto (${contactCount}) sostituiti da segnaposto ([email], [telefono], [codice fiscale], [partita IVA]): non servono a interpretare il piano (regola ${CONTACT_MINIMIZATION_VERSION}).`, contacts)
    const partial = codes.some(code => pdfReadingIssueCodes[code as IssueCode] === 'partial')
    const status: ReaderInventoryEntry['status'] = !page.textItems ? (page.unreadableItems ? 'not_read' : 'no_text') : !pageBlocks.length ? 'not_read' : partial ? 'partial' : 'read'
    inventory.push({ id: `pdf:page:${page.page}`, kind: 'page', page: page.page, status, blockIds: pageBlocks, issueCodes: codes })
  }
  return { blocks, readingIssues, inventory }
}
