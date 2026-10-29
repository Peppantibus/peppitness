import { createClient } from '@supabase/supabase-js'
import { readSupabaseConfig } from './config'
import { readRecoveryLink, recoveryHash } from './recovery-url'

// Prima del primo render: nessun token nell'URL mentre React o l'SDK si inizializzano.
const initial = readRecoveryLink(location.hash, location.search)
const initialCallback = initial.active && (location.hash !== recoveryHash || Boolean(location.search))
let incomingToken = initial.token
let incomingCredentials = initial.credentials
if (initial.active) history.replaceState(null, '', `${location.pathname}${recoveryHash}`)
let locked = initial.active
try {
  locked ||= sessionStorage.getItem('peppitness:recovery-lock') === '1'
  if (locked) sessionStorage.setItem('peppitness:recovery-lock', '1')
  if (initialCallback) {
    sessionStorage.removeItem('peppitness:recovery-user')
    sessionStorage.removeItem('peppitness:recovery-done')
  }
} catch { /* Il login ordinario resta utilizzabile senza sessionStorage. */ }
let revision = 0
export const recoveryRevision = () => revision
export function captureRecovery() {
  const link = readRecoveryLink(location.hash, location.search)
  const callback = link.active && (location.hash !== recoveryHash || Boolean(location.search))
  if (callback) {
    incomingToken = link.token; incomingCredentials = link.credentials; verification = undefined; revision++
  }
  if (link.active) {
    locked = true
    history.replaceState(null, '', `${location.pathname}${recoveryHash}`)
    try {
      sessionStorage.setItem('peppitness:recovery-lock', '1')
      if (callback) {
        sessionStorage.removeItem('peppitness:recovery-user')
        sessionStorage.removeItem('peppitness:recovery-done')
      }
    } catch { /* gestito dalla schermata */ }
  }
}
export async function closeRecovery() {
  try { await client?.auth.signOut({ scope: 'local' }) } catch { /* La revoca può fallire offline: rimuove comunque solo le credenziali isolate. */ } finally {
    await client?.auth.stopAutoRefresh()
    const key = sessionStorage.getItem('peppitness:recovery-key')
    if (key) { sessionStorage.removeItem(key); sessionStorage.removeItem(`${key}-user`) }
    incomingToken = null
    incomingCredentials = undefined
    verification = undefined
    leaveRecovery()
  }
}
export const recoveryActive = () => locked
export function leaveRecovery() {
  locked = false
  sessionStorage.removeItem('peppitness:recovery-lock')
  sessionStorage.removeItem('peppitness:recovery-user')
  sessionStorage.removeItem('peppitness:recovery-done')
  location.hash = '#/accedi'
}

let client: ReturnType<typeof createClient> | null = null
export function recoveryClient() {
  if (client) return client
  const config = readSupabaseConfig(import.meta.env)
  if (!config) throw new Error('Auth non configurato')
  // Sessione della sola scheda: nessuna sostituzione del login principale o broadcast ad altre schede.
  let key = sessionStorage.getItem('peppitness:recovery-key')
  if (!key) { key = `peppitness:recovery:${crypto.randomUUID()}`; sessionStorage.setItem('peppitness:recovery-key', key) }
  client = createClient(config.url, config.publishableKey, {
    auth: { storage: sessionStorage, storageKey: key, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }) },
  })
  return client
}

// Una sola verifica anche con StrictMode. Il token resta solo in memoria fino al click esplicito.
export const hasIncomingRecovery = () => Boolean(incomingToken || incomingCredentials)
export const hasImplicitRecovery = () => Boolean(incomingCredentials)
let verification: ReturnType<typeof verify> | undefined
async function verify() {
  const token = incomingToken
  const credentials = incomingCredentials
  incomingToken = null
  incomingCredentials = undefined
  if (!token && !credentials) throw new Error('Link non disponibile')
  sessionStorage.removeItem('peppitness:recovery-user')
  sessionStorage.removeItem('peppitness:recovery-done')
  const isolated = recoveryClient()
  await isolated.auth.signOut({ scope: 'local' })
  // Valida prima di importare: una sessione password/OAuth etichettata recovery non viene
  // né installata né revocata (potrebbe essere la sessione principale già aperta).
  if (credentials) {
    const verified = await isolated.auth.getClaims(credentials.access_token)
    if (verified.error || !verified.data?.claims.amr?.some(method => typeof method === 'object' && ['recovery', 'otp'].includes(method.method))) {
      throw new Error('Sessione non da link email')
    }
  }
  const { data, error } = token ? await isolated.auth.verifyOtp({ token_hash: token, type: 'recovery' })
    : await isolated.auth.setSession(credentials!)
  if (error || !data.session) throw new Error('Link non valido')
  // Oltre a type=recovery richiede una sessione da link email verificata dall'SDK.
  // GoTrue emette attualmente amr=otp anche per i link recovery (verificato sul backend locale).
  const claims = await isolated.auth.getClaims(data.session.access_token)
  if (claims.error || claims.data?.claims.sub !== data.session.user.id
    || !claims.data.claims.amr?.some(method => typeof method === 'object' && ['recovery', 'otp'].includes(method.method))) {
    await isolated.auth.signOut({ scope: 'local' })
    throw new Error('Sessione non di recupero')
  }
  sessionStorage.setItem('peppitness:recovery-user', data.session.user.id)
  return data.session
}
export function verifyRecovery() { return verification ??= verify() }
