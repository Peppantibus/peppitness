import { applyOp, emptyDiary, emptyResults, mealLogKey, nextRestTimer, opKey, replay, setValues } from '../domain/diary.ts'
import type { DiaryData, DiaryOp } from '../domain/diary.ts'
import type { DayType, LocalDate, Meal, MealStatus, RestTimerState, SetResult, WorkoutDay, WorkoutSession } from '../domain/types.ts'
import { keyValueArchive } from './diary-archive.ts'
import type { ServerArchive, ServerCopy } from './diary-archive.ts'
import { DiaryFailure, dayFromRow, mealLogFromRow, mergeDiary, serverTime, sessionFromRow, setFromRow } from './diary-repository.ts'
import type { DiaryTransport, Row } from './diary-repository.ts'

/**
 * Da risolvere con una scelta esplicita:
 * - conflict: valore diverso online; *Mantieni il mio* o *Usa quello online*.
 * - blocked: seduta non avviabile ora (un'altra è in corso online); le sue registrazioni
 *   restano sul dispositivo finché si sceglie *Riprova* o *Scarta dal dispositivo*.
 * - rejected: respinto in modo definitivo dal database; si può solo scartare.
 */
export interface DiaryConflict { id: string; op: DiaryOp; kind: 'conflict' | 'blocked' | 'rejected'; label: string; local: string; remote: string; sessionId?: string }

export interface DiaryState {
  /** loading: nessun dato sul dispositivo; ready: vista disponibile (anche offline). */
  phase: 'loading' | 'ready' | 'error'
  view: DiaryData
  restTimer: RestTimerState | null
  pending: number
  conflicts: DiaryConflict[]
  sync: 'local' | 'synced' | 'pending' | 'sending' | 'waiting' | 'conflict'
  refreshedAt: string | null
  storage: boolean
  message: string
}

export interface KeyValueStorage { get(key: string): string | null; set(key: string, value: string): void; remove(key: string): void }
export const memoryStorage = (): KeyValueStorage => { const map = new Map<string, string>(); return { get: key => map.get(key) ?? null, set: (key, value) => { map.set(key, value) }, remove: key => { map.delete(key) } } }
export const browserStorage: KeyValueStorage = {
  get: key => { try { return window.localStorage.getItem(key) } catch { return null } },
  set: (key, value) => { window.localStorage.setItem(key, value) },
  remove: key => { try { window.localStorage.removeItem(key) } catch { /* archivio non disponibile */ } },
}

/** Parte locale, piccola e sincrona (localStorage): ciò che esiste solo su questo dispositivo. */
interface LocalPart {
  version: 2; queue: DiaryOp[]; conflicts: DiaryConflict[]; restTimer: RestTimerState | null
  /** Operazioni già inviate almeno una volta: il server potrebbe averle applicate. */
  attempted: string[]
  /** Sedute le cui operazioni restano ferme sul dispositivo in attesa di una scelta. */
  blocked: string[]
  /** Cambia a ogni salvataggio della copia confermata: avvisa le altre schede di rileggerla. */
  serverStamp: string | null
}
type Persisted = Omit<LocalPart, 'version'> & Omit<ServerCopy, 'version'>
/** Formato precedente: tutto in un'unica chiave (convertito al primo avvio). */
interface LegacyV1 extends Omit<Persisted, 'serverStamp' | 'cursor' | 'fullAt'> { version: 1 }

/** Dopo una lettura completa le incrementali bastano per un giorno; poi si rilegge tutto (rete di sicurezza). */
export const FULL_REFRESH_MS = 24 * 60 * 60 * 1000
/** Le incrementali ripartono un po' prima del cursore: scritture lente o orologi non allineati non sfuggono. */
export const CURSOR_OVERLAP_MS = 5 * 60 * 1000

const describe = (op: DiaryOp, data: DiaryData): { label: string; value: string } => {
  const session = 'sessionId' in op ? data.sessions.find(item => item.id === op.sessionId) : op.type === 'start' ? op.session : undefined
  switch (op.type) {
    case 'set': {
      const exercise = session?.day.exercises.find(item => item.id === op.prescriptionId)
      return { label: `${exercise?.name ?? 'Esercizio'} · serie ${op.index + 1}`, value: `${op.result.load || '—'} × ${op.result.amount || '—'}${op.result.completed ? ' · completata' : ''}` }
    }
    case 'start': {
      const sets = Object.values(op.session.results).flat()
      const done = data.sessions.find(item => item.id === op.session.id)
      const count = done ? Object.values(done.results).flat().filter(set => set.completed).length : sets.filter(set => set.completed).length
      return { label: `Seduta ${op.session.day.title} · ${op.session.date}`, value: `Avviata su questo dispositivo, ${count} serie completate` }
    }
    case 'complete': return { label: `Seduta ${session?.day.title ?? ''}`.trim(), value: 'Completata' }
    case 'discard': return { label: `Seduta ${session?.day.title ?? ''}`.trim(), value: 'Annullata' }
    case 'meal': return { label: `${op.meal.name} · ${op.date}`, value: `${op.status}${op.note ? ` · ${op.note}` : ''}` }
    case 'day': return { label: `Giornata ${op.date}`, value: op.dayType === 'rest' ? 'Riposo' : 'Palestra' }
  }
}
const sessionOf = (op: DiaryOp) => op.type === 'start' ? op.session.id : 'sessionId' in op ? op.sessionId : null

