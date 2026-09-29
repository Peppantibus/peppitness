import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chooseCatalogExercise, chooseNewExercise, identityFields, matchExercises, type CatalogSnapshot, type MatchOccurrence } from '../src/import/matching/exercises.ts'
import { validateExerciseChoice, exerciseChoiceValues } from '../src/import/contracts/review.ts'

const fixture = (): CatalogSnapshot => JSON.parse(readFileSync(new URL('./fixtures/import/matching/catalog.json', import.meta.url), 'utf8'))
const occurrence = (): MatchOccurrence => ({ localId: 'occ-1', name: 'Squat', variant: 'libero', equipment: 'bilanciere', loadConvention: 'total', loadUnit: 'kg', measurementMode: 'reps', perSide: false })
const match = (o = occurrence(), s = fixture()) => matchExercises([o], s)[0]!

test('08: exact complete personal first, deterministic ranking and independent occurrences', () => {
  const snapshot = fixture(), before = structuredClone(snapshot)
  const result = match(occurrence(), snapshot)
  assert.equal(result.preselected?.source, 'existing')
  assert.equal(result.candidates[2]?.conflicts.includes('variant'), true)
  assert.deepEqual(match(occurrence(), { ...snapshot, personal: [...snapshot.personal].reverse() }), result)
  const pair = matchExercises([occurrence(), { ...occurrence(), localId: 'occ-2' }], snapshot)
  assert.deepEqual(pair[0]!.preselected, pair[1]!.preselected)
  assert.notEqual(pair[0]!.localId, pair[1]!.localId)
  assert.deepEqual(snapshot, before)
  assert.equal(match({ ...occurrence(), name: '  SQUAT  ' }).preselected?.source, 'existing')
  assert.equal(result.sourceName, 'Squat')
  assert.ok(validateExerciseChoice(result.preselected).ok)
})

test('08: every missing or conflicting identity field requires choice, never defaults', () => {
  for (const field of identityFields) {
    const o = { ...occurrence(), [field]: null }
    assert.equal(match(o).preselected, null, field)
    assert.deepEqual(match(o).candidates[0]!.missing, [field])
    assert.equal(o[field], null)
  }
  for (const change of [{ variant: 'frontale' }, { equipment: 'macchina' }, { measurementMode: 'seconds' }, { perSide: true }, { loadUnit: 'lb' }, { loadConvention: 'single-dumbbell' }] as const) {
    const result = match({ ...occurrence(), ...change })
    assert.equal(result.preselected, null)
    assert.ok(result.candidates.every(c => c.conflicts.length > 0))
  }
})

test('08: fuzzy and accents are suggestions; unrelated exercises never equivalent', () => {
  assert.equal(match({ ...occurrence(), name: 'Squatt' }).preselected, null)
  assert.equal(match({ ...occurrence(), name: 'Squát' }).candidates[0]?.nameMatch, 'fuzzy')
  assert.equal(match({ ...occurrence(), name: 'Lat machine' }).candidates.length, 0)
  assert.equal(match({ ...occurrence(), name: null }).candidates.length, 0)
})

test('08: empty, incomplete, ambiguous and malformed snapshots do not preselect', () => {
  assert.equal(match(occurrence(), { personal: [], shared: [], complete: true }).preselected, null)
  assert.equal(match(occurrence(), { ...fixture(), complete: false }).preselected, null)
  const s = fixture()
  s.personal = [...s.personal, { ...s.personal[0]!, id: '44444444-4444-4444-8444-444444444444' }]
  assert.equal(match(occurrence(), s).preselected, null)
  assert.throws(() => match(occurrence(), { ...s, personal: [...s.personal, s.personal[0]!] }))
  assert.throws(() => match(occurrence(), { ...s, personal: [{ ...s.personal[0]!, id: 'llm-id' }] }))
})

test('08: adopted copies are preferred, renamed/changed copies require choice, archives never reactivated', () => {
  const s = fixture(), template = s.shared[0]!
  s.personal = [{ ...template, id: s.personal[0]!.id, revision: 4, sourceTemplateId: template.id }]
  assert.equal(match(occurrence(), s).candidates.length, 1)
  assert.equal(chooseCatalogExercise(s, 'shared', template.id).source, 'existing')
  s.personal = [{ ...s.personal[0]!, note: 'Modificata' }]
  assert.equal(match(occurrence(), s).preselected, null)
  assert.throws(() => chooseCatalogExercise(s, 'shared', template.id))
  assert.equal(chooseCatalogExercise(s, 'existing', s.personal[0]!.id).source, 'existing')
  s.personal = [{ ...s.personal[0]!, name: 'Rinominato' }]
  assert.equal(match(occurrence(), s).preselected, null)
  s.personal = [{ ...s.personal[0]!, archivedAt: '2026-09-29T00:00:00Z' }]
  assert.equal(match(occurrence(), s).candidates[0]?.adoption, 'archived_copy')
  assert.throws(() => chooseCatalogExercise(s, 'existing', s.personal[0]!.id))
  assert.throws(() => chooseCatalogExercise(s, 'shared', template.id))
})

test('08: new metadata are explicit and complete; snapshot choices cannot inject IDs', () => {
  const s = fixture(), values = exerciseChoiceValues(chooseCatalogExercise(s, 'existing', s.personal[0]!.id))
  assert.ok(validateExerciseChoice(chooseNewExercise('new-1', values, true)).ok)
  assert.throws(() => chooseNewExercise('new-1', values, false))
  for (const field of identityFields) assert.throws(() => chooseNewExercise('new-1', { ...values, [field]: null }, true))
  assert.throws(() => chooseCatalogExercise(s, 'existing', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
  assert.throws(() => chooseCatalogExercise({ ...s, complete: false }, 'existing', s.personal[0]!.id))
  assert.equal(chooseCatalogExercise({ ...s, personal: [] }, 'shared', s.shared[0]!.id).source, 'shared')
})

test('08: pure module has no repository, store or write capability', () => {
  const source = readFileSync(new URL('../src/import/matching/exercises.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"].*(?:persistence|supabase)|\.(?:save|adopt|insert|update|rpc)\(/)
})
