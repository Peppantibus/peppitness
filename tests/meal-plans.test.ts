import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanMealPlanDraft, daysForType, mealFromPlan, mealPlanTooLarge, newMealPlan, newPlanDay, newPlanMeal, validateMealPlanDocument, validateMealPlanDraft } from '../src/domain/meal-plans.ts'
import type { MealPlan, MealPlanDraft } from '../src/domain/meal-plans.ts'
import type { ProgramIndex, SavedProgram } from '../src/domain/programs.ts'
import { memoryStorage } from '../src/persistence/diary-store.ts'
import { mealPlanFromRow, PlansFailure } from '../src/persistence/plans-repository.ts'
import type { ActiveSelection, PlansRepository } from '../src/persistence/plans-repository.ts'
import { PlansStore } from '../src/persistence/plans-store.ts'
import type { ProgramsRepository } from '../src/persistence/programs-repository.ts'

const OWNER = '11111111-1111-4111-8111-111111111111'
function draft(): MealPlanDraft {
  const plan = newMealPlan()
  const training = newPlanDay([]), rest = newPlanDay([training])
  const breakfast = { ...newPlanMeal(), name: 'Colazione', time: '07:30', foods: [{ name: 'Yogurt', quantity: '150 g' }, { name: 'Avena', quantity: '' }], alternatives: ['Pane e ricotta'] }
  return { ...plan, name: 'Piano di prova', document: { guidance: '', days: [{ ...training, meals: [breakfast] }, { ...rest, meals: [{ ...newPlanMeal(), name: 'Pranzo' }] }] } }
}

test('piano alimentare: stesso contratto del database, testi vuoti e chiavi estranee respinti', () => {
  const value = draft()
  assert.equal(validateMealPlanDraft(value), null)
  assert.equal(value.document.days[0]!.dayType, 'training')
  assert.equal(value.document.days[1]!.dayType, 'rest')
  assert.ok(validateMealPlanDocument({ ...value.document, extra: true }))
  assert.ok(validateMealPlanDraft({ ...value, name: ' ' }))
  const blankMeal = structuredClone(value); blankMeal.document.days[0]!.meals[0]!.name = ' '
  assert.ok(validateMealPlanDraft(blankMeal))
  const duplicate = structuredClone(value); duplicate.document.days[1]!.id = duplicate.document.days[0]!.id
  assert.ok(validateMealPlanDraft(duplicate))
  const control = structuredClone(value); control.document.guidance = 'a\u0007b'
  assert.ok(validateMealPlanDraft(control))
  assert.equal(mealPlanTooLarge(value.document), null)
  const huge = structuredClone(value)
  huge.document.days = Array.from({ length: 14 }, () => ({ ...newPlanDay([]), note: 'n'.repeat(4000), meals: Array.from({ length: 20 }, () => ({ ...newPlanMeal(), name: 'P', note: 'm'.repeat(4000) })) }))
  assert.equal(validateMealPlanDraft(huge), null, 'ogni campo nei limiti')
  assert.ok(mealPlanTooLarge(huge.document), 'ma il totale supera il limite di salvataggio')
})

test('piano alimentare: righe vuote dell’editor rimosse, nessun valore aggiunto', () => {
  const value = draft()
  value.document.days[0]!.meals[0]!.alternatives = ['  Pane e ricotta ', '', '   ']
  value.document.days[0]!.meals[0]!.foods.push({ name: '', quantity: '' })
  const clean = cleanMealPlanDraft(value)
  assert.deepEqual(clean.document.days[0]!.meals[0]!.alternatives, ['Pane e ricotta'])
  assert.equal(clean.document.days[0]!.meals[0]!.foods.length, 2)
  const meal = mealFromPlan(clean.document.days[0]!.meals[0]!)
  assert.deepEqual(meal.items, ['Yogurt · 150 g', 'Avena'])
  assert.equal(meal.timeLabel, '07:30')
  assert.deepEqual(daysForType(clean.document, 'rest').map(day => day.name), ['Riposo'])
  assert.deepEqual(daysForType({ guidance: '', days: [{ ...clean.document.days[0]!, dayType: 'training' }] }, 'rest').length, 1, 'senza giornate dedicate si usano tutte')
})

test('piano alimentare: righe del server validate per proprietario', () => {
  const value = draft()
  const row = { id: value.id, owner_id: OWNER, name: value.name, document: value.document, archived_at: null, revision: 1 }
  assert.equal(mealPlanFromRow(row, OWNER).name, 'Piano di prova')
  assert.throws(() => mealPlanFromRow({ ...row, owner_id: '22222222-2222-4222-8222-222222222222' }, OWNER))
  assert.throws(() => mealPlanFromRow({ ...row, document: { guidance: '', days: 'x' } }, OWNER))
})

