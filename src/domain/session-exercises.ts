import { emptyResults, prescription } from './diary.ts'
import type { SnapshotExercise } from './diary.ts'
import type { ExercisePrescription, WorkoutSession } from './types.ts'

export type ExercisePosition = { kind: 'start' } | { kind: 'end' } | { kind: 'after'; id: string }
export type SessionEdit =
  | { action: 'add'; exercise: SnapshotExercise; position: ExercisePosition; allowDuplicate: boolean }
  | { action: 'move'; id: string; position: ExercisePosition }
  | { action: 'remove'; id: string; confirmed: boolean }
export interface WorkoutContext { lastCompletedId?: string; workingId?: string }

export function defaultExercisePosition(session: WorkoutSession, context?: WorkoutContext): ExercisePosition {
  const id = [context?.lastCompletedId, context?.workingId].find(id => session.day.exercises.some(item => item.id === id))
  return id ? { kind: 'after', id } : { kind: 'end' }
}

export function exercisePositionOptions(exercises: ExercisePrescription[], exclude?: string) {
  return exercises.filter(item => item.id !== exclude).map(item => {
    const same = exercises.filter(other => other.name === item.name)
    const variant = [item.snapshot?.variant, item.snapshot?.equipment].filter(Boolean).join(' · ')
    const label = same.length > 1 ? `${item.name}${variant ? ` · ${variant}` : ''} (${same.indexOf(item) + 1}ª occorrenza)` : item.name
    return { id: item.id, label: `Dopo ${label}` }
  })
}

export function hasExerciseValues(session: WorkoutSession, id: string) {
  return (session.results[id] ?? []).some(set => set.completed || set.load !== '' || set.amount !== '')
}

/** Opera solo sulla copia della seduta. Il replay di un'aggiunta non azzera mai i risultati. */
export function editSessionExercises(session: WorkoutSession, edit: SessionEdit): WorkoutSession {
  if (session.completedAt) return session
  const current = session.day.exercises
  if (edit.action === 'add' && current.some(item => item.id === edit.exercise.id)) return session
  const existing = edit.action === 'add' ? undefined : current.find(item => item.id === edit.id)
  if (edit.action !== 'add' && !existing?.snapshot?.session_added) return session
  if (edit.action === 'remove') {
    if (!edit.confirmed && hasExerciseValues(session, edit.id)) return session
    const results = { ...session.results }; delete results[edit.id]
    return { ...session, day: { ...session.day, exercises: current.filter(item => item.id !== edit.id) }, results }
  }
  if (edit.action === 'add' && (current.length >= 200 || !edit.exercise.session_added || !edit.allowDuplicate && current.some(item => item.exerciseId === edit.exercise.exercise_id))) return session
  const item = edit.action === 'add' ? prescription(edit.exercise) : existing!
  const exercises = current.filter(other => other.id !== item.id)
  const position = edit.position
  const index = position.kind === 'start' ? 0 : position.kind === 'end' ? exercises.length : exercises.findIndex(other => other.id === position.id) + 1
  if (position.kind === 'after' && index === 0) return session
  exercises.splice(index, 0, item)
  return { ...session, day: { ...session.day, exercises }, results: edit.action === 'add'
    ? { ...session.results, ...emptyResults({ ...session.day, exercises: [item] }) } : session.results }
}
