/**
 * Rendering lazy delle pagine PDF per il futuro pannello della fonte (task 11): PDF.js viene
 * scaricato solo alla prima apertura e analizza il file nel proprio worker same-origin
 * (`pdf-render-worker.ts`); il thread principale disegna soltanto sul canvas. I byte restano sul
 * dispositivo e non vengono conservati: chiudere la vista rilascia documento, pagine e worker.
 * Le bbox dei blocchi (normalizzate, origine in alto a sinistra) si proiettano sul canvas
 * moltiplicandole per larghezza e altezza restituite da `renderPage`.
 */
import { DocumentReaderError } from '../contracts/reader.ts'
import { PDFJS_ASSET_DIRECTORY } from './pdf-assets.ts'

/** Superficie del canvas usata dal rendering (HTMLCanvasElement o equivalente). */
export interface PdfCanvas { width: number; height: number; getContext(contextId: '2d'): unknown }
export interface RenderedPage { pageNumber: number; width: number; height: number; scale: number }

export interface PdfSourceView {
  readonly pageCount: number
  /** Disegna una pagina (da 1) nel canvas, ridimensionandolo; il signal annulla il rendering. */
  renderPage(pageNumber: number, canvas: PdfCanvas, options?: { scale?: number; signal?: AbortSignal }): Promise<RenderedPage>
  /** Rilascia documento, pagine e worker; la vista non è più utilizzabile. */
  close(): Promise<void>
}

const errorName = (error: unknown) => (typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '')

export async function openPdfSourceView(bytes: Uint8Array, options: { signal?: AbortSignal } = {}): Promise<PdfSourceView> {
  const signal = options.signal
  if (signal?.aborted) throw new DocumentReaderError('cancelled', 'Apertura annullata.')
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const worker = new Worker(new URL('./pdf-render-worker.ts', import.meta.url), { type: 'module' })
  const pdfWorker = new pdfjs.PDFWorker({ port: worker as never })
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    worker: pdfWorker,
    useWasm: false,
    wasmUrl: new URL(`/${PDFJS_ASSET_DIRECTORY}/`, globalThis.location.href).href,
    useWorkerFetch: false,
    enableXfa: false,
    verbosity: 0,
  })
  const release = async () => {
    await task.destroy().catch(() => {})
    pdfWorker.destroy()
    worker.terminate()
  }
  const onAbort = () => { void release() }
  signal?.addEventListener('abort', onAbort, { once: true })
  let pdf: Awaited<typeof task.promise>
  try {
    pdf = await task.promise
  } catch (error) {
    await release()
    if (signal?.aborted) throw new DocumentReaderError('cancelled', 'Apertura annullata.')
    if (errorName(error) === 'PasswordException') throw new DocumentReaderError('unsupported', 'Il PDF è protetto da password.')
    throw new DocumentReaderError('corrupt', 'Il PDF non può essere visualizzato.')
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  let closed = false
  return {
    pageCount: pdf.numPages,
    async renderPage(pageNumber, canvas, renderOptions = {}) {
      if (closed) throw new DocumentReaderError('cancelled', 'Vista chiusa.')
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > pdf.numPages) throw new RangeError('Pagina inesistente.')
      const scale = renderOptions.scale ?? 1
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale })
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const renderTask = page.render({ canvas: canvas as never, viewport })
      const cancel = () => renderTask.cancel()
      renderOptions.signal?.addEventListener('abort', cancel, { once: true })
      try {
        if (renderOptions.signal?.aborted) renderTask.cancel()
        await renderTask.promise
      } catch (error) {
        if (renderOptions.signal?.aborted || errorName(error) === 'RenderingCancelledException') throw new DocumentReaderError('cancelled', 'Rendering annullato.')
        throw new DocumentReaderError('corrupt', 'La pagina non può essere visualizzata.')
      } finally {
        renderOptions.signal?.removeEventListener('abort', cancel)
        page.cleanup()
      }
      return { pageNumber, width: canvas.width, height: canvas.height, scale }
    },
    async close() {
      if (closed) return
      closed = true
      await release()
    },
  }
}
