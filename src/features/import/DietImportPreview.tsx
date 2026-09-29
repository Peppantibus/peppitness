import { Icon } from '../../components/Icon'
import { mealFromPlan, mealPlanLimits, MEAL_PLAN_MAX_BYTES, planDayTypes } from '../../domain/meal-plans.ts'
import type { MappingResult } from '../../import/contracts/index.ts'
import type { DietMapping } from '../../import/mapping/diet.ts'
import { formatNumber, mappingOnlyIssues } from './review-model'
import './review.css'
import './diet-review.css'

/** Riga di nota che il mapper 10 ha trasferito da un alimento al pasto («Nome (alimento n): …»). */
const FOOD_NOTE = /^(.+) \(alimento (\d+)\): /

/**
 * Anteprima del piano alimentare che verrebbe salvato (task 13): solo dal risultato del mapper 10 e dalla vista
 * del dominio (`mealFromPlan`, la stessa del diario), completa di indicazioni, regole dell'intero piano, note,
 * alternative e aggiunte. Le alternative e le aggiunte restano separate dagli alimenti del pasto base: non si
 * sommano. Mostra anche la dimensione del documento rispetto al limite, senza tagli.
 */
export function DietImportPreview({ mapping }: { mapping: MappingResult<DietMapping> }) {
  if (!mapping.ok) {
    const blocking = mapping.issues.filter(issue => issue.severity === 'blocking').length
    return <section className="panel dr-preview" aria-labelledby="dr-preview-title">
      <h2 id="dr-preview-title">Anteprima del piano</h2>
      <p className="rv-status is-blocked"><Icon name="alert" size={20} />L’anteprima compare quando la revisione non ha più problemi da risolvere ({blocking} {blocking === 1 ? 'aperto' : 'aperti'}{mappingOnlyIssues(mapping).length ? ', compresi quantità, pasti o regole da completare' : ''}).</p>
    </section>
  }
  const { plan } = mapping.value
  const bytes = new TextEncoder().encode(JSON.stringify(plan.document)).length
  const meals = plan.document.days.reduce((total, day) => total + day.meals.length, 0)
  return <section className="panel dr-preview" aria-labelledby="dr-preview-title" data-preview="diet">
    <h2 id="dr-preview-title">Anteprima del piano</h2>
    <p className="small muted">Così verrà salvato e mostrato nel diario, dopo la conferma. Nessun calcolo nutrizionale.</p>
    <h3 className="dr-preview-name">{plan.name}</h3>
    <ul className="dr-preview-facts">
      <li>{plan.document.days.length} {plan.document.days.length === 1 ? 'giornata' : 'giornate'} (massimo {mealPlanLimits.days}) · {meals} {meals === 1 ? 'pasto' : 'pasti'}</li>
      <li data-bytes={bytes}>Dimensione: {formatNumber(bytes)} di {formatNumber(MEAL_PLAN_MAX_BYTES)} byte</li>
    </ul>
    {plan.document.guidance && <div className="dr-preview-guidance"><h4>Indicazioni e regole dell’intero piano</h4><p>{plan.document.guidance}</p></div>}
    <ol className="dr-preview-days">{plan.document.days.map(day => <li key={day.id} className="dr-preview-day" data-day={day.id}>
      <h4>{day.name} <span className="rv-badge is-neutral">{planDayTypes[day.dayType]}</span></h4>
      {day.note && <p className="dr-preview-note">{day.note}</p>}
      <ol className="dr-preview-meals">{day.meals.map(meal => {
        const view = mealFromPlan(meal)
        const alternatives = view.alternatives ?? [], additions = view.additions ?? []
        return <li key={meal.id} className="dr-preview-meal" data-meal={meal.id}>
          <div className="dr-preview-head"><strong>{view.name}</strong>{view.timeLabel && <span className="small muted">{view.timeLabel}</span>}</div>
          {view.items.length > 0 ? <ul className="dr-preview-foods" aria-label="Alimenti del pasto base">{view.items.map((item, index) => <li key={index}>{item}</li>)}</ul>
            : <p className="small muted">Nessun alimento nel pasto base: vedi le opzioni.</p>}
          {alternatives.length > 0 && <div className="dr-preview-block is-alternatives"><h5>Alternative · non si sommano al pasto base</h5><ul>{alternatives.map((line, index) => <li key={index}>{line}</li>)}</ul></div>}
          {additions.length > 0 && <div className="dr-preview-block is-additions"><h5>Aggiunte con condizione</h5><ul>{additions.map((line, index) => <li key={index}>{line}</li>)}</ul></div>}
          {view.note && <div className="dr-preview-block"><h5>Note</h5><ul className="dr-preview-notes">{view.note.split('\n').map((line, index) => {
            const food = FOOD_NOTE.exec(line)
            return <li key={index} className={food ? 'is-food-note' : undefined}>{food && <span className="rv-badge is-neutral">Nota dell’alimento {food[2]}</span>} {line}</li>
          })}</ul></div>}
        </li>
      })}</ol>
    </li>)}</ol>
  </section>
}
