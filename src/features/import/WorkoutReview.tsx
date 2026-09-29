import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { weekdays } from '../../domain/weekly.ts'
import {
  domainLimits, exerciseChoiceValues,
  type ExerciseChoice, type ExtractedComplexRule, type ExtractedExercise, type ExtractedSession, type NormalizedDocument, type ReviewDraft,
  type ReviewItem, type ValidationIssue, type WorkoutExtraction, type WorkoutReviewDraft,
} from '../../import/contracts/index.ts'
import type { WorkoutMapping, WorkoutMappingIds } from '../../import/mapping/workout.ts'
import type { CatalogSnapshot, MatchOccurrence } from '../../import/matching/exercises.ts'
import {
  addItem, chooseCatalog, compareWithProposal, confirmFinding, DecisionError, moveItem, removeItem, setField, staleConfirmations,
} from '../../import/review/decisions.ts'
import { resolvePointer, type ValidationFinding } from '../../import/validation/validate.ts'
import { ExerciseMatchPicker, type ReusableNewExercise } from './ExerciseMatchPicker'
import { ChoiceField, Field, FindingCard, NumberField, RangeField, ReanalysisPanel, ScalarChoice, TextField, TextListField, type FieldIssue } from './ReviewParts'
import {
  childrenOf, findingState, formatRange, isRange, mappingOnlyIssues, originLabel, proposalValue, reserveWorkoutIds, ReviewIndex, rootOf,
  workoutReviewOutcome, type Range,
} from './review-model'
import { SourceViewer } from './SourceViewer'
import { WorkoutImportPreview } from './WorkoutImportPreview'
import './review.css'
import './workout-review.css'

/**
 * Revisione della scheda importata (task 12, specifica §9.2): componente controllato che modifica la bozza
 * solo con le azioni pure del 07 (ogni modifica è una decisione tracciata sulla proposta immutabile), mostra
 * problemi e origine dei valori dalla validazione 06, la fonte affiancata, le scelte del catalogo dal matching
 * 08 e l'anteprima dal mapper 09. Nessuna scrittura, rete o salvataggio: `onConfirm` riceve bozza, ID
 * prenotati e mapping valido, e solo quando la revisione è pronta. Il collegamento all'app è del task 22.
 */
export interface WorkoutReviewValue { draft: WorkoutReviewDraft; ids: WorkoutMappingIds }
export interface WorkoutReviewResult extends WorkoutReviewValue { mapping: WorkoutMapping }

type RootValues = Pick<WorkoutExtraction, 'title' | 'guidance' | 'schedule' | 'cycle'>
type SessionValues = Omit<ExtractedSession, 'exercises'>
type Item<V> = ReviewItem & { values: V }

const ruleLabels: Record<ExtractedComplexRule['kind'], string> = {
  phase: 'Fase', progression: 'Progressione', deload: 'Scarico', superset: 'Superserie', circuit: 'Circuito', cardio: 'Cardio', other: 'Altra regola',
}
const complexKinds: readonly string[] = ['phase', 'progression', 'deload', 'superset', 'circuit']
const fieldLabels: Record<string, string> = {
  title: 'Nome', guidance: 'Indicazioni', schedule: 'Calendario', cycle: 'Ciclo', label: 'Etichetta', weekday: 'Giorno', notes: 'Note',
  name: 'Nome', variant: 'Variante', equipment: 'Attrezzo', measurementMode: 'Misura', sets: 'Serie', optionalSets: 'Serie facoltative',
  repetitions: 'Ripetizioni', durationSeconds: 'Durata', restSeconds: 'Recupero', rir: 'RIR', rpe: 'RPE', perSide: 'Per lato',
  loadUnit: 'Unità del carico', loadConvention: 'Tipo di carico', loadInstruction: 'Carico prescritto', tempoInstruction: 'Tempo di esecuzione',
  prescriptionText: 'Riga del documento', text: 'Regola', catalog: 'Esercizio del catalogo',
}
/** Campo da raggiungere per i problemi del solo mapping (09). */
const mappingFields: Record<string, string> = {
  workout_schedule_required: 'schedule', workout_rotation_labels: 'schedule', workout_weekday_required: 'weekday', workout_rotation_weekday: 'weekday',
  workout_optional_confirmation: 'optionalSets', workout_identity_choice_required: 'catalog', workout_catalog_changed: 'catalog',
}
const emptyExercise: ExtractedExercise = {
  name: null, variant: null, equipment: null, measurementMode: null, sets: null, optionalSets: null, repetitions: null, durationSeconds: null,
  restSeconds: null, rir: null, rpe: null, perSide: null, loadUnit: null, loadConvention: null, loadInstruction: null, tempoInstruction: null,
  prescriptionText: '', notes: [],
}
const fieldId = (localId: string, field: string) => `rv-${localId}-${field}`
const itemId = (localId: string) => `rv-item-${localId}`

