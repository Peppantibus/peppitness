import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { browserStorage } from './diary-store'
import { createPlansRepository } from './plans-repository'
import { PlansStore } from './plans-store'
import { createProgramsRepository } from './programs-repository'
import type { PlansState } from './plans-store'

const unavailable: PlansState = { phase: 'ready', programs: [], selection: null, workout: null, mealPlans: [], selecting: false, cached: false, message: '', editor: { phase: 'closed', draft: null, base: null, remote: null, message: '' } }
const subscribeUnavailable = () => () => undefined
const getUnavailable = () => unavailable

/** `version` cambia quando serve rileggere (es. ritorno alla Scheda dopo l'editor). */
export function usePlans(version: string) {
  const { client, state: auth } = useAuth()
  const owner = auth.session?.user.id
  const store = useMemo(() => client && owner ? new PlansStore(createPlansRepository(client, owner), createProgramsRepository(client, owner), browserStorage, owner) : null, [client, owner])
  const state = useSyncExternalStore(store?.subscribe ?? subscribeUnavailable, store?.getSnapshot ?? getUnavailable)
  useEffect(() => { if (store) void store.load() }, [store, version])
  useEffect(() => () => store?.stop(), [store])
  return { store, state, pending: store?.pending ?? false }
}
