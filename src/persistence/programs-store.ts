import { copyProgram, forkProgram, newProgram, sameContent, sameCycle, sameProgram, validateProgram } from '../domain/programs.ts'
import type { ProgramCycle, ProgramDocument, ProgramIndex, SavedProgram } from '../domain/programs.ts'
import { ProgramsFailure } from './programs-repository.ts'
import type { ProgramsRepository, RevisionOutcome } from './programs-repository.ts'

export interface ProgramsState {
  phase: 'idle' | 'loading' | 'ready' | 'deleting' | 'error' | 'saving' | 'publishing' | 'checking' | 'uncertain' | 'conflict'
  index: ProgramIndex[]; document: ProgramDocument | null; base: SavedProgram | null
  remote: SavedProgram | null; intent: 'save' | 'publish'; message: string; requestedId: string | null
  /** Inizio e durata scelti nel wizard; salvati sul programma dopo la pubblicazione. */
  cycleDraft: ProgramCycle | null
  renewalFrom: string | null
  /** Modifica del programma pubblicato aperto: si salva con save_workout_revision, senza bozze intermedie. */
  revising: boolean
  revisionFinished: boolean
}

const revisionMessages: Record<Exclude<RevisionOutcome, 'unchanged'>, string> = {
  metadata: 'Nome e ciclo aggiornati.',
  updated: 'Programma aggiornato.',
  created: 'Programma aggiornato. Le sedute già registrate restano legate alla versione precedente, che trovi nella cronologia.',
}
export const initialProgramsState = (): ProgramsState => ({ phase: 'idle', index: [], document: null, base: null, remote: null, intent: 'save', message: '', requestedId: null, cycleDraft: null, renewalFrom: null, revising: false, revisionFinished: false })

