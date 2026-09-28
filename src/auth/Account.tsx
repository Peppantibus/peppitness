import { useState } from 'react'
import { Modal } from '../components/Modal'
import { useAuth } from './AuthProvider'

export function Account({ hasUnsavedData, busy = false, onSignedOut }: { hasUnsavedData: boolean; busy?: boolean; onSignedOut?: () => void }) {
  const { client, state, reportLogoutFailure } = useAuth()
  const [pending, setPending] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [error, setError] = useState('')
  if (!client || state.status !== 'signed-in') return null
  const signOut = async () => {
    if (pending) return
    setPending(true); setError('')
    try {
      const { error: failure } = await client.auth.signOut({ scope: 'local' })
      // La sessione locale viene rimossa anche se la revoca online fallisce: la copia
      // del diario di questo account non deve restare sul dispositivo.
      onSignedOut?.()
      if (failure) { reportLogoutFailure(); setError('Uscita non riuscita. Controlla la connessione e riprova.') }
    } catch { reportLogoutFailure(); setError('Uscita non riuscita. Controlla la connessione e riprova.') }
    finally { setPending(false); setConfirm(false) }
  }
  return <section className="panel settings-panel account-panel" aria-labelledby="account-title">
    <h2 id="account-title">Account</h2>
    <p className="account-email">{state.session.user.email}</p>
    <button className="button secondary" disabled={pending || busy} onClick={() => hasUnsavedData ? setConfirm(true) : void signOut()}>{pending ? 'Uscita in corso…' : 'Esci'}</button>
    {error && <p className="form-error" role="alert">{error}</p>}
    {confirm && <Modal label="Uscire dall’account?" onClose={() => { if (!pending) setConfirm(false) }}>
      <h2>Uscire dall’account?</h2><p className="logout-explanation">Le modifiche non salvate e le registrazioni non ancora sincronizzate saranno eliminate da questo dispositivo. I dati già salvati online rimangono nel tuo account.</p>
      <div className="account-actions"><button className="button secondary" disabled={pending} onClick={() => setConfirm(false)}>Resta</button><button className="button danger" disabled={pending} onClick={() => void signOut()}>Esci e scarta</button></div>
    </Modal>}
  </section>
}
