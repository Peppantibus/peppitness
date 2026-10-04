import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { BrandLogo } from '../components/BrandLogo'
import { mfaErrorMessage } from './errors'

type Step = { kind: 'checking' } | { kind: 'ok' } | { kind: 'challenge'; factorId: string }
  | { kind: 'enroll'; factorId: string; qr: string; secret: string }

// Il server impone aal2 (policy RLS e RPC): questa schermata guida soltanto la verifica.
// Se lo stato non è raggiungibile (offline, backend senza MFA) l'app prosegue: i dati
// restano protetti dal server e la copia locale è già quella del dispositivo.
export function MfaGate({ client, session, children }: { client: SupabaseClient; session: Session; children: ReactNode }) {
  const [step, setStep] = useState<Step>({ kind: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const userId = session.user.id
  useEffect(() => {
    let active = true
    setStep({ kind: 'checking' })
    void (async () => {
      try {
        const { data: level } = await client.auth.mfa.getAuthenticatorAssuranceLevel()
        if (level?.currentLevel === 'aal2') return active && setStep({ kind: 'ok' })
        const { data: satisfied, error } = await client.rpc('is_mfa_satisfied')
        if (error || satisfied !== false) return active && setStep({ kind: 'ok' })
        const { data: factors } = await client.auth.mfa.listFactors()
        const verified = factors?.totp?.[0]
        if (verified) return active && setStep({ kind: 'challenge', factorId: verified.id })
        // Elimina iscrizioni abbandonate prima di crearne una nuova.
        for (const stale of factors?.all ?? []) if (stale.status === 'unverified') await client.auth.mfa.unenroll({ factorId: stale.id })
        const { data: enrolled, error: enrollError } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'peppitness' })
        if (enrollError || !enrolled) return active && setStep({ kind: 'ok' })
        if (active) setStep({ kind: 'enroll', factorId: enrolled.id, qr: enrolled.totp.qr_code, secret: enrolled.totp.secret })
      } catch { if (active) setStep({ kind: 'ok' }) }
    })()
    return () => { active = false }
  }, [client, userId, attempt])
  if (step.kind === 'ok') return children
  return <main className="auth-page" id="main-content">
    <section className="panel auth-card" aria-labelledby="auth-title">
      <BrandLogo className="auth-logo" title="peppitness" />
      {step.kind === 'checking' ? <><h1 id="auth-title">Il tuo spazio</h1><p role="status">Verifica dell’accesso…</p></>
        : <CodeForm client={client} step={step} onVerified={() => setStep({ kind: 'ok' })} onRestart={() => setAttempt(value => value + 1)} />}
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
