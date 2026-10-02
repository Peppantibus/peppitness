import type { SupabaseClient } from '@supabase/supabase-js'
import { isMealEnergy } from '../domain/food-energy.ts'
import { dayFromSnapshot, emptyDiary, formatDecimal, mealLogKey, totalSets } from '../domain/diary.ts'
import type { DiaryData, SessionSnapshot, SnapshotExercise } from '../domain/diary.ts'
import { isExerciseId } from '../domain/exercises.ts'
import { isMuscleGroup } from '../domain/muscle-groups.ts'
import { isLocalDate } from '../domain/dates.ts'
import type { DayType, Meal, MealStatus, SetResult, WorkoutSession } from '../domain/types.ts'

export type DiaryTable = 'workout_set_logs' | 'meal_logs' | 'diary_days' | 'workout_sessions'
export type RowKey = Record<string, string | number>
export type Row = Record<string, unknown>

/** Contratto minimo verso Supabase; sostituibile nei test. Nessun retry automatico. */
export interface DiaryTransport {
  loadAll(signal: AbortSignal): Promise<{ data: DiaryData; revisions: Record<string, number> }>
  start(args: { sessionId: string; versionId: string; dayId: string; date: string; timeZone: string }, signal: AbortSignal): Promise<Row>
  insert(table: DiaryTable, values: Row, signal: AbortSignal): Promise<Row>
  update(table: DiaryTable, key: RowKey, values: Row, revision: number, signal: AbortSignal): Promise<Row | null>
  fetch(table: DiaryTable, key: RowKey, signal: AbortSignal): Promise<Row | null>
  discard(sessionId: string, signal: AbortSignal): Promise<boolean>
}

export class DiaryFailure extends Error {
  /** conflict: revisione/unicità; rejected: dato respinto in modo definitivo; unavailable: rete o servizio. */
  readonly kind: 'conflict' | 'rejected' | 'unavailable' | 'session'
  constructor(kind: DiaryFailure['kind']) { super(kind); this.kind = kind }
}

const bad = (): never => { throw new DiaryFailure('unavailable') }
function record(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : bad() }
function string(value: unknown): string { return typeof value === 'string' ? value : bad() }
function id(value: unknown): string { const key = string(value); return isExerciseId(key) ? key : bad() }
function revision(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : bad() }
function date(value: unknown): string { const key = string(value); return isLocalDate(key) ? key : bad() }
function nullableNumber(value: unknown): number | null {
  if (value === null) return null
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && number >= 0 ? number : bad()
}
function timestamp(value: unknown): string { const key = string(value); return Number.isFinite(Date.parse(key)) ? key : bad() }
const dayTypes = ['training', 'rest'], statuses = ['unrecorded', 'followed', 'modified', 'skipped']

function snapshotExercise(value: unknown): SnapshotExercise {
  const row = record(value)
  if (row.muscle_group !== undefined && row.muscle_group !== null && !isMuscleGroup(row.muscle_group)) bad()
  const result = {
    ...(row.muscle_group === undefined ? {} : { muscle_group: row.muscle_group }),
    id: id(row.id), exercise_id: id(row.exercise_id), name: string(row.name), variant: string(row.variant), equipment: string(row.equipment),
    load_convention: string(row.load_convention), load_unit: string(row.load_unit), per_side: row.per_side, exercise_note: string(row.exercise_note ?? ''),
    mode: string(row.mode), sets: nullableNumber(row.sets), optional_sets: nullableNumber(row.optional_sets), reps_min: nullableNumber(row.reps_min),
    reps_max: nullableNumber(row.reps_max), duration_seconds: nullableNumber(row.duration_seconds), rest_seconds: nullableNumber(row.rest_seconds),
    rir: nullableNumber(row.rir), rpe: nullableNumber(row.rpe), note: string(row.note),
  }
  if (!['total', 'single-dumbbell', 'bodyweight'].includes(result.load_convention) || !['kg', 'lb'].includes(result.load_unit)
    || typeof result.per_side !== 'boolean' || !['reps', 'seconds'].includes(result.mode) || !result.sets || result.optional_sets === null || result.rest_seconds === null
    || (result.mode === 'reps' ? result.reps_min === null || result.reps_max === null : result.duration_seconds === null)) bad()
  return result as SnapshotExercise
}

