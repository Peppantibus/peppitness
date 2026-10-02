import { isExerciseId } from './exercises.ts'
import { exerciseMuscleGroup } from './muscle-groups.ts'
import type { CatalogExercise, ExerciseValues } from './exercises.ts'
import { parseNonNegativeNumber } from './validation.ts'

export type ProgramExercise = Omit<ExerciseValues, 'archivedAt'> & { id: string }
export interface PrescriptionDraft {
  id: string; exercise: ProgramExercise; sets: string; optionalSets: string
  repsMin: string; repsMax: string; durationSeconds: string; restSeconds: string
  rir: string; rpe: string; note: string
}
export interface ProgramDay { id: string; label: string; title: string; note: string; exercises: PrescriptionDraft[] }
export interface ProgramDocument { planId: string; id: string; title: string; guidance: string; days: ProgramDay[] }
/** Ciclo: primo giorno e durata in settimane; la settimana tipo si ripete per tutto il ciclo. */
export interface ProgramCycle { start: string; weeks: number }
export interface ProgramRoot { id: string; name: string; revision: number; activeVersionId: string | null; archivedAt: string | null; cycle?: ProgramCycle | null; updatedAt?: string | null }
export interface ProgramVersion { id: string; planId: string; title: string; guidance: string; number: number; revision: number; status: 'draft' | 'published'; updatedAt?: string | null; publishedAt?: string | null }
export interface ProgramIndex { plan: ProgramRoot; versions: ProgramVersion[] }
export interface SavedProgram { plan: ProgramRoot; version: ProgramVersion; document: ProgramDocument }

const uuid = () => crypto.randomUUID()
export function newProgram(): ProgramDocument { return { planId: uuid(), id: uuid(), title: '', guidance: '', days: [] } }
export function nextDayLabel(days: ProgramDay[]) {
  let index = days.length + 1
  while (days.some(day => day.label === String(index))) index++
  return String(index)
}
export function newDay(days: ProgramDay[]): ProgramDay {
  const label = nextDayLabel(days)
  return { id: uuid(), label, title: `Seduta ${label}`, note: '', exercises: [] }
}
export function newPrescription(exercise: CatalogExercise): PrescriptionDraft {
  return { id: uuid(), exercise: { ...exercise }, sets: '', optionalSets: '0', repsMin: '', repsMax: '', durationSeconds: '', restSeconds: '0', rir: '', rpe: '', note: '' }
}
export function duplicateDay(day: ProgramDay, days: ProgramDay[]): ProgramDay {
  return { ...structuredClone(day), id: uuid(), label: nextDayLabel(days), exercises: day.exercises.map(item => ({ ...structuredClone(item), id: uuid() })) }
}
export function forkProgram(document: ProgramDocument): ProgramDocument {
  return { ...structuredClone(document), id: uuid(), days: document.days.map(day => ({ ...structuredClone(day), id: uuid(), exercises: day.exercises.map(item => ({ ...structuredClone(item), id: uuid() })) })) }
}
/** Un nuovo ciclo conserva la settimana tipo, ma ha identità e storico propri. */
export function copyProgram(document: ProgramDocument): ProgramDocument {
  return { ...forkProgram(document), planId: uuid() }
}
export function moveItem<T>(items: T[], index: number, direction: -1 | 1): T[] {
  const next = index + direction
  if (index < 0 || next < 0 || index >= items.length || next >= items.length) return items
  const result = [...items]; [result[index], result[next]] = [result[next]!, result[index]!]; return result
}

function bounded(value: string, label: string, min: number, max: number, integer = true, optional = false) {
  const number = parseNonNegativeNumber(value)
  if (number === null && optional) return null
  if (number === null || number < min || number > max || (integer && !Number.isInteger(number))) throw new Error(`${label}: inserisci ${integer ? 'un intero' : 'un numero'} da ${min} a ${max}.`)
  return number
}
function text(value: string, label: string, max: number, required = false) {
  if ((required && !value.trim()) || [...value].length > max || value.includes('\0')) throw new Error(`${label}: ${required ? 'inserisci un testo, ' : ''}massimo ${max} caratteri.`)
}