export function WorkoutReview({
  document: sourceDocument, format, original = null, pageCount = null, originalUnavailable, value, onChange, catalog,
  reanalysis = null, onAdoptReanalysis, onDismissReanalysis, onConfirm, confirmLabel = 'Conferma la revisione', newId = () => crypto.randomUUID(),
}: {
  document: NormalizedDocument
  format: 'docx' | 'pdf'
  original?: Uint8Array | null
  pageCount?: number | null
  originalUnavailable?: ReactNode
  /** Bozza e ID prenotati: `reserveWorkoutIds(draft, null)` alla prima apertura, poi quelli ricevuti da `onChange`. */
  value: WorkoutReviewValue
  onChange: (value: WorkoutReviewValue) => void
  /** Snapshot del catalogo letto dall'app (08); `complete` solo dopo entrambe le letture paginate. */
  catalog: CatalogSnapshot
  /** Nuova proposta da confrontare (rianalisi): mai applicata senza una scelta esplicita. */
  reanalysis?: WorkoutReviewDraft | null
  onAdoptReanalysis?: () => void
  onDismissReanalysis?: () => void
  /** Solo con revisione pronta: stessi dati di anteprima e comando. Nessun salvataggio qui. */
  onConfirm?: (result: WorkoutReviewResult) => void
  confirmLabel?: string
  /** ID locali degli elementi aggiunti (UUID casuali per default). */
  newId?: () => string
}) {
  const { draft } = value
  const ids = useMemo(() => reserveWorkoutIds(draft, value.ids), [draft, value.ids])
  useEffect(() => { if (ids !== value.ids) onChange({ draft, ids }) }, [ids, value.ids, draft, onChange])
  const outcome = useMemo(() => workoutReviewOutcome(sourceDocument, draft, ids), [sourceDocument, draft, ids])
  const index = useMemo(() => new ReviewIndex(draft, outcome.validation), [draft, outcome.validation])
  const stale = useMemo(() => staleConfirmations(draft), [draft])
  const [error, setError] = useState<string | null>(null)
  const [source, setSource] = useState<{ refs: string[]; selected: string | null; from: string | null }>({ refs: [], selected: null, from: null })
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [picker, setPicker] = useState<string | null>(null)
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
    if (next !== draft) onChange({ draft: next as WorkoutReviewDraft, ids: reserveWorkoutIds(next as WorkoutReviewDraft, ids) })
    if (focus) setFocusTarget(focus)
  }
  const set = (localId: string, field: string, next: unknown, reason: 'user_edit' | 'timer_choice' | 'confirmed_missing' | 'scope_choice' = 'user_edit') =>
    apply(current => setField(current, localId, field, next as never, reason))

  const root = rootOf(draft) as Item<RootValues>
  const sessions = childrenOf(draft, root.localId, 'sessions') as Item<SessionValues>[]
  const rules = childrenOf(draft, root.localId, 'complexRules') as Item<ExtractedComplexRule>[]
  const exercisesOf = (sessionId: string) => childrenOf(draft, sessionId, 'exercises') as (Item<ExtractedExercise> & { catalog: ExerciseChoice | null })[]
  const allExercises = sessions.flatMap(session => exercisesOf(session.localId))
  const byId = new Map((draft.current as readonly ReviewItem[]).map(item => [item.localId, item]))

  const issues = (localId: string, field: string | null): FieldIssue[] => index.findingsOf(localId, field).map(finding => ({ finding, state: findingState(draft, finding, stale) }))
  const origin = (localId: string, field: string) => originLabel(index.provenance(localId, field))
  const showSource = (localId: string, field: string | null) => {
    const refs = index.refs(localId, field)
    setSource({ refs, selected: refs[0] ?? null, from: field ? fieldId(localId, field) : itemId(localId) })
  }
  const sourceButton = (localId: string, field: string | null) => index.refs(localId, field).length ? () => showSource(localId, field) : undefined
  const exerciseName = (item: Item<ExtractedExercise> & { catalog: ExerciseChoice | null }) => item.catalog ? exerciseChoiceValues(item.catalog).name : item.values.name ?? 'Esercizio senza nome'
  const context = (localId: string | null): string => {
    const item = localId ? byId.get(localId) : undefined
    if (!item || item.collection === 'root') return 'Scheda'
    if (item.collection === 'sessions') return `Seduta ${(item.values as SessionValues).label ?? 'senza etichetta'}`
    if (item.collection === 'complexRules') return `Regola: ${ruleLabels[(item.values as ExtractedComplexRule).kind]}`
    return `${context(item.parentLocalId)} · ${exerciseName(item as Item<ExtractedExercise> & { catalog: ExerciseChoice | null })}`
  }
  const goTo = (localId: string | null, field: string | null) => {
    const item = localId ? byId.get(localId) : undefined
    if (!item) { setFocusTarget('rv-summary'); return }
    if (item.collection === 'exercises') setExpanded(previous => new Set(previous).add(item.localId))
    setFocusTarget(item.collection === 'root' && field === 'schedule' ? 'rv-schedule' : field ? fieldId(item.localId, field) : itemId(item.localId))
  }

  // ---------------------------------------------------------------- struttura
  const addSession = () => {
    const localId = newId()
    apply(current => addItem(current, { collection: 'sessions', parentLocalId: root.localId, localId, values: { label: null, title: null, weekday: null, notes: [] } }), fieldId(localId, 'label'))
  }
  const addExercise = (sessionId: string) => {
    const localId = newId()
    setExpanded(previous => new Set(previous).add(localId))
    apply(current => addItem(current, { collection: 'exercises', parentLocalId: sessionId, localId, values: { ...emptyExercise, notes: [] } }), fieldId(localId, 'name'))
  }
  const remove = (item: ReviewItem) => {
    const siblings = childrenOf(draft, item.parentLocalId!, item.collection)
    const at = siblings.findIndex(entry => entry.localId === item.localId)
    const neighbour = siblings[at + 1] ?? siblings[at - 1]
    apply(current => removeItem(current, item.localId), neighbour ? itemId(neighbour.localId) : item.collection === 'sessions' ? 'rv-add-session' : `rv-add-${item.parentLocalId}`)
  }
  const move = (item: ReviewItem, delta: -1 | 1) => {
    const siblings = childrenOf(draft, item.parentLocalId!, item.collection)
    const at = siblings.findIndex(entry => entry.localId === item.localId)
    const to = at + delta
    if (to < 0 || to >= siblings.length) return
    const edge = to === 0 || to === siblings.length - 1
    apply(current => moveItem(current, item.localId, item.parentLocalId!, to), `rv-move-${item.localId}-${edge ? (delta < 0 ? 'down' : 'up') : delta < 0 ? 'up' : 'down'}`)
  }
  const moveTo = (item: ReviewItem, sessionId: string) => apply(current => moveItem(current, item.localId, sessionId, childrenOf(current, sessionId, 'exercises').length), itemId(item.localId))
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
    if (code === 'optional_sets_missing' && localId) out.push(<button key="none" type="button" className="text-button" onClick={() => set(localId, 'optionalSets', 0, 'confirmed_missing')}>Nessuna serie facoltativa</button>)
    else if (resolutions.includes('catalog_choice') && localId) out.push(<button key="catalog" type="button" className="text-button" onClick={() => setPicker(localId)}>Scegli l’esercizio</button>)
    else if (resolutions.includes('scope_choice') && code !== 'complex_rule_unresolved') out.push(<button key="scope" type="button" className="text-button" onClick={() => apply(current => confirmFinding(current, finding, 'scope_choice'))}>Ho controllato: confermo</button>)
    else if (resolutions.includes('confirmed_missing')) out.push(<button key="missing" type="button" className="text-button" onClick={() => apply(current => confirmFinding(current, finding, 'confirmed_missing'))}>Confermo che non è indicato</button>)
    if (resolutions.includes('remove_item') && item && item.collection !== 'root') out.push(<button key="remove" type="button" className="text-button delete-link" onClick={() => remove(item)}>Rimuovi {item.collection === 'sessions' ? 'la seduta' : 'l’esercizio'}</button>)
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
    {/\/days\/\d+\/label/.test(issue.message) && issue.code === 'resolved_contract_violation'
      ? <p>Due sedute cadono nello stesso giorno o hanno la stessa etichetta: cambia il giorno o l’etichetta di una delle due. <span className="small muted">({issue.message})</span></p>
      : <p>{issue.message}</p>}
    {issue.localId && <div className="rv-finding-actions"><button type="button" className="text-button" onClick={() => goTo(issue.localId, mappingFields[issue.code] ?? null)}>Vai al punto</button></div>}
  </li>

  // ---------------------------------------------------------------- campi
  const text = (item: ReviewItem, field: string, max?: number, options: { nullable?: boolean; multiline?: boolean; label?: string } = {}) => <Field id={fieldId(item.localId, field)} label={options.label ?? fieldLabels[field]!} origin={origin(item.localId, field)} issues={issues(item.localId, field)} onSource={sourceButton(item.localId, field)}>
    <TextField id={fieldId(item.localId, field)} value={(item.values as unknown as Record<string, string | null>)[field]!} max={max} nullable={options.nullable} multiline={options.multiline} onCommit={next => set(item.localId, field, next)} />
  </Field>
  const list = (item: ReviewItem, field: string, addLabel: string, itemLabel: string, max?: number) => <Field id={fieldId(item.localId, field)} group label={fieldLabels[field]!} origin={origin(item.localId, field)} issues={issues(item.localId, field)} onSource={sourceButton(item.localId, field)}>
    <TextListField id={fieldId(item.localId, field)} values={(item.values as unknown as Record<string, string[]>)[field]!} addLabel={addLabel} itemLabel={itemLabel} max={max} onCommit={next => set(item.localId, field, next)} />
  </Field>
  const range = (item: Item<ExtractedExercise>, field: 'repetitions' | 'durationSeconds' | 'restSeconds' | 'rir' | 'rpe', suffix?: string) => {
    const current = item.values[field]
    const scalarReason = field === 'restSeconds' || field === 'durationSeconds' ? 'timer_choice' as const : 'user_edit' as const
    const needsScalar = field !== 'repetitions' && isRange(current) && current.min !== current.max
    return <Field id={fieldId(item.localId, field)} group label={fieldLabels[field]!} origin={origin(item.localId, field)} issues={issues(item.localId, field)} onSource={sourceButton(item.localId, field)}
      help={field === 'restSeconds' ? 'Recupero 0 solo se previsto: un recupero non indicato non diventa 0.' : undefined}>
      <RangeField id={fieldId(item.localId, field)} value={current} suffix={suffix} onCommit={next => set(item.localId, field, next)} />
      {needsScalar && <ScalarChoice id={`${fieldId(item.localId, field)}-scalar`} range={current as Range} suffix={suffix}
        label={field === 'restSeconds' || field === 'durationSeconds' ? 'Valore del timer' : `Valore di ${fieldLabels[field]} da usare`}
        onChoose={chosen => set(item.localId, field, { min: chosen, max: chosen }, scalarReason)} />}
    </Field>
  }
  const choice = <T extends string>(item: ReviewItem, field: string, options: { value: T; label: string }[]) => <Field id={fieldId(item.localId, field)} group label={fieldLabels[field]!} origin={origin(item.localId, field)} issues={issues(item.localId, field)} onSource={sourceButton(item.localId, field)}>
    <ChoiceField labelledBy={`${fieldId(item.localId, field)}-label`} value={(item.values as unknown as Record<string, T | null>)[field]!} options={options} onChange={next => set(item.localId, field, next)} />
  </Field>

  // ---------------------------------------------------------------- esercizio
  const exerciseSummary = (item: Item<ExtractedExercise>) => {
    const v = item.values
    const dose = v.measurementMode === 'seconds' || (v.durationSeconds && !v.repetitions) ? formatRange(v.durationSeconds, ' s') : formatRange(v.repetitions)
    return [`${v.sets ?? '?'} × ${dose || '?'}`, v.restSeconds ? `recupero ${formatRange(v.restSeconds, ' s')}` : 'recupero non indicato'].join(' · ')
  }
  const exerciseDetail = (item: Item<ExtractedExercise> & { catalog: ExerciseChoice | null }, session: Item<SessionValues>) => {
    const v = item.values
    return <div className="wr-exercise-detail" id={`rv-detail-${item.localId}`}>
      <Field id={fieldId(item.localId, 'catalog')} group label="Esercizio del catalogo" issues={issues(item.localId, null).filter(issue => issue.finding.issue.stage === 'catalog')}>
        {item.catalog ? <div className="wr-choice">
          <strong>{exerciseChoiceValues(item.catalog).name}</strong>
          <span className="rv-origin">{item.catalog.source === 'new' ? 'Nuovo esercizio, dati confermati da te' : item.catalog.source === 'shared' ? 'Scelto dal catalogo comune' : 'Scelto dal catalogo'}</span>
          <span className="small muted">{[exerciseChoiceValues(item.catalog).variant, exerciseChoiceValues(item.catalog).equipment].filter(Boolean).join(' · ')}</span>
        </div> : <p className="small muted">Non ancora scelto.</p>}
        <div className="rv-field-actions">
          <button type="button" id={`${fieldId(item.localId, 'catalog')}-pick`} className="button secondary" onClick={() => setPicker(item.localId)}>{item.catalog ? 'Cambia esercizio' : 'Scegli l’esercizio'}</button>
          {item.catalog && <button type="button" className="text-button" onClick={() => apply(current => chooseCatalog(current, item.localId, null))}>Togli la scelta</button>}
        </div>
      </Field>
      <div className="rv-fields is-grid">
        {text(item, 'name', domainLimits.exercise.name)}
        {text(item, 'variant', domainLimits.exercise.variant)}
        {text(item, 'equipment', domainLimits.exercise.equipment)}
        {choice(item, 'measurementMode', [{ value: 'reps', label: 'Ripetizioni' }, { value: 'seconds', label: 'Secondi' }])}
        <Field id={fieldId(item.localId, 'sets')} label="Serie" origin={origin(item.localId, 'sets')} issues={issues(item.localId, 'sets')} onSource={sourceButton(item.localId, 'sets')}>
          <NumberField id={fieldId(item.localId, 'sets')} value={v.sets} onCommit={next => set(item.localId, 'sets', next)} />
        </Field>
        <Field id={fieldId(item.localId, 'optionalSets')} label="Serie facoltative" origin={origin(item.localId, 'optionalSets')} issues={issues(item.localId, 'optionalSets')} onSource={sourceButton(item.localId, 'optionalSets')}
          actions={v.optionalSets === null ? <button type="button" className="text-button" onClick={() => set(item.localId, 'optionalSets', 0, 'confirmed_missing')}>Nessuna serie facoltativa</button> : undefined}>
          <NumberField id={fieldId(item.localId, 'optionalSets')} value={v.optionalSets} onCommit={next => set(item.localId, 'optionalSets', next)} />
        </Field>
        {range(item, 'repetitions')}
        {range(item, 'durationSeconds', ' s')}
        {range(item, 'restSeconds', ' s')}
        {range(item, 'rir')}
        {range(item, 'rpe')}
        <Field id={fieldId(item.localId, 'perSide')} group label="Per lato" origin={origin(item.localId, 'perSide')} issues={issues(item.localId, 'perSide')} onSource={sourceButton(item.localId, 'perSide')}>
          <ChoiceField labelledBy={`${fieldId(item.localId, 'perSide')}-label`} value={v.perSide === null ? null : v.perSide ? 'yes' : 'no'}
            options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Sì' }]} onChange={next => set(item.localId, 'perSide', next === null ? null : next === 'yes')} />
        </Field>
        {choice(item, 'loadConvention', [{ value: 'total', label: 'Carico totale' }, { value: 'single-dumbbell', label: 'Un manubrio' }, { value: 'bodyweight', label: 'Corpo libero' }])}
        {choice(item, 'loadUnit', [{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }])}
        {text(item, 'loadInstruction', domainLimits.workout.prescriptionNote)}
        {text(item, 'tempoInstruction', domainLimits.workout.prescriptionNote)}
        <div className="is-wide">{text(item, 'prescriptionText', domainLimits.workout.prescriptionNote, { nullable: false, multiline: true })}</div>
        <div className="is-wide">{list(item, 'notes', 'Aggiungi una nota', 'Nota', domainLimits.workout.prescriptionNote)}</div>
      </div>
      {sessions.length > 1 && <label className="wr-move-session">Sposta in un’altra seduta
        <select value={session.localId} onChange={event => moveTo(item, event.target.value)}>
          {sessions.map(entry => <option key={entry.localId} value={entry.localId}>Seduta {entry.values.label ?? 'senza etichetta'}{entry.values.title ? ` · ${entry.values.title}` : ''}</option>)}
        </select>
      </label>}
    </div>
  }

  const exerciseRow = (item: Item<ExtractedExercise> & { catalog: ExerciseChoice | null }, session: Item<SessionValues>, siblings: readonly ReviewItem[]) => {
    const open = expanded.has(item.localId)
    const own = index.itemFindings(item.localId).filter(finding => { const state = findingState(draft, finding, stale); return state === 'open' || state === 'stale' })
    const blocking = own.filter(finding => finding.issue.severity === 'blocking').length
    const name = exerciseName(item)
    return <li key={item.localId} className={`wr-exercise${open ? ' is-open' : ''}`} data-local-id={item.localId}>
      <div className="wr-exercise-row">
        <button type="button" id={itemId(item.localId)} className="wr-exercise-toggle" aria-expanded={open} aria-controls={`rv-detail-${item.localId}`}
          onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(item.localId)) next.delete(item.localId); else next.add(item.localId); return next })}>
          <span className="wr-exercise-name">{name}</span>
          <span className="small muted">{exerciseSummary(item)}</span>
          {own.length > 0 ? <span className={`rv-badge ${blocking ? 'is-blocking' : 'is-confirmation'}`}>{blocking ? `${blocking} da risolvere` : `${own.length} da confermare`}</span>
            : <span className="rv-badge is-ok">Completo</span>}
        </button>
        {tools(item, `esercizio ${name}`, siblings)}
      </div>
      {open && exerciseDetail(item, session)}
    </li>
  }

  // ---------------------------------------------------------------- regole
  const ruleCard = (rule: Item<ExtractedComplexRule>) => <RuleCard key={rule.localId} rule={rule} draft={draft}
    complex={complexKinds.includes(rule.values.kind)} targets={ruleTargets(rule)} issues={issues(rule.localId, null)}
    mapping={outcome.mapping.issues.filter(issue => issue.localId === rule.localId && issue.stage === 'mapping' && !issue.code.endsWith('_review_required'))}
    onSource={sourceButton(rule.localId, null)}
    onResolve={(nextText, reason) => apply(current => {
      let next = setField(current, rule.localId, 'text', nextText, reason)
      const finding = index.findings.find(entry => entry.issue.localId === rule.localId && (entry.issue.code === 'complex_rule_unresolved' || entry.issue.code === 'complex_rule_review'))
      if (finding && finding.issue.resolutions.includes('scope_choice') && reason === 'scope_choice') next = confirmFinding(next, finding, 'scope_choice')
      return next
    })}
    onReconfirm={() => apply(current => {
      const finding = index.findings.find(entry => entry.issue.localId === rule.localId && entry.issue.code === 'complex_rule_unresolved')
      return finding ? confirmFinding(current, finding, 'scope_choice') : current
    })} />
  function ruleTargets(rule: Item<ExtractedComplexRule>) {
    if (!rule.values.targetPaths.length) return 'Intera scheda'
    return rule.values.targetPaths.map(path => {
      const localId = draft.localIds.find(entry => entry.pointer === path)?.localId
      return localId && byId.has(localId) ? context(localId) : 'elemento non più presente'
    }).join('; ')
  }

  // ---------------------------------------------------------------- confronto e fonte
  const differences = reanalysis ? compareWithProposal(draft, reanalysis) : []
  const describe = (difference: { pointer: string; collection: string }) => {
    const found = reanalysis ? resolvePointer(reanalysis.proposal.extraction, difference.pointer) : null
    const fromNext = found?.found ? found.value as Record<string, unknown> : null
    const oldId = draft.localIds.find(entry => entry.pointer === difference.pointer)?.localId
    const label = fromNext?.name ?? fromNext?.label ?? fromNext?.title ?? (oldId ? context(oldId) : null)
    const noun = { root: 'Scheda', sessions: 'Seduta', exercises: 'Esercizio', complexRules: 'Regola' }[difference.collection] ?? 'Elemento'
    return `${noun}${label ? ` «${String(label)}»` : ''}`
  }
  const users = source.selected ? index.usersOf(source.selected) : []
  const readiness = outcome.readiness
  const pickerItem = picker ? allExercises.find(item => item.localId === picker) : undefined
  const reusable: ReusableNewExercise[] = []
  for (const item of allExercises) if (item.catalog?.source === 'new' && item.localId !== picker) {
    const existing = reusable.find(entry => entry.localKey === (item.catalog as Extract<ExerciseChoice, { source: 'new' }>).localKey)
    if (existing) existing.usedBy += `, ${context(item.localId)}`
    else reusable.push({ localKey: item.catalog.localKey, values: item.catalog.values, usedBy: context(item.localId) })
  }

  return <div className="rv-review wr-review" data-review="workout">
    {reanalysis && <ReanalysisPanel differences={differences} describe={describe} editCount={draft.decisions.length} onAdopt={onAdoptReanalysis} onDismiss={onDismissReanalysis} />}
    <section className="panel" id="rv-summary" tabIndex={-1} aria-labelledby="rv-summary-title">
      <h2 id="rv-summary-title">Revisione della scheda</h2>
      <ul className="rv-counts">
        <li>{sessions.length} {sessions.length === 1 ? 'seduta' : 'sedute'}</li>
        <li>{allExercises.length} {allExercises.length === 1 ? 'esercizio' : 'esercizi'}</li>
        {rules.length > 0 && <li>{rules.length} {rules.length === 1 ? 'regola' : 'regole'}</li>}
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
        <section className="panel" aria-labelledby="rv-plan-title" id={itemId(root.localId)} tabIndex={-1}>
          <h2 id="rv-plan-title">Scheda e calendario</h2>
          <div className="rv-fields">
            {text(root, 'title', domainLimits.workout.title, { label: 'Nome della scheda' })}
            <Field id="rv-schedule" group label="Calendario" origin={origin(root.localId, 'schedule')} issues={issues(root.localId, 'schedule')} onSource={sourceButton(root.localId, 'schedule')}
              help={root.values.schedule === 'unknown' ? 'Il documento non dice se le sedute sono legate ai giorni della settimana: scegli tu.' : root.values.schedule === 'weekly' ? 'Ogni seduta ha il suo giorno (Lun…Dom); gli altri giorni sono di riposo.' : 'Le sedute si alternano in ordine (A, B, C…), senza giorni fissi.'}>
              <ChoiceField labelledBy="rv-schedule-label" nullable={false} value={root.values.schedule === 'unknown' ? null : root.values.schedule}
                options={[{ value: 'weekly', label: 'Giorni della settimana' }, { value: 'rotation', label: 'A rotazione' }]} onChange={next => set(root.localId, 'schedule', next ?? 'unknown')} />
            </Field>
            <CycleField id={fieldId(root.localId, 'cycle')} value={root.values.cycle} origin={origin(root.localId, 'cycle')} issues={issues(root.localId, 'cycle')} onSource={sourceButton(root.localId, 'cycle')} onCommit={next => set(root.localId, 'cycle', next)} />
            {list(root, 'guidance', 'Aggiungi un’indicazione', 'Indicazione', domainLimits.workout.guidance)}
          </div>
          {issues(root.localId, null).filter(issue => issue.state === 'open' || issue.state === 'stale').length > 0 && <p className="field-help">Altri punti dell’intera scheda sono nell’elenco «Da sistemare prima».</p>}
        </section>

        <section className="panel" aria-labelledby="rv-sessions-title">
          <h2 id="rv-sessions-title">Sedute ed esercizi</h2>
          <ol className="wr-sessions">{sessions.map(session => {
            const exercises = exercisesOf(session.localId)
            return <li key={session.localId} className="wr-session" data-local-id={session.localId}>
              <div className="wr-session-head">
                <h3 id={itemId(session.localId)} tabIndex={-1}>Seduta {session.values.label ?? 'senza etichetta'}{session.values.title ? ` · ${session.values.title}` : ''}</h3>
                {tools(session, `seduta ${session.values.label ?? ''}`.trim(), sessions)}
              </div>
              {issues(session.localId, null).filter(issue => issue.state !== 'confirmed').map(issue => <p key={issue.finding.issue.code} className={`rv-field-issue is-${issue.finding.issue.severity}`}>{issue.finding.issue.message}</p>)}
              <div className="rv-fields is-grid">
                {text(session, 'label', domainLimits.workout.dayLabel)}
                {text(session, 'title', domainLimits.workout.dayTitle, { label: 'Titolo della seduta' })}
                <Field id={fieldId(session.localId, 'weekday')} label="Giorno della settimana" origin={origin(session.localId, 'weekday')} issues={issues(session.localId, 'weekday')} onSource={sourceButton(session.localId, 'weekday')}
                  help={root.values.schedule === 'rotation' && session.values.weekday !== null ? 'In una rotazione le sedute non hanno giorni fissi: togli il giorno o scegli il calendario settimanale.' : undefined}>
                  <select id={fieldId(session.localId, 'weekday')} value={session.values.weekday ?? ''} onChange={event => set(session.localId, 'weekday', event.target.value === '' ? null : Number(event.target.value))}>
                    <option value="">Non indicato</option>
                    {weekdays.map((day, position) => <option key={day.code} value={position + 1}>{day.name}</option>)}
                  </select>
                </Field>
                <div className="is-wide">{list(session, 'notes', 'Aggiungi una nota', 'Nota della seduta', domainLimits.workout.dayNote)}</div>
              </div>
              <ol className="wr-exercises">{exercises.map(item => exerciseRow(item, session, exercises))}</ol>
              {exercises.length === 0 && <p className="small muted">Nessun esercizio in questa seduta.</p>}
              <button type="button" id={`rv-add-${session.localId}`} className="button secondary rv-add" onClick={() => addExercise(session.localId)}><Icon name="plus" size={16} />Aggiungi un esercizio</button>
            </li>
          })}</ol>
          {sessions.length === 0 && <p className="muted">Nessuna seduta.</p>}
          <button type="button" id="rv-add-session" className="button secondary rv-add" onClick={addSession}><Icon name="plus" size={16} />Aggiungi una seduta</button>
        </section>

        {rules.length > 0 && <section className="panel" aria-labelledby="rv-rules-title">
          <h2 id="rv-rules-title">Fasi, progressioni e altre regole</h2>
          <p className="field-help">Il programma ripete le prescrizioni scelte: fasi, progressioni, scarichi, superserie e circuiti non si eseguono da soli. Per ciascuna regola scrivi quale fase o settimana importi, oppure come la gestirai a mano. Il testo originale resta nelle indicazioni.</p>
          <div className="wr-rules">{rules.map(ruleCard)}</div>
        </section>}

        <WorkoutImportPreview mapping={outcome.mapping} draft={draft} />

        {onConfirm && <section className="panel rv-confirm" aria-labelledby="rv-confirm-title">
          <h2 id="rv-confirm-title">Conferma</h2>
          <p className="small muted">Qui non viene salvato nulla: la conferma passa la scheda rivista al passo successivo.</p>
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
          {users.length === 0 ? <li className="muted">Nessun valore della scheda cita questo punto.</li>
            : users.map(user => <li key={`${user.localId}-${user.field}`}><button type="button" className="text-button" onClick={() => goTo(user.localId, user.field)}>{context(user.localId)}{user.field ? ` · ${fieldLabels[user.field] ?? user.field}` : ''}</button></li>)}
        </ul>}
        <SourceViewer document={sourceDocument} format={format} original={original} pageCount={pageCount} selectedId={source.selected} highlightIds={source.refs}
          onSelect={blockId => setSource(previous => ({ ...previous, selected: blockId }))} originalUnavailable={originalUnavailable} />
      </section>
    </div>

    {pickerItem && <ExerciseMatchPicker key={pickerItem.localId} snapshot={catalog} current={pickerItem.catalog} reusable={reusable}
      occurrence={{ localId: pickerItem.localId, name: pickerItem.values.name, variant: pickerItem.values.variant, equipment: pickerItem.values.equipment, measurementMode: pickerItem.values.measurementMode, perSide: pickerItem.values.perSide, loadUnit: pickerItem.values.loadUnit, loadConvention: pickerItem.values.loadConvention } satisfies MatchOccurrence}
      onCancel={() => { setPicker(null); setFocusTarget(itemId(pickerItem.localId)) }}
      onChoose={next => { const localId = pickerItem.localId; setPicker(null); setExpanded(previous => new Set(previous).add(localId)); apply(current => chooseCatalog(current, localId, next), `${fieldId(localId, 'catalog')}-pick`) }} />}
  </div>
}

