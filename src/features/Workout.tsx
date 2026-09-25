import { useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { demoWorkoutDays } from '../data/demo'
import { formatDate } from '../domain/dates'
import { validateSet } from '../domain/validation'
import { findPreviousExercise, formatResult, reusePreviousLoads } from '../domain/workout'
import type { PreviousExercise } from '../domain/workout'
import type { DemoSession, ExercisePrescription, SetResult, WorkoutDay } from '../domain/types'

export function Workout({ day, date, sessions, onDay, activeSession, onStart }: {
  day: WorkoutDay; date: string; sessions: DemoSession[]; onDay: (id: string) => void; activeSession?: DemoSession; onStart: () => void
}) {
  const totalSets = day.exercises.reduce((sum, exercise) => sum + exercise.sets, 0)
  const previousDay = sessions.filter(session => session.completedAt && session.day.id === day.id && session.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date) || b.startedAt.localeCompare(a.startedAt))[0]
  return <>
    {activeSession && <a className="resume-banner" href="#/scheda/seduta"><Icon name="play" /><span><strong>Allenamento in corso</strong><small>{activeSession.day.title} · {formatDate(activeSession.date)}</small></span><span>Riprendi</span><Icon name="arrow" size={18} /></a>}
    <div className="workout-overview">
      <section className="workout-summary"><div className="workout-summary-copy"><span className="eyebrow">IL TUO PROGRAMMA</span><h2>Full body<span className="program-dot">.</span></h2><p>{day.exercises.length} esercizi <span>·</span> {totalSets} serie <span>·</span> Seduta {day.label}</p></div><button className="button primary" onClick={onStart}>{activeSession ? 'Riprendi allenamento' : 'Inizia allenamento'}<Icon name="play" size={17} /></button></section>
      <div className="workout-day-tabs" aria-label="Scegli una seduta">{demoWorkoutDays.map(item => <button key={item.id} aria-pressed={day.id === item.id} onClick={() => onDay(item.id)}><span>{item.label}</span><span>{item.title}</span>{item.id === day.id && <Icon name="check" size={16} />}</button>)}</div>
      <div className="section-heading"><h2>Gli esercizi</h2><span>{previousDay ? `Ultima seduta · ${formatDate(previousDay.date, { day: 'numeric', month: 'short' })}` : 'Il tuo punto di partenza'}</span></div>
      <div className="exercise-list">{day.exercises.map((exercise, index) => {
        const previous = findPreviousExercise(sessions, exercise, { id: '', date, startedAt: new Date().toISOString() })
        const previousSet = previous?.results.find(set => set.completed)
        return <a key={exercise.id} className="exercise-card" href={`#/scheda/esercizio/${exercise.id}`}><span className="exercise-number">{String(index + 1).padStart(2, '0')}</span><div className="exercise-copy"><span className="mini-label">{exercise.area}</span><h3>{exercise.name}</h3><p>{exercise.sets} serie <span>×</span> {exercise.target}{exercise.mode === 'reps' ? ' rip.' : ''}</p>{previousSet && <span className="overview-previous"><Icon name="history" size={13} />{formatResult(previousSet, exercise.mode)} <span>· {formatDate(previous!.session.date, { day: 'numeric', month: 'short' })}</span></span>}</div><span className="exercise-rest"><Icon name="clock" size={15} />{exercise.restSeconds}″</span><Icon name="chevron" size={18} /></a>
      })}</div>
    </div>
  </>
}

function PreviousResults({ previous, mode }: { previous?: PreviousExercise; mode: ExercisePrescription['mode'] }) {
  if (!previous) return <div className="no-previous"><Icon name="history" size={26} /><h3>La prima volta parte da qui</h3><p>Non ci sono ancora serie confrontabili per questo esercizio.</p></div>
  return <><div className="previous-heading"><span><Icon name="history" size={17} />{formatDate(previous.session.date, { day: 'numeric', month: 'long', year: 'numeric' })}</span><p>{previous.session.day.title}</p></div><div className="previous-results">{previous.results.map((set, index) => <div key={index}><span>Serie {index + 1}</span><strong>{set.completed ? formatResult(set, mode) : 'Non completata'}</strong>{set.completed ? <Icon name="check" size={17} /> : <span>—</span>}</div>)}</div></>
}

