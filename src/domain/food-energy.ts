import { foodEnergyData } from './food-energy-data.ts'
import type { MealFood } from './meal-plans.ts'
import type { Meal, MealLog } from './types.ts'

export interface MealEnergy { version: 1; kcal: number | null; missing: number }
export interface FoodEnergyEstimate {
  name: string; quantity: string; kcal: number | null; reference: string | null
  sourceUrl: string | null; assumption: string | null; issue: string | null
}
const normalize = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim()
const references = new Map<string, typeof foodEnergyData[number]>(foodEnergyData.flatMap(food => food.aliases.map(alias => [normalize(alias), food] as const)))
const number = '(?:\\d+(?:[.,]\\d+)?)'
const mass = new RegExp(`^(${number})(?:\\s*[-–]\\s*(${number}))?\\s*(g|gr|grammi|grammo|kg|ml|cl|l)$`)
const count = new RegExp(`^(${number})\\s*(?:pezzi?|uov[oa]|banan[ae]|mel[ae]|per[ae]|kiwi|aranc(?:ia|e))?\\s*(piccol[oaie]|medi[oaie]|grand[ei])?$`)
const numeric = (value: string) => Number(value.replace(',', '.'))
const validGrams = (grams: number) => Number.isFinite(grams) && grams > 0 && grams <= 10000

export function estimateFoodEnergy(food: MealFood): FoodEnergyEstimate {
  const ref = references.get(normalize(food.name))
  const override = food.kcalPer100g
  const energy = override != null ? override : ref?.kcalPer100g
  const base = { name: food.name, quantity: food.quantity, reference: override != null ? 'Valore inserito da te' : ref?.label ?? null, sourceUrl: override != null ? null : ref?.sourceUrl ?? null }
  const unknown = (issue: string): FoodEnergyEstimate => ({ ...base, kcal: null, assumption: null, issue })
  if (energy == null || !Number.isFinite(energy) || energy < 0 || energy > 1000) return unknown('Alimento non riconosciuto')
  const qty = normalize(food.quantity)
  const match = mass.exec(qty)
  let grams: number | null = null, assumption: string | null = null
  if (match) {
    const low = numeric(match[1]!), high = match[2] ? numeric(match[2]) : low
    if (high < low || low <= 0) return unknown('Intervallo di quantità non valido')
    grams = (low + high) / 2
    if (high !== low) assumption = `Intervallo: usati ${(low + high) / 2} ${match[3]}`
    if (match[3] === 'kg') grams *= 1000
    if (['ml', 'cl', 'l'].includes(match[3]!)) {
      // Una tazza US ≈237 ml; peso della tazza dal record USDA dell'alimento.
      const cup = ref?.portions.find(p => p.name === 'cup')
      const liquid = ref && (/^Latte /.test(ref.label) || ref.id === '171413' || ref.id === '174832')
      if (!liquid || !cup) return unknown('Per questo alimento indica il peso in grammi')
      const ml = grams * (match[3] === 'l' ? 1000 : match[3] === 'cl' ? 10 : 1)
      grams = ml * cup.grams / 237
      assumption = [assumption, `Volume convertito in circa ${Math.round(grams)} g`].filter(Boolean).join(' · ')
    }
  } else if (ref) {
    const spoon = new RegExp(`^(${number})\\s*(cucchiaio|cucchiai|cucchiaino|cucchiaini)$`).exec(qty)
    if (spoon) {
      const portion = ref.portions.find(p => p.name === (spoon[2]!.startsWith('cucchiain') ? 'tsp' : 'tablespoon'))
      if (portion) grams = numeric(spoon[1]!) * portion.grams
    } else {
      const pieces = count.exec(qty)
      const supported = ['173944', '171688', '169118', '171287', '173424', '168153', '169097'].includes(ref.id)
      if (pieces && supported) {
        const size = pieces[2]?.startsWith('piccol') ? 'small' : pieces[2]?.startsWith('grand') ? 'large' : 'medium'
        const portion = ref.portions.find(p => p.name === size || p.name.startsWith(size + ' '))
          ?? (!pieces[2] && ref.portions.find(p => p.name === (ref.id === '171287' || ref.id === '173424' ? 'large' : 'fruit (2" dia)')))
        if (portion) grams = numeric(pieces[1]!) * portion.grams
      }
    }
    if (grams != null) assumption = `Porzione di riferimento: circa ${Math.round(grams)} g edibili`
  }
  if (grams === null || !validGrams(grams)) return unknown('Quantità non convertibile: indica grammi o una misura riconosciuta')
  return { ...base, kcal: grams * energy / 100, assumption, issue: null }
}

export function estimateFoods(foods: readonly MealFood[]): { energy: MealEnergy; foods: FoodEnergyEstimate[] } {
  const rows = foods.map(estimateFoodEnergy)
  const known = rows.filter(row => row.kcal !== null)
  return { energy: { version: 1, kcal: known.length ? Math.round(known.reduce((sum, row) => sum + row.kcal!, 0)) : null, missing: rows.length ? rows.length - known.length : 1 }, foods: rows }
}

export function foodsFromMeal(meal: Meal): MealFood[] {
  return meal.items.map((item, i) => { const parts = item.split(' · '); return { ...(parts.length === 2 ? { name: parts[0]!, quantity: parts[1]! } : { name: item, quantity: '' }), ...(meal.energyOverrides?.[i] != null ? { kcalPer100g: meal.energyOverrides[i] } : {}) } })
}
export function energyOfMeal(meal: Meal): MealEnergy { return meal.energy ?? estimateFoods(foodsFromMeal(meal)).energy }
export function isMealEnergy(value: unknown): value is MealEnergy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).every(k => ['version', 'kcal', 'missing'].includes(k)) && row.version === 1
    && (row.kcal === null || typeof row.kcal === 'number' && Number.isInteger(row.kcal) && row.kcal >= 0 && row.kcal <= 10000000)
    && typeof row.missing === 'number' && Number.isInteger(row.missing) && row.missing >= 0 && row.missing <= 60
}

/** Tutti i pasti della data, anche di menu precedenti: usa gli snapshot registrati. */
export function dailyEnergyBudget(date: string, meals: readonly Meal[], logs: Readonly<Record<string, MealLog>>, target?: number | null) {
  const planned = meals.map(energyOfMeal)
  const plannedKcal = planned.reduce((sum, energy) => sum + (energy.kcal ?? 0), 0)
  const plannedMissing = planned.reduce((sum, energy) => sum + energy.missing, 0)
  let consumed = 0, missing = 0
  for (const log of Object.values(logs)) if (log.date === date) {
    if (log.status === 'followed') { const energy = energyOfMeal(log.snapshot); consumed += energy.kcal ?? 0; missing += energy.missing }
    else if (log.status === 'modified') missing++
  }
  const goal = target ?? (meals.length && !plannedMissing ? plannedKcal : null)
  return { goal, explicitTarget: target != null, plannedKcal, plannedMissing, consumed, missing, remaining: goal === null ? null : Math.max(0, goal - consumed), excess: goal === null ? 0 : Math.max(0, consumed - goal) }
}
