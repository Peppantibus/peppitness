import { isLocalDate, localDate, shiftDate, weekDates } from './dates.ts'
import type { DiaryData } from './diary.ts'
import type { ProgramCycle } from './programs.ts'
import type { WorkoutDay } from './types.ts'
import { dayForDate, isWeekly } from './weekly.ts'

/** Due assegnazioni concrete. Gli ID delle schede e gli snapshot restano immutati. */
export interface DaySwap {
  id: string; planId: string; versionId: string; sourceDate: string; targetDate: string
  sourceDayId: string | null; targetDayId: string | null; timeZone: string; cancelled: boolean
}
export interface ScheduleExpectation { dayId: string | null; swapId: string | null; manualChoice?: boolean }
export function swapAt(swaps: readonly DaySwap[], versionId: string, date: string) {
  return swaps.find(swap => !swap.cancelled && swap.versionId === versionId && (swap.sourceDate === date || swap.targetDate === date))
}
export function inCycle(cycle: ProgramCycle | null | undefined, date: string) {
  return !cycle || date >= cycle.start && date <= shiftDate(cycle.start, cycle.weeks * 7 - 1)
}
/** Unica risoluzione del calendario, prima delle modifiche datate ai singoli esercizi. */
export function scheduledDay<T extends { id: string; label: string }>(days: T[], date: string, versionId: string, swaps: readonly DaySwap[] = [], cycle?: ProgramCycle | null): T | undefined {
  const swap = swapAt(swaps, versionId, date)
  if (!swap || !inCycle(cycle, swap.sourceDate) || !inCycle(cycle, swap.targetDate)) return dayForDate(days, date)
  const id = swap.sourceDate === date ? swap.targetDayId : swap.sourceDayId
  return days.find(day => day.id === id)
}
export function scheduleExpectation(days: WorkoutDay[], date: string, versionId: string, swaps: readonly DaySwap[], cycle?: ProgramCycle | null): ScheduleExpectation {
  return { dayId: scheduledDay(days, date, versionId, swaps, cycle)?.id ?? null, swapId: swapAt(swaps, versionId, date)?.id ?? null }
}
export function swapBlocked(swap: DaySwap, view: DiaryData, today = localDate(new Date(), swap.timeZone), ignoreId?: string): string | null {
  if (!isLocalDate(swap.sourceDate) || !isLocalDate(swap.targetDate) || swap.sourceDate === swap.targetDate || !weekDates(swap.sourceDate).includes(swap.targetDate)) return 'Scegli due date diverse nella stessa settimana.'
  if (swap.targetDate < today) return 'La destinazione non può precedere oggi.'
  if (view.sessions.some(session => (session.versionId === swap.versionId || !session.versionId && session.planId === swap.planId) && [swap.sourceDate, swap.targetDate].includes(session.date))) return 'Una delle due giornate ha un allenamento già avviato.'
  if (view.swaps?.some(other => !other.cancelled && other.id !== ignoreId && other.versionId === swap.versionId && [other.sourceDate, other.targetDate].some(date => [swap.sourceDate, swap.targetDate].includes(date)))) return 'Annulla prima lo spostamento già presente su questa giornata.'
  if (view.changes?.some(change => !change.cancelled && change.versionId === swap.versionId && [swap.sourceDate, swap.targetDate].some(date => date === change.sourceDate || date === change.partner?.date))) return 'È presente una modifica datata agli esercizi: annullala prima.'
  return null
}
export function newDaySwap(args: { planId: string; versionId: string; days: WorkoutDay[]; sourceDate: string; targetDate: string; timeZone: string; cycle?: ProgramCycle | null }, view: DiaryData): DaySwap {
  const { days, cycle, ...rest } = args
  if (!isWeekly(days) || new Set(days.map(day => day.label.trim().toLowerCase())).size !== days.length || !inCycle(cycle, args.sourceDate) || !inCycle(cycle, args.targetDate)) throw new Error('Scegli due giornate del ciclo dello stesso programma settimanale.')
  const swap: DaySwap = { ...rest, id: crypto.randomUUID(), sourceDayId: scheduledDay(days, args.sourceDate, args.versionId, view.swaps)?.id ?? null,
    targetDayId: scheduledDay(days, args.targetDate, args.versionId, view.swaps)?.id ?? null, cancelled: false }
  if (!swap.sourceDayId || swap.sourceDayId === swap.targetDayId) throw new Error('Scegli un allenamento da spostare.')
  const reason = swapBlocked(swap, view)
  if (reason) throw new Error(reason)
  return swap
}
export function applyDaySwap(view: DiaryData, swap: DaySwap): DiaryData {
  return { ...view, swaps: [...(view.swaps ?? []).filter(item => item.id !== swap.id), { ...swap }] }
}
