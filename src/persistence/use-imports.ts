import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../auth/AuthProvider'
import type { ImportReceipt } from '../import/contracts/index.ts'
import type { StructuredImportsStore } from './structured-imports-store'

// Il motore (contratti, reader, journal, rete) si scarica solo quando serve: questo modulo resta leggero.
const loadEngine = () => import('./import-engine')

const noGuards = { busy: false, unsaved: false, logoutRisk: false }
const subscribeIdle = () => () => undefined
const getIdle = () => noGuards as unknown

/** Rilettura dei dati dell'app dopo un salvataggio confermato (piani, catalogo); il fallimento resta distinto dall'esito. */
export type ImportSavedHandler = (receipt: ImportReceipt, signal: AbortSignal) => Promise<void> | void

/**
 * Importazione dell'account corrente, per l'intera App. `active`: carica il motore (pagina d'importazione o
 * Impostazioni, dove si esce dall'account). Con la sessione Supabase il motore riceve il repository di rete
 * dell'account per ricevute e conferma. App è smontata a ogni cambio di account (main.tsx).
 */
export function useImports(active: boolean, onSaved?: ImportSavedHandler) {
  const { client, state: auth } = useAuth()
  const owner = auth.session?.user.id ?? 'local'
  const connected = Boolean(client && auth.session)
  const [engine, setEngine] = useState<StructuredImportsStore | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const saved = useRef(onSaved)
  useEffect(() => { saved.current = onSaved }, [onSaved])

  useEffect(() => {
    if (!active || engine) return
    let cancelled = false
    setLoadFailed(false)
    loadEngine().then(module => {
      if (cancelled) return
      void module.purgeLegacyImportDb()
      setEngine(module.createImportEngine(owner, {
        repository: connected && client ? module.createImportsRepository(client, owner) : undefined,
        refresh: async (receipt, signal) => { await saved.current?.(receipt, signal) },
      }))
    }, () => { if (!cancelled) setLoadFailed(true) })
    return () => { cancelled = true }
  }, [active, engine, owner, connected, client, attempt])

  useEffect(() => {
    if (!engine) return
    void engine.start()
    // Ritorno della rete o dell'app in primo piano: si verificano i salvataggi incerti con lo stesso comando.
    const resume = () => { if (document.visibilityState === 'visible') void engine.resume() }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
      engine.stop()
    }
  }, [engine])

  // Le guardie derivano dallo stato del motore: si ricalcolano a ogni suo cambiamento.
  useSyncExternalStore(engine?.subscribe ?? subscribeIdle, engine?.getSnapshot ?? getIdle)
  const guards = engine?.guards ?? noGuards
  const retryLoad = useCallback(() => setAttempt(value => value + 1), [])
  /** Logout: nessuna bozza d'importazione di questo account resta sul dispositivo, motore caricato o no. */
  const clearDevice = useCallback(() => engine ? engine.clear().then(() => undefined, () => undefined) : loadEngine().then(module => module.clearImportDevice(owner), () => undefined), [engine, owner])

  return { engine, loadFailed, retryLoad, clearDevice, ...guards }
}
