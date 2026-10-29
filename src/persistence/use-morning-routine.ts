import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { browserStorage } from './diary-store'
import { createMorningRepository } from './morning-routine-repository'
import { MorningRoutineStore } from './morning-routine-store'

export function useMorningRoutine() {
  const { client, state: auth } = useAuth(), owner = auth.session?.user.id
  const store = useMemo(() => new MorningRoutineStore(client && owner ? createMorningRepository(client, owner) : null, browserStorage, owner ?? 'local'), [client, owner])
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  useEffect(() => {
    store.start()
    const resume = () => { if (document.visibilityState === 'visible') store.retry() }
    const storage = (event: StorageEvent) => { if (event.key === store.storageKey) store.reloadFromDevice() }
    window.addEventListener('online', resume); window.addEventListener('storage', storage); document.addEventListener('visibilitychange', resume)
    return () => { window.removeEventListener('online', resume); window.removeEventListener('storage', storage); document.removeEventListener('visibilitychange', resume); store.stop() }
  }, [store])
  return { store, state }
}
