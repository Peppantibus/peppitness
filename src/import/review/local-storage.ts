/**
 * Journal locale dell'importazione (task 07): IndexedDB dedicato (`peppitness-import`), separato dalla coda
 * localStorage del diario. Una voce per sessione d'importazione, chiave owner + sessione: documento
 * normalizzato, proposta, ID locali, decisioni, metadati del file e comando congelato con requestId. Mai i
 * byte originali. Nessuna cifratura promessa: il dispositivo protegge i dati come il resto dell'app.
 *
 * - Scritture condizionate alla revisione letta: due schede sulla stessa bozza producono un conflitto
 *   esplicito, mai una sovrascrittura silenziosa.
 * - Formato versionato: una voce di una versione più nuova non viene né letta né cancellata.
 * - Scadenza per inattività (7 giorni, come il server) tranne che per un comando inviato non riconciliato.
 * - All'apertura per un account le voci di altri account vengono eliminate; `clearOwner` al logout.
 * - Archivio assente, quota esaurita o scrittura fallita: la sessione diventa volatile e il chiamante deve
 *   avvisare prima della chiusura; senza journal durevole il salvataggio non parte (state.ts).
 */
import {
  importLocalStates, validateCommitCommand, validateImportReceipt, validateNormalizedDocument,
  type ExtractionKind,
} from '../contracts/index.ts'
import { verifyDraft } from './decisions.ts'
import {
  hasUncertainCommand, IMPORT_INACTIVITY_DAYS, IMPORT_SESSION_FORMAT, isExpired, markPersisted, markVolatile, resumeImportSession,
  type ImportSession,
} from './state.ts'

export const IMPORT_DB_NAME = 'peppitness-import'
export const IMPORT_DB_VERSION = 1
const STORE = 'sessions'
/** Formato della voce; una nuova versione aggiunge una migrazione e non riusa questo valore. */
export const IMPORT_RECORD_FORMAT = 'peppitness.import-local.v1'
const knownFormats = [IMPORT_RECORD_FORMAT] as const

export interface StoredRecord {
  key: string
  formatVersion: string
  ownerId: string
  sessionId: string
  revision: number
  updatedAt: string
  session: unknown
}

export class StorageConflictError extends Error {
  readonly storedRevision: number | null
  constructor(storedRevision: number | null) { super('La bozza è stata modificata altrove (un’altra scheda).'); this.name = 'StorageConflictError'; this.storedRevision = storedRevision }
}
export class StorageUnavailableError extends Error {
  readonly reason: 'unavailable' | 'quota' | 'newer_database' | 'failed'
  constructor(reason: StorageUnavailableError['reason'], message: string) { super(message); this.name = 'StorageUnavailableError'; this.reason = reason }
}

/** Archivio iniettabile: IndexedDB nell'app, memoria nei test o come ripiego volatile. */
export interface ReviewStorageBackend {
  get(key: string): Promise<StoredRecord | undefined>
  /** Scrive solo se la revisione archiviata è `expected` (null = voce assente); altrimenti StorageConflictError. */
  put(record: StoredRecord, expected: number | null): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<StoredRecord[]>
}

export const recordKey = (ownerId: string, sessionId: string) => `${ownerId}\u0000${sessionId}`

/** Archivio in memoria con copia strutturata in ingresso e in uscita, come IndexedDB. */
export function memoryBackend(): ReviewStorageBackend & { readonly records: Map<string, StoredRecord> } {
  const records = new Map<string, StoredRecord>()
  return {
    records,
    async get(key) { const found = records.get(key); return found ? structuredClone(found) : undefined },
    async put(record, expected) {
      const stored = records.get(record.key)?.revision ?? null
      if (stored !== expected) throw new StorageConflictError(stored)
      records.set(record.key, structuredClone(record))
    },
    async delete(key) { records.delete(key) },
    async list() { return [...records.values()].map(record => structuredClone(record)) },
  }
}

function storageError(error: unknown): Error {
  if (error instanceof StorageConflictError || error instanceof StorageUnavailableError) return error
  const name = (error as { name?: string } | null)?.name
  if (name === 'QuotaExceededError') return new StorageUnavailableError('quota', 'Spazio del dispositivo esaurito.')
  if (name === 'VersionError') return new StorageUnavailableError('newer_database', 'Archivio creato da una versione più nuova dell’app.')
  return new StorageUnavailableError('failed', 'Archivio del dispositivo non disponibile.')
}

