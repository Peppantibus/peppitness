import { useEffect, useRef, useState } from 'react'
import { MuscleGroupSelect } from '../components/MuscleGroupSelect'
import { MuscleGroupBadge } from '../components/MuscleGroupBadge'
import { groupExercises, isTimedCardio } from '../domain/muscle-groups'
import type { MuscleGroupFilter } from '../domain/muscle-groups'

import { Icon } from '../components/Icon'
import { SubpageHeader } from '../components/SubpageHeader'
import { Modal } from '../components/Modal'
import { loadLabels, searchExercises } from '../domain/exercises'
import { withCatalogMuscleGroups, duplicateDay, moveItem, newDay, newPrescription } from '../domain/programs'
import type { CatalogExercise } from '../domain/exercises'
import type { ProgramDocument, PrescriptionDraft, ProgramDay, ProgramIndex } from '../domain/programs'
import { fitsWizard, weeklySummary } from '../domain/weekly'
import { cycleInfo } from '../domain/progress'
import { formatDate } from '../domain/dates'
import { ProgramWizard } from './ProgramWizard'
import type { WizardStep } from './ProgramWizard'
import type { ExercisesState, ExercisesStore } from '../persistence/exercises-store'
import type { ProgramsState, ProgramsStore } from '../persistence/programs-store'

function ExercisePicker({ catalog, onAdd, dayId }: { catalog: { store: ExercisesStore | null; state: ExercisesState }; onAdd: (exercise: CatalogExercise) => void; dayId: string }) {
  const [group, setGroup] = useState<MuscleGroupFilter>('all')
  const [search, setSearch] = useState(''), [selected, setSelected] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const personal = searchExercises(catalog.state.rows, search, 'active', group)
  const shared = searchExercises(catalog.state.sharedRows, search, 'active', group).filter(row => !catalog.state.rows.some(own => own.sourceTemplateId === row.id))
  const chosen = [...personal, ...shared].find(item => item.id === selected)
  const fromShared = chosen && shared.some(item => item.id === chosen.id)
  const add = async () => {
    if (!chosen || busy) return
    if (!fromShared) { onAdd(chosen); setSelected(''); return }
    setBusy(true); setError('')
    const adopted = await catalog.store?.adoptShared(chosen.id)
    setBusy(false)
    if (!adopted) { setError('Non riesco ad aggiungere l’esercizio comune. Controlla il catalogo e riprova.'); return }
    onAdd(adopted); setSelected('')
  }
  return <div className="program-picker">
    <label htmlFor={`${dayId}-search`}>Cerca nel catalogo<input id={`${dayId}-search`} type="search" placeholder="Nome, variante o attrezzo" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <MuscleGroupSelect id={`${dayId}-group-filter`} filter value={group} onChange={setGroup} disabled={busy} />
    <label htmlFor={`${dayId}-pick`}>Esercizio<select id={`${dayId}-pick`} className="program-exercise-select" value={chosen?.id ?? ''} onChange={event => setSelected(event.target.value)}><option value="">Scegli un esercizio</option>{groupExercises(personal).map(section => <optgroup key={section.label} label={`I tuoi · ${section.label}`}>{section.rows.map(row => <option key={row.id} value={row.id}>{[row.name, row.variant, row.equipment].filter(Boolean).join(' · ')}</option>)}</optgroup>)}{groupExercises(shared).map(section => <optgroup key={section.label} label={`Comuni · ${section.label}`}>{section.rows.map(row => <option key={row.id} value={row.id}>{[row.name, row.variant, row.equipment].filter(Boolean).join(' · ')}</option>)}</optgroup>)}</select></label>
    <button type="button" className="button secondary program-add-exercise" disabled={!chosen || busy} onClick={() => void add()}>{busy ? 'Aggiunta…' : 'Aggiungi esercizio'}</button>
    {error && <p role="alert" className="form-error">{error}</p>}
    {!personal.length && !shared.length && <p className="small muted">Nessun esercizio attivo corrispondente. Puoi aggiungerlo nel <a href="#/scheda/catalogo" className="text-link">catalogo</a> e tornare qui.</p>}
  </div>
}

