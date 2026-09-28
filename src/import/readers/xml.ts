/**
 * Parser XML stretto e minimo per le parti OOXML, utilizzabile in un worker (niente DOMParser).
 * Rifiuta DTD e dichiarazioni `<!…>`: nessuna entità definita dal documento, nessuna risorsa
 * esterna. Ammette solo le cinque entità predefinite e i riferimenti numerici. Profondità
 * limitata e pause cooperative per annullamento e tempo massimo.
 *
 * I nomi con namespace noto diventano `alias:locale` indipendentemente dal prefisso usato nel
 * file (`w:p` anche se il documento dichiara `x:p`); gli altri `{uri}locale`.
 */
import { DocumentReaderError } from '../contracts/reader.ts'
import type { ReadControl } from './read-control.ts'

export interface XmlElement {
  name: string
  attributes: Record<string, string>
  children: XmlNode[]
}
export type XmlNode = XmlElement | string

export interface XmlParseOptions {
  control: ReadControl
  maxDepth: number
  /** Elementi di cui conservare il testo; altrove il testo fra i tag è ignorato. */
  textElements?: ReadonlySet<string>
}

/** URI noti → alias stabili. Transitional e Strict condividono l'alias. */
const knownNamespaces: Record<string, string> = {
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main': 'w',
  'http://purl.oclc.org/ooxml/wordprocessingml/main': 'w',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships': 'r',
  'http://purl.oclc.org/ooxml/officeDocument/relationships': 'r',
  'http://schemas.openxmlformats.org/markup-compatibility/2006': 'mc',
  'http://schemas.openxmlformats.org/package/2006/content-types': 'ct',
  'http://schemas.openxmlformats.org/package/2006/relationships': 'rel',
  'http://schemas.openxmlformats.org/officeDocument/2006/math': 'm',
  'http://purl.oclc.org/ooxml/officeDocument/math': 'm',
  'http://schemas.openxmlformats.org/drawingml/2006/main': 'a',
  'http://purl.oclc.org/ooxml/drawingml/main': 'a',
  'http://schemas.openxmlformats.org/drawingml/2006/chart': 'c',
  'http://purl.oclc.org/ooxml/drawingml/chart': 'c',
  'http://schemas.openxmlformats.org/drawingml/2006/diagram': 'dgm',
  'http://purl.oclc.org/ooxml/drawingml/diagram': 'dgm',
  'urn:schemas-microsoft-com:vml': 'v',
  'urn:schemas-microsoft-com:office:office': 'o',
  'http://www.w3.org/XML/1998/namespace': 'xml',
}

const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace'
const MAX_ATTRIBUTES = 256
const namePattern = /^[\p{L}_][\p{L}\p{N}_.\-·]*(?::[\p{L}_][\p{L}\p{N}_.\-·]*)?$/u
const predefined: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: '\'' }

const corrupt = (message: string) => new DocumentReaderError('corrupt', message)
const malformed = () => corrupt('Il documento contiene XML non valido.')

const isXmlChar = (code: number) =>
  code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff)

/** Riferimenti a entità: solo predefinite e numeriche valide. */
function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw
  let result = ''
  let from = 0
  for (let amp = raw.indexOf('&'); amp >= 0; amp = raw.indexOf('&', from)) {
    const semicolon = raw.indexOf(';', amp)
    if (semicolon < 0 || semicolon - amp > 12) throw malformed()
    const reference = raw.slice(amp + 1, semicolon)
    let value: string
    if (reference.startsWith('#')) {
      const code = /^#x[0-9A-Fa-f]{1,6}$/.test(reference) ? Number.parseInt(reference.slice(2), 16)
        : /^#[0-9]{1,7}$/.test(reference) ? Number.parseInt(reference.slice(1), 10) : Number.NaN
      if (!isXmlChar(code)) throw malformed()
      value = String.fromCodePoint(code)
    } else {
      const known = predefined[reference]
      if (known === undefined) throw new DocumentReaderError('unsupported', 'Il documento usa entità XML non ammesse.')
      value = known
    }
    result += raw.slice(from, amp) + value
    from = semicolon + 1
  }
  return result + raw.slice(from)
}

interface Frame { raw: string; element: XmlElement; scope: Map<string, string> | null }

const isSpace = (code: number) => code === 0x20 || code === 0x9 || code === 0xa || code === 0xd

