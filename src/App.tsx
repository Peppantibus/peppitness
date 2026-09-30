import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { DateContext, DatePicker } from './components/DatePicker'
import { Icon } from './components/Icon'
import { Layout } from './components/Layout'
import { Modal } from './components/Modal'
import { PwaUpdate } from './components/PwaUpdate'
import { RestTimer } from './components/RestTimer'
import { SectionMenu } from './components/SectionMenu'
import { SyncIndicator, SyncStatus } from './components/SyncStatus'
import { Toast } from './components/Toast'
import type { ToastMessage } from './components/Toast'
import { demoMeals, demoWorkoutDays } from './data/demo'
import { formatDate, localDate, weekDates } from './domain/dates'
import { mealLogKey, suggestedDay, workoutDaysFromProgram } from './domain/diary'
import { daysForType, fitsMealWizard, mealFromPlan } from './domain/meal-plans'
import { dayForDate, fitsWizard, isWeekly, weekdayOfDate, weekdays } from './domain/weekly'
import { adherence, cycleInfo, mondayOf, weeklyProgress } from './domain/progress'
import { Progress } from './features/Progress'
import type { WizardStep } from './features/ProgramWizard'
import type { MealWizardStep } from './features/MealPlanWizard'
import { findPreviousExercise } from './domain/workout'
import type { Meal, SetResult } from './domain/types'
import type { ImportReceipt } from './import/contracts/index.ts'
import { Diet, MealDetail } from './features/Diet'
import { History } from './features/History'
import { Settings } from './features/Settings'
import { ExerciseDetail, SessionView, Workout } from './features/Workout'
import type { CycleSummary } from './features/Workout'
import { useDiary } from './persistence/use-diary'
import { useExercises } from './persistence/use-exercises'
import { useImports } from './persistence/use-imports'
import { usePlans } from './persistence/use-plans'
import { usePrograms } from './persistence/use-programs'
import { useSettings } from './persistence/use-settings'

