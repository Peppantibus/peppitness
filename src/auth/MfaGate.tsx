import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { BrandLogo } from '../components/BrandLogo'
import { mfaErrorMessage } from './errors'

type Step = { kind: 'checking' } | { kind: 'ok' } | { kind: 'unverified' } | { kind: 'challenge'; factorId: string }
  | { kind: 'enroll'; factorId: string; qr: string; secret: string }

/**
 * Ultima risposta del server per questo account: «secondo fattore non richiesto». Serve solo ad aprire
 * l'app senza rete; non autorizza nulla (il server applica comunque aal2). Valore booleano, nessun dato personale.
 */
const notRequiredKey = (userId: string) => `peppitness:mfa-not-required:v1:${userId}`
export function forgetMfaNotRequired(userId: string) { try { localStorage.removeItem(notRequiredKey(userId)) } catch { /* archivio non disponibile */ } }
function rememberMfaNotRequired(userId: string) { try { localStorage.setItem(notRequiredKey(userId), '1') } catch { /* archivio non disponibile */ } }
function knownMfaNotRequired(userId: string) { try { return localStorage.getItem(notRequiredKey(userId)) === '1' } catch { return false } }

// Il server impone aal2 (policy RLS e RPC): questa schermata guida la verifica. Con una sessione aal1
// l'app si apre solo se il server conferma che il fattore non serve, oppure, senza risposta (offline),
// se lo aveva già confermato per questo account. Altrimenti niente app: con aal1 le letture tornerebbero
// vuote e le scritture respinte, e il diario sul dispositivo verrebbe confrontato con dati sbagliati.
export function MfaGate({ client, session, children }: { client: SupabaseClient; session: Session; children: ReactNode }) {
  const [attempt, setAttempt] = useState(0)
  const userId = session.user.id
  // Ogni tentativo (o account) è un controllo nuovo: la chiave riparte da «verifica in corso».
  return <MfaCheck key={`${userId}:${attempt}`} client={client} userId={userId} onRestart={() => setAttempt(value => value + 1)}>{children}</MfaCheck>
}

function MfaCheck({ client, userId, onRestart, children }: { client: SupabaseClient; userId: string; onRestart: () => void; children: ReactNode }) {
  const [step, setStep] = useState<Step>({ kind: 'checking' })
  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const { data: level } = await client.auth.mfa.getAuthenticatorAssuranceLevel()
        if (level?.currentLevel === 'aal2') return active && setStep({ kind: 'ok' })
        const { data: satisfied, error } = await client.rpc('is_mfa_satisfied')
        if (error || typeof satisfied !== 'boolean') return active && setStep({ kind: knownMfaNotRequired(userId) ? 'ok' : 'unverified' })
        if (satisfied) { rememberMfaNotRequired(userId); return active && setStep({ kind: 'ok' }) }
        forgetMfaNotRequired(userId)
        const { data: factors, error: factorsError } = await client.auth.mfa.listFactors()
        if (factorsError || !factors) return active && setStep({ kind: 'unverified' })
        const verified = factors.totp[0]
        if (verified) return active && setStep({ kind: 'challenge', factorId: verified.id })
        // Elimina iscrizioni abbandonate prima di crearne una nuova.
        for (const stale of factors.all) if (stale.status === 'unverified') await client.auth.mfa.unenroll({ factorId: stale.id })
        const { data: enrolled, error: enrollError } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'peppitness' })
        if (enrollError || !enrolled) return active && setStep({ kind: 'unverified' })
        if (active) setStep({ kind: 'enroll', factorId: enrolled.id, qr: enrolled.totp.qr_code, secret: enrolled.totp.secret })
      } catch { if (active) setStep({ kind: knownMfaNotRequired(userId) ? 'ok' : 'unverified' }) }
    })()
    return () => { active = false }
  }, [client, userId])
  if (step.kind === 'ok') return children
  const restart = onRestart
  return <main className="auth-page" id="main-content">
    <section className="panel auth-card" aria-labelledby="auth-title">
      <BrandLogo className="auth-logo" title="peppitness" />
      {step.kind === 'checking' ? <><h1 id="auth-title">Il tuo spazio</h1><p role="status">Verifica dell’accesso…</p></>
        : step.kind === 'unverified' ? <>
          <h1 id="auth-title">Verifica dell’accesso non riuscita</h1>
          <p role="alert">Non riesco a controllare la verifica in due passaggi. Controlla la connessione e riprova.</p>
          <button className="button primary full-width" type="button" onClick={restart}>Riprova</button>
          <p className="auth-help"><button className="button secondary" type="button" onClick={() => { void client.auth.signOut({ scope: 'local' }); restart() }}>Esci</button></p>
        </>
        : <CodeForm client={client} step={step} onVerified={() => setStep({ kind: 'ok' })} onRestart={restart} />}
    </section>
  </main>
}

function CodeForm({ client, step, onVerified, onRestart }: {
  client: SupabaseClient; step: Extract<Step, { kind: 'challenge' | 'enroll' }>; onVerified: () => void; onRestart: () => void
}) {
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const enrolling = step.kind === 'enroll'
  return <>
    <span className="eyebrow">Verifica in due passaggi</span>
    <h1 id="auth-title">{enrolling ? 'Proteggi il tuo account' : 'Inserisci il codice'}</h1>
    {enrolling ? <>
      <p>Scansiona il QR con un’app di autenticazione (per esempio Google Authenticator o 1Password), poi inserisci il codice a 6 cifre. Conserva il fattore: senza di esso l’accesso va ripristinato dall’amministratore.</p>
      <img className="mfa-qr" src={step.qr} alt="Codice QR per l’app di autenticazione" width={180} height={180} />
      <p>Oppure inserisci questa chiave: <code className="mfa-secret">{step.secret}</code></p>
    </> : <p>Apri la tua app di autenticazione e inserisci il codice a 6 cifre.</p>}
    <form className="auth-form" onSubmit={async event => {
      event.preventDefault()
      if (pending) return
      setPending(true); setError('')
      try {
        const { error: failure } = await client.auth.mfa.challengeAndVerify({ factorId: step.factorId, code: code.trim() })
        if (failure) setError(mfaErrorMessage(failure)); else onVerified()
      } catch { setError(mfaErrorMessage(null)) }
      finally { setCode(''); setPending(false) }
    }}>
      <label htmlFor="mfa-code">Codice<input id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} disabled={pending} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="button primary full-width" type="submit" disabled={pending || code.length !== 6}>{pending ? 'Verifica in corso…' : 'Verifica'}</button>
    </form>
    <p className="auth-help"><button className="button secondary" type="button" disabled={pending} onClick={() => { void client.auth.signOut({ scope: 'local' }); onRestart() }}>Esci</button></p>
  </>
}
