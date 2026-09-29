import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode, RefObject } from 'react'
import { Icon } from '../../components/Icon'
import { SubpageHeader } from '../../components/SubpageHeader'
import type { NormalizedDocument } from '../../import/contracts/index.ts'
import { acceptedFileTypes } from '../../import/readers/file-checks.ts'
import { IMPORT_INACTIVITY_DAYS } from '../../import/review/state.ts'
import type { ImportKind, ImportReviewState, ImportReviewStore, ImportSlot } from '../../persistence/import-review-store'
import { hasUnreadParts, ImportIssues, onlyScans } from './ImportIssues'
import { SourceViewer } from './SourceViewer'
import './import.css'

const copy = {
  workout: { title: 'Importa una scheda', short: 'Scheda di allenamento', back: '#/scheda/programmi', backLabel: 'Torna ai programmi', recognition: 'di sedute ed esercizi', saved: 'programmi', manual: '#/scheda/programmi/nuovo', manualLabel: 'crea il programma a mano' },
  diet: { title: 'Importa un piano alimentare', short: 'Piano alimentare', back: '#/dieta/piani', backLabel: 'Torna ai piani alimentari', recognition: 'di giornate e pasti', saved: 'piani alimentari', manual: '#/dieta/piani/nuovo', manualLabel: 'crea il piano a mano' },
} satisfies Record<ImportKind, unknown>
const formatNames = { docx: 'Documento Word (DOCX)', pdf: 'PDF' } as const

const sizeFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 })
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} byte`
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`
  return `${sizeFormat.format(bytes / (1024 * 1024))} MB`
}

function describe(document: NormalizedDocument, pageCount: number | null) {
  const tables = new Set(document.blocks.flatMap(block => block.tableId ? [block.tableId] : [])).size
  const text = document.blocks.filter(block => block.kind !== 'table_row' && block.kind !== 'table_cell').length
  const pages = pageCount ?? Math.max(0, ...document.blocks.map(block => block.page ?? 0))
  return [
    `${text} ${text === 1 ? 'blocco di testo' : 'blocchi di testo'}`,
    tables ? `${tables} ${tables === 1 ? 'tabella' : 'tabelle'}` : '',
    pages ? `${pages} ${pages === 1 ? 'pagina' : 'pagine'}` : '',
  ].filter(Boolean).join(' · ')
}

/**
 * Pagina d'importazione di un dominio (task 11): scelta del file, lettura sul dispositivo, problemi del
 * reader e fonte. Nessuna analisi o salvataggio: arriveranno come comandi espliciti (22), negli slot
 * `actions` (azioni del documento letto) e `review` (revisione, 12/13), vuoti in questa versione.
 */
export function ImportPlan({ kind, store, state, loadFailed, onRetryLoad, actions, review }: {
  kind: ImportKind
  store: ImportReviewStore | null
  state: ImportReviewState
  loadFailed: boolean
  onRetryLoad: () => void
  actions?: ReactNode
  review?: ReactNode
}) {
  const text = copy[kind]
  const slot = state.slots[kind]
  const session = slot.session
  const [selected, setSelected] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<readonly string[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const focusNext = useRef<'card' | 'picker' | null>(null)

  // Una nuova sessione azzera la selezione nella fonte.
  const sessionId = session?.sessionId ?? null
  useEffect(() => { setSelected(null); setHighlight([]) }, [sessionId])
  useEffect(() => {
    if (focusNext.current === 'card' && sessionId) { card.current?.focus(); focusNext.current = null }
    if (focusNext.current === 'picker' && !sessionId) { picker.current?.focus(); focusNext.current = null }
  }, [sessionId])

  const header = <>
    <SubpageHeader back={text.back} backLabel={text.backLabel} title={text.title} subtitle="Da un file Word (DOCX) o PDF, letto su questo dispositivo." />
    <nav className="import-kind" aria-label="Cosa importi">
      <a href="#/scheda/importa" aria-current={kind === 'workout' ? 'page' : undefined}><Icon name="dumbbell" size={20} />{copy.workout.short}</a>
      <a href="#/dieta/importa" aria-current={kind === 'diet' ? 'page' : undefined}><Icon name="fork" size={20} />{copy.diet.short}</a>
    </nav>
  </>
  if (!store) return <>{header}{loadFailed
    ? <section className="panel empty-state"><h2>Importazione non disponibile</h2><p role="alert">Non riesco ad aprire l’importazione. Controlla la connessione e riprova.</p><button className="button primary" onClick={onRetryLoad}>Riprova</button></section>
    : <section className="panel empty-state" role="status"><p>Preparo l’importazione…</p></section>}</>

  const choose = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return // selettore annullato: nulla cambia
    if (!session) focusNext.current = 'card'
    void store.select(kind, file)
  }
  const reattach = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file) void store.attachOriginal(kind, file)
  }
  const reading = Boolean(session && session.status === 'reading' && !session.document)
  const document = session?.document ?? null
  const announcement = reading ? 'Lettura del documento in corso.' : document ? 'Documento letto.' : ''

  return <>
    {header}
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    <section className="panel import-file" aria-labelledby="import-file-title">
      <h2 id="import-file-title">Documento</h2>
      {!session ? <label className="import-drop">
        <input ref={picker} type="file" className="import-file-input" accept={acceptedFileTypes} onChange={choose} />
        <span className="import-drop-icon" aria-hidden="true"><Icon name="plus" size={24} /></span>
        <strong>Scegli un file DOCX o PDF</strong>
        <small>Un solo file, fino a 10 MB (PDF fino a 30 pagine). Viene letto qui, sul dispositivo: il file non viene caricato.</small>
      </label> : <FileCard slot={slot} reading={reading} cardRef={card} onChoose={choose}
        onCancel={() => { focusNext.current = 'picker'; store.cancel(kind) }}
        onRemove={() => { focusNext.current = 'picker'; void store.remove(kind) }}
        onRetry={() => void store.retry(kind)} />}
      {slot.problem && <div className="import-callout is-danger" role="alert"><Icon name="alert" size={20} /><div><strong>{slot.problem.title}</strong><p>{slot.problem.message}</p></div></div>}
      {slot.notice && <p className={`import-notice is-${slot.notice.tone}`} role={slot.notice.tone === 'warning' ? 'alert' : undefined}>{slot.notice.text}</p>}
    </section>

    {session && document && <>
      <section className="panel import-summary" aria-labelledby="import-summary-title">
        <h2 id="import-summary-title">{onlyScans(document.readingIssues, document.blocks.length) ? 'Nessun testo letto' : hasUnreadParts(document.readingIssues) ? 'Documento letto in parte' : 'Documento letto'}</h2>
        <p className="import-counts">{describe(document, slot.metadata?.pageCount ?? null)}</p>
        <p>Per ora l’importazione si ferma alla lettura: il riconoscimento {text.recognition} dal testo non è ancora disponibile e nulla viene aggiunto ai tuoi {text.saved}. Puoi consultare qui sotto il testo letto, oppure <a className="text-link" href={text.manual}>{text.manualLabel}</a>.</p>
        <StorageLine slot={slot} onReload={() => void store.reload(kind)} />
        {actions}
      </section>
      <ImportIssues issues={document.readingIssues} blockCount={document.blocks.length} onShow={ids => { setHighlight(ids); setSelected(ids[0] ?? null) }} />
      {review}
      <section className="panel import-source" aria-labelledby="import-source-title">
        <h2 id="import-source-title">Fonte</h2>
        <p className="field-help">Il testo come è stato letto, senza interpretazioni.{session.file.format === 'pdf' ? ' Tocca un blocco per vederne la posizione nella pagina.' : ''}</p>
        <SourceViewer document={document} format={session.file.format} original={slot.original} pageCount={slot.metadata?.pageCount ?? null}
          selectedId={selected} highlightIds={highlight} onSelect={session.file.format === 'pdf' ? id => { setSelected(id); setHighlight([]) } : undefined}
          originalUnavailable={<>
            <p>Il file originale non viene conservato: per vedere le pagine scegli di nuovo lo stesso PDF. Il testo letto resta consultabile.</p>
            <label className="button secondary import-reattach">Riapri il PDF originale<input type="file" className="import-file-input" accept=".pdf,application/pdf" onChange={reattach} /></label>
          </>} />
      </section>
    </>}
  </>
}

