import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode, RefObject } from 'react'
import { Icon } from '../../components/Icon'
import { SubpageHeader } from '../../components/SubpageHeader'
import type { DietReviewDraft, ImportError, NormalizedDocument, WorkoutReviewDraft } from '../../import/contracts/index.ts'
import type { CatalogSnapshot } from '../../import/matching/exercises.ts'
import type { DietMappingIds } from '../../import/mapping/diet.ts'
import type { WorkoutMappingIds } from '../../import/mapping/workout.ts'
import { acceptedFileTypes } from '../../import/readers/file-checks.ts'
import { IMPORT_INACTIVITY_DAYS, type ImportSession } from '../../import/review/state.ts'
import type { ImportKind, ImportReviewState, ImportReviewStore, ImportSlot } from '../../persistence/import-review-store'
import { analysisOutcome } from '../../persistence/imports-store'
import type { ActiveSelection } from '../../persistence/plans-repository'
import { DietReview } from './DietReview'
import { ImportConfirmation, type ConfirmationResult } from './ImportConfirmation'
import { hasUnreadParts, ImportIssues, onlyScans } from './ImportIssues'
import { reserveDietIds, reserveWorkoutIds } from './review-model'
import { SourceViewer } from './SourceViewer'
import { documentUnits, narrowDocument } from './source-model'
import { WorkoutReview } from './WorkoutReview'
import './import.css'
import { StructuredImportPlan } from './StructuredImportPlan'

export function ImportPlan(props: Parameters<typeof LegacyImportPlan>[0]) {
  return <StructuredImportPlan {...props} />
}

const copy = {
  workout: { title: 'Importa una scheda', short: 'Scheda di allenamento', back: '#/scheda/programmi', backLabel: 'Torna ai programmi', noun: 'una scheda di allenamento', plan: 'programma', saved: '#/scheda/programmi', savedLabel: 'Apri i programmi', daily: '#/scheda', dailyLabel: 'Vai alla Scheda e inizia una seduta', manual: '#/scheda/programmi/nuovo', manualLabel: 'crea il programma a mano', other: 'diet' as const },
  diet: { title: 'Importa un piano alimentare', short: 'Piano alimentare', back: '#/dieta/piani', backLabel: 'Torna ai piani alimentari', noun: 'un piano alimentare', plan: 'piano alimentare', saved: '#/dieta/piani', savedLabel: 'Apri i piani alimentari', daily: '#/dieta', dailyLabel: 'Vai alla Dieta e registra i pasti', manual: '#/dieta/piani/nuovo', manualLabel: 'crea il piano a mano', other: 'workout' as const },
} satisfies Record<ImportKind, unknown>
const routes: Record<ImportKind, string> = { workout: '#/scheda/importa', diet: '#/dieta/importa' }
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

/** Contesto dell'app per la revisione e la conferma: rete, catalogo, selezione attiva e riletture. */
export interface ImportContext {
  online: boolean
  catalog: CatalogSnapshot
  selection: ActiveSelection | null
  selectionKnown: boolean
  /** Nome del piano seguito ora nella sezione dell'importazione. */
  followedName: string | null
  onSelectionStale: () => void
  onCatalogStale: () => void
}

/**
 * Pagina d'importazione di un dominio (11 → 22): file letto sul dispositivo, analisi esplicita sul server,
 * revisione (12/13), conferma con anteprima del mapping (09/10) e un solo salvataggio atomico (21, RPC 19/20),
 * poi esito. Ogni fase mostrata è quella reale della sessione; nessuna scrittura prima della conferma.
 */
