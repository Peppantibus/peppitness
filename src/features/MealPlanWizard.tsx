import { useEffect, useRef, useState } from 'react'
import { MealPlanSettings } from '../components/MealPlanSettings'
import { FoodEnergyPreview } from '../components/FoodEnergyPreview'
import { MealPlanMetadata } from '../components/MealPlanMetadata'
import type { ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { mealPlanLimits, newPlanMeal } from '../domain/meal-plans'
import type { MealPlanDay, PlanMeal } from '../domain/meal-plans'
import { moveItem } from '../domain/programs'
import type { PlansState, PlansStore } from '../persistence/plans-store'

export type MealWizardStep = 'name' | 'training' | 'rest' | 'done'
const mealNames = ['Colazione', 'Spuntino', 'Pranzo', 'Merenda', 'Cena', 'Pre-allenamento', 'Post-allenamento']
const lines = (value: string) => value.split('\n')

function MealCard({ meal, index, count, onChange, onMove, onRemove }: {
  meal: PlanMeal; index: number; count: number; onChange: (meal: PlanMeal) => void; onMove: (direction: -1 | 1) => void; onRemove: () => void
}) {
  const food = useRef<HTMLInputElement>(null)
  return <article className="wz-meal" aria-label={meal.name || `Pasto ${index + 1}`}>
    <div className="wz-meal-head">
      <label htmlFor={`${meal.id}-name`} className="sr-only">Nome del pasto</label>
      <input id={`${meal.id}-name`} className="wz-meal-name" maxLength={120} placeholder="Nome del pasto" value={meal.name} onChange={event => onChange({ ...meal, name: event.target.value })} />
      <label htmlFor={`${meal.id}-time`} className="sr-only">Orario (facoltativo)</label>
      <input id={`${meal.id}-time`} className="wz-meal-time" maxLength={60} placeholder="Orario" value={meal.time} onChange={event => onChange({ ...meal, time: event.target.value })} />
      <div className="wz-exercise-tools">
        <button type="button" className="icon-button" disabled={index === 0} aria-label={`Sposta su ${meal.name || 'pasto'}`} onClick={() => onMove(-1)}><Icon name="back" size={16} style={{ transform: 'rotate(90deg)' }} /></button>
        <button type="button" className="icon-button" disabled={index === count - 1} aria-label={`Sposta giù ${meal.name || 'pasto'}`} onClick={() => onMove(1)}><Icon name="back" size={16} style={{ transform: 'rotate(-90deg)' }} /></button>
        <button type="button" className="icon-button" aria-label={`Rimuovi ${meal.name || 'pasto'}`} onClick={onRemove}><Icon name="close" size={16} /></button>
      </div>
    </div>
    <ul className="wz-foods">{meal.foods.map((item, position) => <li key={position} className="meal-food-row">
      <label htmlFor={`${meal.id}-food-${position}`} className="sr-only">Alimento {position + 1}</label>
      <input ref={position === meal.foods.length - 1 ? food : undefined} id={`${meal.id}-food-${position}`} className="meal-food-name" maxLength={200} placeholder="Alimento" value={item.name} onChange={event => onChange({ ...meal, foods: meal.foods.map((value, i) => i === position ? { ...value, name: event.target.value } : value) })} />
      <label htmlFor={`${meal.id}-qty-${position}`} className="sr-only">Quantità alimento {position + 1}</label>
      <input id={`${meal.id}-qty-${position}`} className="meal-food-quantity" maxLength={60} placeholder="Quantità" value={item.quantity} onChange={event => onChange({ ...meal, foods: meal.foods.map((value, i) => i === position ? { ...value, quantity: event.target.value } : value) })} />
      <button type="button" className="icon-button" aria-label={`Rimuovi alimento ${position + 1}`} onClick={() => onChange({ ...meal, foods: meal.foods.filter((_, i) => i !== position) })}><Icon name="close" size={16} /></button>
    </li>)}</ul>
    <button type="button" className="text-button wz-add-food" disabled={meal.foods.length >= mealPlanLimits.foods} onClick={() => { onChange({ ...meal, foods: [...meal.foods, { name: '', quantity: '' }] }); setTimeout(() => food.current?.focus(), 0) }}><Icon name="plus" size={16} />Aggiungi alimento</button>
    <FoodEnergyPreview foods={meal.foods} onChange={foods => onChange({ ...meal, foods })} />
    <details className="wz-more">
      <summary>Alternative, aggiunte e note</summary>
      <label htmlFor={`${meal.id}-alternatives`}>Alternative · una per riga<textarea id={`${meal.id}-alternatives`} rows={2} placeholder="Es. pane e ricotta al posto dello yogurt" value={meal.alternatives.join('\n')} onChange={event => onChange({ ...meal, alternatives: lines(event.target.value) })} /></label>
      <label htmlFor={`${meal.id}-additions`}>Aggiunte previste · una per riga<textarea id={`${meal.id}-additions`} rows={2} placeholder="Es. +1 frutto se ti alleni la sera" value={meal.additions.join('\n')} onChange={event => onChange({ ...meal, additions: lines(event.target.value) })} /></label>
      <label htmlFor={`${meal.id}-note`}>Note<textarea id={`${meal.id}-note`} rows={2} maxLength={4000} value={meal.note} onChange={event => onChange({ ...meal, note: event.target.value })} /></label>
    </details>
  </article>
}

function MealsEditor({ day, onChange, disabled }: { day: MealPlanDay; onChange: (day: MealPlanDay) => void; disabled: boolean }) {
  const add = (name: string) => onChange({ ...day, meals: [...day.meals, { ...newPlanMeal(), name, foods: [{ name: '', quantity: '' }] }] })
  return <fieldset className="wz-meals" disabled={disabled}>
    <legend className="sr-only">Pasti</legend>
    {day.meals.map((meal, index) => <MealCard key={meal.id} meal={meal} index={index} count={day.meals.length}
      onChange={value => onChange({ ...day, meals: day.meals.map(item => item.id === meal.id ? value : item) })}
      onMove={direction => onChange({ ...day, meals: moveItem(day.meals, index, direction) })}
      onRemove={() => onChange({ ...day, meals: day.meals.filter(item => item.id !== meal.id) })} />)}
    <div className="wz-add-meal"><span>{day.meals.length ? 'Aggiungi un altro pasto' : 'Da quale pasto parti?'}</span>
      <div className="chip-row">{mealNames.map(name => <button key={name} type="button" className="chip" disabled={day.meals.length >= mealPlanLimits.meals} onClick={() => add(name)}><Icon name="plus" size={16} />{name}</button>)}<button type="button" className="chip" disabled={day.meals.length >= mealPlanLimits.meals} onClick={() => add('')}><Icon name="plus" size={16} />Altro</button></div>
    </div>
  </fieldset>
}

const copyMeals = (meals: PlanMeal[]) => meals.map(meal => ({ ...structuredClone(meal), id: crypto.randomUUID() }))

export function MealPlanWizard({ store, state, step, setStep, onAdvanced, onExit }: {
  store: PlansStore; state: PlansState; step: MealWizardStep; setStep: (step: MealWizardStep) => void; onAdvanced: () => void; onExit: () => void
}) {
  const editor = state.editor, draft = editor.draft
  const [confirm, setConfirm] = useState<{ title: string; text: string; action: () => void } | null>(null)
  const [saving, setSaving] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const [editing] = useState(() => Boolean(state.editor.base))
  useEffect(() => { heading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0 }) }, [step])
  if (!draft) return null
  const busy = saving || ['saving', 'checking'].includes(editor.phase)
  const days = draft.document.days
  const training = days.find(day => day.dayType === 'training' || day.dayType === 'any')
  const restDay = days.find(day => day.dayType === 'rest')
  const everyDay = training?.dayType === 'any'
  const setDays = (next: MealPlanDay[]) => store.editMealPlan({ ...draft, document: { ...draft.document, days: next } })
  const setDay = (value: MealPlanDay) => setDays([...days.filter(day => day.id !== value.id), value].sort((a, b) => (a.dayType === 'rest' ? 1 : 0) - (b.dayType === 'rest' ? 1 : 0)))
  const trainingDay = training ?? { id: crypto.randomUUID(), name: 'Allenamento', dayType: 'training' as const, note: '', meals: [] }
  const exit = () => store.mealDirty && step !== 'done' ? setConfirm({ title: 'Uscire dalla creazione?', text: 'Le modifiche non salvate di questo piano andranno perse. I piani già salvati restano invariati.', action: () => { store.closeMealPlan(); onExit() } }) : (store.closeMealPlan(), onExit())
  const followed = state.selection?.mealPlanId === draft.id

  async function save() {
    setSaving(true)
    try {
      await store.saveMealPlan()
      const after = store.getSnapshot()
      if (after.editor.phase !== 'editing' || store.mealDirty) return
      if (!after.selection?.mealPlanId || after.selection.mealPlanId === draft!.id) await store.choose({ mealPlanId: draft!.id })
      setStep('done')
    } finally { setSaving(false) }
  }

  const shell = (content: ReactNode, footer: ReactNode, back?: () => void) => <section className="wizard" aria-labelledby="wizard-heading">
    <header className="wizard-top">
      {back ? <button type="button" className="icon-button is-outlined" aria-label="Indietro" onClick={back}><Icon name="back" size={20} /></button> : <span className="wizard-spacer" />}
      <div className="wizard-top-title"><span className="eyebrow">{editing ? 'Modifica piano' : 'Nuovo piano alimentare'}</span>{draft.name && step !== 'name' && <strong>{draft.name}</strong>}</div>
      <button type="button" className="icon-button is-outlined" aria-label="Chiudi" onClick={exit}><Icon name="close" size={20} /></button>
    </header>
    {content}
    {editor.message && step !== 'done' && !/salvato online/.test(editor.message) && <p className="wz-message" role="alert">{editor.message}</p>}
    {editor.phase === 'uncertain' && <button type="button" className="button secondary" onClick={() => void store.checkMealPlan()}>Verifica online</button>}
    {editor.phase === 'conflict' && <div className="wz-message"><p>La versione online è diversa: apri l’editor avanzato per confrontarle e scegliere.</p><button type="button" className="button secondary" onClick={onAdvanced}>Apri editor avanzato</button></div>}
    <div className="wizard-footer">{footer}</div>
    {confirm && <Modal label={confirm.title} onClose={() => setConfirm(null)}><h2>{confirm.title}</h2><p>{confirm.text}</p><div className="program-actions"><button className="button secondary" onClick={() => setConfirm(null)}>Annulla</button><button className="button primary" onClick={() => { confirm.action(); setConfirm(null) }}>Conferma</button></div></Modal>}
  </section>

  if (step === 'name') return shell(<>
    <div className="wizard-intro"><span className="wizard-count">Passo 1 di 3</span><h1 id="wizard-heading" ref={heading} tabIndex={-1}>Come si chiama il piano?</h1><p>Poi inserirai i pasti dei giorni di allenamento e di riposo.</p></div>
    <form id="meal-wizard-name" className="wizard-form" onSubmit={event => { event.preventDefault(); if (draft.name.trim()) { if (!training) setDays([trainingDay, ...days]); setStep('training') } }}>
      <label htmlFor="meal-wizard-name-input">Nome del piano<input id="meal-wizard-name-input" autoFocus maxLength={160} placeholder="Es. Piano estate" value={draft.name} onChange={event => store.editMealPlan({ ...draft, name: event.target.value })} /></label>
      <MealPlanSettings document={draft.document} onChange={document => store.editMealPlan({ ...draft, document })} />
      <details className="wz-more"><summary>Indicazioni generali (facoltative)</summary><label htmlFor="meal-wizard-guidance" className="sr-only">Indicazioni generali</label><textarea id="meal-wizard-guidance" rows={4} maxLength={16000} placeholder="Acqua, integrazioni, regole valide ogni giorno…" value={draft.document.guidance} onChange={event => store.editMealPlan({ ...draft, document: { ...draft.document, guidance: event.target.value } })} /></details>
    </form>
    <button type="button" className="text-button wizard-advanced" onClick={onAdvanced}>Preferisci l’editor avanzato?</button>
  </>, <button type="submit" form="meal-wizard-name" className="button primary wizard-next" disabled={!draft.name.trim()}>Avanti<Icon name="arrow" size={20} /></button>)

  if (step === 'done') return shell(<div className="wizard-done">
    <span className="wizard-done-icon" aria-hidden="true"><Icon name="check" size={32} /></span>
    <h1 id="wizard-heading" ref={heading} tabIndex={-1}>Piano salvato</h1>
    <MealPlanMetadata document={draft.document} />
    <p>{followed ? 'È il piano che segui: la Dieta ti mostra i pasti in base al tipo di giornata.' : 'Puoi seguirlo dalla Dieta quando vuoi.'}</p>
    <ul className="wz-summary">{days.map(day => <li key={day.id}><strong>{day.dayType === 'rest' ? 'Riposo' : day.dayType === 'any' ? 'Ogni giorno' : 'Allenamento'}</strong><span>{day.meals.map(meal => meal.name).join(' · ') || 'Nessun pasto'}</span></li>)}</ul>
  </div>, <>
    {!followed && <button type="button" className="button secondary" disabled={state.selecting} onClick={() => void store.choose({ mealPlanId: draft.id })}>Segui questo piano</button>}
    <a className="button primary wizard-next" href="#/dieta" onClick={() => store.closeMealPlan()}>Vai alla Dieta<Icon name="arrow" size={20} /></a>
  </>)

  if (step === 'training') return shell(<>
    <div className="wizard-intro"><span className="wizard-count">Passo 2 di 3</span><h1 id="wizard-heading" ref={heading} tabIndex={-1}>{everyDay ? 'Ogni giorno' : 'Giorni di allenamento'}</h1><p>{everyDay ? 'Gli stessi pasti per tutti i giorni.' : 'I pasti dei giorni in cui ti alleni.'}</p></div>
    <MealsEditor day={trainingDay} disabled={busy} onChange={value => setDay(value)} />
  </>, <button type="button" className="button primary wizard-next" disabled={busy || !trainingDay.meals.length} onClick={() => setStep('rest')}>Avanti<Icon name="arrow" size={20} /></button>, () => setStep('name'))

  // ------------------------------------------------------------------ riposo
  return shell(<>
    <div className="wizard-intro"><span className="wizard-count">Passo 3 di 3</span><h1 id="wizard-heading" ref={heading} tabIndex={-1}>Giorni di riposo</h1><p>{everyDay ? 'Userai gli stessi pasti anche nei giorni di riposo.' : 'I pasti dei giorni in cui non ti alleni.'}</p></div>
    {everyDay ? <button type="button" className="button secondary" disabled={busy} onClick={() => setDays([{ ...trainingDay, dayType: 'training', name: 'Allenamento' }])}>Preferisco un menu diverso per il riposo</button>
      : !restDay ? <div className="wz-choice">
        <button type="button" className="wz-choice-card" disabled={busy} onClick={() => setDays([trainingDay, { id: crypto.randomUUID(), name: 'Riposo', dayType: 'rest', note: '', meals: copyMeals(trainingDay.meals) }])}><Icon name="history" size={20} /><span><strong>Parti dai pasti dell’allenamento</strong><small>Li copio qui e modifichi solo ciò che cambia.</small></span></button>
        <button type="button" className="wz-choice-card" disabled={busy} onClick={() => setDays([{ ...trainingDay, dayType: 'any', name: 'Ogni giorno' }])}><Icon name="check" size={20} /><span><strong>Stessa dieta ogni giorno</strong><small>Nessuna differenza fra allenamento e riposo.</small></span></button>
        <button type="button" className="wz-choice-card" disabled={busy} onClick={() => setDays([trainingDay, { id: crypto.randomUUID(), name: 'Riposo', dayType: 'rest', note: '', meals: [] }])}><Icon name="plus" size={20} /><span><strong>Menu diverso da zero</strong><small>Inserisci i pasti del riposo.</small></span></button>
      </div> : null}
    {!everyDay && restDay && <MealsEditor day={restDay} disabled={busy} onChange={value => setDay(value)} />}
  </>, <button type="button" className="button primary wizard-save" disabled={busy || (!everyDay && !restDay?.meals.length)} onClick={() => void save()}>{busy ? 'Salvataggio…' : 'Salva piano'}{!busy && <Icon name="check" size={20} />}</button>, () => setStep('training'))
}
