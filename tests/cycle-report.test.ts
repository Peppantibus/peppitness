import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cycleReport } from '../src/domain/cycle-report.ts'
import { shiftDate } from '../src/domain/dates.ts'
import { personalRecords, sessionRecords } from '../src/domain/records.ts'
import type { ExercisePrescription, SetResult, WorkoutDay, WorkoutSession } from '../src/domain/types.ts'
import { findPreviousExercise } from '../src/domain/workout.ts'

const bench: ExercisePrescription = { id: 'bench', exerciseId: 'catalog-bench', name: 'Panca inclinata al multipower', area: 'Petto', muscleGroup: 'Petto', sets: 2, target: '6', mode: 'reps', restSeconds: 90, note: '',
  loadUnit: 'kg', comparison: { variant: 'inclinata', equipment: 'multipower', loadConvention: 'total', perSide: false } }
const row: ExercisePrescription = { ...bench, id: 'row', exerciseId: 'catalog-row', name: 'Rematore al cavo', muscleGroup: 'Schiena' }
const day: WorkoutDay = { id: 'monday', label: 'Lun', title: 'Seduta A', subtitle: '', exercises: [bench, row] }
const cycle = { start: '2026-09-07', weeks: 8 }
const weekDate = (week: number) => shiftDate(cycle.start, 7 * (week - 1))
const set = (load: string, amount = '6', completed = true): SetResult => ({ load, amount, completed })

function session(id: string, week: number, results: WorkoutSession['results'] = {}, metadata: Partial<WorkoutSession> = {}): WorkoutSession {
  const date = weekDate(week)
  return { id, planId: 'plan', day, date, startedAt: `${date}T12:00:00Z`, completedAt: `${date}T13:00:00Z`, results, ...metadata }
}

const report = (sessions: WorkoutSession[], today = weekDate(9)) => cycleReport('plan', sessions, cycle, today, [day])

test('costanza: conta solo le sedute concluse del programma entro il ciclo', () => {
  const result = report([
    session('a', 1), session('b', 1), session('c', 8),
    session('other', 3, {}, { planId: 'other' }), session('before', 0), session('after', 9),
    session('active', 4, {}, { completedAt: undefined }), session('free', 7, {}, { kind: 'free' }),
  ])
  assert.equal(result.sessions, 3)
  assert.equal(result.activeWeeks, 2)
  assert.equal(result.streak, 1)
  assert.deepEqual(result.weeks, [2, 0, 0, 0, 0, 0, 0, 1])
})

test('pause: rileva più interruzioni, eventuali riprese e settimane vuote dopo l’ultima seduta', () => {
  const result = report([session('a', 2), session('b', 4), session('c', 7)])
  assert.deepEqual(result.pauses, [
    { firstWeek: 3, lastWeek: 3, resumedIn: 4 },
    { firstWeek: 5, lastWeek: 6, resumedIn: 7 },
    { firstWeek: 8, lastWeek: 8, resumedIn: null },
  ])
})

test('pause: ciclo senza sedute o con allenamenti ogni settimana', () => {
  assert.deepEqual(report([]).pauses, [])
  assert.deepEqual(report(Array.from({ length: 8 }, (_, i) => session(String(i), i + 1))).pauses, [])
})

test('il riepilogo aspetta la fine effettiva del ciclo salvato', () => {
  const tenWeeks = { ...cycle, weeks: 10 }
  const sessions = [session('a', 1), session('b', 10)]
  const active = cycleReport('plan', sessions, tenWeeks, shiftDate(weekDate(11), -1))
  assert.equal(active.info.status, 'active')
  assert.deepEqual(active.weeks, [])
  assert.equal(cycleReport('plan', sessions, tenWeeks, weekDate(0)).info.status, 'upcoming')
  const finished = cycleReport('plan', sessions, tenWeeks, weekDate(11))
  assert.equal(finished.info.status, 'finished')
  assert.equal(finished.weeks.length, 10)
  assert.equal(finished.sessions, 2)
})

test('record: richiede una precedente seduta valida e riporta il giorno del nuovo risultato', () => {
  const first = session('a', 1, { bench: [set('40'), set('50')] })
  const second = session('b', 7, { bench: [set('52,5'), set('60', '6', false)] })
  assert.equal(report([first]).record, null)
  assert.deepEqual(report([first, second]).record?.score, { load: 52.5, amount: 6 })
  assert.equal(report([first, second]).record?.date, weekDate(7))
})

test('record: un precedente superiore da un allenamento libero vale ancora, un risultato futuro non cancella un record del ciclo', () => {
  const first = session('a', 1, { bench: [set('40')] })
  const second = session('b', 7, { bench: [set('52,5')] })
  const previous = session('c', 0, { bench: [set('70')] }, { kind: 'free', planId: undefined })
  const future = session('d', 10, { bench: [set('100')] })
  assert.equal(report([first, second, previous]).record, null)
  assert.equal(report([first, second, future], weekDate(11)).record?.score.load, 52.5)
})

test('record: unità, attrezzo e impostazioni per lato distinte', () => {
  const first = session('a', 1, { bench: [set('40')] })
  for (const changed of [{ ...bench, loadUnit: 'lb' as const }, { ...bench, comparison: { ...bench.comparison!, equipment: 'manubri' } }, { ...bench, comparison: { ...bench.comparison!, perSide: true } }]) {
    const second = session('b', 7, { bench: [set('60')] }, { day: { ...day, exercises: [changed] } })
    assert.equal(report([first, second]).record, null)
  }
})

