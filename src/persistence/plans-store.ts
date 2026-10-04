import { cleanMealPlanDraft, mealPlanTooLarge, newMealPlan, sameMealPlan, validateMealPlanDraft } from '../domain/meal-plans.ts'
import type { MealPlan, MealPlanDraft } from '../domain/meal-plans.ts'
import type { ProgramIndex, SavedProgram } from '../domain/programs.ts'
import { withCatalogMuscleGroups } from '../domain/programs.ts'
import type { CatalogExercise } from '../domain/exercises.ts'
import type { KeyValueStorage } from './diary-store.ts'
import { PlansFailure } from './plans-repository.ts'
import type { ActiveSelection, PlansRepository } from './plans-repository.ts'
import type { ProgramsRepository } from './programs-repository.ts'

export interface MealEditorState {
  phase: 'closed' | 'editing' | 'saving' | 'checking' | 'uncertain' | 'conflict'
  draft: MealPlanDraft | null; base: MealPlan | null; remote: MealPlan | null; message: string
}
export interface PlansState {
  phase: 'loading' | 'ready' | 'error'
  programs: ProgramIndex[]
  selection: ActiveSelection | null
  /** Versione corrente del programma selezionato, letta per la Scheda quotidiana. */
  workout: SavedProgram | null
  mealPlans: MealPlan[]
  selecting: boolean
  deleting?: boolean
  /** true quando la vista usa la copia salvata sul dispositivo. */
  cached: boolean
  message: string
  editor: MealEditorState
}
interface Cache { version: 1; programs: ProgramIndex[]; selection: ActiveSelection | null; workout: SavedProgram | null; mealPlans: MealPlan[] }

const closedEditor = (): MealEditorState => ({ phase: 'closed', draft: null, base: null, remote: null, message: '' })

/** Piani seguiti dall'account: selezione persistente, programma corrente e piani alimentari. */
export class PlansStore {
  private plans: PlansRepository
  private programs: ProgramsRepository
  private storage: KeyValueStorage
  private key: string
  private state: PlansState
  private listeners = new Set<() => void>()
  private stopped = false
  private loading: AbortController | null = null
  private writing: AbortController | null = null
  private editing: AbortController | null = null

  constructor(plans: PlansRepository, programs: ProgramsRepository, storage: KeyValueStorage, owner: string) {
    this.plans = plans; this.programs = programs; this.storage = storage; this.key = `peppitness:plans:v1:${owner}`
    const cache = this.read()
    this.state = cache ? { phase: 'ready', ...cache, selecting: false, cached: true, message: '', editor: closedEditor() }
      : { phase: 'loading', programs: [], selection: null, workout: null, mealPlans: [], selecting: false, cached: false, message: '', editor: closedEditor() }
  }
  private read(): Omit<Cache, 'version'> | null {
    try { const raw = this.storage.get(this.key); const cache = raw ? JSON.parse(raw) as Cache : null; return cache?.version === 1 ? { programs: cache.programs, selection: cache.selection, workout: cache.workout, mealPlans: cache.mealPlans } : null }
    catch { return null }
  }
  private emit(value: Partial<PlansState>) {
    if (this.stopped) return
    this.state = { ...this.state, ...value }
    if (this.state.phase === 'ready' && !this.state.cached) {
      const { programs, selection, workout, mealPlans } = this.state
      try { this.storage.set(this.key, JSON.stringify({ version: 1, programs, selection, workout, mealPlans } satisfies Cache)) } catch { /* copia offline non disponibile */ }
    }
    this.listeners.forEach(listener => listener())
  }
  private editor(value: Partial<MealEditorState>) { this.emit({ editor: { ...this.state.editor, ...value } }) }
  /** Conserva nella copia offline della scheda i gruppi letti online per questo account. */
  applyCatalogMuscleGroups = (rows: readonly CatalogExercise[]) => {
    const workout = this.state.workout
    if (!workout || this.state.phase !== 'ready' || this.state.cached) return
    const document = withCatalogMuscleGroups(workout.document, rows)
    if (JSON.stringify(document) !== JSON.stringify(workout.document)) this.emit({ workout: { ...workout, document } })
  }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  stop = () => {
    this.stopped = true
    const controllers = [this.loading, this.writing, this.editing]
    this.loading = this.writing = this.editing = null
    controllers.forEach(controller => controller?.abort())
  }
  /** Uscita esplicita: rimuove la copia offline dei piani di questo account. */
  clearDevice = () => { this.stop(); try { this.storage.remove(this.key) } catch { /* archivio non disponibile */ } }
  get mealDirty() {
    const { draft, base } = this.state.editor
    return Boolean(draft && (base ? !sameMealPlan(draft, base) : draft.name || draft.document.guidance || draft.document.days.length))
  }
  get pending() { return this.mealDirty || this.state.selecting || this.state.deleting || ['saving', 'checking', 'uncertain', 'conflict'].includes(this.state.editor.phase) }

