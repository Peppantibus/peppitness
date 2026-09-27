import type { Session, SupabaseClient } from '@supabase/supabase-js'

export type AuthState =
  | { status: 'loading' | 'error' | 'signed-out' | 'unconfigured'; session: null }
  | { status: 'signed-in'; session: Session }

// Separato da React per verificare le corse tra bootstrap, logout e rinnovo.
export function observeSession(client: Pick<SupabaseClient, 'auth'>, publish: (state: AuthState) => void): () => void {
  let active = true
  let eventVersion = 0
  const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
    // Callback sincrona: nessuna chiamata Auth mentre l'SDK detiene il proprio lock.
    eventVersion++
    if (active) publish(session ? { status: 'signed-in', session } : { status: 'signed-out', session: null })
  })
  const startVersion = eventVersion
  void client.auth.getSession().then(({ data, error }) => {
    // Una risposta iniziale tardiva non deve ripristinare una sessione già terminata.
    if (!active || eventVersion !== startVersion) return
    publish(error ? { status: 'error', session: null } : data.session
      ? { status: 'signed-in', session: data.session } : { status: 'signed-out', session: null })
  }).catch(() => {
    if (active && eventVersion === startVersion) publish({ status: 'error', session: null })
  })
  return () => { active = false; subscription.unsubscribe() }
}
