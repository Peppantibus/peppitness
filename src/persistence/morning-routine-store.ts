import { isLocalDate } from '../domain/dates.ts'
import { validMorningRoutine } from '../domain/morning-routine.ts'
import type { MorningRoutine } from '../domain/morning-routine.ts'
import { MorningFailure } from './morning-routine-repository.ts'
import type { MorningDay, MorningOperation, MorningRepository, MorningRow } from './morning-routine-repository.ts'
import type { KeyValueStorage } from './diary-store.ts'

interface Archive { version: 1; known: boolean; routine: MorningRow | null; days: Record<string, MorningDay>; queue: MorningOperation[]; acknowledged: string[] }
export interface MorningState {
  known: boolean; routine: MorningRoutine | null; routineRevision: number; days: Record<string, MorningDay>; pending: number; storage: boolean
  sync: 'synced' | 'pending' | 'sending' | 'waiting' | 'conflict'; message: string
}
const keyOf = (op: MorningOperation) => op.kind === 'routine' ? 'routine' : op.date
const empty = (): Archive => ({ version: 1, known: false, routine: null, days: {}, queue: [], acknowledged: [] })
const uuid = (value: unknown) => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
function validArchive(value: unknown): value is Archive {
  if (!value || typeof value !== 'object') return false
  const cache = value as Archive
  const row = (value: MorningRow | MorningDay) => value && Number.isSafeInteger(value.revision) && value.revision > 0 && uuid(value.requestId)
  return cache.version === 1 && typeof cache.known === 'boolean' && (cache.routine === null || row(cache.routine) && validMorningRoutine(cache.routine.document))
    && Boolean(cache.days && typeof cache.days === 'object' && !Array.isArray(cache.days))
    && Object.entries(cache.days).every(([date, day]) => row(day) && day.date === date && isLocalDate(date) && (day.snapshot === null || validMorningRoutine(day.snapshot)))
    && Array.isArray(cache.acknowledged) && cache.acknowledged.every(uuid) && Array.isArray(cache.queue)
    && cache.queue.every(op => op && uuid(op.id) && Number.isSafeInteger(op.revision) && op.revision >= 0
      && (op.kind === 'routine' ? validMorningRoutine(op.document) : op.kind === 'day' && isLocalDate(op.date) && (op.snapshot === null || validMorningRoutine(op.snapshot))))
}
export class MorningRoutineStore {
  readonly storageKey: string
  private archive: Archive = empty()
  private state: MorningState = { known: false, routine: null, routineRevision: 0, days: {}, pending: 0, storage: true, sync: 'synced', message: '' }
  private listeners = new Set<() => void>()
  private controller: AbortController | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = true
  private conflictKey: string | null = null
  private failures = 0
  private repository: MorningRepository | null
  private storage: KeyValueStorage
  constructor(repository: MorningRepository | null, storage: KeyValueStorage, owner: string) {
    this.repository = repository; this.storage = storage
    this.storageKey = `peppitness:morning-routine:v1:${owner}`
    this.mergeDevice()
    if (!repository) this.archive.known = true
    this.publish()
  }
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback) } }
  getSnapshot = () => this.state
  get hasPending() { return this.archive.queue.length > 0 }
  private publish(patch: Partial<MorningState> = {}) {
    let routine = this.archive.routine?.document ?? null
    let routineRevision = this.archive.routine?.revision ?? 0
    const days = { ...this.archive.days }
    for (const operation of this.archive.queue) {
      if (operation.kind === 'routine') { routine = operation.document; routineRevision = operation.revision + 1 }
      else days[operation.date] = { date: operation.date, snapshot: operation.snapshot, revision: operation.revision + 1, requestId: operation.id }
    }
    this.state = { ...this.state, known: this.archive.known, routine, routineRevision, days, pending: this.archive.queue.length, ...patch }
    this.listeners.forEach(callback => callback())
  }
  private mergeDevice() {
    try {
      const raw = this.storage.get(this.storageKey)
      if (!raw) return
      const saved: unknown = JSON.parse(raw)
      if (!validArchive(saved)) throw new Error('Invalid cache')
      this.archive.known ||= saved.known
      if ((saved.routine?.revision ?? 0) > (this.archive.routine?.revision ?? 0)) this.archive.routine = saved.routine
      for (const day of Object.values(saved.days)) if (day.revision > (this.archive.days[day.date]?.revision ?? 0)) this.archive.days[day.date] = day
      this.archive.acknowledged = [...new Set([...saved.acknowledged, ...this.archive.acknowledged])].slice(-500)
      const acknowledged = new Set(this.archive.acknowledged)
      const operations = new Map([...saved.queue, ...this.archive.queue].map(op => [op.id, op]))
      this.archive.queue = [...operations.values()].filter(op => !acknowledged.has(op.id))
    } catch { this.state = { ...this.state, storage: false } }
  }
  private persist() {
    try { this.storage.set(this.storageKey, JSON.stringify(this.archive)); this.state = { ...this.state, storage: true } }
    catch { this.state = { ...this.state, storage: false } }
  }
  private enqueue(operation: { kind: 'routine'; document: MorningRoutine } | { kind: 'day'; date: string; snapshot: MorningRoutine | null }, expectedRevision?: number) {
    if (!this.archive.known || this.stopped) return false
    this.mergeDevice()
    const key = operation.kind === 'routine' ? 'routine' : operation.date
    const revision = key === 'routine' ? this.archive.routine?.revision ?? 0 : this.archive.days[key]?.revision ?? 0
    const queued = this.archive.queue.filter(item => keyOf(item) === key).length
    this.archive.queue.push({ ...operation, id: crypto.randomUUID(), revision: expectedRevision ?? revision + queued })
    this.persist(); this.publish({ sync: this.conflictKey ? 'conflict' : 'pending' }); this.schedule()
    return true
  }
  save = (document: MorningRoutine, expectedRevision?: number) => validMorningRoutine(document) && this.enqueue({ kind: 'routine', document: structuredClone(document) }, expectedRevision)
  complete = (date: string, today: string) => {
    const routine = this.state.routine
    if (!routine || !isLocalDate(date) || date > today || this.state.days[date]?.snapshot) return false
    return this.enqueue({ kind: 'day', date, snapshot: structuredClone(routine) })
  }
  undo = (date: string) => isLocalDate(date) && Boolean(this.state.days[date]?.snapshot) && this.enqueue({ kind: 'day', date, snapshot: null })
  start = () => { this.stopped = false; this.schedule() }
  stop = () => { this.stopped = true; clearTimeout(this.timer); this.controller?.abort(); this.controller = null }
  reloadFromDevice = () => { this.mergeDevice(); this.publish(); this.schedule() }
  private schedule(delay = 0) { if (this.stopped || this.controller || this.conflictKey) return; clearTimeout(this.timer); this.timer = setTimeout(() => void this.synchronize(), delay) }
  retry = () => { this.failures = 0; this.schedule() }
  synchronize = async () => {
    if (this.stopped || this.controller || this.conflictKey) return
    clearTimeout(this.timer); this.mergeDevice()
    if (!this.repository) {
      for (const op of this.archive.queue) this.accept(op, op.kind === 'routine' ? { document: op.document, revision: op.revision + 1, requestId: op.id } : { date: op.date, snapshot: op.snapshot, revision: op.revision + 1, requestId: op.id })
      this.archive.queue = []; this.persist(); this.publish({ sync: 'synced', message: '' }); return
    }
    const controller = new AbortController(); this.controller = controller
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(20000)])
    this.publish({ sync: this.hasPending ? 'sending' : this.state.sync })
    try {
      const remote = await this.repository.load(signal)
      if (this.stopped || controller.signal.aborted) return
      this.archive.known = true; this.archive.routine = remote.routine; this.archive.days = Object.fromEntries(remote.days.map(day => [day.date, day]))
      this.persist(); this.publish({ sync: this.hasPending ? 'sending' : 'synced', message: '' })
      while (this.archive.queue.length) {
        const op = this.archive.queue[0]!
        const row = await this.repository.send(op, signal)
        if (this.stopped || controller.signal.aborted) return
        this.mergeDevice(); this.accept(op, row)
        this.archive.queue = this.archive.queue.filter(item => item.id !== op.id)
        this.persist(); this.publish()
      }
      this.failures = 0; this.publish({ sync: 'synced', message: '' })
    } catch (error) {
      if (this.stopped || controller.signal.aborted) return
      if (error instanceof MorningFailure && ['conflict', 'invalid'].includes(error.kind) && this.archive.queue.length) {
        this.conflictKey = keyOf(this.archive.queue[0]!)
        this.publish({ sync: 'conflict', message: error.kind === 'conflict' ? 'La routine è cambiata su un altro dispositivo. Le tue modifiche sono conservate qui.' : 'Una modifica non è stata accettata. Le tue modifiche sono conservate qui.' })
      } else this.publish({ sync: 'waiting', message: this.hasPending ? 'Routine salvata sul dispositivo. Invio appena torna la connessione.' : 'Non riesco ad aggiornare la routine. Riprova quando torna la connessione.' })
    } finally {
      if (this.controller === controller) this.controller = null
      if (!this.stopped && this.state.sync === 'waiting') this.schedule(Math.min(30000, 1500 * 2 ** Math.min(this.failures++, 5)))
    }
  }
  private accept(op: MorningOperation, row: MorningRow | MorningDay) {
    if (op.kind === 'routine') this.archive.routine = row as MorningRow
    else this.archive.days[op.date] = row as MorningDay
    this.archive.acknowledged = [...new Set([...this.archive.acknowledged, op.id])].slice(-500)
  }
  resolve = async (keepLocal: boolean) => {
    if (!this.conflictKey || !this.repository || this.stopped) return
    const key = this.conflictKey, controller = new AbortController()
    try {
      const remote = await this.repository.load(AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]))
      if (this.stopped) return
      this.mergeDevice(); this.archive.routine = remote.routine; this.archive.days = Object.fromEntries(remote.days.map(day => [day.date, day]))
      let revision = key === 'routine' ? remote.routine?.revision ?? 0 : this.archive.days[key]?.revision ?? 0
      const discarded = this.archive.queue.filter(op => keyOf(op) === key)
      this.archive.queue = this.archive.queue.flatMap(op => keyOf(op) !== key ? [op] : keepLocal ? [{ ...op, id: crypto.randomUUID(), revision: revision++ }] : [])
      this.archive.acknowledged = [...this.archive.acknowledged, ...discarded.map(op => op.id)].slice(-500)
      this.conflictKey = null; this.persist(); this.publish({ sync: this.hasPending ? 'pending' : 'synced', message: '' }); this.schedule()
    } catch { this.publish({ message: 'Connessione non disponibile. Le tue modifiche restano sul dispositivo.' }) }
  }
  clearDevice = () => { this.stop(); this.archive = empty(); try { this.storage.remove(this.storageKey) } catch { /* no further writes after logout */ }; this.publish() }
}
