import type { Meal } from '../domain/types'
import breakfast from '../assets/meals/breakfast.svg'
import morningSnack from '../assets/meals/morning-snack.svg'
import lunch from '../assets/meals/lunch.svg'
import afternoonSnack from '../assets/meals/afternoon-snack.svg'
import dinner from '../assets/meals/dinner.svg'
import generic from '../assets/meals/meal.svg'

/** Nome e orario identificano l'illustrazione; l'ordine dei pasti non conta. */
function imageForMeal(meal: Pick<Meal, 'name' | 'timeLabel'>): string {
  const name = meal.name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  if (/colazion/.test(name)) return breakfast
  if (/pranzo/.test(name)) return lunch
  if (/cena/.test(name)) return dinner
  if (/meta\s*mattina|mezza\s*mattina|mattutin|spuntin.*mattin/.test(name)) return morningSnack
  if (/merend|pomerigg|pomeridian/.test(name)) return afternoonSnack
  if (/allenament|workout/.test(name)) return generic
  const time = /^\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(meal.timeLabel)
  const hour = time ? Number(time[1]) : null
  if (/spuntin|snack/.test(name)) return hour !== null && hour < 12 ? morningSnack : afternoonSnack
  if (hour !== null) return hour < 11 ? breakfast : hour < 15 ? lunch : hour < 18 ? afternoonSnack : dinner
  return generic
}

export function MealImage({ meal }: { meal: Pick<Meal, 'name' | 'timeLabel'> }) {
  return <img className="meal-image" src={imageForMeal(meal)} alt="" aria-hidden="true"
    width={64} height={64} decoding="async" />
}
