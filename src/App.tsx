import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { DietToday } from './app/DietToday'
import { navigate, useRoute } from './app/route'
import { useDietToday } from './app/use-diet-today'
import { useEditors } from './app/use-editors'
import { useWorkoutToday } from './app/use-workout-today'
import { WorkoutToday } from './app/WorkoutToday'
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
import { formatDate, localDate } from './domain/dates'
import { mealLogKey } from './domain/diary'
import { fitsMealWizard } from './domain/meal-plans'
import { fitsWizard } from './domain/weekly'
import { findPreviousExercise } from './domain/workout'
import type { Meal, SetResult } from './domain/types'
import type { ImportReceipt } from './import/contracts/index.ts'
import { MealDetail } from './features/Diet'
import { History } from './features/History'
import { Progress } from './features/Progress'
import { SessionSummaryDialog } from './features/SessionSummary'
import { Settings } from './features/Settings'
import { ExerciseDetail, SessionView } from './features/Workout'
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

const pageTitles: [keyof ReturnType<typeof useRoute>, string][] = [
  ['isSettings', 'Impostazioni'], ['isPrograms', 'I tuoi programmi'], ['isProgress', 'I tuoi progressi'], ['isCatalog', 'I tuoi esercizi'], ['isMealPlans', 'I tuoi piani alimentari'],
]

