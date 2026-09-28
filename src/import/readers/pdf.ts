/**
 * Motore PDF puro (task 05): byte → NormalizedDocument + metadati di lettura, con PDF.js (build
 * legacy, compatibile con Safari 16) eseguito nello stesso thread: nel browser gira dentro il
 * worker del reader (`pdf-worker.ts`), nei test in Node. Nessuna rete: niente URL di font, CMap o
 * WebAssembly remoti; i decodificatori JavaScript di JBIG2/JPEG 2000 arrivano da asset locali.
 *
 * Ogni pagina è controllata: testo e coordinate (`getTextContent`), immagini e testo invisibile
 * (`getOperatorList`), annotazioni con testo. La geometria e la qualità sono in `pdf-layout.ts`.
 * Pagine senza testo, immagini estese senza testo, font senza mappa Unicode e pagine danneggiate
 * restano nell'inventario con il loro problema: nessun OCR, nessuna pagina omessa in silenzio.
 * Il file originale non lascia mai il dispositivo.
 */
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs'
// Motore di PDF.js nello stesso thread (niente worker annidati): registra `globalThis.pdfjsWorker`.
import 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import { defaultImportLimits, type ImportLimits } from '../contracts/jobs.ts'
import { TEXT_NORMALIZATION_VERSION } from '../contracts/normalized-document.ts'
import { DocumentReaderError, validateDocumentReadResult, type DocumentReader, type DocumentReaderInput, type DocumentReadResult } from '../contracts/reader.ts'
import { checkPdfBytes, sha256Hex } from './file-checks.ts'
import { assembleDocument, layoutPage, type DamagedPage, type LayoutImage, type LayoutItem, type PageLayout } from './pdf-layout.ts'
import { PDF_READER_VERSION } from './pdf-version.ts'
import { ReadControl } from './read-control.ts'

export { PDF_READER_VERSION }

export const defaultPdfReaderLimits = {
  /** Tempo massimo di una lettura, pause comprese. */
  readMilliseconds: 30_000,
} as const

export interface PdfReaderOptions {
  limits?: ImportLimits
  maxMilliseconds?: number
  now?: () => number
  /**
   * URL della cartella con i decodificatori JavaScript di PDF.js (`pdf-assets.ts`), terminato da
   * `/`. Nel worker è `/pdfjs/` sulla stessa origine; nei test la cartella `wasm` del pacchetto.
   */
  decoderAssetsUrl?: string
}

type Matrix = [number, number, number, number, number, number]
const identity: Matrix = [1, 0, 0, 1, 0, 0]
const multiply = (m: Matrix, n: readonly number[]): Matrix => pdfjs.Util.transform(m, n) as Matrix

/** Opzioni di PDF.js: niente WebAssembly (CSP), niente fetch, errori di contenuto visibili. PDF.js 6 non usa eval. */
function documentOptions(bytes: Uint8Array, assets: string | undefined) {
  return {
    data: bytes,
    useWasm: false,
    wasmUrl: assets,
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: true,
    verbosity: 0,
  }
}

const textOperations = new Set([pdfjs.OPS.showText, pdfjs.OPS.showSpacedText, pdfjs.OPS.nextLineShowText, pdfjs.OPS.nextLineSetSpacingShowText])
/** Operazioni che lasciano un segno visibile (testo, immagini, tracciati, sfumature). */
const paintOperations = new Set([
  pdfjs.OPS.constructPath, pdfjs.OPS.rawFillPath, pdfjs.OPS.fill, pdfjs.OPS.eoFill, pdfjs.OPS.stroke, pdfjs.OPS.closeStroke, pdfjs.OPS.fillStroke,
  pdfjs.OPS.eoFillStroke, pdfjs.OPS.closeFillStroke, pdfjs.OPS.closeEOFillStroke, pdfjs.OPS.shadingFill, pdfjs.OPS.paintSolidColorImageMask,
])
const imageOperations = new Set([
  pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject,
  pdfjs.OPS.paintInlineImageXObjectGroup, pdfjs.OPS.paintImageMaskXObjectGroup, pdfjs.OPS.paintImageXObjectRepeat, pdfjs.OPS.paintImageMaskXObjectRepeat,
])