export function LegacyImportPlan({ kind, store, state, loadFailed, onRetryLoad, context }: {
  kind: ImportKind
  store: ImportReviewStore | null
  state: ImportReviewState
  loadFailed: boolean
  onRetryLoad: () => void
  context: ImportContext
}) {
  const text = copy[kind]
  const slot = state.slots[kind]
  const session = slot.session
  const [selected, setSelected] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<readonly string[]>([])
  const picker = useRef<HTMLInputElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const focusNext = useRef<'card' | 'picker' | null>(null)

  // Conferma aperta: sopravvive all'invio, così un rifiuto certo (es. selezione cambiata) torna alla stessa conferma.
  const [confirming, setConfirming] = useState<ConfirmationResult | null>(null)
  const [switchBlocked, setSwitchBlocked] = useState(false)
  // Una nuova sessione azzera la selezione nella fonte e la conferma.
  const sessionId = session?.sessionId ?? null
  useEffect(() => { setSelected(null); setHighlight([]); setConfirming(null); setSwitchBlocked(false) }, [sessionId])
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
  // Durante l'invio partito dalla conferma questa resta montata (scelte conservate, pulsanti in attesa).
  const confirmingNow = Boolean(confirming && session?.draft && confirming.result.draft.proposal.proposalId === session.draft.proposal.proposalId)
  const phase = !session || !document ? null : session.status === 'saved' ? 'saved'
    : session.status === 'save_unknown' || (session.status === 'saving' && !confirmingNow) ? 'saving'
    : session.draft && (session.status === 'reviewing' || session.status === 'ready' || session.status === 'saving') ? 'review' : 'analysis'
  const announcement = reading ? 'Lettura del documento in corso.' : session?.status === 'analyzing' ? 'Analisi in corso sul server.' : session?.status === 'saving' ? 'Salvataggio in corso.'
    : phase === 'review' ? 'Proposta pronta da rivedere.' : phase === 'saved' ? 'Importazione salvata.' : document ? 'Documento letto.' : ''
  const network = slot.network
  const originalUnavailable = <>
    <p>Il file originale non viene conservato: per vedere le pagine scegli di nuovo lo stesso PDF. Il testo letto resta consultabile.</p>
    <label className="button secondary import-reattach">Riapri il PDF originale<input type="file" className="import-file-input" accept=".pdf,application/pdf" onChange={reattach} /></label>
  </>
  const switchDomain = async () => {
    if (await store.copyTo(kind, text.other)) window.location.hash = routes[text.other]
    else setSwitchBlocked(true)
  }

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
      </label> : <FileCard slot={slot} reading={reading} cardRef={card} onChoose={choose} locked={phase === 'saving'}
        onCancel={() => { focusNext.current = 'picker'; store.cancel(kind) }}
        onRemove={() => { focusNext.current = 'picker'; void store.remove(kind) }}
        onRetry={() => void store.retry(kind)} />}
      {slot.problem && <div className="import-callout is-danger" role="alert"><Icon name="alert" size={20} /><div><strong>{slot.problem.title}</strong><p>{slot.problem.message}</p></div></div>}
      {slot.notice && <p className={`import-notice is-${slot.notice.tone}`} role={slot.notice.tone === 'warning' ? 'alert' : undefined}>{slot.notice.text}</p>}
    </section>

    {switchBlocked && <div className="import-callout is-warning" role="alert"><Icon name="alert" size={20} /><div><strong>Percorso {kind === 'workout' ? 'dieta' : 'scheda'} occupato</strong><p>C’è già un’importazione in revisione o da verificare in quel percorso: concludila o scartala prima di passarle questo documento.</p></div></div>}
    {session && document && network.problem && phase !== 'saving' && <div className="import-callout is-warning import-network-problem" role="alert"><Icon name="alert" size={20} /><div><strong>{network.problem.title}</strong><p>{network.problem.message}</p></div></div>}

    {session && document && phase === 'analysis' && <>
      <section className="panel import-summary" aria-labelledby="import-summary-title">
        <h2 id="import-summary-title">{onlyScans(document.readingIssues, document.blocks.length) ? 'Nessun testo letto' : hasUnreadParts(document.readingIssues) ? 'Documento letto in parte' : 'Documento letto'}</h2>
        <p className="import-counts">{describe(document, slot.metadata?.pageCount ?? null)}</p>
        <p>Il testo letto resta su questo dispositivo finché non avvii l’analisi: scegliere o leggere il file non invia nulla. Se preferisci, puoi anche <a className="text-link" href={text.manual}>{text.manualLabel}</a>.</p>
        <StorageLine slot={slot} onReload={() => void store.reload(kind)} />
      </section>
      <AnalysisPanel kind={kind} store={store} session={session} slot={slot} online={context.online} />
      <ImportIssues issues={document.readingIssues} blockCount={document.blocks.length} onShow={ids => { setHighlight(ids); setSelected(ids[0] ?? null) }} />
      <section className="panel import-source" aria-labelledby="import-source-title">
        <h2 id="import-source-title">Fonte</h2>
        <p className="field-help">Il testo come è stato letto, senza interpretazioni.{session.file.format === 'pdf' ? ' Tocca un blocco per vederne la posizione nella pagina.' : ''}</p>
        <SourceViewer document={document} format={session.file.format} original={slot.original} pageCount={slot.metadata?.pageCount ?? null}
          selectedId={selected} highlightIds={highlight} onSelect={session.file.format === 'pdf' ? id => { setSelected(id); setHighlight([]) } : undefined}
          originalUnavailable={originalUnavailable} />
      </section>
    </>}

    {session && document && phase === 'review' && (analysisOutcome(session) === 'extracted'
      ? <ReviewStep key={session.draft!.proposal.proposalId} kind={kind} store={store} session={session} slot={slot} context={context} originalUnavailable={originalUnavailable} onSwitch={() => void switchDomain()}
        confirming={confirming?.result.draft.proposal.proposalId === session.draft!.proposal.proposalId ? confirming : null} setConfirming={setConfirming} />
      : <OutcomePanel kind={kind} store={store} session={session} slot={slot} online={context.online} onSwitch={() => void switchDomain()} />)}

    {session && phase === 'saving' && <SavingPanel kind={kind} store={store} session={session} slot={slot} online={context.online} />}
    {session && phase === 'saved' && <SavedPanel kind={kind} store={store} session={session} slot={slot} />}
  </>
}

