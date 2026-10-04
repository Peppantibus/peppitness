/**
 * Motore DOCX puro: byte → NormalizedDocument + metadati di lettura. Nessuna dipendenza da DOM o
 * trasporto: gira nel worker (`docx-worker.ts`) e nei test Node.
 *
 * Copertura (task 03 + 04):
 * - Corpo con paragrafi, titoli, elenchi, tabelle unite e annidate, caselle di testo (`box:<n>:`)
 *   subito dopo il blocco che le ancora.
 * - Intestazioni e piè di pagina (`hdr:<n>:`, `ftr:<n>:`, n come in `docx:header:<n>`), lette una
 *   sola volta anche se usate da più sezioni; l'ambito (sezione, prima pagina, pagine pari) è
 *   descritto in un problema `header_footer_scope` quando non vale per tutto il documento. Parti non
 *   usate da alcuna sezione non sono visibili in Word: escluse con avviso.
 * - Note a piè di pagina e di chiusura richiamate (`fn:<id>:`, `en:<id>:`, id di Word), con
 *   `parentId` sul blocco che le richiama; una nota richiamata da più punti non ha un solo genitore
 *   ed è segnalata con `shared_note`; le note mai richiamate sono escluse con avviso.
 * - Blocchi del corpo, poi intestazioni, piè di pagina, note e note di chiusura: nessun ordine di
 *   pagina inventato, nessun numero di pagina (i campi PAGE/NUMPAGES non sono letti).
 * - Non letti ma sempre segnalati: commenti (annotazioni di revisione, con i blocchi a cui sono
 *   ancorati), immagini (nemmeno il testo alternativo diventa contenuto; quelle collegate
 *   all'esterno mai scaricate), oggetti e grafici, formule, simboli, contenuti incorporati, parti
 *   non riconosciute con testo, parti danneggiate.
 * - Revisioni aperte (inserimenti, eliminazioni, spostamenti, righe o celle revisionate) in una
 *   qualsiasi parte letta: il documento è rifiutato con diagnostica per parte, senza scegliere né
 *   unire testo inserito ed eliminato.
 * - Errori fatali (`DocumentReaderError`): file o pacchetto non valido, documento principale
 *   corrotto, DTD/entità, limiti di dimensione, profondità, blocchi o tempo, revisioni aperte.
 *   Una parte laterale danneggiata rende invece la lettura parziale e rivedibile.
 * - Minimizzazione: metadati OOXML (proprietà del documento, autori e date di revisioni e
 *   commenti, rsid, variabili, impostazioni) mai letti; dati di contatto nel testo sostituiti da
 *   segnaposto secondo `minimize.ts`, con avviso `contact_data_removed`.
 */
import { contractLimits } from '../contracts/schema.ts'
import { defaultImportLimits, type ImportLimits } from '../contracts/limits.ts'
import { TEXT_NORMALIZATION_VERSION, type ReadingIssue, type SourceBlock } from '../contracts/normalized-document.ts'
import {
  DocumentReaderError, validateDocumentReadResult,
  type DocumentReader, type DocumentReaderInput, type DocumentReadResult, type ReaderInventoryEntry,
} from '../contracts/reader.ts'
import {
  IMAGES_ENTRY, OBJECTS_ENTRY, StoryReader, StorySink, storyFindingKinds, storyTextElements, TEXT_BOXES_ENTRY,
  type FindingLog, type NoteKind, type StoryContext, type StoryFinding,
} from './docx-body.ts'
import { onOff, StyleSheet } from './docx-styles.ts'
import { DOCX_READER_VERSION } from './docx-version.ts'
import { checkDocxBytes, sha256Hex } from './file-checks.ts'
import { CONTACT_MINIMIZATION_VERSION } from './minimize.ts'
import { contentTypeOf, openWordPackage, readRelationships, readXmlPart, type OoxmlPackage, type PartParser, type Relationship } from './ooxml-package.ts'
import { ReadControl } from './read-control.ts'
import { directText, elementChildren, firstChild, type XmlElement } from './xml.ts'
import { ZipArchive } from './zip.ts'

export { DOCX_READER_VERSION }

