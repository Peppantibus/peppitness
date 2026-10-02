import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommitCommand, ImportReceipt, MappingResult, NormalizedDocument, ReviewDraft } from '../src/import/contracts/index.ts'
import { commandHash } from '../src/import/mapping/canonical.ts'
import {
  addItem, applyDecision, chooseCatalog, compareWithProposal, confirmFinding, DecisionError, evaluateReadiness, findItem, isConfirmed, moveItem,
  openFindings, removeItem, replayDecisions, setField, staleConfirmations, verifyDraft,
} from '../src/import/review/decisions.ts'
import { createReviewDraft, randomLocalIds, sequentialLocalIds } from '../src/import/review/draft.ts'
import {
  memoryBackend, recordKey, ReviewStore, StorageUnavailableError, type ReviewStorageBackend, type StoredRecord,
} from '../src/import/review/local-storage.ts'
import {
  applyImportEvent, capabilities, createImportSession, ImportAccountScope, ImportStateError, isBusy, isDirty, matchesOriginal, resumeImportSession, type ImportEvent, type ImportSession,
} from '../src/import/review/state.ts'
import { validateDraft } from '../src/import/validation/validate.ts'

const fixtures = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'tests', 'fixtures', 'import')
type Json = any
const readJson = (path: string): Json => JSON.parse(readFileSync(join(fixtures, path), 'utf8'))
const manifest = readJson('manifest.json') as { cases: Json[] }

const PROPOSAL = '90000000-0000-4000-8000-000000000001'
const SOURCE = { sourceHash: 'c5c114fb3df2775b8d5e7828fddc80454843566c207b5fcf38ee07584f31f7a9', readerVersion: 'synthetic-fixture/1', textNormalizationVersion: 'peppitness.text-normalization.v1' as const }
const incompleteDocument = () => readJson('documents/workout-incomplete.json') as NormalizedDocument
const incompleteDraft = (proposalId = PROPOSAL) => createReviewDraft({
  kind: 'workout', extraction: readJson('extractions/workout-incomplete.json'), proposalId, jobId: 'f0000000-0000-4000-8000-000000000001', source: SOURCE, localIds: sequentialLocalIds('i'),
})
let counter = 0
const id = () => ({ decisionId: `t${++counter}` })

test('07: ID locali assegnati una volta, proposta copiata e mai mutata', () => {
  const extraction = readJson('extractions/workout-incomplete.json')
  const snapshot = structuredClone(extraction)
  const draft = createReviewDraft({ kind: 'workout', extraction, proposalId: PROPOSAL, jobId: null, source: SOURCE, localIds: sequentialLocalIds('i') })
  assert.deepEqual(draft.localIds.map(entry => entry.localId), ['i0', 'i1', 'i2', 'i3'])
  assert.deepEqual(draft.localIds.map(entry => entry.pointer), ['', '/sessions/0', '/sessions/0/exercises/0', '/sessions/0/exercises/1'])
  assert.ok(verifyDraft(draft).ok)
  // Nessun alias: modificare il contenuto corrente non tocca proposta né ingresso.
  ;(draft.current[2]!.values as Json).notes.push('x')
  assert.deepEqual(extraction, snapshot)
  assert.deepEqual(draft.proposal.extraction, snapshot)
  const random = createReviewDraft({ kind: 'workout', extraction, proposalId: PROPOSAL, jobId: null, source: SOURCE, localIds: randomLocalIds })
  assert.equal(new Set(random.localIds.map(entry => entry.localId)).size, 4)
  assert.throws(() => createReviewDraft({ kind: 'workout', extraction, proposalId: PROPOSAL, jobId: null, source: SOURCE, localIds: () => 'same' }), /ripetuto/)
})

test('07: le bozze d’esempio del contratto 02 derivano esattamente dal replay delle decisioni', () => {
  for (const name of ['workout-incomplete-draft', 'diet-spec-draft']) {
    const draft = readJson(`contracts/review/${name}.json`)
    assert.ok(verifyDraft(draft).ok, name)
    const tampered = structuredClone(draft)
    tampered.current[1].values[Object.keys(tampered.current[1].values)[0]] = 'manomesso'
    const checked = verifyDraft(tampered)
    assert.ok(!checked.ok && (checked.reason === 'current_mismatch' || checked.reason === 'invalid_shape'), name)
  }
  // Una decisione registrata su un valore diverso da quello corrente non si applica in silenzio.
  const draft = readJson('contracts/review/workout-incomplete-draft.json')
  draft.decisions[0].before = 3
  const stale = verifyDraft(draft)
  assert.ok(!stale.ok && stale.reason === 'replay_failed')
})

