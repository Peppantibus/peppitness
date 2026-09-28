/**
 * Pacchetto OPC di un DOCX: content types, relationships e documento principale reale.
 * Un DOCX valido non è un qualsiasi ZIP: servono `[Content_Types].xml`, `_rels/.rels` e una
 * relazione officeDocument interna verso una parte WordprocessingML (anche rinominata).
 * Le relazioni esterne sono solo annotate: mai seguite né scaricate.
 */
import { DocumentReaderError } from '../contracts/reader.ts'
import type { ReadControl } from './read-control.ts'
import { elementChildren, parseXml, type XmlElement } from './xml.ts'
import type { ZipArchive } from './zip.ts'

export const WORD_DOCUMENT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const WORD_TEMPLATE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml'
const WORD_MACRO_CONTENT_TYPES = [
  'application/vnd.ms-word.document.macroenabled.main+xml',
  'application/vnd.ms-word.template.macroenabledtemplate.main+xml',
]

/** Tipi di relazione per nome breve, Transitional e Strict. */
const relationshipTypes: Record<string, string> = {
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument': 'officeDocument',
  'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument': 'officeDocument',
}
for (const kind of ['styles', 'numbering', 'settings', 'header', 'footer', 'footnotes', 'endnotes', 'comments', 'image', 'hyperlink', 'oleObject', 'package', 'chart', 'diagramData', 'subDocument', 'aFChunk']) {
  relationshipTypes[`http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}`] = kind
  relationshipTypes[`http://purl.oclc.org/ooxml/officeDocument/relationships/${kind}`] = kind
}

export interface Relationship {
  id: string
  /** Nome breve per i tipi noti, altrimenti l'URI completo. */
  type: string
  external: boolean
  /** Parte interna risolta (nome dell'archivio), null se esterna o fuori dal pacchetto. */
  part: string | null
}

export interface OoxmlPackage {
  zip: ZipArchive
  contentTypes: { defaults: Map<string, string>; overrides: Map<string, string> }
  mainPart: string
  mainRelationships: Map<string, Relationship>
}

const corrupt = (message: string) => new DocumentReaderError('corrupt', message)
const notWordPackage = () => corrupt('Il file non è un documento Word valido: mancano le parti essenziali del pacchetto.')

/** Testo XML UTF-8 (BOM ammesso) o UTF-16 con BOM, come previsto da OPC. */
export function decodeXmlBytes(bytes: Uint8Array): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw corrupt('Il documento contiene testo con codifica non valida.')
  }
}

export interface PartParser {
  control: ReadControl
  maxDepth: number
}

/** Legge e interpreta una parte XML dell'archivio con i limiti della lettura. */
export async function readXmlPart(zip: ZipArchive, part: string, parser: PartParser, textElements?: ReadonlySet<string>): Promise<XmlElement> {
  const bytes = await zip.read(part, parser.control)
  return parseXml(decodeXmlBytes(bytes), { control: parser.control, maxDepth: parser.maxDepth, textElements })
}

/** Risolve un target relativo alla parte sorgente; null se esce dal pacchetto o non è valido. */
export function resolvePartName(sourcePart: string, target: string): string | null {
  let decoded: string
  try { decoded = decodeURIComponent(target.split('#')[0]!) } catch { return null }
  if (!decoded || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.includes('\\')) return null
  const base = decoded.startsWith('/') ? [] : sourcePart.split('/').slice(0, -1)
  const segments = [...base]
  for (const segment of decoded.replace(/^\/+/, '').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
    } else segments.push(segment)
  }
  return segments.length ? segments.join('/') : null
}

