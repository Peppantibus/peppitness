import type { MealPlanDocument } from '../domain/meal-plans'
import { localDate, formatDate, isLocalDate, shiftDate } from '../domain/dates'
import { cycleDurations } from '../domain/progress'

/** Condiviso da wizard ed editor: nessun periodo o obiettivo imposto ai piani esistenti. */
export function MealPlanSettings({ document, onChange }: { document: MealPlanDocument; onChange: (document: MealPlanDocument) => void }) {
  const cycle = document.cycle
  const valid = cycle && isLocalDate(cycle.start) && Number.isInteger(cycle.weeks) && cycle.weeks >= 1 && cycle.weeks <= 52
  return <section className="meal-plan-settings" aria-label="Periodo e obiettivo alimentare">
    <label className="wz-check"><input type="checkbox" checked={Boolean(cycle)} onChange={e => onChange({ ...document, cycle: e.target.checked ? { start: localDate(), weeks: 8 } : null })} />Definisci il periodo del piano</label>
    {cycle && <><div className="program-day-names"><label htmlFor="meal-cycle-start">Data d’inizio<input id="meal-cycle-start" type="date" min="1900-01-01" max="2100-12-31" required value={cycle.start} onChange={e => onChange({ ...document, cycle: { ...cycle, start: e.target.value } })} /></label><label htmlFor="meal-cycle-weeks">Durata · settimane<input id="meal-cycle-weeks" type="number" min={1} max={52} required value={cycle.weeks || ''} onChange={e => onChange({ ...document, cycle: { ...cycle, weeks: Number(e.target.value) } })} /></label></div><div className="chip-row">{cycleDurations.map(weeks => <button type="button" key={weeks} className={`chip ${cycle.weeks === weeks ? 'is-selected' : ''}`} aria-pressed={cycle.weeks === weeks} onClick={() => onChange({ ...document, cycle: { ...cycle, weeks } })}>{weeks} settimane</button>)}</div>{valid && <p className="small muted">Termina il {formatDate(shiftDate(cycle.start, cycle.weeks * 7 - 1), { day: 'numeric', month: 'long', year: 'numeric' })}.</p>}</>}
    <label htmlFor="meal-daily-calories">Obiettivo giornaliero · kcal (facoltativo)<input id="meal-daily-calories" type="number" min={1} max={20000} step={1} placeholder="Es. 2000" value={document.dailyCalories ?? ''} onChange={e => onChange({ ...document, dailyCalories: e.target.value === '' ? null : Number(e.target.value) })} /></label>
    <p className="small muted">Imposta l’obiettivo del tuo piano. Se lasci vuoto, il riferimento è la somma dei pasti del menu, quando la stima è completa.</p>
  </section>
}
