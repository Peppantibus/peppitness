import { isLocalDate } from './dates.ts'

export interface MorningExercise { id: string; name: string; area: string; dose: string; minutes: number; note: string }
export interface MorningRoutine { title: string; base: MorningExercise[]; extra: MorningExercise[]; strengthDays: number[]; note: string }
export const morningWeekdays = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom']
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const text = (value: unknown, max: number, required = false) => typeof value === 'string' && [...value].length <= max && (!required || Boolean(value.trim())) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).length === allowed.length && Object.keys(value).every(key => allowed.includes(key))
export function validMorningRoutine(value: unknown): value is MorningRoutine {
  if (!record(value) || !keys(value, ['title', 'base', 'extra', 'strengthDays', 'note']) || !text(value.title, 120, true) || !text(value.note, 8000)
    || !Array.isArray(value.base) || value.base.length < 1 || value.base.length > 30 || !Array.isArray(value.extra) || value.extra.length > 30
    || !Array.isArray(value.strengthDays) || value.strengthDays.length > 7 || new Set(value.strengthDays).size !== value.strengthDays.length
    || value.strengthDays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) return false
  const base: unknown[] = value.base, extra: unknown[] = value.extra
  const items = [...base, ...extra], ids = new Set<string>()
  let total = 0
  for (const item of items) {
    if (!record(item) || !keys(item, ['id', 'name', 'area', 'dose', 'minutes', 'note']) || !uuid(item.id) || ids.has(item.id)
      || !text(item.name, 120, true) || !text(item.area, 80) || !text(item.dose, 80) || !text(item.note, 4000)
      || typeof item.minutes !== 'number' || !Number.isFinite(item.minutes) || item.minutes < .5 || item.minutes > 30 || !Number.isInteger(item.minutes * 2)) return false
    ids.add(item.id)
    total += item.minutes
  }
  return total <= 180
}
export const morningDuration = (items: readonly MorningExercise[]) => items.reduce((sum, item) => sum + item.minutes, 0)
export function morningForDate(routine: MorningRoutine, date: string) {
  if (!isLocalDate(date)) throw new Error('Data non valida')
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay() || 7
  const withStrength = routine.extra.length > 0 && routine.strengthDays.includes(weekday)
  const exercises = [...routine.base, ...(withStrength ? routine.extra : [])]
  return { withStrength, exercises, minutes: morningDuration(exercises) }
}
export const morningDaysLabel = (days: readonly number[]) => days.length ? morningWeekdays.filter((_, i) => days.includes(i + 1)).join(' · ') : 'Nessun giorno'
export const emptyMorningRoutine = (): MorningRoutine => ({ title: 'Mobilità del mattino', base: [], extra: [], strengthDays: [2, 4, 6], note: '' })
