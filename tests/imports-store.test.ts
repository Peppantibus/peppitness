import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { commitFixtureCases } from '../scripts/lib/import-commit-fixtures.mjs'
import {
  defaultSelectionOptions,
  type CommitCommand, type ExtractionKind, type ImportError, type ImportJobResult, type ImportReceipt, type NormalizedDocument, type ReviewDraft,
} from '../src/import/contracts/index.ts'
import { commandHash, contentHash } from '../src/import/mapping/canonical.ts'
import { mapReviewedDiet, type DietMappingIds } from '../src/import/mapping/diet.ts'
import { mapReviewedWorkout, type WorkoutMappingIds } from '../src/import/mapping/workout.ts'
import { applyDecision, setField } from '../src/import/review/decisions.ts'
import { sequentialLocalIds } from '../src/import/review/draft.ts'
import { memoryBackend, ReviewStore, type StoredRecord } from '../src/import/review/local-storage.ts'
import { applyImportEvent, createImportSession, type ImportSession } from '../src/import/review/state.ts'
import { ImportReviewStore } from '../src/persistence/import-review-store.ts'
import { CommitRejected, ImportsFailure, type AnalyzeResult, type DuplicateImport, type ImportsRepository } from '../src/persistence/imports-repository.ts'
import { analysisOutcome, buildCommitCommand, ImportsStore } from '../src/persistence/imports-store.ts'

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
interface FixtureCase { id: string; kind: ExtractionKind; command: CommitCommand; document: NormalizedDocument; extraction: unknown; draft: ReviewDraft; ids: WorkoutMappingIds | DietMappingIds }
const cases = commitFixtureCases() as FixtureCase[]
const byId = (id: string) => cases.find(item => item.id === id)!
const fixture = (path: string) => JSON.parse(readFileSync(new URL(`./fixtures/import/${path}`, import.meta.url), 'utf8'))

let counter = 0
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
const settle = () => new Promise(done => setTimeout(done, 0))
async function waitFor(check: () => boolean, label = 'condizione') {
  for (let attempt = 0; attempt < 500; attempt++) { if (check()) return; await settle() }
  throw new Error(`${label} non raggiunta`)
}

// ---------------------------------------------------------------------------
// Server simulato con le regole di 14/17/18/19/20: una ricevuta per chiave, replay prima di tutto.
// ---------------------------------------------------------------------------

