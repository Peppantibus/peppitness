/** Il dominio non dipende dalle risposte Supabase o dalla UI. */
export type LocalDate = string
export type MealStatus = 'unrecorded' | 'followed' | 'modified' | 'skipped'
export type DayType = 'training' | 'rest'

export interface Meal {
  id: string
  name: string
  timeLabel: string
  description: string
  items: string[]
  alternative: string
  note: string
}

export interface MealLog {
  date: LocalDate
  mealId: string
  status: MealStatus
  note: string
  dayType: DayType
  /** Il contesto della registrazione non segue modifiche future del piano. */
  snapshot: Meal
}

export interface ExercisePrescription {
  id: string
  exerciseId: string
  name: string
  area: string
  sets: number
  target: string
  mode: 'reps' | 'seconds'
  restSeconds: number
  note: string
  comparison?: {
    variant: string
    equipment: string
    loadConvention: 'single-dumbbell' | 'total' | 'bodyweight'
    perSide: boolean
  }
}

export interface WorkoutDay {
  id: string
  label: string
  title: string
  subtitle: string
  exercises: ExercisePrescription[]
}

export interface SetResult {
  load: string
  amount: string
  completed: boolean
}

export interface DemoSession {
  id: string
  date: LocalDate
  day: WorkoutDay
  startedAt: string
  completedAt?: string
  results: Record<string, SetResult[]>
}

export interface RestTimerState {
  sessionId: string
  exerciseId: string
  exerciseName: string
  setIndex: number
  durationSeconds: number
  deadline: number
  pausedSeconds: number | null
}

export const mealStatuses: Record<MealStatus, string> = {
  unrecorded: 'Da registrare', followed: 'Seguito', modified: 'Modificato', skipped: 'Saltato',
}
