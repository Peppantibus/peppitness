import type { MealPlanDocument } from '../domain/meal-plans'
import { cycleInfo } from '../domain/progress'
import { formatDate, localDate } from '../domain/dates'

export function MealPlanMetadata({ document }: { document: MealPlanDocument }) {
  const period = document.cycle ? cycleInfo(document.cycle, localDate()) : null
  return <p className="small muted meal-plan-metadata">{period ? <>{formatDate(period.start, { day: 'numeric', month: 'short', year: 'numeric' })} – {formatDate(period.end, { day: 'numeric', month: 'short', year: 'numeric' })} · {period.status === 'active' ? `Settimana ${period.week} di ${period.weeks}` : period.status === 'upcoming' ? 'Da iniziare' : 'Periodo concluso'}</> : 'Periodo non impostato'}{document.dailyCalories != null && <> · Obiettivo {document.dailyCalories} kcal/giorno</>}</p>
}
