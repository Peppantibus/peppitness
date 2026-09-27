import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { DatePicker } from './components/DatePicker'
import { Icon } from './components/Icon'
import { Layout } from './components/Layout'
import { Modal } from './components/Modal'
import { PwaUpdate } from './components/PwaUpdate'
import { RestTimer } from './components/RestTimer'
import { SectionMenu } from './components/SectionMenu'
import { SyncStatus, syncLabels } from './components/SyncStatus'
import { demoMeals, demoWorkoutDays } from './data/demo'
import { formatDate, localDate } from './domain/dates'
import { mealLogKey, suggestedDay, workoutDaysFromProgram } from './domain/diary'
import { daysForType, fitsMealWizard, mealFromPlan } from './domain/meal-plans'
import { dayForDate, fitsWizard, isWeekly, weekdayOfDate, weekdays } from './domain/weekly'
import { adherence, cycleInfo, mondayOf, weeklyProgress } from './domain/progress'
import { Progress } from './features/Progress'
import type { WizardStep } from './features/ProgramWizard'
import type { MealWizardStep } from './features/MealPlanWizard'
import { findPreviousExercise } from './domain/workout'
import type { SetResult } from './domain/types'
import { Diet, MealDetail } from './features/Diet'
import { History } from './features/History'
import { Settings } from './features/Settings'
import { ExerciseDetail, SessionView, Workout } from './features/Workout'
import { useDiary } from './persistence/use-diary'
import { useExercises } from './persistence/use-exercises'
import { usePlans } from './persistence/use-plans'
import { usePrograms } from './persistence/use-programs'
import { useSettings } from './persistence/use-settings'

const Programs = lazy(() => import('./features/ProgramEditor').then(module => ({ default: module.Programs })))
const ExerciseCatalog = lazy(() => import('./features/ExerciseCatalog').then(module => ({ default: module.ExerciseCatalog })))
const MealPlans = lazy(() => import('./features/MealPlans').then(module => ({ default: module.MealPlans })))