type Hook = (phase: 'before' | 'after', command: CommitCommand) => void | Promise<void>
function fakeServer(owner = OWNER) {
  const jobs = new Map<string, ImportJobResult & { document: NormalizedDocument }>()
  const receipts = new Map<string, { hash: string; content: string; receipt: ImportReceipt }>()
  const state = { selectionRevision: null as number | null, extraction: null as unknown, analyzeCalls: 0, providerCalls: 0, commitCalls: 0, commitHook: null as Hook | null,
    analyzeMode: 'ok' as 'ok' | 'lost_after' | 'lost_before' | 'running' | { error: ImportError; status: number }, running: 0, receiptFailure: 0, requestIds: [] as string[] }
  const jobResult = ({ document: _document, ...job }: ImportJobResult & { document: NormalizedDocument }): ImportJobResult => structuredClone(job)
  const repository: ImportsRepository = {
    ownerId: owner,
    async analyze(request, signal): Promise<AnalyzeResult> {
      signal.throwIfAborted()
      state.analyzeCalls++
      const mode = state.analyzeMode
      if (typeof mode === 'object') return { ok: false, status: mode.status, error: mode.error }
      if (mode === 'lost_before') throw new ImportsFailure('uncertain')
      let job = [...jobs.values()].find(item => item.analysisRequestId === request.analysisRequestId)
      if (!job) {
        state.providerCalls++
        job = { jobId: uuid(), analysisRequestId: request.analysisRequestId, kind: request.kind, status: state.running > 0 ? 'running' : 'ready', extraction: state.running > 0 ? null : structuredClone(state.extraction) as ImportJobResult['extraction'],
          validationIssues: [], usageSummary: { providerCalls: 1, inputTokens: 1, outputTokens: 1, reasoningTokens: null, cached: false, costEstimate: null }, error: null,
          expiresAt: '2026-10-07T10:00:00.000Z', document: structuredClone(request.normalizedDocument) }
        jobs.set(job.jobId, job)
      }
      if (mode === 'lost_after') throw new ImportsFailure('uncertain')
      return { ok: true, job: jobResult(job) }
    },
    async readJob(jobId) { const job = jobs.get(jobId); return job ? jobResult(job) : null },
    async findJob(analysisRequestId) {
      const job = [...jobs.values()].find(item => item.analysisRequestId === analysisRequestId)
      if (job?.status === 'running' && --state.running <= 0) Object.assign(job, { status: 'ready', extraction: structuredClone(state.extraction) })
      return job ? jobResult(job) : null
    },
    async readDraft(jobId) { const job = jobs.get(jobId); return job ? { jobId, document: structuredClone(job.document), expiresAt: job.expiresAt } : null },
    async findCompatibleAnalysis({ kind, sourceHash, readerVersion }) {
      return [...jobs.values()].filter(job => job.kind === kind && job.status === 'ready' && job.document.sourceHash === sourceHash && job.document.readerVersion === readerVersion).map(jobResult)
    },
    async getReceipt(requestId) {
      if (state.receiptFailure > 0) { state.receiptFailure--; throw new ImportsFailure('unavailable') }
      return structuredClone(receipts.get(requestId)?.receipt ?? null)
    },
    async findDuplicate({ kind, contentHash: hash }): Promise<DuplicateImport[]> {
      return [...receipts.values()].filter(item => item.content === hash && item.receipt.kind === kind && item.receipt.resultState === 'committed')
        .map(item => ({ requestId: item.receipt.requestId, planId: item.receipt.planId, versionId: item.receipt.versionId, createdAt: '2026-09-30T10:00:00Z' }))
    },
    commitWorkout: (command, signal) => commit(command, signal),
    commitDiet: (command, signal) => commit(command, signal),
  }
  async function commit(command: CommitCommand, signal: AbortSignal): Promise<ImportReceipt> {
    state.commitCalls++
    state.requestIds.push(command.requestId)
    await state.commitHook?.('before', command)
    signal.throwIfAborted()
    const hash = await commandHash(command)
    const known = receipts.get(command.requestId)
    let receipt: ImportReceipt
    if (known) {
      if (known.hash !== hash) throw new CommitRejected('request_conflict')
      receipt = known.receipt
    } else {
      const { selectionOptions: options } = command
      if (options.follow && options.expectedActiveRevision !== state.selectionRevision) throw new CommitRejected('selection_conflict')
      const planId = command.payload.kind === 'workout' ? command.payload.resolved.planId : command.payload.resolved.plan.id
      if ([...receipts.values()].some(item => item.receipt.planId === planId)) throw new CommitRejected('request_conflict')
      const selection = options.follow ? { revision: (state.selectionRevision ?? 0) + 1, workoutPlanId: command.payload.kind === 'workout' ? planId : null, mealPlanId: command.payload.kind === 'diet' ? planId : null } : null
      if (selection) state.selectionRevision = selection.revision
      receipt = {
        requestId: command.requestId, kind: command.payload.kind, commandHash: hash, contentHash: await contentHash(command.payload), resultState: 'committed', planId,
        versionId: command.payload.kind === 'workout' ? command.payload.resolved.versionId : null,
        exerciseBindings: command.payload.kind === 'workout' ? command.payload.resolved.catalog.map(binding => ({ ref: binding.ref, exerciseId: binding.choice.source === 'existing' ? binding.ref : uuid(),
          resolution: binding.choice.source === 'existing' ? 'existing' as const : binding.choice.source === 'shared' ? 'adopted' as const : 'created' as const })) : [],
        selection,
      }
      receipts.set(command.requestId, { hash, content: receipt.contentHash, receipt })
    }
    await state.commitHook?.('after', command)
    return structuredClone(receipt)
  }
  const deletePlan = (planId: string) => { for (const item of receipts.values()) if (item.receipt.planId === planId) item.receipt = { ...item.receipt, resultState: 'deleted', selection: null } }
  return { repository, state, jobs, receipts, deletePlan }
}

// ---------------------------------------------------------------------------
// Motore 11 + coordinatore 21 su journal in memoria
// ---------------------------------------------------------------------------

/** Documento già letto nel journal (come dopo la lettura dell'11): il motore lo riprende all'avvio. */
async function seedRead(backend: ReturnType<typeof memoryBackend>, kind: ExtractionKind, document: NormalizedDocument, owner = OWNER) {
  const at = new Date().toISOString(), sessionId = uuid()
  const event = (value: object) => ({ ...value, ownerId: owner, sessionId, at }) as never
  let session: ImportSession = createImportSession({ ownerId: owner, sessionId, kind, file: { name: `${kind}.docx`, size: 100, format: 'docx', sourceHash: document.sourceHash }, at })
  session = applyImportEvent(session, event({ type: 'read_started' })).state
  session = applyImportEvent(session, event({ type: 'read_succeeded', document, sourceHash: document.sourceHash })).state
  const saved = await new ReviewStore(backend).save(session)
  assert.ok(saved.ok)
  return sessionId
}

