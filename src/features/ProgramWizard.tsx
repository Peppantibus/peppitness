import { withCatalogMuscleGroups } from '../domain/programs'
import { useEffect, useRef, useState } from 'react'
import { MuscleGroupSelect } from '../components/MuscleGroupSelect'
import { MuscleGroupBadge } from '../components/MuscleGroupBadge'
import { MuscleGroupImage } from '../components/MuscleGroupImage'
import { exerciseMuscleGroup, groupExercises, inferMuscleGroup, isTimedCardio, withCardioDefaults } from '../domain/muscle-groups'
import type { MuscleGroupFilter } from '../domain/muscle-groups'

import type { ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { Segmented } from '../components/Segmented'
import { Modal } from '../components/Modal'
import { emptyExercise, loadLabels, searchExercises } from '../domain/exercises'
import type { CatalogExercise, ExerciseValues } from '../domain/exercises'
import { moveItem, newPrescription } from '../domain/programs'
import type { PrescriptionDraft, ProgramDay } from '../domain/programs'
import { copyWeeklyDay, dayIssues, emptyWeeklyDay, groupsFromTitle, muscleGroups, prefillFromDay, setWeeklyDay, titleFromGroups, weekdays, weeklyDay, weeklySummary } from '../domain/weekly'
import type { ExercisesState, ExercisesStore } from '../persistence/exercises-store'
import { formatDate, isLocalDate } from '../domain/dates'
import { cycleDurations, cycleInfo, mondayOf } from '../domain/progress'
import type { ProgramsState, ProgramsStore } from '../persistence/programs-store'

export type WizardStep = 'name' | number | 'done'

/** Campo numerico con scorciatoie a un tocco: nessun valore viene scelto al posto dell'utente. */
function QuickNumber({ id, label, value, onChange, chips, error, unit }: {
  id: string; label: string; value: string; onChange: (value: string) => void; chips: { value: string; label: string }[]; error?: string; unit?: string
}) {
  return <div className={`wz-field ${error ? 'has-error' : ''}`}>
    <div className="wz-field-head"><label htmlFor={id}>{label}</label><span className="wz-input-wrap"><input id={id} inputMode="numeric" autoComplete="off" maxLength={6} value={value} placeholder="—" aria-invalid={Boolean(error) || undefined} onChange={event => onChange(event.target.value.replace(/[^\d]/g, ''))} />{unit && <span>{unit}</span>}</span></div>
    <div className="chip-row" role="group" aria-label={`${label}: valori rapidi`}>{chips.map(chip => <button key={chip.value} type="button" className="chip" aria-pressed={value === chip.value} onClick={() => onChange(chip.value)}>{chip.label}</button>)}</div>
    {error && <p className="wz-error" role="alert">{error}</p>}
  </div>
}

const repsChips = [['6', '6'], ['8', '8'], ['10', '10'], ['12', '12'], ['6', '8'], ['8', '10'], ['8', '12'], ['10', '12'], ['12', '15']] as const
const restChips = [{ value: '45', label: '45″' }, { value: '60', label: '1′' }, { value: '90', label: '1′30″' }, { value: '120', label: '2′' }, { value: '180', label: '3′' }]

function RepsField({ item, onChange, error }: { item: PrescriptionDraft; onChange: (item: PrescriptionDraft) => void; error?: string }) {
  const digits = (value: string) => value.replace(/[^\d]/g, '')
  return <div className={`wz-field ${error ? 'has-error' : ''}`}>
    <div className="wz-field-head"><span className="wz-label" id={`${item.id}-reps-label`}>Ripetizioni</span><span className="wz-range" role="group" aria-labelledby={`${item.id}-reps-label`}>
      <input aria-label="Ripetizioni minime" inputMode="numeric" maxLength={5} placeholder="min" value={item.repsMin} aria-invalid={Boolean(error) || undefined} onChange={event => onChange({ ...item, repsMin: digits(event.target.value) })} />
      <span aria-hidden="true">–</span>
      <input aria-label="Ripetizioni massime" inputMode="numeric" maxLength={5} placeholder="max" value={item.repsMax} aria-invalid={Boolean(error) || undefined} onChange={event => onChange({ ...item, repsMax: digits(event.target.value) })} />
    </span></div>
    <div className="chip-row" role="group" aria-label="Ripetizioni: valori rapidi">{repsChips.map(([min, max]) => <button key={`${min}-${max}`} type="button" className="chip" aria-pressed={item.repsMin === min && item.repsMax === max} onClick={() => onChange({ ...item, repsMin: min, repsMax: max })}>{min === max ? min : `${min}–${max}`}</button>)}</div>
    {error && <p className="wz-error" role="alert">{error}</p>}
  </div>
}

/** Cardio: si indicano solo i minuti; nel programma restano 1 serie da N secondi, senza recupero. */
function MinutesField({ item, onChange, error }: { item: PrescriptionDraft; onChange: (item: PrescriptionDraft) => void; error?: string }) {
  const seconds = Number(item.durationSeconds)
  const minutes = item.durationSeconds !== '' && Number.isFinite(seconds) ? String(Math.round(seconds / 60 * 100) / 100) : ''
  const set = (value: string) => onChange({ ...item, sets: '1', optionalSets: '0', restSeconds: '0', repsMin: '', repsMax: '', durationSeconds: value === '' ? '' : String(Number(value) * 60) })
  return <QuickNumber id={`${item.id}-minutes`} label="Durata" unit="min" value={minutes} onChange={set} error={error} chips={['10', '15', '20', '30', '45'].map(value => ({ value, label: `${value} min` }))} />
}

function ExerciseCard({ item, index, count, issues, onChange, onMove, onRemove }: {
  item: PrescriptionDraft; index: number; count: number; issues: Record<string, string>
  onChange: (item: PrescriptionDraft) => void; onMove: (direction: -1 | 1) => void; onRemove: () => void
}) {
  const meta = [item.exercise.variant, item.exercise.equipment, loadLabels[item.exercise.loadConvention], item.exercise.perSide ? 'per lato' : ''].filter(Boolean).join(' · ')
  return <article className="wz-exercise" aria-label={`${index + 1}. ${item.exercise.name}`}>
    <div className="wz-exercise-head">
      <MuscleGroupImage exercise={item.exercise} />
      <div><h3>{item.exercise.name}</h3><MuscleGroupBadge exercise={item.exercise} illustrated={false} /><small>{meta}</small></div>
      <div className="wz-exercise-tools">
        <button type="button" className="icon-button" disabled={index === 0} aria-label={`Sposta su ${item.exercise.name}`} onClick={() => onMove(-1)}><Icon name="back" size={16} style={{ transform: 'rotate(90deg)' }} /></button>
        <button type="button" className="icon-button" disabled={index === count - 1} aria-label={`Sposta giù ${item.exercise.name}`} onClick={() => onMove(1)}><Icon name="back" size={16} style={{ transform: 'rotate(-90deg)' }} /></button>
        <button type="button" className="icon-button" aria-label={`Rimuovi ${item.exercise.name}`} onClick={onRemove}><Icon name="close" size={16} /></button>
      </div>
    </div>
    {isTimedCardio(item.exercise) ? <MinutesField item={item} onChange={onChange} error={issues[`${item.id}:duration`]} /> : <>
    <QuickNumber id={`${item.id}-sets`} label="Serie" value={item.sets} onChange={sets => onChange({ ...item, sets })} error={issues[`${item.id}:sets`]} chips={['2', '3', '4', '5'].map(value => ({ value, label: value }))} />
    {item.exercise.measurementMode === 'reps'
      ? <RepsField item={item} onChange={onChange} error={issues[`${item.id}:reps`]} />
      : <QuickNumber id={`${item.id}-duration`} label="Durata" unit="sec" value={item.durationSeconds} onChange={durationSeconds => onChange({ ...item, durationSeconds })} error={issues[`${item.id}:duration`]} chips={['20', '30', '45', '60', '90'].map(value => ({ value, label: `${value}″` }))} />}
    <QuickNumber id={`${item.id}-rest`} label="Recupero" unit="sec" value={item.restSeconds === '0' ? '' : item.restSeconds} onChange={restSeconds => onChange({ ...item, restSeconds: restSeconds || '0' })} error={issues[`${item.id}:rest`]} chips={restChips} /></>}
    <details className="wz-more">
      <summary>{isTimedCardio(item.exercise) ? 'RIR/RPE e note' : 'Serie facoltative, RIR/RPE e note'}</summary>
      <div className="wz-more-grid">
        {!isTimedCardio(item.exercise) && <label htmlFor={`${item.id}-optional`}>Serie facoltative<input id={`${item.id}-optional`} inputMode="numeric" maxLength={4} value={item.optionalSets} onChange={event => onChange({ ...item, optionalSets: event.target.value.replace(/[^\d]/g, '') || '0' })} /></label>}
        <label htmlFor={`${item.id}-rir`}>RIR<input id={`${item.id}-rir`} inputMode="decimal" maxLength={4} placeholder="—" value={item.rir} onChange={event => onChange({ ...item, rir: event.target.value })} /></label>
        <label htmlFor={`${item.id}-rpe`}>RPE<input id={`${item.id}-rpe`} inputMode="decimal" maxLength={4} placeholder="—" value={item.rpe} onChange={event => onChange({ ...item, rpe: event.target.value })} /></label>
      </div>
      <label htmlFor={`${item.id}-note`}>Note<textarea id={`${item.id}-note`} rows={2} maxLength={4000} value={item.note} onChange={event => onChange({ ...item, note: event.target.value })} /></label>
    </details>
  </article>
}

/** Ricerca nel catalogo e creazione rapida di un esercizio nuovo, in un pannello dal basso. */
function ExerciseSheet({ catalog, onAdd, onClose }: { catalog: { store: ExercisesStore | null; state: ExercisesState }; onAdd: (exercise: CatalogExercise) => void; onClose: () => void }) {
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<MuscleGroupFilter>('all')
  const [added, setAdded] = useState(0)
  const [draft, setDraft] = useState<ExerciseValues | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const rows = searchExercises(catalog.state.rows, search, 'active', group)
  const shared = searchExercises(catalog.state.sharedRows, search, 'active', group).filter(row => !catalog.state.rows.some(personal => personal.sourceTemplateId === row.id))
  const exact = [...catalog.state.rows, ...catalog.state.sharedRows].some(row => row.name.toLocaleLowerCase('it') === search.trim().toLocaleLowerCase('it'))
  const add = (exercise: CatalogExercise) => { onAdd(exercise); setAdded(value => value + 1) }
  const addShared = async (exercise: CatalogExercise) => {
    if (!catalog.store || creating) return
    setCreating(true); setError('')
    const personal = await catalog.store.adoptShared(exercise.id)
    setCreating(false)
    if (!personal) { setError('Non riesco ad aggiungere l’esercizio comune. Se lo hai archiviato, ripristinalo nel catalogo.'); return }
    add(personal)
  }
  const create = async () => {
    if (!draft || !catalog.store || creating) return
    setCreating(true); setError('')
    const saved = await catalog.store.quickCreate(draft)
    setCreating(false)
    if (!saved) { setError('Esercizio non salvato. Controlla la connessione e riprova.'); return }
    add(saved); setDraft(null); setSearch('')
  }
  return <Modal label="Aggiungi esercizi" variant="sheet" onClose={onClose}>
    <div className="wz-sheet">
      <h2>Aggiungi esercizi</h2>
      <label className="wz-search" htmlFor="wizard-search"><Icon name="dumbbell" size={20} /><input ref={input} id="wizard-search" type="search" autoComplete="off" placeholder="Cerca o scrivi un nuovo esercizio" value={search} onChange={event => { setSearch(event.target.value); setDraft(null) }} /></label>
      <MuscleGroupSelect id="wizard-group-filter" filter value={group} onChange={setGroup} disabled={creating} />
      {catalog.state.phase === 'loading' || catalog.state.phase === 'idle' ? <p role="status" className="small muted">Caricamento del catalogo…</p>
        : catalog.state.phase === 'error' ? <p role="alert">Catalogo non disponibile. <button type="button" className="text-button" onClick={() => void catalog.store?.load()}>Riprova</button></p> : null}
      {search.trim() && !exact && catalog.state.phase !== 'error' && (draft ? <section className="wz-create" aria-label="Nuovo esercizio">
        <strong>Nuovo: {draft.name}</strong>
        <MuscleGroupSelect id="wizard-muscle-group" value={exerciseMuscleGroup(draft) ?? ''} onChange={muscleGroup => setDraft(withCardioDefaults({ ...draft, muscleGroup }))} disabled={creating} />
        {exerciseMuscleGroup(draft) !== 'Cardio' && <>
        <Segmented label="Si misura in" value={draft.measurementMode} onChange={measurementMode => setDraft({ ...draft, measurementMode })} options={[{ value: 'reps', label: 'Ripetizioni' }, { value: 'seconds', label: 'Secondi' }]} />
        <Segmented label="Carico" value={draft.loadConvention} onChange={loadConvention => setDraft({ ...draft, loadConvention })} options={(Object.keys(loadLabels) as ExerciseValues['loadConvention'][]).map(key => ({ value: key, label: key === 'single-dumbbell' ? 'Un manubrio' : loadLabels[key] }))} />
        </>}
        <label htmlFor="wizard-equipment">Attrezzo o macchina (facoltativo)<input id="wizard-equipment" maxLength={120} placeholder="Es. Pulley, Smith, manubri" value={draft.equipment} onChange={event => setDraft({ ...draft, equipment: event.target.value })} /></label>
        {exerciseMuscleGroup(draft) !== 'Cardio' && <label className="wz-check"><input type="checkbox" checked={draft.perSide} onChange={event => setDraft({ ...draft, perSide: event.target.checked })} />Ripetizioni per lato</label>}
        {error && <p className="wz-error" role="alert">{error}</p>}
        <div className="program-actions"><button type="button" className="button secondary" onClick={() => setDraft(null)}>Annulla</button><button type="button" className="button primary wz-create-confirm" disabled={creating} onClick={() => void create()}>{creating ? 'Salvataggio…' : 'Crea e aggiungi'}</button></div>
      </section> : <button type="button" className="wz-create-start" onClick={() => setDraft(withCardioDefaults({ ...emptyExercise(), name: search.trim().slice(0, 120), muscleGroup: group === 'unclassified' ? null : group !== 'all' ? group : inferMuscleGroup(search.trim()) }))}><Icon name="plus" size={20} /><span>Crea «{search.trim()}»</span><small>Nuovo esercizio nel tuo catalogo</small></button>)}
      {error && <p className="wz-error" role="alert">{error}</p>}
      {rows.length > 0 && <section aria-label="I tuoi esercizi"><h3 className="wz-results-title">I tuoi esercizi</h3>{groupExercises(rows).map(section => <section key={section.label}><h4 className="wz-group-title">{section.label} <span>{section.rows.length}</span></h4><ul className="wz-results">{section.rows.map(row => <li key={row.id}><button type="button" disabled={creating} onClick={() => add(row)}><span><strong>{row.name}</strong><MuscleGroupBadge exercise={row} /><small>{[row.variant, row.equipment, row.measurementMode === 'seconds' ? 'a tempo' : 'ripetizioni', row.perSide ? 'per lato' : ''].filter(Boolean).join(' · ')}</small></span><Icon name="plus" size={20} /></button></li>)}</ul></section>)}</section>}
      {shared.length > 0 && <section aria-label="Esercizi comuni"><h3 className="wz-results-title">Esercizi comuni</h3>{groupExercises(shared).map(section => <section key={section.label}><h4 className="wz-group-title">{section.label} <span>{section.rows.length}</span></h4><ul className="wz-results">{section.rows.map(row => <li key={row.id}><button type="button" disabled={creating} onClick={() => void addShared(row)}><span><strong>{row.name}</strong><MuscleGroupBadge exercise={row} /><small>{[row.variant, row.equipment, row.measurementMode === 'seconds' ? 'a tempo' : 'ripetizioni', row.perSide ? 'per lato' : ''].filter(Boolean).join(' · ')}</small></span><Icon name="plus" size={20} /></button></li>)}</ul></section>)}</section>}
      {catalog.state.phase === 'ready' && !rows.length && !shared.length && !search.trim() && group === 'all' && <p className="small muted">Il catalogo è vuoto: scrivi il nome del primo esercizio per crearlo.</p>}
      {catalog.state.phase === 'ready' && !rows.length && !shared.length && (search.trim() || group !== 'all') && <p className="small muted" role="status">Nessun esercizio in questo gruppo corrisponde alla ricerca.</p>}
      <div className="wz-sheet-footer"><button type="button" className="button primary full-width" onClick={onClose}>{added ? `Fatto · ${added} aggiunt${added === 1 ? 'o' : 'i'}` : 'Chiudi'}</button></div>
    </div>
  </Modal>
}

function WeekPills({ step, days, onJump }: { step: number; days: ProgramDay[]; onJump: (index: number) => void }) {
  return <nav className="wz-week" aria-label="Giorni della settimana">{weekdays.map((weekday, index) => {
    const day = days.find(item => item.label === weekday.code)
    const state = day?.exercises.length ? 'training' : index < step ? 'rest' : 'todo'
    return <button key={weekday.code} type="button" className={`wz-pill is-${state}`} aria-current={index === step ? 'step' : undefined} aria-label={`${weekday.name}: ${state === 'training' ? `${day!.exercises.length} esercizi` : state === 'rest' ? 'riposo' : 'da compilare'}`} onClick={() => onJump(index)}><span>{weekday.short}</span></button>
  })}</nav>
}

export function ProgramWizard({ store, state, catalog, step, setStep, onAdvanced, onExit, followedPlanId, onFollow, today }: {
  store: ProgramsStore; state: ProgramsState; catalog: { store: ExercisesStore | null; state: ExercisesState }
  step: WizardStep; setStep: (step: WizardStep) => void; onAdvanced: () => void; onExit: () => void
  followedPlanId: string | null; onFollow: (planId: string) => Promise<boolean>; today: string
}) {
  const document = state.document ? withCatalogMuscleGroups(state.document, catalog.state.rows) : null
  const [sheet, setSheet] = useState(false)
  const [confirm, setConfirm] = useState<{ title: string; text: string; action: () => void } | null>(null)
  // Dopo il primo tentativo di proseguire gli errori si aggiornano mentre l'utente corregge.
  const [checked, setChecked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [followedNow, setFollowedNow] = useState(false)
  const [cycleWarning, setCycleWarning] = useState(false)
  // Un ciclo nuovo parte di default dal prossimo lunedì per 8 settimane; tutto modificabile.
  useEffect(() => { if (state.document && !state.cycleDraft && !state.revising) store.setCycleDraft({ start: mondayOf(today, true), weeks: 8 }) }, [store, state.document, state.cycleDraft, state.revising, today])
  const heading = useRef<HTMLHeadingElement>(null)
  // Cambio di passo: controlli e messaggi ripartono (nel render), focus e scorrimento nell'effetto.
  const [shownStep, setShownStep] = useState(step)
  if (shownStep !== step) { setShownStep(step); setChecked(false); setMessage('') }
  useEffect(() => { heading.current?.focus({ preventScroll: true }); window.scrollTo({ top: 0 }) }, [step])
  // Titolo deciso all'apertura: dopo il salvataggio un programma nuovo non diventa "modifica".
  const [editing] = useState(() => step === 'done' ? state.revisionFinished : Boolean(state.base) || state.index.some(item => item.plan.id === state.document?.planId))
  const busy = saving || ['saving', 'publishing', 'checking'].includes(state.phase)
  // Conferma solo con modifiche reali; in modifica il programma resta com'era.
  const exit = () => store.dirty && step !== 'done'
    ? setConfirm(editing
      ? { title: 'Uscire dalla modifica?', text: 'Le modifiche non salvate andranno perse. Il programma resta com’era.', action: () => { store.close(); onExit() } }
      : { title: 'Uscire dalla creazione?', text: 'Il programma non ancora salvato andrà perso. I programmi già salvati restano invariati.', action: () => { store.close(); onExit() } })
    : (store.close(), onExit())

  if (!document) return null
  const title = editing ? 'Modifica programma' : 'Nuovo programma'
  const shell = (content: ReactNode, footer: ReactNode, back?: () => void) => <section className="wizard" aria-labelledby="wizard-heading">
    <header className="wizard-top">
      {back ? <button type="button" className="icon-button is-outlined" aria-label="Indietro" onClick={back}><Icon name="back" size={20} /></button> : <span className="wizard-spacer" />}
      <div className="wizard-top-title"><span className="eyebrow">{title}</span>{document.title && step !== 'name' && <strong>{document.title}</strong>}</div>
      <button type="button" className="icon-button is-outlined" aria-label="Chiudi" onClick={exit}><Icon name="close" size={20} /></button>
    </header>
    {content}
    {step !== 'done' && (message || (state.phase !== 'ready' && state.message)) && <p className="wz-message" role="alert">{message || state.message}</p>}
    {state.phase === 'uncertain' && <button type="button" className="button secondary" onClick={() => void store.check()}>Verifica online</button>}
    {state.phase === 'conflict' && (state.revising
      ? <div className="wz-message"><p>Il programma è cambiato su un altro dispositivo: riparti dalla versione online e ripeti la modifica.</p><button type="button" className="button secondary" onClick={() => { store.restartRevision(); setStep('name') }}>Riparti dalla versione online</button></div>
      : <div className="wz-message"><p>La versione online è diversa: apri l’editor avanzato per confrontarle e scegliere.</p><button type="button" className="button secondary" onClick={onAdvanced}>Apri editor avanzato</button></div>)}
    <div className="wizard-footer">{footer}</div>
    {sheet && typeof step === 'number' && <ExerciseSheet catalog={catalog} onClose={() => setSheet(false)} onAdd={exercise => {
      const current = weeklyDay(store.getSnapshot().document!, step) ?? emptyWeeklyDay(step)
      const item = prefillFromDay(newPrescription(exercise), current)
      store.edit(setWeeklyDay(store.getSnapshot().document!, step, { ...current, exercises: [...current.exercises, item] }))
    }} />}
    {confirm && <Modal label={confirm.title} onClose={() => setConfirm(null)}><h2>{confirm.title}</h2><p>{confirm.text}</p><div className="program-actions"><button className="button secondary" onClick={() => setConfirm(null)}>Annulla</button><button className="button primary" onClick={() => { confirm.action(); setConfirm(null) }}>Conferma</button></div></Modal>}
  </section>

  // ------------------------------------------------------------------ nome
  if (step === 'name') {
    return shell(<>
      <div className="wizard-intro"><span className="wizard-count">Passo 1 di 8</span><h1 id="wizard-heading" ref={heading} tabIndex={-1}>{state.revising ? 'Nome e durata' : 'Come si chiama il programma?'}</h1><p>{state.revising ? 'Poi potrai rivedere la settimana tipo, da lunedì a domenica.' : 'Poi imposterai la settimana tipo, da lunedì a domenica.'}</p></div>
      {state.revising && state.base && <p className="wz-revise-note">Stai modificando «{state.base.plan.name}». Salvando aggiorni questo programma: le sedute già registrate restano nello storico così come le hai fatte. Puoi anche rinominarlo.</p>}
      <form id="wizard-name-form" className="wizard-form" onSubmit={event => { event.preventDefault(); if (document.title.trim() && (state.cycleDraft || state.revising)) setStep(0) }}>
        <label htmlFor="wizard-name">Nome del programma<input id="wizard-name" autoFocus maxLength={160} placeholder="Es. Forza settembre–novembre" value={document.title} onChange={event => store.edit({ ...document, title: event.target.value })} /></label>
        {state.cycleDraft && <>
          <fieldset className="wz-groups"><legend>Per quante settimane?</legend><div className="chip-row">{cycleDurations.map(weeks => <button key={weeks} type="button" className="chip wz-weeks" aria-pressed={state.cycleDraft!.weeks === weeks} onClick={() => store.setCycleDraft({ ...state.cycleDraft!, weeks })}>{weeks} settimane</button>)}</div></fieldset>
          <fieldset className="wz-groups"><legend>Da quando?</legend><div className="chip-row">
            <button type="button" className="chip" aria-pressed={state.cycleDraft.start === today} onClick={() => store.setCycleDraft({ ...state.cycleDraft!, start: today })}>Oggi</button>
            {mondayOf(today, true) !== today && <button type="button" className="chip" aria-pressed={state.cycleDraft.start === mondayOf(today, true)} onClick={() => store.setCycleDraft({ ...state.cycleDraft!, start: mondayOf(today, true) })}>Lunedì {formatDate(mondayOf(today, true), { day: 'numeric', month: 'short' })}</button>}
            <label className="wz-date"><span className="sr-only">Altra data di inizio</span><input type="date" value={state.cycleDraft.start} min="2000-01-01" max="2199-12-31" onChange={event => { if (isLocalDate(event.target.value)) store.setCycleDraft({ ...state.cycleDraft!, start: event.target.value }) }} /></label>
          </div></fieldset>
          <p className="wz-cycle-note">Imposterai una settimana tipo: si ripete da sola dal {formatDate(state.cycleDraft.start, { day: 'numeric', month: 'long' })} fino a {formatDate(cycleInfo(state.cycleDraft, today).end, { weekday: 'long', day: 'numeric', month: 'long' })}.</p>
        </>}
        {!state.cycleDraft && state.revising && <fieldset className="wz-groups"><legend>Durata</legend><p className="field-help">Questo programma non ha durata né data di inizio.</p><div className="chip-row"><button type="button" className="chip" onClick={() => store.setCycleDraft({ start: mondayOf(today, true), weeks: 8 })}>Imposta durata e inizio</button></div></fieldset>}
        <details className="wz-more"><summary>Istruzioni generali (facoltative)</summary><label htmlFor="wizard-guidance" className="sr-only">Istruzioni generali</label><textarea id="wizard-guidance" rows={4} maxLength={16000} placeholder="Riscaldamento, progressione, indicazioni valide ogni giorno…" value={document.guidance} onChange={event => store.edit({ ...document, guidance: event.target.value })} /></details>
      </form>
      <button type="button" className="text-button wizard-advanced" onClick={onAdvanced}>Preferisci l’editor avanzato?</button>
    </>, <button type="submit" form="wizard-name-form" className="button primary wizard-next" disabled={!document.title.trim() || (!state.cycleDraft && !state.revising)}>Avanti<Icon name="arrow" size={20} /></button>)
  }

  // ------------------------------------------------------------------ fine
  if (step === 'done') {
    const planId = document.planId
    const followed = followedNow || followedPlanId === planId
    return shell(<div className="wizard-done">
      <span className="wizard-done-icon" aria-hidden="true"><Icon name="check" size={32} /></span>
      <h1 id="wizard-heading" ref={heading} tabIndex={-1}>{editing ? 'Programma aggiornato' : 'Programma salvato'}</h1>
      {editing && state.message && <p className="wz-revise-note" role="status">{state.message}</p>}
      <p>{followed ? 'È il programma che segui: lo trovi nella Scheda, giorno per giorno.' : 'Puoi usarlo nella Scheda quando vuoi.'}{state.cycleDraft && ` La settimana si ripete per ${state.cycleDraft.weeks} settimane, dal ${formatDate(state.cycleDraft.start, { day: 'numeric', month: 'long' })}.`}</p>
      {cycleWarning && <p className="wz-message" role="alert">Programma salvato, ma durata e inizio non sono stati confermati. Riaprilo con «Modifica» per riprovare.</p>}
      <ul className="wz-summary">{weeklySummary(document.days).map(item => <li key={item.code} className={item.title ? '' : 'is-rest'}><strong>{item.name}</strong><span>{item.title ?? 'Riposo'}</span></li>)}</ul>
    </div>, <>
      {!followed && <button type="button" className="button secondary" disabled={busy} onClick={() => { void onFollow(planId).then(ok => { if (ok) setFollowedNow(true) }) }}>Segui questo programma</button>}
      <a className="button primary wizard-next" href="#/scheda" onClick={() => store.close()}>Vai alla Scheda<Icon name="arrow" size={20} /></a>
    </>)
  }

  // ------------------------------------------------------------------ giorni
  const index = step
  const weekday = weekdays[index]!
  const day = weeklyDay(document, index)
  const exercises = day?.exercises ?? []
  const groups = groupsFromTitle(day?.title ?? '')
  const issues = checked && day ? dayIssues(day) : {}
  const others = document.days.filter(item => item.label !== weekday.code && item.exercises.length)
  const last = index === 6
  const update = (value: ProgramDay | null) => store.edit(setWeeklyDay(document, index, value))
  const updateItem = (item: PrescriptionDraft) => update({ ...day!, exercises: exercises.map(value => value.id === item.id ? item : value) })
  const next = () => last ? void save() : setStep(index + 1)
  const rest = () => {
    const apply = () => { update(null); next() }
    if (exercises.length) setConfirm({ title: `${weekday.name} di riposo?`, text: `${exercises.length === 1 ? 'L’esercizio inserito verrà rimosso' : `Gli ${exercises.length} esercizi inseriti verranno rimossi`} da questo giorno.`, action: apply })
    else apply()
  }
  const forward = () => {
    if (!exercises.length) { if (day) update(null); next(); return }
    if (Object.keys(dayIssues(day!)).length) { setChecked(true); setMessage('Completa i campi evidenziati prima di proseguire.'); return }
    next()
  }
  async function save() {
    const current = store.getSnapshot().document!
    if (!current.title.trim()) { setStep('name'); return }
    if (!current.days.some(item => item.exercises.length)) { setMessage('Aggiungi almeno un giorno di allenamento prima di salvare.'); return }
    const broken = current.days.findIndex(item => Object.keys(dayIssues(item)).length)
    if (broken >= 0) { setStep(weekdays.findIndex(item => item.code === current.days[broken]!.label)); return }
    setSaving(true); setMessage('')
    try {
      // Modifica di un programma pubblicato: una sola chiamata, esito deciso dal database.
      if (store.getSnapshot().revising) {
        const outcome = await store.saveRevision()
        if (outcome === 'unchanged') { store.close('Nessuna modifica da salvare.'); onExit(); return }
        if (!outcome) return
        const planId = store.getSnapshot().base!.plan.id
        if (followedPlanId === planId) setFollowedNow(await onFollow(planId))
        setStep('done')
        return
      }
      await store.save()
      let snapshot = store.getSnapshot()
      if (snapshot.phase !== 'ready' || store.dirty || snapshot.base?.version.status !== 'draft') return
      await store.publish()
      snapshot = store.getSnapshot()
      if (snapshot.phase !== 'ready' || snapshot.base?.version.status !== 'published') return
      setCycleWarning(!(await store.saveCycle()))
      snapshot = store.getSnapshot()
      if (!followedPlanId || followedPlanId === snapshot.base!.plan.id || snapshot.renewalFrom === followedPlanId) setFollowedNow(await onFollow(snapshot.base!.plan.id))
      setStep('done')
    } finally { setSaving(false) }
  }

  return shell(<>
    <WeekPills step={index} days={document.days} onJump={setStep} />
    <div className="wizard-intro"><span className="wizard-count">Passo {index + 2} di 8</span><h1 id="wizard-heading" ref={heading} tabIndex={-1}>{weekday.name}</h1>
      <p>{exercises.length ? `${exercises.length} ${exercises.length === 1 ? 'esercizio' : 'esercizi'} · ${exercises.reduce((sum, item) => sum + (Number(item.sets) || 0), 0)} serie` : 'Aggiungi gli esercizi oppure segna il giorno di riposo.'}</p></div>
    <fieldset className="wz-groups" disabled={busy}><legend>Gruppi muscolari</legend><div className="chip-row">{muscleGroups.map(group => <button key={group} type="button" className="chip" aria-pressed={groups.includes(group)} onClick={() => {
      const selected = groups.includes(group) ? groups.filter(item => item !== group) : [...groups, group]
      update({ ...(day ?? emptyWeeklyDay(index)), title: titleFromGroups(selected) })
    }}>{group}</button>)}</div></fieldset>
    {!exercises.length && others.length > 0 && <div className="wz-copy"><span>Stessa seduta di un altro giorno?</span><div className="chip-row">{others.map(other => <button key={other.id} type="button" className="chip" disabled={busy} onClick={() => update(copyWeeklyDay(other, index))}>Copia {weekdays.find(item => item.code === other.label)?.name.toLowerCase()} · {other.title}</button>)}</div></div>}
    <div className="wz-exercises">{exercises.map((item, position) => <ExerciseCard key={item.id} item={item} index={position} count={exercises.length} issues={issues}
      onChange={updateItem} onMove={direction => update({ ...day!, exercises: moveItem(exercises, position, direction) })}
      onRemove={() => update({ ...day!, exercises: exercises.filter(value => value.id !== item.id) })} />)}</div>
    <button type="button" className="wz-add" disabled={busy || exercises.length >= 200} onClick={() => setSheet(true)}><Icon name="plus" size={20} /><span>Aggiungi esercizio</span></button>
    {exercises.length > 0 && <label className="wz-day-note" htmlFor={`${day!.id}-note`}>Note del giorno<textarea id={`${day!.id}-note`} rows={2} maxLength={4000} placeholder="Facoltative" value={day!.note} onChange={event => update({ ...day!, note: event.target.value })} /></label>}
  </>, <>
    <button type="button" className="button secondary wizard-rest" disabled={busy} onClick={rest}><Icon name="moon" size={20} />Riposo</button>
    <button type="button" className={`button primary ${last ? 'wizard-save' : 'wizard-next'}`} disabled={busy} onClick={forward}>{busy ? 'Salvataggio…' : last ? 'Salva programma' : 'Avanti'}{!busy && <Icon name={last ? 'check' : 'arrow'} size={20} />}</button>
  </>, () => setStep(index === 0 ? 'name' : index - 1))
}