export function ProgramPreview({ document }: { document: ProgramDocument }) {
  return <div className="program-preview"><h3>{document.title}</h3><p className="catalog-note">{document.guidance || 'Nessuna istruzione generale'}</p>{document.days.map(day => <section key={day.id}><h4>{day.label} · {day.title}</h4>{day.note && <p className="catalog-note">{day.note}</p>}
    <ol>{day.exercises.map(item => <li key={item.id}><strong>{item.exercise.name}</strong> <MuscleGroupBadge exercise={item.exercise} /><p className="small muted">{[item.exercise.variant, item.exercise.equipment, loadLabels[item.exercise.loadConvention], item.exercise.loadUnit, item.exercise.perSide ? 'Per lato' : ''].filter(Boolean).join(' · ')}</p><p>{isTimedCardio(item.exercise) ? `${Math.round(Number(item.durationSeconds) / 60 * 100) / 100} minuti` : <>{item.sets} serie{Number(item.optionalSets) > 0 ? ` + ${item.optionalSets} facoltative` : ''} · {item.exercise.measurementMode === 'reps' ? `${item.repsMin}–${item.repsMax} ripetizioni` : `${item.durationSeconds} secondi`} · Recupero {item.restSeconds} s</>}{item.rir !== '' ? ` · RIR ${item.rir}` : ''}{item.rpe !== '' ? ` · RPE ${item.rpe}` : ''}</p>{item.note && <p className="catalog-note">{item.note}</p>}</li>)}</ol>{!day.exercises.length && <p>Nessun esercizio</p>}</section>)}</div>
}

const fields = { sets: 'Serie obbligatorie', optionalSets: 'Serie facoltative', repsMin: 'Ripetizioni minime', repsMax: 'Ripetizioni massime', durationSeconds: 'Durata · secondi', restSeconds: 'Recupero · secondi', rir: 'RIR (facoltativo)', rpe: 'RPE (facoltativo)' }
function PrescriptionFields({ item, onChange }: { item: PrescriptionDraft; onChange: (value: PrescriptionDraft) => void }) {
  const cardio = isTimedCardio(item.exercise)
  const keys = (Object.keys(fields) as (keyof typeof fields)[]).filter(key => cardio ? ['durationSeconds', 'rir', 'rpe'].includes(key) : item.exercise.measurementMode === 'reps' ? key !== 'durationSeconds' : key !== 'repsMin' && key !== 'repsMax')
  return <><MuscleGroupBadge exercise={item.exercise} /><p className="small muted">{[item.exercise.variant, item.exercise.equipment, loadLabels[item.exercise.loadConvention], item.exercise.loadUnit, item.exercise.perSide ? 'Per lato' : ''].filter(Boolean).join(' · ')}</p>
    <div className="program-numbers">{keys.map(key => <label key={key} htmlFor={`${item.id}-${key}`}>{fields[key]}<input id={`${item.id}-${key}`} data-field={key} inputMode={key === 'rir' || key === 'rpe' ? 'decimal' : 'numeric'} autoComplete="off" maxLength={30} value={item[key]} onChange={event => onChange({ ...item, [key]: event.target.value })} /></label>)}</div>
    <label htmlFor={`${item.id}-note`}>Note dell’esercizio<textarea id={`${item.id}-note`} rows={2} maxLength={4000} value={item.note} onChange={event => onChange({ ...item, note: event.target.value })} /></label>
  </>
}