test('07: aggiunta, rimozione e riordino mantengono sourcePath e provenienza', () => {
  let draft: ReviewDraft = incompleteDraft()
  draft = addItem(draft, { collection: 'sessions', parentLocalId: 'i0', values: { label: '2', title: 'Seduta 2', weekday: null, notes: [] }, localId: 'u1' }, id())
  draft = moveItem(draft, 'i3', 'u1', 0, id()) // il rematore passa alla seduta aggiunta
  draft = addItem(draft, { collection: 'exercises', parentLocalId: 'i1', index: 0, localId: 'u2', values: {
    name: 'Plank', variant: null, equipment: null, measurementMode: 'seconds', sets: 3, optionalSets: 0, repetitions: null, durationSeconds: { min: 30, max: 30 },
    restSeconds: { min: 60, max: 60 }, rir: null, rpe: null, perSide: false, loadUnit: null, loadConvention: null, loadInstruction: null, tempoInstruction: null, prescriptionText: '', notes: [],
  } }, id())
  assert.deepEqual(draft.current.map(item => item.localId), ['i0', 'i1', 'u2', 'i2', 'u1', 'i3'])
  assert.equal(findItem(draft, 'i3')!.parentLocalId, 'u1')
  assert.ok(verifyDraft(draft).ok)
  // La proposta resta quella dell'interprete; l'elemento spostato conserva il puntatore d'origine.
  assert.deepEqual(draft.proposal.extraction, readJson('extractions/workout-incomplete.json'))
  assert.equal(draft.localIds.find(entry => entry.localId === 'i3')!.pointer, '/sessions/0/exercises/1')
  const validation = validateDraft(incompleteDocument(), draft)
  assert.ok(validation.issues.filter(issue => issue.localId === 'i3').every(issue => issue.sourcePath === null || issue.sourcePath.startsWith('/sessions/0/exercises/1')))
  assert.ok(validation.issues.filter(issue => issue.localId === 'u2').every(issue => issue.sourcePath === null))
  assert.ok(validation.provenance.some(entry => entry.localId === 'i3' && entry.field === 'restSeconds' && entry.origin === 'source'))
  // Rimuovere una seduta rimuove i suoi esercizi; decisioni successive su di loro non si applicano.
  const removed = removeItem(draft, 'u1', 'user_edit', id())
  assert.deepEqual(removed.current.map(item => item.localId), ['i0', 'i1', 'u2', 'i2'])
  assert.throws(() => setField(removed, 'i3', 'sets', 3, 'user_edit', id()), (error: unknown) => error instanceof DecisionError && error.code === 'unknown_item')
  // Anche una decisione scritta a mano su un figlio rimosso non si applica nel replay.
  assert.throws(() => applyDecision(removed, { op: 'set', decisionId: 'raw', localId: 'i3', field: 'sets', before: 2, after: 3, reason: 'user_edit' }), (error: unknown) => error instanceof DecisionError && error.code === 'unknown_item')
  assert.throws(() => removeItem(draft, 'i0'), (error: unknown) => error instanceof DecisionError)
  // Un valore fuori contratto non entra nella bozza.
  assert.throws(() => setField(draft, 'i2', 'sets', '4' as Json), (error: unknown) => error instanceof DecisionError && error.code === 'invalid_decision')
  assert.equal(setField(draft, 'i2', 'sets', null), draft, 'un valore identico non registra decisioni')
})