type PdfPage = Awaited<ReturnType<Awaited<ReturnType<typeof pdfjs.getDocument>['promise']>['getPage']>>

/** Immagini (con la trasformazione corrente) e operazioni di testo invisibile dall'elenco delle operazioni. */
async function drawnContent(page: PdfPage, viewport: { transform: number[] }) {
  const list = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.DISABLE })
  const images: LayoutImage[] = []
  const stack: { ctm: Matrix; mode: number }[] = []
  let ctm = identity
  let mode = 0
  let invisible = 0
  let drawn = false
  list.fnArray.forEach((operation, index) => {
    if (paintOperations.has(operation) || textOperations.has(operation) || imageOperations.has(operation)) drawn = true
    const args = list.argsArray[index] as unknown[] | null
    switch (operation) {
      case pdfjs.OPS.save: stack.push({ ctm, mode }); break
      case pdfjs.OPS.restore: { const state = stack.pop(); if (state) ({ ctm, mode } = state); break }
      case pdfjs.OPS.transform: if (args && args.length >= 6) ctm = multiply(ctm, args as number[]); break
      case pdfjs.OPS.paintFormXObjectBegin: {
        stack.push({ ctm, mode })
        const matrix = args?.[0]
        if (Array.isArray(matrix) || ArrayBuffer.isView(matrix)) ctm = multiply(ctm, Array.from(matrix as ArrayLike<number>))
        break
      }
      case pdfjs.OPS.paintFormXObjectEnd: { const state = stack.pop(); if (state) ({ ctm, mode } = state); break }
      case pdfjs.OPS.setTextRenderingMode: mode = Number(args?.[0] ?? 0); break
      default:
        if (textOperations.has(operation) && (mode === 3 || mode === 7)) invisible++
        if (imageOperations.has(operation)) {
          const m = multiply(viewport.transform as Matrix, ctm)
          const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [m[0] * x! + m[2] * y! + m[4], m[1] * x! + m[3] * y! + m[5]] as const)
          images.push({ x0: Math.min(...points.map(([x]) => x)), x1: Math.max(...points.map(([x]) => x)), y0: Math.min(...points.map(([, y]) => y)), y1: Math.max(...points.map(([, y]) => y)) })
        }
    }
  })
  return { images, invisible, drawn }
}

/** Una pagina: testo con coordinate nella pagina visualizzata (rotazione compresa), immagini, annotazioni. */
async function readPage(page: PdfPage, pageNumber: number): Promise<PageLayout> {
  const viewport = page.getViewport({ scale: 1 })
  const content = await page.getTextContent({ includeMarkedContent: false })
  const items: LayoutItem[] = []
  for (const item of content.items) {
    if (!('str' in item) || !item.str) continue
    const t = multiply(viewport.transform as Matrix, item.transform as number[])
    items.push({ text: item.str, x: t[4], y: t[5], width: item.width, size: Math.hypot(t[2], t[3]), angle: Math.atan2(t[1], t[0]) })
  }
  const { images, invisible, drawn } = await drawnContent(page, viewport)
  const annotations = (await page.getAnnotations({ intent: 'display' })).filter((annotation: Record<string, unknown>) => {
    const contents = (annotation.contentsObj as { str?: unknown } | undefined)?.str
    const value = annotation.fieldValue
    return (typeof contents === 'string' && /\S/.test(contents)) || (typeof value === 'string' && /\S/.test(value))
  }).length
  return layoutPage({ page: pageNumber, width: viewport.width, height: viewport.height, items, images, invisibleText: invisible, annotations, drawn })
}

const errorName = (error: unknown) => (typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '')

