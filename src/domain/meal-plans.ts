import { isExerciseId } from './exercises.ts'
import type { DayType, Meal } from './types.ts'
import type { ProgramCycle } from './programs.ts'
import { isLocalDate, shiftDate } from './dates.ts'
import { estimateFoods } from './food-energy.ts'
import { weekdayOfDate, weekdays } from './weekly.ts'

/** Documento V1 del piano alimentare, identico al contratto validato dal database. */
export interface MealFood { name: string; quantity: string; kcalPer100g?: number | null }
export interface PlanMeal { id: string; name: string; time: string; foods: MealFood[]; alternatives: string[]; additions: string[]; note: string }
export type PlanDayType = DayType | 'any'
export interface MealPlanDay { id: string; name: string; dayType: PlanDayType; note: string; meals: PlanMeal[] }
export interface MealPlanDocument { guidance: string; days: MealPlanDay[]; cycle?: ProgramCycle | null; dailyCalories?: number | null }
export interface MealPlan { id: string; name: string; document: MealPlanDocument; archivedAt: string | null; revision: number }
export interface MealPlanDraft { id: string; name: string; document: MealPlanDocument }

export const planDayTypes: Record<PlanDayType, string> = { training: 'Giorno di palestra', rest: 'Giorno di riposo', any: 'Qualsiasi giorno' }
export const mealPlanLimits = { days: 14, meals: 20, foods: 60, lines: 30 }
/**
 * Limite di salvataggio dall'editor. Il database accetta fino a 256 KiB nella forma
 * testuale jsonb (con spazi dopo `:` e `,`): qui si tiene un margine sul JSON compatto.
 */
export const MEAL_PLAN_MAX_BYTES = 180_000
export function mealPlanTooLarge(document: MealPlanDocument): string | null {
  return new TextEncoder().encode(JSON.stringify(document)).length > MEAL_PLAN_MAX_BYTES
    ? 'Il piano è troppo grande per essere salvato: riduci note, alternative o giornate.' : null
}

const uuid = () => crypto.randomUUID()
export function newMealPlan(): MealPlanDraft { return { id: uuid(), name: '', document: { guidance: '', days: [] } } }
export function newPlanDay(days: MealPlanDay[]): MealPlanDay {
  const dayType: PlanDayType = days.some(day => day.dayType === 'training') && !days.some(day => day.dayType === 'rest') ? 'rest' : days.length ? 'any' : 'training'
  return { id: uuid(), name: dayType === 'rest' ? 'Riposo' : dayType === 'training' ? 'Palestra' : `Giornata ${days.length + 1}`, dayType, note: '', meals: [] }
}
export function newPlanMeal(): PlanMeal { return { id: uuid(), name: '', time: '', foods: [], alternatives: [], additions: [], note: '' } }
export function duplicatePlanDay(day: MealPlanDay): MealPlanDay {
  return { ...structuredClone(day), id: uuid(), name: `${day.name} (copia)`.slice(0, 120), meals: day.meals.map(meal => ({ ...structuredClone(meal), id: uuid() })) }
}

const controlCharacters = /[\u0001-\u0008\u000B\u000C\u000E-\u001F\0]/
function text(value: unknown, max: number, required: boolean): value is string {
  return typeof value === 'string' && [...value].length <= max && (!required || value.trim() !== '') && !controlCharacters.test(value)
}
function lines(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= mealPlanLimits.lines && value.every(item => text(item, max, true))
}
function onlyKeys(value: object, keys: string[]) { return Object.keys(value).every(key => keys.includes(key)) }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }

