import type { SupabaseClient } from '@supabase/supabase-js'
import { isExerciseId, validateExercise } from '../domain/exercises.ts'
import type { CatalogExercise, ExerciseValues } from '../domain/exercises.ts'
import { isMuscleGroup } from '../domain/muscle-groups.ts'

export interface ExercisesRepository {
  list(signal: AbortSignal): Promise<CatalogExercise[]>
  listShared(signal: AbortSignal): Promise<CatalogExercise[]>
  get(id: string, signal: AbortSignal): Promise<CatalogExercise | null>
  save(id: string, value: ExerciseValues, revision: number | null, signal: AbortSignal): Promise<CatalogExercise>
  adopt(templateId: string, signal: AbortSignal): Promise<CatalogExercise>
}
export class ExercisesFailure extends Error {
  readonly kind: 'conflict' | 'unavailable' | 'session'
  constructor(kind: ExercisesFailure['kind']) { super(kind); this.kind = kind }
}
const columns = 'id,owner_id,name,variant,equipment,load_convention,load_unit,measurement_mode,per_side,note,archived_at,revision,source_template_id,muscle_group'
const sharedColumns = 'id,name,variant,equipment,load_convention,load_unit,measurement_mode,per_side,note,muscle_group'

function category(row: Record<string, unknown>) {
  if (row.muscle_group === undefined) return {} // Fixture anteriori al campo.
  if (row.muscle_group === null || isMuscleGroup(row.muscle_group)) return { muscleGroup: row.muscle_group }
  throw new ExercisesFailure('unavailable')
}

// Contratto minimo scritto dallo schema già applicato; non sono tipi generati.
function decode(data: unknown, owner: string): CatalogExercise {
  if (!data || typeof data !== 'object') throw new ExercisesFailure('unavailable')
  const row = data as Record<string, unknown>
  if (row.owner_id !== owner || typeof row.id !== 'string' || !isExerciseId(row.id)
    || !['name', 'variant', 'equipment', 'note', 'load_convention', 'load_unit', 'measurement_mode'].every(key => typeof row[key] === 'string')
    || typeof row.per_side !== 'boolean' || !(row.archived_at === null || typeof row.archived_at === 'string')
    || !(row.source_template_id === undefined || row.source_template_id === null || typeof row.source_template_id === 'string')
    || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1) throw new ExercisesFailure('unavailable')
  const value: CatalogExercise = {
    ...category(row),
    id: row.id, name: row.name as string, variant: row.variant as string, equipment: row.equipment as string,
    loadConvention: row.load_convention as ExerciseValues['loadConvention'], loadUnit: row.load_unit as ExerciseValues['loadUnit'],
    measurementMode: row.measurement_mode as ExerciseValues['measurementMode'], perSide: row.per_side,
    note: row.note as string, archivedAt: row.archived_at as string | null, revision: row.revision,
    ...(row.source_template_id === undefined ? {} : { sourceTemplateId: typeof row.source_template_id === 'string' ? row.source_template_id : null }),
  }
  if (validateExercise(value) || (value.sourceTemplateId && !isExerciseId(value.sourceTemplateId))) throw new ExercisesFailure('unavailable')
  return value
}

function decodeShared(data: unknown): CatalogExercise {
  if (!data || typeof data !== 'object') throw new ExercisesFailure('unavailable')
  const row = data as Record<string, unknown>
  if (typeof row.id !== 'string' || !['name', 'variant', 'equipment', 'note', 'load_convention', 'load_unit', 'measurement_mode'].every(key => typeof row[key] === 'string')
    || typeof row.per_side !== 'boolean') throw new ExercisesFailure('unavailable')
  const value: CatalogExercise = {
    ...category(row),
    id: row.id as string, name: row.name as string, variant: row.variant as string,
    equipment: row.equipment as string, loadConvention: row.load_convention as ExerciseValues['loadConvention'],
    loadUnit: row.load_unit as ExerciseValues['loadUnit'], measurementMode: row.measurement_mode as ExerciseValues['measurementMode'],
    perSide: row.per_side as boolean, note: row.note as string, archivedAt: null, revision: 1,
  }
  if (!isExerciseId(value.id) || validateExercise(value)) throw new ExercisesFailure('unavailable')
  return value
}

