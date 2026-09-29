import { useState } from 'react'
import { Icon } from '../components/Icon'
import { SubpageHeader } from '../components/SubpageHeader'
import { Modal } from '../components/Modal'
import { duplicatePlanDay, mealPlanLimits, newPlanDay, newPlanMeal, planDayTypes } from '../domain/meal-plans'
import type { MealPlanDay, MealPlanDraft, PlanDayType, PlanMeal } from '../domain/meal-plans'
import { moveItem } from '../domain/programs'
import type { PlansState, PlansStore } from '../persistence/plans-store'
import { fitsMealWizard } from '../domain/meal-plans'
import { MealPlanWizard } from './MealPlanWizard'
import type { MealWizardStep } from './MealPlanWizard'

const toLines = (value: string) => value.split('\n')

function MealFields({ meal, onChange }: { meal: PlanMeal; onChange: (meal: PlanMeal) => void }) {
  return <>
    <div className="program-day-names"><label htmlFor={`${meal.id}-name`}>Nome del pasto<input id={`${meal.id}-name`} className="meal-name" maxLength={120} value={meal.name} placeholder="Colazione" onChange={event => onChange({ ...meal, name: event.target.value })} /></label><label htmlFor={`${meal.id}-time`}>Orario o momento (facoltativo)<input id={`${meal.id}-time`} maxLength={60} value={meal.time} placeholder="07:30" onChange={event => onChange({ ...meal, time: event.target.value })} /></label></div>
    <fieldset className="meal-foods"><legend>Alimenti</legend>
      {meal.foods.map((food, index) => <div className="meal-food-row" key={index}>
        <label htmlFor={`${meal.id}-food-${index}`} className="sr-only">Alimento {index + 1}</label><input id={`${meal.id}-food-${index}`} className="meal-food-name" maxLength={200} placeholder="Alimento" value={food.name} onChange={event => onChange({ ...meal, foods: meal.foods.map((item, i) => i === index ? { ...item, name: event.target.value } : item) })} />
        <label htmlFor={`${meal.id}-qty-${index}`} className="sr-only">Quantità alimento {index + 1}</label><input id={`${meal.id}-qty-${index}`} className="meal-food-quantity" maxLength={60} placeholder="Quantità" value={food.quantity} onChange={event => onChange({ ...meal, foods: meal.foods.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item) })} />
        <button type="button" className="icon-button" aria-label={`Rimuovi alimento ${index + 1}`} onClick={() => onChange({ ...meal, foods: meal.foods.filter((_, i) => i !== index) })}><Icon name="close" size={16} /></button>
      </div>)}
      <button type="button" className="button secondary meal-add-food" disabled={meal.foods.length >= mealPlanLimits.foods} onClick={() => onChange({ ...meal, foods: [...meal.foods, { name: '', quantity: '' }] })}><Icon name="plus" size={16} />Aggiungi alimento</button>
    </fieldset>
    <label htmlFor={`${meal.id}-alternatives`}>Alternative · una per riga<textarea id={`${meal.id}-alternatives`} rows={2} value={meal.alternatives.join('\n')} onChange={event => onChange({ ...meal, alternatives: toLines(event.target.value) })} /></label>
    <label htmlFor={`${meal.id}-additions`}>Aggiunte previste e loro condizioni · una per riga<textarea id={`${meal.id}-additions`} rows={2} value={meal.additions.join('\n')} onChange={event => onChange({ ...meal, additions: toLines(event.target.value) })} /></label>
    <label htmlFor={`${meal.id}-note`}>Note del pasto<textarea id={`${meal.id}-note`} rows={2} maxLength={4000} value={meal.note} onChange={event => onChange({ ...meal, note: event.target.value })} /></label>
  </>
}

function PlanPreview({ draft }: { draft: MealPlanDraft }) {
  return <div className="program-preview"><h3>{draft.name}</h3>{draft.document.guidance && <p className="catalog-note">{draft.document.guidance}</p>}{draft.document.days.map(day => <section key={day.id}><h4>{day.name} · {planDayTypes[day.dayType]}</h4><ol>{day.meals.map(meal => <li key={meal.id}><strong>{meal.name}</strong>{meal.time && <span className="small muted"> · {meal.time}</span>}<p>{meal.foods.map(food => food.quantity ? `${food.name} ${food.quantity}` : food.name).join(', ') || 'Nessun alimento'}</p></li>)}</ol></section>)}</div>
}