test('07: le conferme sono legate al valore e al motivo ammesso; un edit successivo le invalida', () => {
  const document = readJson('documents/workout-partially-interpretable.json')
  let draft: ReviewDraft = createReviewDraft({ kind: 'workout', extraction: readJson('extractions/workout-partially-interpretable.json'), proposalId: PROPOSAL, jobId: null, source: SOURCE, localIds: sequentialLocalIds('i') })
  const find = (code: string, localId: string) => validateDraft(document, draft).findings.find(entry => entry.issue.code === code && entry.issue.localId === localId)!
  const unverified = find('value_unverified', 'i2')
  draft = confirmFinding(draft, unverified, 'scope_choice', id())
  assert.ok(isConfirmed(draft, unverified))
  assert.ok(!openFindings(draft, validateDraft(document, draft).findings).some(entry => entry.issue.code === 'value_unverified' && entry.issue.localId === 'i2'))
  // L'utente cambia le serie: il campo diventa suo, la conferma non vale più.
  draft = setField(draft, 'i2', 'sets', 4, 'user_edit', id())
  assert.equal(staleConfirmations(draft).length, 1)
  assert.ok(!isConfirmed(draft, unverified))
  // Un bloccante si chiude solo con le risoluzioni del catalogo: niente spunta su un recupero mancante o su una criticità.
  assert.throws(() => confirmFinding(draft, find('rest_missing', 'i2'), 'scope_choice'), (error: unknown) => error instanceof DecisionError && error.code === 'not_allowed')
  assert.throws(() => confirmFinding(draft, find('source_not_read', 'i0'), 'confirmed_missing'), (error: unknown) => error instanceof DecisionError && error.code === 'not_allowed')
  // Una conferma di ambito su una regola resta valida finché la regola esiste.
  draft = setField(draft, 'i4', 'sets', null, 'user_edit', id())
  const rule = find('complex_rule_unresolved', 'i8')
  draft = confirmFinding(draft, rule, 'scope_choice', id())
  assert.ok(isConfirmed(draft, rule))
  // Conferma registrata su un altro valore (bozza manomessa): non chiude il problema.
  const forged = applyDecision(draft, { op: 'confirm', decisionId: 'forged', localId: 'i2', field: 'restSeconds', issueCode: 'rest_missing', value: null, reason: 'confirmed_missing' })
  assert.ok(openFindings(forged, validateDraft(document, forged).findings).some(entry => entry.issue.code === 'rest_missing' && entry.issue.localId === 'i2'))
})

test('07: le decisioni del corpus chiudono ogni problema; pronto solo con un mapping valido passato come risultato', () => {
  const ok: MappingResult<unknown> = { ok: true, value: {}, issues: [] }
  const failed: MappingResult<unknown> = { ok: false, issues: [{ code: 'resolved_contract_violation', severity: 'blocking', stage: 'mapping', localId: null, sourcePath: '', sourceRefs: [], message: 'x', resolutions: ['user_edit'] }] }
  let checked = 0
  for (const item of manifest.cases.filter(entry => entry.candidate === null && entry.userDecisions !== null)) {
    const document = readJson(item.expectedBlocks)
    const base = createReviewDraft({ kind: item.domain, extraction: readJson(item.expectedProposal), proposalId: PROPOSAL, jobId: null, source: { ...SOURCE, sourceHash: document.sourceHash }, localIds: sequentialLocalIds('i') })
    const draft = { ...base, decisions: item.userDecisions, current: replayDecisions({ ...base, decisions: item.userDecisions }) }
    const verified = verifyDraft(draft)
    assert.ok(verified.ok, `${item.id}: ${!verified.ok && verified.message}`)
    const findings = validateDraft(document, draft).findings
    const before = evaluateReadiness(base, validateDraft(document, base).findings, ok)
    assert.equal(before.ready, item.id === 'diet-spec-example', item.id)
    const readiness = evaluateReadiness(draft, findings, null)
    assert.deepEqual([readiness.blocking.length, readiness.confirmations.length, readiness.mapping, readiness.ready], [0, 0, 'missing', false], item.id)
    assert.equal(evaluateReadiness(draft, findings, ok).ready, true, item.id)
    assert.equal(evaluateReadiness(draft, findings, failed).ready, false, item.id)
    checked++
  }
  assert.equal(checked, 8)
  const wrong = manifest.cases.find(entry => entry.id === 'workout-wrong-domain')!
  assert.equal(wrong.userDecisions, null, 'un dominio sbagliato non produce una bozza')
})

// ---------------------------------------------------------------------------
// Macchina a stati
// ---------------------------------------------------------------------------

