import type { SupabaseClient } from '@supabase/supabase-js'
import { isExerciseId } from '../domain/exercises.ts'
import { mealPlanTooLarge, validateMealPlanDocument, validateMealPlanDraft } from '../domain/meal-plans.ts'
import type { MealPlan, MealPlanDocument, MealPlanDraft } from '../domain/meal-plans.ts'

export interface ActiveSelection { workoutPlanId: string | null; mealPlanId: string | null; revision: number }

export interface PlansRepository {
  selection(signal: AbortSignal): Promise<ActiveSelection | null>
  select(value: { workoutPlanId: string | null; mealPlanId: string | null }, revision: number | null, signal: AbortSignal): Promise<ActiveSelection>
  mealPlans(signal: AbortSignal): Promise<MealPlan[]>
  mealPlan(id: string, signal: AbortSignal): Promise<MealPlan | null>
  saveMealPlan(draft: MealPlanDraft, revision: number | null, signal: AbortSignal): Promise<MealPlan>
  archiveMealPlan(plan: MealPlan, archived: boolean, signal: AbortSignal): Promise<MealPlan>
  deleteMealPlans(planId: string | null, signal: AbortSignal): Promise<number>
}

export class PlansFailure extends Error {
  readonly kind: 'conflict' | 'invalid' | 'unavailable' | 'session'
  constructor(kind: PlansFailure['kind']) { super(kind); this.kind = kind }
}

const bad = (): never => { throw new PlansFailure('unavailable') }
type Row = Record<string, unknown>
function record(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : bad() }
function nullableId(value: unknown) { return value === null ? null : typeof value === 'string' && isExerciseId(value) ? value : bad() }
function revision(value: unknown) { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : bad() }

export function selectionFromRow(value: unknown, owner: string): ActiveSelection {
  const row = record(value)
  if (row.owner_id !== owner) bad()
  return { workoutPlanId: nullableId(row.workout_plan_id), mealPlanId: nullableId(row.meal_plan_id), revision: revision(row.revision) }
}
export function mealPlanFromRow(value: unknown, owner: string): MealPlan {
  const row = record(value)
  if (row.owner_id !== owner || typeof row.id !== 'string' || typeof row.name !== 'string' || validateMealPlanDocument(row.document)) bad()
  const archivedAt = row.archived_at === null ? null : typeof row.archived_at === 'string' && Number.isFinite(Date.parse(row.archived_at)) ? row.archived_at : bad()
  const plan = { id: row.id as string, name: row.name as string, document: row.document as MealPlanDocument, archivedAt, revision: revision(row.revision) }
  if (validateMealPlanDraft(plan)) bad()
  return plan
}

const selectionColumns = 'owner_id,workout_plan_id,meal_plan_id,revision'
const mealColumns = 'id,owner_id,name,document,archived_at,revision'

export function createPlansRepository(client: SupabaseClient, owner: string): PlansRepository {
  async function token(signal: AbortSignal) {
    const { data, error } = await client.auth.getSession()
    signal.throwIfAborted()
    if (error || data.session?.user.id !== owner) throw new PlansFailure('session')
    return data.session.access_token
  }
  function failure(error: { code?: string }) {
    const code = error.code ?? ''
    return new PlansFailure(['PT409', '23505'].includes(code) ? 'conflict' : ['23514', '22023', '22P02', '23503'].includes(code) ? 'invalid' : 'unavailable')
  }
  return {
    async selection(signal) {
      const auth = await token(signal)
      const { data, error } = await client.from('active_plans').select(selectionColumns).eq('owner_id', owner)
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      return data === null ? null : selectionFromRow(data, owner)
    },
    async select(value, current, signal) {
      if ((value.workoutPlanId && !isExerciseId(value.workoutPlanId)) || (value.mealPlanId && !isExerciseId(value.mealPlanId))) throw new PlansFailure('invalid')
      const auth = await token(signal)
      const fields = { workout_plan_id: value.workoutPlanId, meal_plan_id: value.mealPlanId }
      const table = client.from('active_plans')
      // Nessun upsert: il primo inserimento concorrente produce conflitto esplicito.
      const change = current === null ? table.insert(fields) : table.update({ ...fields, revision: current + 1 }).eq('owner_id', owner)
      const { data, error } = await change.select(selectionColumns).setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      if (!data) throw new PlansFailure('conflict')
      return selectionFromRow(data, owner)
    },
    async mealPlans(signal) {
      const auth = await token(signal), plans: MealPlan[] = []
      let cursor: string | null = null
      while (true) {
        let request = client.from('meal_plans').select(mealColumns).eq('owner_id', owner).order('id').limit(100)
        if (cursor) request = request.gt('id', cursor)
        const { data, error } = await request.setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false)
        signal.throwIfAborted()
        if (error) throw failure(error)
        if (!Array.isArray(data)) bad()
        if (!data.length) return plans.sort((a, b) => a.name.localeCompare(b.name, 'it') || a.id.localeCompare(b.id))
        for (const row of data) { const plan = mealPlanFromRow(row, owner); if (cursor && plan.id <= cursor) bad(); plans.push(plan); cursor = plan.id }
      }
    },
    async mealPlan(id, signal) {
      if (!isExerciseId(id)) bad()
      const auth = await token(signal)
      const { data, error } = await client.from('meal_plans').select(mealColumns).eq('owner_id', owner).eq('id', id)
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      return data === null ? null : mealPlanFromRow(data, owner)
    },
    async saveMealPlan(draft, current, signal) {
      if (validateMealPlanDraft(draft) || mealPlanTooLarge(draft.document)) throw new PlansFailure('invalid')
      const auth = await token(signal)
      const table = client.from('meal_plans')
      const change = current === null ? table.insert({ id: draft.id, name: draft.name, document: draft.document })
        : table.update({ name: draft.name, document: draft.document, revision: current + 1 }).eq('owner_id', owner).eq('id', draft.id)
      const { data, error } = await change.select(mealColumns).setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      if (!data) throw new PlansFailure('conflict')
      return mealPlanFromRow(data, owner)
    },
    async archiveMealPlan(plan, archived, signal) {
      const auth = await token(signal)
      const { data, error } = await client.from('meal_plans').update({ archived_at: archived ? new Date().toISOString() : null, revision: plan.revision + 1 })
        .eq('owner_id', owner).eq('id', plan.id).select(mealColumns).setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      if (!data) throw new PlansFailure('conflict')
      return mealPlanFromRow(data, owner)
    },
    async deleteMealPlans(planId, signal) {
      if (planId !== null && !isExerciseId(planId)) throw new PlansFailure('invalid')
      const auth = await token(signal)
      const { data, error } = await client.rpc('delete_meal_plans', { p_plan_id: planId })
        .setHeader('Authorization', `Bearer ${auth}`).abortSignal(signal).retry(false)
      if (error) throw failure(error)
      if (typeof data !== 'number' || !Number.isSafeInteger(data) || data < 0) bad()
      return data
    },
  }
}