/**
 * Diario per account: la vista locale è la vista confermata dal server con in cima le
 * operazioni in coda. Tutto è conservato sul dispositivo prima dell'invio; le operazioni
 * partono in ordine con la sessione dell'account, revisione attesa e verifica dopo
 * risposte perse. Un conflitto non viene mai risolto in base al solo orario.
 * Più schede dello stesso account condividono l'archivio: ogni scrittura unisce le
 * operazioni salvate dalle altre invece di sovrascriverle.
 */
export class DiaryStore {
  private transport: DiaryTransport | null
  private storage: KeyValueStorage
  private archive: ServerArchive
  readonly storageKey: string
  private legacyKey: string
  private data: Persisted
  /** Copia confermata letta dall'archivio (asincrono): prima nessun invio né lettura dal server. */
  private hydrated = false
  private hydration: Promise<void>
  private serverDirty = false
  private saving: Promise<boolean> | null = null
  private state: DiaryState
  private listeners = new Set<() => void>()
  private flushing: AbortController | null = null
  private inFlight: string | null = null
  private loading: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /** Archivio scartato con l'uscita: nessuna risposta tardiva può riscriverlo. */
  private cleared = false
  private waiting = false
  private acked = 0
  /** Operazioni e conflitti chiusi da questa scheda: non vanno reintrodotti dall'archivio. */
  private removed = new Set<string>()

  /**
   * `archive`: dove sta la copia confermata (IndexedDB nel browser). Senza, la stessa memoria chiave/valore
   * della coda in una chiave separata: comodo nei test e senza Supabase.
   */
  constructor(transport: DiaryTransport | null, storage: KeyValueStorage, owner: string, archive?: ServerArchive) {
    this.transport = transport; this.storage = transport ? storage : memoryStorage()
    this.archive = transport && archive ? archive : keyValueArchive(this.storage, owner)
    this.storageKey = `peppitness:diary:v2:${owner}`; this.legacyKey = `peppitness:diary:v1:${owner}`
    const legacy = this.readLegacy()
    this.data = { ...this.empty(), ...(legacy ?? {}), ...(this.readLocal() ?? {}) }
    if (legacy) {
      // Conversione dal formato v1: la coda passa subito nella nuova chiave; la vecchia si toglie
      // solo quando anche la copia confermata è al sicuro nell'archivio.
      this.persistLocal()
    }
    this.state = { phase: transport ? 'loading' : 'ready', view: emptyDiary(), restTimer: this.data.restTimer, pending: 0, conflicts: [], sync: 'local', refreshedAt: null, storage: true, message: '' }
    this.state = { ...this.state, ...this.derived() }
    this.hydration = this.hydrate(legacy)
  }