function engineFor(backend: ReturnType<typeof memoryBackend> | null, server: ReturnType<typeof fakeServer>, options: { online?: () => boolean; refresh?: (receipt: ImportReceipt) => Promise<void>; owner?: string } = {}) {
  const engine = new ImportReviewStore(options.owner ?? OWNER, {
    journal: new ReviewStore(backend), newId: uuid, repository: server.repository, localIds: sequentialLocalIds('i'),
    online: options.online, refresh: options.refresh ? receipt => options.refresh!(receipt) : undefined, poll: { intervalMs: 1, maxMs: 50 },
    createReader: () => { throw new Error('nessuna lettura in questi test') },
  })
  engine.start()
  return engine
}
const slot = (engine: ImportReviewStore, kind: ExtractionKind) => engine.getSnapshot().slots[kind]
const session = (engine: ImportReviewStore, kind: ExtractionKind) => slot(engine, kind).session!

/** Dal documento letto alla bozza pronta: analisi, poi le decisioni del caso applicate come edit dell'utente. */
async function reviewed(engine: ImportReviewStore, item: FixtureCase) {
  await waitFor(() => engine.getSnapshot().phase === 'ready' && session(engine, item.kind) !== undefined, 'apertura')
  await engine.imports!.analyze(item.kind)
  assert.equal(session(engine, item.kind).status, 'reviewing')
  let draft = session(engine, item.kind).draft!
  for (const decision of item.draft.decisions) draft = applyDecision(draft, decision)
  await engine.changeDraft(item.kind, draft, item.ids as never)
  return draft
}
const record = (backend: ReturnType<typeof memoryBackend>, sessionId: string) => [...backend.records.values()].find((item: StoredRecord) => item.sessionId === sessionId)!.session as ImportSession

// ---------------------------------------------------------------------------

test('21: il comando dell’app coincide con quello accettato dalle RPC 19/20 (provenienza, target, decisioni)', () => {
  for (const item of cases) {
    const mapping = item.kind === 'workout' ? mapReviewedWorkout(item.document, item.draft as never, item.ids as WorkoutMappingIds) : mapReviewedDiet(item.document, item.draft as never, item.ids as DietMappingIds)
    assert.ok(mapping.ok, item.id)
    const built = buildCommitCommand({ draft: item.draft, mapping: mapping.value, requestId: item.command.requestId, selectionOptions: defaultSelectionOptions })
    assert.deepEqual(built, item.command, item.id)
  }
})

test('21: una conferma = un comando congelato nel journal prima dell’invio, una sola RPC e un solo requestId', async () => {
  for (const id of ['workout-spec-example', 'diet-spec-example']) {
    const item = byId(id), server = fakeServer(), backend = memoryBackend()
    server.state.extraction = item.extraction
    const sessionId = await seedRead(backend, item.kind, item.document)
    const refreshed: string[] = []
    const engine = engineFor(backend, server, { refresh: async receipt => { refreshed.push(receipt.planId) } })
    await reviewed(engine, item)
    const journaled: ImportSession[] = []
    server.state.commitHook = phase => { if (phase === 'before') journaled.push(record(backend, sessionId)) }
    // Doppio click: la seconda conferma è la stessa operazione.
    await Promise.all([engine.imports!.confirm(item.kind, { ids: item.ids as never, selection: defaultSelectionOptions }), engine.imports!.confirm(item.kind, { ids: item.ids as never, selection: defaultSelectionOptions })])
    const done = session(engine, item.kind)
    assert.equal(server.state.commitCalls, 1, `${id}: una sola RPC`)
    assert.equal(done.status, 'saved')
    assert.equal(done.receipt!.requestId, server.state.requestIds[0])
    assert.deepEqual([journaled[0]!.status, journaled[0]!.commit!.sent, journaled[0]!.commit!.command.requestId], ['saving', true, server.state.requestIds[0]], 'comando e requestId durevoli prima dell’invio')
    assert.deepEqual(journaled[0]!.commit!.command.payload, (item.kind === 'workout' ? { ...item.command.payload } : item.command.payload), 'payload = mapping 09/10 della bozza rivista')
    assert.equal(done.receipt!.selection, null, 'segui disattivato per default')
    assert.deepEqual(refreshed, [done.receipt!.planId])
    assert.equal(slot(engine, item.kind).network.refresh, 'done')
    engine.stop()
  }
})

