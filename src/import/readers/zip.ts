/**
 * Lettura limitata di un archivio ZIP in memoria, soltanto per i pacchetti OOXML. La directory
 * centrale è interpretata qui con controlli stretti; la decompressione DEFLATE usa `fflate`,
 * in streaming e a piccoli blocchi, così i limiti valgono sui byte effettivamente prodotti e
 * non soltanto sulle dimensioni dichiarate. Nessuna estrazione su filesystem.
 */
import { Inflate } from 'fflate'
import { DocumentReaderError } from '../contracts/reader.ts'
import type { ReadControl } from './read-control.ts'

export interface ZipLimits {
  /** Entry della directory centrale (cartelle comprese). */
  maxEntries: number
  /** Somma dei byte decompressi: sia dichiarati sia effettivamente letti. */
  maxUncompressedBytes: number
}

export interface ZipEntry {
  /** Nome esatto dell'archivio, senza barra iniziale. */
  name: string
  method: 0 | 8
  crc32: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const ZIP64_LOCATOR = 0x07064b50
/** Blocchi di input DEFLATE: al massimo ~1032 volte in uscita, quindi pochi MiB fra due controlli. */
const INFLATE_CHUNK = 4096

const corrupt = (message: string) => new DocumentReaderError('corrupt', message)

let crcTable: Uint32Array | null = null
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let index = 0; index < bytes.length; index++) crc = crcTable[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Nome di entry ammesso: relativo, senza `..`, `.`, segmenti vuoti, barre rovesciate, unità o
 * caratteri di controllo. Un nome sospetto rende il pacchetto non valido: nessun percorso esterno.
 */
function checkEntryName(name: string): void {
  const directory = name.endsWith('/')
  const body = directory ? name.slice(0, -1) : name
  const invalid = !body || name.startsWith('/') || name.includes('\\') || /[\u0000-\u001f\u007f]/.test(name) || /^[A-Za-z]:/.test(name)
    || body.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  if (invalid) throw corrupt('Il pacchetto contiene un percorso non valido.')
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

export class ZipArchive {
  private readonly bytes: Uint8Array
  private readonly view: DataView
  private readonly limits: ZipLimits
  /** Chiave: nome in minuscolo, perché i nomi delle parti OPC non distinguono maiuscole. */
  private readonly byName = new Map<string, ZipEntry>()
  private readonly dataOffsets = new Map<ZipEntry, number>()
  private produced = 0
  readonly entryCount: number
  readonly declaredUncompressedBytes: number

  private constructor(bytes: Uint8Array, limits: ZipLimits) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.limits = limits
    const { entries, declared } = this.readCentralDirectory()
    this.entryCount = entries
    this.declaredUncompressedBytes = declared
  }

  /** Apre l'archivio leggendo solo la directory centrale; nessuna entry viene decompressa. */
  static open(bytes: Uint8Array, limits: ZipLimits): ZipArchive {
    return new ZipArchive(bytes, limits)
  }

  /** Byte decompressi prodotti finora da `read`, rispetto al limite complessivo. */
  get producedBytes(): number { return this.produced }

  entry(name: string): ZipEntry | undefined { return this.byName.get(name.toLowerCase()) }

  private u16(offset: number) { return this.view.getUint16(offset, true) }
  private u32(offset: number) { return this.view.getUint32(offset, true) }

  private findEndOfCentralDirectory(): number {
    const length = this.bytes.length
    if (length < 22) throw corrupt('Il file non è un archivio DOCX completo.')
    const earliest = Math.max(0, length - 22 - 0xffff)
    for (let offset = length - 22; offset >= earliest; offset--) {
      if (this.u32(offset) !== EOCD) continue
      // Il commento finale deve arrivare esattamente alla fine del file.
      if (offset + 22 + this.u16(offset + 20) === length) return offset
    }
    throw corrupt('Il file è incompleto o non è un archivio DOCX.')
  }

  private readCentralDirectory() {
    const eocd = this.findEndOfCentralDirectory()
    if (eocd >= 20 && this.u32(eocd - 20) === ZIP64_LOCATOR) throw new DocumentReaderError('unsupported', 'Archivio ZIP64 non supportato per i documenti DOCX.')
    const disk = this.u16(eocd + 4)
    const centralDisk = this.u16(eocd + 6)
    const entriesOnDisk = this.u16(eocd + 8)
    const declaredEntries = this.u16(eocd + 10)
    const size = this.u32(eocd + 12)
    const start = this.u32(eocd + 16)
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== declaredEntries) throw new DocumentReaderError('unsupported', 'Archivi divisi in più parti non supportati.')
    if (declaredEntries === 0xffff || size === 0xffffffff || start === 0xffffffff) throw new DocumentReaderError('unsupported', 'Archivio ZIP64 non supportato per i documenti DOCX.')
    if (declaredEntries > this.limits.maxEntries) {
      throw new DocumentReaderError('limit_exceeded', 'Il documento contiene troppi elementi interni.', { limit: 'docxEntries', max: this.limits.maxEntries, actual: declaredEntries })
    }
    if (start + size !== eocd) throw corrupt('Directory centrale dell’archivio non valida.')

    let offset = start
    let declared = 0
    const ranges: [number, number][] = []
    for (let index = 0; index < declaredEntries; index++) {
      if (offset + 46 > eocd || this.u32(offset) !== CENTRAL) throw corrupt('Directory centrale dell’archivio non valida.')
      const flags = this.u16(offset + 8)
      const method = this.u16(offset + 10)
      const crc = this.u32(offset + 16)
      const compressedSize = this.u32(offset + 20)
      const uncompressedSize = this.u32(offset + 24)
      const nameLength = this.u16(offset + 28)
      const extraLength = this.u16(offset + 30)
      const commentLength = this.u16(offset + 32)
      const localHeaderOffset = this.u32(offset + 42)
      const next = offset + 46 + nameLength + extraLength + commentLength
      if (next > eocd) throw corrupt('Directory centrale dell’archivio non valida.')
      let name: string
      try { name = utf8.decode(this.bytes.subarray(offset + 46, offset + 46 + nameLength)) } catch { throw corrupt('Nome di un elemento interno non leggibile.') }
      checkEntryName(name)
      if (flags & 0x41) throw new DocumentReaderError('unsupported', 'Il documento è protetto da password: rimuovi la protezione e riprova.')
      if (method !== 0 && method !== 8) throw new DocumentReaderError('unsupported', 'Il documento usa una compressione non supportata.')
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) throw new DocumentReaderError('unsupported', 'Archivio ZIP64 non supportato per i documenti DOCX.')
      if (method === 0 && compressedSize !== uncompressedSize) throw corrupt('Dimensioni non coerenti in un elemento interno.')
      const key = name.toLowerCase()
      if (this.byName.has(key)) throw corrupt('Il pacchetto contiene elementi interni duplicati.')
      declared += uncompressedSize
      if (declared > this.limits.maxUncompressedBytes) {
        throw new DocumentReaderError('limit_exceeded', 'Il contenuto decompresso del documento supera il limite.', { limit: 'docxUncompressedBytes', max: this.limits.maxUncompressedBytes, actual: declared })
      }

      // Intestazione locale: stesso nome, dati interamente prima della directory centrale.
      if (localHeaderOffset + 30 > start || this.u32(localHeaderOffset) !== LOCAL) throw corrupt('Elemento interno non valido.')
      const localNameLength = this.u16(localHeaderOffset + 26)
      const localExtraLength = this.u16(localHeaderOffset + 28)
      const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength
      const dataEnd = dataOffset + compressedSize
      if (dataEnd > start) throw corrupt('Elemento interno oltre i limiti dell’archivio.')
      const localName = this.bytes.subarray(localHeaderOffset + 30, localHeaderOffset + 30 + localNameLength)
      const centralName = this.bytes.subarray(offset + 46, offset + 46 + nameLength)
      if (localNameLength !== nameLength || localName.some((byte, position) => byte !== centralName[position])) throw corrupt('Nomi incoerenti in un elemento interno.')

      const entry: ZipEntry = { name, method, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset }
      this.byName.set(key, entry)
      this.dataOffsets.set(entry, dataOffset)
      ranges.push([localHeaderOffset, dataEnd])
      offset = next
    }
    if (offset !== eocd) throw corrupt('Directory centrale dell’archivio non valida.')
    // Entry sovrapposte: tecnica tipica delle zip bomb, mai presente in un pacchetto regolare.
    ranges.sort((a, b) => a[0] - b[0])
    for (let index = 1; index < ranges.length; index++) {
      if (ranges[index]![0] < ranges[index - 1]![1]) throw corrupt('Elementi interni sovrapposti nell’archivio.')
    }
    return { entries: declaredEntries, declared }
  }

  /**
   * Decompressione di una entry con limiti effettivi: si ferma appena i byte prodotti superano
   * la dimensione dichiarata o il totale ammesso, poi verifica dimensione e CRC-32.
   */
  async read(name: string, control: ReadControl): Promise<Uint8Array> {
    const entry = this.entry(name)
    if (!entry || entry.name.endsWith('/')) throw corrupt('Elemento interno mancante.')
    control.check()
    const start = this.dataOffsets.get(entry)!
    const input = this.bytes.subarray(start, start + entry.compressedSize)
    const account = (bytes: number) => {
      this.produced += bytes
      if (this.produced > this.limits.maxUncompressedBytes) {
        throw new DocumentReaderError('limit_exceeded', 'Il contenuto decompresso del documento supera il limite.', { limit: 'docxUncompressedBytes', max: this.limits.maxUncompressedBytes, actual: this.produced })
      }
    }

    let output: Uint8Array
    if (entry.method === 0) {
      account(input.length)
      output = input.slice()
    } else {
      output = new Uint8Array(entry.uncompressedSize)
      let written = 0
      const inflate = new Inflate(chunk => {
        if (written + chunk.length > entry.uncompressedSize) throw corrupt('Un elemento interno è più grande di quanto dichiarato.')
        account(chunk.length)
        output.set(chunk, written)
        written += chunk.length
      })
      for (let offset = 0; ; offset += INFLATE_CHUNK) {
        const last = offset + INFLATE_CHUNK >= input.length
        try { inflate.push(input.subarray(offset, offset + INFLATE_CHUNK), last) } catch (error) {
          if (error instanceof DocumentReaderError) throw error
          throw corrupt('Dati compressi non validi nel documento.')
        }
        if (last) break
        await control.pause()
      }
      if (written !== entry.uncompressedSize) throw corrupt('Un elemento interno ha dimensioni diverse da quelle dichiarate.')
    }
    if (crc32(output) !== entry.crc32) throw corrupt('Controllo di integrità non superato: il documento è danneggiato.')
    await control.pause()
    return output
  }
}
