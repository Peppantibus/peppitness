/**
 * Motore DOCX puro (task 03): byte → NormalizedDocument + metadati di lettura. Nessuna
 * dipendenza da DOM o trasporto: gira nel worker (`docx-worker.ts`) e nei test Node.
 *
 * Copertura di questa versione: corpo con paragrafi, titoli, elenchi, tabelle unite e annidate.
 * Intestazioni, piè di pagina, note, commenti, caselle di testo, immagini e oggetti sono
 * inventariati e, se contengono qualcosa, segnalati nei readingIssues come non letti: il task 04
 * amplia la lettura senza cambiare gli ID dei blocchi già supportati (altrimenti nuova versione).
 */
import { contractLimits } from '../contracts/schema.ts'
import { defaultImportLimits, type ImportLimits } from '../contracts/jobs.ts'
import { TEXT_NORMALIZATION_VERSION, type ReadingIssue } from '../contracts/normalized-document.ts'
import {
  DocumentReaderError, validateDocumentReadResult,
  type DocumentReader, type DocumentReaderInput, type DocumentReadResult, type ReaderInventoryEntry,
} from '../contracts/reader.ts'
import { BodyReader, bodyTextElements, type BodyFinding, type BodyFindingSummary } from './docx-body.ts'
import { StyleSheet } from './docx-styles.ts'
import { DOCX_READER_VERSION } from './docx-version.ts'
import { checkDocxBytes, sha256Hex } from './file-checks.ts'
import { openWordPackage, readXmlPart, type OoxmlPackage, type PartParser } from './ooxml-package.ts'
import { ReadControl } from './read-control.ts'
import { directText, elementChildren, type XmlElement } from './xml.ts'
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

type ComponentKind = 'header' | 'footer' | 'footnotes' | 'endnotes' | 'comments'
const componentLabels: Record<ComponentKind, string> = {
  header: 'Intestazione',
  footer: 'Piè di pagina',
  footnotes: 'Note a piè di pagina',
  endnotes: 'Note di chiusura',
  comments: 'Commenti',
}

/** Parti laterali: hanno testo visibile? (Le note separatrici di Word non contano.) */
function partHasText(root: XmlElement, kind: ComponentKind): boolean {
  const roots = kind === 'footnotes' || kind === 'endnotes'
    ? elementChildren(root).filter(note => {
      const type = note.attributes['w:type']
      return type === undefined || type === 'normal'
    })
    : [root]
  const stack = [...roots]
  while (stack.length) {
    const node = stack.pop()!
    if ((node.name === 'w:t' || node.name === 'w:delText') && /\S/.test(directText(node))) return true
    stack.push(...elementChildren(node))
  }
  return false
}

const refsLimit = contractLimits.refsPerItem
const withRefs = (refs: string[]) => refs.length > refsLimit
  ? { sourceRefs: refs.slice(0, refsLimit), note: ` Elencati i primi ${refsLimit} blocchi su ${refs.length}.` }
  : { sourceRefs: refs, note: '' }

interface Diagnostic { code: string; message: string; target: 'body' | 'text_box' | 'image' | 'embedded_object' }

function diagnostics(finding: BodyFindingSummary): Diagnostic {
  const n = finding.count
  const messages: Record<BodyFinding, Diagnostic> = {
    tracked_changes: { code: 'tracked_changes', target: 'body', message: `Il documento contiene revisioni non accettate (${n}): il testo esclude le parti eliminate e include quelle inserite, senza unirle. Accetta o rifiuta le revisioni in Word e carica di nuovo il file.` },
    hidden_text: { code: 'hidden_text', target: 'body', message: `Testo nascosto in Word (${n}): escluso dalla lettura. Se contiene indicazioni valide, rendilo visibile e carica di nuovo il file.` },
    hidden_row: { code: 'hidden_text', target: 'body', message: `Righe di tabella nascoste in Word (${n}): il contenuto è incluso, verificane la validità.` },
    math: { code: 'unsupported_content', target: 'body', message: `Formule (${n}) non lette.` },
    symbol: { code: 'unsupported_content', target: 'body', message: `Simboli di un font speciale (${n}) non letti.` },
    alt_chunk: { code: 'unsupported_content', target: 'body', message: `Contenuto incorporato da un altro file (${n}) non letto.` },
    merged_cell_text: { code: 'merged_cell_text', target: 'body', message: `Testo in celle unite (${n}): accodato una sola volta alla cella che le contiene.` },
    text_box: { code: 'component_not_read', target: 'text_box', message: `Caselle di testo con contenuto (${n}) non lette da questa versione del lettore.` },
    image: { code: 'image_without_text', target: 'image', message: `Immagini (${n}) non lette: possono contenere indicazioni che vanno controllate a mano.` },
    external_image: { code: 'image_without_text', target: 'image', message: `Immagini collegate all’esterno (${n}) mai scaricate né lette.` },
    embedded_object: { code: 'unsupported_content', target: 'embedded_object', message: `Oggetti incorporati o grafici (${n}) non letti.` },
  }
  return messages[finding.kind]
}

