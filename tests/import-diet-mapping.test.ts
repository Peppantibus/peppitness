import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mapReviewedDiet, type DietMappingIds } from '../src/import/mapping/diet.ts'
import { createReviewDraft, sequentialLocalIds } from '../src/import/review/draft.ts'
import { applyDecision, setField, addItem, removeItem, moveItem, evaluateReadiness } from '../src/import/review/decisions.ts'
import { validateDraft } from '../src/import/validation/validate.ts'
import { mealPlanTooLarge, validateMealPlanDraft, mealFromPlan } from '../src/domain/meal-plans.ts'
import { resolvedPayloadContract } from '../src/import/contracts/commit.ts'
import type { DietReviewDraft, NormalizedDocument, JsonValue } from '../src/import/contracts/index.ts'

type Json = any
const read = (path: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/import/${path}`, import.meta.url), 'utf8'))
const uuid = (n: number) => `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const source = { sourceHash: 'a'.repeat(64), readerVersion: 'synthetic-fixture/1', textNormalizationVersion: 'peppitness.text-normalization.v1' as const }
let seq = 0
const decision = () => ({ decisionId: `test${++seq}` })
const edit = (draft: DietReviewDraft, id: string, field: string, value: JsonValue, reason: 'user_edit' | 'confirmed_missing' = 'user_edit') => setField(draft, id, field, value, reason, decision()) as DietReviewDraft
function fixture(name = 'diet-spec-example') {
  const entry = read('manifest.json').cases.find((c: Json) => c.id === name)
  const document = read(entry.expectedBlocks) as NormalizedDocument
  let draft = createReviewDraft({ kind: 'diet', extraction: read(entry.expectedProposal), proposalId: uuid(1), jobId: null, source, localIds: sequentialLocalIds('i') })
  for (const d of entry.userDecisions ?? []) draft = applyDecision(draft, d) as DietReviewDraft
  return { draft, document }
}
const ids = (draft: DietReviewDraft): DietMappingIds => ({ planId: uuid(2), items: Object.fromEntries(draft.current.map((i, n) => [i.localId, uuid(10 + n)])) })
const map = (draft: DietReviewDraft, document = fixture().document, reserved = ids(draft)) => mapReviewedDiet(document, draft, reserved)
function success(result: ReturnType<typeof map>) { assert.equal(result.ok, true, JSON.stringify(result.issues)); if (!result.ok) throw new Error(); return result.value }
function fails(result: ReturnType<typeof map>, code?: string) {
  assert.equal(result.ok, false); assert.equal('value' in result, false)
  if (code) assert.ok(result.issues.some(i => i.code === code), JSON.stringify(result.issues))
}

test('10: golden MealPlanDraft, source decisions and stable reservations; closed domain shape', () => {
  for (const name of ['diet-spec-example', 'diet-alternatives-additions']) {
    const f = fixture(name), before = structuredClone(f.draft), reserved = ids(f.draft)
    const mapped = success(map(f.draft, f.document, reserved))
    assert.deepEqual(mapped.plan, read(`mapping/diet/${name}.json`))
    assert.deepEqual(mapped.resolved, { plan: mapped.plan })
    assert.deepEqual(success(map(f.draft, f.document, reserved)), mapped)
    assert.deepEqual(f.draft, before)
    assert.equal(validateMealPlanDraft(mapped.plan), null)
    assert.equal(mealPlanTooLarge(mapped.plan.document), null)
    assert.ok(resolvedPayloadContract.diet(mapped.resolved).ok)
    assert.ok(evaluateReadiness(f.draft, validateDraft(f.document, f.draft).findings, map(f.draft, f.document)).ready)
    assert.deepEqual(Object.keys(mapped.plan.document).sort(), ['days', 'guidance'])
    assert.doesNotMatch(JSON.stringify(mapped.plan), /sourceRefs|evidence|provenance|localId/)
    const foods = f.draft.current.filter(i => i.collection === 'foods')
    for (const food of foods) assert.equal(mapped.targets[food.localId], mapped.targets[food.parentLocalId!])
  }
})

test('10: global conditional addition once, local scope intact and complete breakfast options never split', () => {
  const f = fixture('diet-alternatives-additions'), mapped = success(map(f.draft, f.document)), plan = mapped.plan
  const global = f.draft.current.find(i => i.collection === 'globalRules')!.values.text
  assert.equal(JSON.stringify(plan).split(global).length - 1, 1)
  const meals = plan.document.days[0]!.meals
  assert.deepEqual(meals[0]!.foods.map(food => food.name), ['Yogurt greco', 'banana'])
  assert.deepEqual(meals[0]!.alternatives, ['Yogurt → latte 200 ml', 'Opzione B colazione: pane integrale 60 g e marmellata 20 g.'])
  assert.deepEqual(meals.map(meal => meal.additions), [[], [], ['Se ti alleni nel pomeriggio aggiungi 30 g di pane']])
  assert.equal(meals[1]!.foods[0]!.quantity, '80 g a crudo')
  assert.equal(meals[1]!.foods[1]!.quantity, 'q.b.')
  assert.equal(meals[0]!.foods[1]!.quantity, '½')
  assert.deepEqual(mealFromPlan(meals[0]!).alternatives, meals[0]!.alternatives)
  fails(map(edit(f.draft, 'i0', 'guidance', [global]), f.document), 'diet_global_rule_duplicate')
  const meal = f.draft.current.find(i => i.collection === 'meals')!
  fails(map(edit(f.draft, meal.localId, 'additions', [global]), f.document))
  fails(map(edit(f.draft, meal.localId, 'notes', [global]), f.document), 'diet_global_rule_local_note')
})

test('10: missing quantity requires confirmation, unknown day type stays unknown, time stays empty', () => {
  const f = fixture()
  const missing = edit(f.draft, 'i3', 'quantityText', null)
  fails(map(missing))
  fails(map(edit(missing, 'i3', 'quantityText', '')), 'diet_quantity_confirmation')
  const confirmed = success(map(edit(missing, 'i3', 'quantityText', '', 'confirmed_missing')))
  assert.equal(confirmed.plan.document.days[0]!.meals[0]!.foods[0]!.quantity, '')
  assert.equal(confirmed.plan.document.days[0]!.meals[0]!.time, '')
  fails(map(edit(f.draft, 'i1', 'dayType', null)))
  const chosen = edit(edit(f.draft, 'i1', 'dayType', null), 'i1', 'dayType', 'any')
  assert.equal(success(map(chosen)).plan.document.days[0]!.dayType, 'any')
  for (const text of ['1 confezione da 125 g', '100 g cotti', 'q.b.', ' 2 porzioni ', 'circa ½ tazza']) {
    assert.equal(success(map(edit(f.draft, 'i3', 'quantityText', text))).plan.document.days[0]!.meals[0]!.foods[0]!.quantity, text)
  }
})

test('10: golden decision effects preserve complete options, chosen emptiness, nutrients and conditions', () => {
  const golden = read('mapping/diet/reviewed-conditions.json')
  let { draft } = fixture()
  for (const d of golden.additionalDecisions) draft = applyDecision(draft, d) as DietReviewDraft
  assert.deepEqual(success(map(draft)).plan, golden.expected)
})

test('10: food notes name the precise occurrence; intentional duplicate foods and order survive', () => {
  let { draft } = fixture()
  draft = edit(draft, 'i1', 'notes', ['Nota giornata'])
  draft = edit(draft, 'i2', 'notes', ['Nota pasto'])
  draft = edit(draft, 'i3', 'notes', ['Proteine 12 g', 'Da consumare freddo'])
  draft = addItem(draft, { collection: 'foods', parentLocalId: 'i2', localId: 'duplicate', values: { name: 'yogurt bianco', quantityText: '1 confezione', notes: ['Seconda porzione facoltativa solo se indicato'] } }, decision()) as DietReviewDraft
  const result = success(map(draft)), meal = result.plan.document.days[0]!.meals[0]!
  assert.equal(meal.foods.length, 2)
  assert.equal(meal.note, 'Nota pasto\nyogurt bianco (alimento 1): Proteine 12 g\nyogurt bianco (alimento 1): Da consumare freddo\nyogurt bianco (alimento 2): Seconda porzione facoltativa solo se indicato')
  assert.equal(result.plan.document.days[0]!.note, 'Nota giornata')
  const reordered = moveItem(draft, 'duplicate', 'i2', 0, decision()) as DietReviewDraft
  assert.equal(success(map(reordered)).plan.document.days[0]!.meals[0]!.foods[0]!.quantity, '1 confezione')
  assert.equal(success(map(removeItem(draft, 'duplicate', 'user_edit', decision()) as DietReviewDraft)).plan.document.days[0]!.meals[0]!.foods.length, 1)
})

test('10: alternative-only meals keep two complete options, empty plans/meals never succeed', () => {
  const f = fixture()
  let draft = removeItem(f.draft, 'i3', 'user_edit', decision()) as DietReviewDraft
  draft = edit(draft, 'i2', 'alternatives', ['Opzione A, intera colazione: latte 200 ml e pane 60 g.', 'Opzione B, intera colazione: yogurt 170 g e frutta 1 porzione.'])
  const meal = success(map(draft)).plan.document.days[0]!.meals[0]!
  assert.deepEqual(meal.foods, [])
  assert.equal(meal.alternatives.length, 2)
  fails(map(edit(draft, 'i2', 'alternatives', [])), 'diet_empty_meal')
  fails(map(removeItem(draft, 'i2', 'user_edit', decision()) as DietReviewDraft))
  fails(map(removeItem(draft, 'i1', 'user_edit', decision()) as DietReviewDraft))
})

test('10: UTF-16 vs code points, field limits and added note/scope labels count without trim or cut', () => {
  const f = fixture()
  assert.equal(success(map(edit(f.draft, 'i3', 'name', '🍎'.repeat(200)))).plan.document.days[0]!.meals[0]!.foods[0]!.name.length, 400)
  const changes: [string, string, JsonValue][] = [
    ['i0', 'title', 'x'.repeat(161)], ['i0', 'title', ' Spazi '], ['i0', 'guidance', ['x'.repeat(16001)]],
    ['i1', 'name', 'x'.repeat(121)], ['i1', 'notes', ['x'.repeat(4001)]], ['i2', 'name', 'x'.repeat(121)], ['i2', 'timeText', 'x'.repeat(61)],
    ['i2', 'notes', ['x'.repeat(4001)]], ['i3', 'name', '🍎'.repeat(201)], ['i3', 'quantityText', 'x'.repeat(61)],
    ['i2', 'alternatives', ['x'.repeat(501)]], ['i2', 'additions', ['x'.repeat(501)]], ['i2', 'alternatives', Array(31).fill('Opzione completa')],
    ['i2', 'additions', Array(31).fill('Aggiungi se necessario')], ['i2', 'alternatives', ['  ']], ['i3', 'notes', ['x'.repeat(3999)]],
    ['i3', 'quantityText', '\u0001'],
  ]
  for (const [id, field, value] of changes) fails(map(edit(f.draft, id, field, value)))
  const g = fixture('diet-alternatives-additions')
  const global = g.draft.current.find(i => i.collection === 'globalRules')!
  fails(map(edit(g.draft, global.localId, 'text', 'x'.repeat(16000)), g.document))
})

test('10: stale/tampered review and missing/duplicate reserved IDs cannot produce payload', () => {
  const f = fixture(), reserved = ids(f.draft)
  fails(map(f.draft, f.document, { ...reserved, items: {} }))
  fails(map(f.draft, f.document, { ...reserved, planId: reserved.items.i1! }))
  const tampered = structuredClone(f.draft); (tampered.current[3]!.values as Json).quantityText = '250 g'
  fails(map(tampered), 'diet_invalid_review')
})

test('10: exact serialized UTF-8 byte limit is checked after projection, including Unicode', () => {
  const f = fixture()
  let draft = edit(f.draft, 'i0', 'guidance', ['🍎'.repeat(15000)])
  for (let n = 0; n < 7; n++) draft = addItem(draft, {
    collection: 'meals', parentLocalId: 'i1', localId: `large${n}`, values: { name: `Pasto ${n}`, timeText: null, notes: ['🍎'.repeat(3990)],
      alternatives: ['Opzione completa: pane 60 g e latte 200 ml.'], additions: [] },
  }, decision()) as DietReviewDraft
  const valid = success(map(draft))
  const bytes = new TextEncoder().encode(JSON.stringify(valid.plan.document)).length
  assert.ok(bytes > 170000 && bytes <= 180000, String(bytes))
  const alternatives = [...valid.plan.document.days[0]!.meals[0]!.alternatives]
  let remaining = 180000 - bytes
  while (remaining > 503) { alternatives.push('x'.repeat(500)); remaining -= 503 }
  if (remaining >= 4) alternatives.push('x'.repeat(remaining - 3))
  else alternatives[0] += 'x'.repeat(remaining)
  const exact = edit(draft, 'i2', 'alternatives', alternatives)
  assert.equal(new TextEncoder().encode(JSON.stringify(success(map(exact)).plan.document)).length, 180000)
  alternatives[0] += 'x'
  const over = edit(exact, 'i2', 'alternatives', alternatives)
  assert.equal(validateDraft(f.document, over).issues.some(i => i.code === 'document_too_large'), false, '06 only measures a lower bound')
  fails(map(over), 'resolved_contract_violation')
  draft = addItem(draft, { collection: 'meals', parentLocalId: 'i1', localId: 'tooLarge', values: { name: 'Pasto extra', timeText: null, notes: ['🍎'.repeat(3990)], alternatives: ['Opzione completa: pane 60 g e latte 200 ml.'], additions: [] } }, decision()) as DietReviewDraft
  fails(map(draft))
})

test('10: collection bounds are enforced after explicit additions, without removing extracted rows', () => {
  const f = fixture()
  let foods = f.draft
  for (let n = 1; n <= 60; n++) {
    foods = addItem(foods, { collection: 'foods', parentLocalId: 'i2', localId: `food${n}`, values: { name: `Alimento ${n}`, quantityText: '1 porzione', notes: [] } }, decision()) as DietReviewDraft
    if (n === 59) assert.equal(success(map(foods)).plan.document.days[0]!.meals[0]!.foods.length, 60)
  }
  fails(map(foods))
  let meals = f.draft
  for (let n = 1; n <= 20; n++) {
    meals = addItem(meals, { collection: 'meals', parentLocalId: 'i1', localId: `meal${n}`, values: { name: `Pasto ${n}`, timeText: null, alternatives: ['Opzione completa: latte 200 ml e pane 60 g.'], additions: [], notes: [] } }, decision()) as DietReviewDraft
    if (n === 19) assert.equal(success(map(meals)).plan.document.days[0]!.meals.length, 20)
  }
  fails(map(meals))
  let days = f.draft
  for (let n = 1; n <= 14; n++) {
    days = addItem(days, { collection: 'days', parentLocalId: 'i0', localId: `day${n}`, values: { name: `Giorno ${n}`, dayType: 'any', notes: [] } }, decision()) as DietReviewDraft
    days = addItem(days, { collection: 'meals', parentLocalId: `day${n}`, localId: `dayMeal${n}`, values: { name: 'Pasto', timeText: null, alternatives: ['Opzione completa: latte 200 ml e pane 60 g.'], additions: [], notes: [] } }, decision()) as DietReviewDraft
    if (n === 13) assert.equal(success(map(days)).plan.document.days.length, 14)
  }
  fails(map(days))
})
