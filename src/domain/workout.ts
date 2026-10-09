import { validateSet } from './validation.ts'
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
  // Esercizi a tempo: solo il tempo, anche se uno storico vecchio avesse un carico.
  return result.load.trim() === '' || mode === 'seconds' ? amount : `${result.load} ${unit} × ${amount}`
}

/** Copia solo i carichi nelle righe ancora vuote, senza segnare risultati eseguiti. */
export function reusePreviousLoads(current: SetResult[], previous: SetResult[]): SetResult[] {
  return current.map((set, index) => {
    const old = previous[index]
    return !set.completed && set.load === '' && old?.completed ? { ...set, load: old.load } : set
  })
}

/**
 * Spuntata una serie, la successiva dello stesso tipo (obbligatoria o facoltativa) ancora senza carico
 * riceve lo stesso carico. Mai ripetizioni né spunta: le facoltative non si attivano da sole.
 */
export function carryLoadForward(results: SetResult[], index: number, requiredSets: number): { index: number; result: SetResult } | null {
  const done = results[index], next = results[index + 1]
  if (!done?.completed || done.load.trim() === '' || !next || next.completed || next.load !== '') return null
  if ((index < requiredSets) !== (index + 1 < requiredSets)) return null
  return { index: index + 1, result: { ...next, load: done.load } }
}

/** Le modifiche di una spunta: la serie fatta e, se serve, il carico riportato alla successiva. */
export function completeSetChanges(results: SetResult[], index: number, requiredSets: number): { index: number; result: SetResult }[] {
  const set = results[index]
  if (!set) return []
  const done = { ...set, completed: true }
  const carried = carryLoadForward(results.map((item, i) => i === index ? done : item), index, requiredSets)
  return carried ? [{ index, result: done }, carried] : [{ index, result: done }]
}

/**
 * Serie «appena fatta» di un esercizio: l'ultima con qualche valore scritto, se non è spuntata e la spunta
 * manuale la accetterebbe. Serve a segnarla passando all'esercizio successivo.
 */
export function pendingFilledSet(results: SetResult[], mode: ExercisePrescription['mode']): number | undefined {
  let last = -1
  results.forEach((set, index) => { if (set.load.trim() !== '' || set.amount.trim() !== '') last = index })
  const set = results[last]
  return set && !set.completed && validateSet(set.load, set.amount, mode) === null ? last : undefined
}

/** Serie previste e serie previste completate (le facoltative non contano). */
export function sessionProgress(session: WorkoutSession): { required: number; completedRequired: number } {
  const required = session.day.exercises.reduce((sum, exercise) => sum + exercise.sets, 0)
  const completedRequired = session.day.exercises.reduce((sum, exercise) => sum + Math.min(exercise.sets, (session.results[exercise.id] ?? []).filter(set => set.completed).length), 0)
  return { required, completedRequired }
}

/** Serie compilate ma senza spunta: solo quelle che la spunta manuale accetterebbe (mai valori vuoti). */
export function filledUnchecked(session: WorkoutSession): { exerciseId: string; index: number; result: SetResult; required: boolean }[] {
  return session.day.exercises.flatMap(exercise => (session.results[exercise.id] ?? []).flatMap((result, index) =>
    !result.completed && validateSet(result.load, result.amount, exercise.mode) === null ? [{ exerciseId: exercise.id, index, result, required: index < exercise.sets }] : []))
}

/** Oltre questo tempo dall'inizio una seduta ancora aperta è probabilmente dimenticata. */
export const STALE_SESSION_MS = 4 * 60 * 60 * 1000
export function isStaleSession(session: WorkoutSession, now = Date.now()): boolean {
  const started = Date.parse(session.startedAt)
  return !session.completedAt && Number.isFinite(started) && now - started >= STALE_SESSION_MS
}

/** Ordine mostrato in seduta: gli esercizi rimandati passano in fondo, nell'ordine in cui sono stati rimandati. */
export function sessionOrder(exercises: ExercisePrescription[], later: readonly string[]): ExercisePrescription[] {
  const deferred = later.flatMap(id => exercises.filter(exercise => exercise.id === id))
  return [...exercises.filter(exercise => !later.includes(exercise.id)), ...deferred]
}

/**
 * Esercizio a cui passare dopo `fromId`: il successivo ancora da fare nell'ordine mostrato, saltando i
 * rimandati finché resta qualcos'altro da fare; poi il primo rimandato ancora da fare.
 */
export function nextExercise(session: WorkoutSession, later: readonly string[], fromId: string): string | undefined {
  const order = sessionOrder(session.day.exercises, later)
  const pending = (exercise: ExercisePrescription) => exercise.id !== fromId && (session.results[exercise.id] ?? []).filter(set => set.completed).length < exercise.sets
  const position = order.findIndex(exercise => exercise.id === fromId)
  const after = order.find((exercise, index) => index > position && !later.includes(exercise.id) && pending(exercise))
  if (after) return after.id
  if (order.some(exercise => !later.includes(exercise.id) && pending(exercise))) return undefined
  return order.find(exercise => later.includes(exercise.id) && pending(exercise))?.id
}

export function remainingRest(timer: RestTimerState, now = Date.now()): number {
  return timer.pausedSeconds ?? Math.max(0, Math.ceil((timer.deadline - now) / 1000))
}

/**
 * +15 s o −15 s sul recupero, anche in pausa. Mai sotto zero: a 0 il recupero risulta terminato.
 * Allungando cresce anche la durata, così la barra resta proporzionata.
 */
export function adjustRest(timer: RestTimerState, deltaSeconds: number, now = Date.now()): RestTimerState {
  const paused = timer.pausedSeconds !== null
  return {
    ...timer,
    durationSeconds: timer.durationSeconds + Math.max(0, deltaSeconds),
    deadline: paused ? timer.deadline + deltaSeconds * 1000 : Math.max(now, timer.deadline + deltaSeconds * 1000),
    pausedSeconds: paused ? Math.max(0, remainingRest(timer, now) + deltaSeconds) : null,
  }
}

export function formatRest(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`
}
