import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateNormalizedDocument, type DocumentReadResult, type NormalizedDocument } from '../src/import/contracts/index.ts'
import { memoryBackend, ReviewStore } from '../src/import/review/local-storage.ts'
import { applyImportEvent, createImportSession, type ImportSession } from '../src/import/review/state.ts'
import { createReviewDraft } from '../src/import/review/draft.ts'
import { validateDraft } from '../src/import/validation/validate.ts'
import { documentUnits, EXCLUDED_BY_USER, narrowDocument } from '../src/features/import/source-model.ts'
import { reserveDietIds } from '../src/features/import/review-model.ts'
import { ImportReviewStore } from '../src/persistence/import-review-store.ts'

const OWNER = '11111111-1111-4111-8111-111111111111'
const expected = (path: string) => (JSON.parse(readFileSync(new URL(`./fixtures/import/${path}`, import.meta.url), 'utf8')) as DocumentReadResult).document
const fixture = (path: string) => JSON.parse(readFileSync(new URL(`./fixtures/import/${path}`, import.meta.url), 'utf8'))
let counter = 0
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
const settle = () => new Promise(done => setTimeout(done, 0))
async function waitFor(check: () => boolean) { for (let i = 0; i < 300; i++) { if (check()) return; await settle() } throw new Error('condizione non raggiunta') }

async function seeded(kind: 'workout' | 'diet', document: NormalizedDocument, backend = memoryBackend()) {
  const at = new Date().toISOString(), sessionId = uuid()
  const event = (value: object) => ({ ...value, ownerId: OWNER, sessionId, at }) as never
  let session: ImportSession = createImportSession({ ownerId: OWNER, sessionId, kind, file: { name: 'f.docx', size: 1, format: 'docx', sourceHash: document.sourceHash }, at })
  session = applyImportEvent(session, event({ type: 'read_started' })).state
  session = applyImportEvent(session, event({ type: 'read_succeeded', document, sourceHash: document.sourceHash })).state
  assert.ok((await new ReviewStore(backend).save(session)).ok)
  const engine = new ImportReviewStore(OWNER, { journal: new ReviewStore(backend), newId: uuid, createReader: () => { throw new Error() } })
  engine.start()
  await waitFor(() => engine.getSnapshot().phase === 'ready')
  return { engine, backend }
}

test('22: selezione esplicita di sezioni DOCX — documento valido, genitori e titoli conservati, esclusioni dichiarate e da confermare', () => {
  const document = expected('docx/docx-paragraphs.expected.json')
  const units = documentUnits(document, 'docx')
  assert.ok(units.length >= 3, 'parte iniziale e sezioni di primo livello')
  assert.deepEqual(units.flatMap(unit => unit.blockIds).sort(), document.blocks.map(block => block.id).sort(), 'ogni blocco in una sola parte')
  const chosen = new Set([units[1]!.id])
  const narrowed = narrowDocument(document, units, chosen)
  assert.ok(validateNormalizedDocument(narrowed).ok, 'nessun riferimento pendente')
  assert.deepEqual([narrowed.sourceHash, narrowed.readerVersion], [document.sourceHash, document.readerVersion])
  assert.ok(narrowed.blocks.length < document.blocks.length)
  assert.deepEqual(narrowed.blocks.map(block => block.id), document.blocks.filter(block => narrowed.blocks.some(kept => kept.id === block.id)).map(block => block.id), 'ordine della fonte')
  const exclusion = narrowed.readingIssues.find(issue => issue.code === EXCLUDED_BY_USER)!
  for (const unit of units.slice(2)) assert.ok(exclusion.message.includes(unit.label), unit.label)
  // Le parti escluse sono un problema bloccante della revisione, risolvibile solo con una scelta di ambito.
  const draft = createReviewDraft({ kind: 'workout', extraction: fixture('extractions/workout-spec-example.json'), proposalId: uuid(), jobId: null,
    source: { sourceHash: narrowed.sourceHash, readerVersion: narrowed.readerVersion, textNormalizationVersion: 'peppitness.text-normalization.v1' } })
  const finding = validateDraft(narrowed, draft).findings.find(item => item.issue.message.includes(EXCLUDED_BY_USER))!
  assert.deepEqual([finding.issue.code, finding.issue.severity], ['source_not_read', 'blocking'])
  assert.ok(finding.issue.resolutions.includes('scope_choice'))
  // Tutto scelto: nessuna esclusione dichiarata; PDF per pagine.
  assert.equal(narrowDocument(document, units, new Set(units.map(unit => unit.id))).readingIssues.some(issue => issue.code === EXCLUDED_BY_USER), false)
  const pdf = expected('pdf/pdf-table.expected.json')
  assert.ok(documentUnits(pdf, 'pdf').every(unit => /^Pagina \d+$/.test(unit.label)))
})

