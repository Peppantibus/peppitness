import { FreeWorkoutEntry } from '../features/FreeWorkout'
import { useState } from 'react'
import { Modal } from '../components/Modal'
import { WorkoutDaySwap, WorkoutDaySwapStatus } from '../features/WorkoutDaySwap'
import { Icon } from '../components/Icon'
import { formatDate } from '../domain/dates'
import { weekdayOfDate, weekdays } from '../domain/weekly'
import { Workout } from '../features/Workout'
import type { DiaryState, DiaryStore } from '../persistence/diary-store'
import type { PlansState, PlansStore } from '../persistence/plans-store'
import type { WorkoutToday as Schedule } from './use-workout-today'

interface Props {
  configured: boolean
  plans: { store: PlansStore | null; state: PlansState }
  diary: { store: DiaryStore; state: DiaryState }
  schedule: Schedule
  date: string
  timeZone: string
  today: string
  workoutWeekdays: number[] | undefined
  onStartFree: () => void
  onStart: () => void
  onDiscard: (sessionId: string) => void
}

function RetryPlans({ store }: { store: PlansStore | null }) {
  return <button className="button primary" onClick={() => void store?.load()}>Riprova</button>
}

function ActiveRestSession({ title, date, onDiscard }: { title: string; date: string; onDiscard: () => void }) {
  const [optionsOpen, setOptionsOpen] = useState(false)
  return <section className="rest-active-session" aria-label="Allenamento in corso">
    <div className="rest-active-heading"><span className="rest-active-icon"><Icon name="play" size={20} /></span><div><strong>Hai una seduta in corso</strong><p>{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })} · {title}</p></div>
      <button type="button" className="icon-button" aria-label="Opzioni della seduta in corso" aria-haspopup="dialog" onClick={() => setOptionsOpen(true)}><Icon name="more" size={20} /></button>
    </div>
    <a className="button primary rest-active-resume" href="#/scheda/seduta">Riprendi allenamento<Icon name="arrow" size={20} /></a>
    {optionsOpen && <Modal label="Seduta in corso" variant="sheet" onClose={() => setOptionsOpen(false)}><div className="workout-card-menu"><h2>Seduta in corso</h2><button type="button" className="rest-active-discard" aria-haspopup="dialog" onClick={() => { setOptionsOpen(false); onDiscard() }}><Icon name="close" size={20} /><span><strong>Annulla allenamento</strong><small>Ti chiederemo conferma prima di eliminarlo.</small></span><Icon name="chevron" size={20} /></button></div></Modal>}
  </section>
}

function CycleFinished({ done, planned }: { done: number; planned: number }) {
  return <section className="cycle-finished"><Icon name="check" size={20} /><div><strong>Ciclo concluso</strong><p>Hai completato {done} sedute su {planned}. Guarda come è andata e prepara il prossimo.</p></div>
    <div className="program-actions"><a className="button secondary" href="#/scheda/progressi">Progressi</a><a className="button primary" href="#/scheda/programmi/rinnova">Crea dal programma concluso</a></div></section>
}