function subscribeRoute(callback: () => void) { window.addEventListener('hashchange', callback); return () => window.removeEventListener('hashchange', callback) }
function currentRoute() { return window.location.hash.replace(/^#/, '') || '/dieta' }
function navigate(path: string) { window.location.hash = path }

export function App() {
  const route = useSyncExternalStore(subscribeRoute, currentRoute)
  const settings = useSettings()
  const isCatalog = route === '/scheda/catalogo'
  const isPrograms = route === '/scheda/programmi' || route === '/scheda/programmi/nuovo' || route === '/scheda/programmi/modifica' || route === '/scheda/programmi/rinnova'
  const isMealPlans = route === '/dieta/piani' || route === '/dieta/piani/nuovo'
  const isProgress = route === '/scheda/progressi'
  const catalog = useExercises(isCatalog || isPrograms)
  const programs = usePrograms(isPrograms)
  // Rilettura dei piani al ritorno dagli editor verso le pagine quotidiane.
  const plans = usePlans(isCatalog || isPrograms ? 'programs' : isMealPlans ? 'meal-plans' : 'daily')
  const diary = useDiary()
  const configured = Boolean(plans.store)
  const view = diary.state.view
  const timeZone = settings.state.saved?.timeZone ?? 'Europe/Rome'
  const today = localDate(new Date(), timeZone)
  const [selectedDate, selectDate] = useState<string | null>(null)
  const date = selectedDate ?? today
  const setDate = (value: string) => selectDate(value === today ? null : value)
  const [dayId, setDayId] = useState<string | null>(null)
  // Nel programma settimanale la seduta segue il giorno: una scelta diversa vale solo per quella data.
  const [dayChoice, setDayChoice] = useState<{ date: string; id: string } | null>(null)
  const [programMode, setProgramMode] = useState<'wizard' | 'advanced'>('wizard')
  const [programStep, setProgramStep] = useState<WizardStep>('name')
  const [mealMode, setMealMode] = useState<'wizard' | 'advanced'>('wizard')
  const [mealStep, setMealStep] = useState<MealWizardStep>('name')
  const opening = useRef(false)
  const [planDayChoice, setPlanDayChoice] = useState<Record<string, string>>({})
  const [discarding, setDiscarding] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [announcement, setAnnouncement] = useState('')
  const section = route.startsWith('/scheda') ? 'scheda' : 'dieta'

  // Scheda: versione corrente del programma seguito; nessun programma inventato sotto un account.
  const workout = plans.state.workout
  const workoutDays = useMemo(() => configured ? workout ? workoutDaysFromProgram(workout.document) : [] : demoWorkoutDays, [configured, workout])
  const weekly = isWeekly(workoutDays)
  const planned = weekly ? dayForDate(workoutDays, date) : undefined
  const suggestion = weekly ? planned : suggestedDay(workoutDays, view.sessions)
  const chosen = weekly ? (dayChoice?.date === date ? workoutDays.find(item => item.id === dayChoice.id) : undefined) : workoutDays.find(item => item.id === dayId)
  const day = weekly ? chosen ?? planned : chosen ?? suggestion ?? workoutDays[0]
  const selectDay = (id: string) => weekly ? setDayChoice({ date, id }) : setDayId(id)
  const followable = plans.state.programs.filter(item => item.plan.activeVersionId && !item.plan.archivedAt)
  const activeSession = view.sessions.find(session => !session.completedAt)
  // Ciclo del programma seguito: settimana corrente e sedute fatte su quelle previste finora.
  const cycle = workout?.plan.cycle ?? null
  const cycleNow = cycle ? cycleInfo(cycle, date) : null
  const programSessions = view.sessions.filter(session => session.planId === workout?.plan.id)
  const cycleScore = cycle && workoutDays.length ? adherence(weeklyProgress(workoutDays, programSessions, cycle, today)) : null
  const cycleLabel = cycleNow ? cycleNow.status === 'upcoming' ? `INIZIA ${formatDate(cycleNow.start, { day: 'numeric', month: 'short' }).toUpperCase()}` : cycleNow.status === 'finished' ? 'CICLO CONCLUSO' : `SETTIMANA ${cycleNow.week} DI ${cycleNow.weeks} · ${cycleScore?.done ?? 0} DI ${cycleScore?.due ?? 0} SEDUTE FATTE` : undefined

  // Dieta: giornata del piano seguito compatibile con il tipo di giornata del diario.
  const mealPlan = configured ? plans.state.mealPlans.find(plan => plan.id === plans.state.selection?.mealPlanId && !plan.archivedAt) : undefined
  const followableMeals = plans.state.mealPlans.filter(plan => !plan.archivedAt)
  // Tipo di giornata: quello annotato; altrimenti la scheda settimanale seguita (riposo se
  // quel giorno non ha seduta); altrimenti palestra. Sempre modificabile dall'utente.
  const programDayType = weekly && workout ? (planned ? 'training' : 'rest') : undefined
  const dayType = view.dayTypes[date] ?? programDayType ?? 'training'
  const candidateDays = mealPlan ? daysForType(mealPlan.document, dayType) : []
  const planDay = candidateDays.find(item => item.id === planDayChoice[`${date}:${dayType}`]) ?? candidateDays[0]
  const meals = useMemo(() => configured ? planDay?.meals.map(mealFromPlan) ?? [] : demoMeals, [configured, planDay])

  const isHistory = route === `/${section}/storico`
  const isSettings = route === '/impostazioni'
  const isSession = route === '/scheda/seduta'
  const historySession = route.startsWith('/scheda/storico/') ? view.sessions.find(session => session.id === route.split('/')[3] && session.completedAt) : undefined
  const mealId = route.startsWith('/dieta/pasto/') ? route.split('/')[3] : undefined
  const meal = mealId ? meals.find(item => item.id === mealId) ?? view.mealLogs[mealLogKey(date, mealId)]?.snapshot : undefined
  const exercise = route.startsWith('/scheda/esercizio/') ? workoutDays.flatMap(item => item.exercises).find(item => item.id === route.split('/')[3]) : undefined
  const validRoute = route === '/dieta' || route === '/scheda' || isHistory || isSettings || isSession || isCatalog || isPrograms || isMealPlans || isProgress || Boolean(meal || exercise || historySession)
  const inDetail = Boolean(meal || exercise)
  const showDaily = validRoute && !isHistory && !isSettings && !isSession && !historySession && !isCatalog && !isPrograms && !isMealPlans && !isProgress
  const programWizard = isPrograms && Boolean(programs.state.document) && programMode === 'wizard' && (programStep === 'done' || (fitsWizard(programs.state.document!) && programs.state.base?.version.status !== 'published'))
  const mealWizard = isMealPlans && Boolean(plans.state.editor.draft) && mealMode === 'wizard' && (mealStep === 'done' || fitsMealWizard(plans.state.editor.draft!.document))
  const pendingPreferences = settings.dirty || ['saving', 'checking', 'uncertain', 'conflict'].includes(settings.state.phase)
  const volatile = diary.store.hasVolatileData || !diary.state.storage
  const pendingEditors = pendingPreferences || catalog.pending || programs.pending || plans.pending
  const hasUnsavedData = pendingEditors || volatile || diary.store.hasPending
  const diaryNote = configured ? syncLabels[diary.state.sync] : syncLabels.local
  const editorsBusy = ['saving', 'checking'].includes(catalog.state.phase) || ['saving', 'publishing', 'checking'].includes(programs.state.phase) || ['saving', 'checking'].includes(plans.state.editor.phase)

  // Collegamenti diretti alla creazione guidata dagli stati vuoti di Scheda e Dieta.
  useEffect(() => {
    if (route === '/scheda/programmi/nuovo' && programs.store && programs.state.phase === 'ready') {
      if (!programs.state.document) { setProgramMode('wizard'); setProgramStep('name'); programs.store.create() }
      window.location.replace('#/scheda/programmi')
    }
    if (route === '/scheda/programmi/rinnova' && programs.store && programs.state.phase === 'ready' && workout?.plan.cycle) {
      if (!programs.state.document) {
        setProgramMode('wizard'); setProgramStep('name')
        programs.store.createFrom(workout, { start: mondayOf(today, true), weeks: workout.plan.cycle.weeks })
      }
      window.location.replace('#/scheda/programmi')
    }
    if (route === '/scheda/programmi/modifica' && programs.store && programs.state.phase === 'ready' && !opening.current) {
      // Dalla Scheda: apre direttamente il programma seguito nel wizard (nuova versione se pubblicato).
      const store = programs.store, item = programs.state.index.find(value => value.plan.id === plans.state.selection?.workoutPlanId)
      const latest = item?.versions[0]
      if (programs.state.document || !latest) { window.location.replace('#/scheda/programmi'); return }
      opening.current = true
      void store.open(latest.id).then(() => {
        const opened = store.getSnapshot()
        if (opened.base?.version.status === 'published' && !opened.base.plan.archivedAt) store.fork()
        const document = store.getSnapshot().document
        setProgramMode(document && fitsWizard(document) ? 'wizard' : 'advanced'); setProgramStep('name')
      }).finally(() => { opening.current = false; window.location.replace('#/scheda/programmi') })
    }
    if (route === '/dieta/piani/nuovo' && plans.store && plans.state.phase === 'ready') {
      if (plans.state.editor.phase === 'closed') { setMealMode('wizard'); setMealStep('name'); plans.store.createMealPlan() }
      window.location.replace('#/dieta/piani')
    }
  }, [route, programs.store, programs.state.phase, programs.state.document, programs.state.index, plans.store, plans.state.phase, plans.state.editor.phase, plans.state.selection, workout, today])

  useEffect(() => {
    const updateNetwork = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateNetwork)
    window.addEventListener('offline', updateNetwork)
    return () => { window.removeEventListener('online', updateNetwork); window.removeEventListener('offline', updateNetwork) }
  }, [])

  useEffect(() => {
    document.title = `${isSettings ? 'Impostazioni' : isPrograms ? 'I tuoi programmi' : isProgress ? 'I tuoi progressi' : isCatalog ? 'I tuoi esercizi' : isMealPlans ? 'I tuoi piani alimentari' : section === 'dieta' ? 'Dieta' : 'Scheda'} · peppitness`
    if (!inDetail) { window.scrollTo({ top: 0 }); document.getElementById('main-content')?.focus({ preventScroll: true }) }
  }, [route, section, isSettings, isCatalog, isPrograms, isMealPlans, inDetail])

  useEffect(() => {
    // Il diario sincronizzabile è già sul dispositivo: l'avviso resta per bozze in memoria.
    if (!pendingEditors && !volatile) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [pendingEditors, volatile])

  const followProgram = async (planId: string) => {
    if (!plans.store) return false
    // Stesso programma: si rilegge per usare la nuova versione appena pubblicata.
    await plans.store.load()
    if (plans.store.getSnapshot().phase !== 'ready') return false
    if (plans.store.getSnapshot().selection?.workoutPlanId !== planId) await plans.store.choose({ workoutPlanId: planId })
    return plans.store.getSnapshot().selection?.workoutPlanId === planId && plans.store.getSnapshot().workout?.plan.id === planId
  }
  const updateResult = (session: string) => (exerciseId: string, index: number, result: SetResult) => diary.store.updateSet(session, exerciseId, index, result)
  const start = () => {
    if (activeSession) { navigate('/scheda/seduta'); return }
    if (!day || (configured && (!workout || diary.state.phase !== 'ready'))) return
    if (diary.store.startSession({ date, day, planId: workout?.plan.id ?? 'local', versionId: workout?.version.id ?? 'local', timeZone })) navigate('/scheda/seduta')
  }
  const retryPlans = <button className="button primary" onClick={() => void plans.store?.load()}>Riprova</button>
  const finishedCycle = cycleNow?.status === 'finished' && <section className="cycle-finished"><Icon name="check" size={20} /><div><strong>Ciclo concluso</strong><p>Hai completato {cycleScore?.done ?? 0} sedute su {cycleScore?.planned ?? 0}. Guarda come è andata e prepara il prossimo.</p></div><div className="program-actions"><a className="button secondary" href="#/scheda/progressi">Progressi</a><a className="button primary" href="#/scheda/programmi/rinnova">Crea dal programma concluso</a></div></section>

  const workoutContent = () => {
    if (configured && plans.state.phase === 'loading') return <section className="panel empty-state" role="status"><h2>Caricamento del programma…</h2></section>
    if (configured && plans.state.phase === 'error') return <section className="panel empty-state"><h2>Programma non disponibile</h2><p role="alert">{plans.state.message}</p>{retryPlans}</section>
    if (!day && weekly && workout) return <>
      {finishedCycle}
      {activeSession && <a className="resume-banner" href="#/scheda/seduta"><Icon name="play" /><span><strong>Allenamento in corso</strong><small>{activeSession.day.title} · {formatDate(activeSession.date)}</small></span><span>Riprendi</span><Icon name="arrow" size={18} /></a>}
      <section className="rest-day" aria-labelledby="rest-day-title">
        <span className="rest-day-icon" aria-hidden="true"><Icon name="moon" size={28} /></span>
        <span className="eyebrow">{weekdays[weekdayOfDate(date)]!.name.toUpperCase()}</span>
        <h2 id="rest-day-title">Giorno di riposo</h2>
        <p>Il tuo programma non prevede sedute oggi. Recupera bene.</p>
        <div className="rest-day-options"><span>Vuoi allenarti comunque?</span><div className="wz-chips">{workoutDays.map(item => <button key={item.id} type="button" className="wz-chip" onClick={() => selectDay(item.id)}>{weekdays.find(weekday => weekday.code === item.label)?.name ?? item.label} · {item.title}</button>)}</div></div>
      </section>
    </>
    if (!day) return <section className="panel empty-state plan-empty">
      {followable.length ? <><h2>Scegli il programma da seguire</h2><p>La Scheda mostra la versione corrente del programma scelto. Puoi cambiarlo in qualsiasi momento.</p><div className="plan-choices">{followable.map(item => <button key={item.plan.id} className="button secondary plan-choice" disabled={plans.state.selecting} onClick={() => void plans.store?.choose({ workoutPlanId: item.plan.id })}>{item.plan.name}</button>)}</div></>
        : <><span className="empty-icon"><Icon name="calendar" size={30} /></span><h2>Nessun programma da seguire</h2><p>Imposta la tua settimana: per ogni giorno scegli gli esercizi oppure il riposo.</p><a className="button primary" href="#/scheda/programmi/nuovo">Crea il tuo programma<Icon name="arrow" size={18} /></a></>}
      {activeSession && <a className="button secondary" href="#/scheda/seduta">Riprendi l’allenamento in corso</a>}
    </section>
    return <>
      {finishedCycle}
      {configured && followable.length > 1 && <section className="plan-selectors"><label className="plan-selector">Programma seguito<select value={workout?.plan.id ?? ''} disabled={plans.state.selecting} onChange={event => { setDayId(null); void plans.store?.choose({ workoutPlanId: event.target.value }) }}>{followable.map(item => <option key={item.plan.id} value={item.plan.id}>{item.plan.name}</option>)}</select></label></section>}
      {configured && diary.state.phase === 'loading' && <p className="small muted" role="status">Caricamento del diario…</p>}
      {configured && diary.state.phase === 'error' && <section className="panel"><p role="alert">{diary.state.message}</p><button className="button secondary" onClick={() => void diary.store.refresh()}>Riprova</button></section>}
      <Workout day={day} days={workoutDays} planTitle={workout ? `${workout.plan.name}` : 'Full body'} planGuidance={workout?.version.guidance || undefined} date={date} sessions={view.sessions} onDay={selectDay} editHref={workout ? '#/scheda/programmi/modifica' : undefined} cycleLabel={cycleLabel}
        activeSession={activeSession} suggestedDayId={workoutDays.length > 1 ? suggestion?.id : undefined} suggestedLabel={weekly ? 'Oggi' : 'Suggerita'} weekly={weekly} workoutWeekdays={weekly ? [] : settings.state.saved?.workoutWeekdays} onStart={start} diaryNote={diaryNote} />
    </>
  }

  const dietContent = () => {
    if (configured && plans.state.phase === 'loading') return <section className="panel empty-state" role="status"><h2>Caricamento del piano…</h2></section>
    if (configured && plans.state.phase === 'error') return <section className="panel empty-state"><h2>Piano non disponibile</h2><p role="alert">{plans.state.message}</p>{retryPlans}</section>
    if (configured && !mealPlan) return <section className="panel empty-state plan-empty">
      {followableMeals.length ? <><h2>Scegli il piano alimentare da seguire</h2><div className="plan-choices">{followableMeals.map(plan => <button key={plan.id} className="button secondary plan-choice" disabled={plans.state.selecting} onClick={() => void plans.store?.choose({ mealPlanId: plan.id })}>{plan.name}</button>)}</div></>
        : <><span className="empty-icon"><Icon name="fork" size={30} /></span><h2>Nessun piano alimentare</h2><p>Inserisci i pasti dei giorni di allenamento e di riposo: comparirà qui.</p><a className="button primary" href="#/dieta/piani/nuovo">Crea il tuo piano<Icon name="arrow" size={18} /></a></>}
    </section>
    return <>
      {configured && followableMeals.length > 1 && <section className="plan-selectors"><label className="plan-selector">Piano seguito<select value={mealPlan?.id ?? ''} disabled={plans.state.selecting} onChange={event => void plans.store?.choose({ mealPlanId: event.target.value })}>{followableMeals.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label></section>}
      <Diet date={date} state={view} meals={meals} dayType={dayType} dayTypeHint={!view.dayTypes[date] && programDayType ? `Dalla tua scheda: ${programDayType === 'rest' ? 'giorno di riposo' : 'giorno di allenamento'}.` : undefined} planTitle={mealPlan?.name} planGuidance={mealPlan?.document.guidance || undefined}
        dayOptions={candidateDays.length > 1 ? candidateDays.map(item => item.name) : []} selectedPlanDay={Math.max(0, candidateDays.findIndex(item => item.id === planDay?.id))}
        onPlanDay={index => setPlanDayChoice(current => ({ ...current, [`${date}:${dayType}`]: candidateDays[index]!.id }))} dayNote={planDay?.note || undefined}
        onDayType={type => diary.store.setDayType(date, type)} diaryNote={diaryNote} />
    </>
  }

  return <Layout section={section} hasTimer={Boolean(diary.state.restTimer)} focus={programWizard || mealWizard} session={isSession || Boolean(historySession)}>
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    {!online && <div className="network-notice" role="status"><Icon name="info" size={18} /><span>Rete assente. {configured ? 'Le registrazioni restano sul dispositivo e verranno inviate al ritorno della connessione.' : ''}</span></div>}
    {plans.state.message && showDaily && <p className="small muted plans-message" role="status">{plans.state.message}</p>}
    {configured && (showDaily || isSession) && <SyncStatus store={diary.store} state={diary.state} />}
    {showDaily && <>
      <div className="page-heading"><div><span className="eyebrow">{date === today ? 'OGGI' : 'IL TUO DIARIO'}</span><h1>{section === 'dieta' ? 'La tua dieta' : 'La tua scheda'}<span className="heading-dot">.</span></h1><p>{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</p></div><SectionMenu section={section} full={configured} /></div>
      <DatePicker date={date} onChange={setDate} today={today} />
      {date !== today && <div className="past-notice"><Icon name="calendar" size={17} /><span>Giornata {date < today ? 'passata' : 'futura'} · <strong>{formatDate(date)}</strong></span></div>}
      {section === 'dieta' ? dietContent() : workoutContent()}
    </>}
    {isHistory && <History section={section} state={view} onDate={setDate} />}
    {isCatalog && <Suspense fallback={<p role="status">Apertura del catalogo…</p>}><ExerciseCatalog store={catalog.store} state={catalog.state} /></Suspense>}
    {isPrograms && <Suspense fallback={<p role="status">Apertura dei programmi…</p>}><Programs store={programs.store} state={programs.state} catalog={catalog} mode={programMode} setMode={setProgramMode} step={programStep} setStep={setProgramStep}
      followedPlanId={plans.state.selection?.workoutPlanId ?? null} followedDays={workout?.document.days ?? null} onFollow={followProgram} onDeleted={async () => { await plans.store?.load() }} deletionBlocked={diary.store.hasPending || diary.store.hasVolatileData} today={today} /></Suspense>}
    {isProgress && <Progress workout={workout} days={workoutDays} sessions={programSessions} today={today} />}
    {isMealPlans && <Suspense fallback={<p role="status">Apertura dei piani…</p>}><MealPlans store={plans.store} state={plans.state} mode={mealMode} setMode={setMealMode} step={mealStep} setStep={setMealStep} deletionBlocked={diary.store.hasPending || diary.store.hasVolatileData} /></Suspense>}
    {isSettings && <Settings hasUnsavedData={hasUnsavedData} catalogBusy={editorsBusy} onSignedOut={() => { diary.store.clearDevice(); plans.store?.clearDevice() }} {...settings} />}
    {isSession && (activeSession ? <SessionView key={activeSession.id} session={activeSession} sessions={view.sessions} onChange={updateResult(activeSession.id)} syncLabel={configured ? diaryNote : undefined}
      onDiscard={() => setDiscarding(true)}
      onComplete={() => { diary.store.completeSession(activeSession.id); navigate('/scheda/storico'); setAnnouncement('Allenamento completato.') }} />
      : <section className="panel empty-state"><h1>Nessun allenamento in corso</h1><p>Seleziona una seduta dalla scheda per iniziare.</p><a href="#/scheda" className="button primary">Vai alla scheda</a></section>)}
    {historySession && <SessionView key={historySession.id} session={historySession} sessions={view.sessions} onChange={updateResult(historySession.id)} onComplete={() => undefined} onEndCorrection={() => diary.store.discardIncomplete(historySession.id)} syncLabel={configured ? diaryNote : undefined} />}
    {!validRoute && <section className="panel empty-state"><h1>Questa pagina non è disponibile</h1><a className="button primary" href={`#/${section}`}>Torna al tuo spazio</a></section>}
    {meal && <Modal label={`${meal.name}, ${formatDate(date)}`} onClose={() => navigate('/dieta')}><MealDetail key={`${date}:${meal.id}`} meal={view.mealLogs[mealLogKey(date, meal.id)]?.snapshot ?? meal} log={view.mealLogs[mealLogKey(date, meal.id)]} onClose={() => navigate('/dieta')} onSave={(status, note) => { diary.store.recordMeal(date, mealPlan?.id ?? 'local', meal, status, note, dayType); setAnnouncement(`${meal.name}: registrazione aggiornata.`) }} /></Modal>}
    {exercise && <Modal label={exercise.name} onClose={() => navigate('/scheda')}><ExerciseDetail exercise={exercise} previous={findPreviousExercise(view.sessions, exercise, { id: '', date, startedAt: new Date().toISOString() })} /></Modal>}
    {discarding && activeSession && <Modal label="Annullare l’allenamento?" onClose={() => setDiscarding(false)}><h2>Annullare l’allenamento?</h2><p>La seduta in corso e le serie annotate verranno eliminate. Le sedute completate restano nello storico.</p><div className="program-actions"><button className="button secondary" onClick={() => setDiscarding(false)}>Continua l’allenamento</button><button className="button primary" onClick={() => { diary.store.discardSession(activeSession.id); setDiscarding(false); navigate('/scheda'); setAnnouncement('Allenamento annullato.') }}>Annulla allenamento</button></div></Modal>}
    {diary.state.restTimer && <RestTimer timer={diary.state.restTimer} onChange={diary.store.setRestTimer} />}
    <PwaUpdate busy={Boolean(activeSession) || inDetail || pendingEditors || diary.state.sync === 'sending' || editorsBusy} hasDemoData={pendingEditors || volatile} />
  </Layout>
}
