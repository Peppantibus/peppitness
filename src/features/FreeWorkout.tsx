import { useState } from 'react'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { formatDate } from '../domain/dates'

interface Props { date: string; onStart: () => void; active?: boolean; disabled?: boolean }
export function FreeWorkoutPreview({ date, onStart, active, disabled, onClose }: Props & { onClose: () => void }) {
  return <Modal label="Allenamento libero" variant="sheet" onClose={onClose}>
    <div className="free-workout-intro"><Icon name="dumbbell" size={32} /><h2>Allenamento libero</h2>
      <p className="muted">{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <p>Inizia una seduta vuota e aggiungi gli esercizi mentre ti alleni. Puoi registrare anche solo il cardio, con i minuti svolti.</p>
      <p className="small muted">Resta un allenamento extra: non sposta il programma e non completa le sedute previste.</p>
      <button type="button" className="button primary full-width free-workout-start" disabled={disabled} onClick={() => { onStart(); onClose() }}>{active ? 'Riprendi allenamento in corso' : 'Inizia allenamento libero'}<Icon name="play" size={20} /></button>
    </div>
  </Modal>
}
export function FreeWorkoutEntry(props: Props) {
  const [open, setOpen] = useState(false)
  return <>
    <button type="button" className="free-workout-choice" onClick={() => setOpen(true)}><Icon name="plus" size={20} /><span><strong>Allenamento libero</strong><small>Aggiungi gli esercizi mentre ti alleni</small></span><Icon name="chevron" size={16} /></button>
    {open && <FreeWorkoutPreview {...props} onClose={() => setOpen(false)} />}
  </>
}