export const defaultDocxReaderLimits = {
  /** Profondità massima degli elementi XML di una parte. */
  xmlDepth: 256,
  /** Tempo massimo di una lettura, pause comprese. */
  readMilliseconds: 30_000,
} as const

export interface DocxReaderOptions {
  limits?: ImportLimits
  maxXmlDepth?: number
  maxMilliseconds?: number
  /** Orologio iniettabile nei test. */
  now?: () => number
}

/**
 * Codici dei readingIssues prodotti dal reader DOCX. `partial`: una parte del contenuto è esclusa o
 * non letta; `info`: tutto è letto, ma serve un controllo o un contesto (la severità è di 06).
 */
export const docxReadingIssueCodes = {
  component_not_read: 'partial',
  image_without_text: 'partial',
  unsupported_content: 'partial',
  hidden_text: 'partial',
  damaged_part: 'partial',
  empty_body: 'partial',
  merged_cell_text: 'info',
  table_structure: 'info',
  table_continuation: 'info',
  contact_data_removed: 'info',
  shared_note: 'info',
  header_footer_scope: 'info',
} as const

type SideKind = 'header' | 'footer' | 'footnotes' | 'endnotes' | 'comments'
const sideKinds: readonly SideKind[] = ['header', 'footer', 'footnotes', 'endnotes', 'comments']
const OTHER_PARTS_ENTRY = 'docx:other-parts'

const findingCodes: Record<StoryFinding, string> = {
  tracked_changes: 'tracked_changes', hidden_text: 'hidden_text', hidden_row: 'hidden_text', math: 'unsupported_content', symbol: 'unsupported_content',
  alt_chunk: 'unsupported_content', merged_cell_text: 'merged_cell_text', table_structure: 'table_structure', table_continuation: 'table_continuation',
  contact_data: 'contact_data_removed', image: 'image_without_text', external_image: 'image_without_text', broken_image: 'image_without_text',
  embedded_object: 'unsupported_content',
}
/** Constatazioni che escludono o non leggono contenuto della storia. */
const partialFindings: ReadonlySet<StoryFinding> = new Set(['hidden_text', 'hidden_row', 'math', 'symbol', 'alt_chunk'])

function findingMessage(kind: StoryFinding, n: number): string {
  switch (kind) {
    case 'tracked_changes': return `Revisioni non accettate (${n}).`
    case 'hidden_text': return `Testo nascosto in Word (${n}): escluso dalla lettura. Se contiene indicazioni valide, rendilo visibile e carica di nuovo il file.`
    case 'hidden_row': return `Righe di tabella nascoste in Word (${n}): il contenuto è incluso, verificane la validità.`
    case 'math': return `Formule (${n}) non lette.`
    case 'symbol': return `Simboli di un font speciale (${n}) non letti.`
    case 'alt_chunk': return `Contenuto incorporato da un altro file (${n}) non letto.`
    case 'merged_cell_text': return `Testo in celle unite (${n}): accodato una sola volta alla cella che le contiene.`
    case 'table_structure': return `Struttura di tabella irregolare (${n}): celle unite senza cella d’origine o righe di larghezza diversa dalla griglia. Controlla l’allineamento di righe e colonne.`
    case 'table_continuation': return `Tabelle consecutive con le stesse colonne (${n}), separate solo da paragrafi vuoti: potrebbero essere una sola tabella interrotta. Controlla che le intestazioni valgano anche per la parte successiva.`
    case 'contact_data': return `Dati di contatto (${n}) sostituiti da segnaposto ([email], [telefono], [codice fiscale], [partita IVA]): non servono a interpretare il piano (regola ${CONTACT_MINIMIZATION_VERSION}).`
    case 'image': return `Immagini (${n}) non lette: possono contenere indicazioni che vanno controllate a mano.`
    case 'external_image': return `Immagini collegate all’esterno (${n}) mai scaricate né lette.`
    case 'broken_image': return `Immagini con collegamento interno mancante o danneggiato (${n}): non leggibili.`
    case 'embedded_object': return `Oggetti incorporati o grafici (${n}) non letti.`
  }
}

