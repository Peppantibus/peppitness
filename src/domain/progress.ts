import { shiftDate } from './dates.ts'
import type { ProgramCycle } from './programs.ts'
import type { ExercisePrescription, LocalDate, WorkoutDay, WorkoutSession } from './types.ts'
import { parseNonNegativeNumber } from './validation.ts'
import { comparable } from './workout.ts'
import { isWeekly, weekdayIndex, weekdayOfDate } from './weekly.ts'

export const cycleDurations = [4, 6, 8, 10, 12]

/** Lunedì della settimana della data, oppure il successivo se `next`. */
export function mondayOf(date: LocalDate, next = false): LocalDate {
  const index = weekdayOfDate(date)
  if (next) return index === 0 ? date : shiftDate(date, 7 - index)
  return shiftDate(date, -index)
}

export interface CycleInfo {
  start: LocalDate; end: LocalDate; weeks: number
  /** Settimana corrente 1…weeks; 0 prima dell'inizio, weeks+1 dopo la fine. */
  week: number
  status: 'upcoming' | 'active' | 'finished'
}
export function cycleInfo(cycle: ProgramCycle, date: LocalDate): CycleInfo {
  const end = shiftDate(cycle.start, cycle.weeks * 7 - 1)
  const days = Math.floor((Date.parse(`${date}T12:00:00Z`) - Date.parse(`${cycle.start}T12:00:00Z`)) / 86_400_000)
  const week = date < cycle.start ? 0 : date > end ? cycle.weeks + 1 : Math.floor(days / 7) + 1
  return { start: cycle.start, end, weeks: cycle.weeks, week, status: week === 0 ? 'upcoming' : week > cycle.weeks ? 'finished' : 'active' }
}

export interface PlannedSlot { label: string; title: string; date: LocalDate | null; state: 'done' | 'missed' | 'planned' }
export interface WeekProgress { index: number; start: LocalDate; end: LocalDate; slots: PlannedSlot[]; extra: number; current: boolean }

/**
 * Costanza settimana per settimana. Programma settimanale: ogni seduta ha la sua data.
 * Una seduta fatta in un altro giorno della stessa settimana conta comunque: prima si
 * abbinano le sedute con la stessa etichetta, poi le restanti ai posti ancora liberi.
 */
export function weeklyProgress(days: WorkoutDay[], sessions: WorkoutSession[], cycle: ProgramCycle, today: LocalDate): WeekProgress[] {
  const weekly = isWeekly(days)
  const done = sessions.filter(session => session.completedAt)
  return Array.from({ length: cycle.weeks }, (_, i) => {
    const start = shiftDate(cycle.start, i * 7), end = shiftDate(start, 6)
    const inWeek = done.filter(session => session.date >= start && session.date <= end)
    const used = new Set<string>()
    const slots: PlannedSlot[] = days.map(day => {
      const date = weekly ? shiftDate(start, (weekdayIndex(day.label) - weekdayOfDate(start) + 7) % 7) : null
      const match = inWeek.find(session => !used.has(session.id) && session.day.label === day.label)
      if (match) used.add(match.id)
      return { label: day.label, title: day.title, date, state: match ? 'done' : 'planned' }
    })
    for (const slot of slots) {
      if (slot.state === 'done') continue
      const other = inWeek.find(session => !used.has(session.id))
      if (other) { used.add(other.id); slot.state = 'done' }
    }
    // Scaduto: il giorno previsto è passato (o, senza date, la settimana è finita).
    for (const slot of slots) if (slot.state === 'planned' && (slot.date ? slot.date < today : end < today)) slot.state = 'missed'
    return { index: i + 1, start, end, slots, extra: inWeek.length - used.size, current: today >= start && today <= end }
  })
}

export function adherence(weeks: WeekProgress[]) {
  const slots = weeks.flatMap(week => week.slots)
  const done = slots.filter(slot => slot.state === 'done').length
  const due = done + slots.filter(slot => slot.state === 'missed').length
  return { done, due, planned: slots.length, extra: weeks.reduce((sum, week) => sum + week.extra, 0), percent: due ? Math.round(done / due * 100) : null }
}

export interface TrendPoint { date: LocalDate; best: number | null; volume: number; sets: number }
export interface ExerciseTrend {
  exercise: ExercisePrescription
  points: TrendPoint[]
  /** Misura confrontata: carico massimo se presente, altrimenti volume (ripetizioni o secondi). */
  metric: 'best' | 'volume'
  first: number | null; last: number | null
  change: 'up' | 'down' | 'flat' | 'new' | 'none'
}

const number = (value: string) => { try { return parseNonNegativeNumber(value) } catch { return null } }

/** Andamento per esercizio del programma, dalle sole serie completate. */
export function exerciseTrends(days: WorkoutDay[], sessions: WorkoutSession[], from?: LocalDate, to?: LocalDate): ExerciseTrend[] {
  const exercises: ExercisePrescription[] = []
  for (const day of days) for (const exercise of day.exercises) if (!exercises.some(item => comparable(item, exercise) || (!item.comparison && item.exerciseId === exercise.exerciseId))) exercises.push(exercise)
  const completed = sessions.filter(session => session.completedAt && (!from || session.date >= from) && (!to || session.date <= to))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startedAt.localeCompare(b.startedAt))
  return exercises.map(exercise => {
    const points: TrendPoint[] = []
    for (const session of completed) {
      const match = session.day.exercises.find(item => comparable(exercise, item))
      if (!match) continue
      const sets = (session.results[match.id] ?? []).filter(set => set.completed)
      if (!sets.length) continue
      const loads = sets.map(set => number(set.load)).filter((value): value is number => value !== null && value > 0)
      const volume = sets.reduce((sum, set) => {
        const amount = number(set.amount) ?? 0, load = number(set.load)
        return sum + (exercise.mode === 'reps' && load ? load * amount : amount)
      }, 0)
      points.push({ date: session.date, best: loads.length ? Math.max(...loads) : null, volume, sets: sets.length })
    }
    const metric: ExerciseTrend['metric'] = points.some(point => point.best !== null) ? 'best' : 'volume'
    const values = points.map(point => metric === 'best' ? point.best : point.volume).filter((value): value is number => value !== null)
    const first = values[0] ?? null, last = values.at(-1) ?? null
    const change = !values.length ? 'none' : values.length === 1 ? 'new'
      : last! > first! * 1.02 ? 'up' : last! < first! * 0.98 ? 'down' : 'flat'
    return { exercise, points, metric, first, last, change }
  })
}
