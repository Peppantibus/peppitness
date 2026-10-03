import type { ProgramDay, ProgramDocument, PrescriptionDraft } from './programs.ts'
import type { LocalDate, WorkoutDay } from './types.ts'

/**
 * Programma settimanale: ogni seduta ha come etichetta il giorno della settimana
 * (Lun…Dom). I giorni senza seduta sono di riposo. Nessuna colonna aggiuntiva nel
 * database: l'etichetta è già unica per versione.
 */
export const weekdays = [
  { code: 'Lun', name: 'Lunedì', short: 'L' },
  { code: 'Mar', name: 'Martedì', short: 'M' },
  { code: 'Mer', name: 'Mercoledì', short: 'M' },
  { code: 'Gio', name: 'Giovedì', short: 'G' },
  { code: 'Ven', name: 'Venerdì', short: 'V' },
  { code: 'Sab', name: 'Sabato', short: 'S' },
  { code: 'Dom', name: 'Domenica', short: 'D' },
] as const

import { isTimedCardio, muscleGroups } from './muscle-groups.ts'
export { muscleGroups } from './muscle-groups.ts'
export const defaultDayTitle = 'Allenamento'

/** Indice 0 = lunedì … 6 = domenica, oppure -1 se l'etichetta non è un giorno. */
export function weekdayIndex(label: string): number {
  return weekdays.findIndex(day => day.code.toLocaleLowerCase('it') === label.trim().toLocaleLowerCase('it'))
}
export function weekdayOfDate(date: LocalDate): number {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7
}
export function isWeekly(days: { label: string }[]): boolean {
  return days.length > 0 && days.every(day => weekdayIndex(day.label) >= 0)
}
/** Seduta prevista per la data in un programma settimanale; undefined = riposo. */
export function dayForDate<T extends { label: string }>(days: T[], date: LocalDate): T | undefined {
  const index = weekdayOfDate(date)
  return days.find(day => weekdayIndex(day.label) === index)
}
export function sortWeekly<T extends { label: string }>(days: T[]): T[] {
  return [...days].sort((a, b) => weekdayIndex(a.label) - weekdayIndex(b.label))
}

export function groupsFromTitle(title: string): string[] {
  return title.split(' · ').map(item => item.trim()).filter(item => (muscleGroups as readonly string[]).includes(item))
}
export function titleFromGroups(groups: string[]): string {
  const ordered = muscleGroups.filter(group => groups.includes(group))
  return ordered.length ? ordered.join(' · ') : defaultDayTitle
}

/** Documento compatibile con il wizard: vuoto oppure con sole sedute settimanali. */
export function fitsWizard(document: ProgramDocument): boolean {
  return document.days.length === 0 || isWeekly(document.days)
}

export function weeklyDay(document: ProgramDocument, index: number): ProgramDay | undefined {
  return document.days.find(day => weekdayIndex(day.label) === index)
}

/** Inserisce o sostituisce la seduta del giorno mantenendo l'ordine lunedì → domenica. */
export function setWeeklyDay(document: ProgramDocument, index: number, day: ProgramDay | null): ProgramDocument {
  const others = document.days.filter(item => weekdayIndex(item.label) !== index)
  return { ...document, days: sortWeekly(day ? [...others, { ...day, label: weekdays[index]!.code }] : others) }
}

export function emptyWeeklyDay(index: number): ProgramDay {
  return { id: crypto.randomUUID(), label: weekdays[index]!.code, title: defaultDayTitle, note: '', exercises: [] }
}

/** Copia gli esercizi di un altro giorno con nuovi identificativi (stesso catalogo). */
export function copyWeeklyDay(source: ProgramDay, index: number): ProgramDay {
  return { id: crypto.randomUUID(), label: weekdays[index]!.code, title: source.title, note: source.note,
    exercises: source.exercises.map(item => ({ ...structuredClone(item), id: crypto.randomUUID() })) }
}

/**
 * Nuova prescrizione per il wizard: riprende serie, ripetizioni/durata e recupero
 * dell'ultimo esercizio della stessa modalità inserito dall'utente in quel giorno.
 * Nessun valore inventato: senza un precedente i campi restano da compilare.
 */
export function prefillFromDay(item: PrescriptionDraft, day: ProgramDay): PrescriptionDraft {
  if (isTimedCardio(item.exercise)) return item
  const previous = [...day.exercises].reverse().find(other => other.exercise.measurementMode === item.exercise.measurementMode)
  if (!previous) return item
  return { ...item, sets: previous.sets, repsMin: previous.repsMin, repsMax: previous.repsMax, durationSeconds: previous.durationSeconds, restSeconds: previous.restSeconds }
}

/** Errori per campo di una seduta del wizard, per evidenziarli prima di proseguire. */
export function dayIssues(day: ProgramDay): Record<string, string> {
  const issues: Record<string, string> = {}
  const integer = (value: string, min: number, max: number) => /^\d+$/.test(value.trim()) && Number(value) >= min && Number(value) <= max
  for (const item of day.exercises) {
    if (!isTimedCardio(item.exercise) && !integer(item.sets, 1, 1000)) issues[`${item.id}:sets`] = 'Indica quante serie.'
    if (item.exercise.measurementMode === 'reps') {
      if (!integer(item.repsMin, 1, 10000) || !integer(item.repsMax, 1, 10000)) issues[`${item.id}:reps`] = 'Indica le ripetizioni.'
      else if (Number(item.repsMin) > Number(item.repsMax)) issues[`${item.id}:reps`] = 'Il minimo supera il massimo.'
    } else if (!integer(item.durationSeconds, 1, 86400)) issues[`${item.id}:duration`] = isTimedCardio(item.exercise) ? 'Indica i minuti.' : 'Indica la durata in secondi.'
    if (!isTimedCardio(item.exercise) && !integer(item.restSeconds, 0, 86400)) issues[`${item.id}:rest`] = 'Recupero in secondi, anche 0.'
  }
  return issues
}

export function weeklySummary(days: Pick<WorkoutDay, 'label' | 'title'>[]): { code: string; name: string; title: string | null }[] {
  return weekdays.map((weekday, index) => ({ code: weekday.code, name: weekday.name, title: days.find(day => weekdayIndex(day.label) === index)?.title ?? null }))
}