  private empty(): Persisted {
    return { server: emptyDiary(), revisions: {}, refreshedAt: null, cursor: null, fullAt: null, queue: [], conflicts: [], restTimer: null, attempted: [], blocked: [], serverStamp: null }
  }
  private readLocal(): Omit<LocalPart, 'version'> | null {
    try {
      const raw = this.storage.get(this.storageKey)
      const parsed = raw ? JSON.parse(raw) as LocalPart : null
      if (parsed?.version !== 2 || !Array.isArray(parsed.queue)) return null
      const { version: _version, ...local } = { ...this.localPart(), ...parsed }
      return local
    } catch { return null }
  }
  private readLegacy(): Omit<Persisted, 'serverStamp'> | null {
    try {
      const raw = this.storage.get(this.legacyKey)
      const parsed = raw ? JSON.parse(raw) as LegacyV1 : null
      if (parsed?.version !== 1 || !Array.isArray(parsed.queue) || !parsed.server) return null
      const { version: _version, ...rest } = parsed
      return { ...this.empty(), ...rest, cursor: null, fullAt: null }
    } catch { return null }
  }
  private localPart(): LocalPart {
    const { queue, conflicts, restTimer, attempted, blocked, serverStamp } = this.data ?? this.empty()
    return { version: 2, queue, conflicts, restTimer, attempted, blocked, serverStamp }
  }
  private serverCopy(): ServerCopy {
    const { server, revisions, refreshedAt, cursor, fullAt } = this.data
    return { version: 2, server, revisions, refreshedAt, cursor, fullAt }
  }
  /** Copia confermata dall'archivio; resta quella più recente fra archivio e copia v1 in conversione. */
  private async hydrate(legacy: Omit<Persisted, 'serverStamp'> | null) {
    let copy = await this.archive.load().catch((): ServerCopy | null => null)
    if (this.cleared) return
    if (legacy && (!copy || (legacy.refreshedAt ?? '') > (copy.refreshedAt ?? ''))) copy = { version: 2, server: legacy.server, revisions: legacy.revisions, refreshedAt: legacy.refreshedAt, cursor: null, fullAt: null }
    if (copy && (copy.refreshedAt ?? '') >= (this.data.refreshedAt ?? '')) this.adopt(copy)
    this.hydrated = true
    if (legacy) { this.serverDirty = true; void this.saveServer().then(saved => { if (saved) this.storage.remove(this.legacyKey) }) }
    this.emit(this.data.refreshedAt ? { phase: 'ready' } : {})
  }
  private adopt(copy: ServerCopy) {
    // Le revisioni lette altrove possono essere più recenti per alcune righe: si tiene la maggiore.
    const revisions = { ...copy.revisions }
    for (const [key, revision] of Object.entries(this.data.revisions)) if (revision > (revisions[key] ?? 0)) revisions[key] = revision
    Object.assign(this.data, { server: copy.server, revisions, refreshedAt: copy.refreshedAt, cursor: copy.cursor, fullAt: copy.fullAt })
  }
  /** Unisce ciò che un'altra scheda ha salvato e che questa non ha chiuso. */
  private merge(stored: Omit<LocalPart, 'version'> | null) {
    if (!stored) return
    const own = new Set(this.data.queue.map(op => op.opId))
    for (const op of stored.queue) if (!own.has(op.opId) && !this.removed.has(op.opId)) this.data.queue.push(op)
    const conflicts = new Set(this.data.conflicts.map(item => item.id))
    for (const item of stored.conflicts) if (!conflicts.has(item.id) && !this.removed.has(item.id)) this.data.conflicts.push(item)
    const live = new Set(this.data.queue.map(op => op.opId))
    this.data.attempted = [...new Set([...this.data.attempted, ...stored.attempted])].filter(id => live.has(id))
    const sessions = new Set(this.data.queue.map(sessionOf))
    const added = stored.blocked.filter(id => !this.data.blocked.includes(id) && !this.removed.has(`blocked:${id}`))
    this.data.blocked = [...this.data.blocked, ...added].filter(id => sessions.has(id))
  }
  /** Solo la parte locale: pochi KB anche dopo anni di storia, quindi ogni tasto resta veloce. */
  private persistLocal() {
    try { this.merge(this.readLocal()); this.storage.set(this.storageKey, JSON.stringify(this.localPart())); return true } catch { return false }
  }
  /**
   * Salvataggi della copia confermata in sequenza, sempre con l'ultima versione. Se l'archivio
   * non scrive, la copia vecchia viene tolta: meglio rileggere dal server che mostrare dati superati.
   */
  private saveServer(): Promise<boolean> {
    // Il ciclo in corso salva anche le modifiche arrivate nel frattempo.
    if (this.saving) return this.saving
    const run = async () => {
      let saved = true
      while (this.serverDirty && !this.cleared) {
        this.serverDirty = false
        try {
          await this.archive.save(this.serverCopy())
          if (this.cleared) break
          this.data.serverStamp = crypto.randomUUID()
          this.persistLocal()
        } catch {
          saved = false
          await this.archive.remove().catch(() => undefined)
        }
      }
      return saved
    }
    const saving: Promise<boolean> = run().finally(() => { if (this.saving === saving) this.saving = null })
    this.saving = saving
    return saving
  }
  private derived(): Partial<DiaryState> {
    const pending = this.data.queue.length
    return {
      view: replay(this.data.server, this.data.queue), restTimer: this.data.restTimer, pending, conflicts: this.data.conflicts, refreshedAt: this.data.refreshedAt,
      sync: !this.transport ? 'local' : this.data.conflicts.length ? 'conflict' : this.inFlight ? 'sending' : pending ? (this.waiting ? 'waiting' : 'pending') : 'synced',
    }
  }
  private emit(value: Partial<DiaryState> = {}) {
    if (this.cleared) return
    const stored = this.persistLocal()
    if (this.serverDirty && this.hydrated) void this.saveServer()
    this.state = { ...this.state, ...this.derived(), ...value, storage: stored }
    this.listeners.forEach(listener => listener())
  }
  private drop(predicate: (op: DiaryOp) => boolean) {
    this.data.queue = this.data.queue.filter(op => {
      if (!predicate(op)) return true
      this.removed.add(op.opId); return false
    })
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  get hasPending() { return this.data.queue.length > 0 || this.data.conflicts.length > 0 }
  /** Solo senza Supabase: dati in memoria che il reload cancella. */
  get hasVolatileData() { return !this.transport && (this.data.queue.length > 0) }
  /** Riattiva invii e letture (StrictMode e rimontaggi usano la stessa istanza). */
  start = () => { this.stopped = false }
  stop = () => {
    this.stopped = true
    this.flushing?.abort(); this.flushing = null; this.inFlight = null
    this.loading?.abort(); this.loading = null
    if (this.timer) clearTimeout(this.timer)
  }

  /** Un'altra scheda ha aggiornato l'archivio: si adotta la sua copia confermata e si uniscono le code. */
  reloadFromDevice = () => {
    const stored = this.readLocal()
    if (!stored) return
    if (stored.serverStamp && stored.serverStamp !== this.data.serverStamp) {
      this.data.serverStamp = stored.serverStamp
      void this.archive.load().then(copy => {
        if (!copy || this.cleared || (copy.refreshedAt ?? '') < (this.data.refreshedAt ?? '')) return
        this.adopt(copy); this.emit()
      }, () => undefined)
    }
    // Le operazioni assenti nell'archivio sono state chiuse dall'altra scheda (l'archivio
    // contiene sempre l'unione delle code): tranne quella in invio qui, non si reinviano.
    if (this.state.storage) {
      const kept = new Set(stored.queue.map(op => op.opId))
      this.data.queue = this.data.queue.filter(op => kept.has(op.opId) || op.opId === this.inFlight)
      const conflicts = new Set(stored.conflicts.map(item => item.id))
      this.data.conflicts = this.data.conflicts.filter(item => conflicts.has(item.id))
    }
    this.data.restTimer = stored.restTimer
    this.emit()
    this.schedule(0)
  }

  // ------------------------------------------------------------------ letture
  refresh = async (): Promise<void> => {
    if (!this.transport || this.stopped) return
    await this.hydration
    if (this.loading || this.stopped || this.cleared) return
    const controller = new AbortController(); this.loading = controller
    const acked = this.acked
    if (!this.data.refreshedAt) this.emit({ phase: 'loading', message: '' })
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
      const next = await this.read(signal)
      if (this.loading !== controller || controller.signal.aborted) return
      this.loading = null
      // Un invio confermato durante la lettura potrebbe mancare dalla copia letta: si rilegge.
      if (acked !== this.acked) { void this.refresh(); return }
      Object.assign(this.data, next, { refreshedAt: new Date().toISOString() })
      this.serverDirty = true
      this.emit({ phase: 'ready', message: '' })
      this.schedule(0)
    } catch {
      if (this.loading !== controller || controller.signal.aborted) return
      this.emit(this.data.refreshedAt ? { phase: 'ready', message: 'Non riesco ad aggiornare il diario online. Stai vedendo i dati salvati sul dispositivo.' }
        : { phase: 'error', message: 'Non riesco a caricare il diario. Controlla la connessione e riprova.' })
    } finally { if (this.loading === controller) this.loading = null }
  }

