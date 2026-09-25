import type { LocalDate } from './types.ts'

export const diaryTimeZone = 'Europe/Rome'

export function localDate(now = new Date(), timeZone = diaryTimeZone): LocalDate {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const part = (type: string) => parts.find(p => p.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function isLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function shiftDate(value: LocalDate, days: number): LocalDate {
  if (!isLocalDate(value)) throw new Error('Data non valida')
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function formatDate(value: LocalDate, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' }): string {
  return new Intl.DateTimeFormat('it-IT', { ...options, timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`))
}

export function weekDates(value: LocalDate): LocalDate[] {
  const weekday = new Date(`${value}T12:00:00Z`).getUTCDay()
  const monday = shiftDate(value, -((weekday + 6) % 7))
  return Array.from({ length: 7 }, (_, i) => shiftDate(monday, i))
}
