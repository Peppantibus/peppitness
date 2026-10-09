import { MuscleGroupBadge } from '../components/MuscleGroupBadge'
import { MuscleGroupImage } from '../components/MuscleGroupImage'
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { SubpageHeader } from '../components/SubpageHeader'
import { Segmented } from '../components/Segmented'
import { weekdays } from '../domain/weekly'
import { isTimedCardio } from '../domain/muscle-groups'
import { formatDate } from '../domain/dates'
import { isWorkoutWeekday } from '../domain/settings'
import { validateSet } from '../domain/validation'
import { completeSetChanges, filledUnchecked, findPreviousExercise, formatResult, nextExercise, pendingFilledSet, reusePreviousLoads, sessionOrder, sessionProgress } from '../domain/workout'
import { formatImprovement, sessionRecords, setImprovement } from '../domain/records'
import { installAudioUnlock, useScreenWakeLock } from '../workout-alerts'
import type { PreviousExercise } from '../domain/workout'
import type { WorkoutSession, ExercisePrescription, SetResult, WorkoutDay } from '../domain/types'

/** Posizione nel ciclo del programma seguito, già formulata per la Scheda. */
export interface CycleSummary { label: string; detail?: string; ratio: number | null }

export function Workout({ day, days, planTitle, planGuidance, date, today, sessions, onDay, cycle, progressHref, activeSession, onStart, onDiscard, suggestedDayId, weekly = false, workoutWeekdays = [] }: {
  day: WorkoutDay; days: WorkoutDay[]; planTitle: string; planGuidance?: string; date: string; today: string; sessions: WorkoutSession[]; onDay: (id: string) => void
  cycle?: CycleSummary; progressHref?: string
  /** Settimanale: seduta prevista per la data; altrimenti seduta suggerita dalla rotazione. */
  suggestedDayId?: string
  activeSession?: WorkoutSession; onStart: () => void; weekly?: boolean; workoutWeekdays?: number[]
  /** Richiede la conferma prima di annullare l'allenamento in corso. */
  onDiscard?: () => void
}) {
  const [choosing, setChoosing] = useState(false)
  const totalSets = day.exercises.reduce((sum, exercise) => sum + exercise.sets, 0)
  const optionalSets = day.exercises.reduce((sum, exercise) => sum + (exercise.optionalSets ?? 0), 0)
  const previousDay = sessions.filter(session => session.completedAt && (session.day.id === day.id || session.day.label === day.label) && session.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date) || b.startedAt.localeCompare(a.startedAt))[0]
  const weekdayName = (label: string) => weekdays.find(weekday => weekday.code === label)?.name ?? label
  const ofDay = (label: string) => { const name = weekdayName(label).toLowerCase(); return name === 'domenica' ? `della ${name}` : `del ${name}` }
  // Settimanale: «oggi» solo se è davvero la seduta prevista per la data di oggi.
  const kicker = weekly
    ? day.id === suggestedDayId ? date === today ? 'Seduta di oggi' : `Seduta ${ofDay(day.label)}` : `Seduta ${ofDay(day.label)} · scelta da te`
    : `Seduta ${day.label}${day.id === suggestedDayId ? ' · suggerita' : ''}`
  // Allenamento in corso: se è proprio questa seduta in questa data la card diventa «in corso»
  // e il banner sarebbe un doppione; se è un'altra, il banner resta e la card non finge di riprenderla.
  const activeHere = Boolean(activeSession && activeSession.date === date && (activeSession.day.id === day.id || activeSession.day.label === day.label))
  const activeElsewhere = Boolean(activeSession) && !activeHere
  const activeRequired = activeSession ? activeSession.day.exercises.reduce((sum, exercise) => sum + exercise.sets, 0) : 0
  const activeDone = activeSession ? activeSession.day.exercises.reduce((sum, exercise) => sum + Math.min(exercise.sets, (activeSession.results[exercise.id] ?? []).filter(set => set.completed).length), 0) : 0
  const startedAt = activeSession ? new Date(activeSession.startedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : ''
  // CTA sticky: compare solo dopo aver superato la card della seduta (mobile e tablet).
  const startButton = useRef<HTMLButtonElement>(null)
  const [pastCard, setPastCard] = useState(false)
  useEffect(() => {
    const element = startButton.current
    if (!element || !('IntersectionObserver' in window)) return
    const observer = new IntersectionObserver(([entry]) => setPastCard(Boolean(entry) && !entry!.isIntersecting && entry!.boundingClientRect.top < 0))
    observer.observe(element)
    return () => observer.disconnect()
  }, [activeElsewhere])
  const startLabel = activeElsewhere && activeSession ? `Riprendi «${activeSession.day.title}» (in corso)` : activeHere ? 'Riprendi allenamento' : 'Inizia allenamento'
  const cycleContent = <>
    <span className="cycle-link-copy"><strong>{planTitle}</strong>{cycle && <small>{cycle.label}{cycle.detail && <> · {cycle.detail}</>}</small>}</span>
    {cycle?.ratio != null && <span className="cycle-link-bar" aria-hidden="true"><span style={{ width: `${Math.round(Math.min(1, Math.max(0, cycle.ratio)) * 100)}%` }} /></span>}
  </>
  return <>
    {activeElsewhere && activeSession && <a className="resume-banner" href="#/scheda/seduta"><Icon name="play" /><span><strong>Allenamento in corso</strong><small>{activeSession.day.title} · {formatDate(activeSession.date)}</small></span><span>Riprendi</span><Icon name="arrow" size={20} /></a>}
    <div className="workout-overview">
      <div className="workout-aside">
      {workoutWeekdays.length > 0 && <p className="small muted">{isWorkoutWeekday(date, workoutWeekdays) ? 'È uno dei tuoi giorni abituali di allenamento.' : 'Giorno libero: puoi comunque iniziare una seduta.'}</p>}
      {!weekly && days.length > 1 && <Segmented className="session-switch" label="Scegli una seduta" value={day.id} onChange={onDay} options={days.map(item => ({ value: item.id, label: item.label, ariaLabel: `Seduta ${item.label}: ${item.title}${item.id === suggestedDayId ? ', suggerita' : ''}`, dot: item.id === suggestedDayId }))} />}
      <section className="workout-summary" aria-labelledby="workout-title">
        <div className="workout-summary-top"><span className={`workout-kicker ${activeHere ? 'is-active' : ''}`}>{activeHere ? <><span className="workout-live-dot" aria-hidden="true" />In corso · iniziata alle {startedAt}</> : kicker}</span>{weekly && days.length > 0 && !activeHere && <button type="button" className="text-button change-session" aria-haspopup="dialog" onClick={() => setChoosing(true)}><Icon name="swap" size={16} />Cambia seduta</button>}</div>
        <h2 id="workout-title">{day.title}</h2>
        {activeHere
          ? <div className="workout-live-progress"><p className="workout-stats"><strong>{activeDone} di {activeRequired} serie</strong> · {day.exercises.length} {day.exercises.length === 1 ? 'esercizio' : 'esercizi'}</p><progress max={activeRequired || 1} value={activeDone} aria-label={`Serie completate: ${activeDone} di ${activeRequired}`} /></div>
          : <p className="workout-stats">{day.exercises.length} {day.exercises.length === 1 ? 'esercizio' : 'esercizi'} · {totalSets} serie{optionalSets > 0 && <> + {optionalSets} facoltative</>}</p>}
        {progressHref ? <a className="cycle-link" href={progressHref} aria-label={`${planTitle}${cycle ? `, ${cycle.label}${cycle.detail ? `, ${cycle.detail}` : ''}` : ''}. Apri i tuoi progressi`}>{cycleContent}<Icon name="chevron" size={20} /></a>
          : <div className="cycle-link is-static">{cycleContent}</div>}
        {planGuidance && <details className="workout-guidance"><summary>Indicazioni del programma</summary><p>{planGuidance}</p></details>}
        {activeElsewhere && activeSession
          ? <><button ref={startButton} className="button secondary lg workout-start" onClick={onStart}>{startLabel}<Icon name="play" size={20} /></button><p className="workout-blocked">Termina l’allenamento in corso per iniziare questa seduta.</p></>
          : <button ref={startButton} className="button primary lg workout-start" onClick={onStart}>{startLabel}<Icon name="play" size={20} /></button>}
        {activeSession && onDiscard && <button type="button" className="button secondary danger workout-cancel" aria-haspopup="dialog" onClick={onDiscard}>Annulla allenamento<Icon name="close" size={16} /></button>}
      </section>
      {day.notes && <section className="panel plan-guidance"><div><strong>Indicazioni della seduta</strong><p>{day.notes}</p></div></section>}
      </div>
      <div className="workout-exercises">
      <div className="section-heading"><h2>Gli esercizi</h2><span>{previousDay ? `Ultima seduta · ${formatDate(previousDay.date, { day: 'numeric', month: 'short' })}` : 'Nessuna seduta precedente'}</span></div>
      <div className="exercise-list">{day.exercises.map(exercise => {
        const previous = findPreviousExercise(sessions, exercise, { id: '', date, startedAt: new Date().toISOString() })
        const previousSet = previous?.results.find(set => set.completed)
        return <a key={exercise.id} className="exercise-card" href={`#/scheda/esercizio/${exercise.id}`}><MuscleGroupImage exercise={exercise} /><div className="exercise-copy"><h3>{exercise.name}</h3><MuscleGroupBadge exercise={exercise} illustrated={false} /><p className="exercise-prescription"><strong>{prescriptionText(exercise)}</strong>{exercise.optionalSets ? ` (+${exercise.optionalSets} facoltative)` : ''} · {restLabel(exercise.restSeconds)} recupero</p>{exerciseArea(exercise) && <span className="mini-label">{exerciseArea(exercise)}</span>}{previousSet && <span className="overview-previous"><Icon name="history" size={16} />{formatResult(previousSet, exercise.mode, exercise.loadUnit)} <span>· {formatDate(previous!.session.date, { day: 'numeric', month: 'short' })}</span></span>}</div><Icon name="chevron" size={20} /></a>
      })}</div>
      </div>
    </div>
    {/* Copia dell'azione principale, fissa sopra la navigazione quando la card è uscita dallo schermo. */}
    <div className={`sticky-cta ${pastCard ? 'is-visible' : ''}`} inert={!pastCard} aria-hidden={!pastCard}>
      <button type="button" className={`button lg ${activeElsewhere ? 'secondary' : 'primary'}`} onClick={onStart}>
        <span className="sticky-cta-copy"><strong>{startLabel}</strong>{!activeElsewhere && <small>{day.title}</small>}</span><Icon name="play" size={20} />
      </button>
    </div>
    {choosing && <Modal label="Cambia seduta" variant="sheet" onClose={() => setChoosing(false)}>
      <div className="session-picker">
        <h2>Cambia seduta</h2>
        <p className="muted">Vale solo per {date === today ? 'oggi' : formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}: il programma non cambia.</p>
        <ul>{days.map(item => <li key={item.id}><button type="button" aria-current={item.id === day.id ? 'true' : undefined} onClick={() => { onDay(item.id); setChoosing(false) }}>
          <span className="session-picker-day">{item.label}</span>
          <span className="session-picker-copy"><strong>{item.title}</strong><small>{weekdayName(item.label)}{item.id === suggestedDayId ? ' · prevista' : ''}</small></span>
          {item.id === day.id && <Icon name="check" size={20} />}
        </button></li>)}</ul>
      </div>
    </Modal>}
  </>
}

