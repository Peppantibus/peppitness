import { useEffect, useState, useSyncExternalStore } from 'react'
import { DatePicker } from './components/DatePicker'
import { Icon } from './components/Icon'
import { Layout } from './components/Layout'
import { Modal } from './components/Modal'
import { PwaUpdate } from './components/PwaUpdate'
import { RestTimer } from './components/RestTimer'
import { demoMeals, demoWorkoutDays } from './data/demo'
import { formatDate, localDate } from './domain/dates'
import { findPreviousExercise } from './domain/workout'
import type { SetResult } from './domain/types'
import { Diet, MealDetail } from './features/Diet'
import { History } from './features/History'
import { Settings } from './features/Settings'
import { ExerciseDetail, SessionView, Workout } from './features/Workout'
import { createDemoState, mealLogKey, recordMeal, startDemoSession, updateSessionSet } from './persistence/demo-store'

function subscribeRoute(callback: () => void) { window.addEventListener('hashchange', callback); return () => window.removeEventListener('hashchange', callback) }
function currentRoute() { return window.location.hash.replace(/^#/, '') || '/dieta' }
function navigate(path: string) { window.location.hash = path }

export function App() {
  const route = useSyncExternalStore(subscribeRoute, currentRoute)
  const [date, setDate] = useState(localDate)
  const [state, setState] = useState(createDemoState)
  const [dayId, setDayId] = useState(demoWorkoutDays[0]!.id)
  const [online, setOnline] = useState(navigator.onLine)
  const [announcement, setAnnouncement] = useState('')
  const section = route.startsWith('/scheda') ? 'scheda' : 'dieta'
  const day = demoWorkoutDays.find(item => item.id === dayId) ?? demoWorkoutDays[0]!
  const activeSession = state.sessions.find(session => !session.completedAt)
  const isHistory = route === `/${section}/storico`
  const isSettings = route === '/impostazioni'
  const isSession = route === '/scheda/seduta'
  const historySession = route.startsWith('/scheda/storico/') ? state.sessions.find(session => session.id === route.split('/')[3]) : undefined
  const meal = route.startsWith('/dieta/pasto/') ? demoMeals.find(item => item.id === route.split('/')[3]) : undefined
  const exercise = route.startsWith('/scheda/esercizio/') ? demoWorkoutDays.flatMap(item => item.exercises).find(item => item.id === route.split('/')[3]) : undefined
  const validRoute = route === '/dieta' || route === '/scheda' || isHistory || isSettings || isSession || Boolean(meal || exercise || historySession)
  const inDetail = Boolean(meal || exercise)
  const showDaily = validRoute && !isHistory && !isSettings && !isSession && !historySession
  const today = localDate()

  useEffect(() => {
    const updateNetwork = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateNetwork)
    window.addEventListener('offline', updateNetwork)
    return () => { window.removeEventListener('online', updateNetwork); window.removeEventListener('offline', updateNetwork) }
  }, [])

  useEffect(() => {
    document.title = `${isSettings ? 'Impostazioni' : section === 'dieta' ? 'Dieta' : 'Scheda'} · peppitness`
    if (!inDetail) { window.scrollTo({ top: 0 }); document.getElementById('main-content')?.focus({ preventScroll: true }) }
  }, [route, section, isSettings, inDetail])

  useEffect(() => {
    if (!activeSession && !Object.keys(state.mealLogs).length && !state.sessions.length) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [activeSession, state.mealLogs, state.sessions.length])

  const updateResult = (exerciseId: string, index: number, result: SetResult) => {
    if (activeSession) setState(current => updateSessionSet(current, activeSession.id, exerciseId, index, result))
  }

  return <Layout section={section} hasTimer={Boolean(state.restTimer)}>
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    {!online && <div className="network-notice" role="status"><Icon name="info" size={18} /><span>Rete assente.</span></div>}
    {showDaily && <>
      <div className="page-heading"><div><span className="eyebrow">{date === today ? 'OGGI' : 'IL TUO DIARIO'}</span><h1>{section === 'dieta' ? 'La tua dieta' : 'La tua scheda'}<span className="heading-dot">.</span></h1><p>{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</p></div><a className="button secondary history-button" href={`#/${section}/storico`} aria-label={section === 'dieta' ? 'Apri lo storico dei pasti' : 'Apri lo storico delle sedute'}><Icon name="history" size={18} /><span>Storico</span></a></div>
      <DatePicker date={date} onChange={setDate} />
      {date !== today && <div className="past-notice"><Icon name="calendar" size={17} /><span>Giornata {date < today ? 'passata' : 'futura'} · <strong>{formatDate(date)}</strong></span></div>}
      {section === 'dieta' ? <Diet date={date} state={state} onDayType={type => setState(current => ({ ...current, dayTypes: { ...current.dayTypes, [date]: type } }))} /> : <Workout day={day} date={date} sessions={state.sessions} onDay={setDayId} activeSession={activeSession} onStart={() => { setState(current => startDemoSession(current, date, day)); navigate('/scheda/seduta') }} />}
    </>}
    {isHistory && <History section={section} state={state} onDate={setDate} />}
    {isSettings && <Settings />}
    {isSession && (activeSession ? <SessionView key={activeSession.id} session={activeSession} sessions={state.sessions} onChange={updateResult} onComplete={() => { setState(current => ({ ...current, restTimer: null, sessions: current.sessions.map(session => session.id === activeSession.id ? { ...session, completedAt: new Date().toISOString() } : session) })); navigate('/scheda/storico'); setAnnouncement('Allenamento completato.') }} /> : <section className="panel empty-state"><h1>Nessun allenamento in corso</h1><p>Seleziona una seduta dalla scheda per iniziare.</p><a href="#/scheda" className="button primary">Vai alla scheda</a></section>)}
    {historySession && <SessionView key={historySession.id} session={historySession} sessions={state.sessions} onChange={() => undefined} onComplete={() => undefined} />}
    {!validRoute && <section className="panel empty-state"><h1>Questa pagina non è disponibile</h1><a className="button primary" href={`#/${section}`}>Torna al tuo spazio</a></section>}
    {meal && <Modal label={`${meal.name}, ${formatDate(date)}`} onClose={() => navigate('/dieta')}><MealDetail key={`${date}:${meal.id}`} meal={state.mealLogs[mealLogKey(date, meal.id)]?.snapshot ?? meal} log={state.mealLogs[mealLogKey(date, meal.id)]} onClose={() => navigate('/dieta')} onSave={(status, note) => { setState(current => recordMeal(current, date, meal, status, note)); setAnnouncement(`${meal.name}: registrazione aggiornata.`) }} /></Modal>}
    {exercise && <Modal label={exercise.name} onClose={() => navigate('/scheda')}><ExerciseDetail exercise={exercise} previous={findPreviousExercise(state.sessions, exercise, { id: '', date, startedAt: new Date().toISOString() })} /></Modal>}
    {state.restTimer && <RestTimer timer={state.restTimer} onChange={restTimer => setState(current => ({ ...current, restTimer }))} />}
    <PwaUpdate busy={Boolean(activeSession) || inDetail} hasDemoData={Boolean(Object.keys(state.mealLogs).length || state.sessions.length)} />
  </Layout>
}
