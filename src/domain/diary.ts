import { loadLabels } from './exercises.ts'
import type { MuscleGroup } from './muscle-groups.ts'
import type { ProgramDocument } from './programs.ts'
import { parseNonNegativeNumber, validateSet } from './validation.ts'
import type { DayType, ExercisePrescription, LocalDate, Meal, MealLog, MealStatus, RestTimerState, SetResult, WorkoutDay, WorkoutSession } from './types.ts'

/** Stato del diario mostrato dalle schermate: sedute, pasti e tipo di giornata. */
export interface DiaryData {
  sessions: WorkoutSession[]
  mealLogs: Record<string, MealLog>
  dayTypes: Record<LocalDate, DayType>
}
export const emptyDiary = (): DiaryData => ({ sessions: [], mealLogs: {}, dayTypes: {} })
export function mealLogKey(date: LocalDate, mealId: string): string { return `${date}:${mealId}` }

/** Prescrizione salvata nello snapshot server della seduta. */
export interface SnapshotExercise {
  muscle_group?: MuscleGroup | null
  id: string; exercise_id: string; name: string; variant: string; equipment: string
  load_convention: 'total' | 'single-dumbbell' | 'bodyweight'; load_unit: 'kg' | 'lb'; per_side: boolean; exercise_note: string
  mode: 'reps' | 'seconds'; sets: number; optional_sets: number; reps_min: number | null; reps_max: number | null
  duration_seconds: number | null; rest_seconds: number; rir: number | null; rpe: number | null; note: string
}
export interface SessionSnapshot { label: string; title: string; note: string; plan_title: string; version_number: number; exercises: SnapshotExercise[] }

export function formatDecimal(value: number | null): string {
  return value === null ? '' : String(value).replace('.', ',')
}

function prescription(value: SnapshotExercise): ExercisePrescription {
  const target = value.mode === 'reps'
    ? value.reps_min === value.reps_max ? String(value.reps_min) : `${value.reps_min}–${value.reps_max}`
    : `${value.duration_seconds} secondi`
  const effort = [value.rir !== null ? `RIR ${formatDecimal(value.rir)}` : '', value.rpe !== null ? `RPE ${formatDecimal(value.rpe)}` : ''].filter(Boolean).join(' · ')
  const perSide = value.per_side ? 'per lato' : ''
  return {
    ...(value.muscle_group === undefined ? {} : { muscleGroup: value.muscle_group }),
    id: value.id, exerciseId: value.exercise_id, name: value.name,
    area: [value.variant, value.equipment, perSide].filter(Boolean).join(' · ') || loadLabels[value.load_convention],
    sets: value.sets, ...(value.optional_sets > 0 ? { optionalSets: value.optional_sets } : {}),
    target: value.mode === 'reps' && value.per_side ? `${target} per lato` : target, mode: value.mode, restSeconds: value.rest_seconds,
    loadLabel: loadLabels[value.load_convention], loadUnit: value.load_unit, ...(effort ? { effortLabel: effort } : {}),
    note: [value.note, value.exercise_note].filter(Boolean).join('\n'),
    comparison: { variant: value.variant, equipment: value.equipment, loadConvention: value.load_convention, perSide: value.per_side },
  }
}

export function dayFromSnapshot(dayId: string, snapshot: SessionSnapshot): WorkoutDay {
  return { id: dayId, label: snapshot.label, title: snapshot.title, subtitle: snapshot.plan_title, notes: snapshot.note || undefined, exercises: snapshot.exercises.map(prescription) }
}

/** Vista quotidiana di una versione pubblicata: stessi campi dello snapshot del server. */
export function workoutDaysFromProgram(document: ProgramDocument): WorkoutDay[] {
  const number = (value: string) => value.trim() === '' ? null : parseNonNegativeNumber(value)
  return document.days.map(day => dayFromSnapshot(day.id, {
    label: day.label, title: day.title, note: day.note, plan_title: document.title, version_number: 0,
    exercises: day.exercises.map(item => ({
      ...(item.exercise.muscleGroup === undefined ? {} : { muscle_group: item.exercise.muscleGroup }),
      id: item.id, exercise_id: item.exercise.id, name: item.exercise.name, variant: item.exercise.variant, equipment: item.exercise.equipment,
      load_convention: item.exercise.loadConvention, load_unit: item.exercise.loadUnit, per_side: item.exercise.perSide, exercise_note: item.exercise.note,
      mode: item.exercise.measurementMode, sets: number(item.sets) ?? 1, optional_sets: number(item.optionalSets) ?? 0,
      reps_min: number(item.repsMin), reps_max: number(item.repsMax), duration_seconds: number(item.durationSeconds),
      rest_seconds: number(item.restSeconds) ?? 0, rir: number(item.rir), rpe: number(item.rpe), note: item.note,
    })),
  }))
}

export function totalSets(exercise: ExercisePrescription) { return exercise.sets + (exercise.optionalSets ?? 0) }
export function emptyResults(day: WorkoutDay): Record<string, SetResult[]> {
  return Object.fromEntries(day.exercises.map(exercise => [exercise.id, Array.from({ length: totalSets(exercise) }, (): SetResult => ({ load: '', amount: '', completed: false }))]))
}