// ---------------------------------------------------------------------------
// Analisi
// ---------------------------------------------------------------------------

const analysisMessages: Partial<Record<ImportError['code'], string>> = {
  budget_exhausted: 'Il budget delle analisi di questo periodo è esaurito: nessuna chiamata è stata fatta. Riprova più avanti oppure crea il piano a mano.',
  unauthenticated: 'La sessione non è valida: accedi di nuovo per analizzare il documento.',
  provider_refused: 'L’interprete ha rifiutato questo documento: nessuna proposta è stata creata.',
  provider_incomplete: 'L’interprete non ha completato la proposta entro i limiti: nessuna proposta parziale è stata usata.',
  provider_invalid_output: 'L’interprete ha prodotto una risposta non valida: nessuna proposta è stata usata.',
  provider_outcome_uncertain: 'L’esito della chiamata all’interprete è incerto e potrebbe essere già stato conteggiato: non riprovo da solo. Puoi avviare una nuova analisi se vuoi.',
  job_not_found: 'L’analisi non è più disponibile sul server (scaduta): serve una nuova analisi.',
  invalid_request: 'Il documento letto non è stato accettato dal server: prova a rileggere il file.',
  unsupported_schema_version: 'Questa versione dell’app non è più compatibile con il server: aggiorna l’app.',
}
function analysisMessage(error: ImportError | { code: string; message: string }) {
  if (error.code === 'provider_unavailable') return 'retryable' in error && error.retryable ? 'Il servizio di analisi è momentaneamente occupato: riprova tra poco.' : 'L’analisi automatica non è disponibile in questo momento (non attiva o sospesa). Puoi creare il piano a mano.'
  if (error.code === 'request_conflict') return 'retryable' in error && error.retryable ? 'Un’altra analisi del tuo account è in corso: riprova quando è finita.' : 'La richiesta è in conflitto con un’analisi precedente: avviane una nuova.'
  if (error.code === 'limit_exceeded') return 'Il documento supera i limiti dell’analisi.'
  if (error.code === 'interrupted') return 'L’analisi si è interrotta con la chiusura dell’app (non prosegue in background): la cerco sul server con la stessa richiesta.'
  return analysisMessages[error.code as ImportError['code']] ?? error.message
}

