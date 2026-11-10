import { useRef, useState } from 'react'
import { Modal } from '../components/Modal'
import { newPrescription, programPayload } from '../domain/programs'
import { workoutDaysFromProgram } from '../domain/diary'
import { isTimedCardio } from '../domain/muscle-groups'
import { exercisePositionOptions, hasExerciseValues } from '../domain/session-exercises'
import type { ExercisePosition } from '../domain/session-exercises'
import type { CatalogExercise } from '../domain/exercises'
import type { ExercisePrescription, WorkoutSession } from '../domain/types'
import type { DiaryStore } from '../persistence/diary-store'
import type { ExercisesState, ExercisesStore } from '../persistence/exercises-store'
import { storedSetAmount } from '../domain/workout'
import { ExerciseSheet } from './ExerciseSheet'

export function SessionPosition({ session, value, onChange, exclude }: {
  session: WorkoutSession; value: ExercisePosition; onChange: (position: ExercisePosition) => void; exclude?: string
}) {
  return <label className="session-position">Posizione<select aria-label="Posizione" value={value.kind === 'after' ? value.id : value.kind}
    onChange={event => onChange(event.target.value === 'start' ? { kind: 'start' } : event.target.value === 'end' ? { kind: 'end' } : { kind: 'after', id: event.target.value })}>
    <option value="start">All’inizio</option>
    {exercisePositionOptions(session.day.exercises, exclude).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
    <option value="end">Alla fine</option>
  </select></label>
}

function SessionOrderNote() {
  return <><p><strong>Solo per questa seduta</strong></p><p className="small muted">Il programma, le altre sedute e le settimane future restano invariati.</p></>
}

function AdditionProposal({ selected, session, store, initialPosition, onClose, onBack, onApplied }: {
  selected: CatalogExercise; session: WorkoutSession; store: DiaryStore; initialPosition: ExercisePosition
  onClose: () => void; onBack: () => void; onApplied: (id: string, position: ExercisePosition) => void
}) {
  const [draft, setDraft] = useState(() => newPrescription(selected))
  const [position, setPosition] = useState(initialPosition)
  const [duration, setDuration] = useState('')
  const [allowDuplicate, setAllowDuplicate] = useState(false)
  const [error, setError] = useState('')
  const applied = useRef(false)
  const duplicate = session.day.exercises.some(item => item.exerciseId === selected.id)
  const timed = selected.measurementMode === 'seconds', cardio = isTimedCardio(selected)
  const recordCardio = session.kind === 'free' && cardio
  const field = (key: 'sets' | 'repsMin' | 'repsMax' | 'restSeconds', label: string) => <label>{label}<input aria-label={label} inputMode="numeric" maxLength={8} value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>
  const submit = () => {
    if (applied.current) return
    try {
      if (duplicate && !allowDuplicate) throw new Error('L’esercizio è già presente: conferma se vuoi aggiungerlo nuovamente.')
      const item = { ...draft, durationSeconds: timed ? cardio ? storedSetAmount(duration, { name: selected.name, mode: 'seconds', muscleGroup: 'Cardio' }) : duration : '' }
      // Stessi valori iniziali e validazione delle prescrizioni nell’editor del programma.
      const document = { planId: crypto.randomUUID(), id: crypto.randomUUID(), title: 'Seduta', guidance: '', days: [{ id: crypto.randomUUID(), label: 'Seduta', title: 'Seduta', note: '', exercises: [item] }] }
      programPayload(document)
      const snapshot = workoutDaysFromProgram(document)[0]!.exercises[0]!.snapshot!
      applied.current = true
      if (!store.editSession(session.id, { action: 'add', exercise: { ...snapshot, session_added: true }, position, allowDuplicate })) {
        applied.current = false
        throw new Error('La seduta o la posizione è cambiata. Controlla la posizione e riprova.')
      }
      if (recordCardio) store.updateSet(session.id, snapshot.id, 0, { load: '', amount: String(snapshot.duration_seconds), completed: true })
      onApplied(snapshot.id, position)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Controlla i campi.') }
  }
  return <Modal label="Configura esercizio" variant="sheet" onClose={onClose}><div className="wz-sheet session-exercise-proposal">
    <button type="button" className="text-button" onClick={onBack}>← Cambia esercizio</button>
    <h2>{selected.name}</h2><p className="muted">{[selected.variant, selected.equipment].filter(Boolean).join(' · ')}</p>
    {recordCardio ? <p className="small muted">Indica i minuti effettivamente svolti: verranno registrati come completati solo in questo allenamento libero.</p> : <SessionOrderNote />}
    <div className="replacement-dose">{!recordCardio && field('sets', 'Serie')}
      {timed ? <label>{recordCardio ? 'Minuti svolti' : cardio ? 'Durata in minuti' : 'Durata in secondi'}<input aria-label={recordCardio ? 'Minuti svolti' : cardio ? 'Durata in minuti' : 'Durata in secondi'} inputMode="decimal" value={duration} maxLength={8} onChange={event => setDuration(event.target.value)} /></label>
        : <>{field('repsMin', 'Ripetizioni minime')}{field('repsMax', 'Ripetizioni massime')}</>}
      {!recordCardio && field('restSeconds', 'Recupero in secondi')}
    </div>
    {(!recordCardio || session.day.exercises.length > 0) && <SessionPosition session={session} value={position} onChange={setPosition} />}
    {duplicate && <div className="session-duplicate"><p>Questo esercizio è già presente nella seduta.</p><label><input type="checkbox" checked={allowDuplicate} onChange={event => setAllowDuplicate(event.target.checked)} /> Aggiungi comunque una nuova occorrenza</label></div>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="button primary full-width" disabled={duplicate && !allowDuplicate} onClick={submit}>{recordCardio ? 'Aggiungi e registra' : 'Conferma aggiunta'}</button>
  </div></Modal>
}

export function SessionExerciseAddition({ session, store, catalog, position, onClose, onApplied }: {
  session: WorkoutSession; store: DiaryStore; catalog: { store: ExercisesStore | null; state: ExercisesState }
  position: ExercisePosition; onClose: () => void; onApplied: (id: string, position: ExercisePosition) => void
}) {
  const [selected, setSelected] = useState<CatalogExercise | null>(null)
  if (session.completedAt) return null
  return selected ? <AdditionProposal key={selected.id} selected={selected} session={session} store={store} initialPosition={position} onClose={onClose} onBack={() => setSelected(null)} onApplied={onApplied} />
    : <ExerciseSheet catalog={catalog} label="Aggiungi esercizio" single onAdd={setSelected} onClose={onClose} />
}

export function SessionExerciseActions({ exercise, session, store, onApplied }: {
  exercise: ExercisePrescription; session: WorkoutSession; store: DiaryStore; onApplied: (id?: string) => void
}) {
  const [removing, setRemoving] = useState(false), [error, setError] = useState('')
  const applied = useRef(false)
  if (!exercise.snapshot?.session_added || session.completedAt) return null
  const remove = (confirmed: boolean) => {
    if (applied.current) return
    if (store.editSession(session.id, { action: 'remove', id: exercise.id, confirmed })) { applied.current = true; onApplied() }
    else setError('La seduta è cambiata. Controlla le registrazioni e riprova.')
  }
  return <div className="replacement-actions session-added-actions"><span className="small muted">Solo per questa seduta</span>
    <button type="button" className="text-button danger" onClick={() => { if (hasExerciseValues(session, exercise.id)) setRemoving(true); else remove(false) }}>Rimuovi</button>
    {error && <p role="alert">{error}</p>}
    {removing && <Modal label="Rimuovere l’esercizio?" onClose={() => setRemoving(false)}><h2>Rimuovere {exercise.name}?</h2><p>Verranno eliminate anche tutte le serie e i valori annotati su questo esercizio.</p>
      <div className="program-actions"><button type="button" className="button secondary" onClick={() => setRemoving(false)}>Continua</button><button type="button" className="button danger" onClick={() => remove(true)}>Rimuovi</button></div>
    </Modal>}
  </div>
}
