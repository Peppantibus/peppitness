import { receiptMismatches, validateCommitCommand, type CommitCommand, type ImportReceipt, type WorkoutCommitCommand, type DietCommitCommand } from '../import/contracts/commit.ts'
import { validateNormalizedDocument } from '../import/contracts/normalized-document.ts'
import type { DocumentReader } from '../import/contracts/reader.ts'
import { commandHash } from '../import/mapping/canonical.ts'
import { checkSelectedFile, detectSignature } from '../import/readers/file-checks.ts'
import { createDocxWorkerReader } from '../import/readers/worker-client.ts'
import { buildStructured, isStructuredDraft, parseStructured, type StructuredDraft, type StructuredKind } from '../import/structured/parser.ts'
import { structuredJournal, type StructuredJournal, type StructuredRecord } from '../import/structured/journal.ts'
import { CommitRejected, type ImportsRepository } from './imports-repository.ts'

interface Slot { record: StructuredRecord | null; busy: boolean; problem: string | null; durable: boolean; restored: boolean; refreshFailed: boolean }
const empty = (): Slot => ({ record: null, busy: false, problem: null, durable: false, restored: false, refreshFailed: false })
export class StructuredImportsStore {
  private state = { opening: true, slots: { workout: empty(), diet: empty() } }
  private listeners = new Set<() => void>()
  private journal: StructuredJournal
  private reader: (DocumentReader & { close?: () => void }) | null = null
  private controllers: Partial<Record<StructuredKind, AbortController>> = {}
  private epoch = 0
  private pendingWrites = 0
  private writes: Record<StructuredKind, Promise<void>> = { workout: Promise.resolve(), diet: Promise.resolve() }
  readonly owner: string
  private repository?: ImportsRepository
  private refresh?: (receipt: ImportReceipt, signal: AbortSignal) => Promise<void>
  private createReader: () => DocumentReader & { close?: () => void }
  constructor(owner: string, repository?: ImportsRepository, refresh?: (receipt: ImportReceipt, signal: AbortSignal) => Promise<void>, journal?: StructuredJournal, createReader = () => createDocxWorkerReader() as DocumentReader & { close?: () => void }) {
    this.owner = owner; this.repository = repository; this.refresh = refresh; this.createReader = createReader; this.journal = journal ?? structuredJournal()
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  getSnapshot = () => this.state
  get guards() {
    const slots = Object.values(this.state.slots)
    return { busy: slots.some(s => s.busy), unsaved: this.pendingWrites > 0 || slots.some(s => s.record && !s.record.receipt && (!s.durable || s.busy)), logoutRisk: slots.some(s => s.busy || s.record && !s.record.receipt) }
  }
  private patch(kind: StructuredKind, patch: Partial<Slot>) { this.state = { ...this.state, slots: { ...this.state.slots, [kind]: { ...this.state.slots[kind], ...patch } } }; for (const listener of this.listeners) listener() }
  async start() {
    const epoch = ++this.epoch
    try {
      const records = await this.journal.load(this.owner)
      if (epoch !== this.epoch) return
      for (const record of records) {
        if (!['workout', 'diet'].includes(record.kind)) continue
        if (record.owner !== this.owner || !Number.isSafeInteger(record.revision) || record.revision < 1 || !isStructuredDraft(record.draft) || record.draft.kind !== record.kind || !validateNormalizedDocument(record.draft.document).ok || record.command && !validateCommitCommand(record.kind, record.command).ok) { this.patch(record.kind, { problem: 'Bozza locale non conforme: scegli di nuovo il DOCX originale.' }); continue }
        this.patch(record.kind, { record, durable: true, restored: true })
      }
    } catch { if (epoch === this.epoch) for (const kind of ['workout', 'diet'] as const) this.patch(kind, { problem: 'Archivio locale non disponibile: la lettura è possibile, il salvataggio richiede una bozza persistente.' }) }
    if (epoch !== this.epoch) return
    this.state = { ...this.state, opening: false }; for (const listener of this.listeners) listener()
    await this.resume()
  }
  stop() { this.epoch++; for (const c of Object.values(this.controllers)) c.abort(); this.reader?.close?.(); this.reader = null; for (const kind of ['workout', 'diet'] as const) this.patch(kind, { busy: false }) }
  async clear() { this.stop(); await Promise.allSettled(Object.values(this.writes)); await this.journal.remove(this.owner); for (const kind of ['workout', 'diet'] as const) this.patch(kind, empty()) }
  private async persist(kind: StructuredKind, record: StructuredRecord) {
    const epoch = this.epoch
    this.pendingWrites++; this.patch(kind, {})
    const operation = this.writes[kind].then(async () => {
      if (epoch !== this.epoch) throw new Error('Operazione interrotta.')
      const current = this.state.slots[kind]
      const next = { ...record, revision: (current.record?.revision ?? 0) + 1, updatedAt: Date.now() }
      await this.journal.write(next, current.durable ? current.record?.revision ?? null : null)
      if (epoch !== this.epoch) return
      const latest = this.state.slots[kind].record
      this.patch(kind, { record: latest && latest !== current.record ? { ...latest, revision: next.revision } : next, durable: true })
    })
    this.writes[kind] = operation.catch(() => undefined)
    try { return await operation } finally { this.pendingWrites--; this.patch(kind, {}) }
  }
  async select(kind: StructuredKind, file: File) {
    const slot = this.state.slots[kind]
    if (slot.busy || slot.record?.command && !slot.record.receipt) return
    const controller = new AbortController(); this.controllers[kind] = controller
    const epoch = this.epoch
    this.patch(kind, { busy: true, problem: null })
    try {
      if (!file.name.toLowerCase().endsWith('.docx')) throw new Error('Usa un file .docx conforme al modello scaricabile. PDF, .doc e documenti liberi non sono supportati.')
      checkSelectedFile(file)
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (detectSignature(bytes) === 'pdf') throw new Error('Il file contiene un PDF, anche se si chiama .docx. Compila il modello Word e salvalo come DOCX: PDF non supportato in questo percorso.')
      this.reader ??= this.createReader()
      const { document } = await this.reader.read({ bytes, metadata: { format: 'docx', mediaType: file.type || null }, signal: controller.signal })
      if (epoch !== this.epoch || controller.signal.aborted) return
      const draft = parseStructured(document, kind)
      // Prenotazioni tecniche locali durevoli anche prima della conferma; nessun catalogo scritto.
      buildStructured(draft, { personal: [], shared: [], complete: false })
      const record: StructuredRecord = { owner: this.owner, kind, revision: slot.record?.revision ?? 0, updatedAt: Date.now(), fileName: file.name, draft, command: null, receipt: null }
      try { await this.persist(kind, record) } catch (e) { this.patch(kind, { record, durable: false, problem: (e as Error).message }) }
    } catch (e) { if (epoch === this.epoch && !controller.signal.aborted) this.patch(kind, { problem: (e as Error).message }) }
    finally { if (epoch === this.epoch) this.patch(kind, { busy: false }) }
  }
  async edit(kind: StructuredKind, draft: StructuredDraft) {
    const slot = this.state.slots[kind]
    if (!slot.record || slot.busy || slot.record.command && !slot.record.receipt) return
    const record = { ...slot.record, draft: structuredClone(draft) }
    buildStructured(record.draft, { personal: [], shared: [], complete: false })
    this.patch(kind, { record, problem: null })
    const epoch = this.epoch
    try { await this.persist(kind, record) } catch (e) { if (epoch === this.epoch) this.patch(kind, { durable: false, problem: (e as Error).message }) }
  }
  async remove(kind: StructuredKind) {
    const slot = this.state.slots[kind]
    if (slot.busy || slot.record?.command && !slot.record.receipt) return
    try { await this.writes[kind]; await this.journal.remove(this.owner, kind, slot.durable ? slot.record?.revision : undefined); this.patch(kind, empty()) }
    catch (e) { this.patch(kind, { problem: (e as Error).message }) }
  }
  async reload() { if (this.guards.busy) return; await Promise.allSettled(Object.values(this.writes)); for (const kind of ['workout', 'diet'] as const) this.patch(kind, empty()); await this.start() }
  async resume() { for (const kind of ['workout', 'diet'] as const) if (this.state.slots[kind].record?.command && !this.state.slots[kind].record?.receipt) await this.save(kind) }
  async save(kind: StructuredKind, command?: CommitCommand) {
    let slot = this.state.slots[kind]
    if (slot.busy || !slot.record || !this.repository || slot.record.receipt) return
    const epoch = this.epoch
    const controller = new AbortController(); this.controllers[kind] = controller
    this.patch(kind, { busy: true, problem: null })
    try {
      await this.writes[kind]; slot = this.state.slots[kind]
      const frozen = slot.record!.command ?? command
      if (!frozen || !validateCommitCommand(kind, frozen).ok || frozen.payload.kind !== kind) throw new Error('Correggi i dati prima di salvare.')
      if (!slot.durable) throw new Error('Bozza non persistente. Ricarica la bozza prima di salvare.')
      // Congelamento durevole PRIMA di ogni richiesta; retry/ricarica conservano lo stesso comando.
      if (!slot.record!.command) await this.persist(kind, { ...slot.record!, command: structuredClone(frozen) })
      if (epoch !== this.epoch) return
      const hash = await commandHash(frozen)
      const previous = await this.repository.getReceipt(frozen.requestId, controller.signal)
      const receipt = previous ?? await (frozen.payload.kind === 'workout' ? this.repository.commitWorkout(frozen as WorkoutCommitCommand, controller.signal) : this.repository.commitDiet(frozen as DietCommitCommand, controller.signal))
      if (epoch !== this.epoch) return
      if (receiptMismatches(receipt, frozen, hash).length) throw new Error('Ricevuta incoerente: verifica di nuovo l’esito.')
      await this.persist(kind, { ...this.state.slots[kind].record!, receipt })
      try { if (receipt.resultState === 'committed') await this.refresh?.(receipt, controller.signal) } catch { if (epoch === this.epoch) this.patch(kind, { refreshFailed: true }) }
    } catch (e) {
      if (epoch !== this.epoch) return
      if (e instanceof CommitRejected) {
        const messages = { catalog_conflict: 'Catalogo cambiato: aggiorna il catalogo e controlla le associazioni.', selection_conflict: 'Piano seguito cambiato: ricarica la selezione prima di salvare.', request_conflict: 'Richiesta in conflitto: verifica l’esito prima di continuare.', invalid_command: 'Il server ha rifiutato i dati del piano.', not_available: 'Riferimento del catalogo non disponibile.', analysis_expired: 'Fonte non disponibile.' }
        if (e.reason !== 'request_conflict') {
          try { await this.persist(kind, { ...this.state.slots[kind].record!, command: null }) }
          catch { this.patch(kind, { problem: 'Bozza modificata in un’altra scheda: ricarica per verificare l’esito.', durable: false }); return }
        }
        this.patch(kind, { problem: messages[e.reason] })
      } else this.patch(kind, { problem: `Salvataggio da verificare. ${(e as Error).message} Riprova: uso la stessa richiesta.` })
    } finally { if (epoch === this.epoch) this.patch(kind, { busy: false }) }
  }
}
