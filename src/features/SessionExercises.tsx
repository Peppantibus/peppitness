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
  return <><p><strong>Solo per questa seduta</strong></p><p className="small muted">Il programma, le altre sedute e le settimane future restano invariati. La conferma ripristina l’ordine della seduta, annullando i rinvii di “Fallo dopo”.</p></>
}

function AdditionProposal({ selected, session, store, initialPosition, onClose, onBack, onApplied }: {
  selected: CatalogExercise; session: WorkoutSession; store: DiaryStore; initialPosition: ExercisePosition
  onClose: () => void; onBack: () => void; onApplied: (id: string) => void
}) {
  const [draft, setDraft] = useState(() => newPrescription(selected))
  const [position, setPosition] = useState(initialPosition)
  const [duration, setDuration] = useState('')
  const [allowDuplicate, setAllowDuplicate] = useState(false)
  const [error, setError] = useState('')
  const applied = useRef(false)
  const duplicate = session.day.exercises.some(item => item.exerciseId === selected.id)
  const timed = selected.measurementMode === 'seconds', cardio = isTimedCardio(selected)
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
      onApplied(snapshot.id)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Controlla i campi.') }
  }
  return <Modal label="Configura esercizio" variant="sheet" onClose={onClose}><div className="wz-sheet session-exercise-proposal">
    <button type="button" className="text-button" onClick={onBack}>← Cambia esercizio</button>
    <h2>{selected.name}</h2><p className="muted">{[selected.variant, selected.equipment].filter(Boolean).join(' · ')}</p>
    <SessionOrderNote />
    <div className="replacement-dose">{field('sets', 'Serie')}
      {timed ? <label>{cardio ? 'Durata in minuti' : 'Durata in secondi'}<input aria-label={cardio ? 'Durata in minuti' : 'Durata in secondi'} inputMode="decimal" value={duration} maxLength={8} onChange={event => setDuration(event.target.value)} /></label>
        : <>{field('repsMin', 'Ripetizioni minime')}{field('repsMax', 'Ripetizioni massime')}</>}
      {field('restSeconds', 'Recupero in secondi')}
    </div>
    <SessionPosition session={session} value={position} onChange={setPosition} />
    {duplicate && <div className="session-duplicate"><p>Questo esercizio è già presente nella seduta.</p><label><input type="checkbox" checked={allowDuplicate} onChange={event => setAllowDuplicate(event.target.checked)} /> Aggiungi comunque una nuova occorrenza</label></div>}
    {error && <p role="alert">{error}</p>}
    <button type="button" className="button primary full-width" disabled={duplicate && !allowDuplicate} onClick={submit}>Conferma aggiunta</button>
  </div></Modal>
}

export function SessionExerciseAddition({ session, store, catalog, position, onClose, onApplied }: {
  session: WorkoutSession; store: DiaryStore; catalog: { store: ExercisesStore | null; state: ExercisesState }
  position: ExercisePosition; onClose: () => void; onApplied: (id: string) => void
}) {
  const [selected, setSelected] = useState<CatalogExercise | null>(null)
  if (session.completedAt) return null
  return selected ? <AdditionProposal key={selected.id} selected={selected} session={session} store={store} initialPosition={position} onClose={onClose} onBack={() => setSelected(null)} onApplied={onApplied} />
    : <ExerciseSheet catalog={catalog} label="Aggiungi esercizio" single onAdd={setSelected} onClose={onClose} />
}

export function SessionExerciseActions({ exercise, session, store, onApplied }: {
  exercise: ExercisePrescription; session: WorkoutSession; store: DiaryStore; onApplied: (id?: string) => void
}) {
  const [moving, setMoving] = useState(false), [removing, setRemoving] = useState(false), [error, setError] = useState('')
  const [position, setPosition] = useState<ExercisePosition>({ kind: 'end' })
  const applied = useRef<'move' | 'remove' | null>(null)
  if (!exercise.snapshot?.session_added || session.completedAt) return null
  const remove = (confirmed: boolean) => {
    if (applied.current === 'remove') return
    if (store.editSession(session.id, { action: 'remove', id: exercise.id, confirmed })) { applied.current = 'remove'; onApplied() }
    else setError('La seduta è cambiata. Controlla le registrazioni e riprova.')
  }
  return <div className="replacement-actions session-added-actions"><span className="small muted">Solo per questa seduta</span>
    <button type="button" className="text-button" onClick={() => { applied.current = null; setMoving(true) }}>Sposta</button>
    <button type="button" className="text-button danger" onClick={() => { if (hasExerciseValues(session, exercise.id)) setRemoving(true); else remove(false) }}>Rimuovi</button>
    {error && <p role="alert">{error}</p>}
    {moving && <Modal label="Sposta esercizio" variant="sheet" onClose={() => setMoving(false)}><div className="wz-sheet">
      <h2>Sposta {exercise.name}</h2><SessionOrderNote /><SessionPosition session={session} value={position} onChange={setPosition} exclude={exercise.id} />
      {error && <p role="alert">{error}</p>}
      <button type="button" className="button primary full-width" onClick={() => {
        if (applied.current === 'move') return
        if (store.editSession(session.id, { action: 'move', id: exercise.id, position })) { applied.current = 'move'; setMoving(false); onApplied(exercise.id) }
        else setError('La posizione non è più disponibile. Scegline un’altra.')
      }}>Conferma spostamento</button>
    </div></Modal>}
    {removing && <Modal label="Rimuovere l’esercizio?" onClose={() => setRemoving(false)}><h2>Rimuovere {exercise.name}?</h2><p>Verranno eliminate anche tutte le serie e i valori annotati su questo esercizio.</p>
      <div className="program-actions"><button type="button" className="button secondary" onClick={() => setRemoving(false)}>Continua</button><button type="button" className="button danger" onClick={() => remove(true)}>Rimuovi</button></div>
    </Modal>}
  </div>
}