test('22: prenotazioni ID con la bozza nel journal, riprese dopo la chiusura; nuova proposta = nuove prenotazioni', async () => {
  const document = fixture('documents/diet-spec-example.json') as NormalizedDocument
  const backend = memoryBackend()
  const { engine } = await seeded('diet', document, backend)
  const session = engine.getSnapshot().slots.diet.session!
  const draft = createReviewDraft({ kind: 'diet', extraction: fixture('extractions/diet-spec-example.json'), proposalId: uuid(), jobId: uuid(),
    source: { sourceHash: document.sourceHash, readerVersion: document.readerVersion, textNormalizationVersion: 'peppitness.text-normalization.v1' } })
  const at = new Date().toISOString()
  // Esito dell'analisi applicato come farebbe il coordinatore 21.
  const analyzed = applyImportEvent(applyImportEvent(session, { type: 'analysis_started', analysisRequestId: uuid(), ownerId: OWNER, sessionId: session.sessionId, at }).state,
    { type: 'analysis_succeeded', analysisRequestId: (applyImportEvent(session, { type: 'analysis_started', analysisRequestId: 'x', ownerId: OWNER, sessionId: session.sessionId, at }).state.analysisRequestId)!, jobId: draft.proposal.jobId, draft, serverExpiresAt: null, ownerId: OWNER, sessionId: session.sessionId, at })
  assert.equal(analyzed.applied, false, 'risposta di un’analisi superata ignorata')
  engine.stop()
  const started = applyImportEvent(session, { type: 'analysis_started', analysisRequestId: '99999999-9999-4999-8999-999999999999', ownerId: OWNER, sessionId: session.sessionId, at }).state
  const reviewing = applyImportEvent(started, { type: 'analysis_succeeded', analysisRequestId: '99999999-9999-4999-8999-999999999999', jobId: draft.proposal.jobId, draft, serverExpiresAt: null, ownerId: OWNER, sessionId: session.sessionId, at }).state
  assert.equal(reviewing.reservations, null)
  assert.ok((await new ReviewStore(backend).save({ ...reviewing, revision: engine.getSnapshot().slots.diet.session!.revision })).ok)

  const again = new ImportReviewStore(OWNER, { journal: new ReviewStore(backend), newId: uuid, createReader: () => { throw new Error() } })
  again.start()
  await waitFor(() => again.getSnapshot().slots.diet.session?.status === 'reviewing')
  const ids = reserveDietIds(draft, null, uuid)
  await again.changeDraft('diet', draft, ids)
  assert.deepEqual(again.getSnapshot().slots.diet.session!.reservations, ids)
  await again.changeDraft('diet', draft)
  assert.deepEqual(again.getSnapshot().slots.diet.session!.reservations, ids, 'un edit senza prenotazioni nuove conserva le precedenti')
  again.stop()
  const reopened = new ImportReviewStore(OWNER, { journal: new ReviewStore(backend), newId: uuid, createReader: () => { throw new Error() } })
  reopened.start()
  await waitFor(() => reopened.getSnapshot().slots.diet.session?.status === 'reviewing')
  assert.deepEqual(reopened.getSnapshot().slots.diet.session!.reservations, ids, 'stessi ID dopo la ripresa')
  // Voce con prenotazioni non conformi: rifiutata alla lettura, mai usata per un comando.
  const [record] = [...backend.records.values()]
  backend.records.set(record!.key, { ...record!, session: { ...(record!.session as object), reservations: { planId: 'non-uuid', items: {} } } })
  assert.equal((await new ReviewStore(backend).load(OWNER, (record!.session as ImportSession).sessionId)).status, 'corrupt')
})