test('21: risposta persa dopo il commit → save_unknown, ricevuta con la stessa chiave, salvato senza copie', async () => {
  const item = byId('workout-spec-example'), server = fakeServer(), backend = memoryBackend()
  server.state.extraction = item.extraction
  await seedRead(backend, item.kind, item.document)
  const engine = engineFor(backend, server)
  await reviewed(engine, item)
  server.state.commitHook = phase => { if (phase === 'after') throw new ImportsFailure('uncertain') }
  await engine.imports!.confirm('workout', { ids: item.ids as never, selection: defaultSelectionOptions })
  assert.equal(session(engine, 'workout').status, 'saved', 'ricevuta letta subito dopo l’esito incerto')
  assert.equal(server.state.commitCalls, 1)
  assert.equal(server.receipts.size, 1)
})

test('21: risposta persa prima del commit → ricevuta assente, niente edit né nuove chiavi; retry = stesso comando; ripresa dopo chiusura', async () => {
  const item = byId('diet-spec-example'), server = fakeServer(), backend = memoryBackend()
  server.state.extraction = item.extraction
  await seedRead(backend, item.kind, item.document)
  const engine = engineFor(backend, server)
  const draft = await reviewed(engine, item)
  server.state.commitHook = phase => { if (phase === 'before') throw new ImportsFailure('uncertain') }
  await engine.imports!.confirm('diet', { ids: item.ids as never, selection: defaultSelectionOptions })
  const unknown = session(engine, 'diet')
  assert.equal(unknown.status, 'save_unknown')
  assert.equal(slot(engine, 'diet').network.problem?.code, 'save_not_found')
  await assert.rejects(engine.changeDraft('diet', draft), /riconciliato/, 'nessuna modifica con un salvataggio incerto')
  await engine.imports!.analyze('diet')
  assert.equal(server.state.analyzeCalls, 1, 'nessuna nuova analisi in stato incerto')

  // Chiusura e riapertura: stesso comando dal journal; la verifica parte da sola e non trova nulla.
  engine.stop()
  server.state.commitHook = null
  server.state.receiptFailure = 1 // lookup temporaneamente indisponibile alla riapertura
  const again = engineFor(backend, server)
  await waitFor(() => again.getSnapshot().phase === 'ready' && slot(again, 'diet').network.activity === null && slot(again, 'diet').network.problem !== null, 'riconciliazione')
  assert.deepEqual([session(again, 'diet').status, slot(again, 'diet').network.problem?.code], ['save_unknown', 'lookup_failed'])
  await again.imports!.retrySave('diet')
  assert.equal(session(again, 'diet').status, 'saved')
  assert.deepEqual(server.state.requestIds, [unknown.commit!.command.requestId, unknown.commit!.command.requestId], 'retry con la stessa chiave')
  assert.equal(server.receipts.size, 1)
})

test('21: stop o logout durante l’invio con commit riuscito: nessun effetto tardivo; alla riapertura la ricevuta chiude l’operazione', async () => {
  const item = byId('workout-spec-example'), server = fakeServer(), backend = memoryBackend()
  server.state.extraction = item.extraction
  await seedRead(backend, item.kind, item.document)
  const engine = engineFor(backend, server)
  await reviewed(engine, item)
  let release!: () => void
  server.state.commitHook = phase => phase === 'after' ? new Promise<void>(resolve => { release = resolve }) : undefined
  const confirming = engine.imports!.confirm('workout', { ids: item.ids as never, selection: defaultSelectionOptions })
  await waitFor(() => server.receipts.size === 1, 'commit sul server')
  engine.stop()
  release()
  await confirming
  assert.equal(session(engine, 'workout').status, 'saving', 'la risposta dopo lo stop non tocca lo stato')
  assert.equal(slot(engine, 'workout').network.activity, null)
  const again = engineFor(backend, server)
  await waitFor(() => again.getSnapshot().slots.workout.session?.status === 'saved', 'riconciliazione alla riapertura')
  assert.equal(server.state.commitCalls, 1)
})

test('21: ricevuta deleted → piano eliminato, nessun nuovo salvataggio né rilettura', async () => {
  const item = byId('workout-spec-example'), server = fakeServer(), backend = memoryBackend()
  server.state.extraction = item.extraction
  await seedRead(backend, item.kind, item.document)
  let refreshes = 0
  const engine = engineFor(backend, server, { refresh: async () => { refreshes++ } })
  await reviewed(engine, item)
  server.state.commitHook = (phase, command) => {
    if (phase === 'after') { server.deletePlan((command.payload as { resolved: { planId: string } }).resolved.planId); throw new ImportsFailure('uncertain') }
  }
  await engine.imports!.confirm('workout', { ids: item.ids as never, selection: defaultSelectionOptions })
  const done = session(engine, 'workout')
  assert.deepEqual([done.status, done.receipt?.resultState, refreshes, server.state.commitCalls], ['saved', 'deleted', 0, 1])
  await engine.imports!.retrySave('workout')
  assert.equal(server.state.commitCalls, 1, 'un vecchio retry non ricrea il piano')
})

