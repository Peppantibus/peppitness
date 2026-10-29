import {useState} from 'react'
import {navigate} from '../app/route'
import {Icon} from '../components/Icon'
import {Modal} from '../components/Modal'
import {formatDate,shiftDate} from '../domain/dates'
import {morningDaysLabel,morningDuration,morningForDate} from '../domain/morning-routine'
import type {MorningExercise} from '../domain/morning-routine'
import type {MorningRoutineStore,MorningState} from '../persistence/morning-routine-store'
import {MorningRoutineEditor} from './MorningRoutineEditor'

function Sequence({ items, offset = 0 }: { items: MorningExercise[]; offset?: number }) {
  return <div className="morning-sequence">{items.map((item, index) => <details key={item.id} className="morning-movement"><summary><span className="morning-number">{offset + index + 1}</span><span className="morning-movement-copy"><strong>{item.name}</strong>{(item.area || item.dose) && <small>{[item.area, item.dose].filter(Boolean).join(' · ')}</small>}</span><span className="morning-dose">{item.minutes} min</span><Icon name="chevronDown" size={16} /></summary><div className="morning-movement-detail"><p>{item.note || 'Nessuna istruzione aggiunta.'}</p></div></details>)}</div>
}
export function MorningRoutinePage({ store, state, editing, date, today, onDate, onDirty }: {
  store: MorningRoutineStore; state: MorningState; editing: boolean; date: string; today: string; onDate: (date: string) => void; onDirty: (dirty: boolean) => void
}) {
  const [undoing, setUndoing] = useState(false)
  const snapshot = state.days[date]?.snapshot, routine = snapshot ?? state.routine
  if (!state.known) return <section className="panel empty-state"><h1>Routine del mattino</h1><p>{state.sync === 'waiting' ? 'Routine non disponibile. Collegati per scaricarla.' : 'Caricamento…'}</p><button className="button secondary" onClick={store.retry}>Riprova</button><a className="text-link" href="#/scheda">Torna alla scheda</a></section>
  if (editing) return <MorningRoutineEditor value={state.routine} revision={state.routineRevision} onDirty={onDirty} onExit={() => navigate('/scheda/mattino')} onSave={(value, revision) => { if (!store.save(value, revision)) return false; navigate('/scheda/mattino'); return true }} />
  if (!routine) return <section className="panel empty-state"><Icon name="sun" size={32} /><h1>La tua routine del mattino</h1><p>Aggiungi i tuoi esercizi e scegli in quali giorni fare anche il rinforzo.</p><a className="button primary" href="#/scheda/mattino/modifica">Crea routine</a><a className="text-link" href="#/scheda">Torna alla scheda</a></section>
  const schedule = morningForDate(routine, date), future = date > today
  return <div className="morning-page">
    <div className="morning-back"><a className="icon-button" href="#/scheda" aria-label="Torna alla scheda"><Icon name="back" size={20} /></a><span>La tua routine</span><a className="morning-edit" href="#/scheda/mattino/modifica"><Icon name="edit" size={16} />Modifica</a></div>
    <div className="morning-heading"><h1>{routine.title}<span className="heading-dot">.</span></h1><span><b id="routine-duration">{schedule.minutes} min</b> · {schedule.withStrength ? 'Con rinforzo' : 'Base quotidiana'}</span></div>
    <div className="morning-date"><button className="icon-button" aria-label="Giorno precedente" onClick={() => onDate(shiftDate(date, -1))}><Icon name="back" size={16} /></button><span><strong>{date === today ? 'Oggi' : formatDate(date, { weekday: 'short', day: 'numeric', month: 'short' })}</strong><small>{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</small></span><span className={`morning-status ${snapshot ? 'is-done' : ''}`}>{snapshot ? <><Icon name="check" size={16} />Fatta</> : future ? 'In programma' : 'Da fare'}</span><button className="icon-button" aria-label="Giorno successivo" onClick={() => onDate(shiftDate(date, 1))}><Icon name="arrow" size={16} /></button></div>
    <div className="morning-section-heading"><h2>Base quotidiana</h2><span>Ogni giorno · {morningDuration(routine.base)} min</span></div><Sequence items={routine.base} />
    {schedule.withStrength ? <section className="morning-strength"><div className="morning-section-heading"><h2>Rinforzo</h2><span>+{morningDuration(routine.extra)} min</span></div><p>{morningDaysLabel(routine.strengthDays)}</p><Sequence items={routine.extra} offset={routine.base.length} /></section> : routine.extra.length > 0 && <p className="morning-strength-days">Rinforzo: {morningDaysLabel(routine.strengthDays)} · +{morningDuration(routine.extra)} min</p>}
    <div className="morning-footer">{snapshot ? <><button className="text-button morning-undo" onClick={() => setUndoing(true)}>Annulla completamento</button><a className="button secondary lg" href="#/scheda">Torna alla scheda<Icon name="arrow" size={20} /></a></> : <button className="button primary lg" id="mark-routine-done" disabled={future} onClick={() => { store.complete(date, today) }}><Icon name="check" size={20} />{future ? 'Disponibile quel giorno' : 'Segna come fatta'}</button>}</div>
    {undoing && <Modal label="Annullare il completamento?" onClose={() => setUndoing(false)}><h2>Annullare il completamento?</h2><p>La routine di questa giornata tornerà da fare.</p><div className="program-actions program-confirm-actions"><button className="button secondary" onClick={() => setUndoing(false)}>Mantieni</button><button className="button danger" onClick={() => { store.undo(date); setUndoing(false) }}>Annulla completamento</button></div></Modal>}
  </div>
}
