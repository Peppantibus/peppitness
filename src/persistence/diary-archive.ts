import type { DiaryData } from '../domain/diary.ts'
import type { KeyValueStorage } from './diary-store.ts'

/**
 * Copia del diario confermata dal server, per account. È grande (tutta la storia) e cambia solo dopo
 * una lettura o un invio confermato: sta fuori da localStorage, che resta per la coda delle modifiche.
 * Si può sempre ricostruire dal server; la coda locale no.
 */
export interface ServerCopy {
  version: 2
  server: DiaryData
  revisions: Record<string, number>
  /** Ultima lettura riuscita (orologio del dispositivo). */
  refreshedAt: string | null
  /** `updated_at` più recente visto sul server: base della lettura incrementale successiva. */
  cursor: string | null
  /** Ultima lettura completa (orologio del dispositivo): le incrementali si appoggiano a questa. */
  fullAt: string | null
}

export interface ServerArchive {
  load(): Promise<ServerCopy | null>
  save(copy: ServerCopy): Promise<void>
  remove(): Promise<void>
}

export function isServerCopy(value: unknown): value is ServerCopy {
  if (!value || typeof value !== 'object') return false
  const copy = value as Partial<ServerCopy>
  return copy.version === 2 && Boolean(copy.server) && Array.isArray(copy.server?.sessions) && typeof copy.server?.mealLogs === 'object'
    && typeof copy.server?.dayTypes === 'object' && typeof copy.revisions === 'object' && copy.revisions !== null
}

/** Stessa interfaccia su un archivio chiave/valore: test, assenza di IndexedDB e copia senza Supabase. */
export function keyValueArchive(storage: KeyValueStorage, owner: string): ServerArchive {
  const key = `peppitness:diary:v2:${owner}:server`
  return {
    load: () => {
      try { const raw = storage.get(key); const parsed: unknown = raw ? JSON.parse(raw) : null; return Promise.resolve(isServerCopy(parsed) ? parsed : null) }
      catch { return Promise.resolve(null) }
    },
    save: copy => { try { storage.set(key, JSON.stringify(copy)); return Promise.resolve() } catch (error) { return Promise.reject(error instanceof Error ? error : new Error('Archivio non disponibile.')) } },
    remove: () => { storage.remove(key); return Promise.resolve() },
  }
}

const DB_NAME = 'peppitness-diary'
const STORE = 'server'
let opening: Promise<IDBDatabase> | null = null

function openDb(version?: number): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = version ? indexedDB.open(DB_NAME, version) : indexedDB.open(DB_NAME)
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE) }
    request.onsuccess = () => {
      const db = request.result
      // Base esistente senza archivio (creata vuota altrove): nuova versione che lo aggiunge.
      if (!db.objectStoreNames.contains(STORE)) { const next = db.version + 1; db.close(); opening = null; resolve(openDb(next)); return }
      // Un'altra scheda aggiorna lo schema: si chiude e alla prossima operazione si riapre.
      db.onversionchange = () => { db.close(); opening = null }
      resolve(db)
    }
    request.onerror = () => { opening = null; reject(request.error ?? new Error('Archivio locale non disponibile.')) }
    request.onblocked = () => { opening = null; reject(new Error('Archivio locale bloccato da un’altra scheda.')) }
  })
  return opening
}

/** Una richiesta in una transazione propria; si risolve al completamento della transazione (dato scritto). */
async function run<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode)
    const request = operation(transaction.objectStore(STORE))
    transaction.oncomplete = () => resolve(request.result)
    transaction.onerror = () => reject(transaction.error ?? new Error('Archivio locale non disponibile.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('Scrittura dell’archivio annullata.'))
  })
}

/**
 * IndexedDB, una voce per account. Le transazioni sulla stessa base sono ordinate: una rimozione
 * chiesta dopo un salvataggio arriva sempre dopo di esso.
 */
export function indexedDbArchive(owner: string): ServerArchive {
  return {
    load: async () => { const value = await run<unknown>('readonly', store => store.get(owner)); return isServerCopy(value) ? value : null },
    save: async copy => { await run('readwrite', store => store.put(copy, owner)) },
    remove: async () => { await run('readwrite', store => store.delete(owner)) },
  }
}

/** Archivio del browser: IndexedDB se disponibile, altrimenti localStorage (limite di spazio più basso). */
export function browserArchive(owner: string, fallback: KeyValueStorage): ServerArchive {
  if (typeof indexedDB === 'undefined') return keyValueArchive(fallback, owner)
  const primary = indexedDbArchive(owner), secondary = keyValueArchive(fallback, owner)
  let usable = true
  const attempt = async <T>(action: (archive: ServerArchive) => Promise<T>): Promise<T> => {
    if (usable) {
      try { return await action(primary) } catch { usable = false }
    }
    return action(secondary)
  }
  return {
    // Dopo un ripiego le copie possono essere due: vale la più recente.
    load: async () => {
      const [first, second] = await Promise.allSettled([usable ? primary.load() : Promise.resolve(null), secondary.load()])
      if (first.status === 'rejected') usable = false
      const copies = [first, second].flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : [])
      return copies.sort((a, b) => (b.refreshedAt ?? '').localeCompare(a.refreshedAt ?? ''))[0] ?? null
    },
    save: copy => attempt(archive => archive.save(copy)),
    // Rimozione da entrambi: nessuna copia resta dopo l'uscita, qualunque archivio sia stato usato.
    remove: async () => { await Promise.allSettled([primary.remove(), secondary.remove()]) },
  }
}