const refsLimit = contractLimits.refsPerItem
const withRefs = (refs: string[]) => refs.length > refsLimit
  ? { sourceRefs: refs.slice(0, refsLimit), note: ` Elencati i primi ${refsLimit} blocchi su ${refs.length}.` }
  : { sourceRefs: refs, note: '' }
const unique = <T>(items: T[]) => [...new Set(items)]

/** Testo visibile in una parte (le note separatrici di Word non contano). */
function hasVisibleText(root: XmlElement, names: ReadonlySet<string> = new Set(['w:t', 'w:delText'])): boolean {
  const stack = [root]
  while (stack.length) {
    const node = stack.pop()!
    if (names.has(node.name) && /\S/.test(directText(node))) return true
    stack.push(...elementChildren(node))
  }
  return false
}

const isContentNote = (note: XmlElement) => { const type = note.attributes['w:type']; return type === undefined || type === 'normal' }

/** Tipi di relazione del documento principale che non portano testo da leggere o sono gestiti altrove. */
const knownRelationshipTypes = new Set([
  'officeDocument', 'styles', 'numbering', 'settings', 'webSettings', 'fontTable', 'theme', 'header', 'footer', 'footnotes', 'endnotes', 'comments',
  'image', 'hyperlink', 'oleObject', 'package', 'chart', 'diagramData', 'diagramLayout', 'diagramQuickStyle', 'diagramColors', 'diagramDrawing',
  'subDocument', 'aFChunk', 'glossaryDocument', 'customXml', 'customXmlProps', 'people', 'commentsExtended', 'commentsIds', 'commentsExtensible',
  'stylesWithEffects', 'attachedTemplate', 'control', 'printerSettings', 'font', 'thumbnail', 'webextensiontaskpanes', 'webextension', 'video',
  'audio', 'media', 'recipientData', 'mailMergeSource', 'mailMergeHeaderSource', 'frame', 'bibliography', 'keyMapCustomizations', 'vbaProject',
  'wordVbaData', 'attachedToolbars', 'intelligence', 'intelligence2', 'documentTasks', 'classificationlabels', 'sensitivityLabels',
])
const typeName = (type: string) => type.slice(type.lastIndexOf('/') + 1)

interface SidePart {
  kind: SideKind
  ordinal: number
  entry: string
  label: string
  /** Parte interna, null se la relazione è esterna o la parte manca. */
  part: string | null
  external: boolean
}

function sideParts(pkg: OoxmlPackage): SidePart[] {
  const result: SidePart[] = []
  for (const kind of sideKinds) {
    const internal = new Set<string>()
    const broken: Relationship[] = []
    for (const relationship of pkg.mainRelationships.values()) {
      if (relationship.type !== kind) continue
      if (relationship.external || relationship.part === null) broken.push(relationship)
      else internal.add(relationship.part)
    }
    const parts = [...internal].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    const items = [...parts.map(part => ({ part, external: false })), ...broken.map(relationship => ({ part: null, external: relationship.external }))]
    items.forEach((item, index) => {
      const ordinal = index + 1
      const numbered = kind === 'header' || kind === 'footer'
      const entry = numbered ? `docx:${kind}:${ordinal}` : `docx:${kind}${ordinal > 1 ? `:${ordinal}` : ''}`
      const label = kind === 'header' ? `Intestazione ${ordinal}` : kind === 'footer' ? `Piè di pagina ${ordinal}`
        : kind === 'footnotes' ? 'Note a piè di pagina' : kind === 'endnotes' ? 'Note di chiusura' : 'Commenti'
      result.push({ kind, ordinal, entry, label: !numbered && ordinal > 1 ? `${label} (${ordinal})` : label, ...item })
    })
  }
  return result
}

type Variant = 'default' | 'first' | 'even'
interface Usage { section: number; variant: Variant }

/**
 * Sezioni che usano ciascuna parte di intestazione/piè di pagina. Una sezione senza riferimento di
 * un tipo eredita quello della sezione precedente; prima pagina e pagine pari valgono solo se attive.
 */
