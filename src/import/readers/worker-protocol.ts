/**
 * Protocollo fra pagina e worker dei reader, indipendente dal formato: ogni messaggio porta un
 * `requestId`; il worker annulla la lettura su `cancel` e risponde comunque con un esito, che il
 * client ignora se la richiesta non è più attesa (risposta tardiva). Usato anche dal reader PDF.
 */
import {
  documentFormats, DocumentReaderError, readerErrorCodes,
  type DocumentFormat, type DocumentReaderInput, type DocumentReadResult, type ReaderErrorCode, type ReaderLimitDetail,
} from '../contracts/reader.ts'

export const READER_WORKER_PROTOCOL = 'peppitness.reader-worker.v1'

export type ReaderWorkerRequest =
  | { protocol: typeof READER_WORKER_PROTOCOL; type: 'read'; requestId: string; bytes: ArrayBuffer; metadata: DocumentReaderInput['metadata'] }
  | { protocol: typeof READER_WORKER_PROTOCOL; type: 'cancel'; requestId: string }

export interface SerializedReaderError { code: ReaderErrorCode; message: string; limit: ReaderLimitDetail | null }

export type ReaderWorkerResponse =
  | { protocol: typeof READER_WORKER_PROTOCOL; type: 'result'; requestId: string; result: DocumentReadResult }
  | { protocol: typeof READER_WORKER_PROTOCOL; type: 'error'; requestId: string; error: SerializedReaderError }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isRequestId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 100

export function parseWorkerRequest(value: unknown): ReaderWorkerRequest | null {
  if (!isRecord(value) || value.protocol !== READER_WORKER_PROTOCOL || !isRequestId(value.requestId)) return null
  if (value.type === 'cancel') return { protocol: READER_WORKER_PROTOCOL, type: 'cancel', requestId: value.requestId }
  if (value.type !== 'read' || !(value.bytes instanceof ArrayBuffer) || !isRecord(value.metadata)) return null
  const { format, mediaType } = value.metadata
  if (!documentFormats.includes(format as DocumentFormat) || (mediaType !== null && typeof mediaType !== 'string')) return null
  return { protocol: READER_WORKER_PROTOCOL, type: 'read', requestId: value.requestId, bytes: value.bytes, metadata: { format: format as DocumentFormat, mediaType } }
}

/** Risposta del worker; il risultato viene poi validato dal client con il contratto. */
export function parseWorkerResponse(value: unknown): ReaderWorkerResponse | null {
  if (!isRecord(value) || value.protocol !== READER_WORKER_PROTOCOL || !isRequestId(value.requestId)) return null
  if (value.type === 'result' && isRecord(value.result)) return value as unknown as ReaderWorkerResponse
  if (value.type !== 'error' || !isRecord(value.error)) return null
  const { code, message, limit } = value.error
  if (!readerErrorCodes.includes(code as ReaderErrorCode) || typeof message !== 'string') return null
  const detail = isRecord(limit) && typeof limit.limit === 'string' && typeof limit.max === 'number' && (typeof limit.actual === 'number' || limit.actual === null)
    ? { limit: limit.limit, max: limit.max, actual: limit.actual } : null
  return { protocol: READER_WORKER_PROTOCOL, type: 'error', requestId: value.requestId, error: { code: code as ReaderErrorCode, message: message.slice(0, 1000), limit: detail } }
}

/** Errore serializzabile: gli errori imprevisti non espongono dettagli interni né testo del file. */
export function serializeReaderError(error: unknown): SerializedReaderError {
  if (error instanceof DocumentReaderError) return { code: error.code, message: error.message, limit: error.limit }
  return { code: 'corrupt', message: 'Il documento non può essere letto.', limit: null }
}

export const deserializeReaderError = (error: SerializedReaderError) => new DocumentReaderError(error.code, error.message, error.limit)

/** Superficie minima del contesto del worker, senza dipendere dai tipi DOM o WebWorker. */
export interface ReaderWorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(message: ReaderWorkerResponse): void
}

export type ReadFunction = (input: DocumentReaderInput) => Promise<DocumentReadResult>

/** Lato worker: una AbortController per richiesta; `cancel` interrompe la lettura in corso. */
export function serveDocumentReader(scope: ReaderWorkerScope, read: ReadFunction): void {
  const active = new Map<string, AbortController>()
  scope.onmessage = event => {
    const request = parseWorkerRequest(event.data)
    if (!request) return
    if (request.type === 'cancel') { active.get(request.requestId)?.abort(); return }
    if (active.has(request.requestId)) return
    const controller = new AbortController()
    active.set(request.requestId, controller)
    const input: DocumentReaderInput = { bytes: new Uint8Array(request.bytes), metadata: request.metadata, signal: controller.signal }
    void read(input).then(
      result => scope.postMessage({ protocol: READER_WORKER_PROTOCOL, type: 'result', requestId: request.requestId, result }),
      (error: unknown) => scope.postMessage({ protocol: READER_WORKER_PROTOCOL, type: 'error', requestId: request.requestId, error: controller.signal.aborted ? { code: 'cancelled', message: 'Lettura annullata.', limit: null } : serializeReaderError(error) }),
    ).finally(() => active.delete(request.requestId))
  }
}
