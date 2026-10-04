import type { CommitCommand, ImportReceipt } from '../contracts/commit.ts'
import type { StructuredDraft, StructuredKind } from './parser.ts'
export interface StructuredRecord {
  owner: string; kind: StructuredKind; revision: number; updatedAt: number; fileName: string
  draft: StructuredDraft; command: CommitCommand | null; receipt: ImportReceipt | null
}
export interface StructuredJournal {
  load(owner: string): Promise<StructuredRecord[]>
  write(record: StructuredRecord, expected: number | null): Promise<void>
  remove(owner: string, kind?: StructuredKind, expected?: number): Promise<void>
}
export const STRUCTURED_DB = 'peppitness-structured-import-v1'
export function structuredJournal(): StructuredJournal {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(STRUCTURED_DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('drafts', { keyPath: ['owner', 'kind'] })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Archivio locale non disponibile.'))
  })
  async function transact<T>(run: (store: IDBObjectStore, done: (value: T) => void, fail: (message: string) => void) => void): Promise<T> {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('drafts', 'readwrite')
      let result: T, problem: string | null = null
      transaction.oncomplete = () => { db.close(); resolve(result) }
      transaction.onerror = transaction.onabort = () => { db.close(); reject(new Error(problem ?? 'Archivio locale non disponibile.')) }
      run(transaction.objectStore('drafts'), value => { result = value }, message => { problem = message; transaction.abort() })
    })
  }
  return {
    load: owner => transact((store, done) => {
      const request = store.getAll()
      request.onsuccess = () => {
        const kept: StructuredRecord[] = []
        for (const record of request.result as StructuredRecord[]) {
          // Un comando incerto non scade: una ricevuta deve ancora essere riconciliata.
          if (record.owner !== owner || ((!record.command || record.receipt) && record.updatedAt < Date.now() - 7 * 86400000)) store.delete([record.owner, record.kind])
          else kept.push(record)
        }
        done(kept)
      }
    }),
    write: (record, expected) => transact((store, done, fail) => {
      const request = store.get([record.owner, record.kind])
      request.onsuccess = () => {
        if (((request.result as StructuredRecord | undefined)?.revision ?? null) !== expected) { fail('Bozza modificata in un’altra scheda: ricarica prima di continuare.'); return }
        store.put(record); done(undefined)
      }
    }),
    remove: (owner, kind, expected) => transact((store, done, fail) => {
      const request = store.getAll()
      request.onsuccess = () => {
        for (const record of request.result as StructuredRecord[]) if (record.owner === owner && (!kind || record.kind === kind)) {
          if (expected !== undefined && record.revision !== expected) { fail('Bozza modificata in un’altra scheda: ricarica prima di continuare.'); return }
          store.delete([owner, record.kind])
        }
        done(undefined)
      }
    }),
  }
}