/** Parti non lette dal corpo: inventario con stato e problema se contengono testo. */
async function sideComponents(pkg: OoxmlPackage, parser: PartParser) {
  const seen = new Map<string, ComponentKind>()
  const missing: ComponentKind[] = []
  for (const relationship of pkg.mainRelationships.values()) {
    const kind = relationship.type as ComponentKind
    if (!Object.hasOwn(componentLabels, kind)) continue
    if (relationship.external || relationship.part === null) { missing.push(kind); continue }
    if (!seen.has(relationship.part)) seen.set(relationship.part, kind)
  }
  const entries: { kind: ComponentKind; hasText: boolean; missing: boolean }[] = []
  for (const [part, kind] of [...seen].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const root = await readXmlPart(pkg.zip, part, parser, bodyTextElements)
    entries.push({ kind, hasText: partHasText(root, kind), missing: false })
  }
  for (const kind of missing) entries.push({ kind, hasText: false, missing: true })
  return entries
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

  const stylesRelationship = [...pkg.mainRelationships.values()].find(relationship => relationship.type === 'styles' && relationship.part !== null)
  const styles = new StyleSheet(stylesRelationship ? await readXmlPart(zip, stylesRelationship.part!, parser) : null)
  const documentRoot = await readXmlPart(zip, pkg.mainPart, parser, bodyTextElements)
  const body = await new BodyReader(styles, pkg.mainRelationships, control).read(documentRoot)
  const sides = await sideComponents(pkg, parser)
  control.check()

  const readingIssues: ReadingIssue[] = []
  const inventory: ReaderInventoryEntry[] = []
  const bodyCodes: string[] = []
  const grouped = new Map<Diagnostic['target'], string[]>()
  let bodyPartial = false
  for (const finding of body.findings) {
    const diagnostic = diagnostics(finding)
    const { sourceRefs, note } = withRefs(finding.refs)
    readingIssues.push({ code: diagnostic.code, sourceRefs, message: diagnostic.message + note })
    if (diagnostic.target === 'body') {
      if (!bodyCodes.includes(diagnostic.code)) bodyCodes.push(diagnostic.code)
      if (finding.kind !== 'merged_cell_text') bodyPartial = true
    } else {
      const codes = grouped.get(diagnostic.target) ?? []
      if (!codes.includes(diagnostic.code)) codes.push(diagnostic.code)
      grouped.set(diagnostic.target, codes)
    }
  }
  inventory.push({ id: 'docx:body', kind: 'body', page: null, status: bodyPartial ? 'partial' : 'read', blockIds: body.blocks.map(block => block.id), issueCodes: bodyCodes })
  const componentIds: Record<string, string> = { text_box: 'docx:text-boxes', image: 'docx:images', embedded_object: 'docx:embedded-objects' }
  for (const [target, codes] of grouped) {
    inventory.push({ id: componentIds[target]!, kind: target as ReaderInventoryEntry['kind'], page: null, status: 'not_read', blockIds: [], issueCodes: codes })
  }

  const counters = new Map<ComponentKind, number>()
  for (const side of sides) {
    const ordinal = (counters.get(side.kind) ?? 0) + 1
    counters.set(side.kind, ordinal)
    const label = componentLabels[side.kind]
    const id = side.kind === 'header' || side.kind === 'footer' ? `docx:${side.kind}:${ordinal}` : `docx:${side.kind}${ordinal > 1 ? `:${ordinal}` : ''}`
    if (side.missing) {
      readingIssues.push({ code: 'component_not_read', sourceRefs: [], message: `${label}: parte dichiarata ma assente o esterna al documento, non letta.` })
      inventory.push({ id, kind: side.kind, page: null, status: 'not_read', blockIds: [], issueCodes: ['component_not_read'] })
    } else if (side.hasText) {
      readingIssues.push({ code: 'component_not_read', sourceRefs: [], message: `${label}: contiene testo non letto da questa versione del lettore. Controlla che non riporti indicazioni valide per tutto il documento.` })
      inventory.push({ id, kind: side.kind, page: null, status: 'not_read', blockIds: [], issueCodes: ['component_not_read'] })
    } else {
      // Parte letta per intero e senza testo (es. piè di pagina vuoto, solo separatori delle note).
      inventory.push({ id, kind: side.kind, page: null, status: 'read', blockIds: [], issueCodes: [] })
    }
  }

  const result = {
    document: { readerVersion: DOCX_READER_VERSION, sourceHash, blocks: body.blocks, readingIssues },
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
