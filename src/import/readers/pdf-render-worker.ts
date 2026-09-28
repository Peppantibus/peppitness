/**
 * Worker di PDF.js per il rendering delle pagine sul thread principale (`pdf-render.ts`): il
 * modulo si collega da solo ai messaggi del worker. Same-origin, caricato solo al primo rendering.
 */
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
