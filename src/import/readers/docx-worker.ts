/**
 * Entry del worker DOCX (same-origin, caricato solo alla prima lettura da `worker-client.ts`).
 * Contiene soltanto il trasporto: la logica è nel motore puro `docx.ts`.
 */
import { readDocx } from './docx.ts'
import { serveDocumentReader, type ReaderWorkerScope } from './worker-protocol.ts'

serveDocumentReader(globalThis as unknown as ReaderWorkerScope, input => readDocx(input))
