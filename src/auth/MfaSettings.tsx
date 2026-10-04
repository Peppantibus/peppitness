import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { Modal } from '../components/Modal'
import { mfaErrorMessage } from './errors'
import { forgetMfaNotRequired } from './MfaGate'

type Enrollment = { factorId: string; qr: string; secret: string }

// Attivazione volontaria del secondo fattore dall'account. Il requisito vero è imposto dal server.
export function MfaSettings({ client, userId }: { client: SupabaseClient; userId: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [code, setCode] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void client.auth.mfa.listFactors().then(({ data }) => { if (active) setEnabled(data ? data.totp.length > 0 : null) }).catch(() => undefined)
    return () => { active = false }
  }, [client, userId])
  if (enabled === null) return null
  const start = async () => {
    if (pending) return
    setPending(true); setError('')
    try {
      const { data: factors } = await client.auth.mfa.listFactors()
      for (const stale of factors?.all ?? []) if (stale.status === 'unverified') await client.auth.mfa.unenroll({ factorId: stale.id })
      const { data, error: failure } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'peppitness' })
      if (failure || !data) setError(mfaErrorMessage(failure)); else setEnrollment({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret })
    } catch { setError(mfaErrorMessage(null)) }
    finally { setPending(false) }
  }
  const verify = async () => {
    if (!enrollment || pending) return
    setPending(true); setError('')
    try {
      const { error: failure } = await client.auth.mfa.challengeAndVerify({ factorId: enrollment.factorId, code: code.trim() })
      // Da ora l'account richiede il fattore: niente apertura senza verifica in base alla risposta precedente.
      if (failure) setError(mfaErrorMessage(failure)); else { forgetMfaNotRequired(userId); setEnabled(true); setEnrollment(null) }
    } catch { setError(mfaErrorMessage(null)) }
    finally { setCode(''); setPending(false) }
  }
  return <>
    <h3 className="mfa-title">Verifica in due passaggi</h3>
    {enabled ? <p role="status">Attiva: all’accesso serve anche il codice dell’app di autenticazione. Per rimuoverla o recuperarla contatta l’amministratore.</p>
      : <><p>Aggiunge un codice a 6 cifre all’accesso. Conserva l’app di autenticazione: senza di essa il recupero passa dall’amministratore.</p>
        <button className="button secondary" disabled={pending} onClick={() => void start()}>{pending ? 'Attendi…' : 'Attiva'}</button></>}
    {!enrollment && error && <p className="form-error" role="alert">{error}</p>}
    {enrollment && <Modal label="Attiva la verifica in due passaggi" onClose={() => { if (!pending) { setEnrollment(null); setError('') } }}>
      <h2>Attiva la verifica in due passaggi</h2>
      <p>Scansiona il QR con la tua app di autenticazione, poi inserisci il codice a 6 cifre.</p>
      <img className="mfa-qr" src={enrollment.qr} alt="Codice QR per l’app di autenticazione" width={180} height={180} />
      <p>Oppure inserisci questa chiave: <code className="mfa-secret">{enrollment.secret}</code></p>
      <form className="auth-form" onSubmit={event => { event.preventDefault(); void verify() }}>
        <label htmlFor="mfa-setup-code">Codice<input id="mfa-setup-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} disabled={pending} /></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="account-actions"><button className="button secondary" type="button" disabled={pending} onClick={() => { setEnrollment(null); setError('') }}>Annulla</button><button className="button primary" type="submit" disabled={pending || code.length !== 6}>{pending ? 'Verifica in corso…' : 'Verifica'}</button></div>
      </form>
    </Modal>}
  </>
}
