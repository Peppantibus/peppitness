/**
 * Motore dell'importazione per l'account corrente (task 11): scelta del file, lettura locale nel worker,
 * journal IndexedDB e byte originali solo in memoria. Caricato in modo lazy da `use-import-review.ts`, così
 * contratti, reader e journal non entrano nel bundle principale.
 *
 * Uno slot per dominio (scheda, dieta), ciascuno con al più una sessione corrente. Regole:
 * - il file viene letto solo sul dispositivo: nessuna richiesta di rete, nessuna analisi implicita;
 * - una lettura superata (file cambiato, rimosso, annullato, stop o cambio account) non tocca più lo stato;
 * - il documento letto va nel journal (`ReviewStore`), mai i byte: dopo un reload la fonte resta consultabile
 *   come blocchi e la pagina PDF si riapre solo riselezionando un file con lo stesso sourceHash;
 * - archivio assente, quota o conflitto rendono la sessione volatile e lo dichiarano (guardie di chiusura).
 */
import type { DocumentReader, DocumentReadMetadata, ExtractionKind, NormalizedDocument, ReviewDraft } from '../import/contracts/index.ts'
import { DocumentReaderError, validateNormalizedDocument } from '../import/contracts/index.ts'
import { checkSelectedFile, sha256Hex, type SelectedFileInfo } from '../import/readers/file-checks.ts'
import { createDocxWorkerReader, createPdfWorkerReader, ReaderWorkerError } from '../import/readers/worker-client.ts'
import { indexedDbBackend, ReviewStore } from '../import/review/local-storage.ts'
import {
  applyImportEvent, createImportSession, hasUncertainCommand, ImportAccountScope, isBusy, isDirty, matchesOriginal,
  type ImportEvent, type ImportSession, type MappingReservations,
} from '../import/review/state.ts'
import type { ImportsRepository } from './imports-repository.ts'
export { createImportsRepository } from './imports-repository.ts'
import { idleNetwork, ImportsStore, type DispatchResult, type ImportNetwork, type ImportSessionHost, type ImportsStoreOptions, type SessionEvent } from './imports-store.ts'

export type ImportKind = ExtractionKind
export const importKinds: readonly ImportKind[] = ['workout', 'diet']

/** Problema del file o della lettura, da mostrare così com'è; `retry`: ripetibile con gli stessi byte. */
export interface ImportProblem { code: string; title: string; message: string; retry: boolean }
export interface ImportNotice { tone: 'info' | 'warning'; text: string }

export interface ImportSlot {
  session: ImportSession | null
  /** Metadati del reader (inventario, pagine): solo in memoria, assenti dopo una ripresa. */
  metadata: DocumentReadMetadata | null
  /** Byte originali, solo in memoria: vista delle pagine PDF e nuova lettura dopo un guasto del worker. */
  original: Uint8Array | null
  problem: ImportProblem | null
  notice: ImportNotice | null
  /** Esito dell'ultima scrittura nel journal; null finché nulla è stato scritto. */
  storage: 'durable' | 'volatile' | 'conflict' | null
  storageMessage: string | null
  /** Sessione ripresa dal journal: l'originale non è in memoria finché non viene riselezionato. */
  restored: boolean
  /** Stato di rete (21): attività, problemi, analisi compatibili, duplicati, rifiuti e rilettura dopo il salvataggio. */
  network: ImportNetwork
}

export interface ImportGuards {
  /** Lettura in corso: aggiornamento PWA rimandato e avviso di chiusura. */
  busy: boolean
  /** Qualcosa andrebbe perso chiudendo la pagina (sessione volatile con documento, bozza o comando). */
  unsaved: boolean
  /** Il logout eliminerebbe bozze o comandi incerti del journal, o interromperebbe lavoro in corso. */
  logoutRisk: boolean
}

