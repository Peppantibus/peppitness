import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { mealPlanLimits } from '../../domain/meal-plans.ts'
import {
  domainLimits,
  type DietExtraction, type DietReviewDraft, type ExtractedDietDay, type ExtractedDietRule, type ExtractedFood, type ExtractedMeal,
  type NormalizedDocument, type ReviewDraft, type ReviewItem, type ValidationIssue,
} from '../../import/contracts/index.ts'
import type { DietMapping, DietMappingIds } from '../../import/mapping/diet.ts'
import { addItem, compareWithProposal, confirmFinding, DecisionError, moveItem, removeItem, setField, staleConfirmations } from '../../import/review/decisions.ts'
import { resolvePointer, type ValidationFinding } from '../../import/validation/validate.ts'
import { DietImportPreview } from './DietImportPreview'
import { ChoiceField, Field, FindingCard, ReanalysisPanel, TextField, TextListField, type FieldIssue } from './ReviewParts'
import { childrenOf, dietReviewOutcome, findingState, mappingOnlyIssues, originLabel, reserveDietIds, ReviewIndex, rootOf } from './review-model'
import { SourceViewer } from './SourceViewer'
import './review.css'
import './diet-review.css'

/**
 * Revisione del piano alimentare importato (task 13, specifica §§6.2, 9.2): componente controllato che modifica
 * la bozza solo con le azioni pure del 07, mostra problemi e origine dei valori dalla validazione 06, la fonte
 * affiancata e l'anteprima dal mapper 10. Piano base, alternative e aggiunte con condizione restano sezioni
 * distinte; le regole dell'intero piano compaiono una volta. Quantità assenti e tipi di giornata ignoti
 * richiedono una scelta esplicita; nessuna quantità, giornata o valore nutrizionale viene proposto.
 * Nessuna scrittura, rete o salvataggio: `onConfirm` riceve bozza, ID prenotati e mapping, solo se pronta.
 */
export interface DietReviewValue { draft: DietReviewDraft; ids: DietMappingIds }
export interface DietReviewResult extends DietReviewValue { mapping: DietMapping }

type RootValues = Pick<DietExtraction, 'title' | 'guidance'>
type DayValues = Omit<ExtractedDietDay, 'meals'>
type MealValues = Omit<ExtractedMeal, 'foods'>
type Item<V> = ReviewItem & { values: V }

const ruleLabels: Record<ExtractedDietRule['kind'], string> = { addition: 'Aggiunta', substitution: 'Sostituzione', nutrition: 'Nutrienti', other: 'Regola' }
const fieldLabels: Record<string, string> = {
  title: 'Nome del piano', guidance: 'Indicazioni', name: 'Nome', dayType: 'Tipo di giornata', notes: 'Note', timeText: 'Orario',
  alternatives: 'Alternative', additions: 'Aggiunte con condizione', quantityText: 'Quantità', text: 'Regola',
}
const mappingFields: Record<string, string> = { diet_quantity_confirmation: 'quantityText', diet_empty_rule: 'text', diet_global_rule_duplicate: 'text' }
const fieldId = (localId: string, field: string) => `rv-${localId}-${field}`
const itemId = (localId: string) => `rv-item-${localId}`