  /**
   * Lettura incrementale (righe cambiate dopo il cursore) quando c'è una lettura completa recente;
   * altrimenti, o se le modifiche non si applicano alla copia, lettura completa.
   */
  private async read(signal: AbortSignal): Promise<Pick<Persisted, 'server' | 'revisions' | 'cursor' | 'fullAt'>> {
    const transport = this.transport!
    const { cursor, fullAt } = this.data
    const recent = fullAt !== null && Date.now() - Date.parse(fullAt) < FULL_REFRESH_MS
    if (transport.loadChanges && cursor && recent && this.data.refreshedAt) {
      const since = new Date(serverTime(cursor) - CURSOR_OVERLAP_MS).toISOString()
      const changes = await transport.loadChanges(since, signal)
      try {
        const merged = mergeDiary(this.data.server, this.data.revisions, changes)
        return { server: merged.data, revisions: merged.revisions, cursor: changes.cursor && serverTime(changes.cursor) > serverTime(cursor) ? changes.cursor : cursor, fullAt }
      } catch { /* copia non allineata: si ricostruisce da capo */ }
    }
    const full = await transport.loadAll(signal)
    return { server: full.data, revisions: full.revisions, cursor: full.cursor ?? null, fullAt: new Date().toISOString() }
  }

  // ------------------------------------------------------------------ scritture locali
  private enqueue(op: DiaryOp) {
    const key = opKey(op)
    const replaceable = op.type === 'set' || op.type === 'meal' || op.type === 'day'
    // Si uniscono solo operazioni mai inviate: una già tentata potrebbe essere stata
    // applicata dal server con risposta persa e deve essere verificata così com'è.
    const index = replaceable ? this.data.queue.findIndex(item => opKey(item) === key && item.opId !== this.inFlight && !this.data.attempted.includes(item.opId)) : -1
    if (index >= 0 && this.data.queue.slice(index + 1).every(item => opKey(item) !== key)) {
      const previous = this.data.queue[index]!
      this.removed.add(previous.opId)
      this.data.queue[index] = op.type === 'meal' && previous.type === 'meal' ? { ...op, meal: previous.meal, dayType: previous.dayType } : op
    } else this.data.queue.push(op)
    this.emit({ message: '' })
    this.schedule(600)
  }
  private get view() { return replay(this.data.server, this.data.queue) }