/** Contenuto quotidiano della Scheda: caricamento, riposo, scelta del programma o seduta del giorno. */
export function WorkoutToday({ configured, plans, diary, schedule, date, today, workoutWeekdays, onStart, onStartFree, onDiscard, timeZone }: Props) {
  const { state } = plans
  const workout = state.workout
  const { day, weekly, workoutDays, activeSession, followable } = schedule
  const swapProps = configured && weekly && workout ? { workout, days: schedule.baseDays, date, today, timeZone, store: diary.store, state: diary.state, onApplied: schedule.resetDay } : null
  const scheduleStatus = swapProps && <WorkoutDaySwapStatus key={`${workout!.version.id}:${date}`} {...swapProps} />
  const finished = schedule.cycleFinished && <CycleFinished done={schedule.cycleScore?.done ?? 0} planned={schedule.cycleScore?.planned ?? 0} />
  const cancel = activeSession && <button type="button" className="button secondary danger workout-cancel" aria-haspopup="dialog" onClick={() => onDiscard(activeSession.id)}>Annulla allenamento</button>

  if (configured && state.phase === 'loading') return <section className="panel empty-state" role="status"><h2>Caricamento del programma…</h2></section>
  if (configured && state.phase === 'error') return <section className="panel empty-state"><h2>Programma non disponibile</h2><p role="alert">{state.message}</p><RetryPlans store={plans.store} /></section>

  if (!day && weekly && workout) return <>
    {finished}
    {activeSession && <ActiveRestSession key={activeSession.id} title={activeSession.day.title} date={activeSession.date} onDiscard={() => onDiscard(activeSession.id)} />}
    <section className="rest-day" aria-labelledby="rest-day-title">
      <span className="rest-day-icon" aria-hidden="true"><Icon name="moon" size={24} /></span>
      <div className="rest-day-copy"><span className="eyebrow">{weekdays[weekdayOfDate(date)]!.name}</span>
      <h2 id="rest-day-title">Giorno di riposo</h2>
      <p>Nessuna seduta prevista. Prenditi il tempo per recuperare.</p></div>
      {!activeSession && swapProps && <WorkoutDaySwap key={`${workout.version.id}:${date}`} {...swapProps} />}
    </section>
    {scheduleStatus}
      <details key={date} className="rest-day-options"><summary><span>Allenati senza cambiare programma<small>Allenamento libero o una seduta extra</small></span><Icon name="chevronDown" size={20} /></summary>
        <div className="rest-day-actions">
        {activeSession ? <p className="rest-active-hint">Puoi consultare le altre sedute. Per iniziare un altro allenamento, termina o annulla quello in corso.</p> : <FreeWorkoutEntry date={date} onStart={onStartFree} disabled={configured && diary.state.phase !== 'ready'} />}
        <details className="rest-day-sessions"><summary><Icon name="dumbbell" size={20} /><span><strong>Usa una seduta del programma</strong><small>Solo per questa data, senza spostarla</small></span><Icon name="chevronDown" size={16} /></summary>
        <div className="rest-day-session-list">{workoutDays.map(item => <button key={item.id} type="button" onClick={() => schedule.selectDay(item.id)}><span>{weekdays.find(weekday => weekday.code === item.label)?.name ?? item.label}<strong>{item.title}</strong></span><Icon name="chevron" size={16} /></button>)}</div>
        </details>
      </div></details>
  </>

  if (!day) return <section className="panel empty-state plan-empty">
    {followable.length ? <>
      <h2>Scegli il programma da seguire</h2><p>La Scheda mostra la versione corrente del programma scelto. Puoi cambiarlo in qualsiasi momento.</p>
      <div className="plan-choices">{followable.map(item => <button key={item.plan.id} className="button secondary plan-choice" disabled={state.selecting} onClick={() => void plans.store?.choose({ workoutPlanId: item.plan.id })}>{item.plan.name}</button>)}</div>
    </> : <>
      <span className="empty-icon"><Icon name="calendar" size={32} /></span><h2>Nessun programma da seguire</h2><p>Imposta la tua settimana: per ogni giorno scegli gli esercizi oppure il riposo.</p>
      <a className="button primary" href="#/scheda/programmi/nuovo">Crea il tuo programma<Icon name="arrow" size={20} /></a><a className="text-link" href="#/scheda/importa">Oppure importalo dal modello Word</a>
    </>}
    <FreeWorkoutEntry date={date} onStart={onStartFree} active={Boolean(activeSession)} disabled={configured && diary.state.phase !== 'ready'} />
    {activeSession && <><a className="button secondary" href="#/scheda/seduta">Riprendi l’allenamento in corso</a>{cancel}</>}
  </section>

  return <>
    {finished}
    {configured && followable.length > 1 && <section className="plan-selectors"><label className="plan-selector">Programma seguito
      <select value={workout?.plan.id ?? ''} disabled={state.selecting} onChange={event => { schedule.resetDay(); void plans.store?.choose({ workoutPlanId: event.target.value }) }}>
        {followable.map(item => <option key={item.plan.id} value={item.plan.id}>{item.plan.name}</option>)}
      </select></label></section>}
    {configured && diary.state.phase === 'loading' && <p className="small muted" role="status">Caricamento del diario…</p>}
    {configured && diary.state.phase === 'error' && <section className="panel"><p role="alert">{diary.state.message}</p><button className="button secondary" onClick={() => void diary.store.refresh()}>Riprova</button></section>}
    <Workout scheduleStatus={scheduleStatus} scheduleActions={swapProps ? onChooseDay => <WorkoutDaySwap key={`${workout!.version.id}:${date}`} {...swapProps} variant="menu" onChooseDay={onChooseDay} /> : undefined} day={day} days={workoutDays} planTitle={workout ? workout.plan.name : 'Full body'} planGuidance={workout?.version.guidance || undefined} date={date} today={today}
      sessions={diary.state.view.sessions} onDay={schedule.selectDay} cycle={schedule.cycleSummary} progressHref={workout ? '#/scheda/progressi' : undefined}
      activeSession={activeSession} suggestedDayId={weekly ? schedule.planned?.id : workoutDays.length > 1 ? schedule.suggestion?.id : undefined} weekly={weekly}
      workoutWeekdays={weekly ? [] : workoutWeekdays} onStart={onStart} onStartFree={onStartFree} freeAvailable={!configured || diary.state.phase === 'ready'} onDiscard={activeSession ? () => onDiscard(activeSession.id) : undefined}
      onCancelSelection={weekly && !schedule.planned ? schedule.resetDay : undefined} />
  </>
}