export async function readPdf(input: DocumentReaderInput, options: PdfReaderOptions = {}): Promise<DocumentReadResult> {
  const limits = options.limits ?? defaultImportLimits
  const maxMilliseconds = options.maxMilliseconds ?? defaultPdfReaderLimits.readMilliseconds
  const control = new ReadControl(input.signal, { maxMilliseconds, now: options.now })
  control.check()
  if (input.metadata.format !== 'pdf') throw new DocumentReaderError('unsupported', 'Il lettore PDF riceve soltanto documenti PDF.')
  const bytes = input.bytes
  checkPdfBytes(bytes, limits)
  // Impronta dei byte originali prima di qualsiasi interpretazione.
  const sourceHash = await sha256Hex(bytes)
  control.check()

  // PDF.js può trasferire il buffer che riceve: gli passa una copia.
  const task = pdfjs.getDocument(documentOptions(bytes.slice(), options.decoderAssetsUrl))
  // Annullamento e tempo massimo interrompono anche un'attesa lunga dentro PDF.js.
  let stop: ((error: DocumentReaderError) => void) | null = null
  const stopped = new Promise<never>((_, reject) => { stop = reject })
  stopped.catch(() => {})
  const onAbort = () => stop?.(new DocumentReaderError('cancelled', 'Lettura annullata.'))
  input.signal.addEventListener('abort', onAbort, { once: true })
  const deadline = setTimeout(() => stop?.(new DocumentReaderError('limit_exceeded', 'Lettura interrotta: tempo massimo superato.', { limit: 'readMilliseconds', max: maxMilliseconds, actual: null })), maxMilliseconds)
  const guard = <T>(promise: Promise<T>) => Promise.race([promise, stopped])

  try {
    const pdfDocument = await guard(task.promise)
    const pageCount = pdfDocument.numPages
    if (pageCount > limits.pdfPages) {
      throw new DocumentReaderError('limit_exceeded', `Il PDF ha ${pageCount} pagine: il massimo è ${limits.pdfPages}. Dividi il documento e importa le pagine della scheda o della dieta.`, { limit: 'pdfPages', max: limits.pdfPages, actual: pageCount })
    }
    const pages: (PageLayout | DamagedPage)[] = []
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      await control.pause()
      let page: PdfPage | null = null
      try {
        page = await guard(pdfDocument.getPage(pageNumber))
        pages.push(await guard(readPage(page, pageNumber)))
      } catch (error) {
        if (error instanceof DocumentReaderError || input.signal.aborted) throw error
        // Contenuto della pagina non interpretabile: la pagina resta, segnalata come non letta.
        pages.push({ page: pageNumber, damaged: true })
      } finally {
        page?.cleanup()
      }
    }
    control.check()
    const assembled = assembleDocument(pages)
    const result = {
      document: { readerVersion: PDF_READER_VERSION, sourceHash, blocks: assembled.blocks, readingIssues: assembled.readingIssues },
      metadata: { readerVersion: PDF_READER_VERSION, format: 'pdf' as const, textNormalizationVersion: TEXT_NORMALIZATION_VERSION, byteLength: bytes.byteLength, pageCount, inventory: assembled.inventory },
    }
    const checked = validateDocumentReadResult(result)
    if (!checked.ok) throw new DocumentReaderError('corrupt', `Lettura non conforme al contratto: ${checked.errors[0]?.path} ${checked.errors[0]?.code}.`)
    control.check()
    return checked.value
  } catch (error) {
    if (input.signal.aborted) throw new DocumentReaderError('cancelled', 'Lettura annullata.')
    if (error instanceof DocumentReaderError) throw error
    const name = errorName(error)
    if (name === 'PasswordException') throw new DocumentReaderError('unsupported', 'Il PDF è protetto da password: salvane una copia senza protezione e riprova.')
    if (name === 'InvalidPDFException') throw new DocumentReaderError('corrupt', 'Il file non è un PDF valido o è danneggiato.')
    throw new DocumentReaderError('corrupt', 'Il PDF non può essere letto: il file potrebbe essere danneggiato.')
  } finally {
    clearTimeout(deadline)
    input.signal.removeEventListener('abort', onAbort)
    // Rilascia pagine, documento e memoria di PDF.js anche dopo un errore o un annullamento.
    await task.destroy().catch(() => {})
  }
}

export const pdfReader: DocumentReader = {
  format: 'pdf',
  readerVersion: PDF_READER_VERSION,
  read: input => readPdf(input),
}