function FileCard({ slot, reading, cardRef, onChoose, onCancel, onRemove, onRetry }: {
  slot: ImportSlot; reading: boolean; cardRef: RefObject<HTMLDivElement | null>
  onChoose: (event: ChangeEvent<HTMLInputElement>) => void; onCancel: () => void; onRemove: () => void; onRetry: () => void
}) {
  const session = slot.session!
  const status = reading ? 'Lettura sul dispositivo in corso…' : session.document ? (slot.restored ? 'Letto in precedenza su questo dispositivo' : 'Letto sul dispositivo') : 'Non letto'
  return <>
    <div className="import-file-card" ref={cardRef} tabIndex={-1} aria-busy={reading || undefined}>
      <span className="import-format" aria-hidden="true">{session.file.format.toUpperCase()}</span>
      <div className="import-file-copy">
        <strong className="import-file-name" title={session.file.name}>{session.file.name}</strong>
        <small>{formatNames[session.file.format]} · {formatBytes(session.file.size)}</small>
        <span className={`import-file-status ${reading ? 'is-reading' : session.document ? 'is-read' : 'is-failed'}`}>{reading && <span className="import-progress" aria-hidden="true" />}{status}</span>
      </div>
    </div>
    <div className="button-row import-file-actions">
      {!reading && slot.problem?.retry && slot.original && <button type="button" className="button primary import-retry" onClick={onRetry}>Riprova la lettura</button>}
      {/* Cambiare file durante la lettura la interrompe: vale solo il file scelto per ultimo. */}
      <label className="button secondary import-change">Cambia file<input type="file" className="import-file-input" accept={acceptedFileTypes} onChange={onChoose} /></label>
      {reading ? <button type="button" className="button secondary import-cancel" onClick={onCancel}>Annulla la lettura</button>
        : <button type="button" className="button secondary danger import-remove" onClick={onRemove}>Rimuovi</button>}
    </div>
  </>
}

function StorageLine({ slot, onReload }: { slot: ImportSlot; onReload: () => void }) {
  if (slot.storage === 'durable') return <p className="field-help import-storage"><Icon name="check" size={16} />La lettura resta su questo dispositivo per {IMPORT_INACTIVITY_DAYS} giorni senza attività, senza il file originale.</p>
  if (slot.storage === 'conflict') return <div className="import-callout is-warning"><Icon name="alert" size={20} /><div><p>{slot.storageMessage}</p><button type="button" className="button secondary" onClick={onReload}>Ricarica la lettura</button></div></div>
  if (slot.storage === 'volatile') return <div className="import-callout is-warning" role="alert"><Icon name="alert" size={20} /><div><p>{slot.storageMessage}</p></div></div>
  return null
}