function MealPlanEditor({ store, state }: { store: PlansStore; state: PlansState }) {
  const [confirm, setConfirm] = useState<{ title: string; action: () => void } | null>(null)
  const editor = state.editor, draft = editor.draft!
  const busy = ['saving', 'checking'].includes(editor.phase)
  const blocked = busy || editor.phase === 'uncertain'
  const edit = (value: Partial<MealPlanDraft['document']>) => store.editMealPlan({ ...draft, document: { ...draft.document, ...value } })
  const updateDay = (day: MealPlanDay) => edit({ days: draft.document.days.map(item => item.id === day.id ? day : item) })
  return <>
    <section className="panel program-editor meal-plan-editor" aria-labelledby="meal-plan-title">
      <div className="section-heading"><h2 id="meal-plan-title">{editor.base ? 'Modifica piano' : 'Nuovo piano alimentare'}</h2></div>
      <form className="program-form" onSubmit={event => { event.preventDefault(); void store.saveMealPlan() }}>
        <fieldset disabled={blocked}>
          <label htmlFor="meal-plan-name">Nome del piano<input id="meal-plan-name" maxLength={160} required value={draft.name} onChange={event => store.editMealPlan({ ...draft, name: event.target.value })} /></label>
          <label htmlFor="meal-plan-guidance">Indicazioni generali<textarea id="meal-plan-guidance" rows={3} maxLength={16000} value={draft.document.guidance} onChange={event => edit({ guidance: event.target.value })} /></label>
          <p className="small muted">Trascrivi il tuo piano: nessuna quantità, calorie o alternativa viene calcolata o aggiunta dall’app. Le giornate di palestra e riposo vengono proposte secondo il tipo scelto nel diario.</p>
          {draft.document.days.map((day, dayIndex) => <section className="program-day" key={day.id} aria-label={`Giornata ${dayIndex + 1}`}>
            <div className="section-heading"><h3>Giornata {dayIndex + 1}</h3></div>
            <div className="program-day-names"><label htmlFor={`${day.id}-name`}>Nome<input id={`${day.id}-name`} className="meal-day-name" maxLength={120} value={day.name} onChange={event => updateDay({ ...day, name: event.target.value })} /></label><label htmlFor={`${day.id}-type`}>Quando si usa<select id={`${day.id}-type`} value={day.dayType} onChange={event => updateDay({ ...day, dayType: event.target.value as PlanDayType })}>{(Object.keys(planDayTypes) as PlanDayType[]).map(type => <option key={type} value={type}>{planDayTypes[type]}</option>)}</select></label></div>
            <label htmlFor={`${day.id}-note`}>Note della giornata<textarea id={`${day.id}-note`} rows={2} maxLength={4000} value={day.note} onChange={event => updateDay({ ...day, note: event.target.value })} /></label>
            <div className="program-actions"><button type="button" className="button secondary" disabled={dayIndex === 0} aria-label={`Sposta su giornata ${dayIndex + 1}`} onClick={() => edit({ days: moveItem(draft.document.days, dayIndex, -1) })}>Su</button><button type="button" className="button secondary" disabled={dayIndex === draft.document.days.length - 1} aria-label={`Sposta giù giornata ${dayIndex + 1}`} onClick={() => edit({ days: moveItem(draft.document.days, dayIndex, 1) })}>Giù</button><button type="button" className="button secondary" disabled={draft.document.days.length >= mealPlanLimits.days} onClick={() => edit({ days: [...draft.document.days, duplicatePlanDay(day)] })}>Duplica giornata</button><button type="button" className="button secondary" onClick={() => setConfirm({ title: 'Rimuovere questa giornata?', action: () => edit({ days: draft.document.days.filter(item => item.id !== day.id) }) })}>Rimuovi giornata</button></div>
            {day.meals.map((meal, mealIndex) => <section className="program-prescription" key={meal.id} aria-label={`Pasto ${mealIndex + 1}${meal.name ? `: ${meal.name}` : ''}`}>
              <h4>{mealIndex + 1}. {meal.name || 'Nuovo pasto'}</h4>
              <MealFields meal={meal} onChange={value => updateDay({ ...day, meals: day.meals.map(item => item.id === meal.id ? value : item) })} />
              <div className="program-actions"><button type="button" className="button secondary" disabled={mealIndex === 0} aria-label={`Sposta su ${meal.name || 'pasto'}`} onClick={() => updateDay({ ...day, meals: moveItem(day.meals, mealIndex, -1) })}>Su</button><button type="button" className="button secondary" disabled={mealIndex === day.meals.length - 1} aria-label={`Sposta giù ${meal.name || 'pasto'}`} onClick={() => updateDay({ ...day, meals: moveItem(day.meals, mealIndex, 1) })}>Giù</button><button type="button" className="button secondary" onClick={() => setConfirm({ title: 'Rimuovere questo pasto?', action: () => updateDay({ ...day, meals: day.meals.filter(item => item.id !== meal.id) }) })}>Rimuovi pasto</button></div>
            </section>)}
            <button type="button" className="button secondary meal-add" disabled={day.meals.length >= mealPlanLimits.meals} onClick={() => updateDay({ ...day, meals: [...day.meals, newPlanMeal()] })}><Icon name="plus" size={16} />Aggiungi pasto</button>
          </section>)}
          <button className="button secondary meal-add-day" type="button" disabled={draft.document.days.length >= mealPlanLimits.days} onClick={() => edit({ days: [...draft.document.days, newPlanDay(draft.document.days)] })}><Icon name="plus" size={16} />Aggiungi giornata</button>
        </fieldset>
        {editor.phase === 'editing' && <div className="program-actions"><button className="button primary meal-plan-save" type="submit" disabled={!store.mealDirty && Boolean(editor.base)}>Salva piano</button><button type="button" className="button secondary" onClick={() => store.mealDirty ? setConfirm({ title: 'Scartare le modifiche?', action: store.closeMealPlan }) : store.closeMealPlan()}>Torna ai piani</button></div>}
      </form>
      {editor.phase === 'conflict' && <section className="preferences-conflict program-conflict" aria-label="Confronto piano"><h3>Versione attualmente online</h3>{editor.remote ? <PlanPreview draft={editor.remote} /> : <p>Questo piano non risulta online.</p>}
        <div className="program-actions"><button className="button secondary" onClick={store.useRemoteMealPlan}>{editor.remote ? 'Usa la versione online' : 'Scarta la bozza locale'}</button>{editor.remote && <button className="button primary" onClick={() => void store.saveMealPlan(true)}>Salva le mie modifiche</button>}</div>
      </section>}
      {editor.message && <p className="program-message" role={editor.phase === 'editing' ? 'status' : 'alert'}>{editor.message}</p>}
      {busy && <p role="status">{editor.phase === 'saving' ? 'Salvataggio del piano…' : 'Verifica online…'}</p>}
      {editor.phase === 'uncertain' && <button className="button secondary" onClick={() => void store.checkMealPlan()}>Verifica online</button>}
      {store.mealDirty && <p className="small muted">Modifiche da salvare. Restano in questa pagina finché non le salvi online.</p>}
    </section>
    {confirm && <Modal label={confirm.title} onClose={() => setConfirm(null)}><h2>{confirm.title}</h2><p>La modifica riguarda questo piano; i pasti già registrati nel diario conservano la loro copia.</p><div className="program-actions"><button className="button secondary" onClick={() => setConfirm(null)}>Annulla</button><button className="button primary" onClick={() => { confirm.action(); setConfirm(null) }}>Conferma</button></div></Modal>}
  </>
}

