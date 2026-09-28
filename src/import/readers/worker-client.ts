/**
 * Client dei reader in worker: implementa `DocumentReader` sul thread principale, crea il worker
 * solo alla prima lettura (caricamento lazy del motore) e ne gestisce richieste, annullamento e
 * chiusura. Il risultato ricevuto viene sempre rivalidato con il contratto.
 *
 * Annullamento: il `signal` rifiuta subito la promessa con `cancelled` e invia `cancel` al worker;
 * se il worker non conferma entro il tempo di grazia viene terminato e ricreato alla lettura
 * successiva. Una risposta tardiva di una richiesta annullata è ignorata.
 */
import { DocumentReaderError, validateDocumentReadResult, type DocumentFormat, type DocumentReader, type DocumentReaderInput, type DocumentReadResult } from '../contracts/reader.ts'
import { DOCX_READER_VERSION } from './docx-version.ts'
import { deserializeReaderError, parseWorkerResponse, READER_WORKER_PROTOCOL, type ReaderWorkerRequest } from './worker-protocol.ts'

/** Superficie di `Worker` usata dal client; sostituibile nei test. */
export interface ReaderWorkerHandle {
  onmessage: ((event: { data: unknown }) => void) | null
  onerror: ((event: unknown) => void) | null
  onmessageerror: ((event: unknown) => void) | null
  postMessage(message: ReaderWorkerRequest, transfer: Transferable[]): void
  terminate(): void
}

export type ReaderWorkerFailure = 'worker_failed' | 'invalid_response' | 'worker_restarted'

/** Guasto del trasporto, distinto dai problemi del file (`DocumentReaderError`). */
export class ReaderWorkerError extends Error {
  readonly reason: ReaderWorkerFailure
  constructor(reason: ReaderWorkerFailure, message: string) {
    super(message)
    this.name = 'ReaderWorkerError'
    this.reason = reason
  }
}

export interface WorkerDocumentReaderOptions {
  format: DocumentFormat
  readerVersion: string
  createWorker: () => ReaderWorkerHandle
  /** Tempo concesso al worker per confermare un annullamento prima di terminarlo. */
  cancelGraceMilliseconds?: number
  createRequestId?: () => string
}

export interface WorkerDocumentReader extends DocumentReader {
  /** Termina il worker e rifiuta le letture in corso con `cancelled`. */
  close(): void
}

interface Pending { resolve: (result: DocumentReadResult) => void; reject: (error: unknown) => void; cleanup: () => void }

export function createWorkerDocumentReader(options: WorkerDocumentReaderOptions): WorkerDocumentReader {
  const grace = options.cancelGraceMilliseconds ?? 2000
  let sequence = 0
  const nextId = options.createRequestId ?? (() => `${options.format}-${Date.now().toString(36)}-${++sequence}`)
  let worker: ReaderWorkerHandle | null = null
  const pending = new Map<string, Pending>()
  const cancelling = new Map<string, ReturnType<typeof setTimeout>>()

  /** Chiude il worker corrente e rifiuta ciò che vi era in corso. */
  const shutdown = (error: () => unknown) => {
    const current = worker
    worker = null
    if (current) { current.onmessage = null; current.onerror = null; current.onmessageerror = null; current.terminate() }
    cancelling.forEach(timer => clearTimeout(timer))
    cancelling.clear()
    const entries = [...pending.values()]
    pending.clear()
    for (const entry of entries) { entry.cleanup(); entry.reject(error()) }
  }

  const receive = (data: unknown) => {
    const response = parseWorkerResponse(data)
    if (!response) return
    const timer = cancelling.get(response.requestId)
    if (timer !== undefined) { clearTimeout(timer); cancelling.delete(response.requestId); return }
    const entry = pending.get(response.requestId)
    if (!entry) return
    pending.delete(response.requestId)
    entry.cleanup()
    if (response.type === 'error') { entry.reject(deserializeReaderError(response.error)); return }
    const checked = validateDocumentReadResult(response.result)
    if (!checked.ok || checked.value.metadata.format !== options.format || checked.value.metadata.readerVersion !== options.readerVersion) {
      entry.reject(new ReaderWorkerError('invalid_response', 'Il lettore ha restituito un risultato non valido.'))
    } else entry.resolve(checked.value)
  }

  const ensureWorker = () => {
    if (worker) return worker
    const created = options.createWorker()
    const failed = () => shutdown(() => new ReaderWorkerError('worker_failed', 'Il lettore dei documenti si è interrotto.'))
    created.onmessage = event => receive(event.data)
    created.onerror = failed
    created.onmessageerror = failed
    worker = created
    return created
  }

  return {
    format: options.format,
    readerVersion: options.readerVersion,
    read(input: DocumentReaderInput) {
      return new Promise<DocumentReadResult>((resolve, reject) => {
        if (input.metadata.format !== options.format) { reject(new DocumentReaderError('unsupported', 'Formato non gestito da questo lettore.')); return }
        if (input.signal.aborted) { reject(new DocumentReaderError('cancelled', 'Lettura annullata.')); return }
        const target = ensureWorker()
        const requestId = nextId()
        // Copia trasferita: i byte del chiamante restano utilizzabili.
        const bytes = input.bytes.slice().buffer
        const onAbort = () => {
          if (!pending.delete(requestId)) return
          cleanup()
          reject(new DocumentReaderError('cancelled', 'Lettura annullata.'))
          if (worker !== target) return
          target.postMessage({ protocol: READER_WORKER_PROTOCOL, type: 'cancel', requestId }, [])
          cancelling.set(requestId, setTimeout(() => {
            cancelling.delete(requestId)
            if (worker === target) shutdown(() => new ReaderWorkerError('worker_restarted', 'Il lettore è stato riavviato dopo un annullamento.'))
          }, grace))
        }
        const cleanup = () => input.signal.removeEventListener('abort', onAbort)
        input.signal.addEventListener('abort', onAbort, { once: true })
        pending.set(requestId, { resolve, reject, cleanup })
        target.postMessage({ protocol: READER_WORKER_PROTOCOL, type: 'read', requestId, bytes, metadata: { format: input.metadata.format, mediaType: input.metadata.mediaType } }, [bytes])
      })
    },
    close() { shutdown(() => new DocumentReaderError('cancelled', 'Lettore chiuso.')) },
  }
}

/** Reader DOCX nel worker module same-origin; il bundle del worker si scarica alla prima lettura. */
export function createDocxWorkerReader(options: { cancelGraceMilliseconds?: number } = {}): WorkerDocumentReader {
  return createWorkerDocumentReader({
    format: 'docx',
    readerVersion: DOCX_READER_VERSION,
    createWorker: () => new Worker(new URL('./docx-worker.ts', import.meta.url), { type: 'module' }) as unknown as ReaderWorkerHandle,
    ...options,
  })
}
