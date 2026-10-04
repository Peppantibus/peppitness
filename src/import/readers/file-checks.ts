/**
 * Controlli sul file scelto prima di qualsiasi interpretazione (specifica §4.1): estensione,
 * dimensione, firma dei byte e impronta SHA-256. Il MIME del browser è soltanto informativo:
 * può essere vuoto o falso e non decide mai il formato.
 */
import { defaultImportLimits, type ImportLimits } from '../contracts/limits.ts'
import { DocumentReaderError, type DocumentFormat } from '../contracts/reader.ts'

export const DOCX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const PDF_MEDIA_TYPE = 'application/pdf'
/** Valore per l'attributo `accept` del selettore: l'estensione resta comunque verificata qui. */
export const acceptedFileTypes = `.docx,.pdf,${DOCX_MEDIA_TYPE},${PDF_MEDIA_TYPE}`

/** Sottoinsieme di `File` usato dai controlli: il nome non esce mai dal dispositivo. */
export interface SelectedFileInfo { name: string; size: number; type: string }
export interface AcceptedFile { format: DocumentFormat; mediaType: string | null }

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).trim().toLowerCase()
}

const rejectedExtensions: Record<string, string> = {
  doc: 'I documenti Word 97-2003 (.doc) non sono supportati: salva il file come DOCX o PDF e riprova.',
  docm: 'I documenti Word con macro (.docm) non sono supportati: salva il file come DOCX senza macro o come PDF.',
  dot: 'I modelli di Word non sono supportati: salva il contenuto come documento DOCX o PDF.',
  dotx: 'I modelli di Word non sono supportati: salva il contenuto come documento DOCX o PDF.',
  dotm: 'I modelli di Word con macro non sono supportati: salva il contenuto come documento DOCX o PDF.',
  rtf: 'I file RTF non sono supportati: salva il documento come DOCX o PDF.',
  odt: 'I documenti OpenDocument (.odt) non sono supportati: salva il documento come DOCX o PDF.',
}

/** Dimensione del file entro il limite, prima di leggerne i byte. */
export function checkFileSize(size: number, limits: ImportLimits = defaultImportLimits): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new DocumentReaderError('corrupt', 'Dimensione del file non valida.')
  if (size === 0) throw new DocumentReaderError('corrupt', 'Il file è vuoto.')
  if (size > limits.fileBytes) throw new DocumentReaderError('limit_exceeded', 'Il file supera la dimensione massima consentita.', { limit: 'fileBytes', max: limits.fileBytes, actual: size })
}

/**
 * Controllo del file selezionato, prima della lettura: estensione ammessa e dimensione.
 * Restituisce il formato da passare al reader e il MIME dichiarato (null se vuoto).
 */
export function checkSelectedFile(file: SelectedFileInfo, limits: ImportLimits = defaultImportLimits): AcceptedFile {
  const extension = extensionOf(file.name)
  const rejected = rejectedExtensions[extension]
  if (rejected) throw new DocumentReaderError('unsupported', rejected)
  if (extension !== 'docx' && extension !== 'pdf') throw new DocumentReaderError('unsupported', 'Scegli un file DOCX o PDF.')
  checkFileSize(file.size, limits)
  const mediaType = file.type.trim().toLowerCase()
  return { format: extension, mediaType: mediaType ? mediaType.slice(0, 200) : null }
}

export type FileSignature = 'zip' | 'pdf' | 'cfb' | 'unknown'

const startsWith = (bytes: Uint8Array, signature: readonly number[], offset = 0) =>
  bytes.length >= offset + signature.length && signature.every((byte, index) => bytes[offset + index] === byte)

/** Firma dei byte: ZIP locale, PDF (intestazione entro 1024 byte), contenitore OLE/CFB. */
export function detectSignature(bytes: Uint8Array): FileSignature {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return 'zip'
  // Word 97-2003 e documenti OOXML cifrati con password usano entrambi il contenitore CFB.
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'cfb'
  const head = bytes.subarray(0, 1024)
  for (let index = 0; index + 5 <= head.length; index++) {
    if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d], index)) return 'pdf'
  }
  return 'unknown'
}

/** Byte coerenti con un DOCX prima di aprire il pacchetto: non vuoti, entro il limite, firma ZIP. */
export function checkDocxBytes(bytes: Uint8Array, limits: ImportLimits = defaultImportLimits): void {
  checkFileSize(bytes.byteLength, limits)
  const signature = detectSignature(bytes)
  if (signature === 'cfb') throw new DocumentReaderError('unsupported', 'Il file è protetto da password oppure è un documento Word 97-2003: rimuovi la password o salvalo come DOCX e riprova.')
  if (signature === 'pdf') throw new DocumentReaderError('unsupported', 'Il file è un PDF con estensione diversa: sceglilo come PDF.')
  if (signature !== 'zip') throw new DocumentReaderError('corrupt', 'Il file non è un documento DOCX valido.')
}

/** Byte coerenti con un PDF prima di interpretarlo: non vuoti, entro il limite, intestazione `%PDF-`. */
export function checkPdfBytes(bytes: Uint8Array, limits: ImportLimits = defaultImportLimits): void {
  checkFileSize(bytes.byteLength, limits)
  const signature = detectSignature(bytes)
  if (signature === 'zip') throw new DocumentReaderError('unsupported', 'Il file è un documento Word o un archivio con estensione diversa: sceglilo come DOCX.')
  if (signature === 'cfb') throw new DocumentReaderError('unsupported', 'Il file è un documento Word 97-2003 o protetto con estensione diversa: salvalo come PDF o DOCX e riprova.')
  if (signature !== 'pdf') throw new DocumentReaderError('corrupt', 'Il file non è un PDF valido.')
}

/** SHA-256 esadecimale minuscolo dei byte originali, calcolato prima di interpretarli. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  let hex = ''
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0')
  return hex
}