/** Recupero leggibile: «90 s», oppure «2 min» per i minuti interi. */
export function restLabel(seconds: number): string {
  return seconds >= 120 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`
}
/** L'etichetta dell'area si omette quando ripete il nome (es. «Panca» sopra «Panca piana»). */
function exerciseArea(exercise: ExercisePrescription): string | undefined {
  const area = exercise.area?.trim()
  return area && !exercise.name.toLowerCase().includes(area.toLowerCase()) ? area : undefined
}
const prescriptionText = (exercise: ExercisePrescription) => isTimedCardio(exercise) && exercise.sets === 1 ? `${Math.round(parseInt(exercise.target, 10) / 60 * 100) / 100} min` : `${exercise.sets} × ${exercise.target}${exercise.mode === 'reps' ? ' rip.' : ''}`

function PreviousResults({ previous, mode, unit }: { previous?: PreviousExercise; mode: ExercisePrescription['mode']; unit?: 'kg' | 'lb' }) {
  if (!previous) return <div className="no-previous"><Icon name="history" size={24} /><h3>La prima volta parte da qui</h3><p>Non ci sono ancora serie confrontabili per questo esercizio.</p></div>
  return <><div className="previous-heading"><span><Icon name="history" size={20} />{formatDate(previous.session.date, { day: 'numeric', month: 'long', year: 'numeric' })}</span><p>{previous.session.day.title}</p></div><div className="previous-results">{previous.results.map((set, index) => <div key={index}><span>Serie {index + 1}</span><strong>{set.completed ? formatResult(set, mode, unit) : 'Non completata'}</strong>{set.completed ? <Icon name="check" size={20} /> : <span>—</span>}</div>)}</div></>
}

export function ExerciseDetail({ exercise, previous }: { exercise: ExercisePrescription; previous?: PreviousExercise }) {
  const area = exerciseArea(exercise)
  return <>{area && <span className="eyebrow">{area}</span>}<h2>{exercise.name}</h2><MuscleGroupBadge exercise={exercise} /><div className="prescription-stats"><div><strong>{exercise.sets}{exercise.optionalSets ? ` +${exercise.optionalSets}` : ''}</strong><span>{exercise.optionalSets ? 'serie (+ facoltative)' : 'serie'}</span></div><div><strong>{exercise.target}</strong><span>{exercise.mode === 'seconds' ? 'durata prevista' : 'ripetizioni previste'}</span></div><div><strong>{restLabel(exercise.restSeconds)}</strong><span>recupero</span></div></div>{(exercise.loadLabel || exercise.effortLabel) && <div className="detail-facts">{exercise.loadLabel && <p><strong>Carico:</strong> {exercise.loadLabel}</p>}{exercise.effortLabel && <p><strong>Intensità:</strong> {exercise.effortLabel}</p>}</div>}{exercise.note && <div className="detail-note"><strong>Da ricordare</strong><p>{exercise.note}</p></div>}<h3>Ultima volta</h3><PreviousResults previous={previous} mode={exercise.mode} unit={exercise.loadUnit} /></>
}

/**
 * Serie corrispondente dell'ultima volta e, a serie spuntata, di quanto è stata superata e l'eventuale record.
 * Un record presuppone una seduta precedente confrontabile, quindi questa riga c'è sempre quando serve.
 */
function PreviousInline({ result, previous, mode, unit, record }: { result: SetResult; previous?: SetResult; mode: ExercisePrescription['mode']; unit?: 'kg' | 'lb'; record: boolean }) {
  const improvement = setImprovement(result, previous)
  return <div className="previous-inline"><span>Ultima:</span><strong>{formatResult(previous, mode, unit)}</strong>
    {improvement && <span className="set-delta">{formatImprovement(improvement, mode, unit)}<span className="sr-only"> rispetto all’ultima volta</span></span>}
    {record && <span className="record-badge"><Icon name="star" size={16} /><span className="sr-only">Nuovo </span>Record<span className="sr-only"> personale</span></span>}</div>
}

/** «Fallo dopo»: esercizi rimandati della seduta in corso, solo su questo dispositivo (il database non cambia). */
const LATER_KEY = 'peppitness:workout-later:v1'
function readLater(sessionId: string): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(LATER_KEY) ?? 'null') as { sessionId?: unknown; ids?: unknown } | null
    return value?.sessionId === sessionId && Array.isArray(value.ids) ? value.ids.filter((id): id is string => typeof id === 'string') : []
  } catch { return [] }
}
function writeLater(sessionId: string, ids: string[]) {
  try { if (ids.length) window.localStorage.setItem(LATER_KEY, JSON.stringify({ sessionId, ids })); else window.localStorage.removeItem(LATER_KEY) } catch { /* resta solo in memoria */ }
}
/** All'uscita dall'account: niente ordine della seduta rimasto sul dispositivo. */
export function forgetDeferredExercises() { try { window.localStorage.removeItem(LATER_KEY) } catch { /* archivio non disponibile */ } }

function ExerciseSetCard({ session, exercise, previous, onChange, locked, collapsible, onDone, recordIndex, deferred = false, canDefer = false, onDefer, onEnterFirstSet }: {
  session: WorkoutSession; exercise: ExercisePrescription; previous?: PreviousExercise; locked: boolean
  /** Serie che batte il miglior risultato precedente su questo esercizio. */
  recordIndex?: number
  /** Seduta in corso: completato l'esercizio, la card si riduce a una riga di riepilogo. */
  collapsible: boolean
  onDone: (exerciseId: string) => void
  onChange: (exerciseId: string, index: number, result: SetResult) => void
  /** Rimandato con «Fallo dopo»: ridotto in fondo alla lista finché non lo si riapre. */
  deferred?: boolean
  /** C'è almeno un altro esercizio da fare prima di questo. */
  canDefer?: boolean
  /** Rimanda l'esercizio o lo rimette al suo posto; solo nella seduta in corso. */
  onDefer?: (exerciseId: string) => void
  /** Entrando nella prima serie: la seduta segna l'ultima serie compilata dell'esercizio precedente. */
  onEnterFirstSet?: (exerciseId: string) => void
}) {
  const [error, setError] = useState<{ index: number; message: string } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [showPrevious, setShowPrevious] = useState(false)
  const summaryButton = useRef<HTMLButtonElement>(null)
  // Esercizio completato entrando in una sua serie facoltativa: la card resta aperta sotto il dito.
  const keepOpen = useRef(false)
  // Carico appena ripreso con un tocco: il primo tasto lo sostituisce, come se fosse selezionato (senza evidenziarlo).
  const freshLoad = useRef<number | null>(null)
  // Una seduta completata è in sola lettura finché non si sceglie di correggerla.
  const finished = locked
  const results = session.results[exercise.id] ?? []
  const completed = results.filter(set => set.completed).length
  const complete = exercise.sets > 0 && completed >= exercise.sets
  const collapsed = collapsible && (complete || deferred) && !expanded
  const wasComplete = useRef(complete)
  useEffect(() => {
    // Solo nel passaggio a «completato»: la card si chiude e la pagina va all'esercizio successivo.
    if (complete && !wasComplete.current && collapsible) {
      if (keepOpen.current) keepOpen.current = false
      else {
        setExpanded(false)
        // Se si sta già scrivendo in un'altra serie l'utente è andato avanti: niente focus né scorrimento.
        if (!(document.activeElement instanceof HTMLInputElement)) window.requestAnimationFrame(() => { summaryButton.current?.focus({ preventScroll: true }); onDone(exercise.id) })
      }
    }
    wasComplete.current = complete
  }, [complete, collapsible, exercise.id, onDone])
  const prefix = `${session.id}-${exercise.id}`
  const area = exerciseArea(exercise)
  const copyLoads = () => {
    if (!previous) return
    reusePreviousLoads(results, previous.results).forEach((set, i) => { if (set !== results[i]) onChange(exercise.id, i, set) })
  }
  // Esercizi a tempo (plank, cardio): niente carico, si registra solo il tempo fatto.
  const timed = exercise.mode === 'seconds'
  // Un tocco sul carico vuoto lo riempie con quello della serie corrispondente dell'ultima volta. Solo il carico:
  // le ripetizioni si scrivono sempre a mano (AGENT.md §6.1).
  const fillLoadFromLast = (setIndex: number) => {
    const result = results[setIndex], last = previous?.results[setIndex]
    if (finished || !result || result.load !== '' || !last?.completed || last.load.trim() === '') return
    setError(null)
    freshLoad.current = setIndex
    onChange(exercise.id, setIndex, { ...result, load: last.load, completed: false })
  }
  /** Carico scritto: dopo un riempimento automatico il primo inserimento sostituisce, la prima cancellazione svuota. */
  const typeLoad = (setIndex: number, value: string, input: Event) => {
    let load = value
    if (freshLoad.current === setIndex && input instanceof InputEvent) {
      if (input.inputType.startsWith('insert') && input.data) load = input.data
      else if (input.inputType.startsWith('delete')) load = ''
    }
    freshLoad.current = null
    setError(null)
    const result = results[setIndex]
    if (result) onChange(exercise.id, setIndex, { ...result, load, completed: false })
  }
  const toggleSet = (setIndex: number, result: SetResult) => {
    const validation = result.completed ? null : validateSet(result.load, result.amount, exercise.mode)
    if (validation) { setError({ index: setIndex, message: validation }); return }
    setError(null)
    // Riaprire toglie solo la spunta; spuntare porta anche lo stesso carico alla serie successiva ancora vuota.
    if (result.completed) onChange(exercise.id, setIndex, { ...result, completed: false })
    else completeSetChanges(results, setIndex, exercise.sets).forEach(change => onChange(exercise.id, change.index, change.result))
  }
  // Passando alla serie successiva, quella sopra già compilata si segna fatta e parte il recupero.
  // Solo nella seduta in corso e solo con valori che la spunta manuale accetterebbe.
  // Nella prima serie vale per l'ultima serie compilata dell'esercizio precedente (lo decide la seduta).
  const enterSet = (setIndex: number) => {
    if (!collapsible || finished) return
    if (setIndex === 0) { onEnterFirstSet?.(exercise.id); return }
    const above = results[setIndex - 1]
    if (!above || above.completed || validateSet(above.load, above.amount, exercise.mode)) return
    if (!complete && completed + 1 >= exercise.sets) { keepOpen.current = true; setExpanded(true) }
    toggleSet(setIndex - 1, above)
  }
  /** Ultima volta, in grigio nel campo vuoto: il carico si riprende con un tocco, le ripetizioni sono solo un riferimento. */
  const last = (setIndex: number) => { const set = previous?.results[setIndex]; return !finished && set?.completed ? set : undefined }
  const defer = onDefer && !complete && (deferred || canDefer)
    ? <button type="button" className="text-button defer-exercise" onClick={() => { setExpanded(false); onDefer(exercise.id) }}>{deferred ? 'Rimetti al suo posto' : 'Fallo dopo'}</button> : null
  if (collapsed) {
    const summary = results.filter(set => set.completed).map(set => formatResult(set, exercise.mode, exercise.loadUnit)).join(' · ')
    return <article className={`set-panel is-collapsed ${complete ? 'exercise-complete' : 'exercise-later'}`} id={`exercise-${prefix}`}>
      <button ref={summaryButton} type="button" className="set-summary" aria-expanded="false" aria-label={complete ? `${exercise.name}: completato, ${completed} di ${exercise.sets} serie. Apri per modificare` : `${exercise.name}: rimandato, ${completed} di ${exercise.sets} serie. Apri per farlo ora`} onClick={() => setExpanded(true)}>
        <span className={`exercise-number ${complete ? 'is-done' : 'is-later'}`}><Icon name={complete ? 'check' : 'clock'} size={20} /></span>
        <span className="set-summary-copy"><strong>{exercise.name}{recordIndex !== undefined && <span className="record-badge"><Icon name="star" size={16} />Record</span>}</strong><small>{complete ? summary : `Rimandato${summary ? ` · ${summary}` : ''}`}</small></span>
        <span className="exercise-counter">{completed}<span>/{exercise.sets}</span></span>
        <Icon name="chevronDown" size={20} />
      </button>
    </article>
  }
  return <article className={`set-panel ${complete ? 'exercise-complete' : ''}`} id={`exercise-${prefix}`}>
    <div className="set-card-heading"><MuscleGroupImage exercise={exercise} /><div>{area && <span className="mini-label">{area}</span>}<h2>{exercise.name}</h2><MuscleGroupBadge exercise={exercise} illustrated={false} /></div><span className="exercise-counter">{completed}<span>/{exercise.sets}</span></span></div>
    <div className="prescription-line"><span><strong>{prescriptionText(exercise)}</strong>{exercise.optionalSets ? ` · +${exercise.optionalSets} facoltative` : ''}</span><span><Icon name="clock" size={16} />{restLabel(exercise.restSeconds)} recupero</span>{defer}</div>
    <div className="set-rows">
      <div className={`set-grid set-header ${timed ? 'is-timed' : ''}`}><span>Serie</span>{!timed && <span>{exercise.loadUnit?.toUpperCase() ?? 'Carico'}</span>}<span>{timed ? 'Secondi' : 'Ripetizioni'}</span><span>Fatto</span></div>
      {results.map((result, setIndex) => {
        const name = `${exercise.name}, serie ${setIndex + 1}`
        const lastLoad = last(setIndex)?.load.trim() || undefined, lastAmount = last(setIndex)?.amount.trim() || undefined
        return <div className={`set-row ${result.completed ? 'row-complete' : ''} ${setIndex >= exercise.sets ? 'optional-set' : ''}`} key={setIndex}><div className={`set-grid ${timed ? 'is-timed' : ''}`}><strong title={setIndex >= exercise.sets ? 'Serie facoltativa' : undefined}>{setIndex + 1}{setIndex >= exercise.sets && <small aria-label="facoltativa">F</small>}</strong>
          {!timed && <input className={lastLoad ? 'has-last' : undefined} aria-label={`${name}, carico${exercise.loadUnit ? ` in ${exercise.loadUnit}` : ''}${lastLoad ? `, ultima volta ${lastLoad}` : ''}`} inputMode="decimal" maxLength={12} placeholder={lastLoad ?? '—'} value={result.load} readOnly={finished}
            onFocus={() => enterSet(setIndex)} onClick={() => fillLoadFromLast(setIndex)} onBlur={() => { if (freshLoad.current === setIndex) freshLoad.current = null }} onChange={event => typeLoad(setIndex, event.target.value, event.nativeEvent)} />}
          <input className={lastAmount ? 'has-last' : undefined} aria-label={`${name}, ${timed ? 'secondi' : 'ripetizioni'}${lastAmount ? `, ultima volta ${lastAmount}` : ''}`} aria-invalid={error?.index === setIndex || undefined} aria-describedby={error?.index === setIndex ? `${prefix}-error` : undefined} inputMode={timed ? 'decimal' : 'numeric'} maxLength={8} placeholder={lastAmount ?? '—'} value={result.amount} readOnly={finished}
            onFocus={() => enterSet(setIndex)} onChange={event => { setError(null); onChange(exercise.id, setIndex, { ...result, amount: event.target.value, completed: false }) }} />
          <button className={`set-check ${result.completed ? 'is-complete' : ''}`} disabled={finished} aria-label={`${result.completed ? 'Riapri' : 'Completa'} ${name}`} aria-pressed={result.completed} onClick={() => toggleSet(setIndex, result)}><Icon name="check" size={20} /></button></div>
          {previous && <PreviousInline result={result} previous={previous.results[setIndex]} mode={exercise.mode} unit={exercise.loadUnit} record={recordIndex === setIndex} />}{error?.index === setIndex && <p className="form-error" id={`${prefix}-error`} role="alert">{error.message}</p>}</div>
      })}
    </div>
    <div className="set-card-footer">
      {previous ? timed ? <span /> : <button className="text-button reuse-loads" disabled={finished || !results.some((set, i) => !set.completed && set.load === '' && previous.results[i]?.completed && previous.results[i]?.load !== '')} onClick={copyLoads}>Riprendi i carichi<Icon name="back" size={16} /></button> : <span>Prima volta per questo esercizio</span>}
      <span className="set-card-footer-end">
        {collapsible && (complete || deferred) && <button type="button" className="text-button set-collapse" aria-expanded="true" onClick={() => setExpanded(false)}>Riduci</button>}
        {previous && <button type="button" className="text-button history-peek" aria-haspopup="dialog" onClick={() => setShowPrevious(true)}>Storico<Icon name="chevron" size={16} /></button>}
      </span>
    </div>
    {showPrevious && <Modal label={`Ultima volta: ${exercise.name}`} variant="sheet" onClose={() => setShowPrevious(false)}>
      <div className="previous-sheet"><span className="eyebrow">Ultima volta</span><h2>{exercise.name}</h2><MuscleGroupBadge exercise={exercise} /><PreviousResults previous={previous} mode={exercise.mode} unit={exercise.loadUnit} /></div>
    </Modal>}
  </article>
}

/** Nota libera sull'intera seduta: modificabile in corso o in correzione, altrimenti solo letta. */
function SessionNote({ sessionId, note, editable, onChange }: { sessionId: string; note: string; editable: boolean; onChange?: (note: string) => void }) {
  const [open, setOpen] = useState(false)
  if (!editable || !onChange) return note ? <section className="session-note"><h2>Nota della seduta</h2><p>{note}</p></section> : null
  if (!note && !open) return <button type="button" className="text-button session-note-add" onClick={() => setOpen(true)}><Icon name="edit" size={16} />Aggiungi una nota alla seduta</button>
  return <section className="session-note">
    <label htmlFor={`session-note-${sessionId}`}>Nota della seduta</label>
    <textarea id={`session-note-${sessionId}`} rows={3} maxLength={4000} value={note} autoFocus={open && !note} placeholder="Es. presa larga sulla panca, fastidio alla spalla" onChange={event => onChange(event.target.value)} />
  </section>
}

export function SessionView({ session, sessions, onChange, onComplete, onDiscard, onEndCorrection, onNote, syncSlot }: {
  session: WorkoutSession; sessions: WorkoutSession[]
  onChange: (exerciseId: string, index: number, result: SetResult) => void; onComplete: () => void
  /** Elimina la seduta in corso (conferma nel menu «⋯»). */
  onDiscard?: () => void
  /** Fine correzione dello storico: i valori incompleti rimasti non vengono conservati. */
  onEndCorrection?: () => void
  /** Nota della seduta; senza, la nota è solo mostrata. */
  onNote?: (note: string) => void
  /** Indicatore compatto dello stato del salvataggio (in seduta la barra superiore è nascosta su mobile). */
  syncSlot?: ReactNode
}) {
  const finished = Boolean(session.completedAt)
  const [correcting, setCorrecting] = useState(false)
  const [options, setOptions] = useState(false)
  const [confirmEnd, setConfirmEnd] = useState(false)
  // «Fallo dopo» vale solo per la seduta in corso; lo storico mostra sempre l'ordine prescritto.
  const [later, setLater] = useState(() => finished ? [] : readLater(session.id))
  const endCorrection = useEffectEvent(() => onEndCorrection?.())
  useEffect(() => () => endCorrection(), [])
  // Seduta in corso: schermo acceso e audio sbloccato dai tocchi per l'avviso di fine recupero.
  useScreenWakeLock(!finished)
  useEffect(() => finished ? undefined : installAudioUnlock(), [finished])
  const records = sessionRecords(session, sessions)
  const { required, completedRequired } = sessionProgress(session)
  const exerciseCount = session.day.exercises.length
  const deferred = finished ? [] : later.filter(id => session.day.exercises.some(exercise => exercise.id === id))
  const ordered = sessionOrder(session.day.exercises, deferred)
  const isPending = (exercise: ExercisePrescription) => (session.results[exercise.id] ?? []).filter(set => set.completed).length < exercise.sets
  const pendingCount = session.day.exercises.filter(isPending).length
  const scrollTo = (exerciseId: string) => {
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById(`exercise-${session.id}-${exerciseId}`)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
  }
  // Esercizio completato: si passa al successivo ancora da fare, se esiste; i rimandati per ultimi.
  const goToNext = (exerciseId: string) => {
    const next = nextExercise(session, deferred, exerciseId)
    if (next) scrollTo(next)
  }
  const toggleLater = (exerciseId: string) => {
    const deferring = !deferred.includes(exerciseId)
    const next = deferring ? [...deferred, exerciseId] : deferred.filter(id => id !== exerciseId)
    setLater(next); writeLater(session.id, next)
    // Rimandato: la pagina va all'esercizio che ora viene dopo nel suo posto originale.
    const target = deferring ? nextExercise(session, deferred, exerciseId) : exerciseId
    if (target) window.requestAnimationFrame(() => scrollTo(target))
  }
  // Entrando nella prima serie di un esercizio si segna l'ultima serie compilata del precedente (nell'ordine mostrato).
  // La card sopra si riduce: lo scorrimento viene compensato perché il campo toccato resti sotto il dito.
  const anchor = useRef<{ element: Element; top: number } | null>(null)
  useLayoutEffect(() => {
    const kept = anchor.current
    if (!kept) return
    anchor.current = null
    const shift = kept.element.getBoundingClientRect().top - kept.top
    if (kept.element.isConnected && Math.abs(shift) > 1) window.scrollBy(0, shift)
  })
  const enterFirstSet = (exerciseId: string) => {
    const before = ordered[ordered.findIndex(exercise => exercise.id === exerciseId) - 1]
    if (finished || !before) return
    const results = session.results[before.id] ?? []
    const index = pendingFilledSet(results, before.mode)
    if (index === undefined) return
    const active = document.activeElement
    anchor.current = active ? { element: active, top: active.getBoundingClientRect().top } : null
    completeSetChanges(results, index, before.sets).forEach(change => onChange(before.id, change.index, change.result))
  }
  const filled = filledUnchecked(session)
  const emptyRequired = required - completedRequired - filled.filter(item => item.required).length
  const requestComplete = () => { if (completedRequired < required || filled.length > 0) setConfirmEnd(true); else onComplete() }
  // Le spunte in blocco precedono la chiusura: il completamento della seduta azzera il timer di recupero.
  const markFilledAndComplete = () => {
    setConfirmEnd(false)
    filled.forEach(item => onChange(item.exerciseId, item.index, { ...item.result, completed: true }))
    onComplete()
  }
  return <section className={`session-page ${finished ? '' : 'is-active'}`}>
    <SubpageHeader back={finished ? '#/scheda/storico' : '#/scheda'} backLabel={finished ? 'Torna allo storico' : 'Torna alla scheda'} title={session.day.title}
      subtitle={formatDate(session.date, { weekday: 'long', day: 'numeric', month: 'long' })}
      actions={<><span className={`session-status ${finished ? 'finished' : ''}`}><span />{finished ? 'Completato' : 'In corso'}</span>{syncSlot}{!finished && onDiscard && <button type="button" className="icon-button session-more" aria-haspopup="dialog" aria-label="Opzioni della seduta" onClick={() => setOptions(true)}><Icon name="more" size={24} strokeWidth={3} /></button>}</>} />
    <div className="session-progress"><div><span>{completedRequired} di {required} serie</span><strong>{required ? Math.round(completedRequired / required * 100) : 0}%</strong></div><progress max={required} value={completedRequired} aria-label="Serie completate" /></div>
    {finished && <div className="session-correction"><p className="small muted">{correcting ? 'Correzione attiva: le modifiche aggiornano solo lo storico di questa seduta.' : 'Seduta completata.'}</p><button className="button secondary session-correct" onClick={() => { if (correcting) onEndCorrection?.(); setCorrecting(!correcting) }}>{correcting ? 'Fine correzione' : 'Correggi valori'}</button></div>}
    <div className="session-cards">{ordered.map(exercise => <ExerciseSetCard key={exercise.id} session={session} exercise={exercise} previous={findPreviousExercise(sessions, exercise, session)} onChange={onChange} locked={finished && !correcting} collapsible={!finished} onDone={goToNext} recordIndex={records.get(exercise.id)}
      deferred={deferred.includes(exercise.id)} canDefer={pendingCount > 1} onDefer={finished ? undefined : toggleLater} onEnterFirstSet={enterFirstSet} />)}</div>
    <SessionNote sessionId={session.id} note={session.note ?? ''} editable={!finished || correcting} onChange={onNote} />
    {!finished && <div className="session-actions"><span>{completedRequired === required ? 'Tutte le serie previste sono fatte' : `${exerciseCount} ${exerciseCount === 1 ? 'esercizio' : 'esercizi'} · ${required - completedRequired} serie da fare`}</span><button className="button primary session-finish" onClick={requestComplete}>Termina allenamento<Icon name="check" size={20} /></button></div>}
    {options && onDiscard && <Modal label="Opzioni della seduta" variant="sheet" onClose={() => setOptions(false)}>
      <div className="session-options">
        <h2>Opzioni della seduta</h2>
        <p className="muted">Eliminare la seduta cancella questa seduta in corso e le serie annotate. Le sedute completate restano nello storico.</p>
        <button type="button" className="button secondary danger full-width session-discard" onClick={() => { setOptions(false); onDiscard() }}>Elimina seduta</button>
        <button type="button" className="button secondary full-width" onClick={() => setOptions(false)}>Continua l’allenamento</button>
      </div>
    </Modal>}
    {confirmEnd && <Modal label={filled.length ? 'Segnare le serie compilate?' : 'Terminare l’allenamento?'} onClose={() => setConfirmEnd(false)}>
      {filled.length > 0 ? <>
        <h2>{emptyRequired === 0 ? 'Segnare le serie compilate?' : 'Terminare l’allenamento?'}</h2>
        <p>Hai fatto {completedRequired} di {required} serie previste. {filledSentence(filled.length, emptyRequired)}.</p>
        <div className="button-row session-end-actions">
          <button className="button primary session-mark-complete" onClick={markFilledAndComplete}>{markFilledLabel(filled.length)}</button>
          <button className="button secondary session-finish-confirm" onClick={() => { setConfirmEnd(false); onComplete() }}>{filled.length === 1 ? 'Termina senza segnarla' : 'Termina senza segnarle'}</button>
          <button type="button" className="text-button" onClick={() => setConfirmEnd(false)}>Continua l’allenamento</button>
        </div>
      </> : <>
        <h2>Terminare l’allenamento?</h2>
        <p>Hai fatto {completedRequired} di {required} serie previste. Le serie non spuntate restano non completate nello storico.</p>
        <div className="program-actions"><button className="button secondary" onClick={() => setConfirmEnd(false)}>Continua l’allenamento</button><button className="button primary session-finish-confirm" onClick={() => { setConfirmEnd(false); onComplete() }}>Termina</button></div>
      </>}
    </Modal>}
  </section>
}

/** «2 serie sono compilate ma senza spunta, 1 è vuota e resterà non completata» (stesse parole in seduta e alla riapertura). */
export function filledSentence(filled: number, emptyRequired: number): string {
  return `${filled === 1 ? '1 serie è compilata' : `${filled} serie sono compilate`} ma senza spunta${emptyRequired > 0 ? `, ${emptyRequired === 1 ? '1 è vuota e resterà non completata' : `${emptyRequired} sono vuote e resteranno non completate`}` : ''}`
}
export function markFilledLabel(filled: number): string {
  return filled === 1 ? 'Segna la serie compilata e termina' : `Segna le ${filled} compilate e termina`
}