function AnalysisPanel({ kind, store, session, slot, online }: { kind: ImportKind; store: ImportReviewStore; session: ImportSession; slot: ImportSlot; online: boolean }) {
  const imports = store.imports
  const network = slot.network
  const document = session.document!
  const analyzing = session.status === 'analyzing'
  const usable = document.blocks.length > 0
  const error = session.status === 'failed' ? session.error : null
  const oversized = error !== null && 'limit' in error && (error as ImportError).limit?.limit === 'providerCallsPerAnalysis'
  const lost = error?.code === 'internal' || error?.code === 'interrupted'
  const canAnalyze = Boolean(imports) && online && usable && !analyzing && network.activity === null
  // Solo al clic: prima si cerca un'analisi già pronta della stessa fonte (riaprirla non costa), poi l'analisi nuova.
  const analyze = async (force: boolean) => {
    if (!imports) return
    if (!force) {
      await imports.lookupCompatible(kind)
      const found = store.getSnapshot().slots[kind].network.compatible
      if (found === null || found.length > 0) return
    }
    await imports.analyze(kind)
  }

  return <section className="panel import-analysis" aria-labelledby="import-analysis-title" aria-busy={analyzing || undefined}>
    <h2 id="import-analysis-title">Analisi</h2>
    {analyzing ? <p className="import-phase" role="status"><span className="import-progress" aria-hidden="true" />Analisi in corso sul server: può richiedere fino a due o tre minuti. Tieni aperta l’app: su iPhone l’analisi non prosegue in background, ma se si interrompe la ritrovo con la stessa richiesta.</p> : <>
      <div className="import-disclosure">
        <p><strong>Cosa viene inviato.</strong> Solo il testo letto (blocchi, titoli e tabelle), non il file: va al server di peppitness e da lì al servizio di intelligenza artificiale OpenAI, che propone come interpretarlo. OpenAI tratta questi dati secondo le proprie regole di conservazione: la cancellazione immediata non è garantita.</p>
        <p>La proposta resta privata nel tuo account per {IMPORT_INACTIVITY_DAYS} giorni senza attività. Nulla entra nei tuoi {kind === 'workout' ? 'programmi' : 'piani'} prima della tua conferma finale.</p>
      </div>
      {!imports && <p className="import-notice is-warning">L’analisi richiede l’accesso con il tuo account.</p>}
      {imports && !online && <p className="import-notice is-warning" role="status">Sei offline: l’analisi partirà solo con la connessione.</p>}
      {!usable && <p className="import-notice is-warning">Non c’è testo da analizzare in questo documento.</p>}
      {error && <div className={`import-callout ${lost ? 'is-warning' : 'is-danger'} import-analysis-error`} role="alert"><Icon name="alert" size={20} /><div>
        <strong>{lost ? 'Esito dell’analisi da verificare' : 'Analisi non riuscita'}</strong>
        <p>{analysisMessage(error)}</p>
        {lost && imports && <div className="button-row">
          <button type="button" className="button secondary import-recover" disabled={!online || network.activity !== null} onClick={() => void imports.recoverAnalysis(kind)}>Verifica sul server</button>
          <button type="button" className="button secondary import-resume" disabled={!online || network.activity !== null} onClick={() => void imports.resumeAnalysis(kind)}>Riprova la stessa richiesta</button>
        </div>}
      </div></div>}
      {oversized && <PartSelection store={store} kind={kind} session={session} />}
      {network.compatible && network.compatible.length > 0 && imports && <div className="import-callout import-compatible"><Icon name="history" size={20} /><div>
        <strong>Hai già analizzato questo documento</strong>
        <p>Puoi riaprire la proposta già pronta, senza una nuova analisi e senza costi, oppure chiederne una nuova.</p>
        <p>Riaprire conserva il risultato precedente, comprese eventuali parti mancanti. Per rigenerarlo scegli «Nuova analisi».</p>
        <div className="button-row">
          <button type="button" className="button primary import-reopen" disabled={network.activity !== null} onClick={() => void imports.reopen(kind, network.compatible![0]!.jobId)}>Riapri l’analisi pronta</button>
          <button type="button" className="button secondary import-analyze-again" disabled={!canAnalyze} onClick={() => void analyze(true)}>Nuova analisi</button>
        </div>
      </div></div>}
      {!(network.compatible && network.compatible.length > 0) && <div className="button-row">
        <button type="button" className="button primary import-analyze" disabled={!canAnalyze || Boolean(oversized)} onClick={() => void analyze(Boolean(error && !lost))}>
          {network.activity === 'analyzing' || network.activity === 'looking_up' ? 'Invio…' : error && !lost ? 'Avvia una nuova analisi' : 'Analizza il documento'}
        </button>
      </div>}
    </>}
  </section>
}