/** IndexedDB reale (browser). La verifica in un browser vero è un gate dei task 11/24. */
export function indexedDbBackend(factory: IDBFactory | undefined, name = IMPORT_DB_NAME): ReviewStorageBackend {
  let opening: Promise<IDBDatabase> | null = null
  const open = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (!factory) { reject(new StorageUnavailableError('unavailable', 'IndexedDB non disponibile.')); return }
    let request: IDBOpenDBRequest
    try { request = factory.open(name, IMPORT_DB_VERSION) } catch (error) { reject(storageError(error)); return }
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'key' }).createIndex('ownerId', 'ownerId')
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => { database.close(); opening = null }
      resolve(database)
    }
    request.onerror = () => reject(storageError(request.error))
    request.onblocked = () => reject(new StorageUnavailableError('unavailable', 'Archivio bloccato da un’altra scheda con una versione diversa.'))
  }).catch(error => { opening = null; throw error })

  const run = <T>(mode: IDBTransactionMode, body: (store: IDBObjectStore, set: (value: T) => void, fail: (error: Error) => void) => void) =>
    open().then(database => new Promise<T>((resolve, reject) => {
      let result: T | undefined
      let failure: Error | null = null
      let transaction: IDBTransaction
      try { transaction = mode === 'readwrite' ? database.transaction(STORE, mode, { durability: 'strict' }) : database.transaction(STORE, mode) } catch (error) { reject(storageError(error)); return }
      transaction.oncomplete = () => resolve(result as T)
      transaction.onerror = () => reject(failure ?? storageError(transaction.error))
      transaction.onabort = () => reject(failure ?? storageError(transaction.error))
      body(transaction.objectStore(STORE), value => { result = value }, error => { failure = error; transaction.abort() })
    }))

  return {
    get: key => run<StoredRecord | undefined>('readonly', (store, set) => { const request = store.get(key); request.onsuccess = () => set(request.result as StoredRecord | undefined) }),
    put: (record, expected) => run<void>('readwrite', (store, set, fail) => {
      const request = store.get(record.key)
      request.onsuccess = () => {
        const stored = (request.result as StoredRecord | undefined)?.revision ?? null
        if (stored !== expected) { fail(new StorageConflictError(stored)); return }
        store.put(record)
        set(undefined)
      }
    }),
    delete: key => run<void>('readwrite', (store, set) => { store.delete(key); set(undefined) }),
    list: () => run<StoredRecord[]>('readonly', (store, set) => { const request = store.getAll(); request.onsuccess = () => set(request.result as StoredRecord[]) }),
  }
}

// ---------------------------------------------------------------------------
// Verifica di una voce letta
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value))