const OWNER = 'owner-a'
const SESSION = 's-1'
let clock = Date.parse('2026-09-29T08:00:00.000Z')
const at = () => new Date(clock += 1000).toISOString()
const event = (value: Json, overrides: Json = {}): ImportEvent => ({ ownerId: OWNER, sessionId: SESSION, at: at(), ...value, ...overrides })
const apply = (state: ImportSession, value: Json, overrides: Json = {}) => {
  const outcome = applyImportEvent(state, event(value, overrides))
  assert.ok(outcome.applied, `${value.type} ignorato: ${!outcome.applied && outcome.reason}`)
  return outcome.state
}
const newSession = () => createImportSession({ ownerId: OWNER, sessionId: SESSION, kind: 'workout', file: { name: 'scheda.docx', size: 1234, format: 'docx', sourceHash: null }, at: at() })
function reviewing(): ImportSession {
  let state = newSession()
  state = apply(state, { type: 'read_started' })
  state = apply(state, { type: 'read_succeeded', document: incompleteDocument(), sourceHash: SOURCE.sourceHash })
  state = apply(state, { type: 'analysis_started', analysisRequestId: 'a-1' })
  return apply(state, { type: 'analysis_succeeded', analysisRequestId: 'a-1', jobId: 'f0000000-0000-4000-8000-000000000001', draft: incompleteDraft(), serverExpiresAt: null })
}
const command = () => readJson('contracts/commands/workout-basic.json') as CommitCommand
const receipt = () => readJson('contracts/receipts/workout-basic-committed.json') as ImportReceipt
const readyFor = (state: ImportSession) => apply(state, { type: 'readiness_confirmed', draft: state.draft, findings: [], mapping: { ok: true, value: {}, issues: [] } })

test('07: percorso completo con journal durevole, comando congelato e ricevuta verificata', async () => {
  const hash = await commandHash(command())
  assert.equal(hash, receipt().commandHash)
  let state = reviewing()
  assert.equal(state.status, 'reviewing')
  // Un mapping non valido o assente non porta a ready.
  assert.throws(() => applyImportEvent(state, event({ type: 'readiness_confirmed', draft: state.draft, findings: [], mapping: { ok: false, issues: [] } })), (error: unknown) => error instanceof ImportStateError && error.code === 'not_ready')
  const findings = validateDraft(incompleteDocument(), state.draft!).findings
  assert.throws(() => applyImportEvent(state, event({ type: 'readiness_confirmed', draft: state.draft, findings, mapping: { ok: true, value: {}, issues: [] } })), /bloccanti/)
  state = readyFor(state)
  state = apply(state, { type: 'command_frozen', command: command(), commandHash: hash })
  // Senza journal durevole il salvataggio non parte.
  assert.throws(() => applyImportEvent(state, event({ type: 'save_started' })), (error: unknown) => error instanceof ImportStateError && error.code === 'journal_required')
  const store = new ReviewStore(memoryBackend(), { now: () => new Date(clock).toISOString() })
  const saved = await store.save(state)
  assert.ok(saved.ok)
  state = apply(saved.session, { type: 'save_started' })
  assert.equal(state.status, 'saving')
  // Una ricevuta di un altro comando non vale come salvato.
  assert.throws(() => applyImportEvent(state, event({ type: 'save_succeeded', receipt: { ...receipt(), commandHash: 'f'.repeat(64) } })), (error: unknown) => error instanceof ImportStateError)
  state = apply(state, { type: 'save_succeeded', receipt: receipt() })
  assert.equal(state.status, 'saved')
  // Risposte tardive dopo la fine: ignorate.
  assert.equal(applyImportEvent(state, event({ type: 'save_outcome_unknown', error: { code: 'x', message: 'x' } })).applied, false)
})