export const relationshipsPartOf = (part: string) => {
  const slash = part.lastIndexOf('/')
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`
}

export async function readRelationships(zip: ZipArchive, sourcePart: string, parser: PartParser, required = false): Promise<Map<string, Relationship>> {
  const relsPart = sourcePart === '' ? '_rels/.rels' : relationshipsPartOf(sourcePart)
  const relationships = new Map<string, Relationship>()
  if (!zip.entry(relsPart)) {
    if (required) throw notWordPackage()
    return relationships
  }
  const root = await readXmlPart(zip, relsPart, parser)
  if (root.name !== 'rel:Relationships') throw corrupt('Relazioni del documento non valide.')
  for (const child of elementChildren(root)) {
    if (child.name !== 'rel:Relationship') continue
    const id = child.attributes.Id
    const type = child.attributes.Type
    const target = child.attributes.Target
    if (!id || !type || target === undefined) throw corrupt('Relazioni del documento non valide.')
    if (relationships.has(id)) throw corrupt('Relazioni del documento duplicate.')
    const external = child.attributes.TargetMode === 'External'
    const resolved = external ? null : resolvePartName(sourcePart, target)
    relationships.set(id, {
      id,
      type: relationshipTypes[type] ?? type,
      external,
      part: resolved === null ? null : zip.entry(resolved)?.name ?? null,
    })
  }
  return relationships
}

async function readContentTypes(zip: ZipArchive, parser: PartParser) {
  if (!zip.entry('[Content_Types].xml')) throw notWordPackage()
  const root = await readXmlPart(zip, '[Content_Types].xml', parser)
  if (root.name !== 'ct:Types') throw notWordPackage()
  const defaults = new Map<string, string>()
  const overrides = new Map<string, string>()
  for (const child of elementChildren(root)) {
    const contentType = child.attributes.ContentType?.trim().toLowerCase()
    if (!contentType) continue
    if (child.name === 'ct:Default' && child.attributes.Extension) defaults.set(child.attributes.Extension.toLowerCase(), contentType)
    if (child.name === 'ct:Override' && child.attributes.PartName) overrides.set(child.attributes.PartName.replace(/^\/+/, '').toLowerCase(), contentType)
  }
  return { defaults, overrides }
}

export function contentTypeOf(pkg: Pick<OoxmlPackage, 'contentTypes'>, part: string): string | null {
  const key = part.toLowerCase()
  const override = pkg.contentTypes.overrides.get(key)
  if (override) return override
  const dot = key.lastIndexOf('.')
  return dot < 0 ? null : pkg.contentTypes.defaults.get(key.slice(dot + 1)) ?? null
}

/** Apre il pacchetto e individua il documento principale reale tramite la relazione officeDocument. */
export async function openWordPackage(zip: ZipArchive, parser: PartParser): Promise<OoxmlPackage> {
  const contentTypes = await readContentTypes(zip, parser)
  const packageRelationships = await readRelationships(zip, '', parser, true)
  const main = [...packageRelationships.values()].filter(relationship => relationship.type === 'officeDocument')
  if (main.length !== 1 || main[0]!.external) throw notWordPackage()
  const mainPart = main[0]!.part
  if (!mainPart) throw notWordPackage()
  const contentType = contentTypeOf({ contentTypes }, mainPart)
  if (contentType !== WORD_DOCUMENT_CONTENT_TYPE) {
    if (contentType && WORD_MACRO_CONTENT_TYPES.includes(contentType)) throw new DocumentReaderError('unsupported', 'I documenti Word con macro non sono supportati: salva il file come DOCX senza macro o come PDF.')
    if (contentType === WORD_TEMPLATE_CONTENT_TYPE) throw new DocumentReaderError('unsupported', 'I modelli di Word non sono supportati: salva il contenuto come documento DOCX o PDF.')
    if (contentType && /spreadsheetml|presentationml|ms-excel|ms-powerpoint/.test(contentType)) throw new DocumentReaderError('unsupported', 'Il file non è un documento Word: scegli un DOCX o un PDF.')
    throw notWordPackage()
  }
  const mainRelationships = await readRelationships(zip, mainPart, parser)
  return { zip, contentTypes, mainPart, mainRelationships }
}