  private async workoutFor(selection: ActiveSelection | null, programs: ProgramIndex[], signal: AbortSignal) {
    const plan = programs.find(item => item.plan.id === selection?.workoutPlanId)?.plan
    return plan?.activeVersionId && !plan.archivedAt ? await this.programs.get(plan.activeVersionId, signal) : null
  }

  load = async () => {
    this.stopped = false
    this.loading?.abort()
    const controller = new AbortController(); this.loading = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)])
    if (this.state.phase === 'error') this.emit({ phase: 'loading', message: '' })
    try {
      const programs = await this.programs.list(signal)
      const selection = await this.plans.selection(signal)
      const mealPlans = await this.plans.mealPlans(signal)
      const workout = await this.workoutFor(selection, programs, signal)
      if (this.loading === controller) this.emit({ phase: 'ready', programs, selection, workout, mealPlans, cached: false, message: '' })
    } catch {
      if (this.loading !== controller) return
      this.emit(this.state.phase === 'ready' ? { cached: true, message: 'Non riesco ad aggiornare i piani online: stai usando la copia salvata sul dispositivo.' }
        : { phase: 'error', message: 'Non riesco a caricare i tuoi piani. Controlla la connessione e riprova.' })
    } finally { if (this.loading === controller) this.loading = null }
  }

  /** Cambia il programma o il piano alimentare seguito. Mai automatico. */
  choose = async (value: { workoutPlanId?: string | null; mealPlanId?: string | null }) => {
    if (this.state.phase !== 'ready' || this.state.selecting) return
    const current = this.state.selection
    const next = { workoutPlanId: value.workoutPlanId !== undefined ? value.workoutPlanId : current?.workoutPlanId ?? null, mealPlanId: value.mealPlanId !== undefined ? value.mealPlanId : current?.mealPlanId ?? null }
    this.writing?.abort()
    const controller = new AbortController(); this.writing = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
    this.emit({ selecting: true, message: '' })
    try {
      let selection: ActiveSelection
      try { selection = await this.plans.select(next, current?.revision ?? null, signal) }
      catch (error) {
        // Risposta persa o modifica da un altro dispositivo: si rilegge prima di decidere.
        const remote = await this.plans.selection(signal)
        if (!remote || remote.workoutPlanId !== next.workoutPlanId || remote.mealPlanId !== next.mealPlanId) {
          if (this.writing === controller) this.emit({ selecting: false, selection: remote, workout: await this.workoutFor(remote, this.state.programs, signal),
            message: error instanceof PlansFailure && error.kind === 'invalid' ? 'Questo piano non può essere seguito: deve avere una versione pubblicata e non essere archiviato.' : 'La selezione è cambiata online. Controlla il piano seguito e riprova se necessario.' })
          return
        }
        selection = remote
      }
      const workout = await this.workoutFor(selection, this.state.programs, signal)
      if (this.writing === controller) this.emit({ selecting: false, selection, workout, cached: false, message: 'Selezione salvata.' })
    } catch {
      if (this.writing === controller) this.emit({ selecting: false, message: 'Selezione non confermata. Controlla la connessione e riprova.' })
    }
  }

  // ------------------------------------------------------------------ editor piani alimentari
  createMealPlan = () => { if (this.state.editor.phase === 'closed') this.emit({ editor: { ...closedEditor(), phase: 'editing', draft: newMealPlan() } }) }
  openMealPlan = (id: string) => {
    const plan = this.state.mealPlans.find(item => item.id === id)
    if (plan && this.state.editor.phase === 'closed') this.emit({ editor: { ...closedEditor(), phase: 'editing', draft: { id: plan.id, name: plan.name, document: structuredClone(plan.document) }, base: plan } })
  }
  editMealPlan = (draft: MealPlanDraft) => {
    const { phase, draft: current } = this.state.editor
    if (current && draft.id === current.id && ['editing', 'conflict'].includes(phase)) this.editor({ draft, message: '' })
  }
  closeMealPlan = () => { if (this.state.editor.phase === 'editing') this.emit({ editor: closedEditor() }) }
  private acceptMealPlan(plan: MealPlan, message: string) {
    this.emit({ mealPlans: [...this.state.mealPlans.filter(item => item.id !== plan.id), plan].sort((a, b) => a.name.localeCompare(b.name, 'it') || a.id.localeCompare(b.id)),
      editor: { phase: 'editing', draft: { id: plan.id, name: plan.name, document: structuredClone(plan.document) }, base: plan, remote: null, message } })
  }
  saveMealPlan = async (replace = false) => {
    const { draft, base, remote, phase } = this.state.editor
    if (!draft || phase !== (replace ? 'conflict' : 'editing')) return
    const clean = cleanMealPlanDraft(draft)
    const invalid = validateMealPlanDraft(clean) ?? mealPlanTooLarge(clean.document)
    if (invalid) { this.editor({ message: invalid }); return }
    this.editing?.abort()
    const controller = new AbortController(); this.editing = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
    this.editor({ phase: 'saving', draft: clean, message: '' })
    try {
      const saved = await this.plans.saveMealPlan(clean, (replace ? remote : base)?.revision ?? null, signal)
      if (this.editing === controller) this.acceptMealPlan(saved, 'Piano salvato online.')
    } catch (error) {
      if (this.editing !== controller) return
      if (error instanceof PlansFailure && error.kind === 'invalid') { this.editor({ phase: 'editing', message: 'Il database ha respinto il piano; nessuna modifica applicata. Controlla i campi.' }); return }
      this.editor({ phase: 'uncertain', message: 'Salvataggio non confermato. Il piano resta in questa pagina.' })
      await this.checkMealPlan()
    }
  }
  checkMealPlan = async () => {
    const { draft, base } = this.state.editor
    if (!draft || this.state.editor.phase !== 'uncertain') return
    const controller = new AbortController(); this.editing = controller
    this.editor({ phase: 'checking' })
    try {
      const remote = await this.plans.mealPlan(draft.id, AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
      if (this.editing !== controller) return
      if (remote && sameMealPlan(remote, draft)) this.acceptMealPlan(remote, 'Piano salvato online: conferma recuperata.')
      else if (!remote && !base) this.editor({ phase: 'editing', message: 'Il piano non risulta salvato. Puoi riprovare.' })
      else this.editor({ phase: 'conflict', remote, message: 'La versione online è diversa dalla tua. Confrontale e scegli quale conservare.' })
    } catch { if (this.editing === controller) this.editor({ phase: 'uncertain', message: 'Non riesco a verificare online. Il piano resta in questa pagina; riprova quando torna la connessione.' }) }
  }
  useRemoteMealPlan = () => {
    const { remote, phase } = this.state.editor
    if (phase !== 'conflict') return
    if (remote) this.acceptMealPlan(remote, 'Versione online caricata.')
    else this.emit({ editor: closedEditor() })
  }
  archiveMealPlan = async (id: string, archived: boolean) => {
    const plan = this.state.mealPlans.find(item => item.id === id)
    if (!plan || this.state.editor.phase !== 'closed') return
    try {
      const saved = await this.plans.archiveMealPlan(plan, archived, AbortSignal.timeout(15_000))
      this.emit({ mealPlans: this.state.mealPlans.map(item => item.id === saved.id ? saved : item), message: archived ? 'Piano archiviato.' : 'Piano ripristinato.' })
    } catch { this.emit({ message: 'Operazione non confermata. Aggiorna l’elenco e riprova.' }) }
  }
  deleteMealPlans = async (planId: string | null): Promise<boolean> => {
    if (this.state.phase !== 'ready' || this.state.editor.phase !== 'closed' || this.state.selecting || this.state.deleting) return false
    this.emit({ deleting: true, message: '' })
    try {
      await this.plans.deleteMealPlans(planId, AbortSignal.timeout(15_000))
    } catch { /* Una risposta persa viene verificata rileggendo l'elenco. */ }
    try {
      const mealPlans = await this.plans.mealPlans(AbortSignal.timeout(15_000))
      const selection = await this.plans.selection(AbortSignal.timeout(15_000))
      const removed = planId === null ? mealPlans.length === 0 : !mealPlans.some(plan => plan.id === planId)
      this.emit({ mealPlans, selection, deleting: false, cached: false,
        message: removed ? `${planId === null ? 'Piani eliminati' : 'Piano eliminato'}. I pasti registrati restano nello storico.` : 'Eliminazione non confermata: aggiorna e riprova.' })
      return removed
    } catch {
      this.emit({ deleting: false, message: 'Eliminazione non confermata: controlla la connessione e aggiorna l’elenco.' })
      return false
    }
  }
}