test('22: stesso documento nell’altro dominio senza rileggere né analizzare; revisione in corso protetta; nuova lettura ridotta; scarto', async () => {
  const document = expected('docx/docx-paragraphs.expected.json')
  const { engine, backend } = await seeded('workout', document)
  assert.equal(await engine.copyTo('workout', 'diet'), true)
  const copied = engine.getSnapshot().slots.diet.session!
  assert.deepEqual([copied.kind, copied.status, copied.document?.sourceHash, copied.analysisRequestId], ['diet', 'reading', document.sourceHash, null], 'nessuna analisi automatica')
  assert.notEqual(copied.sessionId, engine.getSnapshot().slots.workout.session!.sessionId, 'sessioni e conferme separate')
  assert.equal([...backend.records.values()].length, 2)

  // Selezione ridotta: nuova sessione con il documento derivato, la precedente lascia il journal.
  const units = documentUnits(document, 'docx')
  const before = engine.getSnapshot().slots.workout.session!.sessionId
  assert.equal(await engine.restartWith('workout', narrowDocument(document, units, new Set([units[1]!.id]))), true)
  const narrowed = engine.getSnapshot().slots.workout.session!
  assert.notEqual(narrowed.sessionId, before)
  assert.ok(narrowed.document!.readingIssues.some(issue => issue.code === EXCLUDED_BY_USER))
  await waitFor(() => ![...backend.records.values()].some(record => record.sessionId === before))
  assert.equal(await engine.restartWith('workout', { ...document, sourceHash: 'f'.repeat(64) }), false, 'mai un documento di un’altra fonte')

  assert.equal(await engine.discard('workout'), true)
  assert.equal(engine.getSnapshot().slots.workout.session, null)
  await waitFor(() => ![...backend.records.values()].some(record => record.sessionId === narrowed.sessionId))
  engine.stop()

  // Revisione aperta nell'altro dominio: il passaggio è rifiutato e non la sovrascrive.
  const diet = fixture('documents/diet-spec-example.json') as NormalizedDocument
  const store = memoryBackend()
  const draft = createReviewDraft({ kind: 'diet', extraction: fixture('extractions/diet-spec-example.json'), proposalId: uuid(), jobId: uuid(),
    source: { sourceHash: diet.sourceHash, readerVersion: diet.readerVersion, textNormalizationVersion: 'peppitness.text-normalization.v1' } })
  const at = new Date().toISOString(), sessionId = uuid(), id = '88888888-8888-4888-8888-888888888888'
  const event = (value: object) => ({ ...value, ownerId: OWNER, sessionId, at }) as never
  let reviewing = createImportSession({ ownerId: OWNER, sessionId, kind: 'diet', file: { name: 'd.docx', size: 1, format: 'docx', sourceHash: diet.sourceHash }, at })
  for (const value of [{ type: 'read_started' }, { type: 'read_succeeded', document: diet, sourceHash: diet.sourceHash }, { type: 'analysis_started', analysisRequestId: id },
    { type: 'analysis_succeeded', analysisRequestId: id, jobId: draft.proposal.jobId, draft, serverExpiresAt: null }]) reviewing = applyImportEvent(reviewing, event(value)).state
  assert.ok((await new ReviewStore(store).save(reviewing)).ok)
  const both = await seeded('workout', document, store)
  await waitFor(() => both.engine.getSnapshot().slots.diet.session?.status === 'reviewing')
  assert.equal(await both.engine.copyTo('workout', 'diet'), false)
  assert.equal(both.engine.getSnapshot().slots.diet.session!.sessionId, sessionId, 'revisione della dieta intatta')
})