export function ProgramEditor({ store, state, catalog }: { store: ProgramsStore; state: ProgramsState; catalog: { store: ExercisesStore | null; state: ExercisesState } }) {
  const [confirm, setConfirm] = useState<{ title: string; text: string; action: () => void } | null>(null)
  const editor = useRef<HTMLElement>(null)
  const document = state.document ? withCatalogMuscleGroups(state.document, catalog.state.rows) : null!
  useEffect(() => { editor.current?.focus({ preventScroll: true }); editor.current?.scrollIntoView({ block: 'start' }) }, [document.id])
  const readonly = (state.base?.version.status === 'published' && !state.revising) || Boolean(state.base?.plan.archivedAt)
  const busy = ['saving', 'publishing', 'checking'].includes(state.phase)
  const blocked = readonly || busy || state.phase === 'uncertain' || (state.phase === 'conflict' && state.intent === 'publish')
  const updateDay = (value: ProgramDay) => store.edit({ ...document, days: document.days.map(day => day.id === value.id ? value : day) })
  const remove = (title: string, action: () => void) => setConfirm({ title, text: 'La rimozione riguarda questa bozza. Le versioni pubblicate rimangono invariate.', action })
  return <>
    <section ref={editor} tabIndex={-1} className="panel program-editor" aria-labelledby="program-editor-title">
      <div className="section-heading"><h2 id="program-editor-title">{state.revising ? 'Modifica programma' : state.base ? `Versione ${state.base.version.number} · ${state.base.version.status === 'published' ? 'Pubblicata' : 'Bozza'}` : 'Nuova bozza'}</h2></div>
      {state.base?.plan.archivedAt && <p role="status">Questo programma è archiviato e può essere soltanto consultato.</p>}
      {readonly ? <ProgramPreview document={document} /> : <form className="program-form" onSubmit={event => { event.preventDefault(); void (state.revising ? store.saveRevision() : store.save()) }}>
        <fieldset disabled={blocked}>
          <label htmlFor="program-title">{state.revising || !state.base ? 'Nome del programma' : 'Titolo della versione'}<input id="program-title" maxLength={160} required value={document.title} onChange={event => store.edit({ ...document, title: event.target.value })} /></label>
          <label htmlFor="program-guidance">Istruzioni generali<textarea id="program-guidance" rows={4} maxLength={16000} value={document.guidance} onChange={event => store.edit({ ...document, guidance: event.target.value })} /></label>
          <p className="small muted">Le serie facoltative restano separate. Nessun esercizio o numero di serie viene aggiunto automaticamente.</p>
          <div className="program-catalog-status">
            <a className="text-link" href="#/scheda/catalogo">Apri il catalogo esercizi</a>
            {catalog.state.phase === 'ready' ? <button type="button" className="button secondary" disabled={Boolean(catalog.state.draft)} onClick={() => void catalog.store?.load()}>Aggiorna catalogo</button>
              : catalog.state.phase === 'error' ? <><p role="alert">Catalogo non disponibile.</p><button type="button" className="button secondary" onClick={() => void catalog.store?.load()}>Riprova catalogo</button></>
                : <p role="status">{['idle', 'loading'].includes(catalog.state.phase) ? 'Caricamento del catalogo…' : 'Completa la modifica aperta nel catalogo per aggiungere altri esercizi.'}</p>}
          </div>
          {document.days.map((day, dayIndex) => <section className="program-day" key={day.id} aria-label={`Seduta ${dayIndex + 1}`}>
            <div className="section-heading"><h3>Seduta {dayIndex + 1}</h3></div>
            <div className="program-day-names"><label htmlFor={`${day.id}-label`}>Etichetta<input id={`${day.id}-label`} className="program-day-label" maxLength={40} value={day.label} onChange={event => updateDay({ ...day, label: event.target.value })} /></label><label htmlFor={`${day.id}-title`}>Nome della seduta<input id={`${day.id}-title`} className="program-day-title" maxLength={160} value={day.title} onChange={event => updateDay({ ...day, title: event.target.value })} /></label></div>
            <label htmlFor={`${day.id}-note`}>Note della seduta<textarea id={`${day.id}-note`} rows={2} maxLength={4000} value={day.note} onChange={event => updateDay({ ...day, note: event.target.value })} /></label>
            <div className="program-actions"><button type="button" className="button secondary day-up" disabled={dayIndex === 0} aria-label={`Sposta su seduta ${dayIndex + 1}`} onClick={() => store.edit({ ...document, days: moveItem(document.days, dayIndex, -1) })}>Su</button><button type="button" className="button secondary day-down" disabled={dayIndex === document.days.length - 1} aria-label={`Sposta giù seduta ${dayIndex + 1}`} onClick={() => store.edit({ ...document, days: moveItem(document.days, dayIndex, 1) })}>Giù</button><button type="button" className="button secondary day-copy" disabled={document.days.length >= 50} onClick={() => store.edit({ ...document, days: [...document.days, duplicateDay(day, document.days)] })}>Duplica seduta</button><button type="button" className="button secondary day-remove" onClick={() => remove('Rimuovere questa seduta?', () => store.edit({ ...document, days: document.days.filter(item => item.id !== day.id) }))}>Rimuovi seduta</button></div>
            {day.exercises.map((item, index) => <section className="program-prescription" key={item.id} aria-label={`${index + 1}. ${item.exercise.name}`}>
              <h4>{index + 1}. {item.exercise.name}</h4>
              {catalog.state.rows.find(row => row.id === item.exercise.id)?.archivedAt && <p role="alert">Esercizio archiviato: ripristinalo nel catalogo oppure rimuovilo dalla bozza prima di salvarla.</p>}
              <PrescriptionFields item={item} onChange={value => updateDay({ ...day, exercises: day.exercises.map(exercise => exercise.id === item.id ? value : exercise) })} />
              <div className="program-actions"><button type="button" className="button secondary prescription-up" disabled={index === 0} aria-label={`Sposta su ${item.exercise.name}`} onClick={() => updateDay({ ...day, exercises: moveItem(day.exercises, index, -1) })}>Su</button><button type="button" className="button secondary prescription-down" disabled={index === day.exercises.length - 1} aria-label={`Sposta giù ${item.exercise.name}`} onClick={() => updateDay({ ...day, exercises: moveItem(day.exercises, index, 1) })}>Giù</button><button type="button" className="button secondary prescription-copy" disabled={day.exercises.length >= 200} onClick={() => updateDay({ ...day, exercises: [...day.exercises, { ...structuredClone(item), id: crypto.randomUUID() }] })}>Duplica esercizio</button><button type="button" className="button secondary prescription-remove" onClick={() => remove('Rimuovere questo esercizio?', () => updateDay({ ...day, exercises: day.exercises.filter(value => value.id !== item.id) }))}>Rimuovi esercizio</button></div>
            </section>)}
            {catalog.state.phase === 'ready' && day.exercises.length < 200 && <ExercisePicker dayId={day.id} catalog={catalog} onAdd={exercise => {
              const latest = store.getSnapshot().document?.days.find(item => item.id === day.id)
              if (latest) store.edit({ ...store.getSnapshot().document!, days: store.getSnapshot().document!.days.map(item => item.id === day.id ? { ...latest, exercises: [...latest.exercises, newPrescription(exercise)] } : item) })
            }} />}
          </section>)}
          <button className="button secondary program-add-day" type="button" disabled={document.days.length >= 50} onClick={() => store.edit({ ...document, days: [...document.days, newDay(document.days)] })}>Aggiungi seduta</button>
        </fieldset>
        {state.phase === 'ready' && <div className="program-actions"><button className="button primary program-save" type="submit" disabled={!store.dirty && Boolean(state.base)}>{state.revising ? 'Salva programma' : 'Salva bozza'}</button>{!state.revising && <button className="button secondary program-publish" type="button" disabled={store.dirty || !state.base} onClick={() => setConfirm({ title: 'Pubblicare questa versione?', text: 'La versione diventerà corrente per questo programma e non sarà più modificabile. Potrai crearne una nuova; le precedenti rimarranno disponibili.', action: () => { void store.publish() } })}>Pubblica versione</button>}</div>}
      </form>}
      {state.phase === 'conflict' && <section className="preferences-conflict program-conflict" aria-label="Confronto programma"><h3>Versione attualmente online</h3>{state.remote ? <><p>{state.remote.version.status === 'published' ? 'Pubblicata' : 'Bozza'} · Versione {state.remote.version.number}</p><ProgramPreview document={state.remote.document} /></> : <p>Questa versione non risulta online.</p>}
        <div className="program-actions">{state.revising ? <button className="button secondary" onClick={store.restartRevision}>Riparti dalla versione online</button> : <><button className="button secondary" onClick={store.useRemote}>{state.remote ? 'Usa la versione online' : 'Scarta la bozza locale'}</button>{store.canReplace && <button className="button primary" onClick={() => void store.save(true)}>Salva le mie modifiche</button>}{state.remote?.version.status === 'published' && !state.remote.plan.archivedAt && <button className="button secondary" onClick={store.fork}>Crea bozza dalle mie modifiche</button>}</>}</div>
      </section>}
      {state.message && <p className="program-message" role={state.phase === 'ready' ? 'status' : 'alert'}>{state.message}</p>}
      {busy && <p role="status">{state.phase === 'saving' ? 'Salvataggio della bozza…' : state.phase === 'publishing' ? 'Pubblicazione…' : 'Verifica online…'}</p>}
      {state.phase === 'uncertain' && <button className="button secondary program-check" onClick={() => void store.check()}>Verifica online</button>}
      {state.phase === 'ready' && <div className="program-actions">{readonly && !state.base?.plan.archivedAt && <button className="button primary program-fork" onClick={store.fork}>Crea nuova versione</button>}{readonly && state.base?.version.status === 'published' && !state.base.plan.archivedAt && state.base.plan.activeVersionId !== state.base.version.id && <button className="button secondary program-activate" onClick={() => setConfirm({ title: 'Ripristinare questa versione?', text: 'La Scheda userà di nuovo questa versione per le prossime sedute. Le altre versioni restano nella cronologia e le sedute già registrate non cambiano.', action: () => { void store.activate() } })}>Ripristina</button>}<button className="button secondary program-close" onClick={() => store.dirty ? setConfirm({ title: 'Scartare le modifiche alla bozza?', text: 'Le modifiche non salvate andranno perse. Le versioni già online rimangono disponibili.', action: store.close }) : store.close()}>Torna ai programmi</button></div>}
      {store.dirty && <p className="small muted">Modifiche da salvare. La bozza locale resta in questa pagina; chiuderla o ricaricarla può perderla.</p>}
    </section>
    {confirm && <Modal label={confirm.title} onClose={() => setConfirm(null)}><h2>{confirm.title}</h2><p>{confirm.text}</p><div className="program-actions"><button className="button secondary" onClick={() => setConfirm(null)}>Annulla</button><button className="button primary" onClick={() => { confirm.action(); setConfirm(null) }}>Conferma</button></div></Modal>}
  </>
}