export async function parseXml(text: string, options: XmlParseOptions): Promise<XmlElement> {
  const { control, maxDepth } = options
  const textElements = options.textElements ?? new Set<string>()
  const stack: Frame[] = []
  let root: XmlElement | null = null
  let position = 0
  let tokens = 0

  const lookup = (prefix: string): string | null => {
    if (prefix === 'xml') return XML_NAMESPACE
    for (let index = stack.length - 1; index >= 0; index--) {
      const uri = stack[index]!.scope?.get(prefix)
      if (uri !== undefined) return uri
    }
    return null
  }
  const resolve = (raw: string, isAttribute: boolean): string => {
    const colon = raw.indexOf(':')
    const prefix = colon < 0 ? '' : raw.slice(0, colon)
    const local = colon < 0 ? raw : raw.slice(colon + 1)
    // Gli attributi senza prefisso non hanno namespace.
    if (isAttribute && colon < 0) return local
    const uri = lookup(prefix)
    if (uri === null || uri === '') {
      if (prefix) throw corrupt('Il documento usa un prefisso XML non dichiarato.')
      return local
    }
    const alias = knownNamespaces[uri]
    return alias ? `${alias}:${local}` : `{${uri}}${local}`
  }
  const skipSpaces = () => { while (position < text.length && isSpace(text.charCodeAt(position))) position++ }
  const readName = () => {
    const start = position
    while (position < text.length) {
      const code = text.charCodeAt(position)
      if (isSpace(code) || code === 0x2f || code === 0x3e || code === 0x3d || code === 0x3c) break
      position++
    }
    const name = text.slice(start, position)
    if (!namePattern.test(name)) throw malformed()
    return name
  }

  while (position < text.length) {
    if (++tokens % 1024 === 0) await control.pause()
    const open = text.indexOf('<', position)
    const chunk = text.slice(position, open < 0 ? text.length : open)
    if (chunk) {
      const top = stack[stack.length - 1]
      if (!top) { if (/\S/.test(chunk)) throw malformed() }
      else if (textElements.has(top.element.name)) {
        if (chunk.includes(']]>')) throw malformed()
        const value = decodeEntities(chunk)
        const last = top.element.children[top.element.children.length - 1]
        if (typeof last === 'string') top.element.children[top.element.children.length - 1] = last + value
        else top.element.children.push(value)
      }
    }
    if (open < 0) break
    position = open

    if (text.startsWith('<?', position)) {
      const end = text.indexOf('?>', position + 2)
      if (end < 0) throw malformed()
      position = end + 2
      continue
    }
    if (text.startsWith('<!--', position)) {
      const end = text.indexOf('-->', position + 4)
      if (end < 0) throw malformed()
      position = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', position)) {
      const end = text.indexOf(']]>', position + 9)
      const top = stack[stack.length - 1]
      if (end < 0 || !top) throw malformed()
      if (textElements.has(top.element.name)) top.element.children.push(text.slice(position + 9, end))
      position = end + 3
      continue
    }
    if (text.startsWith('<!', position)) {
      // DOCTYPE, ENTITY e simili: mai presenti in un pacchetto Word, mai interpretati.
      throw new DocumentReaderError('unsupported', 'Il documento contiene dichiarazioni XML (DTD) non ammesse.')
    }
    if (text.startsWith('</', position)) {
      position += 2
      const raw = readName()
      skipSpaces()
      if (text.charCodeAt(position) !== 0x3e) throw malformed()
      position++
      const frame = stack.pop()
      if (!frame || frame.raw !== raw) throw malformed()
      continue
    }

    // Tag di apertura.
    position++
    const raw = readName()
    const rawAttributes: [string, string][] = []
    let scope: Map<string, string> | null = null
    let selfClosing = false
    for (;;) {
      const before = position
      skipSpaces()
      const code = text.charCodeAt(position)
      if (code === 0x3e) { position++; break }
      if (code === 0x2f) {
        if (text.charCodeAt(position + 1) !== 0x3e) throw malformed()
        position += 2
        selfClosing = true
        break
      }
      if (position === before || position >= text.length) throw malformed()
      const name = readName()
      skipSpaces()
      if (text.charCodeAt(position) !== 0x3d) throw malformed()
      position++
      skipSpaces()
      const quote = text[position]
      if (quote !== '"' && quote !== '\'') throw malformed()
      const end = text.indexOf(quote, position + 1)
      if (end < 0) throw malformed()
      const rawValue = text.slice(position + 1, end)
      if (rawValue.includes('<')) throw malformed()
      position = end + 1
      const value = decodeEntities(rawValue)
      if (name === 'xmlns' || name.startsWith('xmlns:')) {
        scope ??= new Map()
        const prefix = name === 'xmlns' ? '' : name.slice(6)
        if (scope.has(prefix) || prefix === 'xml' || prefix === 'xmlns') throw malformed()
        scope.set(prefix, value)
        continue
      }
      if (rawAttributes.some(([existing]) => existing === name)) throw malformed()
      rawAttributes.push([name, value])
      if (rawAttributes.length > MAX_ATTRIBUTES) throw corrupt('Elemento XML con troppi attributi.')
    }

    if (stack.length + 1 > maxDepth) {
      throw new DocumentReaderError('limit_exceeded', 'Struttura del documento troppo profonda.', { limit: 'xmlDepth', max: maxDepth, actual: stack.length + 1 })
    }
    if (root && !stack.length) throw malformed()
    const element: XmlElement = { name: '', attributes: {}, children: [] }
    const frame: Frame = { raw, element, scope }
    stack.push(frame)
    element.name = resolve(raw, false)
    for (const [name, value] of rawAttributes) {
      const resolved = resolve(name, true)
      if (Object.hasOwn(element.attributes, resolved)) throw malformed()
      element.attributes[resolved] = value
    }
    const parent = stack[stack.length - 2]
    if (parent) parent.element.children.push(element)
    else root = element
    if (selfClosing) stack.pop()
  }
  if (stack.length || !root) throw malformed()
  control.check()
  return root
}

/** Figli elemento, esclusi i nodi di testo. */
export const elementChildren = (element: XmlElement): XmlElement[] =>
  element.children.filter((child): child is XmlElement => typeof child !== 'string')

export const firstChild = (element: XmlElement, name: string): XmlElement | undefined =>
  element.children.find((child): child is XmlElement => typeof child !== 'string' && child.name === name)

/** Testo diretto di un elemento conservato con `textElements`. */
export const directText = (element: XmlElement): string =>
  element.children.filter((child): child is string => typeof child === 'string').join('')
