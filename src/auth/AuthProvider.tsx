import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { BrandLogo } from '../components/BrandLogo'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getSupabaseClient } from './client'
import { authErrorMessage } from './errors'
import { Landing, landingHash, signInHash } from './Landing'
import { MfaGate } from './MfaGate'
import { observeSession } from './session'
import type { AuthState } from './session'

interface AuthContextValue { state: AuthState; client: SupabaseClient | null; logoutUnconfirmed: boolean; reportLogoutFailure: () => void }
const AuthContext = createContext<AuthContextValue>({ state: { status: 'unconfigured', session: null }, client: null, logoutUnconfirmed: false, reportLogoutFailure: () => undefined })
export function useAuth() { return useContext(AuthContext) }

export function AuthProvider({ children }: { children: ReactNode }) {
  const [client] = useState(getSupabaseClient)
  const [state, setState] = useState<AuthState>({ status: client ? 'loading' : 'unconfigured', session: null })
  const [logoutUnconfirmed, setLogoutUnconfirmed] = useState(false)
  useEffect(() => client ? observeSession(client, next => {
    setState(next)
    if (next.session) setLogoutUnconfirmed(false)
  }) : undefined, [client])
  return <AuthContext.Provider value={{ state, client, logoutUnconfirmed, reportLogoutFailure: () => setLogoutUnconfirmed(true) }}>{children}</AuthContext.Provider>
}

/** Dispositivo già usato per accedere: niente presentazione, si va dritti al modulo. Nessun dato dell'account. */
const returningKey = 'peppitness:returning-device'
function knownDevice() { try { return localStorage.getItem(returningKey) === '1' } catch { return false } }
function rememberDevice() { try { localStorage.setItem(returningKey, '1') } catch { /* archivio non disponibile */ } }
/** PWA aperta dalla schermata Home: chi l'ha installata vuole accedere, non leggere la presentazione. */
function installedApp() { return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true }
function subscribeHash(callback: () => void) { window.addEventListener('hashchange', callback); return () => window.removeEventListener('hashchange', callback) }
const currentHash = () => window.location.hash

export function AuthGate({ children }: { children: ReactNode }) {
  const { state, client, logoutUnconfirmed } = useAuth()
  const hash = useSyncExternalStore(subscribeHash, currentHash)
  const signedIn = state.status === 'signed-in'
  // Dopo l'accesso le rotte pubbliche non esistono nell'app: si apre la Dieta.
  useEffect(() => {
    if (!signedIn) return
    rememberDevice()
    if (hash === signInHash || hash === landingHash) window.location.replace('#/dieta')
  }, [signedIn, hash])
  const showLanding = state.status === 'signed-out' && Boolean(client) && hash !== signInHash
    && (hash === landingHash || !(logoutUnconfirmed || knownDevice() || installedApp()))
  useEffect(() => {
    if (state.status === 'signed-out') document.title = showLanding ? 'peppitness · Un giorno alla volta' : 'Accedi · peppitness'
  }, [state.status, showLanding])
  if (state.status === 'unconfigured') return children
  if (signedIn) return client ? <MfaGate client={client} session={state.session}>{children}</MfaGate> : children
  if (showLanding) return <Landing />
  return <main className="auth-page" id="main-content">
    <section className="panel auth-card" aria-labelledby="auth-title">
      <BrandLogo className="auth-logo" title="peppitness" />
      {state.status === 'loading' ? <><h1 id="auth-title">Il tuo spazio</h1><p role="status">Verifica dell’accesso…</p></>
        : state.status === 'error' ? <><h1 id="auth-title">Accesso non disponibile</h1><p role="alert">Non riesco a ripristinare la sessione. Controlla la connessione e riprova.</p><button className="button primary" onClick={() => window.location.reload()}>Riprova</button></>
          : client && <>{logoutUnconfirmed && <p role="status">Sei uscito da questo dispositivo. La chiusura della sessione online non è stata confermata.</p>}<SignIn client={client} /></>}
    </section>
  </main>
}

function SignIn({ client }: { client: SupabaseClient }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  return <>
    <span className="eyebrow">Il tuo spazio</span><h1 id="auth-title">Bentornato.</h1>
    <p>Accedi con il tuo account.</p>
    <form className="auth-form" onSubmit={async event => {
      event.preventDefault()
      if (pending) return
      setPending(true); setError('')
      try {
        const { error: failure } = await client.auth.signInWithPassword({ email: email.trim(), password })
        if (failure) setError(authErrorMessage(failure))
      } catch { setError(authErrorMessage(null)) }
      finally { setPassword(''); setPending(false) }
    }}>
      <label htmlFor="login-email">Email<input id="login-email" type="email" autoComplete="username" inputMode="email" autoCapitalize="none" spellCheck={false} required value={email} onChange={event => setEmail(event.target.value)} disabled={pending} /></label>
      <label htmlFor="login-password">Password<input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} disabled={pending} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button primary full-width" type="submit" disabled={pending}>{pending ? 'Accesso in corso…' : 'Accedi'}</button>
    </form>
    <p className="auth-help">Accesso riservato agli account abilitati. Per attivare un account o recuperare l’accesso, contatta l’amministratore.</p>
    <p className="auth-back"><a href={landingHash}>Cos’è peppitness?</a></p>
  </>
}