export type ProgramMode = 'wizard' | 'advanced'

/** Il wizard gestisce bozze nuove o versioni settimanali; il resto passa all'editor avanzato. */
export function showsWizard(state: ProgramsState, mode: ProgramMode, step: WizardStep) {
  return Boolean(state.document) && mode === 'wizard' && (step === 'done' || state.revising || (fitsWizard(state.document!) && state.base?.version.status !== 'published'))
}

/** Data e ora brevi della cronologia (es. «28 set, 18:40»). */
function when(value: string) {
  const date = new Date(value)
  return `${date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }).replace('.', '')}, ${date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
}
function latest(...values: (string | null | undefined)[]) { return values.filter((value): value is string => Boolean(value)).sort().at(-1) }
function capitalize(value: string) { return value.charAt(0).toUpperCase() + value.slice(1) }
function cycleText(cycle: { start: string; weeks: number }, today: string) {
  const info = cycleInfo(cycle, today)
  return info.status === 'active' ? `settimana ${info.week} di ${info.weeks}` : info.status === 'finished' ? `ciclo di ${info.weeks} settimane concluso` : `${info.weeks} settimane dal ${formatDate(info.start, { day: 'numeric', month: 'short' })}`
}

function WeekStrip({ days }: { days: { label: string; title: string }[] }) {
  return <ol className="week-strip-mini" aria-label="Settimana del programma">{weeklySummary(days).map(item => <li key={item.code} className={item.title ? 'is-training' : ''} title={`${item.name}: ${item.title ?? 'riposo'}`}><span>{item.code.slice(0, 1)}</span><small>{item.title ? item.title.split(' · ')[0] : 'Riposo'}</small></li>)}</ol>
}

export function Programs({ store, state, catalog, mode, setMode, step, setStep, followedPlanId, followedDays, onFollow, onDeleted, deletionBlocked, today }: {
  store: ProgramsStore | null; state: ProgramsState; catalog: { store: ExercisesStore | null; state: ExercisesState }
  mode: ProgramMode; setMode: (mode: ProgramMode) => void; step: WizardStep; setStep: (step: WizardStep) => void
  followedPlanId: string | null; followedDays: { label: string; title: string }[] | null; onFollow: (planId: string) => Promise<boolean>; onDeleted: () => Promise<void>; deletionBlocked: boolean; today: string
}) {
  const [opening, setOpening] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<{ id: string | null; name: string } | null>(null)
  if (store && state.document && showsWizard(state, mode, step)) {
    return <ProgramWizard store={store} state={state} catalog={catalog} step={step} setStep={setStep} followedPlanId={followedPlanId} onFollow={onFollow} today={today}
      onAdvanced={() => setMode('advanced')} onExit={() => setMode('wizard')} />
  }
  const startWizard = () => { if (!store) return; setMode('wizard'); setStep('name'); store.create() }
  const edit = async (item: ProgramIndex) => {
    const newest = item.versions[0]
    const target = newest?.status === 'draft' ? newest : item.versions.find(version => version.id === item.plan.activeVersionId) ?? newest
    if (!store || !target || opening) return
    setOpening(true)
    try {
      await store.open(target.id)
      const opened = store.getSnapshot()
      if (!opened.document) return
      const weekly = fitsWizard(opened.document)
      if (opened.base?.version.status === 'published' && !opened.base.plan.archivedAt) store.revise()
      setMode(weekly ? 'wizard' : 'advanced'); setStep('name')
    } finally { setOpening(false) }
  }
  return <><SubpageHeader back="#/scheda" backLabel="Torna alla scheda" title="I tuoi programmi" subtitle="Imposta la settimana tipo e per quante settimane seguirla." />
    {!store ? <section className="panel empty-state"><h2>Accedi per gestire i programmi</h2></section>
      : ['idle', 'loading'].includes(state.phase) ? <section className="panel empty-state" role="status">Caricamento dei programmi…</section>
        : state.phase === 'error' ? <section className="panel empty-state"><p role="alert">{state.message}</p><div className="program-actions"><button className="button primary" onClick={() => void store.retry()}>Riprova</button>{state.requestedId && <button className="button secondary" onClick={() => void store.load()}>Torna all’elenco</button>}</div></section>
          : state.document ? <ProgramEditor store={store} state={state} catalog={catalog} />
            : <>
              <button className="button primary lg program-wizard-new full-width-mobile" onClick={startWizard}><Icon name="plus" size={20} />Nuovo programma</button>
              <a className="button secondary full-width-mobile program-import" href="#/scheda/importa"><Icon name="plus" size={20} />Importa da un file Word</a>
              <p className="small muted program-import-hint">Hai già compilato il modello Word? Caricalo qui e il programma viene creato per te.</p>
              {state.index.length > 0 && <div className="program-list-tools"><button className="text-button delete-link" disabled={deletionBlocked || state.phase === 'deleting'} onClick={() => setConfirmDelete({ id: null, name: 'tutti i programmi' })}>Elimina tutto</button></div>}
              {deletionBlocked && <p className="small muted">Completa la sincronizzazione del diario prima di eliminare i programmi.</p>}
              {state.message && <p role="status">{state.message}</p>}
              {!state.index.length ? <section className="panel empty-state"><span className="empty-icon"><Icon name="calendar" size={32} /></span><h2>Nessun programma salvato</h2><p>Imposta una settimana tipo e per quante settimane seguirla: si ripete da sola.</p><button className="button primary" onClick={startWizard}>Crea il tuo programma<Icon name="arrow" size={20} /></button><p className="small"><a className="text-link" href="#/scheda/importa">Oppure importalo dal modello Word</a></p></section>
                : <div className="program-list">{state.index.map(item => {
                  const current = item.versions.find(version => version.id === item.plan.activeVersionId)
                  const followed = followedPlanId === item.plan.id
                  const updated = latest(item.plan.updatedAt, current?.updatedAt)
                  return <section className={`panel program-card ${followed ? 'is-followed' : ''}`} key={item.plan.id}>
                    <div className="program-card-head"><h2>{item.plan.name}</h2>{followed && <span className="badge-followed"><Icon name="check" size={16} />Seguito</span>}</div>
                    <p className="small muted">{[
                      item.plan.archivedAt ? 'Archiviato' : '',
                      current ? (updated ? `Aggiornato il ${new Date(updated).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}` : '') : 'Non ancora pubblicato',
                      item.plan.cycle ? cycleText(item.plan.cycle, today) : '',
                      item.versions[0]?.status === 'draft' ? 'bozza da completare' : '',
                    ].filter(Boolean).map((part, index) => index === 0 ? capitalize(part) : part).join(' · ')}</p>
                    {followed && followedDays && <WeekStrip days={followedDays} />}
                    <div className="program-actions">
                      {!item.plan.archivedAt && item.versions.length > 0 && <button className="button primary program-edit" disabled={opening} onClick={() => void edit(item)}>{item.versions[0]?.status === 'draft' ? 'Continua' : 'Modifica'}</button>}
                      {!followed && current && !item.plan.archivedAt && <button className="button secondary program-follow" onClick={() => void onFollow(item.plan.id)}>Segui</button>}
                      <button className="button secondary danger" disabled={deletionBlocked || state.phase === 'deleting'} onClick={() => setConfirmDelete({ id: item.plan.id, name: item.plan.name })}>Elimina</button>
                    </div>
                    <details className="program-versions"><summary>Cronologia modifiche ({item.versions.length})</summary>{item.versions.map(version => <button className="program-version" key={version.id} onClick={() => { setMode('advanced'); void store.open(version.id) }}><span><strong>{version.updatedAt ? when(version.updatedAt) : `Versione ${version.number}`}</strong><small>{version.title} · {version.status === 'draft' ? 'Bozza' : item.plan.activeVersionId === version.id ? 'In uso' : 'Precedente'}</small></span><Icon name="chevron" size={20} /></button>)}</details>
                  </section>
                })}</div>}
            </>}
    {confirmDelete && <Modal label="Conferma eliminazione programmi" onClose={() => setConfirmDelete(null)}><h2>Eliminare {confirmDelete.name}?</h2><p>{confirmDelete.id ? 'Il programma e tutte le sue versioni verranno eliminati.' : 'Tutti i programmi e le loro versioni verranno eliminati.'} Le sedute già registrate restano nello storico. L’azione non si può annullare.</p><div className="program-actions"><button className="button secondary" onClick={() => setConfirmDelete(null)}>Annulla</button><button className="button danger" onClick={() => { const id = confirmDelete.id; setConfirmDelete(null); void store?.deletePlans(id).then(ok => { if (ok) void onDeleted() }) }}>Elimina {confirmDelete.id ? 'programma' : 'tutto'}</button></div></Modal>}
  </>
}
