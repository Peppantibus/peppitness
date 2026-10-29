import { useEffect, useRef, useState } from 'react'
import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { BrandLogo } from '../components/BrandLogo'
import { MfaGate } from './MfaGate'
import { closeRecovery, hasImplicitRecovery, hasIncomingRecovery, recoveryClient, verifyRecovery } from './recovery-client'
import { recoveryHash, forgotHash } from './recovery-url'

export function ForgotPassword({ client }: { client: SupabaseClient }) {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  return <><h1 id="auth-title">Password dimenticata?</h1>
    {sent ? <p role="status">Se l’indirizzo corrisponde a un account abilitato, riceverai un link per impostare una nuova password. Controlla anche la posta indesiderata.</p> : <>
      <p>Inserisci l’email del tuo account.</p>
      <form className="auth-form" onSubmit={async event => {
        event.preventDefault()
        if (busy.current) return
        busy.current = true; setPending(true); setError('')
        try {
          const { error: failure } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${location.origin}/${recoveryHash}` })
          if (failure && (failure.status === 0 || failure.status! >= 500 || failure.name === 'AuthRetryableFetchError')) {
            setError('Invio non disponibile. Controlla la connessione e riprova tra qualche minuto.')
          } else setSent(true)
        } catch { setError('Invio non disponibile. Controlla la connessione e riprova tra qualche minuto.') }
        finally { busy.current = false; setPending(false) }
      }}>
        <label htmlFor="recovery-email">Email<input id="recovery-email" type="email" autoComplete="email" inputMode="email" autoCapitalize="none" spellCheck={false} required disabled={pending} value={email} onChange={e => setEmail(e.target.value)} /></label>
        {error && <p role="alert" className="form-error">{error}</p>}
        <button className="button primary full-width" disabled={pending}>{pending ? 'Invio in corso…' : 'Invia il link di recupero'}</button>
      </form></>}
    <p className="auth-back"><a href="#/accedi">Torna all’accesso</a></p>
  </>
}

export function PasswordRecovery() {
  const [step, setStep] = useState<'start' | 'verifying' | 'checking' | 'ready' | 'invalid' | 'done'>(() => hasImplicitRecovery() ? 'verifying' : hasIncomingRecovery() ? 'start' : sessionStorage.getItem('peppitness:recovery-done') ? 'done' : 'checking')
  const [session, setSession] = useState<Session | null>(null)
  const [error, setError] = useState('')
  const [client] = useState(recoveryClient)
  useEffect(() => {
    document.title = 'Recupero password · peppitness'
    if (step === 'verifying') {
      let active = true
      void verifyRecovery().then(value => { if (active) { setSession(value); setStep('ready') } }).catch(() => { if (active) setStep('invalid') })
      return () => { active = false }
    }
    if (step !== 'checking') return
    let active = true
    void (async () => {
      try {
        const expected = sessionStorage.getItem('peppitness:recovery-user')
        const { data, error: failure } = await client.auth.getUser()
        const { data: current } = await client.auth.getSession()
        if (failure || !expected || data.user?.id !== expected || !current.session) throw new Error()
        if (active) { setSession(current.session); setStep('ready') }
      } catch { if (active) setStep('invalid') }
    })()
    return () => { active = false }
  }, [client, step])
  if (step === 'ready' && session) return <MfaGate client={client} session={session} requireOnline onExit={() => { void closeRecovery() }}><NewPassword client={client} session={session} onDone={() => setStep('done')} /></MfaGate>
  return <main className="auth-page" id="main-content"><section className="panel auth-card" aria-labelledby="auth-title">
    <BrandLogo className="auth-logo" title="peppitness" />
    <h1 id="auth-title">{step === 'done' ? 'Password aggiornata' : 'Imposta una nuova password'}</h1>
    {step === 'start' ? <><p>Continua per verificare il link di recupero. La sessione già aperta nell’app rimane separata.</p><button className="button primary full-width" onClick={() => {
      setStep('verifying')
    }}>Continua con il recupero</button></> : (step === 'checking' || step === 'verifying') ? <p role="status">Verifica del recupero…</p>
      : step === 'done' ? <><p role="status">La nuova password è stata salvata. Account, dati e verifica in due passaggi sono conservati.</p><p>Puoi tornare alla sessione già aperta oppure accedere con la nuova password dalla schermata di accesso.</p></>
        : <><p role="alert">Il link è scaduto, non valido, già utilizzato oppure la verifica non è riuscita. Controlla la connessione. Se hai già salvato, prova ad accedere con la nuova password; altrimenti richiedi un nuovo link.</p><button className="button secondary" onClick={() => { setError(''); setStep('checking') }}>Riprova la sessione di recupero</button><p><a href={forgotHash} onClick={event => { event.preventDefault(); void closeRecovery().then(() => { location.hash = forgotHash }) }}>Richiedi un nuovo link</a></p></>}
    {error && <p role="alert">{error}</p>}
    {step !== 'checking' && step !== 'verifying' && <p className="auth-back"><button className="button secondary" onClick={async () => {
      try { await closeRecovery() } catch { setError('Controlla la connessione e riprova.') }
    }}>Torna all’app / accesso</button></p>}
  </section></main>
}

function NewPassword({ client, session, onDone }: { client: SupabaseClient; session: Session; onDone: () => void }) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [visible, setVisible] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const busy = useRef(false)
  return <main className="auth-page" id="main-content"><section className="panel auth-card" aria-labelledby="auth-title">
    <BrandLogo className="auth-logo" title="peppitness" /><h1 id="auth-title">Imposta una nuova password</h1>
    <p>Account da aggiornare: <strong>{session.user.email}</strong>. La sessione già aperta nell’app non viene sostituita.</p>
    <form className="auth-form" onSubmit={async event => {
      event.preventDefault()
      if (busy.current) return
      if (password !== confirm) { setError('Le password non coincidono.'); return }
      busy.current = true; setPending(true); setError('')
      try {
        const { data, error: identityError } = await client.auth.getUser()
        if (identityError || data.user?.id !== session.user.id || sessionStorage.getItem('peppitness:recovery-user') !== session.user.id) throw new Error()
        const { error: failure } = await client.auth.updateUser({ password })
        if (failure) {
          setError(failure.code === 'same_password' ? 'Scegli una password diversa da quella attuale.' : failure.code === 'weak_password' ? 'La password non soddisfa i requisiti di sicurezza.' : 'Salvataggio non confermato. Controlla la connessione. Puoi riprovare o verificare la nuova password dalla schermata di accesso.')
        } else {
          sessionStorage.setItem('peppitness:recovery-done', '1')
          sessionStorage.removeItem('peppitness:recovery-user')
          try { await client.auth.signOut({ scope: 'local' }) } finally { onDone() }
        }
      } catch { setError('Salvataggio non confermato. Controlla la connessione; se il link è scaduto richiedine uno nuovo. Se hai già inviato, prova ad accedere con la nuova password.') }
      finally { setPassword(''); setConfirm(''); busy.current = false; setPending(false) }
    }}>
      <p id="password-help">Almeno 12 caratteri, con maiuscole, minuscole e numeri.</p>
      <label htmlFor="new-password">Password<input id="new-password" type={visible ? 'text' : 'password'} autoComplete="new-password" minLength={12} pattern="(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9]).{12,}" aria-describedby="password-help" required disabled={pending} value={password} onChange={e => setPassword(e.target.value)} /></label>
      <label htmlFor="confirm-password">Conferma password<input id="confirm-password" type={visible ? 'text' : 'password'} autoComplete="new-password" required disabled={pending} value={confirm} onChange={e => setConfirm(e.target.value)} /></label>
      <button type="button" className="button secondary" aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? 'Nascondi password' : 'Mostra password'}</button>
      {error && <p role="alert" className="form-error">{error}</p>}
      <button className="button primary full-width" disabled={pending}>{pending ? 'Salvataggio in corso…' : 'Salva la nuova password'}</button>
    </form>
    <p className="auth-back"><button className="button secondary" disabled={pending} onClick={async () => { try { await closeRecovery() } catch { setError('Chiusura non confermata. Riprova.') } }}>Annulla e torna all’app</button></p>
  </section></main>
}