export class ProgramsStore {
  private repository: ProgramsRepository
  private state = initialProgramsState()
  private listeners = new Set<() => void>()
  private operation: AbortController | null = null
  /** ID della eventuale nuova versione, riusato nei tentativi successivi dopo una risposta persa. */
  private revisionId: string | null = null
  constructor(repository: ProgramsRepository) { this.repository = repository }
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(value: Partial<ProgramsState>) { this.state = { ...this.state, ...value }; this.listeners.forEach(listener => listener()) }
  stop = () => { this.operation?.abort(); this.operation = null }
  private begin() {
    this.stop(); const controller = new AbortController(); this.operation = controller
    return { controller, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) }
  }
  private current(controller: AbortController) { return this.operation === controller && !controller.signal.aborted }
  get dirty() {
    const { document, base, revising, cycleDraft } = this.state
    // In modifica contano solo differenze reali: contenuto, nome del programma e ciclo.
    if (revising && document && base) return !sameContent(document, base.document) || document.title.trim() !== base.plan.name || !sameCycle(cycleDraft, base.plan.cycle)
    return Boolean(document && (base ? JSON.stringify(document) !== JSON.stringify(base.document) : document.title || document.guidance || document.days.length))
  }
  get pending() { return this.dirty || ['saving', 'publishing', 'checking', 'uncertain', 'conflict', 'deleting'].includes(this.state.phase) }
  get canReplace() {
    return this.state.intent === 'save' && (this.state.remote ? this.state.remote.version.status === 'draft' && !this.state.remote.plan.archivedAt : !this.state.base)
  }
  private remember(saved: SavedProgram) {
    const previous = this.state.index.find(item => item.plan.id === saved.plan.id)
    const item: ProgramIndex = { plan: saved.plan, versions: [...(previous?.versions ?? []).filter(version => version.id !== saved.version.id), saved.version].sort((a, b) => b.number - a.number) }
    return [...this.state.index.filter(value => value.plan.id !== saved.plan.id), item]
  }
  private accept(saved: SavedProgram, message = '') {
    // Aprendo un programma il ciclo parte da quello salvato; dopo un salvataggio resta la scelta in corso.
    const cycleDraft = this.state.document?.planId === saved.plan.id ? this.state.cycleDraft ?? saved.plan.cycle ?? null : saved.plan.cycle ?? null
    this.emit({ phase: 'ready', document: structuredClone(saved.document), base: structuredClone(saved), remote: null, index: this.remember(saved), message, requestedId: null, cycleDraft, revising: false, revisionFinished: false })
  }
  load = async () => {
    if (this.state.document || this.pending) return
    const { controller, signal } = this.begin(); this.emit({ phase: 'loading', message: '', requestedId: null })
    try { const index = await this.repository.list(signal); if (this.current(controller)) this.emit({ phase: 'ready', index }) }
    catch { if (this.current(controller)) this.emit({ phase: 'error', message: 'Non riesco a caricare i programmi. Controlla la connessione e riprova.' }) }
  }
  create = () => {
    if (this.state.phase === 'ready' && !this.state.document) this.emit({ document: newProgram(), base: null, remote: null, message: '', cycleDraft: null, renewalFrom: null, revising: false })
  }
  deletePlans = async (planId: string | null): Promise<boolean> => {
    if (this.state.phase !== 'ready' || this.state.document) return false
    const { controller, signal } = this.begin()
    this.emit({ phase: 'deleting', message: '' })
    try {
      await this.repository.deletePlans(planId, signal)
      const index = await this.repository.list(signal)
      if (!this.current(controller)) return false
      const removed = planId === null ? index.length === 0 : !index.some(item => item.plan.id === planId)
      this.emit({ phase: 'ready', index, message: removed ? `${planId === null ? 'Programmi eliminati' : 'Programma eliminato'}. Le sedute registrate restano nello storico.` : 'Eliminazione non confermata: aggiorna e riprova.' })
      return removed
    } catch {
      if (!this.current(controller)) return false
      try {
        const index = await this.repository.list(AbortSignal.timeout(15_000))
        if (!this.current(controller)) return false
        const removed = planId === null ? index.length === 0 : !index.some(item => item.plan.id === planId)
        this.emit({ phase: 'ready', index, message: removed ? `${planId === null ? 'Programmi eliminati' : 'Programma eliminato'}. Le sedute registrate restano nello storico.` : 'Eliminazione non confermata: controlla la connessione e riprova.' })
        return removed
      } catch { if (this.current(controller)) this.emit({ phase: 'ready', message: 'Eliminazione non confermata: controlla la connessione e aggiorna l’elenco.' }); return false }
    }
  }
  createFrom = (source: SavedProgram, cycle: ProgramCycle) => {
    if (this.state.phase !== 'ready' || this.state.document || this.pending || source.version.status !== 'published') return
    this.emit({ document: copyProgram(source.document), base: null, remote: null, message: '', cycleDraft: cycle, renewalFrom: source.plan.id, revising: false })
  }
  open = async (id: string) => {
    if (this.state.document || this.pending || !['ready', 'error', 'loading'].includes(this.state.phase)) return
    const { controller, signal } = this.begin(); this.emit({ phase: 'loading', requestedId: id, message: '' })
    try {
      const saved = await this.repository.get(id, signal)
      if (!this.current(controller)) return
      if (!saved) throw new Error('Missing version')
      this.accept(saved)
    } catch { if (this.current(controller)) this.emit({ phase: 'error', message: 'Non riesco ad aprire questa versione. Riprova o torna all’elenco.' }) }
  }
  retry = () => this.state.requestedId ? this.open(this.state.requestedId) : this.load()
  edit = (document: ProgramDocument) => {
    if (!this.state.document || (this.state.base?.version.status === 'published' && !this.state.revising) || this.state.base?.plan.archivedAt
      || !['ready', 'conflict'].includes(this.state.phase) || (this.state.phase === 'conflict' && this.state.intent === 'publish')
      || document.id !== this.state.document.id || document.planId !== this.state.document.planId) return
    this.emit({ document, message: '' })
  }
  close = (message = '') => { if (this.state.phase === 'ready') this.emit({ document: null, base: null, remote: null, message, renewalFrom: null, revising: false }) }
  /**
   * Apre in modifica la versione pubblicata caricata, senza duplicarla: stessi ID, nome del programma
   * come titolo e ciclo salvato. Finché nulla cambia la modifica non risulta «da salvare».
   */
  revise = () => {
    const { base, document } = this.state
    if (!base || !document || base.version.status !== 'published' || base.plan.archivedAt || this.state.phase !== 'ready') return
    this.revisionId = null
    this.emit({ revising: true, revisionFinished: false, document: { ...structuredClone(base.document), title: base.plan.name }, cycleDraft: base.plan.cycle ?? null, message: '' })
  }
  /** Salva la modifica: il database decide l'esito in modo atomico. */
  saveRevision = async (): Promise<RevisionOutcome | null> => {
    const { document, base, cycleDraft, revising } = this.state
    if (!revising || !document || !base || this.state.phase !== 'ready') return null
    const invalid = validateProgram(document, true)
    if (invalid) { this.emit({ message: invalid }); return null }
    // Niente da salvare: nessuna chiamata, nessuna scrittura.
    if (!this.dirty) { this.emit({ message: 'Nessuna modifica da salvare.' }); return 'unchanged' }
    this.revisionId ??= crypto.randomUUID()
    const { controller, signal } = this.begin(); this.emit({ phase: 'saving', intent: 'save', message: '' })
    try {
      const result = await this.repository.revise({ base, document: structuredClone(document), cycle: cycleDraft, newVersionId: this.revisionId }, signal)
      if (!this.current(controller)) return null
      if (result.outcome === 'unchanged') { this.emit({ phase: 'ready', message: 'Nessuna modifica da salvare.' }); return 'unchanged' }
      const remote = await this.repository.get(result.versionId, signal)
      if (!this.current(controller)) return null
      if (!remote) throw new ProgramsFailure('unavailable')
      this.revisionId = null
      this.accept(remote, revisionMessages[result.outcome])
      this.emit({ revisionFinished: true })
      return result.outcome
    } catch (error) {
      if (!this.current(controller)) return null
      if (error instanceof ProgramsFailure && error.kind === 'invalid') {
        this.emit({ phase: 'ready', message: 'Il database ha respinto il programma; nessuna modifica applicata. Controlla valori ed esercizi.' })
        return null
      }
      // Conflitto o risposta persa: si rilegge la versione in uso prima di dichiarare l'esito.
      try {
        const remote = await this.activeVersion(base.plan.id)
        if (!this.current(controller)) return null
        if (remote && sameContent(remote.document, document) && remote.plan.name === document.title.trim() && sameCycle(remote.plan.cycle, cycleDraft)) {
          const outcome: RevisionOutcome = remote.version.id === this.revisionId ? 'created'
            : sameContent(remote.document, base.document) ? 'metadata' : 'updated'
          this.revisionId = null
          this.accept(remote, revisionMessages[outcome])
          this.emit({ revisionFinished: true })
          return outcome
        }
        if (remote && (error instanceof ProgramsFailure && error.kind === 'conflict')) {
          this.emit({ phase: 'conflict', intent: 'save', remote, message: 'Il programma è cambiato su un altro dispositivo. Riparti dalla versione online e ripeti la modifica.' })
          return null
        }
      } catch { /* verifica non riuscita: resta la modifica locale */ }
      if (this.current(controller)) this.emit({ phase: 'ready', message: 'Salvataggio non confermato. Controlla la connessione e riprova: le modifiche restano in questa pagina.' })
      return null
    }
  }
  /** Dopo un conflitto in modifica: carica la versione online e riapre la modifica da lì. */
  restartRevision = () => {
    if (this.state.phase !== 'conflict' || !this.state.remote || !this.state.revising) return
    this.accept(this.state.remote)
    this.revise()
  }
  private async activeVersion(planId: string) {
    const index = await this.repository.list(AbortSignal.timeout(15_000))
    const versionId = index.find(item => item.plan.id === planId)?.plan.activeVersionId
    return versionId ? this.repository.get(versionId, AbortSignal.timeout(15_000)) : null
  }
  fork = () => {
    const source = this.state.phase === 'conflict' ? this.state.remote : this.state.base
    if (!source || source.version.status !== 'published' || source.plan.archivedAt || !this.state.document || !['ready', 'conflict'].includes(this.state.phase)) return
    this.emit({ phase: 'ready', document: forkProgram(this.state.document), base: null, remote: null, message: 'Nuova bozza: la versione pubblicata resta invariata.', index: this.remember(source), revising: false })
  }
  private reconcile(remote: SavedProgram | null) {
    const { document, intent } = this.state
    if (remote && document && sameProgram(document, remote.document) && (intent === 'save' || remote.version.status === 'published')) {
      this.accept(remote, remote.version.status === 'published' ? 'Versione pubblicata online.' : 'Bozza salvata online: dati verificati.')
    } else this.emit({ phase: 'conflict', remote, message: 'L’operazione non è confermata. Confronta la tua versione con quella online prima di proseguire.' })
  }
  save = async (replace = false) => {
    const { document, base } = this.state
    if (!document || this.state.phase !== (replace ? 'conflict' : 'ready') || (replace && !this.canReplace)
      || base?.version.status === 'published' || base?.plan.archivedAt) return
    const invalid = validateProgram(document)
    if (invalid) { this.emit({ message: invalid }); return }
    const revision = (replace ? this.state.remote : base)?.version.revision ?? 0
    await this.write('save', signal => this.repository.save(structuredClone(document), revision, signal))
  }
  publish = async () => {
    const { base, document } = this.state
    if (!base || !document || this.state.phase !== 'ready' || this.dirty || base.version.status !== 'draft' || base.plan.archivedAt) return
    const invalid = validateProgram(document, true)
    if (invalid) { this.emit({ message: invalid }); return }
    await this.write('publish', signal => this.repository.publish(base, signal))
  }
  private async write(intent: 'save' | 'publish', send: (signal: AbortSignal) => Promise<void>) {
    const document = this.state.document!
    const { controller, signal } = this.begin(); this.emit({ phase: intent === 'save' ? 'saving' : 'publishing', intent, message: '' })
    try {
      await send(signal)
      if (!this.current(controller)) return
      const remote = await this.repository.get(document.id, signal)
      if (this.current(controller)) this.reconcile(remote)
    } catch (error) {
      if (!this.current(controller)) return
      if (error instanceof ProgramsFailure && error.kind === 'invalid') {
        this.emit({ phase: 'ready', message: 'Il database ha respinto i campi della bozza; nessuna modifica applicata. Controlla valori, etichette e disponibilità degli esercizi.' })
      } else { this.emit({ phase: 'uncertain', message: 'Operazione non confermata. La tua bozza resta in questa pagina.' }); await this.check() }
    }
  }
  /** Rende corrente una versione pubblicata precedente, dopo conferma esplicita. */
  activate = async () => {
    const { base } = this.state
    if (!base || this.state.phase !== 'ready' || base.version.status !== 'published' || base.plan.archivedAt || base.plan.activeVersionId === base.version.id) return
    const { controller, signal } = this.begin(); this.emit({ phase: 'publishing', intent: 'publish', message: '' })
    try {
      await this.repository.activate(base, signal)
      const remote = await this.repository.get(base.version.id, signal)
      if (this.current(controller)) remote ? this.accept(remote, 'Versione ripristinata: è di nuovo quella in uso.') : this.emit({ phase: 'error', message: 'Versione non più disponibile.' })
    } catch {
      if (!this.current(controller)) return
      try {
        const remote = await this.repository.get(base.version.id, AbortSignal.timeout(15_000))
        if (!this.current(controller)) return
        if (remote?.plan.activeVersionId === base.version.id) this.accept(remote, 'Versione ripristinata: è di nuovo quella in uso.')
        else if (remote) this.accept(remote, 'Versione non ripristinata: il programma è cambiato online. Controlla e riprova.')
        else this.emit({ phase: 'error', message: 'Versione non più disponibile.' })
      } catch { if (this.current(controller)) this.emit({ phase: 'ready', message: 'Operazione non confermata. Controlla la connessione e riapri la versione.' }) }
    }
  }
  setCycleDraft = (cycle: ProgramCycle | null) => { if (this.state.document) this.emit({ cycleDraft: cycle }) }
  /** Salva il ciclo scelto sul programma già pubblicato; true se confermato dal server. */
  saveCycle = async (): Promise<boolean> => {
    const { base, cycleDraft } = this.state
    if (!base) return false
    const current = base.plan.cycle ?? null
    if (current?.start === cycleDraft?.start && current?.weeks === cycleDraft?.weeks) return true
    try {
      const plan = await this.repository.setCycle(base.plan, cycleDraft, AbortSignal.timeout(15_000))
      const saved = { ...base, plan }
      this.emit({ base: saved, index: this.remember(saved) })
      return plan.cycle?.start === cycleDraft?.start && plan.cycle?.weeks === cycleDraft?.weeks
    } catch {
      try {
        // Risposta persa: si rilegge prima di dichiarare l'esito.
        const remote = await this.repository.get(base.version.id, AbortSignal.timeout(15_000))
        if (remote) this.emit({ base: remote, index: this.remember(remote) })
        return remote?.plan.cycle?.start === cycleDraft?.start && remote?.plan.cycle?.weeks === cycleDraft?.weeks
      } catch { return false }
    }
  }
  check = async () => {
    if (this.state.phase !== 'uncertain' || !this.state.document) return
    const { controller, signal } = this.begin(); this.emit({ phase: 'checking' })
    try { const remote = await this.repository.get(this.state.document.id, signal); if (this.current(controller)) this.reconcile(remote) }
    catch { if (this.current(controller)) this.emit({ phase: 'uncertain', message: 'Non riesco a verificare online. Conserva aperta questa pagina e riprova quando torna la connessione.' }) }
  }
  useRemote = () => {
    if (this.state.phase !== 'conflict') return
    if (this.state.remote) this.accept(this.state.remote, 'Versione online caricata. Verifica i contenuti prima di salvare o pubblicare.')
    else this.emit({ phase: 'ready', document: null, base: null, remote: null, message: 'Bozza locale scartata.', revising: false })
  }
}