const Programs = lazy(() => import('./features/ProgramEditor').then(module => ({ default: module.Programs })))
const ExerciseCatalog = lazy(() => import('./features/ExerciseCatalog').then(module => ({ default: module.ExerciseCatalog })))
const MealPlans = lazy(() => import('./features/MealPlans').then(module => ({ default: module.MealPlans })))
const ImportPlan = lazy(() => import('./features/import/ImportPlan').then(module => ({ default: module.ImportPlan })))

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
  const isImport = route === '/scheda/importa' || route === '/dieta/importa'
  const importKind = route === '/dieta/importa' ? 'diet' : 'workout'
  // Il catalogo serve anche alla revisione della scheda importata (scelte esistente/comune/nuovo).
  const catalog = useExercises(isCatalog || isPrograms || route === '/scheda/importa')
  const programs = usePrograms(isPrograms)
  // Rilettura dei piani al ritorno dagli editor verso le pagine quotidiane.
  const plans = usePlans(isCatalog || isPrograms ? 'programs' : isMealPlans ? 'meal-plans' : 'daily')
  // Dopo un'importazione confermata dal server: rilettura di piani, programmi e catalogo. Un errore qui resta
  // distinto dall'esito (il piano è salvato) e si può ripetere dalla pagina d'importazione.
  const plansStore = plans.store, catalogStore = catalog.store, programsStore = programs.store
  const onImportSaved = useCallback(async (receipt: ImportReceipt) => {
    if (!plansStore) return
    await plansStore.load()
    const loaded = plansStore.getSnapshot()
    if (loaded.phase !== 'ready' || loaded.cached) throw new Error('Piani non riletti')
    if (receipt.kind !== 'workout') return
    if (catalogStore) { await catalogStore.load(); if (catalogStore.getSnapshot().phase === 'error') throw new Error('Catalogo non riletto') }
    if (programsStore && programsStore.getSnapshot().phase !== 'idle') { await programsStore.load(); if (programsStore.getSnapshot().phase === 'error') throw new Error('Programmi non riletti') }
  }, [plansStore, catalogStore, programsStore])
  // Importazione: il motore si carica sulla sua pagina o in Impostazioni (logout); lettura e analisi proseguono fuori pagina.
  const importReview = useImports(isImport || route === '/impostazioni', onImportSaved)
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
  const [online, setOnline] = useState(navigator.onLine)
  const [announcement, setAnnouncement] = useState('')
  const [toast, setToast] = useState<ToastMessage | null>(null)
  // Ultima sezione visitata: Impostazioni e pagine non valide riportano lì.
  const lastSection = useRef<'dieta' | 'scheda'>('dieta')
  const section = route.startsWith('/scheda') ? 'scheda' : route.startsWith('/dieta') ? 'dieta' : lastSection.current

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
  const cycleSummary: CycleSummary | undefined = cycleNow ? cycleNow.status === 'upcoming' ? { label: `Inizia il ${formatDate(cycleNow.start, { day: 'numeric', month: 'long' })}`, ratio: 0 }
    : cycleNow.status === 'finished' ? { label: 'Ciclo concluso', ratio: 1 }
    : { label: `Settimana ${cycleNow.week} di ${cycleNow.weeks}`, detail: cycleScore && cycleScore.due > 0 ? `${cycleScore.done} di ${cycleScore.due} sedute fatte` : undefined, ratio: cycleNow.week / cycleNow.weeks } : undefined
  // Giorni con una seduta prevista nella settimana mostrata (solo programmi settimanali).
  const trainingDates = weekly && workout ? weekDates(date).filter(value => dayForDate(workoutDays, value)) : []
  // Giorni della settimana mostrata con qualcosa di registrato: sedute completate o pasti annotati.
  const shownWeek = weekDates(date)
  const sessionDates = shownWeek.filter(value => view.sessions.some(session => session.completedAt && session.date === value))
  const mealDates = shownWeek.filter(value => Object.values(view.mealLogs).some(log => log.date === value && log.status !== 'unrecorded'))

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
  const validRoute = route === '/dieta' || route === '/scheda' || isHistory || isSettings || isSession || isCatalog || isPrograms || isMealPlans || isProgress || isImport || Boolean(meal || exercise || historySession)
  const inDetail = Boolean(meal || exercise)
  const showDaily = validRoute && !isHistory && !isSettings && !isSession && !historySession && !isCatalog && !isPrograms && !isMealPlans && !isProgress && !isImport
  const programWizard = isPrograms && Boolean(programs.state.document) && programMode === 'wizard' && (programStep === 'done' || programs.state.revising || (fitsWizard(programs.state.document!) && programs.state.base?.version.status !== 'published'))
  const mealWizard = isMealPlans && Boolean(plans.state.editor.draft) && mealMode === 'wizard' && (mealStep === 'done' || fitsMealWizard(plans.state.editor.draft!.document))
  const pendingPreferences = settings.dirty || ['saving', 'checking', 'uncertain', 'conflict'].includes(settings.state.phase)
  const volatile = diary.store.hasVolatileData || !diary.state.storage
  const pendingEditors = pendingPreferences || catalog.pending || programs.pending || plans.pending
  // Il logout cancella anche le letture d'importazione di questo account: conferma se c'è qualcosa da perdere.
  const hasUnsavedData = pendingEditors || volatile || diary.store.hasPending || importReview.logoutRisk
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
      // Dalla Scheda: apre la versione in uso; il database decide se aggiornarla o crearne una nuova.
      const store = programs.store, item = programs.state.index.find(value => value.plan.id === plans.state.selection?.workoutPlanId)
      const target = item?.versions.find(version => version.id === item.plan.activeVersionId) ?? item?.versions[0]
      if (programs.state.document || !target) { window.location.replace('#/scheda/programmi'); return }
      opening.current = true
      void store.open(target.id).then(() => {
        const opened = store.getSnapshot()
        const weekly = Boolean(opened.document && fitsWizard(opened.document))
        if (opened.base?.version.status === 'published' && !opened.base.plan.archivedAt) store.revise()
        setProgramMode(weekly ? 'wizard' : 'advanced'); setProgramStep('name')
      }).finally(() => { opening.current = false; window.location.replace('#/scheda/programmi') })
    }
    if (route === '/dieta/piani/nuovo' && plans.store && plans.state.phase === 'ready') {
      if (plans.state.editor.phase === 'closed') { setMealMode('wizard'); setMealStep('name'); plans.store.createMealPlan() }
      window.location.replace('#/dieta/piani')
    }
  }, [route, programs.store, programs.state.phase, programs.state.document, programs.state.index, plans.store, plans.state.phase, plans.state.editor.phase, plans.state.selection, workout, today])

  useEffect(() => {
    if (route.startsWith('/scheda')) lastSection.current = 'scheda'
    else if (route.startsWith('/dieta')) lastSection.current = 'dieta'
  }, [route])

  useEffect(() => {
    const updateNetwork = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateNetwork)
    window.addEventListener('offline', updateNetwork)
    return () => { window.removeEventListener('online', updateNetwork); window.removeEventListener('offline', updateNetwork) }
  }, [])

  useEffect(() => {
    document.title = `${isSettings ? 'Impostazioni' : isImport ? (importKind === 'diet' ? 'Importa un piano alimentare' : 'Importa una scheda') : isPrograms ? 'I tuoi programmi' : isProgress ? 'I tuoi progressi' : isCatalog ? 'I tuoi esercizi' : isMealPlans ? 'I tuoi piani alimentari' : section === 'dieta' ? 'Dieta' : 'Scheda'} · peppitness`
    if (!inDetail) { window.scrollTo({ top: 0 }); document.getElementById('main-content')?.focus({ preventScroll: true }) }
  }, [route, section, isSettings, isCatalog, isPrograms, isMealPlans, isImport, importKind, inDetail])

  useEffect(() => {
    // Il diario sincronizzabile è già sul dispositivo: l'avviso resta per bozze in memoria e letture in corso.
    if (!pendingEditors && !volatile && !importReview.busy && !importReview.unsaved) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [pendingEditors, volatile, importReview.busy, importReview.unsaved])

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
  // Registrazione rapida dalla card: «Seguito» con un tocco, oppure lo toglie; «Annulla» ripristina lo stato precedente.
  const quickFollow = (meal: Meal) => {
    const log = view.mealLogs[mealLogKey(date, meal.id)]
    const previous = { status: log?.status ?? 'unrecorded', note: log?.note ?? '' }
    const next = previous.status === 'followed' ? 'unrecorded' : 'followed'
    const planId = mealPlan?.id ?? 'local', mealDate = date, mealDayType = dayType
    diary.store.recordMeal(mealDate, planId, meal, next, previous.note, mealDayType)
    const message = next === 'followed' ? `${meal.name}: seguito` : `${meal.name}: da registrare`
    setToast({ id: Date.now(), message, undo: () => { diary.store.recordMeal(mealDate, planId, meal, previous.status, previous.note, mealDayType); setAnnouncement(`${meal.name}: registrazione ripristinata.`) } })
    setAnnouncement(`${message}. Puoi annullare dall’avviso in basso.`)
  }
  const retryPlans = <button className="button primary" onClick={() => void plans.store?.load()}>Riprova</button>
  const finishedCycle = cycleNow?.status === 'finished' && <section className="cycle-finished"><Icon name="check" size={20} /><div><strong>Ciclo concluso</strong><p>Hai completato {cycleScore?.done ?? 0} sedute su {cycleScore?.planned ?? 0}. Guarda come è andata e prepara il prossimo.</p></div><div className="program-actions"><a className="button secondary" href="#/scheda/progressi">Progressi</a><a className="button primary" href="#/scheda/programmi/rinnova">Crea dal programma concluso</a></div></section>

  const workoutContent = () => {
    if (configured && plans.state.phase === 'loading') return <section className="panel empty-state" role="status"><h2>Caricamento del programma…</h2></section>
    if (configured && plans.state.phase === 'error') return <section className="panel empty-state"><h2>Programma non disponibile</h2><p role="alert">{plans.state.message}</p>{retryPlans}</section>
    if (!day && weekly && workout) return <>
      {finishedCycle}
      {activeSession && <a className="resume-banner" href="#/scheda/seduta"><Icon name="play" /><span><strong>Allenamento in corso</strong><small>{activeSession.day.title} · {formatDate(activeSession.date)}</small></span><span>Riprendi</span><Icon name="arrow" size={20} /></a>}
      <section className="rest-day" aria-labelledby="rest-day-title">
        <span className="rest-day-icon" aria-hidden="true"><Icon name="moon" size={24} /></span>
        <span className="eyebrow">{weekdays[weekdayOfDate(date)]!.name}</span>
        <h2 id="rest-day-title">Giorno di riposo</h2>
        <p>Il tuo programma non prevede sedute oggi. Recupera bene.</p>
        <div className="rest-day-options"><span>Vuoi allenarti comunque?</span><div className="chip-row">{workoutDays.map(item => <button key={item.id} type="button" className="chip" onClick={() => selectDay(item.id)}>{weekdays.find(weekday => weekday.code === item.label)?.name ?? item.label} · {item.title}</button>)}</div></div>
      </section>
    </>
    if (!day) return <section className="panel empty-state plan-empty">
      {followable.length ? <><h2>Scegli il programma da seguire</h2><p>La Scheda mostra la versione corrente del programma scelto. Puoi cambiarlo in qualsiasi momento.</p><div className="plan-choices">{followable.map(item => <button key={item.plan.id} className="button secondary plan-choice" disabled={plans.state.selecting} onClick={() => void plans.store?.choose({ workoutPlanId: item.plan.id })}>{item.plan.name}</button>)}</div></>
        : <><span className="empty-icon"><Icon name="calendar" size={32} /></span><h2>Nessun programma da seguire</h2><p>Imposta la tua settimana: per ogni giorno scegli gli esercizi oppure il riposo.</p><a className="button primary" href="#/scheda/programmi/nuovo">Crea il tuo programma<Icon name="arrow" size={20} /></a><a className="text-link" href="#/scheda/importa">Oppure importalo da un file Word o PDF</a></>}
      {activeSession && <a className="button secondary" href="#/scheda/seduta">Riprendi l’allenamento in corso</a>}
    </section>
    return <>
      {finishedCycle}
      {configured && followable.length > 1 && <section className="plan-selectors"><label className="plan-selector">Programma seguito<select value={workout?.plan.id ?? ''} disabled={plans.state.selecting} onChange={event => { setDayId(null); void plans.store?.choose({ workoutPlanId: event.target.value }) }}>{followable.map(item => <option key={item.plan.id} value={item.plan.id}>{item.plan.name}</option>)}</select></label></section>}
      {configured && diary.state.phase === 'loading' && <p className="small muted" role="status">Caricamento del diario…</p>}
      {configured && diary.state.phase === 'error' && <section className="panel"><p role="alert">{diary.state.message}</p><button className="button secondary" onClick={() => void diary.store.refresh()}>Riprova</button></section>}
      <Workout day={day} days={workoutDays} planTitle={workout ? `${workout.plan.name}` : 'Full body'} planGuidance={workout?.version.guidance || undefined} date={date} today={today} sessions={view.sessions} onDay={selectDay} cycle={cycleSummary} progressHref={workout ? '#/scheda/progressi' : undefined}
        activeSession={activeSession} suggestedDayId={weekly ? planned?.id : workoutDays.length > 1 ? suggestion?.id : undefined} weekly={weekly} workoutWeekdays={weekly ? [] : settings.state.saved?.workoutWeekdays} onStart={start} />
    </>
  }

  const dietContent = () => {
    if (configured && plans.state.phase === 'loading') return <section className="panel empty-state" role="status"><h2>Caricamento del piano…</h2></section>
    if (configured && plans.state.phase === 'error') return <section className="panel empty-state"><h2>Piano non disponibile</h2><p role="alert">{plans.state.message}</p>{retryPlans}</section>
    if (configured && !mealPlan) return <section className="panel empty-state plan-empty">
      {followableMeals.length ? <><h2>Scegli il piano alimentare da seguire</h2><div className="plan-choices">{followableMeals.map(plan => <button key={plan.id} className="button secondary plan-choice" disabled={plans.state.selecting} onClick={() => void plans.store?.choose({ mealPlanId: plan.id })}>{plan.name}</button>)}</div></>
        : <><span className="empty-icon"><Icon name="fork" size={32} /></span><h2>Nessun piano alimentare</h2><p>Inserisci i pasti dei giorni di allenamento e di riposo: comparirà qui.</p><a className="button primary" href="#/dieta/piani/nuovo">Crea il tuo piano<Icon name="arrow" size={20} /></a><a className="text-link" href="#/dieta/importa">Oppure importalo da un file Word o PDF</a></>}
    </section>
    return <>
      {configured && followableMeals.length > 1 && <section className="plan-selectors"><label className="plan-selector">Piano seguito<select value={mealPlan?.id ?? ''} disabled={plans.state.selecting} onChange={event => void plans.store?.choose({ mealPlanId: event.target.value })}>{followableMeals.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}</select></label></section>}
      <Diet date={date} isToday={date === today} state={view} meals={meals} dayType={dayType} dayTypeHint={!view.dayTypes[date] && programDayType ? `Dalla tua scheda: ${programDayType === 'rest' ? 'giorno di riposo' : 'giorno di allenamento'}. Puoi cambiarlo.` : undefined} planTitle={mealPlan?.name} planGuidance={mealPlan?.document.guidance || undefined}
        dayOptions={candidateDays.length > 1 ? candidateDays.map(item => item.name) : []} selectedPlanDay={Math.max(0, candidateDays.findIndex(item => item.id === planDay?.id))}
        onPlanDay={index => setPlanDayChoice(current => ({ ...current, [`${date}:${dayType}`]: candidateDays[index]!.id }))} dayNote={planDay?.note || undefined}
        onDayType={type => diary.store.setDayType(date, type)} onQuickFollow={quickFollow} />
    </>
  }

  const syncIndicator = <SyncIndicator store={diary.store} state={diary.state} localOnly={!configured} />
  const importCatalog = { personal: catalog.state.rows, shared: catalog.state.sharedRows, complete: catalog.state.phase === 'ready' }
  const importContext = {
    online, catalog: importCatalog, selection: plans.state.selection,
    selectionKnown: configured && plans.state.phase === 'ready' && !plans.state.cached,
    followedName: importKind === 'workout' ? workout?.plan.name ?? null : mealPlan?.name ?? null,
    onSelectionStale: () => void plans.store?.load(), onCatalogStale: () => void catalog.store?.load(),
  }
  // Pagine secondarie: intestazione propria (← e titolo); su mobile la barra superiore si nasconde.
  const subpage = isHistory || isProgress || isSettings || isCatalog || isPrograms || isMealPlans || isImport
  return <Layout section={isSettings ? null : section} hasTimer={Boolean(diary.state.restTimer)} focus={programWizard || mealWizard} session={isSession || Boolean(historySession)} subpage={subpage} status={syncIndicator} sidebarStatus={<SyncIndicator store={diary.store} state={diary.state} localOnly={!configured} withLabel />}>
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    {!online && <div className="network-notice" role="status"><Icon name="info" size={20} /><span>Rete assente. {configured ? 'Le registrazioni restano sul dispositivo e verranno inviate al ritorno della connessione.' : ''}</span></div>}
    {plans.state.message && showDaily && <p className="small muted plans-message" role="status">{plans.state.message}</p>}
    {configured && (showDaily || isSession) && <SyncStatus store={diary.store} state={diary.state} />}
    {showDaily && <>
      <div className="day-header"><h1>{section === 'dieta' ? 'La tua dieta' : 'La tua scheda'}<span className="heading-dot">.</span></h1><SectionMenu section={section} full={configured} extra={section === 'scheda'
        ? [...(configured && workout ? [{ href: '#/scheda/programmi/modifica', icon: 'edit' as const, title: 'Modifica programma', detail: `Esercizi e giorni di «${workout.plan.name}»` }] : []), { href: '#/scheda/importa', icon: 'plus', title: 'Importa una scheda', detail: 'Da un file Word o PDF' }]
        : [{ href: '#/dieta/importa', icon: 'plus', title: 'Importa un piano alimentare', detail: 'Da un file Word o PDF' }]} /></div>
      <DatePicker date={date} onChange={setDate} today={today} planned={section === 'scheda' ? trainingDates : []} done={section === 'scheda' ? sessionDates : mealDates} doneLabel={section === 'scheda' ? 'seduta completata' : 'pasti registrati'} />
      <DateContext date={date} today={today} onToday={() => setDate(today)} />
      {section === 'dieta' ? dietContent() : workoutContent()}
    </>}
    {isHistory && <History section={section} state={view} onDate={setDate} />}
    {isCatalog && <Suspense fallback={<p role="status">Apertura del catalogo…</p>}><ExerciseCatalog store={catalog.store} state={catalog.state} /></Suspense>}
    {isPrograms && <Suspense fallback={<p role="status">Apertura dei programmi…</p>}><Programs store={programs.store} state={programs.state} catalog={catalog} mode={programMode} setMode={setProgramMode} step={programStep} setStep={setProgramStep}
      followedPlanId={plans.state.selection?.workoutPlanId ?? null} followedDays={workout?.document.days ?? null} onFollow={followProgram} onDeleted={async () => { await plans.store?.load() }} deletionBlocked={diary.store.hasPending || diary.store.hasVolatileData} today={today} /></Suspense>}
    {isProgress && <Progress workout={workout} days={workoutDays} sessions={programSessions} today={today} />}
    {isMealPlans && <Suspense fallback={<p role="status">Apertura dei piani…</p>}><MealPlans store={plans.store} state={plans.state} mode={mealMode} setMode={setMealMode} step={mealStep} setStep={setMealStep} deletionBlocked={diary.store.hasPending || diary.store.hasVolatileData} /></Suspense>}
    {isImport && <Suspense fallback={<p role="status">Apertura dell’importazione…</p>}><ImportPlan key={importKind} kind={importKind} store={importReview.store} state={importReview.state} loadFailed={importReview.loadFailed} onRetryLoad={importReview.retryLoad} context={importContext} /></Suspense>}
    {isSettings && <Settings backSection={lastSection.current} weeklyProgram={weekly && Boolean(workout)} hasUnsavedData={hasUnsavedData} catalogBusy={editorsBusy} onSignedOut={() => { diary.store.clearDevice(); plans.store?.clearDevice(); void importReview.clearDevice() }} {...settings} />}
    {isSession && (activeSession ? <SessionView key={activeSession.id} session={activeSession} sessions={view.sessions} onChange={updateResult(activeSession.id)} syncSlot={syncIndicator}
      onDiscard={() => { diary.store.discardSession(activeSession.id); navigate('/scheda'); setAnnouncement('Seduta eliminata.') }}
      onComplete={() => { diary.store.completeSession(activeSession.id); navigate('/scheda/storico'); setAnnouncement('Allenamento completato.') }} />
      : <section className="panel empty-state"><h1>Nessun allenamento in corso</h1><p>Seleziona una seduta dalla scheda per iniziare.</p><a href="#/scheda" className="button primary">Vai alla scheda</a></section>)}
    {historySession && <SessionView key={historySession.id} session={historySession} sessions={view.sessions} onChange={updateResult(historySession.id)} onComplete={() => undefined} onEndCorrection={() => diary.store.discardIncomplete(historySession.id)} syncSlot={syncIndicator} />}
    {!validRoute && <section className="panel empty-state"><h1>Questa pagina non è disponibile</h1><a className="button primary" href={`#/${section}`}>Torna al tuo spazio</a></section>}
    {meal && <Modal label={`${meal.name}, ${formatDate(date)}`} onClose={() => navigate('/dieta')}><MealDetail key={`${date}:${meal.id}`} meal={view.mealLogs[mealLogKey(date, meal.id)]?.snapshot ?? meal} log={view.mealLogs[mealLogKey(date, meal.id)]} onClose={() => navigate('/dieta')} onSave={(status, note) => { diary.store.recordMeal(date, mealPlan?.id ?? 'local', meal, status, note, dayType); setAnnouncement(`${meal.name}: registrazione aggiornata.`) }} /></Modal>}
    {exercise && <Modal label={exercise.name} onClose={() => navigate('/scheda')}><ExerciseDetail exercise={exercise} previous={findPreviousExercise(view.sessions, exercise, { id: '', date, startedAt: new Date().toISOString() })} /></Modal>}
    {diary.state.restTimer && <RestTimer timer={diary.state.restTimer} onChange={diary.store.setRestTimer} />}
    <div className="toast-stack">
      {toast && <Toast key={toast.id} toast={toast} onClose={() => setToast(current => current?.id === toast.id ? null : current)} />}
      <PwaUpdate hidden={isSession || Boolean(historySession)} busy={Boolean(activeSession) || inDetail || pendingEditors || diary.state.sync === 'sending' || editorsBusy || importReview.busy} hasDemoData={pendingEditors || volatile || importReview.unsaved} />
    </div>
  </Layout>
}
