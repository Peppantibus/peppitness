import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mapReviewedWorkout, exerciseChoiceKey, type WorkoutMappingIds } from '../src/import/mapping/workout.ts'
import { createReviewDraft, sequentialLocalIds } from '../src/import/review/draft.ts'
import { applyDecision, setField, chooseCatalog, moveItem, addItem, removeItem, evaluateReadiness, replayDecisions } from '../src/import/review/decisions.ts'
import { validateDraft } from '../src/import/validation/validate.ts'
import { validateProgram, programPayload } from '../src/domain/programs.ts'
import { workoutDaysFromProgram } from '../src/domain/diary.ts'
import { isWeekly, dayForDate } from '../src/domain/weekly.ts'
import { resolvedPayloadContract } from '../src/import/contracts/commit.ts'
import type { WorkoutReviewDraft, NormalizedDocument, JsonValue } from '../src/import/contracts/index.ts'

type Json = any
const read = (path: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/import/${path}`, import.meta.url), 'utf8'))
const uuid = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const source = { sourceHash: 'a'.repeat(64), readerVersion: 'synthetic-fixture/1', textNormalizationVersion: 'peppitness.text-normalization.v1' as const }
let seq = 0
const decision = () => ({ decisionId: `test${++seq}` })
const edit = (draft: WorkoutReviewDraft, id: string, field: string, value: JsonValue, reason: 'user_edit' | 'scope_choice' | 'timer_choice' | 'confirmed_missing' = 'user_edit') => setField(draft, id, field, value, reason, decision()) as WorkoutReviewDraft
function fixture(name = 'workout-spec-example') {
  const entry = read('manifest.json').cases.find((c: Json) => c.id === name)
  const document = read(entry.expectedBlocks) as NormalizedDocument
  let draft = createReviewDraft({ kind: 'workout', extraction: read(entry.expectedProposal), proposalId: uuid(1), jobId: null, source, localIds: sequentialLocalIds('i') })
  for (const d of entry.userDecisions ?? []) draft = applyDecision(draft, d) as WorkoutReviewDraft
  if (draft.current.find(i => i.collection === 'root')!.values.schedule === 'unknown') draft = edit(draft, 'i0', 'schedule', 'rotation')
  return { draft, document }
}
function ids(draft: WorkoutReviewDraft): WorkoutMappingIds {
  return { planId: uuid(2), versionId: uuid(3), items: Object.fromEntries(draft.current.map((i, n) => [i.localId, uuid(10 + n)])),
    exercises: Object.fromEntries(draft.current.filter(i => i.collection === 'exercises').filter(i => i.catalog).map((i, n) => [exerciseChoiceKey(i.catalog!), uuid(100 + n)])) }
}
const map = (draft: WorkoutReviewDraft, document = fixture().document, reserved = ids(draft)) => mapReviewedWorkout(document, draft, reserved)
function success(result: ReturnType<typeof map>) { assert.equal(result.ok, true, JSON.stringify(result.issues)); if (!result.ok) throw new Error(); return result.value }
function fails(result: ReturnType<typeof map>, code?: string) {
  assert.equal(result.ok, false)
  assert.equal('value' in result, false)
  if (code) assert.ok(result.issues.some(i => i.code === code), JSON.stringify(result.issues))
}

test('09: complete golden corpus includes weekly, ABC, ranges, optional sets, limits and manual phases', () => {
  for (const name of ['workout-spec-example', 'workout-incomplete', 'workout-ranges-unicode', 'workout-abc-no-days', 'workout-out-of-bounds', 'workout-partially-interpretable']) {
    const entry = read('manifest.json').cases.find((c: Json) => c.id === name), golden = read(`mapping/workout/${name}.json`)
    let draft = createReviewDraft({ kind: 'workout', extraction: read(entry.expectedProposal), proposalId: uuid(1), jobId: null, source, localIds: sequentialLocalIds('i') })
    for (const d of [...entry.userDecisions, ...golden.additionalDecisions]) draft = applyDecision(draft, d) as WorkoutReviewDraft
    assert.deepEqual(success(map(draft, read(entry.expectedBlocks), golden.ids)), golden.expected, name)
  }
})

test('09: golden DTO + decisions → resolved payload and ProgramDocument, stable IDs and preview', () => {
  const { draft, document } = fixture(), reserved = ids(draft), before = structuredClone(draft)
  const result = success(map(draft, document, reserved))
  const expected = read('mapping/workout/rotation.json')
  assert.deepEqual(result.resolved, expected.resolved)
  assert.deepEqual(result.program, expected.program)
  assert.deepEqual(success(map(draft, document, reserved)), result)
  assert.deepEqual(draft, before)
  assert.equal(validateProgram(result.program, true), null)
  assert.ok(resolvedPayloadContract.workout(result.resolved).ok)
  const p = result.resolved.days[0]!.prescriptions[0]!, preview = workoutDaysFromProgram(result.program)[0]!.exercises[0]!
  assert.equal(preview.sets, p.sets); assert.equal(preview.restSeconds, p.restSeconds)
  assert.equal(result.program.days[0]!.exercises[0]!.repsMax, String(p.repsMax))
  assert.equal(programPayload(result.program).p_days[0]!.exercises[0]!.exercise_id, p.exerciseRef)
  assert.deepEqual(result.provisionalRefs, [p.exerciseRef])
  assert.ok(evaluateReadiness(draft, validateDraft(document, draft).findings, map(draft, document)).ready)
  assert.doesNotMatch(JSON.stringify(result.program), /evidence|sourceRefs|provenance/)
})

test('09: corpus range, optional sets, seconds, per-side, kg, RIR/RPE and ABC retain meaning', () => {
  for (const name of ['workout-incomplete', 'workout-ranges-unicode', 'workout-abc-no-days', 'workout-out-of-bounds']) {
    const { draft, document } = fixture(name)
    const result = success(map(draft, document))
    assert.equal(result.program.days.length, draft.current.filter(i => i.collection === 'sessions').length)
    for (const d of result.program.days) for (const p of d.exercises) {
      assert.equal(validateProgram(result.program, true), null)
      assert.ok(result.resolved.days.flatMap(day => day.prescriptions).some(item => item.id === p.id && String(item.sets) === p.sets))
    }
    if (name === 'workout-ranges-unicode') {
      assert.ok(isWeekly(result.program.days))
      const prescriptions = result.resolved.days[0]!.prescriptions
      assert.match(prescriptions[0]!.note, /90–120/)
      assert.equal(prescriptions[1]!.durationSeconds, 30)
    }
    if (name === 'workout-abc-no-days') { assert.deepEqual(result.program.days.map(d => d.label), ['A', 'B', 'C']); assert.equal(isWeekly(result.program.days), false) }
  }
})

test('09: missing never uses constructor defaults, replay and evidence cannot be bypassed', () => {
  const { draft } = fixture()
  for (const [field, value] of [['restSeconds', null], ['optionalSets', null], ['sets', null], ['repetitions', null], ['rir', { min: 1, max: 2 }], ['rpe', { min: 6, max: 8 }]] as const) fails(map(edit(draft, 'i2', field, value as JsonValue)))
  const changed = structuredClone(draft); (changed.current[2]!.values as Json).restSeconds = { min: 0, max: 0 }
  fails(map(changed), 'workout_invalid_review')
  const noConfirmation = structuredClone(draft)
  noConfirmation.decisions.find(d => d.op === 'set' && d.field === 'optionalSets')!.reason = 'user_edit'
  fails(map(noConfirmation), 'workout_optional_confirmation')
  assert.equal(success(map(edit(draft, 'i2', 'restSeconds', { min: 0, max: 0 }))).resolved.days[0]!.prescriptions[0]!.restSeconds, 0)
  const noCatalog = chooseCatalog(draft, 'i2', null, decision()) as WorkoutReviewDraft
  fails(map(noCatalog))
})

test('09: explicit weekly calendar, rest dates, duplicate weekdays, rotation label ambiguity, order', () => {
  const { draft, document } = fixture('workout-abc-no-days')
  let weekly = edit(draft, 'i0', 'schedule', 'weekly')
  fails(map(weekly, document), 'workout_weekday_required')
  for (const [id, day] of [['i1', 1], ['i3', 3], ['i5', 5]] as const) weekly = edit(weekly, id, 'weekday', day)
  const result = success(map(weekly, document))
  assert.deepEqual(result.program.days.map(d => d.label), ['Lun', 'Mer', 'Ven'])
  assert.equal(dayForDate(result.program.days, '2026-09-29'), undefined)
  assert.match(result.program.days[0]!.note, /Etichetta della fonte: A/)
  fails(map(edit(weekly, 'i3', 'weekday', 1), document))
  fails(map(edit(draft, 'i1', 'weekday', 1), document), 'workout_rotation_weekday')
  const one = fixture().draft
  fails(map(edit(one, 'i1', 'label', 'Lun')), 'workout_rotation_labels')
  fails(map(edit(one, 'i0', 'schedule', 'unknown')), 'workout_schedule_required')
  const reordered = moveItem(draft, 'i5', 'i0', 0, decision()) as WorkoutReviewDraft
  assert.deepEqual(success(map(reordered, document)).program.days.map(d => d.label), ['C', 'A', 'B'])
})

test('09: timers require scalar choice, outside-range choice requires user_edit; decimal intensities', () => {
  const f = fixture('workout-ranges-unicode')
  let draft = edit(f.draft, 'i2', 'restSeconds', { min: 90, max: 120 })
  fails(map(draft, f.document))
  const out = edit(draft, 'i2', 'restSeconds', { min: 180, max: 180 }, 'timer_choice')
  fails(map(out, f.document), 'workout_timer_outside_range')
  draft = edit(draft, 'i2', 'restSeconds', { min: 180, max: 180 }, 'user_edit')
  draft = edit(draft, 'i2', 'rir', { min: 1.5, max: 1.5 })
  draft = edit(draft, 'i2', 'rpe', { min: 8.5, max: 8.5 })
  const result = success(map(draft, f.document))
  assert.equal(result.program.days[0]!.exercises[0]!.rir, '1.5')
  assert.equal(result.resolved.days[0]!.prescriptions[0]!.rpe, 8.5)
  assert.match(result.resolved.days[0]!.prescriptions[0]!.note, /90–120/)
})

test('09: load and tempo instructions remain notes; catalogue and source identity stay distinct', () => {
  let { draft } = fixture()
  draft = edit(draft, 'i2', 'loadInstruction', '20 kg totali, aumentare se facile')
  draft = edit(draft, 'i2', 'tempoInstruction', '3–1–2')
  draft = edit(draft, 'i2', 'perSide', true)
  fails(map(draft), 'workout_identity_choice_required')
  const chosen = draft.current.find(i => i.collection === 'exercises')!.catalog!
  draft = chooseCatalog(draft, 'i2', null, decision()) as WorkoutReviewDraft
  draft = chooseCatalog(draft, 'i2', chosen, decision()) as WorkoutReviewDraft
  const result = success(map(draft))
  const p = result.resolved.days[0]!.prescriptions[0]!
  assert.match(p.note, /20 kg totali/); assert.match(p.note, /3–1–2/); assert.match(p.note, /perSide: true/)
  assert.equal(p.sets, 3); assert.equal(p.repsMin, 8)
  assert.equal(result.program.days[0]!.exercises[0]!.exercise.name, 'Squat')
  assert.equal('load' in p, false)
})

test('09: phases and supersets require explicit scope instruction and retain rule targets and limitations', () => {
  const f = fixture('workout-partially-interpretable')
  fails(map(f.draft, f.document), 'workout_scope_instruction_required')
  let draft = f.draft
  for (const item of draft.current.filter(i => i.collection === 'complexRules')) {
    draft = edit(draft, item.localId, 'text', `Importo la prima settimana. ${item.values.text}. Applicare manualmente, senza variazione automatica.`, 'scope_choice')
  }
  const result = success(map(draft, f.document))
  assert.match(result.program.guidance, /Limite di esecuzione/)
  assert.match(result.program.guidance, /settimana 4 scarico al 60%/)
  assert.match(result.program.guidance, /seduta A, esercizio 2: Curl/)
  assert.match(result.program.guidance, /prima settimana/)
  fails(map(edit(draft, 'i2', 'sets', 4), f.document), 'workout_scope_stale')
  const noTarget = removeItem(draft, 'i4', 'scope_choice', decision()) as WorkoutReviewDraft
  fails(map(noTarget, f.document), 'workout_rule_target_missing')
})

test('09: ID reservations and catalog bindings are unique, stable and shared per identity', () => {
  const f = fixture(), exercise = f.draft.current.find(i => i.collection === 'exercises')!
  let draft = addItem(f.draft, { collection: 'exercises', parentLocalId: 'i1', localId: 'extra', values: exercise.values }, decision()) as WorkoutReviewDraft
  draft = chooseCatalog(draft, 'extra', exercise.catalog, decision()) as WorkoutReviewDraft
  const mapped = success(map(draft))
  assert.equal(mapped.resolved.catalog.length, 1)
  assert.equal(mapped.resolved.days[0]!.prescriptions[0]!.exerciseRef, mapped.resolved.days[0]!.prescriptions[1]!.exerciseRef)
  assert.notEqual(mapped.resolved.days[0]!.prescriptions[0]!.id, mapped.resolved.days[0]!.prescriptions[1]!.id)
  const reservation = ids(f.draft)
  fails(map(f.draft, f.document, { ...reservation, items: {} }))
  fails(map(f.draft, f.document, { ...reservation, versionId: reservation.planId }))
  fails(map(f.draft, f.document, { ...reservation, exercises: {} }))
  const values = exercise.catalog!.source === 'new' ? exercise.catalog!.values : exercise.catalog!.seen
  for (const choice of [{ source: 'existing', personalId: uuid(900), revision: 3, seen: values }, { source: 'shared', templateId: uuid(901), seen: values }] as const) {
    const chosen = chooseCatalog(f.draft, 'i2', choice, decision()) as WorkoutReviewDraft
    const result = success(map(chosen))
    assert.equal(result.provisionalRefs.length, choice.source === 'existing' ? 0 : 1)
    if (choice.source === 'existing') assert.equal(result.resolved.catalog[0]!.ref, choice.personalId)
  }
})

test('09: all numeric bounds, real cycle dates and combined text limits fail without truncation', () => {
  const f = fixture()
  for (const [field, values] of Object.entries({ sets: [0, 1001, 1.5], optionalSets: [-1, 1001, .5], restSeconds: [-1, 86401, .5], rir: [-1, 11, 1e-7], rpe: [0, 11] })) {
    for (const value of values) fails(map(edit(f.draft, 'i2', field, ['sets', 'optionalSets'].includes(field) ? value : { min: value, max: value })))
  }
  for (const value of [0, 10001, 1.5]) fails(map(edit(f.draft, 'i2', 'repetitions', { min: value, max: value })))
  for (const value of [{ startDate: null, weeks: 4 }, { startDate: '2026-02-30', weeks: 4 }, { startDate: '1999-12-31', weeks: 4 }, { startDate: '2200-01-02', weeks: 4 }, { startDate: '2026-01-01', weeks: 53 }]) fails(map(edit(f.draft, 'i0', 'cycle', value)))
  assert.deepEqual(success(map(edit(f.draft, 'i0', 'cycle', { startDate: '2028-02-29', weeks: 52 }))).cycle, { start: '2028-02-29', weeks: 52 })
  for (const [id, field, value] of [['i0', 'title', 'a'.repeat(161)], ['i0', 'guidance', ['a'.repeat(16001)]], ['i1', 'title', 'a'.repeat(161)], ['i1', 'label', 'a'.repeat(41)], ['i1', 'notes', ['a'.repeat(4001)]], ['i2', 'notes', ['a'.repeat(3990)]], ['i2', 'loadInstruction', 'a'.repeat(4000)]] as const) fails(map(edit(f.draft, id, field, value as JsonValue)))
  const timed = fixture('workout-ranges-unicode')
  for (const value of [0, 86401, .5]) fails(map(edit(timed.draft, 'i3', 'durationSeconds', { min: value, max: value }), timed.document))
})

test('09: full collection bounds and reservations survive reorder without renumbering', () => {
  const f = fixture(), exercise = f.draft.current.find(i => i.collection === 'exercises')!
  const expand = (dayCount: number, exerciseCount: number) => {
    const draft = structuredClone(f.draft)
    for (let n = 1; n < dayCount; n++) {
      draft.decisions.push({ op: 'add', decisionId: `day-d${n}`, localId: `day${n}`, parentLocalId: 'i0', collection: 'sessions', index: n,
        reason: 'user_edit', values: { label: `Seduta ${n}`, title: `Seduta ${n}`, weekday: null, notes: [] } })
      draft.decisions.push({ op: 'add', decisionId: `day-ex-d${n}`, localId: `dayex${n}`, parentLocalId: `day${n}`, collection: 'exercises', index: 0,
        reason: 'user_edit', values: exercise.values })
      draft.decisions.push({ op: 'catalog', decisionId: `day-cat-d${n}`, localId: `dayex${n}`, before: null, after: exercise.catalog, reason: 'catalog_choice' })
    }
    for (let n = 1; n < exerciseCount; n++) {
      draft.decisions.push({ op: 'add', decisionId: `ex-d${n}`, localId: `ex${n}`, parentLocalId: 'i1', collection: 'exercises', index: n,
        reason: 'user_edit', values: exercise.values })
      draft.decisions.push({ op: 'catalog', decisionId: `cat-d${n}`, localId: `ex${n}`, before: null, after: exercise.catalog, reason: 'catalog_choice' })
    }
    draft.current = replayDecisions(draft) as WorkoutReviewDraft['current']
    return draft
  }
  const full = expand(50, 200), reserved = ids(full), valid = success(map(full, f.document, reserved))
  assert.equal(valid.program.days.length, 50); assert.equal(valid.program.days[0]!.exercises.length, 200)
  const reordered = moveItem(full, 'day49', 'i0', 0, decision()) as WorkoutReviewDraft
  const reorderedOutput = success(map(reordered, f.document, reserved))
  assert.equal(reorderedOutput.program.days[0]!.id, valid.program.days[49]!.id)
  assert.equal(reorderedOutput.program.days[1]!.exercises[0]!.id, valid.program.days[0]!.exercises[0]!.id)
  fails(map(expand(51, 1))); fails(map(expand(1, 201)))
})
