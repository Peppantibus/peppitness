import { test } from 'node:test'
import assert from 'node:assert/strict'
import { estimateFoodEnergy, estimateFoods, energyOfMeal, foodsFromMeal, dailyEnergyBudget, isMealEnergy } from '../src/domain/food-energy.ts'
import { cleanMealPlanDraft, mealFromPlan, newMealPlan, newPlanDay, newPlanMeal, validateMealPlanDraft } from '../src/domain/meal-plans.ts'
import { cycleInfo } from '../src/domain/progress.ts'
import { mealLogFromRow } from '../src/persistence/diary-repository.ts'
import type { MealLog } from '../src/domain/types.ts'

const food = (name: string, quantity: string) => ({ name, quantity })
const breakfast = () => mealFromPlan({ ...newPlanMeal(), name: 'Colazione', foods: [food('Yogurt greco bianco 2%', '150 g'), food('Fiocchi di avena', '40 g')] })
test('USDA: energia da grammi, decimali italiani, kg e preparazioni distinte', () => {
  assert.equal(estimateFoodEnergy(food('Pasta', '100 g')).kcal, 371)
  assert.equal(estimateFoodEnergy(food('Skyr', '100 g')).kcal, 60)
  assert.equal(estimateFoodEnergy(food('Pasta cotta', '100 g')).kcal, 158)
  assert.equal(estimateFoodEnergy(food('Riso', '0,1 kg')).kcal, 365)
  assert.equal(estimateFoodEnergy(food('Riso cotto', '100 gr')).kcal, 130)
  assert.equal(estimateFoodEnergy(food('Olio EVO', '12,5 g')).kcal, 110.5)
  assert.equal(estimateFoodEnergy(food('Pollo', '100 g')).kcal, 120)
  assert.equal(estimateFoodEnergy(food('Pollo cotto', '100 g')).kcal, 165)
})
test('porzioni e volumi usano pesi USDA e indicano la conversione', () => {
  assert.equal(estimateFoodEnergy(food('Banana', '1 piccola')).kcal, 89.89)
  assert.equal(estimateFoodEnergy(food('Mela', '1')).kcal, 94.64)
  assert.ok(estimateFoodEnergy(food('Uova', '2')).kcal! > 100)
  assert.equal(estimateFoodEnergy(food('Uova', '2 uova')).kcal, estimateFoodEnergy(food('Uova', '2')).kcal)
  const milk = estimateFoodEnergy(food('Latte', '200 ml'))
  assert.ok(Math.abs(milk.kcal! - 102.95) < 0.1)
  assert.match(milk.assumption!, /convertito/)
  assert.equal(estimateFoodEnergy(food('Olio EVO', '1 cucchiaio')).kcal, 119.34)
  assert.ok(estimateFoodEnergy(food('Yogurt', '200 ml')).issue)
})
test('quantità ambigue, marche e piatti composti non diventano quantità inventate', () => {
  for (const quantity of ['', 'a piacere', '1 porzione', '100', '100 g se ti alleni', '100/200 g', '2 confezioni', '10-5 g', '-20 g', '0 g', '10001 g']) assert.equal(estimateFoodEnergy(food('Pane', quantity)).kcal, null, quantity)
  for (const name of ['Verdure', 'Insalata', 'Frutta', 'Pasta al pesto', 'Banana bread', 'Yogurt alla fragola marca X', 'Pollo fritto']) assert.equal(estimateFoodEnergy(food(name, '100 g')).kcal, null, name)
  const range = estimateFoodEnergy(food('Riso', '80–100 g'))
  assert.equal(range.kcal, 328.5); assert.match(range.assumption!, /90 g/)
  assert.equal(estimateFoods([food('Riso', '100 g'), food('Frutta', '1 porzione')]).energy.kcal, 365)
  assert.equal(estimateFoods([food('Riso', '100 g'), food('Frutta', '1 porzione')]).energy.missing, 1)
})
test('valori dalla confezione conservati in pulizia, snapshot e rilettura', () => {
  const draft = newMealPlan(), day = newPlanDay([])
  const meal = { ...newPlanMeal(), name: 'Snack', foods: [{ name: 'Prodotto particolare', quantity: '100 g', kcalPer100g: 200 }] }
  draft.name = 'Test'; draft.document.days = [{ ...day, meals: [meal] }]
  const clean = cleanMealPlanDraft(draft)
  assert.equal(validateMealPlanDraft(clean), null)
  const snapshot = mealFromPlan(clean.document.days[0]!.meals[0]!)
  assert.equal(snapshot.energy!.kcal, 200)
  assert.equal(estimateFoods(foodsFromMeal(snapshot)).energy.kcal, 200)
  const row = { diary_date: '2026-10-02', meal_id: snapshot.id, meal_plan_id: draft.id, meal_snapshot: snapshot, status: 'followed', note: '', day_type: 'training', revision: 1 }
  assert.deepEqual(mealLogFromRow(row).log.snapshot, snapshot)
  assert.throws(() => mealLogFromRow({ ...row, meal_snapshot: { ...snapshot, energy: { version: 1, missing: 0 } } }))
  assert.throws(() => mealLogFromRow({ ...row, meal_snapshot: { ...snapshot, energyOverrides: [-1] } }))
  assert.equal(isMealEnergy({ version: 1, kcal: null, missing: 1 }), true)
  assert.equal(isMealEnergy({ version: 1, kcal: Infinity, missing: 1 }), false)
})
test('2000 → 1800, annullamento, saltato, modificato, date e menu diversi', () => {
  const meal = breakfast(); meal.energy = { version: 1, kcal: 200, missing: 0 }
  const log: MealLog = { date: '2026-10-02', mealId: meal.id, status: 'followed', note: '', dayType: 'training', snapshot: meal }
  const budget = (logs: Record<string, MealLog>, meals = [meal]) => dailyEnergyBudget('2026-10-02', meals, logs, 2000)
  assert.equal(budget({}).remaining, 2000)
  assert.equal(budget({ breakfast: log }).remaining, 1800)
  assert.equal(budget({ breakfast: log }, []).remaining, 1800, 'cambio menu non toglie il pasto annotato')
  assert.equal(budget({ breakfast: { ...log, status: 'unrecorded' } }).remaining, 2000)
  assert.equal(budget({ breakfast: { ...log, status: 'skipped' } }).remaining, 2000)
  assert.equal(budget({ breakfast: { ...log, status: 'modified' } }).missing, 1)
  assert.equal(budget({ breakfast: { ...log, date: '2026-10-01' } }).remaining, 2000)
  assert.equal(budget({ breakfast: log, dinner: { ...log, mealId: 'other', snapshot: { ...meal, energy: { version: 1, kcal: 1900, missing: 0 } } } }).excess, 100)
  assert.equal(budget({ breakfast: { ...log, snapshot: { ...meal, energy: { version: 1, kcal: 150, missing: 1 } } } }).missing, 1)
  assert.equal(dailyEnergyBudget('2026-10-02', [meal], {}, null).goal, 200)
  assert.equal(dailyEnergyBudget('2026-10-02', [{ ...meal, energy: { version: 1, kcal: 100, missing: 1 } }], {}, null).goal, null)
  assert.equal(energyOfMeal(log.snapshot).kcal, 200, 'stima registrata non ricalcolata')
})
test('periodo opzionale, fine inclusiva e validazione date/settimane/energia', () => {
  const draft = newMealPlan(); draft.name = 'Piano'
  draft.document.cycle = { start: '2026-10-02', weeks: 4 }; draft.document.dailyCalories = 2000
  assert.equal(validateMealPlanDraft(draft), null)
  assert.equal(cleanMealPlanDraft(draft).document.dailyCalories, 2000)
  assert.equal(cycleInfo(draft.document.cycle, '2026-10-29').status, 'active')
  assert.equal(cycleInfo(draft.document.cycle, '2026-10-30').status, 'finished')
  assert.equal(cycleInfo(draft.document.cycle, '2026-10-01').status, 'upcoming')
  for (const cycle of [{ start: '2026-02-30', weeks: 4 }, { start: '2026-10-02', weeks: 0 }, { start: '2026-10-02', weeks: 53 }, { start: '2100-12-31', weeks: 1 }]) assert.ok(validateMealPlanDraft({ ...draft, document: { ...draft.document, cycle } }))
  for (const dailyCalories of [-1, 0, 20001, 1.5, Infinity]) assert.ok(validateMealPlanDraft({ ...draft, document: { ...draft.document, dailyCalories } }))
  assert.equal(validateMealPlanDraft({ ...draft, document: { guidance: '', days: [], cycle: null, dailyCalories: null } }), null)
})