test('macchinario diverso e seduta di prova: restano nel diario e non cambiano i record abituali', () => {
  const first = session('a', 1, { bench: [set('40')], row: [set('25')] })
  const different = session('b', 5, { bench: [set('150')], row: [set('30')] }, { differentMachines: { bench: bench.exerciseId } })
  const trial = session('c', 6, { bench: [set('180')], row: [set('90')] }, { trial: true })
  const last = session('d', 7, { bench: [set('50')], row: [set('35')] }, { note: 'Macchinario diverso dal solito' })
  const sessions = [first, different, trial, last]
  const result = report(sessions)
  assert.equal(result.sessions, 4)
  assert.equal(findPreviousExercise(sessions, bench, different), undefined)
  assert.equal(findPreviousExercise(sessions, bench, last)?.session.id, 'a')
  assert.equal(findPreviousExercise(sessions, row, last)?.session.id, 'b')
  assert.deepEqual([...sessionRecords(different, sessions).keys()], ['row'])
  assert.deepEqual([...sessionRecords(last, sessions).keys()], ['bench', 'row'])
  assert.equal(personalRecords([day], sessions).find(item => item.exercise.id === 'bench')?.score.load, 50)
  assert.equal(result.record?.score.load, 50)
})

test('costanza: distingue il miglior blocco consecutivo dal totale delle settimane attive', () => {
  const result = report([1, 2, 4, 5, 6, 8].map(week => session(String(week), week)))
  assert.equal(result.activeWeeks, 6)
  assert.equal(result.streak, 3)
})

test('panoramica prima–metà–fine: conserva le serie reali e mostra 60 × 6 della settimana 7', () => {
  const sessions = [20, 30, 35, 40, 45, 55, 60, 60].map((load, i) =>
    session(String(i), i + 1, { bench: [set(String(load), i === 7 ? '4' : '6')] }))
  const extra = session('alt', 8, { bench: [set('150')] }, { differentMachines: { bench: bench.exerciseId } })
  const result = report([...sessions, extra])
  assert.equal(result.sets, 9)
  assert.deepEqual(result.groups[0]?.points.map(point => [point.set.load, point.set.amount, point.week]),
    [['20', '6', 1], ['40', '6', 4], ['60', '6', 7]])
  assert.equal(result.groups.length, 1)
})

test('panoramica: le croci battono il picco isolato e un gruppo può restare stabile con due punti', () => {
  const fly = { ...bench, id: 'fly', exerciseId: 'catalog-fly', name: 'Croci ai cavi' }
  const press = { ...bench, id: 'press', exerciseId: 'catalog-press', name: 'Chest press' }
  const trainingDay = { ...day, exercises: [bench, press, fly, row] }
  const sessions = Array.from({ length: 8 }, (_, i) => session(String(i), i + 1, {
    bench: [set(i === 7 ? '100' : '40')],
    press: [set('50', '10')],
    fly: [set(String(8 + i), '12')],
    ...(i === 0 || i === 7 ? { row: [set('25', '8')] } : {}),
  }, { day: trainingDay }))
  const result = cycleReport('plan', sessions, cycle, weekDate(9), [trainingDay])
  assert.equal(result.groups[0]?.exercise.name, fly.name)
  assert.equal(result.groups[0]?.trend, 'progress')
  assert.equal(result.featuredGroup, 'Petto')
  assert.equal(result.groups[1]?.trend, 'stable')
  assert.deepEqual(result.groups[1]?.points.map(point => point.week), [1, 8])
})

test('panoramica: mostra una singola serie utile e omette i gruppi senza registrazioni utilizzabili', () => {
  const first = session('a', 2, { bench: [set('30')], row: [set('15'), set('20')] })
  const otherEquipment = session('b', 6, { bench: [set('200')], row: [set('100')] },
    { differentMachines: { bench: bench.exerciseId, row: row.exerciseId } })
  const result = report([first, otherEquipment])
  assert.deepEqual(result.groups.map(group => [group.label, group.trend, group.points.map(point => [point.set.load, point.week])]), [
    ['Petto', undefined, [['30', 2]]],
    ['Schiena', undefined, [['20', 2]]],
  ])
  assert.deepEqual(report([otherEquipment]).groups, [])
  assert.equal(result.featuredGroup, undefined)
})

test('la storia della progressione sceglie il gruppo con più copertura a parità di miglioramento confermato', () => {
  const sessions = Array.from({ length: 8 }, (_, index) => session(String(index), index + 1, {
    bench: [set(String(20 + 2 * index))],
    ...(index === 0 ? { row: [set('30')] } : index >= 6 ? { row: [set(String(50 + 10 * index))] } : {}),
  }))
  const result = report(sessions)
  assert.equal(result.groups.find(group => group.label === 'Schiena')?.trend, 'progress')
  assert.equal(result.featuredGroup, 'Petto')
  assert.deepEqual(result.groups.find(group => group.label === result.featuredGroup)?.points.map(point => point.week), [1, 4, 8])
})

test('la storia della progressione compare solo con miglioramenti confermati', () => {
  const result = report([
    session('a', 1, { bench: [set('40')], row: [set('25')] }),
    session('b', 4, { bench: [set('40')], row: [set('25')] }),
    session('c', 7, { bench: [set('60')], row: [set('25')] }),
  ])
  assert.equal(result.groups.length, 2)
  assert.equal(result.featuredGroup, undefined)
})
