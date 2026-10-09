import { useEffect, useState } from 'react'
import { Modal } from '../components/Modal'
import { formatDate, shiftDate } from '../domain/dates'
import type { WorkoutSession } from '../domain/types'
import { filledUnchecked, isStaleSession, sessionProgress } from '../domain/workout'
import { filledSentence, markFilledLabel } from '../features/Workout'

/**
 * Seduta rimasta aperta da ore (dimenticata): all'apertura dell'app, o al ritorno in primo piano, chiede
 * se è finita. Stesse regole di «Termina»: le serie compilate si segnano solo su richiesta, mai valori
 * inventati. «Non ora» la nasconde fino al prossimo avvio dell'app.
 */
export function StaleSessionPrompt({ session, today, onFinish, onResume }: {
  session: WorkoutSession; today: string
  onFinish: (markFilled: boolean) => void
  onResume: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  const [dismissed, setDismissed] = useState<string | null>(null)
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') setNow(Date.now()) }
    const interval = window.setInterval(tick, 5 * 60_000)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', tick); window.removeEventListener('focus', tick) }
  }, [])
  if (dismissed === session.id || !isStaleSession(session, now)) return null
  const close = () => setDismissed(session.id)
  const { required, completedRequired } = sessionProgress(session)
  const filled = filledUnchecked(session)
  const emptyRequired = required - completedRequired - filled.filter(item => item.required).length
  const day = session.date === today ? 'di oggi' : session.date === shiftDate(today, -1) ? 'di ieri' : `di ${formatDate(session.date, { weekday: 'long', day: 'numeric', month: 'long' })}`
  const time = new Date(session.startedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
  return <Modal label="Allenamento ancora aperto" onClose={close}>
    <h2>Hai finito l’allenamento {day}?</h2>
    <p><strong>{session.day.title}</strong> risulta in corso dalle {time}. Hai fatto {completedRequired} di {required} serie previste{filled.length > 0 ? `; ${filledSentence(filled.length, emptyRequired)}` : ''}.</p>
    <div className="button-row session-end-actions stale-session-actions">
      <button type="button" className="button primary stale-finish" onClick={() => { close(); onFinish(filled.length > 0) }}>{filled.length > 0 ? markFilledLabel(filled.length) : 'Termina con le serie fatte'}</button>
      {filled.length > 0 && <button type="button" className="button secondary stale-finish-plain" onClick={() => { close(); onFinish(false) }}>{filled.length === 1 ? 'Termina senza segnarla' : 'Termina senza segnarle'}</button>}
      <button type="button" className="button secondary stale-resume" onClick={() => { close(); onResume() }}>Riprendi l’allenamento</button>
      <button type="button" className="text-button stale-later" onClick={close}>Non ora</button>
    </div>
  </Modal>
}
