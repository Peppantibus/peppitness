import { completedCardioMinutes } from '../src/domain/workout.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyDiary, emptyResults, suggestedDay } from '../src/domain/diary.ts'
import { adherence, weeklyProgress } from '../src/domain/progress.ts'
import { sessionFromRow, mergeDiary } from '../src/persistence/diary-repository.ts'
import { DiaryStore, memoryStorage } from '../src/persistence/diary-store.ts'
import type { WorkoutDay, WorkoutSession } from '../src/domain/types.ts'

const id = crypto.randomUUID(), date = '2026-11-09'
const day: WorkoutDay = { id: crypto.randomUUID(), label: 'Lun', title: 'A', subtitle: '', exercises: [] }
const row = { id, owner_id: crypto.randomUUID(), session_kind: 'free', plan_id: null, version_id: null, day_id: null, diary_date: date, time_zone: 'Europe/Rome', day_snapshot: { label: 'Libero', title: 'Allenamento libero', note: '', plan_title: '', version_number: 0, exercises: [] }, status: 'active', started_at: `${date}T10:00:00Z`, revision: 1 }
const free = (): WorkoutSession => sessionFromRow(row).session
test('avvio libero: seduta vuota, nessun programma e un solo avvio locale', () => {
  const store = new DiaryStore(null, memoryStorage(), 'local')
  try {
    assert.ok(store.startFreeSession(date, 'Europe/Rome'))
    const value = store.getSnapshot().view.sessions[0]!
    assert.equal(value.kind, 'free'); assert.equal(value.planId, undefined); assert.equal(value.versionId, undefined)
    assert.equal(value.day.title, 'Allenamento libero'); assert.deepEqual(value.day.exercises, [])
    assert.equal(store.startFreeSession(date, 'Europe/Rome'), null)
    store.completeSession(value.id)
    assert.equal(store.getSnapshot().view.sessions[0]!.completedAt, undefined)
    store.discardSession(value.id)
    assert.equal(store.getSnapshot().view.sessions.length, 0)
  } finally { store.stop() }
})
test('lettura: null espliciti per libera, contesto non falsificabile e programma storico compatibile', () => {
  assert.equal(free().day.id, id)
  assert.throws(() => sessionFromRow({ ...row, plan_id: crypto.randomUUID() }))
  assert.throws(() => sessionFromRow({ ...row, session_kind: 'unknown' }))
  const legacy = { ...row, session_kind: undefined, plan_id: crypto.randomUUID(), version_id: crypto.randomUUID(), day_id: day.id }
  assert.equal(sessionFromRow(legacy).session.kind, undefined)
})
test('progressi: libera sempre extra, non copre nemmeno uno slot con etichetta coincidente', () => {
  const completed = { ...free(), completedAt: `${date}T11:00:00Z` }
  const weeks = weeklyProgress([day], [{ ...completed, day }], { start: date, weeks: 1 }, '2026-11-10')
  assert.equal(weeks[0]!.slots[0]!.state, 'missed')
  assert.equal(weeks[0]!.extra, 1)
  assert.equal(adherence(weeks).done, 0)
  assert.equal(suggestedDay([day, { ...day, id: 'B', label: 'Mer' }], [{ ...completed, day }])?.id, day.id)
})
test('incrementale: avvio libero vuoto riletto senza introdurre programmi', () => {
  const merged = mergeDiary(emptyDiary(), {}, { sessions: [row], sets: [], meals: [], days: [], activeSessionIds: [id], cursor: null })
  assert.equal(merged.data.sessions[0]!.kind, 'free')
  assert.deepEqual(merged.data.dayTypes, {})
  assert.deepEqual(merged.data.sessions[0]!.results, emptyResults(merged.data.sessions[0]!.day))
})

test('minuti cardio: solo secondi effettivi completati, nessuna durata prescritta o serie vuota', () => {
  const session = free()
  session.day.exercises = [{ id: 'cardio', exerciseId: 'tapis', name: 'Tapis roulant', muscleGroup: 'Cardio', area: '', mode: 'seconds', sets: 1, target: '7200 secondi', restSeconds: 0, note: '' }]
  session.results = { cardio: [{ amount: '3600', load: '', completed: true }, { amount: '600', load: '', completed: false }] }
  assert.equal(completedCardioMinutes(session), 60)
  assert.equal(completedCardioMinutes({ ...session, results: {} }), 0)
})