test('21: PT409 selezione → rifiuto certo, poi «salva senza seguire» con nuovo comando e nuova chiave', async () => {
  const item = byId('diet-spec-example'), server = fakeServer(), backend = memoryBackend()
  server.state.extraction = item.extraction
  server.state.selectionRevision = 4
  await seedRead(backend, item.kind, item.document)
  const engine = engineFor(backend, server)
  await reviewed(engine, item)
  await engine.imports!.confirm('diet', { ids: item.ids as never, selection: { follow: true, expectedActiveRevision: 3 } })
  const rejected = session(engine, 'diet')
  assert.deepEqual([rejected.status, rejected.commit, slot(engine, 'diet').network.rejection], ['reviewing', null, 'selection_conflict'])
  await engine.imports!.confirm('diet', { ids: item.ids as never, selection: defaultSelectionOptions })
  const saved = session(engine, 'diet')
  assert.equal(saved.status, 'saved')
  assert.equal(server.state.requestIds.length, 2)
  assert.notEqual(server.state.requestIds[0], server.state.requestIds[1], 'nuova operazione solo dopo un rifiuto certo')
  assert.deepEqual([saved.receipt!.selection, server.state.selectionRevision], [null, 4], 'selezione intatta')
  // Segui esplicito con la revisione vista: una sola RPC applica anche la selezione.
  const second = byId('workout-spec-example')
  server.state.extraction = second.extraction
  await seedRead(backend, second.kind, second.document)
  const both = engineFor(backend, server)
  await reviewed(both, second)
  await both.imports!.confirm('workout', { ids: second.ids as never, selection: { follow: true, expectedActiveRevision: 4 } })
  assert.deepEqual(session(both, 'workout').receipt!.selection, { revision: 5, workoutPlanId: (second.ids as WorkoutMappingIds).planId, mealPlanId: null })
})

test('21: rifiuti certi del catalogo e della scadenza tornano in revisione senza scrivere', async () => {
  for (const reason of ['catalog_conflict', 'analysis_expired', 'request_conflict'] as const) {
    const item = byId('workout-spec-example'), server = fakeServer(), backend = memoryBackend()
    server.state.extraction = item.extraction
    await seedRead(backend, item.kind, item.document)
    const engine = engineFor(backend, server)
    await reviewed(engine, item)
    server.state.commitHook = phase => { if (phase === 'before') throw new CommitRejected(reason) }
    await engine.imports!.confirm('workout', { ids: item.ids as never, selection: defaultSelectionOptions })
    assert.deepEqual([session(engine, 'workout').status, slot(engine, 'workout').network.rejection, server.receipts.size], ['reviewing', reason, 0], reason)
    // ID tecnici già usati: la prossima conferma prenota ID nuovi (22).
    if (reason === 'request_conflict') assert.equal(session(engine, 'workout').reservations, null)
  }
})

test('21: importazione identica → duplicato proposto senza invio; copia esplicita con una nuova chiave', async () => {
  const item = byId('diet-spec-example'), server = fakeServer(), backend = memoryBackend()
  server.state.extraction = item.extraction
  await seedRead(backend, item.kind, item.document)
  const engine = engineFor(backend, server)
  await reviewed(engine, item)
  await engine.imports!.confirm('diet', { ids: item.ids as never, selection: defaultSelectionOptions })
  const first = session(engine, 'diet').receipt!
  engine.stop()
  backend.records.clear() // importazione conclusa: la successiva parte da una nuova lettura
  await seedRead(backend, item.kind, item.document)
  const copy = engineFor(backend, server)
  await waitFor(() => copy.getSnapshot().slots.diet.session?.status === 'reading', 'nuova lettura')
  await reviewed(copy, item)
  const ids = { planId: uuid(), items: Object.fromEntries(Object.keys((item.ids as DietMappingIds).items).map(key => [key, uuid()])) }
  await copy.imports!.confirm('diet', { ids, selection: defaultSelectionOptions })
  assert.deepEqual([session(copy, 'diet').status, slot(copy, 'diet').network.duplicates?.map(value => value.planId), server.state.commitCalls], ['ready', [first.planId], 1])
  const frozen = session(copy, 'diet').commit!.command.requestId
  await copy.imports!.confirm('diet', { ids, selection: defaultSelectionOptions, allowDuplicate: true })
  assert.equal(session(copy, 'diet').status, 'saved')
  assert.deepEqual([server.state.commitCalls, server.state.requestIds[1]], [2, frozen], 'copia con la chiave già congelata, diversa dalla prima')
  assert.notEqual(frozen, first.requestId)
})

