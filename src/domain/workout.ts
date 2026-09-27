import type { WorkoutSession, ExercisePrescription, RestTimerState, SetResult } from './types.ts'

export interface PreviousExercise {
  session: WorkoutSession
  exercise: ExercisePrescription
  results: SetResult[]
}

export function comparable(a: ExercisePrescription, b: ExercisePrescription): boolean {
  if (!a.comparison || !b.comparison) return false
  return a.exerciseId === b.exerciseId && a.mode === b.mode
    && a.comparison.variant === b.comparison.variant
    && a.comparison.equipment === b.comparison.equipment
    && a.comparison.loadConvention === b.comparison.loadConvention
    && a.comparison.perSide === b.comparison.perSide
}

export function findPreviousExercise(
  sessions: WorkoutSession[], exercise: ExercisePrescription,
  before: Pick<WorkoutSession, 'id' | 'date' | 'startedAt'>,
): PreviousExercise | undefined {
  const candidates = sessions.filter(session => session.id !== before.id && session.completedAt
    && (session.date < before.date || (session.date === before.date && session.startedAt < before.startedAt)))
    .sort((a, b) => b.date.localeCompare(a.date) || b.startedAt.localeCompare(a.startedAt))
  for (const session of candidates) {
    const match = session.day.exercises.find(item => comparable(exercise, item)
      && session.results[item.id]?.some(set => set.completed))
    if (match) return { session, exercise: match, results: session.results[match.id]! }
  }
}

export function formatResult(result: SetResult | undefined, mode: ExercisePrescription['mode'], unit: 'kg' | 'lb' = 'kg'): string {
  if (!result?.completed) return '—'
  const amount = `${result.amount}${mode === 'seconds' ? ' s' : ' rip.'}`
  return result.load.trim() === '' ? amount : `${result.load} ${unit} × ${amount}`
}

/** Copia solo i carichi nelle righe ancora vuote, senza segnare risultati eseguiti. */
export function reusePreviousLoads(current: SetResult[], previous: SetResult[]): SetResult[] {
  return current.map((set, index) => {
    const old = previous[index]
    return !set.completed && set.load === '' && old?.completed ? { ...set, load: old.load } : set
  })
}

export function remainingRest(timer: RestTimerState, now = Date.now()): number {
  return timer.pausedSeconds ?? Math.max(0, Math.ceil((timer.deadline - now) / 1000))
}

export function formatRest(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
