import { test } from 'node:test'
import assert from 'node:assert/strict'
import { beats, personalRecords, sessionRecords, sessionSummary, setScore } from '../src/domain/records.ts'
import type { ExercisePrescription, SetResult, WorkoutDay, WorkoutSession } from '../src/domain/types.ts'

const bench: ExercisePrescription = { id: 'p-bench', exerciseId: 'bench', name: 'Panca', area: '', sets: 3, target: '8', mode: 'reps', restSeconds: 90, note: '', loadUnit: 'kg', comparison: { variant: '', equipment: '', loadConvention: 'total', perSide: false } }
const plank: ExercisePrescription = { ...bench, id: 'p-plank', exerciseId: 'plank', name: 'Plank', sets: 1, mode: 'seconds', comparison: { variant: '', equipment: '', loadConvention: 'bodyweight', perSide: false } }
const free: ExercisePrescription = { ...bench, id: 'p-free', exerciseId: 'free', name: 'Senza confronto', comparison: undefined }
const day: WorkoutDay = { id: 'mon', label: 'Lun', title: 'Petto', subtitle: '', exercises: [bench, plank, free] }
const set = (load: string, amount: string, completed = true): SetResult => ({ load, amount, completed })
function session(id: string, date: string, results: Record<string, SetResult[]>, done = true, minutes = 60): WorkoutSession {
  const start = `${date}T10:00:00.000Z`
  return { id, date, day, startedAt: start, ...(done ? { completedAt: new Date(Date.parse(start) + minutes * 60_000).toISOString() } : {}), results }
}

test('regola del record: più carico, oppure stesso carico e più ripetizioni', () => {
  assert.equal(beats({ load: 62.5, amount: 5 }, { load: 60, amount: 10 }), true)
  assert.equal(beats({ load: 60, amount: 9 }, { load: 60, amount: 8 }), true)
  assert.equal(beats({ load: 57.5, amount: 15 }, { load: 60, amount: 8 }), false, 'più ripetizioni con meno carico non è un record')
  assert.equal(beats({ load: 60, amount: 8 }, { load: 60, amount: 8 }), false, 'pareggio non è un record')
  assert.deepEqual(setScore(set('12,5', '10')), { load: 12.5, amount: 10 })
  assert.deepEqual(setScore(set('', '30')), { load: 0, amount: 30 }, 'senza carico conta la quantità')
  assert.equal(setScore(set('60', '8', false)), null, 'serie non completata')
  assert.equal(setScore(set('60', '0')), null, 'zero ripetizioni non è una serie valida')
})

test('record in seduta: uno per esercizio, mai alla prima volta né senza confronto', () => {
  const first = session('a', '2026-09-28', { 'p-bench': [set('60', '8'), set('60', '8')], 'p-plank': [set('', '40')], 'p-free': [set('20', '10')] })
  assert.equal(sessionRecords(first, [first]).size, 0, 'prima volta: nessun record')
  const current = session('b', '2026-10-05', { 'p-bench': [set('60', '9'), set('62,5', '6'), set('62,5', '6')], 'p-plank': [set('', '40')], 'p-free': [set('40', '10')] }, false)
  const records = sessionRecords(current, [first, current])
  assert.deepEqual([...records], [['p-bench', 1]], 'la migliore (prima a pari merito); plank pari; esercizio senza confronto escluso')
  const later = session('c', '2026-10-12', { 'p-bench': [set('62,5', '6')] })
  assert.equal(sessionRecords(current, [first, current, later]).size, 1, 'le sedute successive non contano')
})

test('record di sempre per il programma, con la data in cui è stato raggiunto', () => {
  const sessions = [
    session('a', '2026-09-28', { 'p-bench': [set('60', '8')], 'p-plank': [set('', '45')] }),
    session('b', '2026-10-05', { 'p-bench': [set('62,5', '6')], 'p-plank': [set('', '40')] }),
    session('c', '2026-10-12', { 'p-bench': [set('62,5', '6')] }),
    session('d', '2026-10-19', { 'p-bench': [set('100', '1', false)] }, false),
  ]
  assert.deepEqual(personalRecords([day], sessions).map(r => [r.exercise.id, r.score.load, r.score.amount, r.date]),
    [['p-bench', 62.5, 6, '2026-10-05'], ['p-plank', 0, 45, '2026-09-28']])
})

test('riepilogo: durata, serie, volume in kg, record e confronto con l’ultima volta', () => {
  const previous = session('a', '2026-09-28', { 'p-bench': [set('60', '8'), set('60', '8')] })
  const current = session('b', '2026-10-05', { 'p-bench': [set('60', '10'), set('62,5', '8'), set('', '', false)], 'p-plank': [set('', '45')] }, true, 52)
  const summary = sessionSummary(current, [previous, current])
  assert.equal(summary.minutes, 52)
  assert.equal(summary.sets, 3)
  assert.equal(summary.requiredSets, 7)
  assert.equal(summary.volume, 1100, '60×10 + 62,5×8; il plank (secondi) non entra nel volume')
  assert.deepEqual(summary.records.map(r => [r.exercise.id, r.index]), [['p-bench', 1]])
  assert.deepEqual(summary.previous, { date: '2026-09-28', volume: 960, sets: 2 })
  assert.equal(sessionSummary(session('x', '2026-10-05', {}, true, 400), []).minutes, null, 'seduta rimasta aperta: durata non affidabile')
  assert.equal(sessionSummary(previous, [previous]).previous, null)
})
