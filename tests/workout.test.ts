import { test } from 'node:test'
import assert from 'node:assert/strict'
import { comparable, findPreviousExercise, formatResult, remainingRest, reusePreviousLoads } from '../src/domain/workout.ts'
import { applyOp, emptyResults, nextRestTimer } from '../src/domain/diary.ts'
import type { WorkoutSession, ExercisePrescription, RestTimerState, SetResult } from '../src/domain/types.ts'

const exercise: ExercisePrescription = { id: 'p1', exerciseId: 'stable-row', name: 'Rematore', area: 'Schiena', sets: 2, target: '10', mode: 'reps', restSeconds: 90, note: '', comparison: { variant: 'unilaterale', equipment: 'manubrio', loadConvention: 'single-dumbbell', perSide: true } }
const completed: SetResult = { load: '12,5', amount: '10', completed: true }
const empty: SetResult = { load: '', amount: '', completed: false }
function session(id: string, date: string, prescription = exercise, done = true): WorkoutSession {
  return { id, date, startedAt: `${date}T10:00:00Z`, completedAt: done ? `${date}T11:00:00Z` : undefined, day: { id: id + '-day', label: id, title: 'Seduta ' + id, subtitle: '', exercises: [prescription] }, results: { [prescription.id]: [{ ...completed }, { ...empty }] } }
}

test('il precedente segue data e identità, anche con una seduta e un nome diversi', () => {
  const old = session('old', '2026-09-18')
  const recent = session('recent', '2026-09-25', { ...exercise, id: 'p-alt', name: 'Nome aggiornato' })
  const current = session('current', '2026-10-02', exercise, false)
  assert.equal(findPreviousExercise([old, recent, current], exercise, current)?.session.id, 'recent')
  assert.equal(findPreviousExercise([recent], exercise, current)?.results[0].load, '12,5')
})

test('nessun confronto tra macchine, varianti, modalità o convenzioni diverse', () => {
  assert.equal(comparable(exercise, { ...exercise, comparison: undefined }), false)
  assert.equal(comparable(exercise, { ...exercise, mode: 'seconds' }), false)
  assert.equal(comparable(exercise, { ...exercise, exerciseId: 'different' }), false)
  for (const mismatch of [{ equipment: 'macchina-2' }, { variant: 'bilaterale' }, { loadConvention: 'total' as const }, { perSide: false }]) {
    assert.equal(comparable(exercise, { ...exercise, comparison: { ...exercise.comparison!, ...mismatch } }), false)
  }
})

test('ignora futuro, seduta corrente, incompleti e ultimi esercizi senza serie eseguite', () => {
  const current = session('current', '2026-10-02', exercise, false)
  const old = session('old', '2026-09-18')
  const noSets = session('empty', '2026-09-25')
  noSets.results.p1 = [{ ...empty }]
  const sessions = [session('future', '2026-10-09'), session('unfinished', '2026-09-30', exercise, false), current, noSets, old]
  assert.equal(findPreviousExercise(sessions, exercise, current)?.session.id, 'old')
  assert.equal(findPreviousExercise([current], exercise, current), undefined)
})

test('riprendere i carichi conserva ripetizioni vuote e non sovrascrive valori inseriti', () => {
  const current = [{ ...empty }, { ...empty, load: '20' }, { ...completed }, { ...empty }]
  const previous = [{ ...completed }, { ...completed }, { ...completed, load: '25' }, { ...completed, completed: false }]
  const result = reusePreviousLoads(current, previous)
  assert.deepEqual(result[0], { load: '12,5', amount: '', completed: false })
  assert.equal(result[1], current[1])
  assert.equal(result[2], current[2])
  assert.equal(result[3], current[3])
  assert.equal(current[0].load, '')
})

test('zero, corpo libero, durata e serie non eseguite hanno una resa distinta', () => {
  assert.equal(formatResult({ load: '0', amount: '0', completed: true }, 'reps'), '0 kg × 0 rip.')
  assert.equal(formatResult({ load: '', amount: '30', completed: true }, 'seconds'), '30 s')
  assert.equal(formatResult({ ...completed, completed: false }, 'reps'), '—')
  assert.equal(formatResult(completed, 'reps', 'lb'), '12,5 lb × 10 rip.')
})

test('il recupero parte una sola volta su Fatto e si annulla riaprendo la stessa serie', () => {
  const day = session('fixture', '2026-10-02').day
  let data = { sessions: [{ id: 'live', date: '2026-10-02', startedAt: '2026-10-02T10:00:00Z', day, results: emptyResults(day) }], mealLogs: {}, dayTypes: {} }
  let timer: RestTimerState | null = null
  const set = (index: number, result: SetResult, now: number) => {
    timer = nextRestTimer(timer, data.sessions[0]!, exercise.id, index, result, now)
    data = applyOp(data, { type: 'set', opId: String(now), sessionId: 'live', prescriptionId: exercise.id, index, result })
  }
  set(0, completed, 1000)
  assert.equal(timer!.deadline, 91000)
  set(0, completed, 2000)
  assert.equal(timer!.deadline, 91000)
  set(1, completed, 5000)
  assert.equal(timer!.deadline, 95000)
  set(0, empty, 6000)
  assert.equal(timer!.setIndex, 1)
  set(1, empty, 7000)
  assert.equal(timer, null)
})

test('il timer usa una scadenza assoluta, recupera il tempo passato e rispetta la pausa', () => {
  const timer: RestTimerState = { sessionId: 's', exerciseId: 'e', exerciseName: 'Esercizio', setIndex: 0, durationSeconds: 90, deadline: 91000, pausedSeconds: null }
  assert.equal(remainingRest(timer, 1000), 90)
  assert.equal(remainingRest(timer, 61000), 30)
  assert.equal(remainingRest(timer, 200000), 0)
  assert.equal(remainingRest({ ...timer, pausedSeconds: 20 }, 200000), 20)
})