/** Il server chiede di ridurre il documento: parti scelte esplicitamente, esclusioni dichiarate, nuova lettura derivata. */
function PartSelection({ store, kind, session }: { store: ImportReviewStore; kind: ImportKind; session: ImportSession }) {
  const document = session.document!
  const units = useMemo(() => documentUnits(document, session.file.format), [document, session.file.format])
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const toggle = (id: string) => setChosen(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })
  return <fieldset className="import-parts">
    <legend>Scegli le {session.file.format === 'pdf' ? 'pagine' : 'sezioni'} da analizzare</legend>
    <p className="field-help">Il documento è troppo lungo per una sola analisi. Le parti escluse restano visibili come «non analizzate» e andranno confermate nella revisione: nulla viene tagliato di nascosto.</p>
    <ul>{units.map(unit => <li key={unit.id}><label><input type="checkbox" checked={chosen.has(unit.id)} onChange={() => toggle(unit.id)} />{unit.label}</label></li>)}</ul>
    <button type="button" className="button secondary import-narrow" disabled={chosen.size === 0 || chosen.size === units.length}
      onClick={() => void store.restartWith(kind, narrowDocument(document, units, chosen))}>Usa solo le parti scelte</button>
  </fieldset>
}

// ---------------------------------------------------------------------------
// Revisione e conferma
// ---------------------------------------------------------------------------

function ReviewStep({ kind, store, session, slot, context, originalUnavailable, onSwitch, confirming, setConfirming }: {
  kind: ImportKind; store: ImportReviewStore; session: ImportSession; slot: ImportSlot; context: ImportContext; originalUnavailable: ReactNode; onSwitch: () => void
  confirming: ConfirmationResult | null; setConfirming: (value: ConfirmationResult | null) => void
}) {
  const imports = store.imports
  const network = slot.network
  const draft = session.draft!
  const document = session.document!
  const reservations = session.reservations ?? null
  const ids = useMemo(() => kind === 'workout'
    ? reserveWorkoutIds(draft as WorkoutReviewDraft, reservations as WorkoutMappingIds | null)
    : reserveDietIds(draft as DietReviewDraft, reservations as DietMappingIds | null), [kind, draft, reservations])
  const rejection = network.rejection
  // Selezione cambiata altrove: si rilegge e si resta sulla conferma; catalogo cambiato: si torna alla revisione.
  useEffect(() => {
    if (rejection === 'selection_conflict') context.onSelectionStale()
    if (rejection === 'catalog_conflict') { context.onCatalogStale(); setConfirming(null) }
    if (rejection === 'request_conflict' || rejection === 'analysis_expired' || rejection === 'invalid_command' || rejection === 'not_available') setConfirming(null)
  }, [rejection]) // eslint-disable-line react-hooks/exhaustive-deps
  const reanalysis = session.reanalysis
  const common = {
    document, format: session.file.format, original: slot.original, pageCount: slot.metadata?.pageCount ?? null, originalUnavailable,
    onAdoptReanalysis: () => void store.adoptReanalysis(kind), onDismissReanalysis: () => void store.dismissReanalysis(kind), confirmLabel: 'Continua alla conferma',
  }
  const saving = network.activity === 'confirming' || network.activity === 'saving'

  if (confirming) return <ImportConfirmation value={confirming} selectionKnown={context.selectionKnown} followedName={context.followedName}
    network={network} saving={saving} online={context.online} onBack={() => setConfirming(null)}
    onSave={options => void imports?.confirm(kind, {
      ids: confirming.result.ids as never, allowDuplicate: options.allowDuplicate,
      selection: options.follow ? { follow: true, expectedActiveRevision: context.selection?.revision ?? null } : { follow: false, expectedActiveRevision: null },
    })} />

  return <>
    <section className="panel import-review-actions" aria-labelledby="import-review-title">
      <h2 id="import-review-title">Proposta da rivedere</h2>
      <p>Controlla la proposta con la fonte e risolvi i punti indicati. {kind === 'workout' && 'Gli esercizi mancanti vengono predisposti per la creazione al salvataggio. '}Le modifiche restano su questo dispositivo{session.persistence === 'durable' ? ` per ${IMPORT_INACTIVITY_DAYS} giorni senza attività` : ', ma solo in questa pagina'}.</p>
      {reanalysis?.status === 'running' && <p className="import-phase" role="status"><span className="import-progress" aria-hidden="true" />Nuova analisi in corso: la bozza attuale resta com’è finché non scegli.</p>}
      {reanalysis?.status === 'failed' && <p className="import-notice is-warning">La nuova analisi non è riuscita{reanalysis.error ? `: ${analysisMessage(reanalysis.error)}` : ' o è stata interrotta'}. La bozza attuale resta invariata.</p>}
      <div className="button-row">
        {imports && <button type="button" className="button secondary import-reanalyze" disabled={!context.online || network.activity !== null || reanalysis?.status === 'running'} onClick={() => void imports.analyze(kind)}>Rianalizza il documento</button>}
        {reanalysis && reanalysis.status !== 'running' && reanalysis.status !== 'ready' && <button type="button" className="button secondary" onClick={() => void store.dismissReanalysis(kind)}>Chiudi l’avviso</button>}
        <button type="button" className="button secondary import-other" onClick={onSwitch}>Importa lo stesso file anche come {copy[copy[kind].other].noun}</button>
      </div>
      {!imports && <p className="import-notice is-warning">Per salvare serve l’accesso con il tuo account.</p>}
    </section>
    {kind === 'workout'
      ? <WorkoutReview {...common} value={{ draft: draft as WorkoutReviewDraft, ids: ids as WorkoutMappingIds }} catalog={context.catalog}
        reanalysis={reanalysis?.status === 'ready' ? reanalysis.draft as WorkoutReviewDraft : null}
        onChange={value => void store.changeDraft(kind, value.draft, value.ids)}
        onConfirm={imports ? result => setConfirming({ kind: 'workout', result }) : undefined} />
      : <DietReview {...common} value={{ draft: draft as DietReviewDraft, ids: ids as DietMappingIds }}
        reanalysis={reanalysis?.status === 'ready' ? reanalysis.draft as DietReviewDraft : null}
        onChange={value => void store.changeDraft(kind, value.draft, value.ids)}
        onConfirm={imports ? result => setConfirming({ kind: 'diet', result }) : undefined} />}
  </>
}