export interface ImportReviewState {
  phase: 'opening' | 'ready'
  /** Journal IndexedDB utilizzabile su questo dispositivo (null finché non è aperto). */
  storageAvailable: boolean | null
  slots: Record<ImportKind, ImportSlot>
  guards: ImportGuards
}

export interface ImportReviewOptions extends Omit<ImportsStoreOptions, 'newId'> {
  journal?: ReviewStore
  createReader?: (format: 'docx' | 'pdf') => DocumentReader & { close?: () => void }
  now?: () => string
  newId?: () => string
  /** Rete dell'account (21): senza repository il motore resta solo locale (lettura e revisione). */
  repository?: ImportsRepository
}

const emptySlot = (patch: Partial<ImportSlot> = {}): ImportSlot => ({
  session: null, metadata: null, original: null, problem: null, notice: null, storage: null, storageMessage: null, restored: false, network: idleNetwork(), ...patch,
})
const noGuards: ImportGuards = { busy: false, unsaved: false, logoutRisk: false }

const problemTitles: Record<string, string> = {
  unsupported: 'File non supportato',
  corrupt: 'File non leggibile',
  limit_exceeded: 'Documento oltre i limiti',
  cancelled: 'Lettura annullata',
}
const MiB = 1024 * 1024

/** Traduce un errore di controllo o lettura in un messaggio veritiero, senza inventare dettagli. */
export function problemOf(error: unknown): ImportProblem {
  if (error instanceof DocumentReaderError) {
    // Solo il limite della dimensione non è già descritto nel messaggio del controllo.
    const limit = error.limit
    const detail = limit?.limit === 'fileBytes' ? ` Massimo ${Math.round(limit.max / MiB)} MB${limit.actual !== null ? `, questo file ne occupa ${(limit.actual / MiB).toLocaleString('it-IT', { maximumFractionDigits: 1 })}` : ''}.` : ''
    return { code: error.code, title: problemTitles[error.code] ?? 'Lettura non riuscita', message: `${error.message}${detail}`, retry: false }
  }
  if (error instanceof ReaderWorkerError) {
    return { code: error.reason, title: 'Lettura interrotta', message: `${error.message} Il file non è stato letto: puoi riprovare.`, retry: true }
  }
  return { code: 'read_failed', title: 'Lettura non riuscita', message: 'Il documento non è stato letto per un errore imprevisto. Puoi riprovare o scegliere un altro file.', retry: true }
}

/** Sessioni del journal da riprendere nella pagina: con documento letto o con un comando da riconciliare. */
const resumable = (session: ImportSession) =>
  !['cancelled', 'expired', 'saved'].includes(session.status) && (session.document !== null || hasUncertainCommand(session))

export class ImportReviewStore {
  readonly ownerId: string
  private state: ImportReviewState
  private readonly listeners = new Set<() => void>()
  private readonly scope: ImportAccountScope
  private readonly journal: ReviewStore
  private readonly createReader: NonNullable<ImportReviewOptions['createReader']>
  private readonly now: () => string
  private readonly newId: () => string
  private readers: Partial<Record<'docx' | 'pdf', DocumentReader & { close?: () => void }>> = {}
  private readonly reads: Partial<Record<ImportKind, AbortController>> = {}
  /** Generazione per dominio: ogni scelta, annullamento o rimozione rende obsolete le operazioni precedenti. */
  private readonly generations: Record<ImportKind, number> = { workout: 0, diet: 0 }
  private opening: Promise<void> | null = null
  private risks = { localDrafts: 0, uncertainCommands: 0 }
  /** Scritture del journal in fila per dominio: ognuna scrive l'ultima versione della sessione. */
  private readonly writes: Record<ImportKind, Promise<void>> = { workout: Promise.resolve(), diet: Promise.resolve() }
  /** Coordinatore di rete (21) sulla stessa sessione e sullo stesso journal; null senza repository. */
  readonly imports: ImportsStore | null