function headerFooterUsage(sections: StorySink['sections'], relationships: Map<string, Relationship>, evenAndOdd: boolean) {
  const usage = new Map<string, Usage[]>()
  let broken = 0
  /** Varianti attive di ogni sezione: una parte vale per tutto il documento solo se le copre tutte. */
  const activeBySection: Variant[][] = []
  const current: Record<'header' | 'footer', Partial<Record<Variant, string>>> = { header: {}, footer: {} }
  sections.forEach((section, index) => {
    const properties = section.properties
    for (const kind of ['header', 'footer'] as const) {
      for (const reference of properties ? elementChildren(properties).filter(child => child.name === `w:${kind}Reference`) : []) {
        const type = reference.attributes['w:type']
        const variant: Variant = type === 'first' || type === 'even' ? type : 'default'
        const id = reference.attributes['r:id']
        if (id !== undefined) current[kind][variant] = id
      }
      const active: Variant[] = ['default']
      if (onOff(properties ? firstChild(properties, 'w:titlePg') : undefined)) active.push('first')
      if (evenAndOdd) active.push('even')
      if (kind === 'header') activeBySection.push(active)
      for (const variant of active) {
        const id = current[kind][variant]
        if (id === undefined) continue
        const relationship = relationships.get(id)
        if (!relationship || relationship.type !== kind) { broken++; continue }
        if (relationship.part === null) continue // esterna o mancante: segnalata dalla sua voce
        const list = usage.get(relationship.part) ?? []
        list.push({ section: index + 1, variant })
        usage.set(relationship.part, list)
      }
    }
  })
  return { usage, broken, activeBySection }
}

const variantLabel = (variant: Variant, evenAndOdd: boolean) =>
  variant === 'first' ? 'prima pagina della sezione' : variant === 'even' ? 'pagine pari' : evenAndOdd ? 'pagine dispari' : 'pagine ordinarie'

/** Lettura di una parte laterale: un errore `corrupt` diventa una parte danneggiata, gli altri restano fatali. */
async function tolerant<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof DocumentReaderError && error.code === 'corrupt') return null
    throw error
  }
}

interface SideResult {
  side: SidePart
  status: ReaderInventoryEntry['status']
  sink: StorySink | null
  /** Problemi propri della parte, oltre alle constatazioni delle storie. */
  issues: ReadingIssue[]
}

