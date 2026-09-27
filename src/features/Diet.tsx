import { useState } from 'react'
import { Icon } from '../components/Icon'
import type { IconName } from '../components/Icon'
import { mealStatuses } from '../domain/types'
import type { DayType, Meal, MealLog, MealStatus } from '../domain/types'
import { mealLogKey } from '../domain/diary'
import type { DiaryData } from '../domain/diary'

const mealIcons: IconName[] = ['sun', 'fork', 'cup', 'moon']

export function Diet({ date, state, meals, dayType, dayTypeHint, planTitle, planGuidance, dayOptions = [], selectedPlanDay = 0, onPlanDay, dayNote, onDayType, diaryNote }: {
  date: string
  state: DiaryData
  meals: Meal[]
  /** Tipo effettivo: annotato, dedotto dalla scheda settimanale o palestra. */
  dayType: DayType
  dayTypeHint?: string
  planTitle?: string
  planGuidance?: string
  dayOptions?: string[]
  selectedPlanDay?: number
  onPlanDay?: (index: number) => void
  dayNote?: string
  onDayType: (type: DayType) => void
  diaryNote: string
}) {
  const recorded = meals.filter(meal => { const status = state.mealLogs[mealLogKey(date, meal.id)]?.status; return status && status !== 'unrecorded' }).length
  const progress = meals.length ? Math.round(recorded / meals.length * 100) : 0
  const hasLogs = meals.some(meal => Boolean(state.mealLogs[mealLogKey(date, meal.id)]))
  return <>
    {(planTitle || dayOptions.length > 1) && <section className="panel diet-plan-heading">
      <span className="eyebrow">IL TUO PIANO</span>
      {planTitle && <h2>{planTitle}</h2>}
      {planGuidance && <details className="diet-guidance-toggle"><summary>Indicazioni del piano</summary><p>{planGuidance}</p></details>}
      {dayOptions.length > 1 && <label htmlFor="diet-plan-day">Giornata del piano<select id="diet-plan-day" value={selectedPlanDay} onChange={event => onPlanDay?.(Number(event.target.value))}>{dayOptions.map((name, index) => <option key={`${index}-${name}`} value={index}>{name}</option>)}</select></label>}
      {dayNote && <p className="small muted">{dayNote}</p>}
    </section>}
    <div className="content-grid"><section className="main-column" aria-labelledby="meals-title"><div className="section-heading"><h2 id="meals-title">I pasti del giorno</h2><span>{recorded} di {meals.length} registrati</span></div><div className="meal-list">{meals.map((meal, index) => {
      const log = state.mealLogs[mealLogKey(date, meal.id)]
      const status = log?.status ?? 'unrecorded'
      return <a key={meal.id} className="meal-card" href={`#/dieta/pasto/${meal.id}`}><span className={`meal-icon meal-icon-${index}`}><Icon name={mealIcons[index] ?? 'fork'} size={24} /></span><div className="meal-card-copy"><span className="mini-label">{meal.timeLabel}</span><h3>{meal.name}</h3><p>{meal.description}</p>{status !== 'unrecorded' && <span className={`status status-${status}`}>{status === 'followed' && <Icon name="check" size={13} />}{mealStatuses[status]}</span>}</div><Icon name="chevron" size={19} /></a>
    })}</div>
    {!meals.length && <section className="panel empty-state"><h3>Nessun pasto in questa giornata</h3><p>Aggiungi i pasti nel tuo piano alimentare.</p></section>}
    <p className="quiet-note"><Icon name="info" size={16} />Nessun pasto registrato significa solo che non l’hai ancora annotato. {diaryNote}</p></section>
    <aside className="side-column"><section className="panel"><span className="eyebrow">LA TUA GIORNATA</span><h3>Che ritmo hai oggi?</h3><div className="segmented" aria-label="Tipo di giornata"><button aria-pressed={dayType === 'training'} onClick={() => onDayType('training')}><Icon name="dumbbell" size={17} />Palestra</button><button aria-pressed={dayType === 'rest'} onClick={() => onDayType('rest')}><Icon name="leaf" size={17} />Riposo</button></div>{dayTypeHint && <p className="small muted">{dayTypeHint}</p>}{hasLogs && <p className="small">I pasti già annotati conservano il contesto originale.</p>}</section>
    <section className="panel progress-panel"><div className="section-heading"><h3>Il tuo diario</h3><Icon name="fork" size={18} /></div><div className="progress-display"><svg viewBox="0 0 110 110" aria-hidden="true"><circle cx="55" cy="55" r="46" fill="none" stroke="var(--border)" strokeWidth="6" /><circle cx="55" cy="55" r="46" fill="none" stroke="var(--action)" strokeWidth="6" strokeLinecap="round" strokeDasharray={`${progress * 2.89} 289`} transform="rotate(-90 55 55)" /></svg><div><strong>{recorded}<span> / {meals.length}</span></strong><span>pasti registrati</span></div></div><p className="muted small">Le annotazioni raccontano la giornata, senza dare voti.</p></section>
    </aside></div>
  </>
}

export function MealDetail({ meal, log, onSave, onClose }: { meal: Meal; log?: MealLog; onSave: (status: MealStatus, note: string) => void; onClose: () => void }) {
  const [status, setStatus] = useState<MealStatus>(log?.status ?? 'unrecorded')
  const [note, setNote] = useState(log?.note ?? '')
  return <form onSubmit={event => { event.preventDefault(); onSave(status, note); onClose() }}>
    <span className="eyebrow">IL TUO PASTO</span><h2>{meal.name}</h2><p className="muted">{meal.description}</p><ul className="food-list">{meal.items.map(item => <li key={item}><Icon name="check" size={16} />{item}</li>)}</ul>
    {(meal.alternatives?.length || meal.alternative) && <div className="detail-note"><strong>Alternative</strong>{meal.alternatives?.length ? <ul>{meal.alternatives.map(item => <li key={item}>{item}</li>)}</ul> : <p>{meal.alternative}</p>}</div>}
    {meal.additions && meal.additions.length > 0 && <div className="detail-note"><strong>Aggiunte previste</strong><ul>{meal.additions.map(item => <li key={item}>{item}</li>)}</ul></div>}
    <p className="muted small">{meal.note}</p>
    <fieldset className="status-fieldset"><legend>Come vuoi registrarlo?</legend><div className="status-options">{(Object.keys(mealStatuses) as MealStatus[]).map(value => <label key={value} className={status === value ? 'chosen' : ''}><input type="radio" name="meal-status" value={value} checked={status === value} onChange={() => setStatus(value)} />{mealStatuses[value]}</label>)}</div></fieldset>
    <label className="field-label" htmlFor="meal-note">{status === 'modified' ? 'Cosa è cambiato?' : 'Una nota, se ti va'}</label><textarea id="meal-note" value={note} maxLength={1500} rows={3} onChange={e => setNote(e.target.value)} placeholder="Aggiungi una nota…" /><button className="button primary full-width" type="submit">Salva pasto<Icon name="check" size={18} /></button>
  </form>
}