export function DietReview({
  document: sourceDocument, format, original = null, pageCount = null, originalUnavailable, value, onChange,
  reanalysis = null, onAdoptReanalysis, onDismissReanalysis, onConfirm, confirmLabel = 'Conferma la revisione', newId = () => crypto.randomUUID(),
}: {
  document: NormalizedDocument
  format: 'docx' | 'pdf'
  original?: Uint8Array | null
  pageCount?: number | null
  originalUnavailable?: ReactNode
  /** Bozza e ID prenotati: `reserveDietIds(draft, null)` alla prima apertura, poi quelli ricevuti da `onChange`. */
  value: DietReviewValue
  onChange: (value: DietReviewValue) => void
  /** Nuova proposta da confrontare (rianalisi): mai applicata senza una scelta esplicita. */
  reanalysis?: DietReviewDraft | null
  onAdoptReanalysis?: () => void
  onDismissReanalysis?: () => void
  /** Solo con revisione pronta: stessi dati di anteprima e comando. Nessun salvataggio qui. */
  onConfirm?: (result: DietReviewResult) => void
  confirmLabel?: string
  newId?: () => string
}) {
  const { draft } = value
  const ids = useMemo(() => reserveDietIds(draft, value.ids), [draft, value.ids])
  useEffect(() => { if (ids !== value.ids) onChange({ draft, ids }) }, [ids, value.ids, draft, onChange])
  const outcome = useMemo(() => dietReviewOutcome(sourceDocument, draft, ids), [sourceDocument, draft, ids])
  const index = useMemo(() => new ReviewIndex(draft, outcome.validation), [draft, outcome.validation])
  const stale = useMemo(() => staleConfirmations(draft), [draft])
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<{ refs: string[]; selected: string | null; from: string | null }>({ refs: [], selected: null, from: null })
  const [focusTarget, setFocusTarget] = useState<string | null>(null)

  useEffect(() => {
    if (!focusTarget) return
    const frame = requestAnimationFrame(() => {
      const element = globalThis.document.getElementById(focusTarget) ?? globalThis.document.getElementById(`${focusTarget}-group`)
      if (element) { element.scrollIntoView({ block: 'center' }); element.focus({ preventScroll: true }) }
      setFocusTarget(null)
    })
    return () => cancelAnimationFrame(frame)
  }, [focusTarget])

  const apply = (change: (current: ReviewDraft) => ReviewDraft, focus?: string) => {
    let next: ReviewDraft
    try { next = change(draft) } catch (reason) {
      if (reason instanceof DecisionError) { setError(`Modifica non applicata: ${reason.message}`); return }
      throw reason
    }
    setError(null)
    if (next !== draft) onChange({ draft: next as DietReviewDraft, ids: reserveDietIds(next as DietReviewDraft, ids) })
    if (focus) setFocusTarget(focus)
  }
  const set = (localId: string, field: string, next: unknown, reason: 'user_edit' | 'confirmed_missing' = 'user_edit') =>
    apply(current => setField(current, localId, field, next as never, reason))

  const root = rootOf(draft) as Item<RootValues>
  const days = childrenOf(draft, root.localId, 'days') as Item<DayValues>[]
  const rules = childrenOf(draft, root.localId, 'globalRules') as Item<ExtractedDietRule>[]
  const mealsOf = (dayId: string) => childrenOf(draft, dayId, 'meals') as Item<MealValues>[]
  const foodsOf = (mealId: string) => childrenOf(draft, mealId, 'foods') as Item<ExtractedFood>[]
  const byId = new Map((draft.current as readonly ReviewItem[]).map(item => [item.localId, item]))
  const allMeals = days.flatMap(day => mealsOf(day.localId))

  const issues = (localId: string, field: string | null): FieldIssue[] => index.findingsOf(localId, field).map(finding => ({ finding, state: findingState(draft, finding, stale) }))
  const origin = (localId: string, field: string) => originLabel(index.provenance(localId, field))
  const sourceButton = (localId: string, field: string | null) => {
    const refs = index.refs(localId, field)
    return refs.length ? () => setSource({ refs, selected: refs[0]!, from: field ? fieldId(localId, field) : itemId(localId) }) : undefined
  }
  const context = (localId: string | null): string => {
    const item = localId ? byId.get(localId) : undefined
    if (!item || item.collection === 'root') return 'Piano'
    if (item.collection === 'days') return `Giornata ${(item.values as DayValues).name ?? 'senza nome'}`
    if (item.collection === 'globalRules') return `Regola dell’intero piano: ${ruleLabels[(item.values as ExtractedDietRule).kind]}`
    if (item.collection === 'meals') return `${context(item.parentLocalId)} · ${(item.values as MealValues).name ?? 'pasto senza nome'}`
    return `${context(item.parentLocalId)} · ${(item.values as ExtractedFood).name ?? 'alimento senza nome'}`
  }
  const goTo = (localId: string | null, field: string | null) => {
    const item = localId ? byId.get(localId) : undefined
    setFocusTarget(!item ? 'rv-summary' : field ? fieldId(item.localId, field) : itemId(item.localId))
  }

  // ---------------------------------------------------------------- struttura
  const add = (collection: 'days' | 'meals' | 'foods', parentLocalId: string, values: unknown, focusField: string) => {
    const localId = newId()
    apply(current => addItem(current, { collection, parentLocalId, localId, values: values as never }), fieldId(localId, focusField))
  }
  const remove = (item: ReviewItem) => {
    const siblings = childrenOf(draft, item.parentLocalId!, item.collection)
    const at = siblings.findIndex(entry => entry.localId === item.localId)
    const neighbour = siblings[at + 1] ?? siblings[at - 1]
    apply(current => removeItem(current, item.localId), neighbour ? itemId(neighbour.localId) : `rv-add-${item.collection}-${item.parentLocalId}`)
  }
  const move = (item: ReviewItem, delta: -1 | 1) => {
    const siblings = childrenOf(draft, item.parentLocalId!, item.collection)
    const to = siblings.findIndex(entry => entry.localId === item.localId) + delta
    if (to < 0 || to >= siblings.length) return
    const edge = to === 0 || to === siblings.length - 1
    apply(current => moveItem(current, item.localId, item.parentLocalId!, to), `rv-move-${item.localId}-${edge ? (delta < 0 ? 'down' : 'up') : delta < 0 ? 'up' : 'down'}`)
  }
  const moveTo = (item: ReviewItem, parentLocalId: string) =>
    apply(current => moveItem(current, item.localId, parentLocalId, childrenOf(current, parentLocalId, item.collection).length), itemId(item.localId))
  const tools = (item: ReviewItem, noun: string, siblings: readonly ReviewItem[]) => {
    const at = siblings.findIndex(entry => entry.localId === item.localId)
    return <div className="rv-item-tools">
      <button type="button" id={`rv-move-${item.localId}-up`} className="icon-button is-outlined" aria-label={`Sposta su ${noun}`} disabled={at === 0} onClick={() => move(item, -1)}><Icon name="chevron" size={20} style={{ transform: 'rotate(-90deg)' }} /></button>
      <button type="button" id={`rv-move-${item.localId}-down`} className="icon-button is-outlined" aria-label={`Sposta giù ${noun}`} disabled={at === siblings.length - 1} onClick={() => move(item, 1)}><Icon name="chevron" size={20} style={{ transform: 'rotate(90deg)' }} /></button>
      <button type="button" className="icon-button is-outlined" aria-label={`Rimuovi ${noun}`} onClick={() => remove(item)}><Icon name="close" size={20} /></button>
    </div>
  }

  // ---------------------------------------------------------------- problemi
  const findingActions = (finding: ValidationFinding, state: string): ReactNode => {
    if (state === 'confirmed' || state === 'info') return null
    const { code, resolutions, localId } = finding.issue
    const item = localId ? byId.get(localId) : undefined
    const out: ReactNode[] = []
    if (code === 'food_quantity_missing' && localId) out.push(<button key="empty" type="button" className="text-button" onClick={() => set(localId, 'quantityText', '', 'confirmed_missing')}>Quantità non indicata: confermo</button>)
    else if (code === 'day_type_missing') { /* si sceglie nel campo: allenamento, riposo o qualsiasi giorno */ }
    else if (resolutions.includes('scope_choice')) out.push(<button key="scope" type="button" className="text-button" onClick={() => apply(current => confirmFinding(current, finding, 'scope_choice'))}>Ho controllato: confermo</button>)
    else if (resolutions.includes('confirmed_missing')) out.push(<button key="missing" type="button" className="text-button" onClick={() => apply(current => confirmFinding(current, finding, 'confirmed_missing'))}>Confermo che non è indicato</button>)
    if (resolutions.includes('remove_item') && item && item.collection !== 'root') out.push(<button key="remove" type="button" className="text-button delete-link" onClick={() => remove(item)}>Rimuovi {item.collection === 'days' ? 'la giornata' : item.collection === 'meals' ? 'il pasto' : 'l’alimento'}</button>)
    return out
  }
  const openFindings = index.findings.filter(finding => { const state = findingState(draft, finding, stale); return state === 'open' || state === 'stale' })
  const settled = index.findings.filter(finding => !openFindings.includes(finding))
  const mappingIssues = mappingOnlyIssues(outcome.mapping)
  const issueCard = (finding: ValidationFinding) => {
    const state = findingState(draft, finding, stale)
    return <FindingCard key={`${finding.issue.code}-${finding.issue.localId}-${finding.field}-${finding.issue.sourceRefs.join(',')}`} finding={finding} state={state} context={context(finding.issue.localId)}
      onGo={finding.issue.localId ? () => goTo(finding.issue.localId, finding.field) : undefined}
      onSource={finding.issue.sourceRefs.length ? () => setSource({ refs: [...finding.issue.sourceRefs], selected: finding.issue.sourceRefs[0]!, from: null }) : undefined}
      actions={findingActions(finding, state)} />
  }
  const mappingCard = (issue: ValidationIssue, position: number) => <li key={`${issue.code}-${position}`} className="rv-finding is-blocking is-open">
    <p className="rv-finding-state">Da risolvere · {context(issue.localId)}</p>
    <p>{issue.message}</p>
    {issue.localId && <div className="rv-finding-actions">
      <button type="button" className="text-button" onClick={() => goTo(issue.localId, mappingFields[issue.code] ?? null)}>Vai al punto</button>
      {issue.code === 'diet_quantity_confirmation' && <button type="button" className="text-button" onClick={() => set(issue.localId!, 'quantityText', '', 'confirmed_missing')}>Quantità non indicata: confermo</button>}
    </div>}
  </li>

  // ---------------------------------------------------------------- campi
  const text = (item: ReviewItem, field: string, max: number, options: { label?: string; help?: ReactNode; actions?: ReactNode; placeholder?: string } = {}) => <Field id={fieldId(item.localId, field)} label={options.label ?? fieldLabels[field]!}
    origin={origin(item.localId, field)} issues={issues(item.localId, field)} onSource={sourceButton(item.localId, field)} help={options.help} actions={options.actions}>
    <TextField id={fieldId(item.localId, field)} value={(item.values as unknown as Record<string, string | null>)[field]!} max={max} placeholder={options.placeholder} onCommit={next => set(item.localId, field, next)} />
  </Field>
  const list = (item: ReviewItem, field: string, addLabel: string, itemLabel: string, max: number, options: { label?: string; help?: ReactNode } = {}) => <Field id={fieldId(item.localId, field)} group label={options.label ?? fieldLabels[field]!}
    origin={origin(item.localId, field)} issues={issues(item.localId, field)} onSource={sourceButton(item.localId, field)} help={options.help}>
    <TextListField id={fieldId(item.localId, field)} values={(item.values as unknown as Record<string, string[]>)[field]!} addLabel={addLabel} itemLabel={itemLabel} max={max} onCommit={next => set(item.localId, field, next)} />
  </Field>
  const openCount = (localId: string) => index.itemFindings(localId).filter(finding => { const state = findingState(draft, finding, stale); return state === 'open' || state === 'stale' }).length
    + outcome.mapping.issues.filter(issue => issue.localId === localId && !issue.code.endsWith('_review_required')).length
  const itemIssues = (localId: string) => issues(localId, null).filter(issue => issue.state === 'open' || issue.state === 'stale')
    .map(issue => <p key={issue.finding.issue.code} className={`rv-field-issue is-${issue.finding.issue.severity}`}>{issue.finding.issue.message}</p>)

  // ---------------------------------------------------------------- alimento
  const foodCard = (food: Item<ExtractedFood>, meal: Item<MealValues>, siblings: readonly Item<ExtractedFood>[], position: number) => {
    const v = food.values
    const quantityMissing = v.quantityText === null
    const confirmedEmpty = v.quantityText === '' && draft.decisions.some(decision => decision.op === 'set' && decision.localId === food.localId && decision.field === 'quantityText' && decision.reason === 'confirmed_missing' && decision.after === '')
    return <li key={food.localId} className="dr-food" data-local-id={food.localId}>
      <div className="dr-item-head">
        <h5 id={itemId(food.localId)} tabIndex={-1}>{v.name ?? 'Alimento senza nome'}{openCount(food.localId) > 0 && <span className="rv-badge is-confirmation">{openCount(food.localId)} da sistemare</span>}</h5>
        {tools(food, `alimento ${v.name ?? position + 1}`, siblings)}
      </div>
      {itemIssues(food.localId)}
      <div className="rv-fields is-grid">
        {text(food, 'name', domainLimits.diet.foodName, { label: 'Alimento' })}
        {text(food, 'quantityText', domainLimits.diet.foodQuantity, {
          placeholder: 'Non indicata',
          help: confirmedEmpty ? 'Quantità non indicata nel documento: confermata vuota.' : 'Scrivi la quantità come nel documento (anche «q.b.» o «a piacere»). Nessuna quantità viene proposta.',
          actions: quantityMissing ? <button type="button" className="text-button" onClick={() => set(food.localId, 'quantityText', '', 'confirmed_missing')}>Quantità non indicata: confermo</button> : undefined,
        })}
        <div className="is-wide">{list(food, 'notes', 'Aggiungi una nota', 'Nota dell’alimento', domainLimits.diet.note, {
          label: 'Note dell’alimento', help: `Nel piano salvato vanno nelle note del pasto come «${v.name ?? 'Alimento'} (alimento ${position + 1}): …».`,
        })}</div>
      </div>
      {allMeals.length > 1 && <label className="dr-move">Sposta in un altro pasto
        <select value={meal.localId} onChange={event => moveTo(food, event.target.value)}>
          {allMeals.map(entry => <option key={entry.localId} value={entry.localId}>{context(entry.localId)}</option>)}
        </select>
      </label>}
    </li>
  }

  // ---------------------------------------------------------------- pasto
  const mealCard = (meal: Item<MealValues>, day: Item<DayValues>, siblings: readonly Item<MealValues>[]) => {
    const foods = foodsOf(meal.localId)
    return <li key={meal.localId} className="dr-meal" data-local-id={meal.localId}>
      <div className="dr-item-head">
        <h4 id={itemId(meal.localId)} tabIndex={-1}>{meal.values.name ?? 'Pasto senza nome'}{meal.values.timeText ? <span className="small muted"> · {meal.values.timeText}</span> : null}</h4>
        {tools(meal, `pasto ${meal.values.name ?? ''}`.trim(), siblings)}
      </div>
      {itemIssues(meal.localId)}
      {outcome.mapping.issues.filter(issue => issue.localId === meal.localId && issue.code === 'diet_empty_meal').map(issue => <p key={issue.code} className="rv-field-issue is-blocking">{issue.message}</p>)}
      <div className="rv-fields is-grid">
        {text(meal, 'name', domainLimits.diet.mealName, { label: 'Nome del pasto' })}
        {text(meal, 'timeText', domainLimits.diet.mealTime, { label: 'Orario (facoltativo)', placeholder: 'Non indicato' })}
      </div>
      <section className="dr-scope is-base" aria-labelledby={`dr-base-${meal.localId}`}>
        <h5 id={`dr-base-${meal.localId}`}>Piano base</h5>
        <p className="field-help">Gli alimenti che compongono il pasto. Le alternative e le aggiunte non vanno qui.</p>
        <ol className="dr-foods">{foods.map((food, position) => foodCard(food, meal, foods, position))}</ol>
        {foods.length === 0 && <p className="small muted">Nessun alimento nel pasto base{meal.values.alternatives.length ? ': il pasto è descritto dalle alternative complete.' : '.'}</p>}
        <button type="button" id={`rv-add-foods-${meal.localId}`} className="button secondary rv-add" onClick={() => add('foods', meal.localId, { name: null, quantityText: null, notes: [] }, 'name')}><Icon name="plus" size={16} />Aggiungi un alimento</button>
      </section>
      <section className="dr-scope is-alternatives" aria-labelledby={`dr-alt-${meal.localId}`}>
        <h5 id={`dr-alt-${meal.localId}`}>Alternative</h5>
        <p className="field-help">Una frase completa per opzione, con ciò che sostituisce (un alimento o l’intero pasto). Non si sommano al pasto base.</p>
        {list(meal, 'alternatives', 'Aggiungi un’alternativa', 'Alternativa', domainLimits.diet.lineChars, { label: 'Alternative del pasto' })}
      </section>
      <section className="dr-scope is-additions" aria-labelledby={`dr-add-${meal.localId}`}>
        <h5 id={`dr-add-${meal.localId}`}>Aggiunte con condizione</h5>
        <p className="field-help">Una frase completa per aggiunta, con la sua condizione (per esempio «Dopo un allenamento lungo: …»).</p>
        {list(meal, 'additions', 'Aggiungi un’aggiunta', 'Aggiunta', domainLimits.diet.lineChars, { label: 'Aggiunte del pasto' })}
      </section>
      {list(meal, 'notes', 'Aggiungi una nota', 'Nota del pasto', domainLimits.diet.note, { label: 'Note del pasto' })}
      {days.length > 1 && <label className="dr-move">Sposta in un’altra giornata
        <select value={day.localId} onChange={event => moveTo(meal, event.target.value)}>
          {days.map(entry => <option key={entry.localId} value={entry.localId}>{context(entry.localId)}</option>)}
        </select>
      </label>}
    </li>
  }

  // ---------------------------------------------------------------- confronto, fonte
  const differences = reanalysis ? compareWithProposal(draft, reanalysis) : []
  const describe = (difference: { pointer: string; collection: string }) => {
    const found = reanalysis ? resolvePointer(reanalysis.proposal.extraction, difference.pointer) : null
    const fromNext = found?.found ? found.value as Record<string, unknown> : null
    const oldId = draft.localIds.find(entry => entry.pointer === difference.pointer)?.localId
    const label = fromNext?.name ?? fromNext?.title ?? (oldId ? context(oldId) : null)
    const noun = { root: 'Piano', days: 'Giornata', meals: 'Pasto', foods: 'Alimento', globalRules: 'Regola' }[difference.collection] ?? 'Elemento'
    return `${noun}${label ? ` «${String(label)}»` : ''}`
  }
  const users = source.selected ? index.usersOf(source.selected) : []
  const readiness = outcome.readiness
  const counts = { meals: allMeals.length, foods: allMeals.reduce((total, meal) => total + foodsOf(meal.localId).length, 0) }

  return <div className="rv-review dr-review" data-review="diet">
    {reanalysis && <ReanalysisPanel differences={differences} describe={describe} editCount={draft.decisions.length} onAdopt={onAdoptReanalysis} onDismiss={onDismissReanalysis} />}
    <section className="panel" id="rv-summary" tabIndex={-1} aria-labelledby="rv-summary-title">
      <h2 id="rv-summary-title">Revisione del piano alimentare</h2>
      <ul className="rv-counts">
        <li>{days.length} {days.length === 1 ? 'giornata' : 'giornate'}{days.length > mealPlanLimits.days ? ` (massimo ${mealPlanLimits.days})` : ''}</li>
        <li>{counts.meals} {counts.meals === 1 ? 'pasto' : 'pasti'}</li>
        <li>{counts.foods} {counts.foods === 1 ? 'alimento' : 'alimenti'}</li>
        {rules.length > 0 && <li>{rules.length} {rules.length === 1 ? 'regola dell’intero piano' : 'regole dell’intero piano'}</li>}
      </ul>
      {readiness.ready ? <p className="rv-status is-ready" role="status"><Icon name="check" size={20} />Revisione completa: controlla l’anteprima e conferma.</p>
        : <p className="rv-status is-blocked" role="status"><Icon name="alert" size={20} />{readiness.blocking.length + mappingIssues.length} da risolvere, {readiness.confirmations.length} da confermare.</p>}
      {error && <p className="rv-error" role="alert">{error}</p>}
      {(openFindings.length > 0 || mappingIssues.length > 0) && <>
        <h3>Da sistemare prima</h3>
        <ul className="rv-finding-list" data-list="open">{mappingIssues.map(mappingCard)}{openFindings.map(issueCard)}</ul>
      </>}
      {settled.length > 0 && <details className="rv-more"><summary>Confermati e informazioni ({settled.length})</summary><ul className="rv-finding-list" data-list="settled">{settled.map(issueCard)}</ul></details>}
    </section>

    <div className="rv-layout">
      <div className="rv-main">
        <section className="panel" aria-labelledby="dr-plan-title" id={itemId(root.localId)} tabIndex={-1}>
          <h2 id="dr-plan-title">Piano</h2>
          <div className="rv-fields">
            {text(root, 'title', domainLimits.diet.name)}
            {list(root, 'guidance', 'Aggiungi un’indicazione', 'Indicazione', domainLimits.diet.guidance)}
          </div>
        </section>

        {rules.length > 0 && <section className="panel dr-rules" aria-labelledby="dr-rules-title">
          <h2 id="dr-rules-title">Regole dell’intero piano</h2>
          <p className="field-help">Valgono per tutte le giornate e compaiono una sola volta, nelle indicazioni del piano: non vanno copiate nei pasti.</p>
          <ul className="dr-rule-list">{rules.map(rule => <li key={rule.localId} className="dr-rule" id={itemId(rule.localId)} tabIndex={-1} data-local-id={rule.localId}>
            <div className="dr-item-head"><h3>{ruleLabels[rule.values.kind]} · intero piano</h3></div>
            {itemIssues(rule.localId)}
            {outcome.mapping.issues.filter(issue => issue.localId === rule.localId && !issue.code.endsWith('_review_required')).map(issue => <p key={issue.code} className="rv-field-issue is-blocking">{issue.message}</p>)}
            <Field id={fieldId(rule.localId, 'text')} label="Testo della regola" origin={origin(rule.localId, 'text')} issues={issues(rule.localId, 'text')} onSource={sourceButton(rule.localId, null)}>
              <TextField id={fieldId(rule.localId, 'text')} value={rule.values.text} nullable={false} multiline max={domainLimits.diet.lineChars} onCommit={next => set(rule.localId, 'text', next ?? '')} />
            </Field>
          </li>)}</ul>
        </section>}

        <section className="panel" aria-labelledby="dr-days-title">
          <h2 id="dr-days-title">Giornate e pasti</h2>
          <ol className="dr-days">{days.map(day => {
            const meals = mealsOf(day.localId)
            return <li key={day.localId} className="dr-day" data-local-id={day.localId}>
              <div className="dr-item-head">
                <h3 id={itemId(day.localId)} tabIndex={-1}>{day.values.name ?? 'Giornata senza nome'}</h3>
                {tools(day, `giornata ${day.values.name ?? ''}`.trim(), days)}
              </div>
              {itemIssues(day.localId)}
              <div className="rv-fields is-grid">
                {text(day, 'name', domainLimits.diet.dayName, { label: 'Nome della giornata' })}
                <Field id={fieldId(day.localId, 'dayType')} group label="Tipo di giornata" origin={origin(day.localId, 'dayType')} issues={issues(day.localId, 'dayType')} onSource={sourceButton(day.localId, 'dayType')}
                  help={day.values.dayType === null ? 'Il documento non lo indica: scegli tu. «Qualsiasi giorno» è una scelta, non un valore predefinito.' : undefined}>
                  <ChoiceField labelledBy={`${fieldId(day.localId, 'dayType')}-label`} nullable={false} value={day.values.dayType}
                    options={[{ value: 'training', label: 'Allenamento' }, { value: 'rest', label: 'Riposo' }, { value: 'any', label: 'Qualsiasi giorno' }]}
                    onChange={next => { if (next !== null) set(day.localId, 'dayType', next) }} />
                </Field>
                <div className="is-wide">{list(day, 'notes', 'Aggiungi una nota', 'Nota della giornata', domainLimits.diet.note, { label: 'Note della giornata' })}</div>
              </div>
              <ol className="dr-meals">{meals.map(meal => mealCard(meal, day, meals))}</ol>
              {meals.length === 0 && <p className="small muted">Nessun pasto in questa giornata.</p>}
              <button type="button" id={`rv-add-meals-${day.localId}`} className="button secondary rv-add" onClick={() => add('meals', day.localId, { name: null, timeText: null, alternatives: [], additions: [], notes: [] }, 'name')}><Icon name="plus" size={16} />Aggiungi un pasto</button>
            </li>
          })}</ol>
          {days.length === 0 && <p className="muted">Nessuna giornata.</p>}
          <button type="button" id={`rv-add-days-${root.localId}`} className="button secondary rv-add" onClick={() => add('days', root.localId, { name: null, dayType: null, notes: [] }, 'name')}><Icon name="plus" size={16} />Aggiungi una giornata</button>
        </section>

        <DietImportPreview mapping={outcome.mapping} />

        {onConfirm && <section className="panel rv-confirm" aria-labelledby="rv-confirm-title">
          <h2 id="rv-confirm-title">Conferma</h2>
          <p className="small muted">Qui non viene salvato nulla: la conferma passa il piano rivisto al passo successivo.</p>
          <button type="button" className="button primary" disabled={!readiness.ready || !outcome.mapping.ok}
            onClick={() => { if (readiness.ready && outcome.mapping.ok) onConfirm({ draft, ids, mapping: outcome.mapping.value }) }}>{confirmLabel}</button>
          {!readiness.ready && <p className="field-help">Disponibile quando non restano punti da risolvere o da confermare.</p>}
        </section>}
      </div>

      <section className="panel rv-source-panel" aria-labelledby="rv-source-title">
        <h2 id="rv-source-title">Documento</h2>
        {source.refs.length > 0 || source.selected ? <p className="rv-source-hint small">
          {source.refs.length > 0 ? `Evidenziati ${source.refs.length} ${source.refs.length === 1 ? 'punto' : 'punti'} del documento.` : 'Punto scelto nel documento.'}
          {source.from && <> <button type="button" className="text-button" onClick={() => setFocusTarget(source.from)}>Torna al campo</button></>}
        </p> : <p className="rv-source-hint field-help">Tocca «Fonte» accanto a un valore per vedere da dove viene.</p>}
        {source.selected && <ul className="rv-source-users" aria-label="Valori collegati a questo punto">
          {users.length === 0 ? <li className="muted">Nessun valore del piano cita questo punto.</li>
            : users.map(user => <li key={`${user.localId}-${user.field}`}><button type="button" className="text-button" onClick={() => goTo(user.localId, user.field)}>{context(user.localId)}{user.field ? ` · ${fieldLabels[user.field] ?? user.field}` : ''}</button></li>)}
        </ul>}
        <SourceViewer document={sourceDocument} format={format} original={original} pageCount={pageCount} selectedId={source.selected} highlightIds={source.refs}
          onSelect={blockId => setSource(previous => ({ ...previous, selected: blockId }))} originalUnavailable={originalUnavailable} />
      </section>
    </div>
  </div>
}