export function App() {
  const page = useRoute()
  const { route, section, isCatalog, isPrograms, isMealPlans, isProgress, isImport, importKind, isHistory, isSettings, isSession } = page
  const settings = useSettings()
  // Il catalogo serve anche alla revisione della scheda importata (scelte esistente/comune/nuovo).
  const catalog = useExercises(route.startsWith('/scheda'))
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
  // Importazione: il motore si carica sulla sua pagina o in Impostazioni (logout).
  const importReview = useImports(isImport || isSettings, onImportSaved)
  const diary = useDiary()
  const configured = Boolean(plans.store)
  const view = diary.state.view
  const timeZone = settings.state.saved?.timeZone ?? 'Europe/Rome'
  const today = localDate(new Date(), timeZone)
  const [selectedDate, selectDate] = useState<string | null>(null)
  const date = selectedDate ?? today
  const setDate = (value: string) => selectDate(value === today ? null : value)
  const workout = plans.state.workout
  const editors = useEditors({ route, programs, plans, workout, today })
  const [online, setOnline] = useState(navigator.onLine)
  const [announcement, setAnnouncement] = useState('')
  const [toast, setToast] = useState<ToastMessage | null>(null)
  const toastId = useRef(0)
  const [discardingSessionId, setDiscardingSessionId] = useState<string | null>(null)
  const [summarySessionId, setSummarySessionId] = useState<string | null>(null)

  // Gruppi muscolari letti online conservati nella copia offline della scheda.
  useEffect(() => {
    if (catalog.state.phase === 'ready') plans.store?.applyCatalogMuscleGroups(catalog.state.rows)
  }, [catalog.state.phase, catalog.state.rows, plans.store, plans.state.workout, plans.state.cached])

  const schedule = useWorkoutToday({ configured, workout, programs: plans.state.programs, catalogRows: catalog.state.rows, sessions: view.sessions, date, today })
  const menu = useDietToday({ configured, mealPlans: plans.state.mealPlans, mealPlanId: plans.state.selection?.mealPlanId, view, date, programDayType: schedule.programDayType })
  const { activeSession } = schedule

  const summarySession = summarySessionId ? view.sessions.find(session => session.id === summarySessionId && session.completedAt) : undefined
  const historySession = page.historySessionId ? view.sessions.find(session => session.id === page.historySessionId && session.completedAt) : undefined
  const meal = page.mealId ? menu.meals.find(item => item.id === page.mealId) ?? view.mealLogs[mealLogKey(date, page.mealId)]?.snapshot : undefined
  const exercise = page.exerciseId ? schedule.workoutDays.flatMap(item => item.exercises).find(item => item.id === page.exerciseId) : undefined
  const validRoute = route === '/dieta' || route === '/scheda' || isHistory || isSettings || isSession || isCatalog || isPrograms || isMealPlans || isProgress || isImport || Boolean(meal || exercise || historySession)
  const inDetail = Boolean(meal || exercise)
  // Pagine secondarie: intestazione propria (← e titolo); su mobile la barra superiore si nasconde.
  const subpage = isHistory || isProgress || isSettings || isCatalog || isPrograms || isMealPlans || isImport
  const showDaily = validRoute && !subpage && !isSession && !historySession
  const programDocument = programs.state.document, mealDraft = plans.state.editor.draft
  const programWizard = isPrograms && Boolean(programDocument) && editors.programMode === 'wizard'
    && (editors.programStep === 'done' || programs.state.revising || (fitsWizard(programDocument!) && programs.state.base?.version.status !== 'published'))
  const mealWizard = isMealPlans && Boolean(mealDraft) && editors.mealMode === 'wizard' && (editors.mealStep === 'done' || fitsMealWizard(mealDraft!.document))

  const pendingPreferences = settings.dirty || ['saving', 'checking', 'uncertain', 'conflict'].includes(settings.state.phase)
  const volatile = diary.store.hasVolatileData || !diary.state.storage
  const pendingEditors = pendingPreferences || catalog.pending || programs.pending || plans.pending
  // Il logout cancella anche le letture d'importazione di questo account: conferma se c'è qualcosa da perdere.
  const hasUnsavedData = pendingEditors || volatile || diary.store.hasPending || importReview.logoutRisk
  const editorsBusy = ['saving', 'checking'].includes(catalog.state.phase) || ['saving', 'publishing', 'checking'].includes(programs.state.phase) || ['saving', 'checking'].includes(plans.state.editor.phase)

  useEffect(() => {
    const updateNetwork = () => setOnline(navigator.onLine)
    window.addEventListener('online', updateNetwork)
    window.addEventListener('offline', updateNetwork)
    return () => { window.removeEventListener('online', updateNetwork); window.removeEventListener('offline', updateNetwork) }
  }, [])

  const pageTitle = isImport ? (importKind === 'diet' ? 'Importa un piano alimentare' : 'Importa una scheda')
    : pageTitles.find(([key]) => page[key])?.[1] ?? (section === 'dieta' ? 'Dieta' : 'Scheda')
  useEffect(() => {
    document.title = `${pageTitle} · peppitness`
    if (!inDetail) { window.scrollTo({ top: 0 }); document.getElementById('main-content')?.focus({ preventScroll: true }) }
  }, [route, pageTitle, inDetail])

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
    const day = schedule.day
    if (!day || (configured && (!workout || diary.state.phase !== 'ready'))) return
    if (diary.store.startSession({ date, day, planId: workout?.plan.id ?? 'local', versionId: workout?.version.id ?? 'local', timeZone })) navigate('/scheda/seduta')
  }
  // Registrazione rapida dalla card: «Seguito» con un tocco, oppure lo toglie; «Annulla» ripristina lo stato precedente.
  const quickFollow = (meal: Meal) => {
    const log = view.mealLogs[mealLogKey(date, meal.id)]
    const previous = { status: log?.status ?? 'unrecorded', note: log?.note ?? '' }
    const next = previous.status === 'followed' ? 'unrecorded' : 'followed'
    const planId = menu.mealPlan?.id ?? 'local', mealDate = date, mealDayType = menu.dayType
    diary.store.recordMeal(mealDate, planId, meal, next, previous.note, mealDayType)
    const message = next === 'followed' ? `${meal.name}: seguito` : `${meal.name}: da registrare`
    setToast({ id: ++toastId.current, message, undo: () => { diary.store.recordMeal(mealDate, planId, meal, previous.status, previous.note, mealDayType); setAnnouncement(`${meal.name}: registrazione ripristinata.`) } })
    setAnnouncement(`${message}. Puoi annullare dall’avviso in basso.`)
  }

  const syncIndicator = <SyncIndicator store={diary.store} state={diary.state} localOnly={!configured} />
  const importContext = {
    online, catalog: { personal: catalog.state.rows, shared: catalog.state.sharedRows, complete: catalog.state.phase === 'ready' }, selection: plans.state.selection,
    selectionKnown: configured && plans.state.phase === 'ready' && !plans.state.cached,
    followedName: importKind === 'workout' ? workout?.plan.name ?? null : menu.mealPlan?.name ?? null,
    onSelectionStale: () => void plans.store?.load(), onCatalogStale: () => void catalog.store?.load(),
  }
  const deletionBlocked = diary.store.hasPending || diary.store.hasVolatileData
  const mealLog = meal ? view.mealLogs[mealLogKey(date, meal.id)] : undefined

  return <Layout userName={settings.state.saved?.displayName} section={isSettings ? null : section} hasTimer={Boolean(diary.state.restTimer)} focus={programWizard || mealWizard} session={isSession || Boolean(historySession)} subpage={subpage}
    status={syncIndicator} sidebarStatus={<SyncIndicator store={diary.store} state={diary.state} localOnly={!configured} withLabel />}>
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    {!online && <div className="network-notice" role="status"><Icon name="info" size={20} /><span>Rete assente. {configured ? 'Le registrazioni restano sul dispositivo e verranno inviate al ritorno della connessione.' : ''}</span></div>}
    {plans.state.message && showDaily && <p className="small muted plans-message" role="status">{plans.state.message}</p>}
    {configured && (showDaily || isSession) && <SyncStatus store={diary.store} state={diary.state} />}
    {showDaily && <>
      <div className="day-header"><h1>{section === 'dieta' ? 'La tua dieta' : 'La tua scheda'}<span className="heading-dot">.</span></h1><SectionMenu section={section} full={configured} current={section === 'scheda' ? workout?.plan.name : menu.mealPlan?.name} /></div>
      <DatePicker date={date} onChange={setDate} today={today} planned={section === 'scheda' ? schedule.trainingDates : []} done={section === 'scheda' ? schedule.sessionDates : menu.mealDates} doneLabel={section === 'scheda' ? 'seduta completata' : 'pasti registrati'} />
      <DateContext date={date} today={today} onToday={() => setDate(today)} />
      {section === 'dieta'
        ? <DietToday configured={configured} plans={plans} diary={diary} menu={menu} date={date} today={today} onQuickFollow={quickFollow} />
        : <WorkoutToday configured={configured} plans={plans} diary={diary} schedule={schedule} date={date} today={today} workoutWeekdays={settings.state.saved?.workoutWeekdays} onStart={start} onDiscard={setDiscardingSessionId} />}
    </>}
    {isHistory && <History section={section} state={view} onDate={setDate} />}
    {isCatalog && <Suspense fallback={<p role="status">Apertura del catalogo…</p>}><ExerciseCatalog store={catalog.store} state={catalog.state} /></Suspense>}
    {isPrograms && <Suspense fallback={<p role="status">Apertura dei programmi…</p>}><Programs store={programs.store} state={programs.state} catalog={catalog} mode={editors.programMode} setMode={editors.setProgramMode} step={editors.programStep} setStep={editors.setProgramStep}
      followedPlanId={plans.state.selection?.workoutPlanId ?? null} followedDays={workout?.document.days ?? null} onFollow={followProgram} onDeleted={async () => { await plans.store?.load() }} deletionBlocked={deletionBlocked} today={today} /></Suspense>}
    {isProgress && <Progress workout={workout} days={schedule.workoutDays} sessions={schedule.programSessions} today={today} />}
    {isMealPlans && <Suspense fallback={<p role="status">Apertura dei piani…</p>}><MealPlans store={plans.store} state={plans.state} mode={editors.mealMode} setMode={editors.setMealMode} step={editors.mealStep} setStep={editors.setMealStep} deletionBlocked={deletionBlocked} /></Suspense>}
    {isImport && <Suspense fallback={<p role="status">Apertura dell’importazione…</p>}><ImportPlan key={importKind} kind={importKind} engine={importReview.engine} loadFailed={importReview.loadFailed} onRetryLoad={importReview.retryLoad} context={importContext} /></Suspense>}
    {isSettings && <Settings backSection={page.lastSection} weeklyProgram={schedule.weekly && Boolean(workout)} hasUnsavedData={hasUnsavedData} catalogBusy={editorsBusy}
      onSignedOut={() => { diary.store.clearDevice(); plans.store?.clearDevice(); void importReview.clearDevice() }} {...settings} />}
    {isSession && (activeSession ? <SessionView key={activeSession.id} session={activeSession} sessions={view.sessions} onChange={updateResult(activeSession.id)} syncSlot={syncIndicator}
      onDiscard={() => { diary.store.discardSession(activeSession.id); navigate('/scheda'); setAnnouncement('Seduta eliminata.') }}
      onComplete={() => { diary.store.completeSession(activeSession.id); navigate('/scheda/storico'); setSummarySessionId(activeSession.id); setAnnouncement('Allenamento completato.') }} />
      : <section className="panel empty-state"><h1>Nessun allenamento in corso</h1><p>Seleziona una seduta dalla scheda per iniziare.</p><a href="#/scheda" className="button primary">Vai alla scheda</a></section>)}
    {historySession && <SessionView key={historySession.id} session={historySession} sessions={view.sessions} onChange={updateResult(historySession.id)} onComplete={() => undefined} onEndCorrection={() => diary.store.discardIncomplete(historySession.id)} syncSlot={syncIndicator} />}
    {!validRoute && <section className="panel empty-state"><h1>Questa pagina non è disponibile</h1><a className="button primary" href={`#/${section}`}>Torna al tuo spazio</a></section>}
    {meal && <Modal label={`${meal.name}, ${formatDate(date)}`} onClose={() => navigate('/dieta')}>
      <MealDetail key={`${date}:${meal.id}`} meal={mealLog?.snapshot ?? meal} log={mealLog} onClose={() => navigate('/dieta')}
        onSave={(status, note) => { diary.store.recordMeal(date, menu.mealPlan?.id ?? 'local', meal, status, note, menu.dayType); setAnnouncement(`${meal.name}: registrazione aggiornata.`) }} />
    </Modal>}
    {exercise && <Modal label={exercise.name} onClose={() => navigate('/scheda')}><ExerciseDetail exercise={exercise} previous={findPreviousExercise(view.sessions, exercise, { id: '', date, startedAt: new Date().toISOString() })} /></Modal>}
    {activeSession && discardingSessionId === activeSession.id && <Modal label="Annullare l’allenamento?" onClose={() => setDiscardingSessionId(null)}>
      <h2>Annullare l’allenamento?</h2>
      <p><strong>{activeSession.day.title}</strong> · {formatDate(activeSession.date)}</p>
      <p>Verranno eliminate questa seduta in corso e le serie annotate. Le sedute completate restano nello storico.</p>
      <div className="program-actions"><button type="button" className="button secondary workout-cancel-keep" onClick={() => setDiscardingSessionId(null)}>Continua l’allenamento</button>
        <button type="button" className="button danger workout-cancel-confirm" onClick={() => { diary.store.discardSession(activeSession.id); setDiscardingSessionId(null); setAnnouncement('Allenamento annullato.') }}>Annulla allenamento</button></div>
    </Modal>}
    {summarySession && <SessionSummaryDialog session={summarySession} sessions={view.sessions} onClose={() => setSummarySessionId(null)} />}
    {diary.state.restTimer && <RestTimer timer={diary.state.restTimer} onChange={diary.store.setRestTimer} />}
    <div className="toast-stack">
      {toast && <Toast key={toast.id} toast={toast} onClose={() => setToast(current => current?.id === toast.id ? null : current)} />}
      <PwaUpdate hidden={isSession || Boolean(historySession)} busy={Boolean(activeSession) || inDetail || pendingEditors || diary.state.sync === 'sending' || editorsBusy || importReview.busy} hasDemoData={pendingEditors || volatile || importReview.unsaved} />
    </div>
  </Layout>
}
