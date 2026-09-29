import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import type { NormalizedDocument, SourceBlock } from '../../import/contracts/index.ts'
import { openPdfSourceView, type PdfSourceView } from '../../import/readers/pdf-render.ts'
import {
  blockAtPoint, blocksOnPage, buildSourceItems, isTextBox, issuesByBlock, pageNumbers, sourceSectionTitles,
  type CellLayout, type SourceItem, type TableLayout,
} from './source-model'
import './import.css'

/**
 * Pannello della fonte letta (task 11), componente controllato: mostra solo ciò che il reader ha prodotto,
 * come testo React (mai HTML del documento). DOCX: paragrafi, tabelle con celle unite e annidate, caselle,
 * intestazioni e note. PDF: testo per pagina e, se l'originale è in memoria, la pagina con i riquadri dei
 * blocchi. `selectedId`/`highlightIds`/`onSelect` sono gli agganci per le citazioni della revisione (12/13).
 */
export interface SourceViewerProps {
  document: NormalizedDocument
  format: 'docx' | 'pdf'
  /** Byte del PDF originale, solo in memoria; null dopo una ripresa senza riselezione. */
  original?: Uint8Array | null
  /** Pagine note dal reader; senza, quelle dell'originale o dei blocchi. */
  pageCount?: number | null
  selectedId?: string | null
  /** Blocchi da evidenziare (per esempio le citazioni di un campo). */
  highlightIds?: readonly string[]
  /** Rende selezionabili i blocchi (e la pagina PDF): per consultare la loro posizione. */
  onSelect?: (blockId: string) => void
  /** Al posto della pagina PDF quando l'originale non è disponibile: spiegazione e riselezione. */
  originalUnavailable?: ReactNode
  /** Etichetta accessibile della regione. */
  label?: string
}

interface Marks { selectedId: string | null; highlight: ReadonlySet<string>; issues: ReadonlyMap<string, string[]>; onSelect?: (id: string) => void }

