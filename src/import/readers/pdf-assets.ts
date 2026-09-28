/**
 * Decodificatori di PDF.js serviti come asset locali same-origin (task 05). PDF.js 6 decodifica
 * JBIG2/CCITT e JPEG 2000, frequenti nelle scansioni, con moduli WebAssembly: la CSP dell'app
 * (`script-src 'self'`, senza `wasm-unsafe-eval`) non li ammette, quindi il reader usa le versioni
 * JavaScript equivalenti (`useWasm: false`), caricate da questa cartella con import dinamico.
 * `vite.config.ts` le copia nella build con nomi stabili, perché PDF.js compone l'URL dal nome.
 */
export const PDFJS_ASSET_DIRECTORY = 'pdfjs'
export const PDFJS_DECODER_FILES = ['jbig2_nowasm_fallback.js', 'openjpeg_nowasm_fallback.js'] as const
