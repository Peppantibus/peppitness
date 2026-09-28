/**
 * Protocollo dei reader DOCX/PDF (implementazioni nei task 03–05). Il risultato separa il
 * NormalizedDocument, l'unico inviato al server, dai metadati di lettura che restano sul dispositivo.
 */
import {
  normalizedDocumentSchema, readerVersionSchema, readingIssueCodeSchema, sourceBlockIdSchema, TEXT_NORMALIZATION_VERSION, validateNormalizedDocument,
  type NormalizedDocument,
} from './normalized-document.ts'
import { array, contractLimits, enumeration, errorList, literal, nullable, number, object, validate, type Infer, type ValidationResult } from './schema.ts'

export const documentFormats = ['docx', 'pdf'] as const
export type DocumentFormat = typeof documentFormats[number]

/** Byte locali e soli metadati non sensibili: niente nome del file, che può contenere dati personali. */
export interface DocumentReaderInput {
  bytes: Uint8Array
  metadata: { format: DocumentFormat; mediaType: string | null }
  signal: AbortSignal
}

export const readerComponentKinds = ['body', 'page', 'header', 'footer', 'footnotes', 'endnotes', 'comments', 'text_box', 'image', 'embedded_object'] as const
export const readerComponentStatuses = ['read', 'partial', 'not_read', 'no_text'] as const

/**
 * Inventario di pagine e componenti, anche senza blocchi di testo. Ogni area non letta per
 * intero dichiara codici presenti nei readingIssues: nessun testo OCR inventato.
 */
export const readerInventoryEntrySchema = object({
  id: sourceBlockIdSchema,
  kind: enumeration(readerComponentKinds),
  page: nullable(number({ integer: true, minimum: 1 })),
  status: enumeration(readerComponentStatuses),
  blockIds: array(sourceBlockIdSchema, { maxItems: contractLimits.largeItems }),
  issueCodes: array(readingIssueCodeSchema, { maxItems: contractLimits.refsPerItem }),
})
export const documentReadMetadataSchema = object({
  readerVersion: readerVersionSchema,
  format: enumeration(documentFormats),
  textNormalizationVersion: literal(TEXT_NORMALIZATION_VERSION),
  byteLength: number({ integer: true, minimum: 0 }),
  /** Solo se il formato ha pagine reali: null per DOCX. */
  pageCount: nullable(number({ integer: true, minimum: 1 })),
  inventory: array(readerInventoryEntrySchema, { maxItems: contractLimits.items }),
})
export const documentReadResultSchema = object({ document: normalizedDocumentSchema, metadata: documentReadMetadataSchema })

export type ReaderInventoryEntry = Infer<typeof readerInventoryEntrySchema>
export type DocumentReadMetadata = Infer<typeof documentReadMetadataSchema>
export interface DocumentReadResult { document: NormalizedDocument; metadata: DocumentReadMetadata }

export interface DocumentReader {
  readonly format: DocumentFormat
  readonly readerVersion: string
  /** Rifiuta con DocumentReaderError; la cancellazione del signal produce `cancelled`. */
  read(input: DocumentReaderInput): Promise<DocumentReadResult>
}

export const readerErrorCodes = ['unsupported', 'corrupt', 'limit_exceeded', 'cancelled'] as const
export type ReaderErrorCode = typeof readerErrorCodes[number]
export interface ReaderLimitDetail { limit: string; max: number; actual: number | null }

export class DocumentReaderError extends Error {
  readonly code: ReaderErrorCode
  readonly limit: ReaderLimitDetail | null
  constructor(code: ReaderErrorCode, message: string, limit: ReaderLimitDetail | null = null) {
    super(message)
    this.name = 'DocumentReaderError'
    this.code = code
    this.limit = code === 'limit_exceeded' ? limit : null
  }
}
export const isDocumentReaderError = (error: unknown): error is DocumentReaderError => error instanceof DocumentReaderError

/** Punto di controllo fra le fasi del reader: una lettura annullata non produce un documento parziale. */
export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DocumentReaderError('cancelled', 'Lettura annullata.')
}

/** Risultato di un reader, anche ricevuto da un worker: documento valido e metadati coerenti con esso. */
export function validateDocumentReadResult(value: unknown): ValidationResult<DocumentReadResult> {
  const shape = validate(documentReadResultSchema, value)
  if (!shape.ok) return shape
  const document = validateNormalizedDocument(shape.value.document)
  if (!document.ok) return { ok: false, errors: document.errors.map(error => ({ ...error, path: `/document${error.path}` })) }

  const { metadata } = shape.value
  const errors = errorList()
  if (metadata.readerVersion !== document.value.readerVersion) errors.add('/metadata/readerVersion', 'reader_mismatch', 'Versione del reader diversa da quella del documento.')
  if (metadata.format === 'docx') {
    if (metadata.pageCount !== null) errors.add('/metadata/pageCount', 'reader_mismatch', 'Un DOCX non ha pagine affidabili.')
    document.value.blocks.forEach((block, index) => {
      if (block.page !== null) errors.add(`/document/blocks/${index}/page`, 'reader_mismatch', 'Pagina inventata in un DOCX.')
    })
  } else if (metadata.pageCount === null) errors.add('/metadata/pageCount', 'reader_mismatch', 'Un PDF dichiara il numero di pagine.')
  if (metadata.pageCount !== null) {
    const pageCount = metadata.pageCount
    document.value.blocks.forEach((block, index) => {
      if (block.page !== null && block.page > pageCount) errors.add(`/document/blocks/${index}/page`, 'reader_mismatch', 'Pagina oltre il numero di pagine.')
    })
  }

  const blockIds = new Set(document.value.blocks.map(block => block.id))
  const issueCodes = new Set(document.value.readingIssues.map(issue => issue.code))
  const entryIds = new Set<string>()
  metadata.inventory.forEach((entry, index) => {
    const at = `/metadata/inventory/${index}`
    if (entryIds.has(entry.id)) errors.add(`${at}/id`, 'duplicate_id', `Componente ripetuto: ${entry.id}.`)
    entryIds.add(entry.id)
    if (entry.page !== null && (metadata.pageCount === null || entry.page > metadata.pageCount)) errors.add(`${at}/page`, 'inventory', 'Pagina non presente nel documento.')
    entry.blockIds.forEach((id, position) => { if (!blockIds.has(id)) errors.add(`${at}/blockIds/${position}`, 'dangling_ref', `Blocco inesistente: ${id}.`) })
    entry.issueCodes.forEach((code, position) => { if (!issueCodes.has(code)) errors.add(`${at}/issueCodes/${position}`, 'inventory', `Codice ${code} assente dai readingIssues.`) })
    if (entry.status === 'no_text' && entry.blockIds.length) errors.add(`${at}/blockIds`, 'inventory', 'Un’area senza testo non ha blocchi.')
    if (entry.status !== 'read' && !entry.issueCodes.length) errors.add(`${at}/issueCodes`, 'inventory', 'Un’area non letta per intero deve restare visibile nei readingIssues.')
  })
  return errors.errors.length ? { ok: false, errors: errors.errors } : { ok: true, value: { document: document.value, metadata } }
}
