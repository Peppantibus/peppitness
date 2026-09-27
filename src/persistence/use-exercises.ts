import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { createExercisesRepository } from './exercises-repository'
import { ExercisesStore, initialExercisesState } from './exercises-store'

const unavailable = initialExercisesState()
const subscribeUnavailable = () => () => undefined
const getUnavailable = () => unavailable

export function useExercises(active: boolean) {
  const { client, state: auth } = useAuth()
  const owner = auth.session?.user.id
  const store = useMemo(() => client && owner ? new ExercisesStore(createExercisesRepository(client, owner)) : null, [client, owner])
  const state = useSyncExternalStore(store?.subscribe ?? subscribeUnavailable, store?.getSnapshot ?? getUnavailable)
  useEffect(() => {
    if (store && active && ['idle', 'loading'].includes(store.getSnapshot().phase)) void store.load()
  }, [store, active])
  // Navigare non cancella la bozza o interrompe una scrittura. Il cambio account sì.
  useEffect(() => () => store?.stop(), [store])
  return { store, state, pending: store?.pending ?? false }
}