test('21: due schede sulla stessa bozza — una sola chiave e un solo invio; l’altra ricarica senza inviare', async () => {
  const item = byId('workout-spec-example'), server = fakeServer(), backend = memoryBackend()
  server.state.extraction = item.extraction
  await seedRead(backend, item.kind, item.document)
  const tabA = engineFor(backend, server)
  await reviewed(tabA, item)
  const tabB = engineFor(backend, server)
  await waitFor(() => tabB.getSnapshot().slots.workout.session?.status === 'reviewing', 'seconda scheda')
  await tabA.imports!.confirm('workout', { ids: item.ids as never, selection: defaultSelectionOptions })
  await tabB.imports!.confirm('workout', { ids: item.ids as never, selection: defaultSelectionOptions })
  assert.equal(server.state.commitCalls, 1)
  assert.equal(slot(tabB, 'workout').network.problem?.code, 'journal_conflict')
  await waitFor(() => tabB.getSnapshot().slots.workout.session?.status === 'saved', 'ricarica dal journal')
  assert.equal(session(tabB, 'workout').receipt!.requestId, server.state.requestIds[0])

  // Stesso comando già congelato in entrambe (duplicato in attesa di scelta): invia solo chi scrive per primo `save_started`.
  const copy = fakeServer(), store = memoryBackend()
  copy.state.extraction = item.extraction
  await seedRead(store, item.kind, item.document)
  const first = engineFor(store, copy)
  await reviewed(first, item)
  await first.imports!.confirm('workout', { ids: item.ids as never, selection: defaultSelectionOptions })
  const existing = session(first, 'workout').receipt!
  first.stop()
  store.records.clear()
  await seedRead(store, item.kind, item.document)
  const tab1 = engineFor(store, copy)
  await reviewed(tab1, item)
  const ids = { planId: uuid(), versionId: uuid(), items: Object.fromEntries(Object.keys((item.ids as WorkoutMappingIds).items).map(key => [key, uuid()])), exercises: Object.fromEntries(Object.keys((item.ids as WorkoutMappingIds).exercises).map(key => [key, uuid()])) }
  await tab1.imports!.confirm('workout', { ids, selection: defaultSelectionOptions })
  assert.equal(slot(tab1, 'workout').network.duplicates?.[0]?.planId, existing.planId)
  const tab2 = engineFor(store, copy)
  await waitFor(() => tab2.getSnapshot().slots.workout.session?.commit !== null && tab2.getSnapshot().slots.workout.session?.status === 'ready', 'comando congelato visto dalla seconda scheda')
  await tab1.imports!.confirm('workout', { ids, selection: defaultSelectionOptions, allowDuplicate: true })
  await tab2.imports!.confirm('workout', { ids, selection: defaultSelectionOptions, allowDuplicate: true })
  assert.equal(copy.state.commitCalls, 2, 'originale + una sola copia')
  assert.equal(slot(tab2, 'workout').network.problem?.code, 'journal_conflict')
})

test('21: journal non disponibile → nessun invio non recuperabile; offline → revisione sì, analisi e salvataggio no', async () => {
  const item = byId('diet-spec-example'), server = fakeServer()
  server.state.extraction = item.extraction
  const volatile = engineFor(null, server)
  await waitFor(() => volatile.getSnapshot().phase === 'ready', 'apertura')
  // Senza journal non c'è nulla da riprendere: la sessione arriva dalla lettura (qui simulata dal seed in memoria).
  const backend = memoryBackend()
  await seedRead(backend, item.kind, item.document)
  const engine = new ImportReviewStore(OWNER, { journal: new ReviewStore(backend), newId: uuid, repository: server.repository, localIds: sequentialLocalIds('i'), createReader: () => { throw new Error() } })
  engine.start()
  await reviewed(engine, item)
  const snapshot = session(engine, 'diet')
  // Stesso stato in un motore senza journal: ogni scrittura fallisce.
  const noJournal = new ImportReviewStore(OWNER, { journal: new ReviewStore(null), newId: uuid, repository: server.repository, localIds: sequentialLocalIds('i'), createReader: () => { throw new Error() } })
  ;(noJournal as unknown as { state: { slots: Record<string, unknown> } }).state.slots.diet = { ...slot(engine, 'diet'), session: { ...snapshot, persistence: 'volatile', revision: null } }
  await noJournal.imports!.confirm('diet', { ids: item.ids as never, selection: defaultSelectionOptions })
  assert.deepEqual([server.state.commitCalls, slot(noJournal, 'diet').network.problem?.code], [0, 'journal_unavailable'])

  let online = false
  const offline = engineFor(backend, server, { online: () => online })
  await waitFor(() => offline.getSnapshot().slots.diet.session?.status === 'reviewing', 'ripresa')
  await offline.imports!.confirm('diet', { ids: item.ids as never, selection: defaultSelectionOptions })
  await offline.imports!.analyze('diet')
  assert.deepEqual([server.state.commitCalls, server.state.analyzeCalls, slot(offline, 'diet').network.problem?.code], [0, 1, 'offline'])
  const edited = setField(session(offline, 'diet').draft!, session(offline, 'diet').draft!.current[0]!.localId, 'title', 'Piano rivisto offline', 'user_edit', { decisionId: 'offline-edit' })
  await offline.changeDraft('diet', edited)
  assert.equal(session(offline, 'diet').draft!.decisions.at(-1)!.decisionId, 'offline-edit', 'revisione offline ammessa')
  online = true
  await offline.imports!.confirm('diet', { ids: item.ids as never, selection: defaultSelectionOptions })
  assert.equal(session(offline, 'diet').status, 'saved')
})