  startSession = (args: { date: LocalDate; day: WorkoutDay; planId: string; versionId: string; timeZone: string }) => {
    if (this.view.sessions.some(session => !session.completedAt)) return null
    const session: WorkoutSession = { id: crypto.randomUUID(), planId: args.planId, date: args.date, day: structuredClone(args.day), startedAt: new Date().toISOString(), results: emptyResults(args.day) }
    this.enqueue({ type: 'start', opId: crypto.randomUUID(), session, planId: args.planId, versionId: args.versionId, timeZone: args.timeZone })
    return session.id
  }
  updateSet = (sessionId: string, prescriptionId: string, index: number, result: SetResult) => {
    const session = this.view.sessions.find(item => item.id === sessionId)
    if (!session || !session.results[prescriptionId]?.[index]) return
    this.data.restTimer = session.completedAt ? this.data.restTimer : nextRestTimer(this.data.restTimer, session, prescriptionId, index, result)
    this.enqueue({ type: 'set', opId: crypto.randomUUID(), sessionId, prescriptionId, index, result: { ...result } })
  }
  /** Valori incompleti (es. "12,") non inviabili: si torna a quelli confermati. */
  discardIncomplete = (sessionId: string) => {
    const before = this.data.queue.length
    this.drop(op => op.type === 'set' && op.sessionId === sessionId && op.opId !== this.inFlight && !this.setValuesFor(op))
    if (this.data.queue.length !== before) this.emit()
  }
  completeSession = (sessionId: string) => {
    const session = this.view.sessions.find(item => item.id === sessionId)
    if (!session || session.completedAt) return
    this.data.restTimer = null
    this.drop(op => op.type === 'set' && op.sessionId === sessionId && op.opId !== this.inFlight && !this.setValuesFor(op))
    this.enqueue({ type: 'complete', opId: crypto.randomUUID(), sessionId, at: new Date().toISOString() })
  }
  discardSession = (sessionId: string) => {
    const session = this.view.sessions.find(item => item.id === sessionId)
    if (!session || session.completedAt) return
    if (this.data.restTimer?.sessionId === sessionId) this.data.restTimer = null
    const blocked = this.data.conflicts.find(item => item.sessionId === sessionId && this.data.blocked.includes(sessionId))
    // Avvio respinto dal server: la seduta esiste solo qui e si annulla sul dispositivo.
    if (blocked) { this.useOnline(blocked.id); return }
    const start = this.data.queue.find(op => op.type === 'start' && op.session.id === sessionId)
    if (start && this.inFlight !== start.opId && !this.data.attempted.includes(start.opId)) {
      // Mai inviata al server: basta rimuovere le operazioni locali della seduta.
      this.drop(op => sessionOf(op) === sessionId)
      this.unblock(sessionId)
      this.emit({ message: 'Allenamento annullato.' })
    } else this.enqueue({ type: 'discard', opId: crypto.randomUUID(), sessionId })
  }
  /** `dayType`: tipo effettivo mostrato all'utente (annotato o dedotto dalla scheda). */
  recordMeal = (date: LocalDate, planId: string, meal: Meal, status: MealStatus, note: string, dayType?: DayType) => {
    const existing = this.view.mealLogs[mealLogKey(date, meal.id)]
    this.enqueue({ type: 'meal', opId: crypto.randomUUID(), date, planId, meal: existing?.snapshot ?? structuredClone(meal), status, note, dayType: existing?.dayType ?? this.view.dayTypes[date] ?? dayType ?? 'training' })
  }
  setDayType = (date: LocalDate, dayType: DayType) => {
    if (this.view.dayTypes[date] !== dayType) this.enqueue({ type: 'day', opId: crypto.randomUUID(), date, dayType })
  }
  setRestTimer = (timer: RestTimerState | null) => { this.data.restTimer = timer; this.emit() }

