import { defaultSettings, sameSettings, validateSettings } from '../domain/settings.ts'
import type { SavedSettings, SettingsValues } from '../domain/settings.ts'
import type { SettingsRepository } from './settings-repository.ts'

export interface SettingsState {
  phase: 'loading' | 'ready' | 'saving' | 'error' | 'checking' | 'conflict' | 'uncertain'
  saved: SavedSettings | null
  draft: SettingsValues
  remote: SavedSettings | null
  message: string
}

/** Bozza per account, in memoria; nessuna coda offline o retry di scrittura. */
export class SettingsStore {
  private repository: SettingsRepository
  private state: SettingsState = { phase: 'loading', saved: null, draft: defaultSettings(), remote: null, message: '' }
  private listeners = new Set<() => void>()
  private operation: AbortController | null = null
  constructor(repository: SettingsRepository) { this.repository = repository }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: Partial<SettingsState>) {
    this.state = { ...this.state, ...value }
    this.listeners.forEach(listener => listener())
  }
  stop = () => { this.operation?.abort(); this.operation = null }
  private begin() {
    this.stop()
    const controller = new AbortController()
    this.operation = controller
    return { controller, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) }
  }
  private current(controller: AbortController) { return this.operation === controller && !controller.signal.aborted }
  get dirty() { return !sameSettings(this.state.draft, this.state.saved ?? defaultSettings()) }
  edit = (draft: SettingsValues) => {
    if (!['ready', 'conflict'].includes(this.state.phase)) return
    this.publish({ draft, message: '' })
  }
  load = async () => {
    const { controller, signal } = this.begin()
    this.publish({ phase: 'loading', message: '' })
    try {
      const saved = await this.repository.load(signal)
      if (this.current(controller)) this.publish({ phase: 'ready', saved, draft: saved ?? defaultSettings(), remote: null })
    } catch {
      if (this.current(controller)) this.publish({ phase: 'error', message: 'Non riesco a caricare le preferenze. Controlla la connessione e riprova.' })
    }
  }
  save = async (replaceRemote = false) => {
    if (this.state.phase !== (replaceRemote ? 'conflict' : 'ready')) return
    const validation = validateSettings(this.state.draft)
    if (validation) { this.publish({ message: validation }); return }
    const revision = (replaceRemote ? this.state.remote : this.state.saved)?.revision ?? null
    const draft = structuredClone(this.state.draft)
    const { controller, signal } = this.begin()
    this.publish({ phase: 'saving', message: '' })
    try {
      const saved = await this.repository.save(draft, revision, signal)
      if (this.current(controller)) this.publish({ phase: 'ready', saved, draft: saved, remote: null, message: 'Preferenze salvate online.' })
    } catch {
      // Una risposta persa può seguire un commit riuscito. Prima di ogni nuovo
      // invio serve una rilettura; mai dichiarare fallita o ripetere alla cieca.
      if (this.current(controller)) {
        this.publish({ phase: 'uncertain', message: 'Salvataggio non confermato. Verifica i dati online prima di riprovare; la tua modifica resta in questa pagina.' })
        await this.check()
      }
    }
  }
  check = async () => {
    if (this.state.phase !== 'uncertain') return
    const { controller, signal } = this.begin()
    this.publish({ phase: 'checking' })
    try {
      const remote = await this.repository.load(signal)
      if (!this.current(controller)) return
      if (remote && sameSettings(remote, this.state.draft)) {
        this.publish({ phase: 'ready', saved: remote, draft: remote, remote: null, message: 'Preferenze salvate online: conferma recuperata.' })
      } else {
        this.publish({ phase: 'conflict', remote, message: 'I dati online sono diversi dalla tua modifica. Confrontali e scegli quali conservare.' })
      }
    } catch {
      if (this.current(controller)) this.publish({ phase: 'uncertain', message: 'Non riesco a verificare il salvataggio. La tua modifica resta in questa pagina; riprova quando torna la connessione.' })
    }
  }
  useRemote = () => {
    if (this.state.phase !== 'conflict') return
    const saved = this.state.remote
    this.publish({ phase: 'ready', saved, draft: saved ?? defaultSettings(), remote: null, message: 'Preferenze online caricate.' })
  }
}