export function sessionFromRow(value: unknown): { session: WorkoutSession; revision: number } {
  const row = record(value), snapshot = record(row.day_snapshot)
  if (!['active', 'completed'].includes(string(row.status))) bad()
  const parsed: SessionSnapshot = { label: string(snapshot.label), title: string(snapshot.title), note: string(snapshot.note), plan_title: string(snapshot.plan_title),
    version_number: nullableNumber(snapshot.version_number) ?? 0, exercises: Array.isArray(snapshot.exercises) ? snapshot.exercises.map(snapshotExercise) : bad() }
  const day = dayFromSnapshot(id(row.day_id), parsed)
  const results = Object.fromEntries(day.exercises.map(exercise => [exercise.id, Array.from({ length: totalSets(exercise) }, (): SetResult => ({ load: '', amount: '', completed: false }))]))
  const session: WorkoutSession = { id: id(row.id), planId: id(row.plan_id), date: date(row.diary_date), day, startedAt: timestamp(row.started_at), results,
    ...(row.status === 'completed' ? { completedAt: timestamp(row.completed_at) } : {}) }
  return { session, revision: revision(row.revision) }
}

export function setFromRow(value: unknown) {
  const row = record(value)
  const index = row.set_index
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || typeof row.completed !== 'boolean') bad()
  return { sessionId: id(row.session_id), prescriptionId: id(row.prescription_id), index: index as number, revision: revision(row.revision),
    result: { load: formatDecimal(nullableNumber(row.load)), amount: formatDecimal(nullableNumber(row.amount)), completed: row.completed as boolean } satisfies SetResult }
}

export function mealLogFromRow(value: unknown) {
  const row = record(value), snapshot = record(row.meal_snapshot)
  if (!statuses.includes(string(row.status)) || !dayTypes.includes(string(row.day_type))) bad()
  const texts = (items: unknown) => Array.isArray(items) && items.every(item => typeof item === 'string') ? items as string[] : bad()
  const meal: Meal = { id: id(snapshot.id), name: string(snapshot.name), timeLabel: string(snapshot.timeLabel ?? ''), description: string(snapshot.description ?? ''),
    items: texts(snapshot.items ?? []), alternative: string(snapshot.alternative ?? ''), alternatives: texts(snapshot.alternatives ?? []), additions: texts(snapshot.additions ?? []), note: string(snapshot.note ?? '') }
  if (meal.id !== row.meal_id) bad()
  if (snapshot.energy !== undefined) {
    if (!isMealEnergy(snapshot.energy)) bad()
    meal.energy = snapshot.energy as NonNullable<Meal['energy']>
  }
  if (snapshot.energyOverrides !== undefined) {
    const overrides = snapshot.energyOverrides
    if (!Array.isArray(overrides) || overrides.length !== meal.items.length || overrides.some(v => v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000))) bad()
    meal.energyOverrides = overrides as (number | null)[]
  }
  return { date: date(row.diary_date), revision: revision(row.revision), planId: id(row.meal_plan_id),
    log: { date: date(row.diary_date), mealId: meal.id, status: row.status as MealStatus, note: string(row.note), dayType: row.day_type as DayType, snapshot: meal } }
}

export function dayFromRow(value: unknown) {
  const row = record(value)
  if (!dayTypes.includes(string(row.day_type))) bad()
  return { date: date(row.diary_date), dayType: row.day_type as DayType, revision: revision(row.revision) }
}

/** Ricostruisce la vista confermata dal server e le revisioni lette per ogni riga. */
export function buildDiary(sessions: unknown[], sets: unknown[], meals: unknown[], days: unknown[]) {
  const data = emptyDiary(), revisions: Record<string, number> = {}
  for (const raw of sessions) { const { session, revision } = sessionFromRow(raw); data.sessions.push(session); revisions[`session:${session.id}`] = revision }
  for (const raw of sets) {
    const set = setFromRow(raw), session = data.sessions.find(item => item.id === set.sessionId)
    const results = session?.results[set.prescriptionId]
    if (!results || set.index >= results.length) bad()
    results![set.index] = set.result
    revisions[`set:${set.sessionId}:${set.prescriptionId}:${set.index}`] = set.revision
  }
  for (const raw of meals) { const meal = mealLogFromRow(raw); data.mealLogs[mealLogKey(meal.date, meal.log.mealId)] = meal.log; revisions[`meal:${meal.date}:${meal.log.mealId}`] = meal.revision }
  for (const raw of days) { const day = dayFromRow(raw); data.dayTypes[day.date] = day.dayType; revisions[`day:${day.date}`] = day.revision }
  data.sessions.sort((a, b) => a.date.localeCompare(b.date) || a.startedAt.localeCompare(b.startedAt))
  return { data, revisions }
}