  constructor(ownerId: string, options: ImportReviewOptions = {}) {
    this.ownerId = ownerId
    this.scope = new ImportAccountScope(ownerId)
    this.journal = options.journal ?? new ReviewStore(indexedDbBackend(globalThis.indexedDB))
    this.createReader = options.createReader ?? (format => format === 'docx' ? createDocxWorkerReader() : createPdfWorkerReader())
    this.now = options.now ?? (() => new Date().toISOString())
    this.newId = options.newId ?? (() => crypto.randomUUID())
    this.state = { phase: 'opening', storageAvailable: null, slots: { workout: emptySlot(), diet: emptySlot() }, guards: noGuards }
    // Accesso del coordinatore di rete: stessa sessione dello slot, stesso journal, stesso ambito d'account.
    const host: ImportSessionHost = {
      ownerId,
      current: kind => this.state.slots[kind].session,
      ticket: () => this.scope.ticket(),
      isCurrent: ticket => this.scope.isCurrent(ticket),
      dispatch: (kind, sessionId, event) => this.dispatch(kind, sessionId, event),
      reload: kind => this.reload(kind),
      network: kind => this.state.slots[kind].network,
      setNetwork: (kind, patch) => this.patch(kind, { network: { ...this.state.slots[kind].network, ...patch } }),
    }
    const { repository, journal: _journal, createReader: _reader, now: _now, ...network } = options
    this.imports = repository ? new ImportsStore(host, repository, { ...network, newId: this.newId }) : null
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.state

  /** Avvio (idempotente): apre il journal dell'account, elimina i residui di altri account e riprende le letture. */
  start() { this.opening ??= this.open() }

  /** Interrompe letture e operazioni in corso; le risposte tardive non valgono più. Riutilizzabile (StrictMode). */
  stop() {
    for (const kind of importKinds) this.abortRead(kind)
    this.scope.stop()
    this.opening = null
    for (const reader of Object.values(this.readers)) reader?.close?.()
    this.readers = {}
    // Una lettura interrotta dallo stop non è più in corso: lo slot torna scegliibile.
    for (const kind of importKinds) {
      const session = this.state.slots[kind].session
      if (session && session.status === 'reading' && session.document === null) this.setSlot(kind, emptySlot({ notice: { tone: 'info', text: 'Lettura interrotta.' } }))
      // Le risposte di rete successive allo stop non valgono più: niente attività né dati di rete residui.
      else this.patch(kind, { network: idleNetwork() })
    }
  }

  /** Ritorno online o in primo piano: riconcilia i salvataggi incerti e cerca le analisi interrotte, senza nuovi invii. */
  resume() { return this.imports?.resume() ?? Promise.resolve() }

  /**
   * Modifica della bozza in revisione (12/13): stessa proposta, decisioni rigiocate, comando non inviato decaduto.
   * `reservations`: ID prenotati dalla revisione, conservati nel journal con la bozza fino al congelamento.
   */
  changeDraft(kind: ImportKind, draft: ReviewDraft, reservations?: MappingReservations | null) {
    return this.localEvent(kind, { type: 'draft_changed', draft, ...(reservations === undefined ? {} : { reservations }) })
  }

  /**
   * Nuova sessione dello slot con un documento derivato da quello letto (selezione esplicita di sezioni o
   * pagine, 22): stessa fonte e stesso reader, esclusioni dichiarate nei problemi di lettura; la precedente
   * lascia il journal. Nessuna analisi parte da sola.
   */
  async restartWith(kind: ImportKind, document: NormalizedDocument) {
    const slot = this.state.slots[kind], previous = slot.session
    if (!previous?.document || hasUncertainCommand(previous) || previous.draft) return false
    if (!validateNormalizedDocument(document).ok || document.sourceHash !== previous.document.sourceHash || document.readerVersion !== previous.document.readerVersion) return false
    await this.adopt(kind, previous.file, document, slot.original, slot.metadata)
    void this.forget(previous)
    return true
  }

  /**
   * Stesso documento letto nell'altro dominio (dominio sbagliato o file misto): una sessione separata, con
   * analisi e conferma proprie. L'altro slot viene sostituito solo se non ha lavoro in corso o incerto.
   */
  async copyTo(from: ImportKind, to: ImportKind) {
    const source = this.state.slots[from], target = this.state.slots[to].session
    if (from === to || !source.session?.document) return false
    // Una revisione in corso nell'altro dominio non si sovrascrive; un'importazione conclusa sì.
    if (target && (hasUncertainCommand(target) || isBusy(target) || (target.draft && (target.status === 'reviewing' || target.status === 'ready')))) return false
    this.nextGeneration(to)
    this.abortRead(to)
    if (target) void this.forget(target)
    await this.adopt(to, source.session.file, source.session.document, source.original, source.metadata)
    return true
  }

  /**
   * Scarta l'importazione dello slot. Con un comando inviato e non riconciliato serve la conferma esplicita
   * (il piano potrebbe essere già salvato): la ricevuta resterà comunque sul server.
   */
  async discard(kind: ImportKind, options: { acknowledgeUncertain?: boolean } = {}) {
    const session = this.state.slots[kind].session
    if (!session || isBusy(session)) return false
    if (hasUncertainCommand(session) && !options.acknowledgeUncertain) return false
    this.nextGeneration(kind)
    this.setSlot(kind, emptySlot({ notice: { tone: 'info', text: 'Importazione scartata da questo dispositivo.' } }))
    if (session.revision !== null) await this.journal.discard(this.ownerId, session.sessionId, { acknowledgeUncertain: true }).catch(() => undefined)
    await this.refreshRisks()
    return true
  }
  /** Adotta la nuova proposta di una rianalisi: la bozza precedente resta fra quelle superate. */
  adoptReanalysis(kind: ImportKind) { return this.localEvent(kind, { type: 'reanalysis_adopted' }) }
  /** Scarta la nuova proposta di una rianalisi (conclusa o fallita): la bozza in uso resta intatta. */
  dismissReanalysis(kind: ImportKind) { return this.localEvent(kind, { type: 'reanalysis_dismissed' }) }
  /** Interrompe l'attesa di una rianalisi sul dispositivo (il server non la annulla): la bozza resta. */
  stopReanalysis(kind: ImportKind) { return this.localEvent(kind, { type: 'cancelled' }) }

  /** Logout: interrompe tutto e cancella dal dispositivo ogni sessione di questo account. */
  async clearDevice() {
    this.stop()
    this.state = { ...this.state, slots: { workout: emptySlot(), diet: emptySlot() } }
    this.risks = { localDrafts: 0, uncertainCommands: 0 }
    this.emit()
    await this.journal.clearOwner(this.ownerId).catch(() => undefined)
  }

  /** Sceglie un file per il dominio: controlli, impronta e lettura locale nel worker. */
  async select(kind: ImportKind, file: SelectedFileInfo & { arrayBuffer(): Promise<ArrayBuffer> }) {
    const previous = this.state.slots[kind].session
    if (previous && hasUncertainCommand(previous)) {
      this.patch(kind, { problem: { code: 'uncertain_save', title: 'Salvataggio da verificare', message: 'Un salvataggio di questa importazione attende l’esito: non si può cambiare file finché non è verificato.', retry: false } })
      return
    }
    let accepted
    try { accepted = checkSelectedFile(file) } catch (error) {
      // Il file rifiutato non sostituisce quello già letto.
      this.patch(kind, { problem: problemOf(error), notice: null })
      return
    }
    const generation = this.nextGeneration(kind)
    const ticket = this.scope.ticket()
    const stale = () => this.generations[kind] !== generation || !this.scope.isCurrent(ticket)
    let bytes: Uint8Array
    let sourceHash: string
    try {
      bytes = new Uint8Array(await file.arrayBuffer())
      sourceHash = await sha256Hex(bytes)
    } catch {
      if (!stale()) this.patch(kind, { problem: { code: 'file_unavailable', title: 'File non disponibile', message: 'Il file scelto non si può aprire dal dispositivo. Sceglilo di nuovo.', retry: false }, notice: null })
      return
    }
    if (stale()) return
    // Il file nuovo sostituisce il precedente: la sua lettura si ferma e la sua voce lascia il journal.
    this.abortRead(kind)
    if (previous) void this.forget(previous)
    let session = createImportSession({ ownerId: this.ownerId, sessionId: this.newId(), kind, file: { name: file.name, size: file.size, format: accepted.format, sourceHash }, at: this.now() })
    session = this.apply(session, { type: 'read_started' }) ?? session
    this.setSlot(kind, emptySlot({ session, original: bytes }))
    await this.runRead(kind, generation, accepted.mediaType)
  }

  /** Nuova lettura degli stessi byte dopo un guasto del worker. */
  async retry(kind: ImportKind) {
    const slot = this.state.slots[kind]
    if (!slot.session || slot.session.status !== 'failed' || !slot.original || !slot.problem?.retry) return
    const generation = this.nextGeneration(kind)
    const session = this.apply(slot.session, { type: 'read_started' })
    if (!session) return
    this.patch(kind, { session, problem: null, notice: null })
    await this.runRead(kind, generation, null)
  }

  /** Annulla la lettura in corso: nulla viene conservato e si torna alla scelta del file. */
  cancel(kind: ImportKind) {
    const session = this.state.slots[kind].session
    if (!session || !(session.status === 'reading' && session.document === null)) return
    this.nextGeneration(kind)
    this.abortRead(kind)
    this.apply(session, { type: 'cancelled' })
    this.setSlot(kind, emptySlot({ notice: { tone: 'info', text: 'Lettura annullata: il file non è stato letto.' } }))
  }

  /** Rimuove il file e la sua lettura, anche dal journal del dispositivo. */
  async remove(kind: ImportKind) {
    const session = this.state.slots[kind].session
    if (!session) { this.patch(kind, { problem: null, notice: null }); return }
    if (hasUncertainCommand(session)) return
    this.nextGeneration(kind)
    this.abortRead(kind)
    this.setSlot(kind, emptySlot({ notice: { tone: 'info', text: 'File rimosso da questa importazione.' } }))
    await this.forget(session)
  }

  /**
   * Riapre l'originale di una lettura ripresa: accettato solo se l'impronta coincide (stesso contenuto,
   * non stesso nome). Non cambia la sessione né rilegge il documento.
   */
  async attachOriginal(kind: ImportKind, file: SelectedFileInfo & { arrayBuffer(): Promise<ArrayBuffer> }) {
    const session = this.state.slots[kind].session
    if (!session?.document) return
    const generation = this.generations[kind]
    const ticket = this.scope.ticket()
    let bytes: Uint8Array
    let hash: string
    try {
      const accepted = checkSelectedFile(file)
      if (accepted.format !== session.file.format) { this.patch(kind, { notice: { tone: 'warning', text: `Il file scelto non è un ${session.file.format.toUpperCase()}: la pagina originale resta non disponibile.` } }); return }
      bytes = new Uint8Array(await file.arrayBuffer())
      hash = await sha256Hex(bytes)
    } catch (error) {
      this.patch(kind, { notice: { tone: 'warning', text: error instanceof DocumentReaderError ? error.message : 'Il file scelto non si può aprire dal dispositivo.' } })
      return
    }
    if (this.generations[kind] !== generation || !this.scope.isCurrent(ticket) || this.state.slots[kind].session?.sessionId !== session.sessionId) return
    if (!matchesOriginal(session, hash)) {
      this.patch(kind, { notice: { tone: 'warning', text: 'Questo file è diverso da quello letto (il contenuto non coincide, anche se il nome può essere uguale): la pagina originale resta non disponibile. Per leggere questo file usa «Cambia file».' } })
      return
    }
    this.patch(kind, { original: bytes, notice: { tone: 'info', text: 'Originale riaperto: le pagine sono di nuovo visibili.' } })
  }

  /** Dopo un conflitto con un'altra scheda: rilegge la sessione dal journal. */
  async reload(kind: ImportKind) {
    const session = this.state.slots[kind].session
    if (!session) return
    const ticket = this.scope.ticket()
    const loaded = await this.journal.load(this.ownerId, session.sessionId)
    if (!this.scope.isCurrent(ticket) || this.state.slots[kind].session?.sessionId !== session.sessionId) return
    if (loaded.status === 'ok') {
      const original = this.state.slots[kind].original
      const keep = original && loaded.session.file.sourceHash === session.file.sourceHash ? original : null
      this.setSlot(kind, emptySlot({ session: loaded.session, original: keep, storage: 'durable', restored: !keep, metadata: keep ? this.state.slots[kind].metadata : null, network: this.state.slots[kind].network }))
    } else {
      this.setSlot(kind, emptySlot({ notice: { tone: 'info', text: loaded.status === 'missing' ? 'Questa lettura è stata rimossa in un’altra scheda.' : loaded.message } }))
    }
    await this.refreshRisks()
  }

  // -------------------------------------------------------------------------

  private async open() {
    const ticket = this.scope.ticket()
    let opened: Awaited<ReturnType<ReviewStore['open']>>
    try { opened = await this.journal.open(this.ownerId) } catch { opened = { available: false, sessions: [], problems: [] } }
    if (!this.scope.isCurrent(ticket)) return
    for (const kind of importKinds) {
      if (this.state.slots[kind].session) continue
      const summary = opened.sessions.find(item => item.kind === kind)
      if (!summary) continue
      const loaded = await this.journal.load(this.ownerId, summary.sessionId).catch(() => null)
      if (!this.scope.isCurrent(ticket)) return
      if (loaded?.status !== 'ok' || !resumable(loaded.session) || this.state.slots[kind].session) continue
      this.setSlot(kind, emptySlot({ session: loaded.session, storage: 'durable', restored: true }))
    }
    this.risks = opened.available ? await this.journal.pendingRisks(this.ownerId).catch(() => this.risks) : this.risks
    if (!this.scope.isCurrent(ticket)) return
    this.state = { ...this.state, phase: 'ready', storageAvailable: opened.available }
    this.emit()
    // Un salvataggio interrotto si verifica subito con la sua chiave; un'analisi interrotta si cerca, non si ripete.
    void this.resume()
  }

  private async runRead(kind: ImportKind, generation: number, mediaType: string | null) {
    const slot = this.state.slots[kind]
    const session = slot.session!
    const bytes = slot.original!
    const format = session.file.format
    const ticket = this.scope.ticket()
    const controller = new AbortController()
    const onStop = () => controller.abort()
    ticket.signal.addEventListener('abort', onStop, { once: true })
    this.reads[kind] = controller
    const stale = () => this.generations[kind] !== generation || !this.scope.isCurrent(ticket) || this.state.slots[kind].session?.sessionId !== session.sessionId
    try {
      const reader = this.readers[format] ??= this.createReader(format)
      const result = await reader.read({ bytes, metadata: { format, mediaType }, signal: controller.signal })
      if (stale()) return
      if (result.document.sourceHash !== session.file.sourceHash) throw new ReaderWorkerError('invalid_response', 'Il lettore ha restituito un documento diverso dal file scelto.')
      const read = this.apply(this.state.slots[kind].session!, { type: 'read_succeeded', document: result.document, sourceHash: result.document.sourceHash })
      if (!read) return
      // Il DOCX si consulta dai blocchi: i byte servono ancora solo per disegnare le pagine del PDF.
      this.patch(kind, { session: read, metadata: result.metadata, problem: null, original: format === 'pdf' ? bytes : null })
      await this.persist(kind, read)
    } catch (error) {
      if (stale() || controller.signal.aborted) return
      const problem = problemOf(error)
      const failed = this.apply(this.state.slots[kind].session!, { type: 'read_failed', error: { code: problem.code, message: problem.message } })
      // I byte restano solo se una nuova lettura può riuscire (guasto del worker, non del file).
      this.patch(kind, { session: failed ?? this.state.slots[kind].session, problem, original: problem.retry ? bytes : null })
    } finally {
      ticket.signal.removeEventListener('abort', onStop)
      if (this.reads[kind] === controller) delete this.reads[kind]
    }
  }

  /**
   * Scrive nel journal l'ultima versione della sessione. Le scritture di uno slot sono in fila: ognuna parte
   * dalla revisione della precedente, così eventi ravvicinati (analisi che arriva durante un edit) non si
   * scambiano per un'altra scheda; un evento applicato durante la scrittura resta in memoria e va nella successiva.
   */
  private persist(kind: ImportKind, session: ImportSession): Promise<void> {
    const write = this.writes[kind].then(() => this.writeLatest(kind, session.sessionId))
    this.writes[kind] = write.catch(() => undefined)
    return write
  }

  private async writeLatest(kind: ImportKind, sessionId: string) {
    const ticket = this.scope.ticket()
    const session = this.state.slots[kind].session
    if (!session || session.sessionId !== sessionId) return
    const result = await this.journal.save(session)
    const current = this.state.slots[kind].session
    if (!this.scope.isCurrent(ticket) || current?.sessionId !== session.sessionId) {
      // Rimossa o sostituita durante la scrittura: la voce appena scritta non deve restare.
      if (result.ok) await this.journal.discard(this.ownerId, session.sessionId).catch(() => undefined)
      return
    }
    // Scritta la versione `session`; se nel frattempo ne è arrivata una più nuova, questa riparte dalla revisione scritta.
    const latest = (written: ImportSession) => current === session ? written : rebase(current, written)
    if (result.ok) this.patch(kind, { session: latest(result.session), storage: 'durable', storageMessage: null })
    else if (result.reason === 'conflict') this.patch(kind, { session: current === session ? result.session : { ...current, persistence: 'volatile' }, storage: 'conflict', storageMessage: 'Questa importazione è stata modificata in un’altra scheda: ricaricala per vedere la versione aggiornata.' })
    else this.patch(kind, {
      session: current === session ? result.session : { ...current, persistence: 'volatile' }, storage: 'volatile',
      storageMessage: result.reason === 'quota'
        ? 'Spazio del dispositivo esaurito: l’importazione resta solo in questa pagina e andrà persa chiudendola o ricaricandola.'
        : 'L’archivio del dispositivo non è disponibile (per esempio in navigazione privata): l’importazione resta solo in questa pagina e andrà persa chiudendola o ricaricandola.',
    })
    await this.refreshRisks()
  }

  /** Evento applicato alla sessione `sessionId` dello slot e scritto; null se la sessione o l'account sono cambiati. */
  private async dispatch(kind: ImportKind, sessionId: string, event: SessionEvent): Promise<DispatchResult | null> {
    const session = this.state.slots[kind].session
    if (!session || session.sessionId !== sessionId) return null
    const next = this.apply(session, event)
    if (!next) return null
    const ticket = this.scope.ticket()
    this.patch(kind, { session: next })
    await this.persist(kind, next)
    const slot = this.state.slots[kind]
    if (!this.scope.isCurrent(ticket) || slot.session?.sessionId !== sessionId) return null
    return { session: slot.session, storage: slot.storage }
  }

  /** Sessione nuova con un documento già letto (nessuna lettura, nessuna rete), scritta nel journal. */
  private async adopt(kind: ImportKind, file: ImportSession['file'], document: NormalizedDocument, original: Uint8Array | null, metadata: DocumentReadMetadata | null) {
    let session = createImportSession({ ownerId: this.ownerId, sessionId: this.newId(), kind, file: { ...file }, at: this.now() })
    session = this.apply(session, { type: 'read_started' }) ?? session
    session = this.apply(session, { type: 'read_succeeded', document, sourceHash: document.sourceHash }) ?? session
    this.setSlot(kind, emptySlot({ session, original, metadata }))
    await this.persist(kind, session)
  }

  /** Eventi locali della revisione, senza rete: il riduttore decide se sono ammessi. */
  private async localEvent(kind: ImportKind, event: SessionEvent) {
    const session = this.state.slots[kind].session
    if (!session) return null
    return this.dispatch(kind, session.sessionId, event)
  }

  /** Elimina una sessione superata dal journal (se vi era scritta). */
  private async forget(session: ImportSession) {
    if (session.revision === null) return
    await this.journal.discard(this.ownerId, session.sessionId).catch(() => undefined)
    await this.refreshRisks()
  }

  private async refreshRisks() {
    if (this.state.storageAvailable === false) return
    const ticket = this.scope.ticket()
    const risks = await this.journal.pendingRisks(this.ownerId).catch(() => null)
    if (!risks || !this.scope.isCurrent(ticket)) return
    this.risks = risks
    this.emit()
  }

  private apply(session: ImportSession, event: DistributiveOmit<ImportEvent, 'ownerId' | 'sessionId' | 'at'>): ImportSession | null {
    const outcome = applyImportEvent(session, { ...event, ownerId: this.ownerId, sessionId: session.sessionId, at: this.now() } as ImportEvent)
    return outcome.applied ? outcome.state : null
  }

  private nextGeneration(kind: ImportKind) { return ++this.generations[kind] }
  private abortRead(kind: ImportKind) { this.reads[kind]?.abort(); delete this.reads[kind] }

  private setSlot(kind: ImportKind, slot: ImportSlot) {
    this.state = { ...this.state, slots: { ...this.state.slots, [kind]: slot } }
    this.emit()
  }
  private patch(kind: ImportKind, patch: Partial<ImportSlot>) { this.setSlot(kind, { ...this.state.slots[kind], ...patch }) }

  private emit() {
    const slots = importKinds.map(kind => this.state.slots[kind])
    const busy = slots.some(slot => slot.session !== null && isBusy(slot.session))
    const unsaved = slots.some(slot => slot.session !== null && (isDirty(slot.session) || (slot.session.persistence === 'volatile' && slot.session.document !== null)))
    const guards = { busy, unsaved, logoutRisk: busy || unsaved || this.risks.localDrafts > 0 || this.risks.uncertainCommands > 0 }
    const previous = this.state.guards
    if (previous.busy !== guards.busy || previous.unsaved !== guards.unsaved || previous.logoutRisk !== guards.logoutRisk) this.state = { ...this.state, guards }
    for (const listener of [...this.listeners]) listener()
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** Versione in memoria più nuova di quella appena scritta: riparte dalla revisione scritta (e dal journal del comando, se è lo stesso). */
function rebase(newer: ImportSession, written: ImportSession): ImportSession {
  const sameCommand = newer.commit && written.commit && newer.commit.journalRevision === null
    && newer.commit.commandHash === written.commit.commandHash && newer.commit.command.requestId === written.commit.command.requestId
  return { ...newer, revision: written.revision, persistence: written.persistence, commit: sameCommand ? { ...newer.commit!, journalRevision: written.commit!.journalRevision } : newer.commit }
}

export const createImportReviewStore = (ownerId: string, options: ImportReviewOptions = {}) => new ImportReviewStore(ownerId, options)

/** Logout senza motore caricato: nessuna sessione di questo account resta sul dispositivo. */
export async function clearImportDevice(ownerId: string) {
  await new ReviewStore(indexedDbBackend(globalThis.indexedDB)).clearOwner(ownerId).catch(() => undefined)
}