export function createExercisesRepository(client: SupabaseClient, owner: string): ExercisesRepository {
  async function token(signal: AbortSignal) {
    const { data, error } = await client.auth.getSession()
    signal.throwIfAborted()
    if (error || data.session?.user.id !== owner) throw new ExercisesFailure('session')
    return data.session.access_token
  }
  const failure = (error: { code?: string }) => new ExercisesFailure(['PT409', '23505'].includes(error.code ?? '') ? 'conflict' : 'unavailable')
  return {
    async list(signal) {
      const accessToken = await token(signal)
      const rows: CatalogExercise[] = []
      // Pagine ordinate per ID: non troncare l'archivio al limite PostgREST.
      // La fine è una pagina vuota, anche se il server impone un limite < 500.
      let cursor: string | null = null
      while (true) {
        let request = client.from('exercises').select(columns).eq('owner_id', owner).order('id').limit(500)
        if (cursor) request = request.gt('id', cursor)
        const { data, error } = await request.setHeader('Authorization', `Bearer ${accessToken}`).abortSignal(signal).retry(false)
        signal.throwIfAborted()
        if (error) throw failure(error)
        if (!Array.isArray(data)) throw new ExercisesFailure('unavailable')
        if (!data.length) return rows
        for (const raw of data) {
          const row = decode(raw, owner)
          if (cursor && row.id <= cursor) throw new ExercisesFailure('unavailable')
          rows.push(row); cursor = row.id
        }
      }
    },
    async listShared(signal) {
      const accessToken = await token(signal)
      const rows: CatalogExercise[] = []
      let cursor: string | null = null
      while (true) {
        let request = client.from('shared_exercises').select(sharedColumns).order('id').limit(500)
        if (cursor) request = request.gt('id', cursor)
        const { data, error } = await request.setHeader('Authorization', `Bearer ${accessToken}`).abortSignal(signal).retry(false)
        signal.throwIfAborted()
        if (error || !Array.isArray(data)) throw new ExercisesFailure('unavailable')
        if (!data.length) return rows
        for (const raw of data) {
          const row = decodeShared(raw)
          if (cursor && row.id <= cursor) throw new ExercisesFailure('unavailable')
          rows.push(row); cursor = row.id
        }
      }
    },
    async get(id, signal) {
      if (!isExerciseId(id)) throw new ExercisesFailure('unavailable')
      const accessToken = await token(signal)
      const { data, error } = await client.from('exercises').select(columns).eq('owner_id', owner).eq('id', id)
        .setHeader('Authorization', `Bearer ${accessToken}`).abortSignal(signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      if (data === null) return null
      const row = decode(data, owner)
      if (row.id !== id) throw new ExercisesFailure('unavailable')
      return row
    },
    async save(id, value, revision, signal) {
      if (!isExerciseId(id) || validateExercise(value) || (revision !== null && (!Number.isSafeInteger(revision) || revision < 1))) throw new ExercisesFailure('unavailable')
      const accessToken = await token(signal)
      const mutable = { name: value.name, note: value.note, archived_at: value.archivedAt, ...(value.muscleGroup === undefined ? {} : { muscle_group: value.muscleGroup }) }
      const table = client.from('exercises')
      const change = revision === null ? table.insert({ id, ...mutable, variant: value.variant, equipment: value.equipment,
        load_convention: value.loadConvention, load_unit: value.loadUnit, measurement_mode: value.measurementMode, per_side: value.perSide })
        : table.update({ ...mutable, revision: revision + 1 }).eq('owner_id', owner).eq('id', id)
      const { data, error } = await change.select(columns).setHeader('Authorization', `Bearer ${accessToken}`).abortSignal(signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      if (!data) throw new ExercisesFailure('conflict')
      const row = decode(data, owner)
      if (row.id !== id) throw new ExercisesFailure('unavailable')
      return row
    },
    async adopt(templateId, signal) {
      if (!isExerciseId(templateId)) throw new ExercisesFailure('unavailable')
      const accessToken = await token(signal)
      const { data, error } = await client.rpc('adopt_shared_exercise', { p_template_id: templateId })
        .setHeader('Authorization', `Bearer ${accessToken}`).abortSignal(signal).retry(false)
      signal.throwIfAborted()
      if (error) throw failure(error)
      if (typeof data !== 'string' || !isExerciseId(data)) throw new ExercisesFailure('unavailable')
      const row = await this.get(data, signal)
      if (!row || row.sourceTemplateId !== templateId) throw new ExercisesFailure('unavailable')
      return row
    },
  }
}