export async function readDocx(input: DocumentReaderInput, options: DocxReaderOptions = {}): Promise<DocumentReadResult> {
  const limits = options.limits ?? defaultImportLimits
  const control = new ReadControl(input.signal, { maxMilliseconds: options.maxMilliseconds ?? defaultDocxReaderLimits.readMilliseconds, now: options.now })
  control.check()
  if (input.metadata.format !== 'docx') throw new DocumentReaderError('unsupported', 'Il lettore DOCX riceve soltanto documenti DOCX.')
  const bytes = input.bytes
  checkDocxBytes(bytes, limits)
  // Impronta dei byte originali prima di qualsiasi interpretazione.
  const sourceHash = await sha256Hex(bytes)
  control.check()

  const zip = ZipArchive.open(bytes, { maxEntries: limits.docxEntries, maxUncompressedBytes: limits.docxUncompressedBytes })
  const parser: PartParser = { control, maxDepth: options.maxXmlDepth ?? defaultDocxReaderLimits.xmlDepth }
  const pkg = await openWordPackage(zip, parser)
  const mainOf = (type: string) => [...pkg.mainRelationships.values()].find(relationship => relationship.type === type && relationship.part !== null)

  const stylesRelationship = mainOf('styles')
  const styles = new StyleSheet(stylesRelationship ? await readXmlPart(zip, stylesRelationship.part!, parser) : null)
  // Impostazioni: solo il flag delle intestazioni pari/dispari; nient'altro viene letto.
  const settingsRelationship = mainOf('settings')
  const settings = settingsRelationship ? await tolerant(() => readXmlPart(zip, settingsRelationship.part!, parser)) : null
  const evenAndOdd = settings?.name === 'w:settings' && onOff(firstChild(settings, 'w:evenAndOddHeaders')) === true

  const ctx: StoryContext = { styles, control, committedBlocks: 0 }
  const commit = (sink: StorySink) => { ctx.committedBlocks += sink.blocks.length }

  const documentRoot = await readXmlPart(zip, pkg.mainPart, parser, storyTextElements)
  const body = new StorySink()
  await new StoryReader(ctx, { prefix: '', entry: 'docx:body', relationships: pkg.mainRelationships, sink: body, trackSections: true }).readDocument(documentRoot)
  commit(body)

  const { usage, broken: brokenReferences, activeBySection } = headerFooterUsage(body.sections, pkg.mainRelationships, evenAndOdd)
  const results: SideResult[] = []
  const readSinks: StorySink[] = [body]

  const readPart = async (part: string, rootName: string) => {
    const relationships = await readRelationships(zip, part, parser)
    const root = await readXmlPart(zip, part, parser, storyTextElements)
    if (root.name !== rootName) throw new DocumentReaderError('corrupt', 'Parte del documento non valida.')
    return { relationships, root }
  }
  const damaged = (side: SidePart): SideResult => ({
    side, status: 'not_read', sink: null,
    issues: [{ code: 'damaged_part', sourceRefs: [], message: `${side.label}: parte danneggiata o non valida, non letta. Controlla il documento originale.` }],
  })
  const unreachable = (side: SidePart): SideResult => ({
    side, status: 'not_read', sink: null,
    issues: side.external
      ? [{ code: 'component_not_read', sourceRefs: [], message: `${side.label}: collegata a un file esterno, mai scaricata né letta.` }]
      : [{ code: 'damaged_part', sourceRefs: [], message: `${side.label}: parte dichiarata ma assente dal documento, non letta.` }],
  })

  // --- intestazioni e piè di pagina -----------------------------------------------------------
  for (const side of sideParts(pkg)) {
    if (side.kind !== 'header' && side.kind !== 'footer') continue
    if (side.part === null) { results.push(unreachable(side)); continue }
    const part = side.part
    const loaded = await tolerant(() => readPart(part, side.kind === 'header' ? 'w:hdr' : 'w:ftr'))
    if (!loaded) { results.push(damaged(side)); continue }
    const used = usage.get(part) ?? []
    if (!used.length) {
      results.push(hasVisibleText(loaded.root)
        ? { side, status: 'not_read', sink: null, issues: [{ code: 'hidden_text', sourceRefs: [], message: `${side.label}: non usata da alcuna sezione del documento (non visibile in Word), esclusa dalla lettura.` }] }
        : { side, status: 'read', sink: null, issues: [] })
      continue
    }
    const sink = new StorySink()
    const prefix = `${side.kind === 'header' ? 'hdr' : 'ftr'}:${side.ordinal}:`
    const ok = await tolerant(async () => { await new StoryReader(ctx, { prefix, entry: side.entry, relationships: loaded.relationships, sink }).container(loaded.root); return true })
    if (!ok) { results.push(damaged(side)); continue }
    commit(sink)
    readSinks.push(sink)
    const issues: ReadingIssue[] = []
    const uniform = activeBySection.every((variants, index) => variants.every(variant => used.some(item => item.section === index + 1 && item.variant === variant)))
    const blocks = sink.entryBlocks.get(side.entry) ?? []
    if (!uniform && blocks.length) {
      const bySection = new Map<number, Variant[]>()
      for (const item of used) bySection.set(item.section, [...(bySection.get(item.section) ?? []), item.variant])
      const starts = [...bySection.keys()].map(section => body.sections[section - 1]!.firstBlock)
      const description = [...bySection].map(([section, variants]) => {
        const first = body.sections[section - 1]!.firstBlock
        return `sezione ${section} ${first ? `(dal blocco ${first})` : '(senza testo)'} – ${variants.map(variant => variantLabel(variant, evenAndOdd)).join(', ')}`
      }).join('; ')
      const { sourceRefs, note } = withRefs(unique([...blocks, ...starts.filter((id): id is string => id !== null)]))
      issues.push({ code: 'header_footer_scope', sourceRefs, message: `${side.label}: vale soltanto per: ${description} (il documento ha ${body.sections.length} ${body.sections.length === 1 ? 'sezione' : 'sezioni'}). Letta una sola volta.${note}` })
    }
    results.push({ side, status: 'read', sink, issues })
  }

  // --- note a piè di pagina e di chiusura -------------------------------------------------------
  // Richiami diretti e campi NOTEREF (riferimento incrociato a un segnalibro sul richiamo della nota).
  const references = () => {
    const bookmarks = new Map(readSinks.flatMap(sink => [...sink.bookmarkNotes]))
    return readSinks.flatMap(sink => sink.references.flatMap(reference => {
      if (reference.kind !== 'noteref') return [reference]
      const target = bookmarks.get(reference.id)
      return target ? [{ ...target, block: reference.block }] : []
    }))
  }
  for (const side of sideParts(pkg)) {
    if (side.kind !== 'footnotes' && side.kind !== 'endnotes') continue
    if (side.part === null) { results.push(unreachable(side)); continue }
    const part = side.part
    const kind: NoteKind = side.kind === 'footnotes' ? 'footnote' : 'endnote'
    const loaded = await tolerant(() => readPart(part, side.kind === 'footnotes' ? 'w:footnotes' : 'w:endnotes'))
    const notes = loaded ? elementChildren(loaded.root).filter(child => child.name === `w:${kind}` && isContentNote(child)) : []
    const ids = notes.map(note => note.attributes['w:id'] ?? '')
    if (!loaded || ids.some(id => !/^-?\d{1,9}$/.test(id)) || new Set(ids).size !== ids.length) { results.push(damaged(side)); continue }

    const cited = references().map((reference, index) => ({ ...reference, index })).filter(reference => reference.kind === kind)
    const queue: { note: XmlElement; id: string; first: number; blocks: (string | null)[] }[] = []
    let excluded = 0
    notes.forEach((note, index) => {
      const id = ids[index]!
      const calls = cited.filter(reference => reference.id === id)
      if (calls.length) queue.push({ note, id, first: calls[0]!.index, blocks: calls.map(call => call.block) })
      else if (hasVisibleText(note)) excluded++
    })
    queue.sort((a, b) => a.first - b.first)

    const sink = new StorySink()
    const prefixBase = `${kind === 'footnote' ? 'fn' : 'en'}${side.ordinal > 1 ? side.ordinal : ''}`
    const label = kind === 'footnote' ? 'Nota a piè di pagina' : 'Nota di chiusura'
    const issues: ReadingIssue[] = []
    const ok = await tolerant(async () => {
      for (const item of queue) {
        const callers = unique(item.blocks)
        const shared = callers.length > 1
        const before = sink.blocks.length
        await new StoryReader(ctx, { prefix: `${prefixBase}:${item.id}:`, entry: side.entry, relationships: loaded.relationships, sink, rootParent: shared ? null : callers[0] ?? null }).container(item.note)
        const own = sink.blocks.slice(before).map(block => block.id)
        if (shared && own.length) {
          const { sourceRefs, note } = withRefs(unique([...own, ...callers.filter((id): id is string => id !== null)]))
          issues.push({ code: 'shared_note', sourceRefs, message: `${label} ${item.id} richiamata in ${item.blocks.length} punti: letta una sola volta, vale per tutti i richiami.${note}` })
        }
      }
      return true
    })
    if (!ok) { results.push(damaged(side)); continue }
    commit(sink)
    readSinks.push(sink)
    if (excluded) issues.push({ code: 'hidden_text', sourceRefs: [], message: `${side.label}: note non richiamate nel testo (${excluded}), non visibili in Word: escluse dalla lettura.` })
    const blocks = sink.blocks.length
    results.push({ side, status: excluded ? (blocks ? 'partial' : 'not_read') : 'read', sink, issues })
  }

  // --- commenti: annotazioni di revisione, mai lette come contenuto -----------------------------
  for (const side of sideParts(pkg)) {
    if (side.kind !== 'comments') continue
    if (side.part === null) { results.push(unreachable(side)); continue }
    const part = side.part
    const root = await tolerant(() => readXmlPart(zip, part, parser, storyTextElements))
    if (!root || root.name !== 'w:comments') { results.push(damaged(side)); continue }
    const withText = elementChildren(root).filter(comment => comment.name === 'w:comment' && hasVisibleText(comment)).length
    if (!withText) { results.push({ side, status: 'read', sink: null, issues: [] }); continue }
    const anchored = unique(references().filter(reference => reference.kind === 'comment' && reference.block !== null).map(reference => reference.block!))
    const { sourceRefs, note } = withRefs(anchored)
    results.push({
      side, status: 'not_read', sink: null,
      issues: [{ code: 'component_not_read', sourceRefs, message: `${side.label} (${withText}): annotazioni di revisione ai margini, non lette come contenuto del piano. Se riportano indicazioni valide, inseriscile nel testo e carica di nuovo il file.${note}` }],
    })
  }

  // --- parti non riconosciute con testo ---------------------------------------------------------
  let unknownWithText = 0
  let unknownDamaged = 0
  const seenUnknown = new Set<string>()
  for (const relationship of pkg.mainRelationships.values()) {
    if (relationship.external || relationship.part === null || knownRelationshipTypes.has(typeName(relationship.type)) || seenUnknown.has(relationship.part)) continue
    seenUnknown.add(relationship.part)
    const contentType = contentTypeOf(pkg, relationship.part) ?? ''
    if (!/xml/.test(contentType)) continue
    const part = relationship.part
    const root = await tolerant(() => readXmlPart(zip, part, parser, new Set(['w:t', 'a:t'])))
    if (!root) unknownDamaged++
    else if (hasVisibleText(root, new Set(['w:t', 'a:t']))) unknownWithText++
  }

  // --- revisioni aperte: rifiuto con diagnostica precisa --------------------------------------
  const revisions: string[] = []
  const locationOf = (entry: string) => entry === 'docx:body' ? 'corpo del documento' : entry === TEXT_BOXES_ENTRY ? 'caselle di testo'
    : results.find(result => result.side.entry === entry)?.side.label.toLowerCase() ?? entry
  let revisionCount = 0
  for (const sink of readSinks) {
    for (const [entry, logs] of sink.findings) {
      const count = logs.get('tracked_changes')?.count ?? 0
      if (!count) continue
      revisionCount += count
      revisions.push(`${locationOf(entry)}: ${count}`)
    }
  }
  if (revisionCount) {
    throw new DocumentReaderError('unsupported', `Il documento contiene revisioni non accettate (${revisionCount} — ${revisions.join('; ')}). Il lettore non sceglie fra testo inserito ed eliminato: in Word usa Revisione › Accetta tutte le revisioni (oppure rifiutale), salva e carica di nuovo il file.`)
  }
  control.check()

  // --- documento e inventario -----------------------------------------------------------------
  const blocks: SourceBlock[] = readSinks.flatMap(sink => sink.blocks)
  const readingIssues: ReadingIssue[] = []
  const inventory: ReaderInventoryEntry[] = []
  const findingsOf = (entry: string) => {
    const merged = new Map<StoryFinding, FindingLog>()
    for (const sink of readSinks) {
      sink.findings.get(entry)?.forEach((log, kind) => {
        const into = merged.get(kind) ?? { count: 0, refs: [], seen: new Set<string>() }
        into.count += log.count
        for (const ref of log.refs) if (!into.seen.has(ref)) { into.seen.add(ref); into.refs.push(ref) }
        merged.set(kind, into)
      })
    }
    return merged
  }
  const blocksOf = (entry: string) => readSinks.flatMap(sink => sink.entryBlocks.get(entry) ?? [])
  /** Problemi dalle constatazioni di una voce; restituisce i codici e se la lettura è parziale. */
  const emit = (entry: string, label: string | null) => {
    const codes: string[] = []
    let partial = false
    const logs = findingsOf(entry)
    for (const kind of storyFindingKinds) {
      const log = logs.get(kind)
      if (!log) continue
      const { sourceRefs, note } = withRefs(log.refs)
      const code = findingCodes[kind]
      readingIssues.push({ code, sourceRefs, message: `${label ? `${label} — ` : ''}${findingMessage(kind, log.count)}${note}` })
      if (!codes.includes(code)) codes.push(code)
      if (partialFindings.has(kind)) partial = true
    }
    return { codes, partial }
  }
  const pushIssues = (issues: ReadingIssue[], codes: string[]) => {
    for (const issue of issues) { readingIssues.push(issue); if (!codes.includes(issue.code)) codes.push(issue.code) }
  }

  const bodyBlocks = blocksOf('docx:body')
  const bodyFindings = emit('docx:body', null)
  if (brokenReferences) {
    pushIssues([{ code: 'damaged_part', sourceRefs: [], message: `Riferimenti a intestazioni o piè di pagina inesistenti (${brokenReferences}): quelle parti non sono lette.` }], bodyFindings.codes)
  }
  const boxBlocks = blocksOf(TEXT_BOXES_ENTRY)
  if (!bodyBlocks.length) {
    const message = blocks.length || boxBlocks.length
      ? 'Il corpo del documento non contiene testo leggibile: sono presenti soltanto parti laterali o caselle di testo.'
      : 'Il documento non contiene testo leggibile.'
    pushIssues([{ code: 'empty_body', sourceRefs: [], message }], bodyFindings.codes)
  }
  inventory.push({
    id: 'docx:body', kind: 'body', page: null,
    status: !bodyBlocks.length ? 'no_text' : bodyFindings.partial ? 'partial' : 'read',
    blockIds: bodyBlocks, issueCodes: bodyFindings.codes,
  })
  const boxFindings = emit(TEXT_BOXES_ENTRY, 'Caselle di testo')
  if (boxBlocks.length || boxFindings.codes.length) {
    inventory.push({ id: TEXT_BOXES_ENTRY, kind: 'text_box', page: null, status: boxFindings.partial ? 'partial' : 'read', blockIds: boxBlocks, issueCodes: boxFindings.codes })
  }
  for (const [entry, kind] of [[IMAGES_ENTRY, 'image'], [OBJECTS_ENTRY, 'embedded_object']] as const) {
    const found = emit(entry, null)
    if (found.codes.length) inventory.push({ id: entry, kind, page: null, status: 'not_read', blockIds: [], issueCodes: found.codes })
  }
  results.sort((a, b) => sideKinds.indexOf(a.side.kind) - sideKinds.indexOf(b.side.kind) || a.side.ordinal - b.side.ordinal)
  for (const result of results) {
    const found = result.sink ? emit(result.side.entry, result.side.label) : { codes: [], partial: false }
    pushIssues(result.issues, found.codes)
    const status = result.status === 'read' && found.partial ? 'partial' : result.status
    inventory.push({ id: result.side.entry, kind: result.side.kind, page: null, status, blockIds: blocksOf(result.side.entry), issueCodes: found.codes })
  }
  if (unknownWithText || unknownDamaged) {
    const codes: string[] = []
    if (unknownWithText) pushIssues([{ code: 'unsupported_content', sourceRefs: [], message: `Parti del documento di tipo non riconosciuto con testo (${unknownWithText}): non lette. Controlla che non contengano indicazioni del piano.` }], codes)
    if (unknownDamaged) pushIssues([{ code: 'damaged_part', sourceRefs: [], message: `Parti del documento di tipo non riconosciuto e non leggibili (${unknownDamaged}).` }], codes)
    inventory.push({ id: OTHER_PARTS_ENTRY, kind: 'embedded_object', page: null, status: 'not_read', blockIds: [], issueCodes: codes })
  }

  // Ordine dei blocchi: corpo (con le caselle), poi le parti laterali nell'ordine dell'inventario.
  const orderedBlocks = [body, ...results.flatMap(result => result.sink ? [result.sink] : [])].flatMap(sink => sink.blocks)

  const result = {
    document: { readerVersion: DOCX_READER_VERSION, sourceHash, blocks: orderedBlocks, readingIssues },
    metadata: { readerVersion: DOCX_READER_VERSION, format: 'docx' as const, textNormalizationVersion: TEXT_NORMALIZATION_VERSION, byteLength: bytes.byteLength, pageCount: null, inventory },
  }
  const checked = validateDocumentReadResult(result)
  if (!checked.ok) throw new DocumentReaderError('corrupt', `Lettura non conforme al contratto: ${checked.errors[0]?.path} ${checked.errors[0]?.code}.`)
  control.check()
  return checked.value
}

export const docxReader: DocumentReader = {
  format: 'docx',
  readerVersion: DOCX_READER_VERSION,
  read: input => readDocx(input),
}