export function ExerciseDetail({ exercise, previous }: { exercise: ExercisePrescription; previous?: PreviousExercise }) {
  return <><span className="eyebrow">{exercise.area}</span><h2>{exercise.name}</h2><div className="prescription-stats"><div><strong>{exercise.sets}</strong><span>serie</span></div><div><strong>{exercise.target}</strong><span>{exercise.mode === 'seconds' ? 'durata prevista' : 'ripetizioni previste'}</span></div><div><strong>{exercise.restSeconds}″</strong><span>recupero</span></div></div>{exercise.note && <div className="detail-note"><strong>Da ricordare</strong><p>{exercise.note}</p></div>}<h3>Ultima volta</h3><PreviousResults previous={previous} mode={exercise.mode} /></>
}

function ExerciseSetCard({ session, exercise, index, previous, onChange }: {
  session: DemoSession; exercise: ExercisePrescription; index: number; previous?: PreviousExercise;
  onChange: (exerciseId: string, index: number, result: SetResult) => void
}) {
  const [panel, setPanel] = useState(0)
  const [error, setError] = useState<{ index: number; message: string } | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const tabs = useRef<(HTMLButtonElement | null)[]>([])
  const finished = Boolean(session.completedAt)
  const results = session.results[exercise.id] ?? []
  const completed = results.filter(set => set.completed).length
  const prefix = `${session.id}-${exercise.id}`
  const switchPanel = (next: number, focus = false) => {
    setPanel(next)
    viewport.current?.scrollTo({ left: next * viewport.current.clientWidth, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    if (focus) tabs.current[next]?.focus()
  }
  const copyLoads = () => {
    if (!previous) return
    reusePreviousLoads(results, previous.results).forEach((set, i) => { if (set !== results[i]) onChange(exercise.id, i, set) })
    switchPanel(0)
  }
  return <article className={`set-panel ${completed === results.length ? 'exercise-complete' : ''}`}>
    <div className="set-card-heading"><span className="exercise-number">{String(index + 1).padStart(2, '0')}</span><div><span className="mini-label">{exercise.area}</span><h2>{exercise.name}</h2></div><span className="exercise-counter">{completed}<span>/{results.length}</span></span></div>
    <div className="prescription-line"><span>{exercise.sets} × {exercise.target}{exercise.mode === 'reps' ? ' rip.' : ''}</span><span><Icon name="clock" size={14} />{exercise.restSeconds}″ recupero</span></div>
    <div className="comparison-tabs" role="tablist" aria-label={`Registrazione e precedente di ${exercise.name}`}>
      {['Questa seduta', 'Ultima volta'].map((label, i) => <button key={label} ref={element => { tabs.current[i] = element }} id={`${prefix}-tab-${i}`} type="button" role="tab" aria-selected={panel === i} aria-controls={`${prefix}-panel-${i}`} tabIndex={panel === i ? 0 : -1} onClick={() => switchPanel(i)} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); switchPanel(1 - i, true) } }}><Icon name={i ? 'history' : 'dumbbell'} size={15} />{label}{i === 1 && previous && <span>{formatDate(previous.session.date, { day: 'numeric', month: 'short' })}</span>}</button>)}
    </div>
    <div className="comparison-viewport" ref={viewport} onScroll={event => { const element = event.currentTarget; if (element.clientWidth) setPanel(Math.round(element.scrollLeft / element.clientWidth)) }}>
      <div className="comparison-panel current-panel" role="tabpanel" id={`${prefix}-panel-0`} aria-labelledby={`${prefix}-tab-0`} inert={panel !== 0}>
        <div className="set-grid set-header"><span>Serie</span><span>Kg</span><span>{exercise.mode === 'seconds' ? 'Secondi' : 'Ripetizioni'}</span><span>Fatto</span></div>
        {results.map((result, setIndex) => <div className={`set-row ${result.completed ? 'row-complete' : ''}`} key={setIndex}><div className="set-grid"><strong>{setIndex + 1}</strong><input aria-label={`${exercise.name}, serie ${setIndex + 1}, carico in kg`} inputMode="decimal" maxLength={12} placeholder="—" value={result.load} readOnly={finished} onChange={event => { setError(null); onChange(exercise.id, setIndex, { ...result, load: event.target.value, completed: false }) }} /><input aria-label={`${exercise.name}, serie ${setIndex + 1}, ${exercise.mode === 'seconds' ? 'secondi' : 'ripetizioni'}`} aria-invalid={error?.index === setIndex || undefined} aria-describedby={error?.index === setIndex ? `${prefix}-error` : undefined} inputMode={exercise.mode === 'seconds' ? 'decimal' : 'numeric'} maxLength={8} placeholder="—" value={result.amount} readOnly={finished} onChange={event => { setError(null); onChange(exercise.id, setIndex, { ...result, amount: event.target.value, completed: false }) }} /><button className={`set-check ${result.completed ? 'is-complete' : ''}`} disabled={finished} aria-label={`${result.completed ? 'Riapri' : 'Completa'} ${exercise.name}, serie ${setIndex + 1}`} aria-pressed={result.completed} onClick={() => {
          const validation = result.completed ? null : validateSet(result.load, result.amount, exercise.mode)
          if (validation) { setError({ index: setIndex, message: validation }); return }
          setError(null); onChange(exercise.id, setIndex, { ...result, completed: !result.completed })
        }}><Icon name="check" size={19} /></button></div>{previous && <div className="previous-inline"><span>Ultima:</span><strong>{formatResult(previous.results[setIndex], exercise.mode)}</strong></div>}{error?.index === setIndex && <p className="form-error" id={`${prefix}-error`} role="alert">{error.message}</p>}</div>)}
        <div className="set-card-footer">{previous ? <button className="text-button reuse-loads" disabled={finished || !results.some((set, i) => !set.completed && set.load === '' && previous.results[i]?.completed && previous.results[i]?.load !== '')} onClick={copyLoads}>Riprendi i carichi<Icon name="back" size={14} /></button> : <span>Nessun precedente confrontabile</span>}<button className="text-button history-peek" onClick={() => switchPanel(1)}>Ultima volta<Icon name="chevron" size={15} /></button></div>
      </div>
      <div className="comparison-panel previous-panel" role="tabpanel" id={`${prefix}-panel-1`} aria-labelledby={`${prefix}-tab-1`} inert={panel !== 1}>
        <PreviousResults previous={previous} mode={exercise.mode} />
        <div className="previous-footer"><Icon name="back" size={15} /><span>Scorri a destra per tornare alle serie.</span></div>
      </div>
    </div>
  </article>
}

