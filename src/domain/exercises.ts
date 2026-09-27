export interface ExerciseValues {
  name: string
  variant: string
  equipment: string
  loadConvention: 'total' | 'single-dumbbell' | 'bodyweight'
  loadUnit: 'kg' | 'lb'
  measurementMode: 'reps' | 'seconds'
  perSide: boolean
  note: string
  archivedAt: string | null
}

export interface CatalogExercise extends ExerciseValues { id: string; revision: number; sourceTemplateId?: string | null }
export const loadLabels = { total: 'Carico totale', 'single-dumbbell': 'Peso di un manubrio', bodyweight: 'Corpo libero' }
export const modeLabels = { reps: 'Ripetizioni', seconds: 'Secondi' }
export const isExerciseId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

export function emptyExercise(): ExerciseValues {
  return { name: '', variant: '', equipment: '', loadConvention: 'total', loadUnit: 'kg', measurementMode: 'reps', perSide: false, note: '', archivedAt: null }
}

export function validateExercise(value: ExerciseValues): string | null {
  // PostgreSQL conta i caratteri Unicode, non le unità UTF-16.
  if (!value.name.trim() || value.name !== value.name.trim() || [...value.name].length > 120) return 'Inserisci un nome da 1 a 120 caratteri.'
  if ([...value.variant].length > 120 || [...value.equipment].length > 120) return 'Variante e attrezzo possono contenere al massimo 120 caratteri.'
  if ([...value.note].length > 4000) return 'La nota può contenere al massimo 4000 caratteri.'
  if (!Object.hasOwn(loadLabels, value.loadConvention) || !['kg', 'lb'].includes(value.loadUnit)
    || !Object.hasOwn(modeLabels, value.measurementMode) || typeof value.perSide !== 'boolean') return 'Controlla modalità e unità dell’esercizio.'
  if (value.archivedAt !== null && !Number.isFinite(Date.parse(value.archivedAt))) return 'Data di archiviazione non valida.'
  if ([value.name, value.variant, value.equipment, value.note].some(text => text.includes('\0'))) return 'Rimuovi i caratteri non validi dal testo.'
  return null
}

export function sameExerciseIdentity(a: ExerciseValues, b: ExerciseValues) {
  return a.variant === b.variant && a.equipment === b.equipment && a.loadConvention === b.loadConvention
    && a.loadUnit === b.loadUnit && a.measurementMode === b.measurementMode && a.perSide === b.perSide
}

export function sameExercise(a: ExerciseValues, b: ExerciseValues) {
  const sameArchive = a.archivedAt === b.archivedAt || (a.archivedAt !== null && b.archivedAt !== null && Date.parse(a.archivedAt) === Date.parse(b.archivedAt))
  return sameExerciseIdentity(a, b) && a.name === b.name && a.note === b.note && sameArchive
}

export function searchExercises(rows: CatalogExercise[], search: string, filter: 'active' | 'archived' | 'all') {
  const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('it')
  const words = normalize(search).trim().split(/\s+/).filter(Boolean)
  return rows.filter(row => (filter === 'all' || Boolean(row.archivedAt) === (filter === 'archived'))
    && words.every(word => normalize(`${row.name} ${row.variant} ${row.equipment}`).includes(word)))
    .sort((a, b) => a.name.localeCompare(b.name, 'it') || a.id.localeCompare(b.id))
}
