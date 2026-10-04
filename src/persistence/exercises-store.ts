import { emptyExercise, sameExercise, sameExerciseIdentity, validateExercise } from '../domain/exercises.ts'
import type { CatalogExercise, ExerciseValues } from '../domain/exercises.ts'
import type { ExercisesRepository } from './exercises-repository.ts'

interface ExerciseDraft { id: string; values: ExerciseValues; base: CatalogExercise | null }
export interface ExercisesState {
  phase: 'idle' | 'loading' | 'ready' | 'error' | 'saving' | 'checking' | 'uncertain' | 'conflict'
  rows: CatalogExercise[]
  sharedRows: CatalogExercise[]
  draft: ExerciseDraft | null
  remote: CatalogExercise | null
  message: string
}
export const initialExercisesState = (): ExercisesState => ({ phase: 'idle', rows: [], sharedRows: [], draft: null, remote: null, message: '' })

/** Un solo editor per account, conservato durante la navigazione. Nessuna coda offline. */
export class ExercisesStore {
  private repository: ExercisesRepository
  private state = initialExercisesState()
  private listeners = new Set<() => void>()
  private operation: AbortController | null = null
  private adoption: AbortController | null = null
  constructor(repository: ExercisesRepository) { this.repository = repository }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: Partial<ExercisesState>) { this.state = { ...this.state, ...value }; this.listeners.forEach(listener => listener()) }
  stop = () => { this.operation?.abort(); this.operation = null; this.adoption?.abort(); this.adoption = null }
  private begin() {
    this.stop()
    const controller = new AbortController()
    this.operation = controller
    return { controller, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) }
  }
  private current(controller: AbortController) { return this.operation === controller && !controller.signal.aborted }
  get dirty() { const draft = this.state.draft; return Boolean(draft && !sameExercise(draft.values, draft.base ?? emptyExercise())) }
  get pending() { return this.dirty || Boolean(this.adoption) || ['saving', 'checking', 'uncertain', 'conflict'].includes(this.state.phase) }
  get canReplaceRemote() {
    const { draft, remote } = this.state
    return Boolean(draft && (remote ? sameExerciseIdentity(draft.values, remote) : !draft.base))
  }
  load = async () => {
    if (this.state.draft || ['saving', 'checking', 'uncertain', 'conflict'].includes(this.state.phase)) return
    const { controller, signal } = this.begin()
    this.publish({ phase: 'loading', message: '' })
    try {
      const [rows, sharedRows] = await Promise.all([this.repository.list(signal), this.repository.listShared(signal)])
      if (this.current(controller)) this.publish({ phase: 'ready', rows, sharedRows })
    } catch {
      if (this.current(controller)) this.publish({ phase: 'error', message: 'Non riesco a caricare gli esercizi. Controlla la connessione e riprova.' })
    }
  }
  open = (exercise?: CatalogExercise, asVariant = false) => {
    if (this.state.phase !== 'ready' || this.state.draft) return
    const base = exercise && !asVariant ? structuredClone(exercise) : null
    const values = exercise ? { ...exercise, archivedAt: asVariant ? null : exercise.archivedAt } : emptyExercise()
    this.publish({ draft: { id: base?.id ?? crypto.randomUUID(), base, values }, remote: null, message: '' })
  }
  edit = (values: ExerciseValues) => {
    const draft = this.state.draft
    if (!draft || !['ready', 'conflict'].includes(this.state.phase)) return
    if (draft.base && !sameExerciseIdentity(values, draft.base)) return
    this.publish({ draft: { ...draft, values }, message: '' })
  }
  close = () => {
    // La UI richiede conferma prima di scartare una bozza modificata.
    if (this.state.phase === 'ready') this.publish({ draft: null, remote: null, message: '' })
  }
  private accept(row: CatalogExercise, message: string) {
    this.publish({ phase: 'ready', rows: [...this.state.rows.filter(item => item.id !== row.id), row],
      draft: { id: row.id, base: row, values: row }, remote: null, message })
  }
  save = async (replaceRemote = false) => {
    const { draft } = this.state
    if (!draft || this.state.phase !== (replaceRemote ? 'conflict' : 'ready') || (replaceRemote && !this.canReplaceRemote)) return
    const values = { ...draft.values, name: draft.values.name.trim() }
    const validation = validateExercise(values)
    if (validation) { this.publish({ message: validation }); return }
    const revision = (replaceRemote ? this.state.remote : draft.base)?.revision ?? null
    const { controller, signal } = this.begin()
    this.publish({ phase: 'saving', draft: { ...draft, values }, message: '' })
    try {
      const saved = await this.repository.save(draft.id, values, revision, signal)
      if (this.current(controller)) {
        // Una risposta valida ma diversa non è conferma della nostra modifica.
        if (!sameExercise(saved, values)) throw new Error('Unexpected saved value')
        this.accept(saved, 'Esercizio salvato online.')
      }
    } catch {
      if (this.current(controller)) {
        this.publish({ phase: 'uncertain', message: 'Salvataggio non confermato. La modifica resta in questa pagina.' })
        await this.check()
      }
    }
  }
  check = async () => {
    const { draft } = this.state
    if (this.state.phase !== 'uncertain' || !draft) return
    const { controller, signal } = this.begin()
    this.publish({ phase: 'checking' })
    try {
      const remote = await this.repository.get(draft.id, signal)
      if (!this.current(controller)) return
      if (remote && sameExercise(remote, draft.values)) this.accept(remote, 'Esercizio salvato online: conferma recuperata.')
      else this.publish({ phase: 'conflict', remote, message: 'Il salvataggio non è confermato: confronta la tua modifica con i dati online e scegli come proseguire.' })
    } catch {
      if (this.current(controller)) this.publish({ phase: 'uncertain', message: 'Non riesco a verificare il salvataggio. La modifica resta in questa pagina; verifica online quando torna la connessione.' })
    }
  }
  /**
   * Creazione rapida dal wizard dei programmi, indipendente dalla bozza del catalogo.
   * Dopo una risposta persa si rilegge lo stesso ID: nessun duplicato, nessun salvataggio finto.
   */
  quickCreate = async (values: ExerciseValues): Promise<CatalogExercise | null> => {
    const clean = { ...values, name: values.name.trim(), variant: values.variant.trim(), equipment: values.equipment.trim() }
    if (validateExercise(clean)) return null
    const id = crypto.randomUUID()
    let saved: CatalogExercise | null = null
    try { saved = await this.repository.save(id, clean, null, AbortSignal.timeout(15_000)) }
    catch { try { saved = await this.repository.get(id, AbortSignal.timeout(15_000)) } catch { saved = null } }
    if (!saved || !sameExercise(saved, clean)) return null
    this.publish({ rows: [...this.state.rows.filter(row => row.id !== saved.id), saved] })
    return saved
  }
  /** Il template condiviso entra nel catalogo personale solo quando viene scelto. */
  adoptShared = async (templateId: string): Promise<CatalogExercise | null> => {
    if (this.state.phase !== 'ready' || this.adoption || !this.state.sharedRows.some(row => row.id === templateId)) return null
    const existing = this.state.rows.find(row => row.sourceTemplateId === templateId)
    if (existing) return existing.archivedAt ? null : existing
    const controller = new AbortController()
    this.adoption = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)])
    try {
      let adopted: CatalogExercise | null = null
      try { adopted = await this.repository.adopt(templateId, signal) }
      catch { adopted = (await this.repository.list(signal)).find(row => row.sourceTemplateId === templateId) ?? null }
      if (!adopted || adopted.archivedAt || controller.signal.aborted) return null
      this.publish({ rows: [...this.state.rows.filter(row => row.id !== adopted.id), adopted] })
      return adopted
    } catch { return null }
    finally { if (this.adoption === controller) this.adoption = null }
  }
  useRemote = () => {
    if (this.state.phase !== 'conflict') return
    if (this.state.remote) this.accept(this.state.remote, 'Esercizio online caricato.')
    else this.publish({ phase: 'ready', rows: this.state.rows.filter(row => row.id !== this.state.draft?.id), draft: null, remote: null, message: 'Nessun esercizio online con questo riferimento. Bozza scartata.' })
  }
}
