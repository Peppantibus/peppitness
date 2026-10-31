import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dayFromSnapshot, emptyDiary, emptyResults, replay } from '../src/domain/diary.ts'
import type { SnapshotExercise } from '../src/domain/diary.ts'
import { defaultExercisePosition, editSessionExercises, exercisePositionOptions, hasExerciseValues } from '../src/domain/session-exercises.ts'
import type { ExercisePosition } from '../src/domain/session-exercises.ts'
import { findPreviousExercise, nextExercise, sessionOrder, sessionProgress } from '../src/domain/workout.ts'
import { DiaryStore, memoryStorage } from '../src/persistence/diary-store.ts'
import { DiaryFailure } from '../src/persistence/diary-repository.ts'
import type { DiaryTransport } from '../src/persistence/diary-repository.ts'
import type { WorkoutSession } from '../src/domain/types.ts'

const curl: SnapshotExercise = { id: randomUUID(), exercise_id: randomUUID(), name: 'Curl al cavo', variant: '', equipment: 'Cavo', load_convention: 'total', load_unit: 'kg', per_side: false, exercise_note: '', mode: 'reps', sets: 2, optional_sets: 0, reps_min: 8, reps_max: 12, duration_seconds: null, rest_seconds: 60, rir: null, rpe: null, note: '' }
const calf: SnapshotExercise = { ...curl, id: randomUUID(), exercise_id: randomUUID(), name: 'Calf raise in piedi alla macchina' }
const added: SnapshotExercise = { ...curl, id: randomUUID(), exercise_id: randomUUID(), name: 'Rematore', session_added: true, sets: 3 }
const day = dayFromSnapshot(randomUUID(), { label: 'A', title: 'Test', note: '', plan_title: 'Test', version_number: 1, exercises: [curl, calf] })
const session = (): WorkoutSession => ({ id: randomUUID(), date: '2026-10-31', startedAt: '2026-10-31T10:00:00Z', day: structuredClone(day), results: emptyResults(day) })
const add = (s: WorkoutSession, position: ExercisePosition, exercise = added, allowDuplicate = false) => editSessionExercises(s, { action: 'add', exercise, position, allowDuplicate })
const ids = (s: WorkoutSession) => s.day.exercises.map(item => item.id)

test('posizione predefinita: completato precede card successiva; lavoro effettivo e fallback alla fine', () => {
  const s = session()
  s.results[curl.id] = [{ load: '20', amount: '10', completed: true }, { load: '20', amount: '10', completed: true }]
  assert.equal(nextExercise(s, [], curl.id), calf.id)
  const proposed = defaultExercisePosition(s, { lastCompletedId: curl.id, workingId: calf.id })
  assert.deepEqual(ids(add(s, proposed)), [curl.id, added.id, calf.id])
  assert.deepEqual(defaultExercisePosition(s, { workingId: calf.id }), { kind: 'after', id: calf.id })
  assert.deepEqual(defaultExercisePosition(s), { kind: 'end' })
  assert.deepEqual(defaultExercisePosition(s, { lastCompletedId: 'removed' }), { kind: 'end' })
})

test('scelta esplicita per occorrenza, inizio, fine e nomi duplicati', () => {
  const s = session()
  assert.deepEqual(ids(add(s, { kind: 'after', id: calf.id })), [curl.id, calf.id, added.id])
  assert.deepEqual(ids(add(s, { kind: 'start' })), [added.id, curl.id, calf.id])
  assert.deepEqual(ids(add(s, { kind: 'end' })), [curl.id, calf.id, added.id])
  s.day.exercises[1] = { ...s.day.exercises[0]!, id: calf.id }
  const options = exercisePositionOptions(s.day.exercises)
  assert.equal(new Set(options.map(item => item.label)).size, 2)
  assert.ok(options.every(item => item.label.includes(curl.name)))
  assert.deepEqual(ids(add(s, { kind: 'after', id: calf.id })), [curl.id, calf.id, added.id])
  assert.equal(add(s, { kind: 'after', id: 'missing' }), s)
})

test('spostamento conserva risultati e snapshot; autoreferenza esclusa; Fallo dopo non cambia ordine persistente', () => {
  let s = add(session(), { kind: 'end' })
  s.results[added.id]![0] = { load: '12,5', amount: '8', completed: true }
  const original = structuredClone(s.results)
  assert.deepEqual(sessionOrder(s.day.exercises, [curl.id]).map(item => item.id), [calf.id, added.id, curl.id])
  s = editSessionExercises(s, { action: 'move', id: added.id, position: { kind: 'after', id: curl.id } })
  assert.deepEqual(ids(s), [curl.id, added.id, calf.id])
  assert.deepEqual(s.results, original)
  assert.deepEqual(s.day.exercises[1]!.snapshot, added)
  assert.ok(!exercisePositionOptions(s.day.exercises, added.id).some(item => item.id === added.id))
  assert.equal(editSessionExercises(s, { action: 'move', id: added.id, position: { kind: 'after', id: added.id } }), s)
})