/** Stessi vincoli del trigger SQL: proprietà sconosciute e testi vuoti sono errori. */
export function validateMealPlanDocument(value: unknown): string | null {
  if (!object(value) || !onlyKeys(value, ['guidance', 'days', 'cycle', 'dailyCalories']) || !text(value.guidance, 16000, false) || !Array.isArray(value.days)) return 'Documento del piano non valido.'
  if (value.cycle != null) {
    if (!object(value.cycle) || !onlyKeys(value.cycle, ['start', 'weeks']) || typeof value.cycle.start !== 'string' || !isLocalDate(value.cycle.start) || value.cycle.start < '1900-01-01' || value.cycle.start > '2100-12-31' || typeof value.cycle.weeks !== 'number' || !Number.isInteger(value.cycle.weeks) || value.cycle.weeks < 1 || value.cycle.weeks > 52) return 'Periodo del piano: indica una data valida e da 1 a 52 settimane.'
    if (shiftDate(value.cycle.start, value.cycle.weeks * 7 - 1) > '2100-12-31') return 'La fine del periodo supera la data consentita.'
  }
  if (value.dailyCalories != null && (typeof value.dailyCalories !== 'number' || !Number.isInteger(value.dailyCalories) || value.dailyCalories < 1 || value.dailyCalories > 20000)) return 'Obiettivo calorico: indica un numero intero da 1 a 20000 kcal, oppure lascia vuoto.'
  if (value.days.length > mealPlanLimits.days) return `Sono consentite al massimo ${mealPlanLimits.days} giornate.`
  const ids = new Set<string>()
  for (const [dayIndex, day] of value.days.entries()) {
    const label = `Giornata ${dayIndex + 1}`
    if (!object(day) || !onlyKeys(day, ['id', 'name', 'dayType', 'note', 'meals']) || typeof day.id !== 'string' || !isExerciseId(day.id) || ids.has(day.id)) return `${label}: riferimento non valido.`
    ids.add(day.id)
    if (!text(day.name, 120, true)) return `${label}: inserisci un nome fino a 120 caratteri.`
    if (!['training', 'rest', 'any'].includes(day.dayType as string)) return `${label}: scegli il tipo di giornata.`
    if (!text(day.note, 4000, false)) return `${label}: le note possono contenere al massimo 4000 caratteri.`
    if (!Array.isArray(day.meals) || day.meals.length > mealPlanLimits.meals) return `${label}: al massimo ${mealPlanLimits.meals} pasti.`
    for (const [mealIndex, meal] of day.meals.entries()) {
      const mealLabel = `${label}, pasto ${mealIndex + 1}`
      if (!object(meal) || !onlyKeys(meal, ['id', 'name', 'time', 'foods', 'alternatives', 'additions', 'note']) || typeof meal.id !== 'string' || !isExerciseId(meal.id) || ids.has(meal.id)) return `${mealLabel}: riferimento non valido.`
      ids.add(meal.id)
      if (!text(meal.name, 120, true)) return `${mealLabel}: inserisci un nome fino a 120 caratteri.`
      if (!text(meal.time, 60, false)) return `${mealLabel}: l’orario può contenere al massimo 60 caratteri.`
      if (!text(meal.note, 4000, false)) return `${mealLabel}: le note possono contenere al massimo 4000 caratteri.`
      if (!lines(meal.alternatives, 500) || !lines(meal.additions, 500)) return `${mealLabel}: alternative e aggiunte richiedono un testo fino a 500 caratteri (massimo ${mealPlanLimits.lines}).`
      if (!Array.isArray(meal.foods) || meal.foods.length > mealPlanLimits.foods) return `${mealLabel}: al massimo ${mealPlanLimits.foods} alimenti.`
      for (const food of meal.foods) {
        if (!object(food) || !onlyKeys(food, ['name', 'quantity', 'kcalPer100g']) || !text(food.name, 200, true) || !text(food.quantity, 60, false)) return `${mealLabel}: ogni alimento richiede un nome (quantità facoltativa, fino a 60 caratteri).`
        if (food.kcalPer100g != null && (typeof food.kcalPer100g !== 'number' || !Number.isFinite(food.kcalPer100g) || food.kcalPer100g < 0 || food.kcalPer100g > 1000)) return `${mealLabel}: energia dell’alimento da 0 a 1000 kcal per 100 g.`
      }
    }
  }
  return null
}

export function validateMealPlanDraft(draft: MealPlanDraft): string | null {
  if (!isExerciseId(draft.id)) return 'Riferimento del piano non valido.'
  if (!text(draft.name, 160, true) || draft.name !== draft.name.trim()) return 'Inserisci un nome del piano da 1 a 160 caratteri, senza spazi iniziali o finali.'
  return validateMealPlanDocument(draft.document)
}

/** Righe vuote dell'editor rimosse prima del salvataggio: nessun testo inventato. */
export function cleanMealPlanDraft(draft: MealPlanDraft): MealPlanDraft {
  const clean = (values: string[]) => values.map(value => value.trim()).filter(Boolean)
  return { ...draft, name: draft.name.trim(), document: { ...draft.document, guidance: draft.document.guidance, days: draft.document.days.map(day => ({ ...day, name: day.name.trim(), meals: day.meals.map(meal => ({
    ...meal, name: meal.name.trim(), time: meal.time.trim(), alternatives: clean(meal.alternatives), additions: clean(meal.additions),
    foods: meal.foods.map(food => ({ ...food, name: food.name.trim(), quantity: food.quantity.trim() })).filter(food => food.name || food.quantity),
  })) })) } }
}

export function sameMealPlan(a: MealPlanDraft, b: MealPlanDraft) {
  return a.id === b.id && a.name === b.name && JSON.stringify(a.document) === JSON.stringify(b.document)
}

/** Giornate del piano compatibili con il tipo scelto nel diario, nell'ordine del piano. */
export function daysForType(document: MealPlanDocument, type: DayType): MealPlanDay[] {
  const matching = document.days.filter(day => day.dayType === type || day.dayType === 'any')
  return matching.length ? matching : document.days
}

/** Menu del giorno della settimana indicato nel nome; per menu generici resta il primo compatibile. */
export function defaultMealPlanDay(days: MealPlanDay[], date: string): MealPlanDay | undefined {
  const weekday = weekdays[weekdayOfDate(date)]
  if (!weekday) return days[0]
  const normalize = (name: string) => name.trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('it').replace(/\.$/, '')
  const names = [normalize(weekday.name), normalize(weekday.code)]
  return days.find(day => names.includes(normalize(day.name))) ?? days[0]
}

/** Vista del pasto usata da schermate e snapshot del diario. */
export function mealFromPlan(meal: PlanMeal): Meal {
  return {
    id: meal.id, name: meal.name, timeLabel: meal.time, description: meal.foods.map(food => food.name).join(', ') || 'Nessun alimento indicato',
    items: meal.foods.map(food => food.quantity ? `${food.name} · ${food.quantity}` : food.name),
    alternative: '', alternatives: meal.alternatives, additions: meal.additions, note: meal.note, energy: estimateFoods(meal.foods).energy,
    ...(meal.foods.some(food => food.kcalPer100g != null) ? { energyOverrides: meal.foods.map(food => food.kcalPer100g ?? null) } : {}),
  }
}

/** Un piano entra nel wizard se ha giornate di allenamento/riposo oppure un'unica giornata per tutti i giorni. */
export function fitsMealWizard(document: MealPlanDocument): boolean {
  const types = document.days.map(day => day.dayType)
  return types.length === 0 || (types.length === 1 && ['any', 'training'].includes(types[0]!))
    || (types.length === 2 && types.includes('training') && types.includes('rest'))
}