/** Una sessione letta dal disco è rivalidata per intero: contratti 01/02, replay delle decisioni, comando e ricevuta. */
export function verifyStoredSession(value: unknown, ownerId: string, sessionId: string): { ok: true; session: ImportSession } | { ok: false; message: string } {
  if (!isObject(value) || value.formatVersion !== IMPORT_SESSION_FORMAT) return { ok: false, message: 'Formato della sessione sconosciuto.' }
  if (value.ownerId !== ownerId || value.sessionId !== sessionId) return { ok: false, message: 'La voce appartiene a un’altra sessione o a un altro account.' }
  const kind = value.kind as ExtractionKind
  if (kind !== 'workout' && kind !== 'diet') return { ok: false, message: 'Dominio sconosciuto.' }
  if (!(importLocalStates as readonly unknown[]).includes(value.status)) return { ok: false, message: 'Stato sconosciuto.' }
  if (!isTime(value.createdAt) || !isTime(value.lastActivityAt)) return { ok: false, message: 'Date non valide.' }
  const file = value.file
  if (!isObject(file) || typeof file.name !== 'string' || typeof file.size !== 'number' || (file.format !== 'docx' && file.format !== 'pdf') || !(file.sourceHash === null || /^[0-9a-f]{64}$/.test(String(file.sourceHash)))) {
    return { ok: false, message: 'Metadati del file non validi.' }
  }
  if (value.document !== null && !validateNormalizedDocument(value.document).ok) return { ok: false, message: 'Documento normalizzato non valido.' }
  for (const draft of [value.draft, ...(Array.isArray(value.previousDrafts) ? value.previousDrafts : [null])]) {
    if (draft === null) continue
    const checked = verifyDraft(draft)
    if (!checked.ok) return { ok: false, message: `Bozza non valida: ${checked.message}` }
    if (checked.draft.kind !== kind) return { ok: false, message: 'Bozza di un altro dominio.' }
  }
  const reanalysis = value.reanalysis
  if (reanalysis !== null && (!isObject(reanalysis) || (reanalysis.draft !== null && !verifyDraft(reanalysis.draft).ok))) return { ok: false, message: 'Rianalisi non valida.' }
  const commit = value.commit
  if (commit !== null) {
    if (!isObject(commit) || !validateCommitCommand(kind, commit.command).ok || !/^[0-9a-f]{64}$/.test(String(commit.commandHash)) || typeof commit.sent !== 'boolean') {
      return { ok: false, message: 'Comando congelato non valido.' }
    }
  }
  if (value.receipt !== null && !validateImportReceipt(value.receipt).ok) return { ok: false, message: 'Ricevuta non valida.' }
  if (value.reservations !== undefined && value.reservations !== null && !validReservations(value.reservations)) return { ok: false, message: 'Prenotazioni degli ID non valide.' }
  if ((value.status === 'saving' || value.status === 'save_unknown') && commit === null) return { ok: false, message: 'Salvataggio senza comando.' }
  return { ok: true, session: value as unknown as ImportSession }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const uuidMap = (value: unknown) => isObject(value) && Object.values(value).every(id => typeof id === 'string' && UUID.test(id))
/** Prenotazioni del mapping (22): solo UUID, nessun altro campo. */
function validReservations(value: unknown) {
  if (!isObject(value) || typeof value.planId !== 'string' || !UUID.test(value.planId) || !uuidMap(value.items)) return false
  if (value.versionId !== undefined && (typeof value.versionId !== 'string' || !UUID.test(value.versionId))) return false
  if (value.exercises !== undefined && !uuidMap(value.exercises)) return false
  return Object.keys(value).every(key => ['planId', 'versionId', 'items', 'exercises'].includes(key))
}

/** Migrazioni del formato della voce: oggi solo la V1. Una voce più nuova resta intatta e non viene letta. */
function migrate(record: StoredRecord): StoredRecord | null {
  return (knownFormats as readonly string[]).includes(record.formatVersion) ? record : null
}

// ---------------------------------------------------------------------------
// Archivio per account
// ---------------------------------------------------------------------------

export type LoadProblem = 'missing' | 'expired' | 'unsupported_version' | 'corrupt'
export type LoadResult =
  | { status: 'ok'; session: ImportSession }
  | { status: LoadProblem; message: string }
  | { status: 'unavailable'; reason: StorageUnavailableError['reason']; message: string }
const unavailable = (error: unknown) => {
  const failure = storageError(error)
  if (failure instanceof StorageConflictError) throw failure
  return { status: 'unavailable' as const, reason: (failure as StorageUnavailableError).reason, message: failure.message }
}
export type SaveResult =
  | { ok: true; session: ImportSession }
  | { ok: false; reason: 'conflict'; session: ImportSession; storedRevision: number | null }
  | { ok: false; reason: 'unavailable' | 'quota'; session: ImportSession; message: string }

export interface SessionSummary {
  sessionId: string
  kind: ExtractionKind
  status: ImportSession['status']
  fileName: string
  lastActivityAt: string
  uncertainCommand: boolean
}

export class ReviewStore {
  private readonly backend: ReviewStorageBackend | null
  private readonly now: () => string
  /** `backend` null = archivio non disponibile: ogni sessione resta volatile. */
  constructor(backend: ReviewStorageBackend | null, options: { now?: () => string } = {}) {
    this.backend = backend
    this.now = options.now ?? (() => new Date().toISOString())
  }
  get available() { return this.backend !== null }

  /**
   * Apertura per l'account corrente: elimina le voci di altri account (residui di un cambio identità non
   * completato) e le sessioni scadute; elenca le sessioni riprendibili, prima quelle con un comando incerto.
   */
  async open(ownerId: string): Promise<{ available: boolean; sessions: SessionSummary[]; problems: { sessionId: string; problem: LoadProblem }[] }> {
    const backend = this.backend
    if (!backend) return { available: false, sessions: [], problems: [] }
    const sessions: SessionSummary[] = []
    const problems: { sessionId: string; problem: LoadProblem }[] = []
    let records: StoredRecord[]
    try { records = await backend.list() } catch (error) { unavailable(error); return { available: false, sessions: [], problems: [] } }
    for (const record of records) {
      if (record.ownerId !== ownerId) { await backend.delete(record.key); continue }
      const loaded = await this.readRecord(record, ownerId, record.sessionId)
      if (loaded.status !== 'ok') { problems.push({ sessionId: record.sessionId, problem: loaded.status }); continue }
      const session = loaded.session
      sessions.push({ sessionId: session.sessionId, kind: session.kind, status: session.status, fileName: session.file.name, lastActivityAt: session.lastActivityAt, uncertainCommand: hasUncertainCommand(session) })
    }
    sessions.sort((a, b) => Number(b.uncertainCommand) - Number(a.uncertainCommand) || b.lastActivityAt.localeCompare(a.lastActivityAt))
    return { available: true, sessions, problems }
  }

  async load(ownerId: string, sessionId: string): Promise<LoadResult> {
    if (!this.backend) return { status: 'unavailable', reason: 'unavailable', message: 'Archivio del dispositivo non disponibile.' }
    let record: StoredRecord | undefined
    try { record = await this.backend.get(recordKey(ownerId, sessionId)) } catch (error) { return unavailable(error) }
    if (!record) return { status: 'missing', message: 'Nessuna bozza salvata su questo dispositivo.' }
    return this.readRecord(record, ownerId, sessionId)
  }

  private async readRecord(record: StoredRecord, ownerId: string, sessionId: string): Promise<Exclude<LoadResult, { status: 'unavailable' }>> {
    if (record.ownerId !== ownerId || record.key !== recordKey(ownerId, sessionId)) return { status: 'corrupt', message: 'Voce di un altro account.' }
    const migrated = migrate(record)
    if (!migrated) return { status: 'unsupported_version', message: 'Bozza creata da una versione più nuova dell’app: aggiornare per riprenderla.' }
    const checked = verifyStoredSession(migrated.session, ownerId, sessionId)
    if (!checked.ok) return { status: 'corrupt', message: checked.message }
    if (checked.session.revision !== migrated.revision) return { status: 'corrupt', message: 'Revisione della voce incoerente.' }
    if (isExpired(checked.session, this.now())) {
      await this.backend!.delete(record.key)
      return { status: 'expired', message: `Bozza scaduta dopo ${IMPORT_INACTIVITY_DAYS} giorni di inattività: i contenuti sono stati eliminati.` }
    }
    return { status: 'ok', session: markPersisted(resumeImportSession(checked.session, this.now()), migrated.revision) }
  }

  /**
   * Scrive la sessione con revisione successiva, solo se l'archivio contiene ancora la revisione letta.
   * Riuscita → sessione durevole (anche il comando congelato); altrimenti sessione volatile con il motivo.
   */
  async save(session: ImportSession): Promise<SaveResult> {
    if (!this.backend) return { ok: false, reason: 'unavailable', session: markVolatile(session), message: 'Archivio del dispositivo non disponibile: la bozza non sopravvive alla chiusura.' }
    const revision = (session.revision ?? 0) + 1
    const persisted = markPersisted(session, revision)
    const record: StoredRecord = {
      key: recordKey(session.ownerId, session.sessionId), formatVersion: IMPORT_RECORD_FORMAT, ownerId: session.ownerId, sessionId: session.sessionId,
      revision, updatedAt: this.now(), session: persisted,
    }
    try {
      await this.backend.put(record, session.revision)
      return { ok: true, session: persisted }
    } catch (error) {
      const failure = storageError(error)
      if (failure instanceof StorageConflictError) return { ok: false, reason: 'conflict', session: markVolatile(session), storedRevision: failure.storedRevision }
      const reason = failure instanceof StorageUnavailableError && failure.reason === 'quota' ? 'quota' : 'unavailable'
      return { ok: false, reason, session: markVolatile(session), message: failure.message }
    }
  }

  /**
   * Scarto esplicito. Con un comando inviato e non riconciliato serve `acknowledgeUncertain`: il piano
   * potrebbe essere già salvato e il requestId è l'unico modo di verificarlo.
   */
  async discard(ownerId: string, sessionId: string, options: { acknowledgeUncertain?: boolean } = {}): Promise<{ ok: true } | { ok: false; reason: 'uncertain_command' }> {
    if (!this.backend) return { ok: true }
    const loaded = await this.load(ownerId, sessionId)
    if (loaded.status === 'ok' && hasUncertainCommand(loaded.session) && !options.acknowledgeUncertain) return { ok: false, reason: 'uncertain_command' }
    await this.backend.delete(recordKey(ownerId, sessionId))
    return { ok: true }
  }

  /** Cosa andrebbe perso al logout o al cambio account, da mostrare prima di confermare. */
  async pendingRisks(ownerId: string): Promise<{ localDrafts: number; uncertainCommands: number }> {
    const { sessions } = await this.open(ownerId)
    return {
      localDrafts: sessions.filter(session => session.status === 'reviewing' || session.status === 'ready').length,
      uncertainCommands: sessions.filter(session => session.uncertainCommand).length,
    }
  }

  /** Logout o cambio identità confermato: nessun residuo privato dell'account sul dispositivo. */
  async clearOwner(ownerId: string): Promise<void> {
    if (!this.backend) return
    for (const record of await this.backend.list()) if (record.ownerId === ownerId) await this.backend.delete(record.key)
  }
}