test('rimozione rapida solo senza valori; zero, bozze e spunte richiedono conferma', () => {
  const s = add(session(), { kind: 'end' })
  assert.equal(hasExerciseValues(s, added.id), false)
  assert.deepEqual(ids(editSessionExercises(s, { action: 'remove', id: added.id, confirmed: false })), [curl.id, calf.id])
  for (const value of [{ load: '0', amount: '', completed: false }, { load: '12,', amount: '', completed: false }, { load: '', amount: '30', completed: true }]) {
    s.results[added.id]![0] = value
    assert.equal(hasExerciseValues(s, added.id), true)
    assert.equal(editSessionExercises(s, { action: 'remove', id: added.id, confirmed: false }), s)
    const removed = editSessionExercises(s, { action: 'remove', id: added.id, confirmed: true })
    assert.equal(removed.results[added.id], undefined)
    assert.deepEqual(removed.results[curl.id], s.results[curl.id])
  }
})

test('avanzamento, replay idempotente, duplicati espliciti e sedute concluse immutabili', () => {
  const s = session(), base = structuredClone(s)
  s.results[curl.id]![0] = { load: '20', amount: '8', completed: true }
  const updated = add(s, { kind: 'start' })
  assert.deepEqual(sessionProgress(updated), { required: 7, completedRequired: 1 })
  updated.results[added.id]![0] = { load: '10', amount: '8', completed: true }
  assert.equal(add(updated, { kind: 'end' }), updated)
  assert.equal(add(s, { kind: 'end' }, { ...added, exercise_id: curl.exercise_id }), s)
  assert.equal(add(s, { kind: 'end' }, { ...added, exercise_id: curl.exercise_id }, true).day.exercises.length, 3)
  const finished = { ...updated, completedAt: '2026-10-31T11:00:00Z' }
  assert.equal(add(finished, { kind: 'end' }, { ...added, id: randomUUID() }), finished)
  assert.equal(editSessionExercises(finished, { action: 'remove', id: added.id, confirmed: true }), finished)
  assert.deepEqual(s.day, base.day)
  const other = session()
  const view = replay({ ...emptyDiary(), sessions: [s, other] }, [{ type: 'session-edit', opId: randomUUID(), sessionId: s.id, expectedOrder: ids(s), edit: { action: 'add', exercise: added, position: { kind: 'start' }, allowDuplicate: false } }])
  assert.deepEqual(view.sessions[1], other)
})

test('contesto affidabile salvato con le serie: reload offline conserva ultimo completato anche dopo lavoro sul successivo', async () => {
  const s = session(), storage = memoryStorage()
  const transport = { loadAll: async () => ({ data: { ...emptyDiary(), sessions: [s] }, revisions: {} }), insert: async () => { throw new DiaryFailure('unavailable') } } as unknown as DiaryTransport
  let store = new DiaryStore(transport, storage, 'test-context')
  await store.refresh()
  for (let i = 0; i < 2; i++) store.updateSet(s.id, curl.id, i, { load: '20', amount: '8', completed: true })
  store.updateSet(s.id, calf.id, 0, { load: '40', amount: '', completed: false })
  assert.deepEqual(defaultExercisePosition(store.getSnapshot().view.sessions[0]!, store.getSnapshot().workoutContext?.[s.id]), { kind: 'after', id: curl.id })
  store.stop()
  store = new DiaryStore(transport, storage, 'test-context')
  try {
    await store.flush()
    assert.deepEqual(defaultExercisePosition(store.getSnapshot().view.sessions[0]!, store.getSnapshot().workoutContext?.[s.id]), { kind: 'after', id: curl.id })
  } finally { store.stop() }
})

test('esercizio aggiunto riconosce i carichi precedenti con ID di occorrenza diversi e snapshot confrontabili', () => {
  const previous = add(session(), { kind: 'end' })
  previous.completedAt = '2026-10-31T11:00:00Z'
  previous.results[added.id]![0] = { load: '22,5', amount: '10', completed: true }
  const current = add({ ...session(), date: '2026-11-02', startedAt: '2026-11-02T10:00:00Z' }, { kind: 'end' }, { ...added, id: randomUUID() })
  const exercise = current.day.exercises.at(-1)!
  assert.notEqual(exercise.id, added.id)
  assert.deepEqual(findPreviousExercise([previous], exercise, current)?.results[0], { load: '22,5', amount: '10', completed: true })
  assert.ok(current.results[exercise.id]!.every(set => !set.completed && set.amount === '' && set.load === ''))
})