test('07: esito incerto: stesso requestId, nessun edit, nessuna identità nuova implicita', async () => {
  const hash = await commandHash(command())
  const store = new ReviewStore(memoryBackend(), { now: () => new Date(clock).toISOString() })
  let state = readyFor(reviewing())
  state = apply(state, { type: 'command_frozen', command: command(), commandHash: hash })
  // Congelare di nuovo lo stesso comando è idempotente; un comando diverso no.
  assert.equal(applyImportEvent(state, event({ type: 'command_frozen', command: command(), commandHash: hash })).applied, false)
  assert.throws(() => applyImportEvent(state, event({ type: 'command_frozen', command: { ...command(), requestId: 'e0000000-0000-4000-8000-000000000099' }, commandHash: hash })))
  state = (await store.save(state)).session
  state = apply(state, { type: 'save_started' })
  state = apply(state, { type: 'save_outcome_unknown', error: { code: 'network', message: 'Risposta persa' } })
  assert.equal(state.status, 'save_unknown')
  assert.throws(() => applyImportEvent(state, event({ type: 'draft_changed', draft: state.draft })), (error: unknown) => error instanceof ImportStateError && error.code === 'uncertain_save')
  assert.throws(() => applyImportEvent(state, event({ type: 'cancelled' })), (error: unknown) => error instanceof ImportStateError && error.code === 'uncertain_save')
  assert.deepEqual(capabilities(state, { online: true }), { edit: false, analyze: false, save: false, retrySave: true, discard: true, discardNeedsWarning: true })
  // Il riavvio dopo un crash in `saving` diventa `save_unknown` con lo stesso comando.
  const persisted = (await store.save(apply(state, { type: 'save_started' }))).session
  assert.equal(persisted.status, 'saving')
  const reopened = await store.load(OWNER, SESSION)
  assert.ok(reopened.status === 'ok')
  if (reopened.status !== 'ok') return
  assert.equal(reopened.session.status, 'save_unknown')
  assert.equal(reopened.session.commit!.command.requestId, command().requestId)
  assert.equal(reopened.session.commit!.commandHash, hash)
  // Scartare un comando incerto richiede una conferma dedicata: il piano potrebbe essere già salvato.
  assert.deepEqual(await store.discard(OWNER, SESSION), { ok: false, reason: 'uncertain_command' })
  assert.deepEqual(await store.pendingRisks(OWNER), { localDrafts: 0, uncertainCommands: 1 })
  // Retry con lo stesso comando, poi ricevuta.
  state = apply(reopened.session, { type: 'save_started' })
  assert.equal(state.commit!.command.requestId, command().requestId)
  state = apply(state, { type: 'save_succeeded', receipt: receipt() })
  assert.equal(state.status, 'saved')
  assert.deepEqual(await store.discard(OWNER, SESSION, { acknowledgeUncertain: true }), { ok: true })
  assert.equal((await store.load(OWNER, SESSION)).status, 'missing')
})

test('07: un rifiuto definitivo torna alla revisione senza comando; una modifica fa decadere il comando mai inviato', async () => {
  const hash = await commandHash(command())
  let state = apply(readyFor(reviewing()), { type: 'command_frozen', command: command(), commandHash: hash })
  const edited = setField(state.draft!, 'i2', 'sets', 4, 'user_edit', id())
  const changed = apply(state, { type: 'draft_changed', draft: edited })
  assert.equal(changed.status, 'reviewing')
  assert.equal(changed.commit, null)
  const store = new ReviewStore(memoryBackend())
  state = apply((await store.save(state)).session, { type: 'save_started' })
  state = apply(state, { type: 'save_rejected', error: { code: 'PT409', message: 'Catalog changed' } })
  assert.equal(state.status, 'reviewing')
  assert.equal(state.commit, null)
})

test('07: rianalisi come proposta separata: confronto e adozione esplicita, edit mai sovrascritti', () => {
  let state = reviewing()
  const edited = setField(state.draft!, 'i2', 'sets', 4, 'user_edit', id())
  state = apply(state, { type: 'draft_changed', draft: edited })
  state = apply(state, { type: 'analysis_started', analysisRequestId: 'a-2' })
  assert.equal(state.status, 'reviewing')
  assert.equal(state.reanalysis!.status, 'running')
  assert.equal(capabilities(state, { online: true }).edit, false)
  const extraction = readJson('extractions/workout-incomplete.json')
  extraction.sessions[0].exercises[0].restSeconds = { min: 120, max: 120 }
  const next = createReviewDraft({ kind: 'workout', extraction, proposalId: '90000000-0000-4000-8000-000000000002', jobId: null, source: SOURCE, previous: { proposalId: PROPOSAL, proposalVersion: 1 }, localIds: sequentialLocalIds('n') })
  assert.equal(next.proposal.proposalVersion, 2)
  assert.equal(next.proposal.previousProposalId, PROPOSAL)
  // Una risposta dell'analisi precedente arrivata ora è ignorata.
  assert.equal(applyImportEvent(state, event({ type: 'analysis_succeeded', analysisRequestId: 'a-1', jobId: null, draft: next, serverExpiresAt: null })).applied, false)
  state = apply(state, { type: 'analysis_succeeded', analysisRequestId: 'a-2', jobId: null, draft: next, serverExpiresAt: null })
  assert.equal(state.draft, edited, 'la bozza in uso resta intatta')
  const differences = compareWithProposal(state.draft!, state.reanalysis!.draft!)
  assert.deepEqual(differences, [{ pointer: '/sessions/0/exercises/0', collection: 'exercises', change: 'changed', fields: ['sets', 'restSeconds'] }])
  const dismissed = apply(state, { type: 'reanalysis_dismissed' })
  assert.equal(dismissed.reanalysis, null)
  assert.equal(dismissed.draft, edited)
  const adopted = apply(state, { type: 'reanalysis_adopted' })
  assert.equal(adopted.draft!.proposal.proposalId, '90000000-0000-4000-8000-000000000002')
  assert.deepEqual(adopted.previousDrafts.map(draft => draft.decisions.length), [1], 'la bozza precedente conserva le sue decisioni')
})

