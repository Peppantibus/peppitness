import { useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { MealImage } from '../components/MealImage'
import { DietSummary } from '../components/DietSummary'
import { FoodEnergyPreview } from '../components/FoodEnergyPreview'
import { energyOfMeal, foodsFromMeal } from '../domain/food-energy'
import type { MealPlanDocument } from '../domain/meal-plans'
import { Segmented } from '../components/Segmented'
import type { IconName } from '../components/Icon'
import { mealStatuses } from '../domain/types'
import type { DayType, Meal, MealLog, MealStatus } from '../domain/types'
import { mealLogKey } from '../domain/diary'
import type { DiaryData } from '../domain/diary'

const statusIcons: Record<Exclude<MealStatus, 'unrecorded'>, IconName> = { followed: 'check', modified: 'edit', skipped: 'skip' }
const recordStatuses = ['followed', 'modified', 'skipped'] as const

/** Mostra i testi salvati, enfatizzando solo la quantità già separata da « · ». */
function MealFoodPreview({ items }: { items: readonly string[] }) {
  return <ul className="meal-food-preview">{items.map((item, index) => {
    const parts = item.split(' · ')
    return <li key={`${index}-${item}`}><span>{parts.length === 2 && parts.every(Boolean)
      ? <>{parts[0]}{' · '}<strong>{parts[1]}</strong></> : item}</span></li>
  })}</ul>
}

export function Diet({ date, isToday, state, meals, dayType, dayTypeHint, planTitle, planGuidance, planDocument, dayOptions = [], selectedPlanDay = 0, onPlanDay, dayNote, onDayType, onQuickFollow }: {
  date: string
  /** Solo oggi il primo pasto non registrato viene indicato come «prossimo». */
  isToday: boolean
  state: DiaryData
  meals: Meal[]
  /** Tipo effettivo: annotato, dedotto dalla scheda settimanale o palestra. */
  dayType: DayType
  dayTypeHint?: string
  planTitle?: string
  planGuidance?: string
  planDocument?: MealPlanDocument
  dayOptions?: string[]
  selectedPlanDay?: number
  onPlanDay?: (index: number) => void
  dayNote?: string
  onDayType: (type: DayType) => void
  /** Registrazione rapida: segna «Seguito» oppure la toglie con un solo tocco. */
  onQuickFollow: (meal: Meal) => void
}) {
  const statusOf = (meal: Meal) => state.mealLogs[mealLogKey(date, meal.id)]?.status ?? 'unrecorded'
  const recorded = meals.filter(meal => statusOf(meal) !== 'unrecorded').length
  const hasLogs = meals.some(meal => Boolean(state.mealLogs[mealLogKey(date, meal.id)]))
  const nextId = isToday ? meals.find(meal => statusOf(meal) === 'unrecorded')?.id : undefined
  // Su desktop largo il contesto della giornata sta in una colonna a sinistra, i pasti a destra.
  return <div className="diet-layout">
    <div className="diet-context">
    {planDocument && <DietSummary date={date} document={planDocument} meals={meals} state={state} />}
    {/* Il tipo di giornata decide quali pasti compaiono: viene prima dell'elenco. */}
    <section className="day-type" aria-labelledby="day-type-title">
      <div className="day-type-row">
        <h2 id="day-type-title">Giornata</h2>
        <Segmented labelledBy="day-type-title" value={dayType === 'rest' ? 'rest' : 'training'} onChange={onDayType} options={[{ value: 'training', label: 'Palestra', icon: 'dumbbell' }, { value: 'rest', label: 'Riposo', icon: 'leaf' }]} />
      </div>
      {(dayTypeHint || hasLogs) && <p className="day-type-hint">{dayTypeHint}{dayTypeHint && hasLogs ? ' ' : ''}{hasLogs && 'I pasti già annotati conservano il contesto originale.'}</p>}
    </section>
    {/* Piano seguito in una riga: indicazioni e variante del menu solo se esistono. */}
    {(planTitle || dayOptions.length > 1) && <section className="diet-plan-line" aria-label="Piano alimentare seguito">
      {planTitle && <span className="diet-plan-name"><Icon name="fork" size={16} /><span>{planTitle}</span></span>}
      {planGuidance && <details className="diet-guidance-toggle"><summary>Indicazioni<Icon name="chevronDown" size={16} /></summary><p>{planGuidance}</p></details>}
      {dayOptions.length > 1 && <label className="diet-plan-day" htmlFor="diet-plan-day">Menu<select id="diet-plan-day" value={selectedPlanDay} onChange={event => onPlanDay?.(Number(event.target.value))}>{dayOptions.map((name, index) => <option key={`${index}-${name}`} value={index}>{name}</option>)}</select></label>}
      {dayNote && <p className="diet-plan-note">{dayNote}</p>}
    </section>}
    </div>
    <section className="meals-section" aria-labelledby="meals-title">
      <div className="section-heading"><h2 id="meals-title">I pasti del giorno</h2><span>{recorded} di {meals.length} registrati</span></div>
      {meals.length > 0 && <div className="day-progress" aria-hidden="true">{meals.map(meal => <span key={meal.id} className={statusOf(meal) !== 'unrecorded' ? 'is-filled' : ''} />)}</div>}
      <div className="meal-list">{meals.map(meal => {
        const status = statusOf(meal)
        const isNext = meal.id === nextId
        const energy = energyOfMeal(state.mealLogs[mealLogKey(date, meal.id)]?.snapshot ?? meal)
        return <div key={meal.id} className={`meal-card ${status !== 'unrecorded' ? 'is-recorded' : ''} ${isNext ? 'is-next' : ''}`}>
          <a className="meal-card-link" href={`#/dieta/pasto/${meal.id}`}>
            <div className="meal-card-heading"><MealImage meal={meal} /><div className="meal-card-copy"><span className="mini-label">{isNext && <span className="next-label">Prossimo</span>}{meal.timeLabel}</span><h3>{meal.name}</h3>{status !== 'unrecorded' && <span className={`status status-${status}`}>{status === 'followed' && <Icon name="check" size={16} />}{mealStatuses[status]}</span>}</div></div>
            <p className="meal-kcal">{energy.kcal === null ? 'Calorie da stimare' : `≈ ${energy.kcal} kcal`}{energy.kcal !== null && energy.missing ? ' · parziale' : ''}{status === 'modified' && ' · pasto modificato da quantificare'}</p>
            {meal.items.length ? <MealFoodPreview items={meal.items} /> : <p className="meal-food-empty">{meal.description}</p>}
          </a>
          {status === 'unrecorded' || status === 'followed'
            ? <button type="button" className={`meal-quick ${status === 'followed' ? 'is-done' : ''}`} aria-pressed={status === 'followed'} aria-label={`${meal.name}: seguito`} title={status === 'followed' ? 'Togli «Seguito»' : 'Segna come seguito'} onClick={() => onQuickFollow(meal)}><Icon name="check" size={20} /></button>
            : <span className={`meal-quick is-static status-${status}`} aria-hidden="true"><Icon name={statusIcons[status]} size={20} /></span>}
        </div>
      })}</div>
      {!meals.length && <section className="panel empty-state"><h3>Nessun pasto in questa giornata</h3><p>Aggiungi i pasti nel tuo piano alimentare.</p></section>}
      {meals.length > 0 && recorded === 0 && <p className="quiet-note"><Icon name="info" size={16} />Tocca la spunta quando segui un pasto. Nessuna registrazione significa solo che non l’hai ancora annotato.</p>}
    </section>
  </div>
}

export function MealDetail({ meal, log, onSave, onClose }: { meal: Meal; log?: MealLog; onSave: (status: MealStatus, note: string) => void; onClose: () => void }) {
  const recorded = log && log.status !== 'unrecorded' ? log.status : null
  const [status, setStatus] = useState<MealStatus | null>(recorded)
  const [note, setNote] = useState(log?.note ?? '')
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const choose = (value: MealStatus) => { setStatus(value); if (value === 'modified') window.requestAnimationFrame(() => noteRef.current?.focus()) }
  return <form onSubmit={event => { event.preventDefault(); if (!status) return; onSave(status, note); onClose() }}>
    {meal.timeLabel && <span className="eyebrow">{meal.timeLabel}</span>}<h2>{meal.name}</h2><p className="muted">{meal.description}</p><ul className="food-list">{meal.items.map(item => <li key={item}><Icon name="check" size={16} />{item}</li>)}</ul>
    <FoodEnergyPreview foods={foodsFromMeal(meal)} />
    {(meal.alternatives?.length || meal.alternative) && <div className="detail-note"><strong>Alternative</strong>{meal.alternatives?.length ? <ul>{meal.alternatives.map(item => <li key={item}>{item}</li>)}</ul> : <p>{meal.alternative}</p>}</div>}
    {meal.additions && meal.additions.length > 0 && <div className="detail-note"><strong>Aggiunte previste</strong><ul>{meal.additions.map(item => <li key={item}>{item}</li>)}</ul></div>}
    <p className="muted small">{meal.note}</p>
    <fieldset className="status-fieldset"><legend>Come è andato?</legend><div className="status-options">{recordStatuses.map(value => <label key={value} className={`status-option status-option-${value} ${status === value ? 'chosen' : ''}`}><input type="radio" name="meal-status" value={value} checked={status === value} onChange={() => choose(value)} /><span className="status-option-icon"><Icon name={statusIcons[value]} size={20} /></span>{mealStatuses[value]}</label>)}</div></fieldset>
    <label className="field-label" htmlFor="meal-note">{status === 'modified' ? 'Cosa è cambiato?' : 'Una nota, se ti va'}</label><textarea ref={noteRef} id="meal-note" value={note} maxLength={1500} rows={3} onChange={e => setNote(e.target.value)} placeholder={status === 'modified' ? 'Per esempio: pasta al posto del riso' : 'Aggiungi una nota…'} />
    <button className="button primary full-width" type="submit" disabled={!status}>Salva pasto<Icon name="check" size={20} /></button>
    {recorded && <button type="button" className="text-button meal-unrecord" onClick={() => { onSave('unrecorded', note); onClose() }}>Annulla registrazione</button>}
  </form>
}
