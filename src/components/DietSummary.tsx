import type { MealPlanDocument } from '../domain/meal-plans'
import type { DiaryData } from '../domain/diary'
import type { Meal } from '../domain/types'
import { cycleInfo } from '../domain/progress'
import { formatDate } from '../domain/dates'
import { dailyEnergyBudget } from '../domain/food-energy'
import { Icon } from './Icon'

export function DietSummary({ date, document, meals, state }: { date: string; document: MealPlanDocument; meals: Meal[]; state: DiaryData }) {
  const period = document.cycle ? cycleInfo(document.cycle, date) : null
  const budget = dailyEnergyBudget(date, meals, state.mealLogs, document.dailyCalories)
  return <>
    <section className={`diet-period ${period?.status === 'finished' ? 'is-finished' : ''}`} aria-label="Periodo del piano alimentare">
      <strong>{!period ? 'Periodo non impostato' : period.status === 'active' ? `Settimana ${period.week} di ${period.weeks}` : period.status === 'upcoming' ? 'Piano non ancora iniziato' : 'Periodo del piano concluso'}</strong>
      {period && <p>{formatDate(period.start, { day: 'numeric', month: 'short', year: 'numeric' })} – {formatDate(period.end, { day: 'numeric', month: 'short', year: 'numeric' })}</p>}
      {(!period || period.status !== 'active') && <a className="text-link" href="#/dieta/piani">{period?.status === 'finished' ? 'Aggiorna il periodo o scegli un nuovo piano' : period ? 'Gestisci il piano' : 'Imposta il periodo'}</a>}
    </section>
    <section className="diet-energy" aria-label="Calorie della giornata">
      <div className="diet-energy-head"><span>Calorie della giornata</span><span>{budget.goal === null ? 'Riferimento da completare' : `${budget.goal} kcal ${budget.explicitTarget ? 'obiettivo' : 'dal menu'}`}</span></div>
      <div className="diet-energy-numbers" aria-live="polite"><div><strong>{budget.remaining === null ? '—' : `≈ ${budget.remaining}`}</strong><span>kcal rimanenti{budget.missing ? ' · parziale' : ''}</span></div><div><strong>≈ {budget.consumed}</strong><span>kcal dai pasti seguiti</span></div></div>
      {budget.goal !== null && budget.goal > 0 && <progress max={budget.goal} value={Math.min(budget.goal, budget.consumed)} aria-label="Calorie conteggiate rispetto all’obiettivo" />}
      {budget.missing > 0 && <p className="small muted">Stima parziale: alcuni pasti non sono quantificati.</p>}
      {budget.excess > 0 && <p className="small muted">Circa {budget.excess} kcal oltre il riferimento.</p>}
      <details className="energy-details"><summary aria-label="Come funziona il conteggio" title="Come funziona il conteggio"><Icon name="info" size={16} /></summary><p className="small muted">Menu: {budget.plannedKcal ? `≈ ${budget.plannedKcal} kcal` : 'stima da completare'}{budget.plannedMissing && budget.plannedKcal ? ' · parziale' : ''}.</p><p className="small muted">La spunta Seguito aggiunge la stima del pasto; togliendola o annullando la registrazione, la rimuovi. Saltato non aggiunge calorie. Modificato resta da quantificare, quindi il residuo è parziale. Il conteggio usa i pasti registrati in questa data, anche se cambi menu. Sono stime energetiche, senza modificare gli alimenti previsti.</p>{document.dailyCalories == null && <a className="text-link" href="#/dieta/piani">Imposta un obiettivo giornaliero</a>}</details>
    </section>
  </>
}
