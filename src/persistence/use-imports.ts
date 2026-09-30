import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../auth/AuthProvider'
import type { ImportReceipt } from '../import/contracts/index.ts'
import type { ImportReviewState, ImportReviewStore } from './import-review-store'

// Il motore (contratti, reader, journal, rete) si scarica solo quando serve: questo modulo resta leggero.
const loadEngine = () => import('./import-review-store')

const idleNetwork = { activity: null, problem: null, compatible: null, duplicates: null, rejection: null, refresh: 'idle' } as const
const idleSlot = { session: null, metadata: null, original: null, problem: null, notice: null, storage: null, storageMessage: null, restored: false, network: idleNetwork }
const idle: ImportReviewState = {
  phase: 'opening', storageAvailable: null,
  slots: { workout: idleSlot, diet: idleSlot },
  guards: { busy: false, unsaved: false, logoutRisk: false },
}
const subscribeIdle = () => () => undefined
const getIdle = () => idle

/** Rilettura dei dati dell'app dopo un salvataggio confermato (piani, catalogo); il fallimento resta distinto dall'esito. */
export type ImportSavedHandler = (receipt: ImportReceipt, signal: AbortSignal) => Promise<void> | void

/**
 * Importazione dell'account corrente, per l'intera App (lettura e analisi proseguono se si cambia pagina).
 * `active`: carica il motore (pagina d'importazione o Impostazioni, dove si esce dall'account). Con la sessione
 * Supabase il motore riceve il repository di rete dell'account (21): analisi, conferma e riconciliazione.
 * App è smontata a ogni cambio di account (main.tsx): lo smontaggio interrompe letture, richieste e risposte tardive.
 */
export function useImports(active: boolean, onSaved?: ImportSavedHandler) {
  const { client, state: auth } = useAuth()
  const owner = auth.session?.user.id ?? 'local'
  const connected = Boolean(client && auth.session)
  const [store, setStore] = useState<ImportReviewStore | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const saved = useRef(onSaved)
  useEffect(() => { saved.current = onSaved }, [onSaved])

  useEffect(() => {
    if (!active || store) return
    let cancelled = false
    setLoadFailed(false)
    loadEngine().then(module => {
      if (cancelled) return
      setStore(module.createImportReviewStore(owner, {
        repository: connected && client ? module.createImportsRepository(client, owner) : undefined,
        refresh: async (receipt, signal) => { await saved.current?.(receipt, signal) },
      }))
    }, () => { if (!cancelled) setLoadFailed(true) })
    return () => { cancelled = true }
  }, [active, store, owner, connected, client, attempt])

  useEffect(() => {
    if (!store) return
    store.start()
    // Ritorno della rete o dell'app in primo piano: si verificano gli esiti incerti, senza nuovi invii.
    const resume = () => { if (document.visibilityState === 'visible') void store.resume() }
    window.addEventListener('online', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      window.removeEventListener('online', resume)
      document.removeEventListener('visibilitychange', resume)
      store.stop()
    }
  }, [store])

  const state = useSyncExternalStore(store?.subscribe ?? subscribeIdle, store?.getSnapshot ?? getIdle)
  const retryLoad = useCallback(() => setAttempt(value => value + 1), [])
  /** Logout: nessuna sessione d'importazione di questo account resta sul dispositivo, motore caricato o no. */
  const clearDevice = useCallback(() => store ? store.clearDevice() : loadEngine().then(module => module.clearImportDevice(owner), () => undefined), [store, owner])

  return { store, state, loadFailed, retryLoad, clearDevice, ...state.guards }
}