/** Ciclo: data d'inizio e settimane insieme, oppure nessun ciclo; mai completato dall'app. */
function CycleField({ id, value, origin, issues, onSource, onCommit }: {
  id: string; value: RootValues['cycle']; origin: string | null; issues: FieldIssue[]; onSource?: () => void; onCommit: (value: RootValues['cycle']) => void
}) {
  const [start, setStart] = useState(value.startDate ?? '')
  const [weeks, setWeeks] = useState(value.weeks === null ? '' : String(value.weeks))
  useEffect(() => { setStart(value.startDate ?? ''); setWeeks(value.weeks === null ? '' : String(value.weeks)) }, [value.startDate, value.weeks])
  const commit = () => {
    const parsed = weeks.trim() === '' ? null : Number(weeks.replace(',', '.'))
    const next = { startDate: start === '' ? null : start, weeks: parsed !== null && Number.isFinite(parsed) ? parsed : null }
    if (next.startDate !== value.startDate || next.weeks !== value.weeks) onCommit(next)
  }
  return <Field id={id} group label="Ciclo" origin={origin} issues={issues} onSource={onSource} help="Data d’inizio e numero di settimane insieme, oppure nessuno dei due.">
    <div className="wr-cycle" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit() }}>
      <label>Inizio<input id={`${id}-start`} type="date" value={start} onChange={event => setStart(event.target.value)} /></label>
      <label>Settimane<input id={`${id}-weeks`} type="text" inputMode="numeric" value={weeks} placeholder="Non indicato" onChange={event => setWeeks(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit() } }} /></label>
    </div>
  </Field>
}

