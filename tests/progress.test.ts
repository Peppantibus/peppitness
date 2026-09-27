import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adherence, cycleInfo, exerciseTrends, mondayOf, weeklyProgress } from '../src/domain/progress.ts'
import type { ExercisePrescription, SetResult, WorkoutDay, WorkoutSession } from '../src/domain/types.ts'

const bench: ExercisePrescription = { id: 'p-bench', exerciseId: 'bench', name: 'Panca', area: '', sets: 3, target: '8', mode: 'reps', restSeconds: 90, note: '', loadUnit: 'kg', comparison: { variant: '', equipment: '', loadConvention: 'total', perSide: false } }
const plank: ExercisePrescription = { ...bench, id: 'p-plank', exerciseId: 'plank', name: 'Plank', mode: 'seconds', comparison: { variant: '', equipment: '', loadConvention: 'bodyweight', perSide: false } }
const days: WorkoutDay[] = [
  { id: 'mon', label: 'Lun', title: 'Petto', subtitle: '', exercises: [bench] },
  { id: 'wed', label: 'Mer', title: 'Schiena', subtitle: '', exercises: [plank] },
]
const set = (load: string, amount: string, completed = true): SetResult => ({ load, amount, completed })
function session(id: string, date: string, day: WorkoutDay, results: Record<string, SetResult[]>, done = true): WorkoutSession {
  return { id, date, day, startedAt: `${date}T10:00:00Z`, ...(done ? { completedAt: `${date}T11:00:00Z` } : {}), results }
}

test('ciclo: settimana corrente, prima dell’inizio e dopo la fine; lunedì successivo', () => {
  const cycle = { start: '2026-09-28', weeks: 8 }
  assert.deepEqual(cycleInfo(cycle, '2026-09-28'), { start: '2026-09-28', end: '2026-11-22', weeks: 8, week: 1, status: 'active' })
  assert.equal(cycleInfo(cycle, '2026-10-12').week, 3)
  assert.equal(cycleInfo(cycle, '2026-11-22').week, 8)
  assert.equal(cycleInfo(cycle, '2026-11-23').status, 'finished')
  assert.equal(cycleInfo(cycle, '2026-09-27').status, 'upcoming')
  assert.equal(mondayOf('2026-09-30', true), '2026-10-05')
  assert.equal(mondayOf('2026-09-28', true), '2026-09-28')
  assert.equal(mondayOf('2026-10-04'), '2026-09-28')
})

test('costanza: fatte, saltate, spostate nella settimana e ancora da fare', () => {
  const cycle = { start: '2026-09-28', weeks: 3 }
  const sessions = [
    session('a', '2026-09-28', days[0]!, {}),
    session('b', '2026-10-01', days[0]!, {}), // spostata: copre il mercoledì della stessa settimana
    session('c', '2026-10-05', days[0]!, {}),
    session('d', '2026-10-07', days[1]!, {}, false), // non completata: non conta
  ]
  const weeks = weeklyProgress(days, sessions, cycle, '2026-10-08')
  assert.deepEqual(weeks[0]!.slots.map(slot => [slot.date, slot.state]), [['2026-09-28', 'done'], ['2026-09-30', 'done']])
  assert.deepEqual(weeks[1]!.slots.map(slot => slot.state), ['done', 'missed'])
  assert.deepEqual(weeks[2]!.slots.map(slot => slot.state), ['planned', 'planned'])
  assert.ok(weeks[1]!.current && !weeks[0]!.current)
  assert.deepEqual(adherence(weeks), { done: 3, due: 4, planned: 6, extra: 0, percent: 75 })
})

test('andamento: carico massimo per esercizi con carico, volume per quelli a tempo', () => {
  const sessions = [
    session('1', '2026-09-28', days[0]!, { 'p-bench': [set('60', '8'), set('62,5', '6'), set('', '', false)] }),
    session('2', '2026-10-05', days[0]!, { 'p-bench': [set('65', '8')] }),
    session('3', '2026-09-30', days[1]!, { 'p-plank': [set('', '40'), set('', '40')] }),
    session('4', '2026-10-07', days[1]!, { 'p-plank': [set('', '30')] }),
  ]
  const [panca, plankTrend] = exerciseTrends(days, sessions)
  assert.equal(panca!.metric, 'best')
  assert.deepEqual(panca!.points.map(point => point.best), [62.5, 65])
  assert.equal(panca!.points[0]!.volume, 60 * 8 + 62.5 * 6)
  assert.equal(panca!.change, 'up')
  assert.equal(plankTrend!.metric, 'volume')
  assert.deepEqual(plankTrend!.points.map(point => point.volume), [80, 30])
  assert.equal(plankTrend!.change, 'down')
  assert.equal(exerciseTrends(days, sessions, '2026-10-06')[0]!.change, 'none', 'finestra senza sedute')
})