export function SessionView({ session, sessions, onChange, onComplete }: {
  session: DemoSession; sessions: DemoSession[];
  onChange: (exerciseId: string, index: number, result: SetResult) => void; onComplete: () => void
}) {
  const finished = Boolean(session.completedAt)
  const results = Object.values(session.results).flat()
  const completedSets = results.filter(set => set.completed).length
  return <section className="session-page">
    <div className="session-topline"><a className="back-link" href={finished ? '#/scheda/storico' : '#/scheda'}><Icon name="back" size={18} />{finished ? 'Storico' : 'Scheda'}</a><span className={`session-status ${finished ? 'finished' : ''}`}><span />{finished ? 'Completato' : 'In corso'}</span></div>
    <div className="page-heading session-heading"><div><span className="eyebrow">ALLENAMENTO</span><h1>{session.day.title}</h1><p>{formatDate(session.date, { weekday: 'long', day: 'numeric', month: 'long' })}</p></div><span className="session-letter">{session.day.label}</span></div>
    <div className="session-progress"><div><span>{completedSets} di {results.length} serie</span><strong>{Math.round(completedSets / results.length * 100)}%</strong></div><progress max={results.length} value={completedSets} aria-label="Serie completate" /></div>
    <div className="session-cards">{session.day.exercises.map((exercise, index) => <ExerciseSetCard key={exercise.id} session={session} exercise={exercise} index={index} previous={findPreviousExercise(sessions, exercise, session)} onChange={onChange} />)}</div>
    {!finished && <div className="session-actions"><span>{completedSets} serie completate</span><button className="button primary" onClick={onComplete}>Termina allenamento<Icon name="check" size={18} /></button></div>}
  </section>
}