  // ------------------------------------------------------------------ conflitti
  private closeConflict(conflict: DiaryConflict) {
    this.data.conflicts = this.data.conflicts.filter(item => item.id !== conflict.id)
    this.removed.add(conflict.id)
  }
  private unblock(sessionId: string) {
    this.data.blocked = this.data.blocked.filter(id => id !== sessionId)
    this.removed.add(`blocked:${sessionId}`)
  }
  keepMine = (conflictId: string) => {
    const conflict = this.data.conflicts.find(item => item.id === conflictId)
    if (!conflict || conflict.kind === 'rejected') return
    this.closeConflict(conflict)
    // blocked: nuovo tentativo dell'avvio con le registrazioni rimaste sul dispositivo.
    if (conflict.kind === 'blocked') { if (conflict.sessionId) this.unblock(conflict.sessionId) }
    // conflict: la revisione online è già stata letta e diventa la revisione attesa.
    else this.data.queue.push({ ...conflict.op, opId: crypto.randomUUID() })
    this.emit({ message: '' }); this.schedule(0)
  }
  useOnline = (conflictId: string) => {
    const conflict = this.data.conflicts.find(item => item.id === conflictId)
    if (!conflict) return
    this.closeConflict(conflict)
    if (conflict.sessionId && this.data.blocked.includes(conflict.sessionId)) {
      // Scarto esplicito della seduta non avviabile e di tutte le sue registrazioni.
      const sessionId = conflict.sessionId
      this.drop(op => sessionOf(op) === sessionId)
      this.unblock(sessionId)
      if (this.data.restTimer?.sessionId === sessionId) this.data.restTimer = null
    }
    this.emit({ message: '' })
  }