test('07: account, sessioni e risposte tardive isolati; stop e StrictMode', () => {
  let state = newSession()
  state = apply(state, { type: 'read_started' })
  assert.deepEqual(applyImportEvent(state, event({ type: 'read_succeeded', document: incompleteDocument(), sourceHash: SOURCE.sourceHash }, { ownerId: 'owner-b' })), { state, applied: false, reason: 'other_owner' })
  assert.equal(applyImportEvent(state, event({ type: 'read_started' }, { sessionId: 'altro' })).applied, false)
  state = apply(state, { type: 'read_succeeded', document: incompleteDocument(), sourceHash: SOURCE.sourceHash })
  state = apply(state, { type: 'analysis_started', analysisRequestId: 'a-1' })
  state = apply(state, { type: 'analysis_failed', analysisRequestId: 'a-1', error: { code: 'provider_unavailable', message: 'x', retryable: true, limit: null } })
  state = apply(state, { type: 'analysis_started', analysisRequestId: 'a-2' })
  // La risposta tardiva della prima analisi non entra nella seconda.
  const superseded = applyImportEvent(state, event({ type: 'analysis_succeeded', analysisRequestId: 'a-1', jobId: null, draft: incompleteDraft(), serverExpiresAt: null }))
  assert.deepEqual([superseded.applied, !superseded.applied && superseded.reason, superseded.state.status], [false, 'stale_response', 'analyzing'])
  state = apply(state, { type: 'cancelled' })
  assert.equal(state.status, 'cancelled')
  const late = applyImportEvent(state, event({ type: 'analysis_succeeded', analysisRequestId: 'a-2', jobId: null, draft: incompleteDraft(), serverExpiresAt: null }))
  assert.deepEqual([late.applied, !late.applied && late.reason], [false, 'after_stop'])
  assert.equal(applyImportEvent(state, event({ type: 'cancelled' })).applied, false, 'stop ripetuto (StrictMode) senza errori')

  const scope = new ImportAccountScope(OWNER)
  const ticket = scope.ticket()
  assert.equal(scope.switchTo(OWNER), null, 'stesso account: nulla da annullare')
  assert.ok(scope.isCurrent(ticket))
  assert.equal(scope.switchTo('owner-b'), OWNER)
  assert.ok(ticket.signal.aborted)
  assert.ok(!scope.isCurrent(ticket))
  const next = scope.ticket()
  scope.stop()
  assert.ok(!scope.isCurrent(next) && next.signal.aborted)
  scope.dispose(); scope.dispose()
})

test('07: offline si rivede, non si analizza né si salva; l’originale si riapre solo con lo stesso hash', () => {
  const state = reviewing()
  assert.deepEqual(capabilities(state, { online: false }), { edit: true, analyze: false, save: false, retrySave: false, discard: true, discardNeedsWarning: true })
  assert.equal(isDirty(state), true)
  assert.ok(matchesOriginal(state, SOURCE.sourceHash))
  assert.ok(!matchesOriginal(state, 'a'.repeat(64)))
  const expired = apply(state, { type: 'expired' })
  assert.deepEqual([expired.status, expired.draft, expired.document], ['expired', null, null])
})

test('07/11: lettura in corso occupata; lettura conclusa in attesa dell’analisi non blocca guardie né scarto', () => {
  const reading = apply(newSession(), { type: 'read_started' })
  assert.equal(isBusy(reading), true)
  assert.equal(capabilities(reading, { online: true }).discard, false)
  const read = apply(reading, { type: 'read_succeeded', document: incompleteDocument(), sourceHash: SOURCE.sourceHash })
  assert.deepEqual([read.status, isBusy(read), isDirty(read)], ['reading', false, false])
  assert.equal(capabilities(read, { online: true }).discard, true)
  // Riaperta dopo un reload resta leggibile e non occupata.
  assert.equal(isBusy(resumeImportSession(read, at())), false)
})

