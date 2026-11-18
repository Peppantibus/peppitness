import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cycleRecapKey } from '../src/domain/cycle-recap.ts'
import type { CycleRecap } from '../src/domain/cycle-recap.ts'
import { emptyDiary } from '../src/domain/diary.ts'
import type { ProgramRoot } from '../src/domain/programs.ts'
import type { WorkoutSession } from '../src/domain/types.ts'
import { historySessionGroups, workoutHistory } from '../src/domain/workout-history.ts'

const first = { start: '2026-09-01', weeks: 8 }
const next = { start: '2026-10-20', weeks: 10 }
const program: ProgramRoot = { id: 'full-body', name: 'Ciclo attuale', revision: 1, activeVersionId: 'v1', archivedAt: null, cycle: next }
const firstKey = cycleRecapKey(program.id, first)

function session(id: string, date: string, metadata: Partial<WorkoutSession> = {}): WorkoutSession {
  return { id, date, planId: program.id, startedAt: `${date}T16:00:00Z`, completedAt: `${date}T17:00:00Z`,
    day: { id: 'a', title: 'Seduta A', subtitle: 'Ciclo precedente', label: 'A', exercises: [] }, results: {}, ...metadata }
}

test('cicli sovrapposti dello stesso programma: mantiene lo snapshot e lascia la seduta ambigua senza ciclo', () => {
  const view = { ...emptyDiary(), sessions: [
    session('attuale', '2026-10-21', { cycle: next, cycleRecorded: true }),
    session('passata', '2026-10-22', { cycle: first, cycleRecorded: true }),
    session('ambigua', '2026-10-22'),
    session('precedente-univoca', '2026-10-01'),
    session('nata-senza-ciclo', '2026-11-02', { cycleRecorded: true }),
    session('in-corso', '2026-11-15', { cycle: next, completedAt: undefined }),
  ], interruptedCycles: [firstKey] }
  const history = workoutHistory(view, [program], program, '2026-11-19')
  assert.deepEqual(history.current?.sessions.map(item => item.id), ['attuale'])
  assert.deepEqual(history.past.find(item => item.key === firstKey)?.sessions.map(item => item.id), ['passata', 'precedente-univoca'])
  assert.equal(history.past.find(item => item.key === firstKey)?.status, 'Interrotto')
  assert.deepEqual(history.past.find(item => !item.cycle)?.sessions.map(item => item.id), ['nata-senza-ciclo', 'ambigua'])
})

test('mantiene il Wrapped di un ciclo senza programma e raggruppa per mese le libere', () => {
  const recap: CycleRecap = { schema: 1, key: firstKey, title: 'Ciclo salvato', report: {
    info: { ...first, end: '2026-10-26' }, sessions: 1, sets: 4, weeks: [1, 0, 0, 0, 0, 0, 0, 0],
    activeWeeks: 1, streak: 1, groups: [], pauses: [], record: null,
  } }
  const history = workoutHistory({ ...emptyDiary(), cycleRecaps: { [firstKey]: recap }, sessions: [
    session('una', '2026-10-18', { kind: 'free', planId: undefined }),
    session('due', '2026-11-12', { kind: 'free', planId: undefined }),
    session('programmata', first.start),
  ] }, [], null, '2026-11-19')
  assert.equal(history.current, undefined)
  assert.equal(history.past[0]?.recap, recap)
  assert.equal(history.past[0]?.status, 'Concluso')
  assert.equal(historySessionGroups(history.past[0]!.sessions, first)[0]?.key, '1')
  assert.deepEqual(historySessionGroups(history.free).map(item => item.key), ['2026-11', '2026-10'])
})