const columns: Record<DiaryTable, string> = {
  workout_sessions: 'id,owner_id,plan_id,version_id,day_id,diary_date,time_zone,day_snapshot,status,started_at,completed_at,revision',
  workout_set_logs: 'id,owner_id,session_id,prescription_id,set_index,load,amount,completed,revision',
  meal_logs: 'id,owner_id,diary_date,meal_id,meal_plan_id,status,note,day_type,meal_snapshot,revision',
  diary_days: 'owner_id,diary_date,day_type,revision',
}

export function createDiaryTransport(client: SupabaseClient, owner: string): DiaryTransport {
  async function token(signal: AbortSignal) {
    const { data, error } = await client.auth.getSession()
    signal.throwIfAborted()
    // Token catturato per operazione: un cambio account non invia dati A con la sessione B.
    if (error || data.session?.user.id !== owner) throw new DiaryFailure('session')
    return data.session.access_token
  }
  function failure(error: { code?: string }) {
    const code = error.code ?? ''
    return new DiaryFailure(['PT409', '23505'].includes(code) ? 'conflict'
      : ['23514', '22023', '22P02', '23503', '42501', '55000', '22003'].includes(code) ? 'rejected' : 'unavailable')
  }
  function owned(value: unknown): Row { const row = record(value); if (row.owner_id !== owner) bad(); return row }
  async function pages(table: DiaryTable, order: string, signal: AbortSignal) {
    const auth = await token(signal), rows: Row[] = []
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await client.from(table).select(columns[table]).eq('owner_id', owner).order(order).range(offset, offset + 499)
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false)
      signal.throwIfAborted()
      if (error) throw failure(error)
      if (!Array.isArray(data)) bad()
      rows.push(...(data as unknown[]).map(owned))
      if ((data as unknown[]).length < 500) return rows
    }
  }
  return {
    async loadAll(signal) {
      // Ordine per chiave stabile; le serie seguono le sedute già lette nella stessa sequenza.
      const sessions = await pages('workout_sessions', 'id', signal)
      const sets = await pages('workout_set_logs', 'id', signal)
      const meals = await pages('meal_logs', 'id', signal)
      const days = await pages('diary_days', 'diary_date', signal)
      // Una seduta creata fra le due letture può avere serie non ancora abbinate: si rilegge.
      const known = new Set(sessions.map(row => row.id))
      if (sets.some(row => !known.has(row.session_id))) throw new DiaryFailure('unavailable')
      return buildDiary(sessions, sets, meals, days)
    },
    async start(args, signal) {
      const auth = await token(signal)
      const { data, error } = await client.rpc('start_workout_session', { p_session_id: args.sessionId, p_version_id: args.versionId, p_day_id: args.dayId, p_diary_date: args.date, p_time_zone: args.timeZone })
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false)
      if (error) throw failure(error)
      const row = owned(Array.isArray(data) && data.length === 1 ? data[0] : data)
      if (row.id !== args.sessionId) bad()
      return row
    },
    async insert(table, values, signal) {
      const auth = await token(signal)
      const { data, error } = await client.from(table).insert(values).select(columns[table]).setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false).single()
      if (error) throw failure(error)
      return owned(data)
    },
    async update(table, key, values, next, signal) {
      const auth = await token(signal)
      const { data, error } = await client.from(table).update({ ...values, revision: next }).eq('owner_id', owner).match(key).select(columns[table])
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      return data === null ? null : owned(data)
    },
    async fetch(table, key, signal) {
      const auth = await token(signal)
      const { data, error } = await client.from(table).select(columns[table]).eq('owner_id', owner).match(key).setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      return data === null ? null : owned(data)
    },
    async discard(sessionId, signal) {
      const auth = await token(signal)
      const { data, error } = await client.from('workout_sessions').delete().eq('owner_id', owner).eq('id', sessionId).eq('status', 'active').select('id')
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false)
      if (error) throw failure(error)
      return Array.isArray(data) && data.length === 1
    },
  }
}