/** Valori numerici inviati al server; null se l'input è ancora incompleto (es. "12,"). */
export function setValues(result: SetResult, mode: ExercisePrescription['mode']): { load: number | null; amount: number | null; completed: boolean } | null {
  try {
    const load = parseNonNegativeNumber(result.load), amount = parseNonNegativeNumber(result.amount)
    if ((load !== null && load > 100000) || (amount !== null && amount > 100000)) return null
    if (mode === 'reps' && amount !== null && !Number.isInteger(amount)) return null
    if (result.completed && validateSet(result.load, result.amount, mode)) return null
    return { load, amount, completed: result.completed }
  } catch { return null }
}

/** Operazioni del diario: applicate subito alla vista locale e poi inviate in ordine. */
export type DiaryOp =
  | { type: 'start'; opId: string; session: WorkoutSession; planId: string; versionId: string; timeZone: string }
  | { type: 'set'; opId: string; sessionId: string; prescriptionId: string; index: number; result: SetResult }
  | { type: 'complete'; opId: string; sessionId: string; at: string }
  | { type: 'discard'; opId: string; sessionId: string }
  | { type: 'note'; opId: string; sessionId: string; note: string }
  | { type: 'meal'; opId: string; date: LocalDate; planId: string; meal: Meal; status: MealStatus; note: string; dayType: DayType }
  | { type: 'day'; opId: string; date: LocalDate; dayType: DayType }

/** Chiave della riga server interessata: operazioni con la stessa chiave si uniscono. */
export function opKey(op: DiaryOp): string {
  switch (op.type) {
    // La nota sta sulla riga della seduta: stessa revisione di avvio e completamento.
    case 'start': case 'complete': case 'discard': case 'note': return `session:${op.type === 'start' ? op.session.id : op.sessionId}`
    case 'set': return `set:${op.sessionId}:${op.prescriptionId}:${op.index}`
    case 'meal': return `meal:${op.date}:${op.meal.id}`
    case 'day': return `day:${op.date}`
  }
}

export function applyOp(data: DiaryData, op: DiaryOp): DiaryData {
  switch (op.type) {
    case 'start':
      return data.sessions.some(session => session.id === op.session.id) ? data : { ...data, sessions: [...data.sessions, structuredClone(op.session)] }
    case 'set':
      return { ...data, sessions: data.sessions.map(session => {
        if (session.id !== op.sessionId) return session
        const exercise = session.day.exercises.find(item => item.id === op.prescriptionId)
        if (!exercise || op.index < 0 || op.index >= totalSets(exercise)) return session
        const current = session.results[op.prescriptionId] ?? emptyResults(session.day)[op.prescriptionId]!
        return { ...session, results: { ...session.results, [op.prescriptionId]: current.map((set, i) => i === op.index ? { ...op.result } : set) } }
      }) }
    case 'complete':
      return { ...data, sessions: data.sessions.map(session => session.id === op.sessionId && !session.completedAt ? { ...session, completedAt: op.at } : session) }
    case 'discard':
      return { ...data, sessions: data.sessions.filter(session => session.id !== op.sessionId || Boolean(session.completedAt)) }
    case 'note':
      return { ...data, sessions: data.sessions.map(session => session.id === op.sessionId ? { ...session, note: op.note } : session) }
    case 'meal': {
      const key = mealLogKey(op.date, op.meal.id), existing = data.mealLogs[key]
      // Il contesto della prima registrazione non segue modifiche successive del piano o della giornata.
      return { ...data, mealLogs: { ...data.mealLogs, [key]: { date: op.date, mealId: op.meal.id, status: op.status, note: op.note, dayType: existing?.dayType ?? op.dayType, snapshot: existing?.snapshot ?? structuredClone(op.meal) } } }
    }
    case 'day':
      return { ...data, dayTypes: { ...data.dayTypes, [op.date]: op.dayType } }
  }
}

export function replay(data: DiaryData, ops: DiaryOp[]): DiaryData { return ops.reduce(applyOp, data) }

/** Recupero avviato dopo Fatto; annullato riaprendo la stessa serie. */
export function nextRestTimer(timer: RestTimerState | null, session: WorkoutSession, prescriptionId: string, index: number, result: SetResult, now = Date.now()): RestTimerState | null {
  const exercise = session.day.exercises.find(item => item.id === prescriptionId)
  const original = session.results[prescriptionId]?.[index]
  if (!exercise || !original) return timer
  if (!original.completed && result.completed && exercise.restSeconds > 0) {
    return { sessionId: session.id, exerciseId: prescriptionId, exerciseName: exercise.name, setIndex: index, durationSeconds: exercise.restSeconds, deadline: now + exercise.restSeconds * 1000, pausedSeconds: null }
  }
  if (!result.completed && timer?.sessionId === session.id && timer.exerciseId === prescriptionId && timer.setIndex === index) return null
  return timer
}

/** Suggerimento: la seduta successiva all'ultima completata della stessa versione. Mai automatico. */
export function suggestedDay(days: WorkoutDay[], sessions: WorkoutSession[]): WorkoutDay | undefined {
  // Una nuova versione ha ID diversi: l'etichetta conserva la rotazione fra versioni.
  const position = (day: WorkoutDay) => { const byId = days.findIndex(item => item.id === day.id); return byId >= 0 ? byId : days.findIndex(item => item.label === day.label) }
  const last = sessions.filter(session => session.completedAt && position(session.day) >= 0)
    .sort((a, b) => b.date.localeCompare(a.date) || b.startedAt.localeCompare(a.startedAt))[0]
  if (!last) return days[0]
  return days[(position(last.day) + 1) % days.length]
}
