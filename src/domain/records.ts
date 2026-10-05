import type { ExercisePrescription, LocalDate, SetResult, WorkoutDay, WorkoutSession } from './types.ts'
import { parseNonNegativeNumber } from './validation.ts'
import { comparable } from './workout.ts'

/**
 * Record personali e riepilogo della seduta, dalle sole serie completate.
 * Una serie batte un'altra se ha più carico, oppure lo stesso carico e più ripetizioni (o secondi);
 * senza carico conta solo la quantità. Valgono le stesse regole di confronto del «precedente»
 * (`comparable`): esercizi senza dati di confronto non hanno record.
 */
export interface SetScore { load: number; amount: number }

const number = (value: string) => { try { return parseNonNegativeNumber(value) } catch { return null } }

export function setScore(set: SetResult | undefined): SetScore | null {
  if (!set?.completed) return null
  const amount = number(set.amount)
  if (amount === null || amount <= 0) return null
  return { load: number(set.load) ?? 0, amount }
}

export function beats(a: SetScore, b: SetScore): boolean {
  return a.load > b.load || (a.load === b.load && a.amount > b.amount)
}

const before = (session: WorkoutSession, ref: Pick<WorkoutSession, 'id' | 'date' | 'startedAt'>) => session.id !== ref.id && Boolean(session.completedAt)
  && (session.date < ref.date || (session.date === ref.date && session.startedAt < ref.startedAt))

/** Miglior serie fra le sedute completate precedenti, per esercizi confrontabili. */
export function bestBefore(sessions: WorkoutSession[], exercise: ExercisePrescription, ref: Pick<WorkoutSession, 'id' | 'date' | 'startedAt'>): SetScore | null {
  let best: SetScore | null = null
  for (const session of sessions) {
    if (!before(session, ref)) continue
    for (const item of session.day.exercises) {
      if (!comparable(exercise, item)) continue
      for (const set of session.results[item.id] ?? []) {
        const score = setScore(set)
        if (score && (!best || beats(score, best))) best = score
      }
    }
  }
  return best
}

/**
 * Serie da segnare come «Nuovo record», per prescrizione: al massimo una per esercizio (la migliore
 * della seduta, la prima a pari merito), solo se esiste già un precedente e lo supera.
 */
export function sessionRecords(session: WorkoutSession, sessions: WorkoutSession[]): Map<string, number> {
  const records = new Map<string, number>()
  for (const exercise of session.day.exercises) {
    if (!exercise.comparison) continue
    const previous = bestBefore(sessions, exercise, session)
    if (!previous) continue
    const results = session.results[exercise.id] ?? []
    let index = -1, best: SetScore | null = null
    for (let i = 0; i < results.length; i++) {
      const score = setScore(results[i])
      if (score && (!best || beats(score, best))) { best = score; index = i }
    }
    if (best && beats(best, previous)) records.set(exercise.id, index)
  }
  return records
}

export interface PersonalRecord { exercise: ExercisePrescription; score: SetScore; date: LocalDate }

/** Miglior serie di sempre per ogni esercizio del programma (la prima volta che è stata raggiunta). */
export function personalRecords(days: WorkoutDay[], sessions: WorkoutSession[]): PersonalRecord[] {
  const exercises: ExercisePrescription[] = []
  for (const day of days) for (const exercise of day.exercises) if (exercise.comparison && !exercises.some(item => comparable(item, exercise))) exercises.push(exercise)
  const completed = sessions.filter(session => session.completedAt)
    .sort((a, b) => a.date.localeCompare(b.date) || a.startedAt.localeCompare(b.startedAt))
  return exercises.flatMap(exercise => {
    let record: PersonalRecord | null = null
    for (const session of completed) for (const item of session.day.exercises) {
      if (!comparable(exercise, item)) continue
      for (const set of session.results[item.id] ?? []) {
        const score = setScore(set)
        if (score && (!record || beats(score, record.score))) record = { exercise, score, date: session.date }
      }
    }
    return record ? [record] : []
  })
}

export interface SessionSummary {
  /** Minuti fra inizio e fine; null se mancano gli orari o la seduta è rimasta aperta oltre 5 ore. */
  minutes: number | null
  sets: number
  requiredSets: number
  /** Volume in kg (carico × ripetizioni) degli esercizi a ripetizioni con carico in kg. */
  volume: number
  records: { exercise: ExercisePrescription; index: number; score: SetScore }[]
  previous: { date: LocalDate; volume: number; sets: number } | null
}

function volumeOf(session: WorkoutSession): { volume: number; sets: number } {
  let volume = 0, sets = 0
  for (const exercise of session.day.exercises) for (const set of session.results[exercise.id] ?? []) {
    const score = setScore(set)
    if (!score) continue
    sets++
    if (exercise.mode === 'reps' && (exercise.loadUnit ?? 'kg') === 'kg') volume += score.load * score.amount
  }
  return { volume: Math.round(volume * 10) / 10, sets }
}

export function sessionSummary(session: WorkoutSession, sessions: WorkoutSession[]): SessionSummary {
  const start = Date.parse(session.startedAt), end = session.completedAt ? Date.parse(session.completedAt) : NaN
  const minutes = Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 5 * 3_600_000 ? Math.max(1, Math.round((end - start) / 60_000)) : null
  const { volume, sets } = volumeOf(session)
  const requiredSets = session.day.exercises.reduce((sum, exercise) => sum + exercise.sets, 0)
  const recordMap = sessionRecords(session, sessions)
  const records = session.day.exercises.flatMap(exercise => {
    const index = recordMap.get(exercise.id)
    const score = index === undefined ? null : setScore(session.results[exercise.id]?.[index])
    return index !== undefined && score ? [{ exercise, index, score }] : []
  })
  // Confronto con l'ultima volta della stessa seduta del programma (stesso giorno o etichetta).
  const last = sessions.filter(other => before(other, session) && (other.day.id === session.day.id || other.day.label === session.day.label))
    .sort((a, b) => b.date.localeCompare(a.date) || b.startedAt.localeCompare(a.startedAt))[0]
  return { minutes, sets, requiredSets, volume, records, previous: last ? { date: last.date, ...volumeOf(last) } : null }
}