/**
 * Regola della scheda. Per fasi, progressioni, scarichi, superserie e circuiti una spunta non basta: si scrive
 * quale fase o settimana si importa o come si gestisce a mano (`scope_choice`), e la scelta va confermata di
 * nuovo se la scheda cambia dopo. Il testo originale resta visibile e finisce comunque nelle indicazioni.
 */
function RuleCard({ rule, draft, complex, targets, issues, mapping, onSource, onResolve, onReconfirm }: {
  rule: Item<ExtractedComplexRule>; draft: ReviewDraft; complex: boolean; targets: string; issues: FieldIssue[]; mapping: ValidationIssue[]
  onSource?: () => void; onResolve: (text: string, reason: 'scope_choice' | 'user_edit') => void; onReconfirm: () => void
}) {
  const originalText = proposalValue(draft, rule.localId, 'text')
  const [text, setText] = useState(rule.values.text)
  useEffect(() => setText(rule.values.text), [rule.values.text])
  const lastEdit = draft.decisions.filter(decision => decision.op === 'set' && decision.localId === rule.localId && decision.field === 'text').at(-1)
  const chosen = lastEdit?.op === 'set' && lastEdit.reason === 'scope_choice'
  const stale = mapping.some(issue => issue.code === 'workout_scope_stale')
  const open = issues.filter(issue => issue.state === 'open' || issue.state === 'stale')
  const changed = text.trim() !== '' && text !== rule.values.text
  return <article className={`wr-rule${open.length || mapping.length ? ' has-issue' : ''}`} id={itemId(rule.localId)} tabIndex={-1} data-local-id={rule.localId}>
    <div className="wr-rule-head">
      <h3>{ruleLabels[rule.values.kind]}</h3>
      {complex && <span className="rv-badge is-confirmation">Gestione manuale</span>}
      {onSource && <button type="button" className="text-button rv-source-link" onClick={onSource}>Fonte</button>}
    </div>
    <p className="small muted">Si applica a: {targets}</p>
    {typeof originalText === 'string' && <div className="rv-field"><span className="rv-label">Nel documento</span><p className="rv-readonly">{originalText}</p></div>}
    <div className="rv-field">
      <label className="rv-label" htmlFor={fieldId(rule.localId, 'text')}>{complex ? 'Cosa importi e come la gestirai' : 'Testo della regola'}</label>
      {chosen && <span className="rv-origin is-user">Scelta scritta da te</span>}
      <textarea id={fieldId(rule.localId, 'text')} rows={3} value={text} onChange={event => setText(event.target.value)} />
      {complex && <p className="field-help">Per esempio «Importo la settimana 1: 3 × 10; dalla settimana 2 aumento a mano» oppure «Superserie: eseguo i due esercizi di seguito, gestita a mano».</p>}
    </div>
    {open.map(issue => <p key={issue.finding.issue.code} className={`rv-field-issue is-${issue.finding.issue.severity}`}>{issue.finding.issue.message}</p>)}
    {mapping.map(issue => <p key={issue.code} className="rv-field-issue is-blocking">{issue.message}</p>)}
    <div className="rv-field-actions">
      {complex
        ? <button type="button" className="button secondary" disabled={!changed && !(chosen && open.length > 0)} onClick={() => onResolve(text, 'scope_choice')}>Conferma questa scelta</button>
        : <button type="button" className="button secondary" disabled={!changed} onClick={() => onResolve(text, 'user_edit')}>Salva il testo</button>}
      {complex && stale && <button type="button" className="button secondary" onClick={onReconfirm}>Conferma di nuovo</button>}
    </div>
  </article>
}
