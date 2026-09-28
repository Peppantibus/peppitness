/**
 * Entry del worker PDF (same-origin, caricato solo alla prima lettura da `worker-client.ts`).
 * Contiene soltanto il trasporto: la logica è nel motore `pdf.ts`, con PDF.js nello stesso thread.
 * Il modulo del worker di PDF.js, importato dal motore, pubblica un proprio messaggio di avvio:
 * il client lo ignora perché non appartiene al protocollo dei reader.
 */
import { PDFJS_ASSET_DIRECTORY } from './pdf-assets.ts'
import { readPdf } from './pdf.ts'
import { serveDocumentReader, type ReaderWorkerScope } from './worker-protocol.ts'

const scope = globalThis as unknown as ReaderWorkerScope & { location: { href: string } }
const decoderAssetsUrl = new URL(`/${PDFJS_ASSET_DIRECTORY}/`, scope.location.href).href
serveDocumentReader(scope, input => readPdf(input, { decoderAssetsUrl }))