/** Proposta senza contenuto importabile: dominio sbagliato, nessun contenuto, testo illeggibile. */
function OutcomePanel({ kind, store, session, slot, online, onSwitch }: { kind: ImportKind; store: ImportReviewStore; session: ImportSession; slot: ImportSlot; online: boolean; onSwitch: () => void }) {
  const outcome = analysisOutcome(session)
  const text = copy[kind], other = copy[text.other]
  const reanalysis = session.reanalysis
  return <section className="panel import-outcome" aria-labelledby="import-outcome-title" data-outcome={outcome}>
    <h2 id="import-outcome-title">{outcome === 'wrong_document_type' ? `Non sembra ${text.noun}` : outcome === 'no_relevant_content' ? 'Nessun contenuto da importare' : 'Testo non interpretabile'}</h2>
    <p>{outcome === 'wrong_document_type'
      ? `L’interprete ha riconosciuto ${other.noun}. Puoi importare lo stesso file in quel percorso: il testo letto passa lì senza rileggere il file e servirà una nuova analisi, con la sua conferma separata.`
      : outcome === 'no_relevant_content' ? `Nel testo letto non c’è ${text.noun} riconoscibile. Nulla viene salvato.`
      : 'Il testo letto non si lascia interpretare in modo affidabile. Nulla viene salvato.'}</p>
    <div className="button-row">
      {outcome === 'wrong_document_type' && <button type="button" className="button primary import-switch" onClick={onSwitch}>Importa come {other.noun}</button>}
      {store.imports && <button type="button" className="button secondary import-reanalyze" disabled={!online || slot.network.activity !== null || reanalysis?.status === 'running'} onClick={() => void store.imports!.analyze(kind)}>Rianalizza</button>}
      {reanalysis?.status === 'ready' && <button type="button" className="button secondary" onClick={() => void store.adoptReanalysis(kind)}>Usa la nuova proposta</button>}
      <button type="button" className="button secondary danger" onClick={() => void store.discard(kind)}>Scarta</button>
    </div>
  </section>
}

