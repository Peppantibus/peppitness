import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAuth } from '../auth/AuthProvider'
import { defaultSettings } from '../domain/settings'
import { createSettingsRepository } from './settings-repository'
import { SettingsStore } from './settings-store'
import type { SettingsState } from './settings-store'

const unavailable: SettingsState = { phase: 'ready', saved: null, draft: defaultSettings(), remote: null, message: '' }
const subscribeUnavailable = () => () => undefined
const getUnavailable = () => unavailable

export function useSettings() {
  const { client, state: auth } = useAuth()
  const ownerId = auth.session?.user.id
  const store = useMemo(() => client && ownerId ? new SettingsStore(createSettingsRepository(client, ownerId)) : null, [client, ownerId])
  const state = useSyncExternalStore(store?.subscribe ?? subscribeUnavailable, store?.getSnapshot ?? getUnavailable)
  useEffect(() => { if (store) { void store.load(); return store.stop } }, [store])
  return { store, state, dirty: store?.dirty ?? false }
}
