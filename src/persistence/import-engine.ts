/**
 * Motore dell'importazione Word strutturato per l'account corrente. Caricato in modo lazy da `use-imports.ts`
 * così contratti, reader e journal non entrano nel bundle principale. Nessuna analisi remota: lettura sul
 * dispositivo, bozza nel journal locale e un solo salvataggio atomico (RPC commit_*_import).
 */
import type { ImportReceipt } from '../import/contracts/index.ts'
import type { ImportsRepository } from './imports-repository.ts'
import { StructuredImportsStore } from './structured-imports-store.ts'
export { createImportsRepository } from './imports-repository.ts'

export interface ImportEngineOptions {
  repository?: ImportsRepository
  refresh?: (receipt: ImportReceipt, signal: AbortSignal) => Promise<void>
}

export const createImportEngine = (ownerId: string, options: ImportEngineOptions = {}) =>
  new StructuredImportsStore(ownerId, options.repository, options.refresh)

/** Archivio IndexedDB del vecchio import con analisi remota: non più scritto né letto, si elimina. */
const LEGACY_DB_NAME = 'peppitness-import'
export function purgeLegacyImportDb() {
  return new Promise<void>(resolve => {
    try {
      const request = globalThis.indexedDB?.deleteDatabase(LEGACY_DB_NAME)
      if (!request) return resolve()
      request.onsuccess = request.onerror = request.onblocked = () => resolve()
    } catch { resolve() }
  })
}

/** Logout senza motore caricato: nessuna bozza di questo account resta sul dispositivo. */
export async function clearImportDevice(ownerId: string) {
  await new StructuredImportsStore(ownerId).clear().catch(() => undefined)
  await purgeLegacyImportDb()
}