export function SourceViewer({ document, format, original = null, pageCount = null, selectedId = null, highlightIds = [], onSelect, originalUnavailable, label = 'Testo letto dal documento' }: SourceViewerProps) {
  const root = useRef<HTMLDivElement>(null)
  const issues = useMemo(() => issuesByBlock(document), [document])
  const highlight = useMemo(() => new Set(highlightIds), [highlightIds])
  const marks: Marks = { selectedId, highlight, issues, onSelect }

  // Il blocco scelto (anche dal pannello dei problemi) si porta in vista e riceve il focus.
  useEffect(() => {
    if (!selectedId) return
    const frame = requestAnimationFrame(() => {
      const element = root.current?.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(selectedId)}"]`)
      if (!element) return
      element.scrollIntoView({ block: 'center', behavior: 'smooth' })
      element.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [selectedId])

  return <div className="source-viewer" ref={root} role="region" aria-label={label}>
    {format === 'pdf'
      ? <PdfSource document={document} original={original} pageCount={pageCount} marks={marks} originalUnavailable={originalUnavailable} />
      : <SourceItems items={buildSourceItems(document.blocks)} marks={marks} />}
  </div>
}

// ---------------------------------------------------------------------------
// Testo: blocchi e tabelle
// ---------------------------------------------------------------------------

function SourceItems({ items, marks }: { items: SourceItem[]; marks: Marks }) {
  if (!items.length) return <p className="source-empty">Nessun testo letto.</p>
  const out: ReactNode[] = []
  let section: SourceItem['section'] | null = null
  items.forEach((item, index) => {
    if (item.section !== section) {
      if (section !== null || item.section !== 'body') out.push(<h3 className="source-section" key={`section-${index}`}>{sourceSectionTitles[item.section]}</h3>)
      section = item.section
    }
    out.push(item.type === 'table' ? <SourceTable key={item.table.id} table={item.table} marks={marks} /> : <BlockView key={item.block.id} block={item.block} marks={marks} />)
  })
  return <div className="source-items">{out}</div>
}

function blockClass(block: SourceBlock, marks: Marks) {
  return [
    'source-block', `is-${block.kind.replace('_', '-')}`, isTextBox(block.id) ? 'is-box' : '',
    marks.selectedId === block.id ? 'is-selected' : '', marks.highlight.has(block.id) ? 'is-highlighted' : '', marks.issues.has(block.id) ? 'has-issue' : '',
  ].filter(Boolean).join(' ')
}

/** Contenuto testuale del blocco: sempre nodo di testo React, a capo conservati dal CSS. */
function BlockText({ block, marks }: { block: SourceBlock; marks: Marks }) {
  return <>
    {isTextBox(block.id) && <span className="source-tag">Casella di testo</span>}
    {marks.issues.has(block.id) && <span className="sr-only">Con avviso di lettura: </span>}
    <span className="source-text">{block.text || '—'}</span>
  </>
}

function BlockView({ block, marks }: { block: SourceBlock; marks: Marks }) {
  const selected = marks.selectedId === block.id
  if (marks.onSelect) {
    const select = marks.onSelect
    return <button type="button" className={blockClass(block, marks)} data-block-id={block.id} aria-current={selected ? 'true' : undefined} onClick={() => select(block.id)}><BlockText block={block} marks={marks} /></button>
  }
  return <div className={blockClass(block, marks)} data-block-id={block.id} tabIndex={selected || marks.highlight.has(block.id) ? -1 : undefined}><BlockText block={block} marks={marks} /></div>
}

function SourceTable({ table, marks }: { table: TableLayout; marks: Marks }) {
  return <div className="source-table-wrap" role="group" aria-label={`Tabella, ${table.rows.length} righe`}>
    <table className="source-table">
      <tbody>{table.rows.map(row => {
        const rowMarked = row.block && (marks.selectedId === row.block.id || marks.highlight.has(row.block.id))
        return <tr key={row.index} data-block-id={row.block?.id} tabIndex={rowMarked ? -1 : undefined}
          className={[rowMarked ? (marks.selectedId === row.block!.id ? 'is-selected' : 'is-highlighted') : '', row.block && marks.issues.has(row.block.id) ? 'has-issue' : ''].filter(Boolean).join(' ') || undefined}>
          {row.cells.map((cell, index) => <SourceCell key={cell.block?.id ?? `empty-${index}`} cell={cell} marks={marks} />)}
        </tr>
      })}</tbody>
    </table>
  </div>
}

function SourceCell({ cell, marks }: { cell: CellLayout; marks: Marks }) {
  const span = { rowSpan: cell.rowSpan > 1 ? cell.rowSpan : undefined, colSpan: cell.columnSpan > 1 ? cell.columnSpan : undefined }
  if (!cell.block) return <td {...span} className="is-filler" />
  const block = cell.block
  const merged = cell.rowSpan > 1 || cell.columnSpan > 1
  return <td {...span} className={merged ? 'is-merged' : undefined}>
    {block.text || cell.nested.length === 0 ? <BlockView block={block} marks={marks} /> : null}
    {merged && <span className="sr-only">{cell.columnSpan > 1 ? `unita su ${cell.columnSpan} colonne` : ''}{cell.rowSpan > 1 ? ` unita su ${cell.rowSpan} righe` : ''}</span>}
    {cell.nested.map(table => <SourceTable key={table.id} table={table} marks={marks} />)}
  </td>
}

// ---------------------------------------------------------------------------
// PDF: pagina originale e testo della pagina
// ---------------------------------------------------------------------------

type ViewState = { status: 'opening' } | { status: 'open'; view: PdfSourceView } | { status: 'error'; message: string }

function PdfSource({ document, original, pageCount, marks, originalUnavailable }: { document: NormalizedDocument; original: Uint8Array | null; pageCount: number | null; marks: Marks; originalUnavailable?: ReactNode }) {
  const [view, setView] = useState<ViewState | null>(null)
  const [page, setPage] = useState(1)

  // L'originale si apre solo quando è in memoria; chiudere la vista rilascia worker e documento.
  useEffect(() => {
    if (!original) { setView(null); return }
    const controller = new AbortController()
    let opened: PdfSourceView | null = null
    let alive = true
    setView({ status: 'opening' })
    openPdfSourceView(original, { signal: controller.signal }).then(value => {
      if (!alive) { void value.close(); return }
      opened = value
      setView({ status: 'open', view: value })
    }, (error: unknown) => { if (alive) setView({ status: 'error', message: error instanceof Error ? error.message : 'Il PDF non può essere visualizzato.' }) })
    return () => { alive = false; controller.abort(); void opened?.close() }
  }, [original])

  const pages = pageNumbers(document, pageCount ?? (view?.status === 'open' ? view.view.pageCount : null))
  // Un blocco scelto altrove (problemi, citazioni) porta alla sua pagina.
  const selectedPage = marks.selectedId ? document.blocks.find(block => block.id === marks.selectedId)?.page ?? null : null
  useEffect(() => { if (selectedPage) setPage(selectedPage) }, [selectedPage])
  const current = Math.min(Math.max(1, page), Math.max(1, pages.length))
  const onPage = blocksOnPage(document.blocks, current)

  return <div className="source-pdf">
    {pages.length > 1 && <nav className="source-pages" aria-label="Pagine del documento">
      <button type="button" className="icon-button is-outlined" aria-label="Pagina precedente" disabled={current <= 1} onClick={() => setPage(current - 1)}><Icon name="back" size={20} /></button>
      <span aria-live="polite">Pagina {current} di {pages.length}</span>
      <button type="button" className="icon-button is-outlined" aria-label="Pagina successiva" disabled={current >= pages.length} onClick={() => setPage(current + 1)}><Icon name="arrow" size={20} /></button>
    </nav>}
    <div className="source-pdf-body">
      <div className="source-page-panel">
        {!original ? <div className="source-page-missing">{originalUnavailable ?? <p>La pagina originale non è disponibile: resta consultabile il testo letto.</p>}</div>
          : view?.status === 'error' ? <p className="source-page-missing" role="alert">La pagina non può essere visualizzata ({view.message}). Il testo letto resta consultabile.</p>
            : view?.status === 'open' ? <PdfPage view={view.view} page={current} blocks={onPage} marks={marks} />
              : <p className="source-page-missing" role="status">Preparo la pagina…</p>}
      </div>
      <div className="source-page-text">
        <h3 className="source-section">Testo letto, pagina {current}</h3>
        {onPage.length ? <SourceItems items={buildSourceItems(onPage)} marks={marks} /> : <p className="source-empty">Nessun testo letto in questa pagina.</p>}
      </div>
    </div>
  </div>
}

const MAX_CANVAS_WIDTH = 1600

function PdfPage({ view, page, blocks, marks }: { view: PdfSourceView; page: number; blocks: SourceBlock[]; marks: Marks }) {
  const holder = useRef<HTMLDivElement>(null)
  const [rendered, setRendered] = useState<{ page: number } | { error: string } | null>(null)

  useEffect(() => {
    const target = holder.current
    if (!target) return
    const controller = new AbortController()
    setRendered(null)
    // Tela nuova per ogni disegno: PDF.js non ammette due rendering sulla stessa tela.
    const canvas = window.document.createElement('canvas')
    canvas.className = 'source-canvas'
    canvas.setAttribute('role', 'img')
    canvas.setAttribute('aria-label', `Pagina ${page} del documento originale`)
    const width = Math.min(MAX_CANVAS_WIDTH, Math.max(320, target.clientWidth) * Math.min(2, window.devicePixelRatio || 1))
    void (async () => {
      // Prima stima su una pagina di formato comune, poi correzione se la pagina è molto diversa (orizzontale, piccola).
      let result = await view.renderPage(page, canvas, { scale: width / 612, signal: controller.signal })
      if (Math.abs(result.width - width) / width > 0.2) result = await view.renderPage(page, canvas, { scale: result.scale * width / result.width, signal: controller.signal })
      if (controller.signal.aborted) return
      target.replaceChildren(canvas)
      setRendered({ page })
    })().catch((error: unknown) => { if (!controller.signal.aborted) setRendered({ error: error instanceof Error ? error.message : 'Pagina non visualizzabile.' }) })
    return () => controller.abort()
  }, [view, page])

  const select = marks.onSelect
  const boxes = blocks.filter(block => block.bbox && (marks.selectedId === block.id || marks.highlight.has(block.id) || marks.issues.has(block.id)))
  const ready = rendered && 'page' in rendered && rendered.page === page
  return <div className="source-page">
    <div className={`source-page-canvas ${select ? 'is-selectable' : ''}`} onClick={select && ready ? event => {
      const rect = event.currentTarget.getBoundingClientRect()
      const found = blockAtPoint(blocks, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
      if (found) select(found.id)
    } : undefined}>
      <div ref={holder} className="source-canvas-holder" />
      {ready && <div className="source-boxes" aria-hidden="true">{boxes.map(block => {
        const [x, y, w, h] = block.bbox!
        const tone = marks.selectedId === block.id ? 'is-selected' : marks.highlight.has(block.id) ? 'is-highlighted' : 'has-issue'
        return <span key={block.id} className={`source-box ${tone}`} data-box-id={block.id} style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }} />
      })}</div>}
    </div>
    {!ready && (rendered && 'error' in rendered ? <p className="source-page-missing" role="alert">La pagina non può essere visualizzata ({rendered.error}). Il testo letto resta consultabile.</p> : <p className="source-page-missing" role="status">Disegno la pagina {page}…</p>)}
  </div>
}
