import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { createProgramsRepository } from './programs-repository'
import { initialProgramsState, ProgramsStore } from './programs-store'

const unavailable = initialProgramsState()
const subscribeUnavailable = () => () => undefined
const getUnavailable = () => unavailable
export function usePrograms(active: boolean) {
  const { client, state: auth } = useAuth()
  const owner = auth.session?.user.id
  const store = useMemo(() => client && owner ? new ProgramsStore(createProgramsRepository(client, owner)) : null, [client, owner])
  const state = useSyncExternalStore(store?.subscribe ?? subscribeUnavailable, store?.getSnapshot ?? getUnavailable)
  useEffect(() => {
    if (store && active && ['idle', 'loading'].includes(store.getSnapshot().phase)) {
      if (store.getSnapshot().requestedId) void store.retry(); else void store.load()
    }
  }, [store, active])
  useEffect(() => () => store?.stop(), [store])
  return { store, state, pending: store?.pending ?? false }
}