// ---------------------------------------------------------------------------
// Salvataggio ed esito
// ---------------------------------------------------------------------------

function SavingPanel({ kind, store, session, slot, online }: { kind: ImportKind; store: ImportReviewStore; session: ImportSession; slot: ImportSlot; online: boolean }) {
  const [discarding, setDiscarding] = useState(false)
  const imports = store.imports
  const network = slot.network
  if (session.status === 'saving') return <section className="panel import-saving" aria-busy="true" aria-labelledby="import-saving-title">
    <h2 id="import-saving-title">Salvataggio in corso</h2>
    <p className="import-phase" role="status"><span className="import-progress" aria-hidden="true" />Invio della conferma al server. Se la risposta si perde, verifico con la stessa richiesta: nessuna copia viene creata.</p>
  </section>
  return <section className="panel import-uncertain" aria-labelledby="import-uncertain-title" data-status="save_unknown">
    <h2 id="import-uncertain-title">Salvataggio da verificare</h2>
    <p>Il {copy[kind].plan} potrebbe essere già salvato: la risposta del server non è arrivata. La bozza resta bloccata finché non verifico l’esito con la stessa richiesta.</p>
    {network.problem && <p className="import-notice is-warning" role="alert">{network.problem.message}</p>}
    {!online && <p className="import-notice is-warning" role="status">Sei offline: verificherò al ritorno della connessione.</p>}
    <div className="button-row">
      <button type="button" className="button primary import-reconcile" disabled={!imports || !online || network.activity !== null} onClick={() => void imports?.reconcile(kind)}>{network.activity === 'reconciling' ? 'Verifica…' : 'Verifica l’esito'}</button>
      <button type="button" className="button secondary import-retry-save" disabled={!imports || !online || network.activity !== null} onClick={() => void imports?.retrySave(kind)}>Riprova con la stessa conferma</button>
    </div>
    {!discarding ? <button type="button" className="text-button danger" onClick={() => setDiscarding(true)}>Scarta questa importazione</button>
      : <div className="import-callout is-danger" role="alert"><Icon name="alert" size={20} /><div>
        <strong>Scartare senza verificare?</strong>
        <p>Il {copy[kind].plan} potrebbe essere già salvato: dopo lo scarto controllalo in «{copy[kind].savedLabel.replace('Apri ', '')}». Su questo dispositivo non resterà nulla di questa importazione.</p>
        <div className="button-row"><button type="button" className="button secondary" onClick={() => setDiscarding(false)}>Annulla</button><button type="button" className="button danger import-discard" onClick={() => void store.discard(kind, { acknowledgeUncertain: true })}>Scarta comunque</button></div>
      </div></div>}
  </section>
}

function SavedPanel({ kind, store, session, slot }: { kind: ImportKind; store: ImportReviewStore; session: ImportSession; slot: ImportSlot }) {
  const text = copy[kind]
  const receipt = session.receipt!
  const payload = session.commit?.command.payload
  const name = payload ? payload.kind === 'workout' ? payload.resolved.title : payload.resolved.plan.name : null
  const followed = receipt.selection !== null
  const refresh = slot.network.refresh
  if (receipt.resultState === 'deleted') return <section className="panel import-saved" aria-labelledby="import-saved-title" data-result="deleted">
    <h2 id="import-saved-title">Importazione eliminata</h2>
    <p>Questa importazione era stata salvata e il {text.plan} è stato poi eliminato. Non viene ricreato: se ti serve, importa di nuovo il file.</p>
    <div className="button-row"><button type="button" className="button primary" onClick={() => void store.remove(kind)}>Importa un altro file</button></div>
  </section>
  return <section className="panel import-saved" aria-labelledby="import-saved-title" data-result="committed" data-followed={followed}>
    <h2 id="import-saved-title">{kind === 'workout' ? 'Programma salvato' : 'Piano alimentare salvato'}</h2>
    <ul className="import-confirmation-facts">
      <li><Icon name="check" size={16} />{kind === 'workout' ? `«${name}» creato e pubblicato.` : `«${name}» creato.`}</li>
      <li><Icon name={followed ? 'check' : 'info'} size={16} />{followed ? `Ora è il ${text.plan} seguito nella ${kind === 'workout' ? 'Scheda' : 'Dieta'}.` : `Non lo segui ancora: puoi sceglierlo quando vuoi.`}</li>
      <li><Icon name="info" size={16} />Nessuna seduta o pasto è stato segnato come svolto.</li>
    </ul>
    {refresh === 'pending' && <p className="import-notice" role="status">Aggiorno l’elenco…</p>}
    {refresh === 'failed' && <div className="import-callout is-warning" role="alert"><Icon name="alert" size={20} /><div><strong>Salvato, ma elenco non aggiornato</strong><p>Il {text.plan} è salvato sul server; non riesco però a rileggere l’elenco in questo momento.</p><button type="button" className="button secondary import-refresh" onClick={() => void store.imports?.refresh(kind)}>Aggiorna l’elenco</button></div></div>}
    <div className="button-row">
      {followed && <a className="button primary" href={text.daily}>{text.dailyLabel}</a>}
      <a className={`button ${followed ? 'secondary' : 'primary'}`} href={text.saved}>{text.savedLabel}</a>
      <button type="button" className="button secondary" onClick={() => void store.remove(kind)}>Importa un altro file</button>
    </div>
  </section>
}

