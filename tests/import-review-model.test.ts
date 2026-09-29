import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { NormalizedDocument, WorkoutReviewDraft } from '../src/import/contracts/index.ts'
import { exerciseChoiceKey } from '../src/import/mapping/workout.ts'
import { createReviewDraft, sequentialLocalIds } from '../src/import/review/draft.ts'
import { addItem, applyDecision, chooseCatalog, moveItem, setField, staleConfirmations } from '../src/import/review/decisions.ts'
import {
  findingState, originalRange, parseNumber, reserveIds, reserveWorkoutIds, ReviewIndex, workoutReviewOutcome,
} from '../src/features/import/review-model.ts'

type Json = any
const read = (path: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/import/${path}`, import.meta.url), 'utf8'))
const source = { sourceHash: 'a'.repeat(64), readerVersion: 'synthetic-fixture/1', textNormalizationVersion: 'peppitness.text-normalization.v1' as const }
let seq = 0
const counter = () => `90000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
function workout(name: string, decisions: 'none' | 'user' | 'golden' = 'user') {
  const entry = read('manifest.json').cases.find((c: Json) => c.id === name)
  let draft = createReviewDraft({ kind: 'workout', extraction: read(entry.expectedProposal), proposalId: '90000000-0000-4000-8000-000000000001', jobId: null, source, localIds: sequentialLocalIds('i') }) as WorkoutReviewDraft
  const golden = decisions === 'golden' ? read(`mapping/workout/${name}.json`) : null
  if (decisions !== 'none') for (const d of [...entry.userDecisions, ...(golden?.additionalDecisions ?? [])]) draft = applyDecision(draft, d) as WorkoutReviewDraft
  return { draft, document: read(entry.expectedBlocks) as NormalizedDocument, golden }
}

test('12: prenotazioni una sola volta, stabili dopo edit, riordino e scelte; nuove chiavi solo per ciò che manca', () => {
  const same = { a: 'x' }
  assert.equal(reserveIds(same, ['a']), same, 'stesso oggetto se non manca nulla')
  let { draft } = workout('workout-abc-no-days', 'none')
  const first = reserveWorkoutIds(draft, null, counter)
  assert.equal(reserveWorkoutIds(draft, first, counter), first)
  assert.deepEqual(Object.keys(first.items).sort(), ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'])
  draft = setField(draft, 'i2', 'restSeconds', { min: 90, max: 90 }, 'user_edit', { decisionId: 'e1' }) as WorkoutReviewDraft
  draft = moveItem(draft, 'i3', 'i0', 0, { decisionId: 'e2' }) as WorkoutReviewDraft
  const afterEdits = reserveWorkoutIds(draft, first, counter)
  assert.equal(afterEdits, first, 'edit e riordino non cambiano le prenotazioni')
  draft = addItem(draft, { collection: 'exercises', parentLocalId: 'i1', localId: 'u1', values: { name: null, variant: null, equipment: null, measurementMode: null, sets: null, optionalSets: null, repetitions: null, durationSeconds: null, restSeconds: null, rir: null, rpe: null, perSide: null, loadUnit: null, loadConvention: null, loadInstruction: null, tempoInstruction: null, prescriptionText: '', notes: [] } }, { decisionId: 'e3' }) as WorkoutReviewDraft
  const choice = { source: 'new' as const, localKey: 'new-x', values: { name: 'Squat', variant: '', equipment: '', loadConvention: 'total' as const, loadUnit: 'kg' as const, measurementMode: 'reps' as const, perSide: false, note: '' } }
  draft = chooseCatalog(draft, 'i2', choice, { decisionId: 'e4' }) as WorkoutReviewDraft
  const extended = reserveWorkoutIds(draft, first, counter)
  assert.notEqual(extended, first)
  for (const [key, value] of Object.entries(first.items)) assert.equal(extended.items[key], value)
  assert.equal(extended.planId, first.planId); assert.equal(extended.versionId, first.versionId)
  assert.ok(extended.items.u1 && extended.exercises[exerciseChoiceKey(choice)])
  // Un'identità existing non riceve un ID: è già un esercizio personale.
  draft = chooseCatalog(draft, 'i4', { source: 'existing', personalId: '11111111-1111-4111-8111-111111111111', revision: 3, seen: { ...choice.values, variant: 'libero', equipment: 'bilanciere', note: 'Catalogo personale' } }, { decisionId: 'e5' }) as WorkoutReviewDraft
  assert.equal(Object.keys(reserveWorkoutIds(draft, extended, counter).exercises).length, 1)
})

test('12: esito della revisione uguale ai golden 09, pronto solo senza problemi', () => {
  for (const name of ['workout-spec-example', 'workout-abc-no-days', 'workout-ranges-unicode', 'workout-partially-interpretable']) {
    const { draft, document, golden } = workout(name, 'golden')
    const outcome = workoutReviewOutcome(document, draft, golden.ids)
    assert.equal(outcome.mapping.ok, true, name)
    if (outcome.mapping.ok) assert.deepEqual(outcome.mapping.value, golden.expected, name)
    assert.equal(outcome.readiness.ready, true, name)
  }
  const { draft, document } = workout('workout-spec-example', 'none')
  const outcome = workoutReviewOutcome(document, draft, reserveWorkoutIds(draft, null, counter))
  assert.equal(outcome.readiness.ready, false)
  assert.equal(outcome.mapping.ok, false)
})

test('12: origine e fonte per ID locale restano collegate dopo il riordino; conferme superate visibili', () => {
  let { draft, document } = workout('workout-abc-no-days', 'user')
  const before = new ReviewIndex(draft, workoutReviewOutcome(document, draft, reserveWorkoutIds(draft, null, counter)).validation)
  const refs = before.refs('i4', 'name')
  assert.ok(refs.length > 0)
  draft = moveItem(draft, 'i3', 'i0', 0, { decisionId: 'r1' }) as WorkoutReviewDraft
  const after = new ReviewIndex(draft, workoutReviewOutcome(document, draft, reserveWorkoutIds(draft, null, counter)).validation)
  assert.deepEqual(after.refs('i4', 'name'), refs)
  assert.equal(after.provenance('i4', 'name')?.origin, 'source')
  assert.ok(after.usersOf(refs[0]!).some(user => user.localId === 'i4' && user.field === 'name'))

  // Conferma del valore 3 per le serie: un edit successivo la rende «da confermare di nuovo».
  let partial = workout('workout-partially-interpretable', 'user')
  const finding = () => new ReviewIndex(partial.draft, workoutReviewOutcome(partial.document, partial.draft, reserveWorkoutIds(partial.draft, null, counter)).validation).findingsOf('i2', 'sets').find(f => f.issue.code === 'value_unverified')!
  assert.equal(findingState(partial.draft, finding()), 'confirmed')
  partial = { ...partial, draft: setField(partial.draft, 'i2', 'sets', 4, 'user_edit', { decisionId: 's1' }) as WorkoutReviewDraft }
  assert.equal(finding(), undefined, 'valore dell’utente: nessun problema di prova sul campo modificato')
  assert.deepEqual(staleConfirmations(partial.draft).map(d => d.decisionId), ['d6'], 'conferma superata dall’edit')
  partial = { ...partial, draft: setField(partial.draft, 'i2', 'sets', 3, 'user_edit', { decisionId: 's2' }) as WorkoutReviewDraft }
  assert.equal(findingState(partial.draft, finding()), 'confirmed', 'di nuovo il valore confermato')
})

test('12: intervallo originale conservato dopo la scelta scalare; numeri senza arrotondamento', () => {
  const { draft } = workout('workout-ranges-unicode', 'user')
  assert.deepEqual(originalRange(draft, 'i2', 'restSeconds'), { min: 90, max: 120 })
  assert.equal(originalRange(draft, 'i4', 'restSeconds'), null)
  assert.equal(parseNumber('2,5'), 2.5); assert.equal(parseNumber(''), null); assert.ok(Number.isNaN(parseNumber('tre')!)); assert.equal(parseNumber(' 0 '), 0)
})
