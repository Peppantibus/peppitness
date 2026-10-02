import type { SupabaseClient } from '@supabase/supabase-js'
import { isExerciseId, validateExercise } from '../domain/exercises.ts'
import { isMuscleGroup } from '../domain/muscle-groups.ts'
import { programPayload, validateProgram } from '../domain/programs.ts'
import type { ProgramCycle, ProgramDocument, ProgramRoot, ProgramVersion, ProgramIndex, SavedProgram, ProgramDay, PrescriptionDraft, ProgramExercise } from '../domain/programs.ts'

/** Esito deciso dal database per una modifica a partire da una versione pubblicata. */
export type RevisionOutcome = 'unchanged' | 'metadata' | 'updated' | 'created'
export interface RevisionInput { base: SavedProgram; document: ProgramDocument; cycle: ProgramCycle | null; newVersionId: string }
export interface RevisionResult { outcome: RevisionOutcome; versionId: string; planRevision: number }
export interface ProgramsRepository {
  list(signal: AbortSignal): Promise<ProgramIndex[]>
  get(versionId: string, signal: AbortSignal): Promise<SavedProgram | null>
  save(document: ProgramDocument, revision: number, signal: AbortSignal): Promise<void>
  publish(saved: SavedProgram, signal: AbortSignal): Promise<void>
  activate(saved: SavedProgram, signal: AbortSignal): Promise<void>
  /** Modifica di un programma pubblicato: il database sceglie tra nessuna modifica, nome/ciclo, stessa versione o vN+1. */
  revise(input: RevisionInput, signal: AbortSignal): Promise<RevisionResult>
  /** Inizio e durata del ciclo, con revisione letta + 1 del programma. */
  setCycle(plan: ProgramRoot, cycle: ProgramCycle | null, signal: AbortSignal): Promise<ProgramRoot>
  deletePlans(planId: string | null, signal: AbortSignal): Promise<number>
}
export class ProgramsFailure extends Error {
  readonly kind: 'conflict' | 'unavailable' | 'session' | 'invalid'
  constructor(kind: ProgramsFailure['kind']) { super(kind); this.kind = kind }
}
type Row = Record<string, unknown>
const fail = () => { throw new ProgramsFailure('unavailable') }
function record(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : fail() }
function string(value: unknown): string { return typeof value === 'string' ? value : fail() }
function id(value: unknown): string { const key = string(value); return isExerciseId(key) ? key : fail() }
function positive(value: unknown): number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fail() }
function nullableId(value: unknown) { return value === null ? null : id(value) }
function numericInput(value: unknown) { return value === null ? '' : typeof value === 'number' && Number.isFinite(value) ? String(value) : fail() }
function timestamp(value: unknown) { return value === null ? null : typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fail() }
/** Date informative (cronologia): assenti nelle risposte parziali, mai inventate. */
function optionalTimestamp(value: unknown) { return value === undefined ? null : timestamp(value) }
function owned(value: unknown, owner: string) { const row = record(value); if (row.owner_id !== owner) fail(); id(row.id); return row }
function root(row: Row): ProgramRoot {
  const start = row.cycle_start ?? null, weeks = row.cycle_weeks ?? null
  const cycle = start === null && weeks === null ? null
    : typeof start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(start) && typeof weeks === 'number' && Number.isInteger(weeks) && weeks >= 1 && weeks <= 52 ? { start, weeks } : fail()
  const result = { id: id(row.id), name: string(row.name), revision: positive(row.revision), activeVersionId: nullableId(row.active_version_id), archivedAt: timestamp(row.archived_at), cycle, updatedAt: optionalTimestamp(row.updated_at) }
  if (!result.name.trim() || [...result.name].length > 160) fail()
  return result
}
function version(row: Row): ProgramVersion {
  if (!['draft', 'published'].includes(string(row.status))) fail()
  if (!string(row.title).trim() || [...string(row.title)].length > 160 || [...string(row.guidance)].length > 16000) fail()
  return { id: id(row.id), planId: id(row.plan_id), title: string(row.title), guidance: string(row.guidance), number: positive(row.version_number), revision: positive(row.revision), status: row.status as ProgramVersion['status'],
    updatedAt: optionalTimestamp(row.updated_at), publishedAt: optionalTimestamp(row.published_at) }
}
function snapshot(value: unknown): ProgramExercise {
  const row = record(value)
  if (row.muscle_group !== undefined && row.muscle_group !== null && !isMuscleGroup(row.muscle_group)) fail()
  const result: ProgramExercise = { ...(row.muscle_group === undefined ? {} : { muscleGroup: row.muscle_group as ProgramExercise['muscleGroup'] }), id: id(row.id), name: string(row.name), variant: string(row.variant), equipment: string(row.equipment),
    loadConvention: string(row.load_convention) as ProgramExercise['loadConvention'], loadUnit: string(row.load_unit) as ProgramExercise['loadUnit'],
    measurementMode: string(row.mode) as ProgramExercise['measurementMode'], perSide: row.per_side as boolean, note: string(row.note) }
  if (validateExercise({ ...result, archivedAt: null })) fail()
  return result
}
function ordered(rows: Row[]) {
  const sorted = [...rows].sort((a, b) => Number(a.position) - Number(b.position))
  if (sorted.some((row, index) => row.position !== index)) fail()
  return sorted
}
const planColumns = 'id,owner_id,name,revision,active_version_id,archived_at,cycle_start,cycle_weeks,updated_at'
const versionColumns = 'id,owner_id,plan_id,title,guidance,version_number,revision,status,published_at,updated_at'
const dayColumns = 'id,owner_id,version_id,position,label,title,note'
const prescriptionColumns = 'id,owner_id,day_id,exercise_id,position,exercise_snapshot,mode,sets,optional_sets,reps_min,reps_max,duration_seconds,rest_seconds,rir,rpe,note'

