import { prescription, totalSets } from './diary.ts'
import type { DiaryData, SnapshotExercise } from './diary.ts'
import { weekDates } from './dates.ts'
import type { CatalogExercise } from './exercises.ts'
import { isTimedCardio } from './muscle-groups.ts'
import { dayForDate, isWeekly } from './weekly.ts'
import type { ExercisePrescription, WorkoutDay, WorkoutSession } from './types.ts'

export interface ChangePartner {
  date: string; dayId: string; prescriptionId: string; before: SnapshotExercise; after: SnapshotExercise
}
/** Una richiesta persistente per due occorrenze al massimo; cancelled conserva l'annullamento. */
export interface ExerciseChange {
  id: string; sessionId: string; planId: string; versionId: string; sourceDate: string; sourceDayId: string; sourceId: string
  timeZone: string; createdAt: string; before: SnapshotExercise; after: SnapshotExercise
  partner: ChangePartner | null; cancelled: boolean
}
export type ChangeDose = Pick<SnapshotExercise, 'sets' | 'optional_sets' | 'reps_min' | 'reps_max' | 'duration_seconds' | 'rest_seconds' | 'rir' | 'rpe'>
export const intact = (session: WorkoutSession, id: string) => !(session.results[id] ?? []).some(set => set.completed || set.load !== '' || set.amount !== '')
export const cardioReplacement = (source: ExercisePrescription, selected: CatalogExercise) => isTimedCardio(source) && isTimedCardio(selected)

export function changeAt(changes: readonly ExerciseChange[], versionId: string, date: string, dayId: string, id: string) {
  return changes.find(change => !change.cancelled && change.versionId === versionId && (
    change.sourceDate === date && change.sourceDayId === dayId && change.sourceId === id
    || change.partner?.date === date && change.partner.dayId === dayId && change.partner.prescriptionId === id))
}
export function datedDay(day: WorkoutDay, date: string, versionId: string, changes: readonly ExerciseChange[]): WorkoutDay {
  return { ...day, exercises: day.exercises.map(exercise => {
    const change = changeAt(changes, versionId, date, day.id, exercise.id)
    return change ? prescription(change.sourceDate === date && change.sourceDayId === day.id && change.sourceId === exercise.id ? change.after : change.partner!.after) : exercise
  }) }
}
export function futurePartners(args: { source: ExercisePrescription; selected: CatalogExercise; session: WorkoutSession; days: WorkoutDay[]; changes: ExerciseChange[]; sessions: WorkoutSession[] }): ChangePartner[] {
  const { source, selected, session, days, changes, sessions } = args
  if (cardioReplacement(source, selected) || !isWeekly(days) || !session.versionId) return []
  return weekDates(session.date).filter(date => date > session.date).flatMap(date => {
    const base = dayForDate(days, date)
    if (!base) return []
    const day = datedDay(base, date, session.versionId!, changes)
    return day.exercises.flatMap(exercise => {
      if (exercise.exerciseId !== selected.id || !exercise.snapshot || changeAt(changes, session.versionId!, date, day.id, exercise.id)) return []
      const occurrences = sessions.filter(other => (other.versionId === session.versionId || !other.versionId && other.planId === session.planId) && other.date === date && other.day.id === day.id)
      if (occurrences.some(other => other.completedAt || !intact(other, exercise.id))) return []
      return [{ date, dayId: day.id, prescriptionId: exercise.id, before: exercise.snapshot, after: { ...source.snapshot!, id: exercise.id } }]
    })
  })
}
/** La dose originale è proposta solo fra modalità compatibili. Nessuna conversione reps/tempo. */
export function replacementSnapshot(source: SnapshotExercise, selected: CatalogExercise, dose: ChangeDose): SnapshotExercise {
  return { ...dose, id: source.id, exercise_id: selected.id, name: selected.name, variant: selected.variant, equipment: selected.equipment,
    load_convention: selected.loadConvention, load_unit: selected.loadUnit, per_side: selected.perSide, exercise_note: selected.note,
    mode: selected.measurementMode, muscle_group: selected.muscleGroup, note: '' }
}
export function proposedDose(source: SnapshotExercise, selected: CatalogExercise): ChangeDose {
  const compatible = source.mode === selected.measurementMode
  const cardio = isTimedCardio(selected)
  return { sets: cardio ? 1 : source.sets, optional_sets: cardio ? 0 : source.optional_sets, rest_seconds: cardio ? 0 : source.rest_seconds, rir: source.rir, rpe: source.rpe,
    reps_min: compatible ? source.reps_min : null, reps_max: compatible ? source.reps_max : null, duration_seconds: compatible ? source.duration_seconds : null }
}
export function canUndoChange(change: ExerciseChange, sessions: WorkoutSession[]) {
  if (change.cancelled) return false
  const source = sessions.find(session => session.id === change.sessionId)
  if (!source || source.completedAt || !intact(source, change.sourceId)) return false
  return !change.partner || !sessions.some(session => (session.versionId === change.versionId || !session.versionId && session.planId === change.planId) && session.date === change.partner!.date && session.day.id === change.partner!.dayId
    && (session.completedAt || !intact(session, change.partner!.prescriptionId)))
}
export function applyExerciseChange(data: DiaryData, change: ExerciseChange): DiaryData {
  const changes = [...(data.changes ?? []).filter(item => item.id !== change.id), structuredClone(change)]
  const sessions = data.sessions.map(session => {
    const source = session.id === change.sessionId
    const partner = change.partner && session.versionId === change.versionId && session.date === change.partner.date && session.day.id === change.partner.dayId
    if ((!source && !partner) || session.completedAt) return session
    const raw = source ? change.cancelled ? change.before : change.after : change.cancelled ? change.partner!.before : change.partner!.after
    const current = session.day.exercises.find(exercise => exercise.id === raw.id)
    if (!current) return session
    // Il replay di una risposta persa conserva le serie già inserite (ordine JSON irrilevante).
    const identical = current.snapshot && Object.entries(raw).every(([key, value]) => current.snapshot![key as keyof SnapshotExercise] === value)
    const exercise = prescription(raw)
    return { ...session, day: { ...session.day, exercises: session.day.exercises.map(item => item.id === raw.id ? exercise : item) },
      results: identical ? session.results : { ...session.results, [raw.id]: Array.from({ length: totalSets(exercise) }, () => ({ load: '', amount: '', completed: false })) } }
  })
  return { ...data, changes, sessions }
}