test('21: cambio account — risposte tardive ignorate, nessuna cache di rete, repository di un altro account rifiutato', async () => {
  const item = byId('workout-spec-example'), server = fakeServer(), backend = memoryBackend()
  server.state.extraction = item.extraction
  await seedRead(backend, item.kind, item.document)
  const engine = engineFor(backend, server)
  await waitFor(() => engine.getSnapshot().phase === 'ready', 'apertura')
  await engine.imports!.lookupCompatible('workout')
  let release!: () => void
  const original = server.repository.analyze
  server.repository.analyze = async (request, signal) => { await new Promise<void>(resolve => { release = resolve }); return original(request, signal) }
  const analyzing = engine.imports!.analyze('workout')
  await waitFor(() => typeof release === 'function', 'richiesta inviata')
  engine.stop() // smontaggio di App al cambio account
  release()
  await analyzing
  assert.equal(session(engine, 'workout').status, 'analyzing', 'risultato dopo lo stop ignorato')
  assert.deepEqual(slot(engine, 'workout').network, { activity: null, problem: null, compatible: null, duplicates: null, rejection: null, refresh: 'idle' })
  const other = engineFor(backend, fakeServer(OTHER), { owner: OTHER })
  await waitFor(() => other.getSnapshot().phase === 'ready', 'altro account')
  assert.equal(other.getSnapshot().slots.workout.session, null)
  assert.equal([...backend.records.values()].filter(value => value.ownerId === OWNER).length, 0, 'dati privati del precedente account rimossi dal dispositivo')
  assert.throws(() => new ImportsStore({ ownerId: OWNER } as never, fakeServer(OTHER).repository), /account diversi/)
})

test('21: analisi — risposta persa recuperata per chiave, mai una seconda chiamata; stessa richiesta dopo perdita prima dell’arrivo', async () => {
  const item = byId('workout-spec-example'), server = fakeServer(), backend = memoryBackend()
  server.state.extraction = item.extraction
  await seedRead(backend, item.kind, item.document)
  const engine = engineFor(backend, server)
  await waitFor(() => engine.getSnapshot().phase === 'ready', 'apertura')
  server.state.analyzeMode = 'lost_after'
  await engine.imports!.analyze('workout')
  assert.deepEqual([session(engine, 'workout').status, server.state.analyzeCalls, server.state.providerCalls], ['reviewing', 1, 1])

  // Perdita prima dell'arrivo: nessun job; la ripresa usa la stessa chiave e il server esegue una sola analisi.
  const lost = fakeServer(), store = memoryBackend()
  lost.state.extraction = item.extraction
  await seedRead(store, item.kind, item.document)
  const other = engineFor(store, lost)
  await waitFor(() => other.getSnapshot().phase === 'ready', 'apertura')
  lost.state.analyzeMode = 'lost_before'
  await other.imports!.analyze('workout')
  const failed = session(other, 'workout')
  assert.deepEqual([failed.status, failed.error?.code, lost.state.providerCalls], ['failed', 'internal', 0])
  lost.state.analyzeMode = 'ok'
  await other.imports!.resumeAnalysis('workout')
  assert.deepEqual([session(other, 'workout').status, session(other, 'workout').analysisRequestId, lost.state.providerCalls], ['reviewing', failed.analysisRequestId, 1])

  // Job ancora in corso: letture per chiave finché la pagina è aperta, poi esito.
  const slow = fakeServer(), third = memoryBackend()
  slow.state.extraction = item.extraction
  slow.state.running = 3
  await seedRead(third, item.kind, item.document)
  const waiting = engineFor(third, slow)
  await waitFor(() => waiting.getSnapshot().phase === 'ready', 'apertura')
  await waiting.imports!.analyze('workout')
  assert.deepEqual([session(waiting, 'workout').status, slow.state.analyzeCalls], ['reviewing', 1])
})