export function createProgramsRepository(client: SupabaseClient, owner: string): ProgramsRepository {
  async function access(signal: AbortSignal) {
    const { data, error } = await client.auth.getSession()
    signal.throwIfAborted()
    if (error || data.session?.user.id !== owner) throw new ProgramsFailure('session')
    return data.session.access_token
  }
  function failure(error: { code?: string }) {
    return new ProgramsFailure(['PT409', '23505'].includes(error.code ?? '') ? 'conflict'
      : ['23514', '22023', '22P02'].includes(error.code ?? '') ? 'invalid' : 'unavailable')
  }
  async function one(table: string, columns: string, key: string, token: string, signal: AbortSignal) {
    const { data, error } = await client.from(table).select(columns).eq('owner_id', owner).eq('id', key)
      .setHeader('Authorization', `Bearer ${token}`).abortSignal(signal).retry(false).maybeSingle()
    if (error) throw failure(error)
    if (data === null) return null
    const row = owned(data, owner); if (row.id !== key) fail(); return row
  }
  async function pages(table: string, columns: string, token: string, signal: AbortSignal, filter?: [string, string]) {
    const rows: Row[] = []; let cursor: string | null = null
    while (true) {
      let request = client.from(table).select(columns).eq('owner_id', owner).order('id').limit(500)
      if (filter) request = request.eq(filter[0], filter[1])
      if (cursor) request = request.gt('id', cursor)
      const { data, error } = await request.setHeader('Authorization', `Bearer ${token}`).abortSignal(signal).retry(false)
      signal.throwIfAborted()
      if (error) throw failure(error)
      if (!Array.isArray(data)) fail()
      if (!data!.length) return rows
      for (const raw of data!) {
        const row = owned(raw, owner), key = id(row.id)
        if ((cursor && key <= cursor) || (filter && row[filter[0]] !== filter[1])) fail()
        rows.push(row); cursor = key
      }
    }
  }
  async function rpc(name: string, args: object, expected: { id: string; planId: string; revision: number; status: string }, signal: AbortSignal) {
    const token = await access(signal)
    const { data, error } = await client.rpc(name, args).setHeader('Authorization', `Bearer ${token}`).abortSignal(signal).retry(false)
    if (error) throw failure(error)
    const row = version(owned(Array.isArray(data) && data.length === 1 ? data[0] : data, owner))
    if (row.id !== expected.id || row.planId !== expected.planId || row.revision !== expected.revision || row.status !== expected.status) fail()
  }
  return {
    async list(signal) {
      const token = await access(signal)
      const plans = (await pages('workout_plans', planColumns, token, signal)).map(root)
      const versions = (await pages('workout_plan_versions', versionColumns, token, signal)).map(version)
      // Una creazione concorrente può essere vista soltanto dalla seconda query.
      if (versions.some(item => !plans.some(plan => plan.id === item.planId))) fail()
      return plans.map(plan => ({ plan, versions: versions.filter(item => item.planId === plan.id).sort((a, b) => b.number - a.number) }))
    },
    async get(versionId, signal) {
      if (!isExerciseId(versionId)) fail()
      const token = await access(signal)
      // Le letture dei figli sono separate: rileggere la revisione impedisce
      // di assemblare una bozza mista se un altro dispositivo la sostituisce.
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await one('workout_plan_versions', versionColumns, versionId, token, signal)
        if (!raw) return null
        const current = version(raw)
        const days = await pages('workout_days', dayColumns, token, signal, ['version_id', versionId])
        const children = await Promise.all(days.map(async day => ({ day, exercises: await pages('workout_prescriptions', prescriptionColumns, token, signal, ['day_id', id(day.id)]) })))
        const planRow = await one('workout_plans', planColumns, current.planId, token, signal)
        const final = await one('workout_plan_versions', versionColumns, versionId, token, signal)
        if (!final || final.revision !== current.revision) continue
        if (!planRow) fail()
        const document: ProgramDocument = { planId: current.planId, id: current.id, title: current.title, guidance: current.guidance, days: ordered(days).map(day => {
          const dayExercises = children.find(child => child.day.id === day.id)!.exercises
          return { id: id(day.id), label: string(day.label), title: string(day.title), note: string(day.note), exercises: ordered(dayExercises).map(row => {
            const exercise = snapshot(row.exercise_snapshot)
            if (exercise.id !== row.exercise_id || exercise.measurementMode !== row.mode) fail()
            return { id: id(row.id), exercise, sets: numericInput(row.sets), optionalSets: numericInput(row.optional_sets), repsMin: numericInput(row.reps_min), repsMax: numericInput(row.reps_max),
              durationSeconds: numericInput(row.duration_seconds), restSeconds: numericInput(row.rest_seconds), rir: numericInput(row.rir), rpe: numericInput(row.rpe), note: string(row.note) } satisfies PrescriptionDraft
          }) } satisfies ProgramDay
        }) }
        if (validateProgram(document, current.status === 'published')) fail()
        return { plan: root(planRow!), version: current, document }
      }
      throw new ProgramsFailure('conflict')
    },
    async save(document, revision, signal) {
      if (!Number.isSafeInteger(revision) || revision < 0 || validateProgram(document)) throw new ProgramsFailure('invalid')
      await rpc('save_workout_draft', { ...programPayload(document), p_expected_revision: revision }, { id: document.id, planId: document.planId, revision: revision + 1, status: 'draft' }, signal)
    },
    async publish(saved, signal) {
      if (saved.version.status !== 'draft' || validateProgram(saved.document, true)) throw new ProgramsFailure('invalid')
      await rpc('publish_workout_version', { p_version_id: saved.version.id, p_expected_revision: saved.version.revision, p_expected_plan_revision: saved.plan.revision },
        { id: saved.version.id, planId: saved.plan.id, revision: saved.version.revision + 1, status: 'published' }, signal)
    },
    async setCycle(plan, cycle, signal) {
      const token = await access(signal)
      const { data, error } = await client.from('workout_plans').update({ cycle_start: cycle?.start ?? null, cycle_weeks: cycle?.weeks ?? null, revision: plan.revision + 1 })
        .eq('owner_id', owner).eq('id', plan.id).select(planColumns).setHeader('Authorization', `Bearer ${token}`).abortSignal(signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      if (!data) throw new ProgramsFailure('conflict')
      return root(owned(data, owner))
    },
    async deletePlans(planId, signal) {
      if (planId !== null && !isExerciseId(planId)) throw new ProgramsFailure('invalid')
      const token = await access(signal)
      const { data, error } = await client.rpc('delete_workout_plans', { p_plan_id: planId })
        .setHeader('Authorization', `Bearer ${token}`).abortSignal(signal).retry(false)
      if (error) throw failure(error)
      if (typeof data !== 'number' || !Number.isSafeInteger(data) || data < 0) fail()
      return data
    },
    async revise({ base, document, cycle, newVersionId }, signal) {
      if (base.version.status !== 'published' || base.plan.archivedAt || !isExerciseId(newVersionId) || newVersionId === base.version.id
        || document.planId !== base.plan.id || validateProgram(document, true)) throw new ProgramsFailure('invalid')
      const payload = programPayload(document)
      const token = await access(signal)
      const { data, error } = await client.rpc('save_workout_revision', {
        p_plan_id: base.plan.id, p_base_version_id: base.version.id, p_expected_plan_revision: base.plan.revision, p_expected_version_revision: base.version.revision,
        p_new_version_id: newVersionId, p_title: payload.p_title, p_guidance: payload.p_guidance, p_days: payload.p_days,
        p_cycle_start: cycle?.start ?? null, p_cycle_weeks: cycle?.weeks ?? null,
      }).setHeader('Authorization', `Bearer ${token}`).abortSignal(signal).retry(false)
      if (error) throw failure(error)
      const row = record(data)
      const outcome = string(row.outcome) as RevisionOutcome
      if (!['unchanged', 'metadata', 'updated', 'created'].includes(outcome)) fail()
      const result = { outcome, versionId: id(row.version_id), planRevision: positive(row.plan_revision) }
      // Nuova versione solo con l'ID proposto; negli altri esiti resta la versione di partenza.
      if (outcome === 'created' ? result.versionId !== newVersionId : result.versionId !== base.version.id) fail()
      return result
    },
    async activate(saved, signal) {
      // Riattivazione di una versione già pubblicata: la versione stessa non cambia.
      if (saved.version.status !== 'published' || saved.plan.archivedAt || saved.plan.activeVersionId === saved.version.id) throw new ProgramsFailure('invalid')
      const token = await access(signal)
      const { data, error } = await client.rpc('activate_workout_version', { p_version_id: saved.version.id, p_expected_plan_revision: saved.plan.revision })
        .setHeader('Authorization', `Bearer ${token}`).abortSignal(signal).retry(false)
      if (error) throw failure(error)
      const row = root(owned(Array.isArray(data) && data.length === 1 ? data[0] : data, owner))
      if (row.id !== saved.plan.id || row.activeVersionId !== saved.version.id || row.revision !== saved.plan.revision + 1) fail()
    },
  }
}