export type MealMode = 'wizard' | 'advanced'
export function showsMealWizard(state: PlansState, mode: MealMode, step: MealWizardStep) {
  const draft = state.editor.draft
  return Boolean(draft) && mode === 'wizard' && (step === 'done' || fitsMealWizard(draft!.document))
}

export function MealPlans({ store, state, mode, setMode, step, setStep, deletionBlocked }: {
  store: PlansStore | null; state: PlansState; mode: MealMode; setMode: (mode: MealMode) => void; step: MealWizardStep; setStep: (step: MealWizardStep) => void; deletionBlocked: boolean
}) {
  const selected = state.selection?.mealPlanId
  const [confirmDelete, setConfirmDelete] = useState<{ id: string | null; name: string } | null>(null)
  if (store && state.editor.phase !== 'closed' && showsMealWizard(state, mode, step)) {
    return <MealPlanWizard store={store} state={state} step={step} setStep={setStep} onAdvanced={() => setMode('advanced')} onExit={() => setMode('wizard')} />
  }
  const startWizard = () => { if (!store) return; setMode('wizard'); setStep('name'); store.createMealPlan() }
  const edit = (id: string) => {
    const plan = state.mealPlans.find(item => item.id === id)
    if (!store || !plan) return
    setMode(fitsMealWizard(plan.document) ? 'wizard' : 'advanced'); setStep('name'); store.openMealPlan(id)
  }
  return <><SubpageHeader back="#/dieta" backLabel="Torna alla dieta" title="I tuoi piani alimentari" subtitle="I pasti dei giorni di allenamento e di riposo." />
    {!store ? <section className="panel empty-state"><h2>Accedi per gestire i piani alimentari</h2></section>
      : state.phase === 'loading' ? <section className="panel empty-state" role="status">Caricamento dei piani…</section>
        : state.phase === 'error' ? <section className="panel empty-state"><p role="alert">{state.message}</p><button className="button primary" onClick={() => void store.load()}>Riprova</button></section>
          : state.editor.phase !== 'closed' ? <MealPlanEditor store={store} state={state} />
            : <>
              <button className="button primary lg meal-plan-wizard-new full-width-mobile" onClick={startWizard}><Icon name="plus" size={20} />Nuovo piano alimentare</button>
              <div className="program-list-tools"><a className="text-button meal-plan-import" href="#/dieta/importa">Importa da Word o PDF</a><button className="text-button meal-plan-new" onClick={() => { setMode('advanced'); store.createMealPlan() }}>Editor avanzato</button><button className="text-button" onClick={() => void store.load()}>Aggiorna elenco</button>{state.mealPlans.length > 0 && <button className="text-button delete-link" disabled={deletionBlocked || state.deleting} onClick={() => setConfirmDelete({ id: null, name: 'tutti i piani alimentari' })}>Elimina tutto</button>}</div>
              {deletionBlocked && <p className="small muted">Completa la sincronizzazione del diario prima di eliminare i piani alimentari.</p>}
              {state.message && <p role="status">{state.message}</p>}
              {!state.mealPlans.length ? <section className="panel empty-state"><span className="empty-icon"><Icon name="fork" size={32} /></span><h2>Nessun piano alimentare</h2><p>Inserisci i pasti dei giorni di allenamento e di riposo.</p><button className="button primary" onClick={startWizard}>Crea il tuo piano<Icon name="arrow" size={20} /></button><p className="small"><a className="text-link" href="#/dieta/importa">Oppure importalo da un file Word o PDF</a></p></section>
                : <div className="program-list">{state.mealPlans.map(plan => <section className={`panel program-card meal-plan-card ${selected === plan.id ? 'is-followed' : ''}`} key={plan.id}>
                  <div className="program-card-head"><h2>{plan.name}</h2>{selected === plan.id && !plan.archivedAt && <span className="badge-followed"><Icon name="check" size={16} />Seguito</span>}</div>
                  <p className="small muted">{plan.document.days.map(day => `${planDayTypes[day.dayType]}: ${day.meals.length} pasti`).join(' · ') || 'Nessuna giornata'}{plan.archivedAt ? ' · Archiviato' : ''}{selected === plan.id ? ' · Piano seguito' : ''}</p>
                  <div className="program-actions">{!plan.archivedAt && selected !== plan.id && <button className="button primary" disabled={state.selecting} onClick={() => void store.choose({ mealPlanId: plan.id })}>Segui questo piano</button>}<button className="button secondary meal-plan-edit" onClick={() => edit(plan.id)}>Modifica</button><button className="button secondary" disabled={selected === plan.id && !plan.archivedAt} onClick={() => void store.archiveMealPlan(plan.id, !plan.archivedAt)}>{plan.archivedAt ? 'Ripristina' : 'Archivia'}</button><button className="button secondary danger" disabled={deletionBlocked || state.deleting} onClick={() => setConfirmDelete({ id: plan.id, name: plan.name })}>Elimina</button></div></section>)}</div>}
            </>}
    {confirmDelete && <Modal label="Conferma eliminazione piani alimentari" onClose={() => setConfirmDelete(null)}><h2>Eliminare {confirmDelete.name}?</h2><p>{confirmDelete.id ? 'Il piano alimentare verrà eliminato.' : 'Tutti i piani alimentari verranno eliminati.'} I pasti già registrati restano nello storico. L’azione non si può annullare.</p><div className="program-actions"><button className="button secondary" onClick={() => setConfirmDelete(null)}>Annulla</button><button className="button danger" onClick={() => { const id = confirmDelete.id; setConfirmDelete(null); void store?.deleteMealPlans(id) }}>Elimina {confirmDelete.id ? 'piano' : 'tutto'}</button></div></Modal>}
  </>
}