test('21: analisi interrotta dalla chiusura → ripresa per chiave; errori budget/dominio distinti; analisi compatibile riaperta senza costi', async () => {
  const item = byId('workout-spec-example'), server = fakeServer(), backend = memoryBackend()
  server.state.extraction = item.extraction
  await seedRead(backend, item.kind, item.document)
  const engine = engineFor(backend, server)
  await waitFor(() => engine.getSnapshot().phase === 'ready', 'apertura')
  let release!: () => void
  const original = server.repository.analyze
  server.repository.analyze = async (request, signal) => { const result = await original(request, signal); await new Promise<void>(resolve => { release = resolve }); return result }
  void engine.imports!.analyze('workout')
  await waitFor(() => server.jobs.size === 1, 'job creato')
  engine.stop()
  release()
  server.repository.analyze = original
  const again = engineFor(backend, server)
  await waitFor(() => again.getSnapshot().slots.workout.session?.status === 'reviewing', 'job ritrovato alla riapertura')
  assert.equal(server.state.analyzeCalls, 1)

  // Stessa fonte in un'altra importazione (la precedente rimossa): analisi pronta riaperta senza chiamate.
  again.stop()
  backend.records.clear()
  await seedRead(backend, item.kind, item.document)
  const reopen = engineFor(backend, server)
  await waitFor(() => reopen.getSnapshot().slots.workout.session?.status === 'reading', 'nuova lettura')
  await reopen.imports!.lookupCompatible('workout')
  const [compatible] = slot(reopen, 'workout').network.compatible!
  await reopen.imports!.reopen('workout', compatible!.jobId)
  assert.deepEqual([session(reopen, 'workout').status, session(reopen, 'workout').jobId, server.state.analyzeCalls], ['reviewing', compatible!.jobId, 1])

  const budget = { code: 'budget_exhausted' as const, message: 'Budget mensile esaurito.', retryable: false, limit: null }
  const errors = fakeServer(), store = memoryBackend()
  await seedRead(store, 'workout', item.document)
  const failing = engineFor(store, errors)
  await waitFor(() => failing.getSnapshot().phase === 'ready', 'apertura')
  errors.state.analyzeMode = { status: 429, error: budget }
  await failing.imports!.analyze('workout')
  assert.deepEqual([session(failing, 'workout').status, session(failing, 'workout').error], ['failed', budget])
  errors.state.analyzeMode = 'ok'
  errors.state.extraction = fixture('extractions/workout-wrong-domain.json')
  await failing.imports!.analyze('workout')
  assert.deepEqual([session(failing, 'workout').status, analysisOutcome(session(failing, 'workout'))], ['reviewing', 'wrong_document_type'])
  await failing.imports!.confirm('workout', { ids: { planId: uuid(), versionId: uuid(), items: {}, exercises: {} }, selection: defaultSelectionOptions })
  assert.deepEqual([errors.state.commitCalls, slot(failing, 'workout').network.problem?.code], [0, 'not_ready'], 'dominio sbagliato non salvabile')
})

test('21: rilettura dopo il salvataggio fallita → esito salvato distinto dall’errore di lettura; rianalisi separata dagli edit', async () => {
  const item = byId('diet-spec-example'), server = fakeServer(), backend = memoryBackend()
  server.state.extraction = item.extraction
  await seedRead(backend, item.kind, item.document)
  let fail = true
  const engine = engineFor(backend, server, { refresh: async () => { if (fail) throw new Error('rete') } })
  const draft = await reviewed(engine, item)
  // Rianalisi: nuova proposta separata, bozza in uso intatta finché non si adotta.
  await engine.imports!.analyze('diet')
  const current = session(engine, 'diet')
  assert.deepEqual([current.reanalysis?.status, current.draft], ['ready', draft])
  await engine.dismissReanalysis('diet')
  await engine.imports!.confirm('diet', { ids: item.ids as never, selection: defaultSelectionOptions })
  assert.deepEqual([session(engine, 'diet').status, slot(engine, 'diet').network.refresh], ['saved', 'failed'])
  fail = false
  await engine.imports!.refresh('diet')
  assert.equal(slot(engine, 'diet').network.refresh, 'done')
  assert.equal(server.state.commitCalls, 1)
})