// ---------------------------------------------------------------------------
// Journal locale
// ---------------------------------------------------------------------------

test('07: journal per account: ripresa dopo reload, nessun byte originale, residui di altri account eliminati', async () => {
  const backend = memoryBackend()
  const store = new ReviewStore(backend, { now: () => new Date(clock).toISOString() })
  const edited = setField(reviewing().draft!, 'i2', 'sets', 4, 'user_edit', id())
  const state = apply(reviewing(), { type: 'draft_changed', draft: edited })
  const first = await store.save(state)
  assert.ok(first.ok)
  assert.equal(first.session.revision, 1)
  assert.equal(first.session.persistence, 'durable')
  // Reload: stessa bozza con le decisioni.
  const loaded = await store.load(OWNER, SESSION)
  assert.ok(loaded.status === 'ok' && loaded.session.draft!.decisions.length === 1 && findItem(loaded.session.draft!, 'i2')!.values.sets === 4)
  const record = backend.records.get(recordKey(OWNER, SESSION))!
  assert.deepEqual(Object.keys((record.session as Json).file).sort(), ['format', 'name', 'size', 'sourceHash'])
  assert.ok(!JSON.stringify(record).includes('"bytes"'))
  // Un altro account non vede e poi elimina i residui del primo.
  assert.equal((await store.load('owner-b', SESSION)).status, 'missing')
  const other = await store.open('owner-b')
  assert.deepEqual(other.sessions, [])
  assert.equal(backend.records.size, 0)
})

test('07: due schede sulla stessa bozza: conflitto esplicito, mai sovrascrittura', async () => {
  const backend = memoryBackend()
  const tabA = new ReviewStore(backend), tabB = new ReviewStore(backend)
  const base = (await tabA.save(reviewing())).session
  const inA = apply(base, { type: 'draft_changed', draft: setField(base.draft!, 'i2', 'sets', 4, 'user_edit', id()) })
  const inB = apply(base, { type: 'draft_changed', draft: setField(base.draft!, 'i2', 'sets', 5, 'user_edit', id()) })
  const savedA = await tabA.save(inA)
  assert.ok(savedA.ok && savedA.session.revision === 2)
  const savedB = await tabB.save(inB)
  assert.ok(!savedB.ok && savedB.reason === 'conflict' && savedB.storedRevision === 2)
  assert.equal(savedB.session.persistence, 'volatile')
  const current = await tabB.load(OWNER, SESSION)
  assert.ok(current.status === 'ok' && findItem(current.session.draft!, 'i2')!.values.sets === 4)
})

test('07: archivio assente, quota esaurita o scrittura fallita: stato volatile e nessun invio', async () => {
  const hash = await commandHash(command())
  const frozen = apply(readyFor(reviewing()), { type: 'command_frozen', command: command(), commandHash: hash })
  const none = await new ReviewStore(null).save(frozen)
  assert.ok(!none.ok && none.reason === 'unavailable' && none.session.persistence === 'volatile')
  const quota: ReviewStorageBackend = { ...memoryBackend(), async put() { throw Object.assign(new Error('full'), { name: 'QuotaExceededError' }) } }
  const full = await new ReviewStore(quota).save(frozen)
  assert.ok(!full.ok && full.reason === 'quota')
  assert.ok(isDirty(full.session))
  assert.throws(() => applyImportEvent(full.session, event({ type: 'save_started' })), (error: unknown) => error instanceof ImportStateError && error.code === 'journal_required')
  const broken: ReviewStorageBackend = { ...memoryBackend(), async put() { throw new StorageUnavailableError('failed', 'x') } }
  const failed = await new ReviewStore(broken).save(frozen)
  assert.ok(!failed.ok && failed.reason === 'unavailable')
  assert.equal(capabilities(failed.session, { online: true }).save, false)
})

