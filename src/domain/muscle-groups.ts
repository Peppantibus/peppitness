/** Gruppo principale: metadato organizzativo, estraneo all'identità di confronto. */
export const muscleGroups = ['Petto', 'Schiena', 'Spalle', 'Bicipiti', 'Tricipiti', 'Gambe', 'Glutei', 'Polpacci', 'Addome', 'Full body', 'Cardio'] as const
export type MuscleGroup = typeof muscleGroups[number]
export type MuscleGroupFilter = MuscleGroup | 'all' | 'unclassified'
export const unclassifiedLabel = 'Da classificare'
export const isMuscleGroup = (value: unknown): value is MuscleGroup => typeof value === 'string' && (muscleGroups as readonly string[]).includes(value)

// Regole ordinate, anche in SQL nella migrazione 20261002120000. Nomi generici
// come «press», «dip» o «distensioni» restano da classificare nel catalogo.
export const muscleGroupRules: readonly { group: MuscleGroup; pattern: string }[] = [
  { group: 'Spalle', pattern: '^(reverse pec deck|face pull|military press|shoulder press|overhead press|arnold press|alzate laterali|alzate posteriori|alzate frontali|lento avanti|lento con|scrollate)( |$)' },
  { group: 'Tricipiti', pattern: '^(pushdown|push down|triceps|tricipiti|estensioni tricipiti|french press|skull crusher|panca presa stretta)( |$)' },
  { group: 'Tricipiti', pattern: '^dip.* tricipiti( |$)' },
  { group: 'Petto', pattern: '^dip.* petto( |$)' },
  { group: 'Gambe', pattern: '^(leg curl|leg extension|squat|front squat|back squat|goblet squat|hack squat|pressa|leg press|affondi|split squat|bulgarian split squat|step up|stacco|deadlift|romanian deadlift|adduzioni)( |$)' },
  { group: 'Glutei', pattern: '^(hip thrust|glute bridge|ponte glutei|abduzioni|glute kickback|slanci glutei)( |$)' },
  { group: 'Polpacci', pattern: '^(calf|polpacci|sollevamento polpacci)( |$)' },
  { group: 'Schiena', pattern: '^(trazioni|pull up|pullup|chin up|lat machine|lat pulldown|rematore|row|seated row|pulley|high row|low row|pulldown|iperestensioni)( |$)' },
  { group: 'Petto', pattern: '^(panca piana|panca inclinata|panca declinata|bench press|chest press|croci|pec deck|pectoral|piegamenti sulle braccia|push up|pushup)( |$)' },
  { group: 'Bicipiti', pattern: '^(curl|biceps|bicipiti)( |$)' },
  { group: 'Addome', pattern: '^(crunch|plank|pallof press|dead bug|sit up|ab wheel|sollevamento gambe|sollevamento ginocchia)( |$)' },
  { group: 'Full body', pattern: '^(farmer|farmers|carry|suitcase carry|burpee|thruster)( |$)' },
  { group: 'Cardio', pattern: '^(camminata|tapis roulant|treadmill|cyclette|bici|bicicletta|vogatore|rowing machine|ellittica|corsa|cardio|air bike|assault bike)( |$)' },
]
export function inferMuscleGroup(name: string, variant = ''): MuscleGroup | null {
  const text = `${name} ${variant}`.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return muscleGroupRules.find(rule => new RegExp(rule.pattern).test(text))?.group ?? null
}
/** undefined indica uno snapshot precedente; null è una scelta esplicita dell'utente. */
export function exerciseMuscleGroup(value: { name: string; variant?: string; comparison?: { variant?: string }; muscleGroup?: MuscleGroup | null }): MuscleGroup | null {
  return value.muscleGroup === undefined ? inferMuscleGroup(value.name, value.variant ?? value.comparison?.variant) : value.muscleGroup
}
export const muscleGroupLabel = (value: Parameters<typeof exerciseMuscleGroup>[0]) => exerciseMuscleGroup(value) ?? unclassifiedLabel
export function groupExercises<T extends { name: string; variant?: string; muscleGroup?: MuscleGroup | null }>(rows: readonly T[]): { group: MuscleGroup | null; label: string; rows: T[] }[] {
  return [...muscleGroups, null].map(group => ({ group, label: group ?? unclassifiedLabel, rows: rows.filter(row => exerciseMuscleGroup(row) === group) })).filter(group => group.rows.length > 0)
}