function fakes() {
  let selection: ActiveSelection | null = null
  const plans = new Map<string, MealPlan>()
  let failNextSelect: PlansFailure | null = null, loseNextSave = false
  const version = { id: 'v1', planId: 'p1', title: 'Programma', guidance: '', number: 1, revision: 2, status: 'published' as const }
  const index: ProgramIndex[] = [{ plan: { id: 'p1', name: 'Programma', revision: 2, activeVersionId: 'v1', archivedAt: null }, versions: [version] }]
  const saved: SavedProgram = { plan: index[0]!.plan, version, document: { planId: 'p1', id: 'v1', title: 'Programma', guidance: '', days: [] } }
  const repository: PlansRepository = {
    async selection() { return selection },
    async select(value, revision) {
      if (failNextSelect) { const error = failNextSelect; failNextSelect = null; throw error }
      if ((selection?.revision ?? null) !== revision) throw new PlansFailure('conflict')
      selection = { ...value, revision: (revision ?? 0) + 1 }
      return selection
    },
    async mealPlans() { return [...plans.values()] },
    async mealPlan(id) { return plans.get(id) ?? null },
    async saveMealPlan(value, revision) {
      const current = plans.get(value.id)
      if ((current?.revision ?? null) !== revision) throw new PlansFailure('conflict')
      const next = { ...structuredClone(value), archivedAt: null, revision: (revision ?? 0) + 1 }
      plans.set(value.id, next)
      if (loseNextSave) { loseNextSave = false; throw new PlansFailure('unavailable') }
      return next
    },
    async archiveMealPlan(plan, archived) { const next = { ...plan, archivedAt: archived ? new Date().toISOString() : null, revision: plan.revision + 1 }; plans.set(plan.id, next); return next },
    async deleteMealPlans(planId) {
      let count = 0
      for (const id of plans.keys()) if (planId === null || id === planId) { plans.delete(id); count++ }
      if (selection?.mealPlanId && (planId === null || selection.mealPlanId === planId)) selection = { ...selection, mealPlanId: null, revision: selection.revision + 1 }
      return count
    },
  }
  const programs = { list: async () => index, get: async (id: string) => id === 'v1' ? saved : null } as unknown as ProgramsRepository
  return { repository, programs, plans, set: (value: ActiveSelection | null) => { selection = value }, failSelect: (error: PlansFailure) => { failNextSelect = error }, loseSave: () => { loseNextSave = true } }
}

test('eliminazione piano selezionato conserva gli altri piani e azzera la scelta', async () => {
  const fake = fakes(), first = draft(), second = { ...draft(), id: crypto.randomUUID(), name: 'Secondo piano' }
  fake.plans.set(first.id, { ...first, archivedAt: null, revision: 1 })
  fake.plans.set(second.id, { ...second, archivedAt: null, revision: 1 })
  fake.set({ workoutPlanId: null, mealPlanId: first.id, revision: 1 })
  const store = new PlansStore(fake.repository, fake.programs, memoryStorage(), OWNER)
  await store.load()
  assert.equal(await store.deleteMealPlans(first.id), true)
  assert.equal(store.getSnapshot().selection?.mealPlanId, null)
  assert.deepEqual(store.getSnapshot().mealPlans.map(plan => plan.id), [second.id])
  assert.equal(await store.deleteMealPlans(null), true)
  assert.equal(store.getSnapshot().mealPlans.length, 0)
})

test('piani seguiti: nessuna selezione automatica; scelta esplicita e copia offline', async () => {
  const fake = fakes(), storage = memoryStorage()
  const store = new PlansStore(fake.repository, fake.programs, storage, OWNER)
  await store.load()
  assert.equal(store.getSnapshot().selection, null)
  assert.equal(store.getSnapshot().workout, null, 'un programma pubblicato non viene seguito da solo')
  await store.choose({ workoutPlanId: 'p1' })
  assert.equal(store.getSnapshot().workout?.version.id, 'v1')
  assert.equal(store.getSnapshot().selection?.revision, 1)
  const offline = new PlansStore(fake.repository, fake.programs, storage, OWNER)
  assert.equal(offline.getSnapshot().phase, 'ready')
  assert.equal(offline.getSnapshot().workout?.version.id, 'v1', 'la Scheda resta disponibile dalla copia sul dispositivo')
  assert.ok(offline.getSnapshot().cached)
  // Selezione cambiata altrove: la revisione obsoleta non sovrascrive.
  fake.set({ workoutPlanId: null, mealPlanId: null, revision: 5 })
  await store.choose({ mealPlanId: null, workoutPlanId: 'p1' })
  assert.equal(store.getSnapshot().selection?.revision, 5)
  assert.match(store.getSnapshot().message, /cambiata online/)
  fake.failSelect(new PlansFailure('invalid'))
  await store.choose({ workoutPlanId: 'p1' })
  assert.match(store.getSnapshot().message, /versione pubblicata/)
})

test('editor piani: risposta persa verificata, conflitto con scelta esplicita', async () => {
  const fake = fakes()
  const store = new PlansStore(fake.repository, fake.programs, memoryStorage(), OWNER)
  await store.load()
  store.createMealPlan()
  const value = { ...draft(), id: store.getSnapshot().editor.draft!.id }
  store.editMealPlan(value)
  assert.ok(store.mealDirty)
  fake.loseSave()
  await store.saveMealPlan()
  assert.equal(store.getSnapshot().editor.phase, 'editing')
  assert.match(store.getSnapshot().editor.message, /conferma recuperata/)
  assert.equal(store.getSnapshot().mealPlans.length, 1)
  assert.equal(store.mealDirty, false)
  // Modifica concorrente online: nessuna sovrascrittura senza scelta.
  const remote = fake.plans.get(value.id)!
  fake.plans.set(value.id, { ...remote, name: 'Nome online', revision: remote.revision + 1 })
  store.editMealPlan({ ...store.getSnapshot().editor.draft!, name: 'Nome locale' })
  await store.saveMealPlan()
  assert.equal(store.getSnapshot().editor.phase, 'conflict')
  assert.equal(store.getSnapshot().editor.remote?.name, 'Nome online')
  await store.saveMealPlan(true)
  assert.equal(fake.plans.get(value.id)!.name, 'Nome locale')
  assert.equal(store.getSnapshot().editor.phase, 'editing')
})