  // ------------------------------------------------------------------ invio
  /**
   * Riprova su richiesta dell'utente: interrompe un invio o una lettura rimasti appesi
   * (rete tornata a metà) e riparte subito. L'operazione interrotta resta in coda ed è
   * verificata al nuovo invio, quindi non viene né persa né duplicata.
   */
  retryNow = () => {
    if (!this.transport || this.stopped) return
    this.flushing?.abort(); this.flushing = null; this.inFlight = null
    this.loading?.abort(); this.loading = null
    this.waiting = false
    this.schedule(0)
    void this.refresh()
  }
  schedule = (delay: number) => {
    if (!this.transport || this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; void this.flush() }, delay)
  }
  flush = async () => {
    if (!this.transport || this.flushing || this.stopped) return
    // Senza la copia confermata le revisioni attese non sono note: si invia dopo averla letta.
    if (!this.hydrated) await this.hydration
    if (this.flushing || this.stopped || this.cleared) return
    const controller = new AbortController(); this.flushing = controller
    const active = () => this.flushing === controller && !controller.signal.aborted
    try {
      while (active()) {
        const op = this.data.queue.find(item => !this.data.blocked.includes(sessionOf(item) ?? '') && (item.type !== 'set' || this.setValuesFor(item)))
        if (!op) break
        this.inFlight = op.opId
        if (!this.data.attempted.includes(op.opId)) this.data.attempted.push(op.opId)
        this.emit()
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
        try {
          await this.send(op, signal)
          this.drop(item => item.opId === op.opId)
          this.data.attempted = this.data.attempted.filter(id => id !== op.opId)
          this.acked++
          this.waiting = false
        } catch (error) {
          if (!active()) return
          let kind = error instanceof DiaryFailure ? error.kind : 'unavailable'
          // Con il secondo fattore mancante la RLS respinge tutto: non è un rifiuto del dato, si attende la verifica.
          // I conflitti restano tali: la revisione online è già stata letta e non va sovrascritta in silenzio.
          if (kind === 'rejected' && !await this.mfaSatisfied(signal)) kind = 'session'
          if (!active()) return
          if (kind === 'unavailable' || kind === 'session') {
            // L'operazione resta in coda sul dispositivo; nuovo tentativo più tardi.
            this.inFlight = null; this.waiting = true
            this.emit(); this.schedule(30_000)
            return
          }
          this.reject(op, kind === 'rejected' ? 'rejected' : 'conflict', error instanceof RemoteValue ? error.remote : '')
        } finally { if (this.flushing === controller) this.inFlight = null }
        // Invio confermato o valore online adottato: la copia confermata va salvata.
        this.serverDirty = true
        this.emit()
      }
    } finally { if (this.flushing === controller) { this.flushing = null; this.inFlight = null; this.emit() } }
  }

  /** Nel dubbio (rete) non soddisfatto: meglio un nuovo tentativo che un rifiuto definitivo. */
  private async mfaSatisfied(signal: AbortSignal) {
    if (!this.transport?.mfaSatisfied) return true
    try { return await this.transport.mfaSatisfied(signal) } catch { return false }
  }

  private setValuesFor(op: Extract<DiaryOp, { type: 'set' }>) {
    const session = replay(this.data.server, this.data.queue).sessions.find(item => item.id === op.sessionId)
    const exercise = session?.day.exercises.find(item => item.id === op.prescriptionId)
    return exercise ? setValues(op.result, exercise.mode) : null
  }

  private reject(op: DiaryOp, kind: 'conflict' | 'rejected', remote: string) {
    const described = describe(op, replay(this.data.server, this.data.queue))
    this.data.attempted = this.data.attempted.filter(id => id !== op.opId)
    if (op.type === 'start') {
      // La seduta e le sue serie restano sul dispositivo, ferme, finché l'utente sceglie:
      // nessuna registrazione viene eliminata senza uno scarto esplicito.
      this.removed.delete(`blocked:${op.session.id}`)
      if (!this.data.blocked.includes(op.session.id)) this.data.blocked.push(op.session.id)
      this.data.conflicts.push({ id: crypto.randomUUID(), op, kind: kind === 'conflict' ? 'blocked' : 'rejected', sessionId: op.session.id, label: described.label, local: described.value,
        remote: remote || 'Il server ha respinto l’avvio di questa seduta.' })
      return
    }
    this.drop(item => item.opId === op.opId)
    if (op.type === 'discard' && kind === 'rejected') {
      // Seduta già completata online: le correzioni successive restano valide, solo l'annullamento cade.
      this.data.conflicts.push({ id: crypto.randomUUID(), op, kind: 'rejected', label: described.label, local: described.value, remote })
      return
    }
    this.data.conflicts.push({ id: crypto.randomUUID(), op, kind, label: described.label, local: described.value,
      remote: remote || (kind === 'rejected' ? 'Il server ha respinto questa registrazione.' : 'Valore diverso online.') })
  }

  private async send(op: DiaryOp, signal: AbortSignal) {
    const transport = this.transport!
    const key = opKey(op)
    const known = this.data.revisions[key]
    switch (op.type) {
      case 'start': {
        let row: Row
        try { row = await transport.start({ sessionId: op.session.id, versionId: op.versionId, dayId: op.session.day.id, date: op.session.date, timeZone: op.timeZone }, signal) }
        catch (error) {
          if (error instanceof DiaryFailure && error.kind === 'conflict') throw new RemoteValue('conflict', 'Un’altra seduta risulta già in corso online: completala o annullala, poi scegli Riprova. Le serie di questa seduta restano sul dispositivo.')
          throw error
        }
        const { session, revision } = sessionFromRow(row)
        this.data.revisions[key] = revision
        this.data.server = applyOp(this.data.server, { ...op, session: { ...session, results: op.session.results } })
        return
      }
      case 'discard': {
        const removed = await transport.discard(op.sessionId, signal)
        const remote = removed ? null : await transport.fetch('workout_sessions', { id: op.sessionId }, signal)
        if (remote && remote.status === 'completed') throw new RemoteValue('rejected', 'La seduta risulta già completata online.')
        // Senza secondo fattore la RLS nasconde la seduta: nulla è stato eliminato, si riprova dopo la verifica.
        if (!removed && !remote && !await this.mfaSatisfied(signal)) throw new DiaryFailure('session')
        this.data.server = { ...this.data.server, sessions: this.data.server.sessions.filter(item => item.id !== op.sessionId) }
        delete this.data.revisions[key]
        return
      }
      case 'complete': {
        const remote = await this.write('workout_sessions', { id: op.sessionId }, { status: 'completed' }, null, known, signal,
          row => row.status === 'completed', row => row.status === 'completed' ? 'Completata' : 'In corso')
        this.data.revisions[key] = Number(remote.revision)
        this.data.server = applyOp(this.data.server, { ...op, at: String(remote.completed_at) })
        return
      }
      case 'set': {
        const values = this.setValuesFor(op)!
        const remote = await this.write('workout_set_logs', { session_id: op.sessionId, prescription_id: op.prescriptionId, set_index: op.index }, values, null, known, signal,
          row => Number(row.load ?? NaN) === Number(values.load ?? NaN) && Number(row.amount ?? NaN) === Number(values.amount ?? NaN) && row.completed === values.completed,
          row => { const set = setFromRow(row).result; return `${set.load || '—'} × ${set.amount || '—'}${set.completed ? ' · completata' : ''}` })
        this.data.revisions[key] = Number(remote.revision)
        this.data.server = applyOp(this.data.server, op)
        return
      }
      case 'meal': {
        const values = { status: op.status, note: op.note }
        const remote = await this.write('meal_logs', { diary_date: op.date, meal_id: op.meal.id }, values,
          { meal_plan_id: op.planId, day_type: op.dayType, meal_snapshot: op.meal }, known, signal,
          row => row.status === op.status && row.note === op.note, row => `${typeof row.status === 'string' ? row.status : ''}${typeof row.note === 'string' && row.note ? ` · ${row.note}` : ''}`)
        this.data.revisions[key] = Number(remote.revision)
        const parsed = mealLogFromRow(remote)
        this.data.server = { ...this.data.server, mealLogs: { ...this.data.server.mealLogs, [mealLogKey(op.date, op.meal.id)]: parsed.log } }
        return
      }
      case 'day': {
        const remote = await this.write('diary_days', { diary_date: op.date }, { day_type: op.dayType }, null, known, signal,
          row => row.day_type === op.dayType, row => row.day_type === 'rest' ? 'Riposo' : 'Palestra')
        this.data.revisions[key] = Number(remote.revision)
        this.data.server = applyOp(this.data.server, op)
        return
      }
    }
  }

  /**
   * Insert se la riga non è mai stata letta, altrimenti update con revisione letta + 1.
   * Conflitto o risposta persa: rilettura; se i valori coincidono l'operazione è confermata,
   * altrimenti la vista confermata assume il valore online e il conflitto va risolto.
   */
  private async write(table: 'workout_sessions' | 'workout_set_logs' | 'meal_logs' | 'diary_days', key: Record<string, string | number>, values: Row, insertOnly: Row | null,
    known: number | undefined, signal: AbortSignal, same: (row: Row) => boolean, show: (row: Row) => string): Promise<Row> {
    const transport = this.transport!
    try {
      const row = known === undefined ? await transport.insert(table, { ...key, ...values, ...insertOnly }, signal) : await transport.update(table, key, values, known + 1, signal)
      if (row) return row
    } catch (error) {
      if (!(error instanceof DiaryFailure) || error.kind !== 'conflict') throw error
    }
    const remote = await transport.fetch(table, key, signal)
    if (remote && same(remote)) return remote
    if (!remote) throw new RemoteValue(known === undefined ? 'conflict' : 'rejected', 'Non più presente online.')
    this.adoptRemote(table, remote)
    throw new RemoteValue('conflict', show(remote))
  }

  private adoptRemote(table: string, row: Row) {
    try {
      if (table === 'workout_set_logs') {
        const set = setFromRow(row)
        this.data.revisions[`set:${set.sessionId}:${set.prescriptionId}:${set.index}`] = set.revision
        this.data.server = applyOp(this.data.server, { type: 'set', opId: '', sessionId: set.sessionId, prescriptionId: set.prescriptionId, index: set.index, result: set.result })
      } else if (table === 'meal_logs') {
        const meal = mealLogFromRow(row)
        this.data.revisions[`meal:${meal.date}:${meal.log.mealId}`] = meal.revision
        this.data.server = { ...this.data.server, mealLogs: { ...this.data.server.mealLogs, [mealLogKey(meal.date, meal.log.mealId)]: meal.log } }
      } else if (table === 'diary_days') {
        const day = dayFromRow(row)
        this.data.revisions[`day:${day.date}`] = day.revision
        this.data.server = applyOp(this.data.server, { type: 'day', opId: '', date: day.date, dayType: day.dayType })
      } else if (table === 'workout_sessions') {
        const { session, revision } = sessionFromRow(row)
        this.data.revisions[`session:${session.id}`] = revision
        if (session.completedAt) this.data.server = applyOp(this.data.server, { type: 'complete', opId: '', sessionId: session.id, at: session.completedAt })
      }
    } catch { /* riga non interpretabile: resta il conflitto, la prossima lettura completa riallinea */ }
  }

  /** Logout esplicito con scarto: rimuove archivio e coda di questo account dal dispositivo. */
  clearDevice = () => {
    this.cleared = true; this.stop()
    this.storage.remove(this.storageKey); this.storage.remove(this.legacyKey)
    // Dopo un eventuale salvataggio in corso: la rimozione arriva sempre per ultima.
    void (this.saving ?? Promise.resolve()).then(() => this.archive.remove()).catch(() => undefined)
  }
}

class RemoteValue extends DiaryFailure {
  readonly remote: string
  constructor(kind: 'conflict' | 'rejected', remote: string) { super(kind); this.remote = remote }
}
