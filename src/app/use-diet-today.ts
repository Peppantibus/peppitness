import { useMemo, useState } from 'react'
import { demoMeals } from '../data/demo'
import { weekDates } from '../domain/dates'
import type { DiaryData } from '../domain/diary'
import { daysForType, defaultMealPlanDay, mealFromPlan } from '../domain/meal-plans'
import type { MealPlan } from '../domain/meal-plans'
import type { DayType } from '../domain/types'

/**
 * Dieta della data mostrata: giornata del piano seguito compatibile con il tipo di giornata.
 * Il tipo è quello annotato; altrimenti la scheda settimanale seguita; altrimenti palestra.
 * La giornata scelta a mano vale per piano, data e tipo, solo in memoria.
 */
export function useDietToday({ configured, mealPlans, mealPlanId, view, date, programDayType }: {
  configured: boolean; mealPlans: MealPlan[]; mealPlanId: string | null | undefined
  view: DiaryData; date: string; programDayType: DayType | undefined
}) {
  const [planDayChoice, setPlanDayChoice] = useState<Record<string, string>>({})
  const mealPlan = configured ? mealPlans.find(plan => plan.id === mealPlanId && !plan.archivedAt) : undefined
  const dayType = view.dayTypes[date] ?? programDayType ?? 'training'
  const candidateDays = mealPlan ? daysForType(mealPlan.document, dayType) : []
  const choiceKey = `${mealPlan?.id ?? 'local'}:${date}:${dayType}`
  const planDay = candidateDays.find(item => item.id === planDayChoice[choiceKey]) ?? defaultMealPlanDay(candidateDays, date)
  const planMeals = planDay?.meals
  const meals = useMemo(() => configured ? planMeals?.map(mealFromPlan) ?? [] : demoMeals, [configured, planMeals])
  return {
    mealPlan, dayType, candidateDays, planDay, meals,
    followableMeals: mealPlans.filter(plan => !plan.archivedAt),
    selectPlanDay: (index: number) => { const day = candidateDays[index]; if (day) setPlanDayChoice(current => ({ ...current, [choiceKey]: day.id })) },
    /** Suggerimento mostrato quando il tipo non è annotato ma viene dalla scheda. */
    dayTypeHint: !view.dayTypes[date] && programDayType ? `Dalla tua scheda: ${programDayType === 'rest' ? 'giorno di riposo' : 'giorno di allenamento'}. Puoi cambiarlo.` : undefined,
    // Giorni della settimana mostrata con pasti annotati.
    mealDates: weekDates(date).filter(value => Object.values(view.mealLogs).some(log => log.date === value && log.status !== 'unrecorded')),
  }
}
export type DietToday = ReturnType<typeof useDietToday>