// ---------------------------------------------------------------------------

function FileCard({ slot, reading, locked, cardRef, onChoose, onCancel, onRemove, onRetry }: {
  slot: ImportSlot; reading: boolean; locked: boolean; cardRef: RefObject<HTMLDivElement | null>
  onChoose: (event: ChangeEvent<HTMLInputElement>) => void; onCancel: () => void; onRemove: () => void; onRetry: () => void
}) {
  const session = slot.session!
  const status = reading ? 'Lettura sul dispositivo in corso…' : session.document ? (slot.restored ? 'Letto in precedenza su questo dispositivo' : 'Letto sul dispositivo') : 'Non letto'
  return <>
    <div className="import-file-card" ref={cardRef} tabIndex={-1} aria-busy={reading || undefined} data-session={session.sessionId}>
      <span className="import-format" aria-hidden="true">{session.file.format.toUpperCase()}</span>
      <div className="import-file-copy">
        <strong className="import-file-name" title={session.file.name}>{session.file.name}</strong>
        <small>{formatNames[session.file.format]} · {formatBytes(session.file.size)}</small>
        <span className={`import-file-status ${reading ? 'is-reading' : session.document ? 'is-read' : 'is-failed'}`}>{reading && <span className="import-progress" aria-hidden="true" />}{status}</span>
      </div>
    </div>
    {/* Durante un salvataggio (anche incerto) il file resta: l'esito va prima verificato. */}
    {!locked && <div className="button-row import-file-actions">
      {!reading && slot.problem?.retry && slot.original && <button type="button" className="button primary import-retry" onClick={onRetry}>Riprova la lettura</button>}
      {/* Cambiare file durante la lettura la interrompe: vale solo il file scelto per ultimo. */}
      <label className="button secondary import-change">Cambia file<input type="file" className="import-file-input" accept={acceptedFileTypes} onChange={onChoose} /></label>
      {reading ? <button type="button" className="button secondary import-cancel" onClick={onCancel}>Annulla la lettura</button>
        : <button type="button" className="button secondary danger import-remove" onClick={onRemove}>Rimuovi</button>}
    </div>}
  </>
}

function StorageLine({ slot, onReload }: { slot: ImportSlot; onReload: () => void }) {
  if (slot.storage === 'durable') return <p className="field-help import-storage"><Icon name="check" size={16} />La lettura resta su questo dispositivo per {IMPORT_INACTIVITY_DAYS} giorni senza attività, senza il file originale.</p>
  if (slot.storage === 'conflict') return <div className="import-callout is-warning"><Icon name="alert" size={20} /><div><p>{slot.storageMessage}</p><button type="button" className="button secondary" onClick={onReload}>Ricarica la lettura</button></div></div>
  if (slot.storage === 'volatile') return <div className="import-callout is-warning" role="alert"><Icon name="alert" size={20} /><div><p>{slot.storageMessage}</p></div></div>
  return null
}
