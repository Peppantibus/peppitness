export interface SettingsValues {
  displayName: string
  timeZone: string
  workoutWeekdays: number[]
}

export interface SavedSettings extends SettingsValues { revision: number }

export function defaultSettings(): SettingsValues {
  return { displayName: '', timeZone: 'Europe/Rome', workoutWeekdays: [] }
}

export function validateSettings(value: SettingsValues): string | null {
  if ([...value.displayName].length > 120) return 'Il nome può contenere al massimo 120 caratteri.'
  if (!value.timeZone || value.timeZone.length > 80) return 'Inserisci un fuso orario valido, per esempio Europe/Rome.'
  try { new Intl.DateTimeFormat('it-IT', { timeZone: value.timeZone }).format() }
  catch { return 'Inserisci un fuso orario valido, per esempio Europe/Rome.' }
  if (value.workoutWeekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)
    || new Set(value.workoutWeekdays).size !== value.workoutWeekdays.length) return 'Controlla i giorni di allenamento selezionati.'
  return null
}

export function sameSettings(a: SettingsValues, b: SettingsValues): boolean {
  return a.displayName === b.displayName && a.timeZone === b.timeZone
    && [...a.workoutWeekdays].sort().join(',') === [...b.workoutWeekdays].sort().join(',')
}

export const weekdayLabels = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica']

export function isWorkoutWeekday(date: string, days: number[]): boolean {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay() || 7
  return days.includes(day)
}
