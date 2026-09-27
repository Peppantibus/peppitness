import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { createDiaryTransport } from './diary-repository'
import { browserStorage, DiaryStore } from './diary-store'

/** Senza Supabase configurato il diario resta in memoria (prototipo locale). */
export function useDiary() {
  const { client, state: auth } = useAuth()
  const owner = auth.session?.user.id
  const store = useMemo(() => new DiaryStore(client && owner ? createDiaryTransport(client, owner) : null, browserStorage, owner ?? 'local'), [client, owner])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => {
    store.start()
    void store.refresh()
    store.schedule(0)
    // Nessuna esecuzione continua in background: si sincronizza all'apertura, al ritorno
    // in primo piano e alla riconnessione.
    const resume = () => { if (document.visibilityState === 'visible') { store.schedule(0) } }
    const online = () => { store.schedule(0); void store.refresh() }
    // Un'altra scheda dello stesso account ha scritto l'archivio: si riallinea la coda.
    const device = (event: StorageEvent) => { if (event.key === store.storageKey) store.reloadFromDevice() }
    window.addEventListener('online', online)
    window.addEventListener('storage', device)
    document.addEventListener('visibilitychange', resume)
    return () => { window.removeEventListener('online', online); window.removeEventListener('storage', device); document.removeEventListener('visibilitychange', resume); store.stop() }
  }, [store])
  return { store, state }
}