test('07: formato versionato, voci corrotte o scadute, comando incerto che non scade', async () => {
  const backend = memoryBackend()
  let now = Date.parse('2026-09-29T08:00:00.000Z')
  const store = new ReviewStore(backend, { now: () => new Date(now).toISOString() })
  const session = { ...reviewing(), lastActivityAt: new Date(now).toISOString() }
  await store.save(session)
  const key = recordKey(OWNER, SESSION)
  // Versione più nuova: non letta e non cancellata.
  const newer: StoredRecord = { ...backend.records.get(key)!, formatVersion: 'peppitness.import-local.v9' }
  backend.records.set(key, newer)
  assert.equal((await store.load(OWNER, SESSION)).status, 'unsupported_version')
  const opened = await store.open(OWNER)
  assert.deepEqual(opened.problems, [{ sessionId: SESSION, problem: 'unsupported_version' }])
  assert.ok(backend.records.has(key))
  // Voce manomessa: rifiutata.
  const corrupt = structuredClone(newer) as Json
  corrupt.formatVersion = 'peppitness.import-local.v1'
  corrupt.session.draft.current[2].values.sets = 99
  backend.records.set(key, corrupt)
  assert.equal((await store.load(OWNER, SESSION)).status, 'corrupt')
  const foreign = structuredClone(corrupt)
  foreign.session.ownerId = 'owner-b'
  backend.records.set(key, foreign)
  assert.equal((await store.load(OWNER, SESSION)).status, 'corrupt')
  // Scadenza dopo 7 giorni di inattività: contenuti eliminati.
  backend.records.clear()
  await store.save(session)
  now += 7 * 24 * 60 * 60 * 1000 + 1
  assert.equal((await store.load(OWNER, SESSION)).status, 'expired')
  assert.equal(backend.records.size, 0)
  // Un comando inviato e non riconciliato non scade: serve per verificare l'esito.
  now = Date.parse('2026-09-29T08:00:00.000Z')
  const hash = await commandHash(command())
  let uncertain = apply(readyFor({ ...reviewing(), lastActivityAt: new Date(now).toISOString() }), { type: 'command_frozen', command: command(), commandHash: hash })
  uncertain = (await store.save({ ...uncertain, lastActivityAt: new Date(now).toISOString() })).session
  uncertain = apply(uncertain, { type: 'save_started' }, { at: new Date(now).toISOString() })
  await store.save(uncertain)
  now += 30 * 24 * 60 * 60 * 1000
  const later = await store.load(OWNER, SESSION)
  assert.ok(later.status === 'ok' && later.session.status === 'save_unknown')
  assert.deepEqual(await store.pendingRisks(OWNER), { localDrafts: 0, uncertainCommands: 1 })
  await store.clearOwner(OWNER)
  assert.equal(backend.records.size, 0)
})

test('07: crash dopo il congelamento: stesso comando e stesso requestId; un nuovo file non ne crea uno nuovo', async () => {
  const hash = await commandHash(command())
  const backend = memoryBackend()
  const store = new ReviewStore(backend)
  const frozen = (await store.save(apply(readyFor(reviewing()), { type: 'command_frozen', command: command(), commandHash: hash }))).session
  assert.equal(frozen.commit!.sent, false)
  // Riapertura (il comando era scritto ma mai inviato): si invia quello, senza ricongelare.
  const reopened = await store.load(OWNER, SESSION)
  assert.ok(reopened.status === 'ok' && reopened.session.status === 'ready' && reopened.session.commit!.journalRevision !== null)
  if (reopened.status !== 'ok') return
  const sending = apply(reopened.session, { type: 'save_started' })
  assert.deepEqual([sending.commit!.command.requestId, sending.commit!.commandHash, sending.commit!.sent], [command().requestId, hash, true])
  await store.save(apply(sending, { type: 'save_outcome_unknown', error: { code: 'network', message: 'x' } }))
  // Un nuovo file apre una sessione distinta; quella incerta resta, in cima all'elenco, con il suo requestId.
  const other = createImportSession({ ownerId: OWNER, sessionId: 's-2', kind: 'workout', file: { name: 'altra.pdf', size: 10, format: 'pdf', sourceHash: null }, at: new Date(clock + 60_000).toISOString() })
  await store.save(other)
  const listed = await store.open(OWNER)
  assert.deepEqual(listed.sessions.map(session => [session.sessionId, session.uncertainCommand]), [[SESSION, true], ['s-2', false]])
  const still = await store.load(OWNER, SESSION)
  assert.ok(still.status === 'ok' && still.session.commit!.command.requestId === command().requestId)
})
