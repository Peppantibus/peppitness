import type { DayType, DemoSession, LocalDate, Meal, MealLog, MealStatus, RestTimerState, SetResult, WorkoutDay } from '../domain/types'

export interface DemoState {
  mealLogs: Record<string, MealLog>
  dayTypes: Record<LocalDate, DayType>
  sessions: DemoSession[]
  restTimer: RestTimerState | null
}

/** Adattatore solo in memoria. Non simula salvataggi cloud o offline persistenti. */
export function createDemoState(): DemoState {
  return { mealLogs: {}, dayTypes: {}, sessions: [], restTimer: null }
}

export function updateSessionSet(state: DemoState, sessionId: string, exerciseId: string, index: number, result: SetResult, now = Date.now()): DemoState {
  const session = state.sessions.find(item => item.id === sessionId && !item.completedAt)
  const exercise = session?.day.exercises.find(item => item.id === exerciseId)
  const original = session?.results[exerciseId]?.[index]
  if (!session || !exercise || !original) return state
  let restTimer = state.restTimer
  if (!original.completed && result.completed && exercise.restSeconds > 0) {
    restTimer = { sessionId, exerciseId, exerciseName: exercise.name, setIndex: index, durationSeconds: exercise.restSeconds, deadline: now + exercise.restSeconds * 1000, pausedSeconds: null }
  } else if (!result.completed && restTimer?.sessionId === sessionId && restTimer.exerciseId === exerciseId && restTimer.setIndex === index) {
    restTimer = null
  }
  return { ...state, restTimer, sessions: state.sessions.map(item => item.id === sessionId ? {
    ...item, results: { ...item.results, [exerciseId]: item.results[exerciseId]!.map((set, i) => i === index ? result : set) },
  } : item) }
}

export function mealLogKey(date: LocalDate, mealId: string): string { return `${date}:${mealId}` }

export function recordMeal(state: DemoState, date: LocalDate, meal: Meal, status: MealStatus, note: string): DemoState {
  const key = mealLogKey(date, meal.id)
  const existing = state.mealLogs[key]
  return { ...state, mealLogs: { ...state.mealLogs, [key]: {
    date, mealId: meal.id, status, note,
    dayType: existing?.dayType ?? state.dayTypes[date] ?? 'training',
    snapshot: existing?.snapshot ?? structuredClone(meal),
  } } }
}

export function startDemoSession(state: DemoState, date: LocalDate, day: WorkoutDay): DemoState {
  if (state.sessions.some(session => !session.completedAt)) return state
  const session: DemoSession = {
    id: crypto.randomUUID(), date, day: structuredClone(day), startedAt: new Date().toISOString(),
    results: Object.fromEntries(day.exercises.map(exercise => [exercise.id, Array.from({ length: exercise.sets }, (): SetResult => ({ load: '', amount: '', completed: false }))])),
  }
  return { ...state, sessions: [...state.sessions, session] }
}
