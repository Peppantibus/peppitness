import { useState } from 'react'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { morningForDate } from '../domain/morning-routine'
import type { MorningRoutineStore, MorningState } from '../persistence/morning-routine-store'
import './morning-routine.css'

export function MorningRoutineCard({ state, date }: { state: MorningState; date: string }) {
  const completed = state.days[date]?.snapshot, routine = completed ?? state.routine
  const schedule = routine ? morningForDate(routine, date) : null
  return <a className={`morning-entry ${completed ? 'is-done' : ''}`} href="#/scheda/mattino">
    <span className="morning-entry-icon"><Icon name={completed ? 'check' : 'sun'} size={24} /></span>
    <span className="morning-entry-copy"><strong>{routine?.title ?? 'Routine del mattino'}</strong><small>{schedule ? `${schedule.minutes} min · ${schedule.withStrength ? 'Mobilità + rinforzo' : 'Mobilità quotidiana'}` : state.known ? 'Crea la tua routine' : 'Caricamento…'}</small></span>
    <span className="morning-entry-side"><small>{completed ? 'Fatta' : routine ? 'Da fare' : ''}</small><Icon name="chevron" size={16} /></span>
  </a>
}
export function MorningRoutineStatus({ store, state }: { store: MorningRoutineStore; state: MorningState }) {
  const [choice, setChoice] = useState<boolean | null>(null)
  if (state.sync === 'synced' && state.storage) return null
  return <div className="morning-sync" role="status">
    <p>{!state.storage ? 'Archivio del dispositivo non disponibile: tieni aperta la pagina finché la routine è salvata online.' : state.message || (state.sync === 'sending' ? 'Salvataggio della routine…' : 'Routine salvata sul dispositivo, in attesa di invio.')}</p>
    {state.sync === 'waiting' && <button className="text-button" onClick={store.retry}>Riprova</button>}
    {state.sync === 'conflict' && <div className="program-actions"><button className="button secondary" onClick={() => setChoice(false)}>Usa online</button><button className="button secondary" onClick={() => setChoice(true)}>Mantieni le mie modifiche</button></div>}
    {choice !== null && <Modal label="Conferma scelta della routine" onClose={() => setChoice(null)}><h2>{choice ? 'Inviare le tue modifiche?' : 'Usare i dati online?'}</h2><p>{choice ? 'Le tue modifiche sostituiranno i dati online della routine o della giornata in conflitto.' : 'Le modifiche locali in attesa per la routine o la giornata in conflitto verranno scartate. Le altre registrazioni restano conservate.'}</p><div className="program-actions program-confirm-actions"><button className="button secondary" onClick={() => setChoice(null)}>Annulla</button><button className="button danger" onClick={() => { void store.resolve(choice); setChoice(null) }}>Conferma</button></div></Modal>}
  </div>
}
