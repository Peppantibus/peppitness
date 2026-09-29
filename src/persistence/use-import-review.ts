import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useAuth } from '../auth/AuthProvider'
import type { ImportReviewState, ImportReviewStore } from './import-review-store'

// Il motore (contratti, reader, journal) si scarica solo quando serve: questo modulo resta leggero.
const loadEngine = () => import('./import-review-store')

const idle: ImportReviewState = {
  phase: 'opening', storageAvailable: null,
  slots: {
    workout: { session: null, metadata: null, original: null, problem: null, notice: null, storage: null, storageMessage: null, restored: false },
    diet: { session: null, metadata: null, original: null, problem: null, notice: null, storage: null, storageMessage: null, restored: false },
  },
  guards: { busy: false, unsaved: false, logoutRisk: false },
}
const subscribeIdle = () => () => undefined
const getIdle = () => idle

/**
 * Importazione dell'account corrente, per l'intera App (la lettura prosegue se si cambia pagina).
 * `active`: carica il motore (pagina d'importazione o Impostazioni, dove si esce dall'account).
 * App è smontata a ogni cambio di account (main.tsx): lo smontaggio interrompe letture e risposte tardive.
 */
export function useImportReview(active: boolean) {
  const { state: auth } = useAuth()
  const owner = auth.session?.user.id ?? 'local'
  const [store, setStore] = useState<ImportReviewStore | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!active || store) return
    let cancelled = false
    setLoadFailed(false)
    loadEngine().then(module => { if (!cancelled) setStore(module.createImportReviewStore(owner)) }, () => { if (!cancelled) setLoadFailed(true) })
    return () => { cancelled = true }
  }, [active, store, owner, attempt])

  useEffect(() => {
    if (!store) return
    store.start()
    return () => store.stop()
  }, [store])

  const state = useSyncExternalStore(store?.subscribe ?? subscribeIdle, store?.getSnapshot ?? getIdle)
  const retryLoad = useCallback(() => setAttempt(value => value + 1), [])
  /** Logout: nessuna sessione d'importazione di questo account resta sul dispositivo, motore caricato o no. */
  const clearDevice = useCallback(() => store ? store.clearDevice() : loadEngine().then(module => module.clearImportDevice(owner), () => undefined), [store, owner])

  return { store, state, loadFailed, retryLoad, clearDevice, ...state.guards }
}