/** Unico documento inviato alla RPC: esclude nomi/snapshot, generati dal server. */
export function programPayload(document: ProgramDocument) {
  text(document.title, 'Titolo', 160, true); text(document.guidance, 'Istruzioni', 16000)
  if (!isExerciseId(document.id) || !isExerciseId(document.planId)) throw new Error('Riferimento del programma non valido.')
  if (document.days.length > 50) throw new Error('Sono consentite al massimo 50 sedute per versione.')
  const ids = new Set<string>(), labels = new Set<string>()
  const checkId = (id: string) => { if (!isExerciseId(id) || ids.has(id)) throw new Error('Riferimenti duplicati o non validi nella bozza.'); ids.add(id) }
  return {
    p_plan_id: document.planId, p_version_id: document.id, p_title: document.title.trim(), p_guidance: document.guidance,
    p_days: document.days.map((day, index) => {
      checkId(day.id); text(day.label, `Etichetta seduta ${index + 1}`, 40, true); text(day.title, `Nome seduta ${index + 1}`, 160, true); text(day.note, 'Note seduta', 4000)
      const label = day.label.trim()
      if (labels.has(label)) throw new Error('Ogni seduta deve avere un’etichetta diversa.')
      labels.add(label)
      if (day.exercises.length > 200) throw new Error('Sono consentiti al massimo 200 esercizi per seduta.')
      return { id: day.id, label, title: day.title.trim(), note: day.note, exercises: day.exercises.map(item => {
        checkId(item.id); text(item.note, 'Note esercizio', 4000)
        if (!isExerciseId(item.exercise.id) || !['reps', 'seconds'].includes(item.exercise.measurementMode)) throw new Error('Seleziona un esercizio valido dal catalogo.')
        const reps = item.exercise.measurementMode === 'reps'
        if ((reps && item.durationSeconds.trim()) || (!reps && (item.repsMin.trim() || item.repsMax.trim()))) throw new Error('Usa ripetizioni oppure durata, secondo l’esercizio.')
        const repsMin = reps ? bounded(item.repsMin, 'Ripetizioni minime', 1, 10000) : null
        const repsMax = reps ? bounded(item.repsMax, 'Ripetizioni massime', 1, 10000) : null
        if (repsMin !== null && repsMax !== null && repsMin > repsMax) throw new Error('Le ripetizioni minime non possono superare le massime.')
        return { id: item.id, exercise_id: item.exercise.id, sets: bounded(item.sets, 'Serie', 1, 1000), optional_sets: bounded(item.optionalSets, 'Serie facoltative', 0, 1000),
          reps_min: repsMin, reps_max: repsMax, duration_seconds: reps ? null : bounded(item.durationSeconds, 'Durata in secondi', 1, 86400),
          rest_seconds: bounded(item.restSeconds, 'Recupero in secondi', 0, 86400), rir: bounded(item.rir, 'RIR', 0, 10, false, true), rpe: bounded(item.rpe, 'RPE', 1, 10, false, true), note: item.note }
      }) }
    }),
  }
}
export function validateProgram(document: ProgramDocument, publish = false): string | null {
  try {
    programPayload(document)
    if (publish && (!document.days.length || document.days.some(day => !day.exercises.length))) return 'Per pubblicare, aggiungi almeno una seduta e un esercizio in ogni seduta.'
    return null
  } catch (error) { return error instanceof Error ? error.message : 'Controlla i campi della bozza.' }
}
/** Contenuto confrontabile di una versione: istruzioni, giorni e prescrizioni senza ID (come il database). */
function contentKey(document: ProgramDocument) {
  const payload = programPayload(document)
  return JSON.stringify({ guidance: payload.p_guidance, days: payload.p_days.map(({ id: _day, exercises, ...day }) => ({ ...day, exercises: exercises.map(({ id: _item, ...item }) => item) })) })
}
export function sameContent(a: ProgramDocument, b: ProgramDocument): boolean {
  try { return contentKey(a) === contentKey(b) } catch { return false }
}
export function sameCycle(a: ProgramCycle | null | undefined, b: ProgramCycle | null | undefined): boolean {
  return (a?.start ?? null) === (b?.start ?? null) && (a?.weeks ?? null) === (b?.weeks ?? null)
}
export function sameProgram(a: ProgramDocument, b: ProgramDocument): boolean {
  // I testi del catalogo possono aggiornarsi al salvataggio dello snapshot.
  // Non fanno parte della scrittura richiesta. Ordine e ID dei figli invece sì.
  try { return JSON.stringify(programPayload(a)) === JSON.stringify(programPayload(b)) }
  catch { return false }
}

/** Categoria corrente del catalogo per gli editor e la scheda; prescrizioni e storico invariati. */
export function withCatalogMuscleGroups(document: ProgramDocument, catalog: readonly CatalogExercise[]): ProgramDocument {
  const rows = new Map(catalog.map(row => [row.id, row]))
  return { ...document, days: document.days.map(day => ({ ...day, exercises: day.exercises.map(item => {
    const current = rows.get(item.exercise.id)
    return current ? { ...item, exercise: { ...item.exercise, muscleGroup: exerciseMuscleGroup(current) } } : item
  }) })) }
}
