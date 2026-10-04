import { Icon } from '../components/Icon'
import type { Meal } from '../domain/types'
import { Diet } from '../features/Diet'
import type { DiaryState, DiaryStore } from '../persistence/diary-store'
import type { PlansState, PlansStore } from '../persistence/plans-store'
import type { DietToday as Menu } from './use-diet-today'

interface Props {
  configured: boolean
  plans: { store: PlansStore | null; state: PlansState }
  diary: { store: DiaryStore; state: DiaryState }
  menu: Menu
  date: string
  today: string
  onQuickFollow: (meal: Meal) => void
}

/** Contenuto quotidiano della Dieta: caricamento, scelta del piano o pasti del giorno. */
export function DietToday({ configured, plans, diary, menu, date, today, onQuickFollow }: Props) {
  const { state } = plans
  const { mealPlan, followableMeals, candidateDays, planDay } = menu
  if (configured && state.phase === 'loading') return <section className="panel empty-state" role="status"><h2>Caricamento del piano…</h2></section>
  if (configured && state.phase === 'error') return <section className="panel empty-state"><h2>Piano non disponibile</h2><p role="alert">{state.message}</p><button className="button primary" onClick={() => void plans.store?.load()}>Riprova</button></section>
  if (configured && !mealPlan) return <section className="panel empty-state plan-empty">
    {followableMeals.length ? <>
      <h2>Scegli il piano alimentare da seguire</h2>
      <div className="plan-choices">{followableMeals.map(plan => <button key={plan.id} className="button secondary plan-choice" disabled={state.selecting} onClick={() => void plans.store?.choose({ mealPlanId: plan.id })}>{plan.name}</button>)}</div>
    </> : <>
      <span className="empty-icon"><Icon name="fork" size={32} /></span><h2>Nessun piano alimentare</h2><p>Inserisci i pasti dei giorni di allenamento e di riposo: comparirà qui.</p>
      <a className="button primary" href="#/dieta/piani/nuovo">Crea il tuo piano<Icon name="arrow" size={20} /></a><a className="text-link" href="#/dieta/importa">Oppure importalo dal modello Word</a>
    </>}
  </section>
  return <>
    {configured && followableMeals.length > 1 && <section className="plan-selectors"><label className="plan-selector">Piano seguito
      <select value={mealPlan?.id ?? ''} disabled={state.selecting} onChange={event => void plans.store?.choose({ mealPlanId: event.target.value })}>
        {followableMeals.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
      </select></label></section>}
    <Diet date={date} isToday={date === today} state={diary.state.view} meals={menu.meals} dayType={menu.dayType} dayTypeHint={menu.dayTypeHint}
      planTitle={mealPlan?.name} planGuidance={mealPlan?.document.guidance || undefined} planDocument={mealPlan?.document}
      dayOptions={candidateDays.length > 1 ? candidateDays.map(item => item.name) : []} selectedPlanDay={Math.max(0, candidateDays.findIndex(item => item.id === planDay?.id))}
      onPlanDay={menu.selectPlanDay} dayNote={planDay?.note || undefined}
      onDayType={type => diary.store.setDayType(date, type)} onQuickFollow={onQuickFollow} />
  </>
}
