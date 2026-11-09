import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDaySwap, newDaySwap, scheduledDay, scheduleExpectation, swapBlocked } from '../src/domain/day-swaps.ts'
import { dayFromSnapshot, emptyDiary, emptyResults } from '../src/domain/diary.ts'
import type { DiaryData, SnapshotExercise } from '../src/domain/diary.ts'
import { localDate, shiftDate, weekDates } from '../src/domain/dates.ts'
import { adherence, weeklyProgress } from '../src/domain/progress.ts'
import { futurePartners } from '../src/domain/exercise-changes.ts'
import type { ExerciseChange } from '../src/domain/exercise-changes.ts'
import type { WorkoutSession } from '../src/domain/types.ts'
import { DiaryFailure, mergeDiary } from '../src/persistence/diary-repository.ts'
import type { DiaryTransport } from '../src/persistence/diary-repository.ts'
import { DiaryStore, memoryStorage } from '../src/persistence/diary-store.ts'

const raw: SnapshotExercise = { id: crypto.randomUUID(), exercise_id: crypto.randomUUID(), name: 'Panca', variant: '', equipment: '', load_convention: 'total', load_unit: 'kg', per_side: false, exercise_note: '', mode: 'reps', sets: 2, optional_sets: 0, reps_min: 8, reps_max: 8, duration_seconds: null, rest_seconds: 60, rir: null, rpe: null, note: '' }
const makeDay = (label: string) => dayFromSnapshot(crypto.randomUUID(), { label, title: label, note: '', plan_title: 'Programma', version_number: 1, exercises: [{ ...raw, id: crypto.randomUUID() }] })
const days = [makeDay('Lun'), makeDay('Mer'), makeDay('Ven')], planId = crypto.randomUUID(), versionId = crypto.randomUUID()
// Settimana futura rispetto al vero orologio, ripetibile anche quando oggi è domenica.
const monday = shiftDate(weekDates(localDate())[0]!, 7), tuesday = shiftDate(monday, 1), wednesday = shiftDate(monday, 2), friday = shiftDate(monday, 4), sunday = shiftDate(monday, 6)
const args = { planId, versionId, days, sourceDate: monday, targetDate: tuesday, timeZone: 'Europe/Rome' }
const swap = newDaySwap(args, emptyDiary())
const session = (date = tuesday): WorkoutSession => ({ id: crypto.randomUUID(), planId, versionId, timeZone: 'Europe/Rome', date, day: days[0]!, startedAt: `${date}T10:00:00Z`, results: emptyResults(days[0]!) })

test('allenamento/riposo: calendario effettivo, settimana successiva e versione diverse', () => {
  assert.equal(scheduledDay(days, monday, versionId, [swap]), undefined)
  assert.equal(scheduledDay(days, tuesday, versionId, [swap])?.id, days[0]!.id)
  assert.equal(scheduledDay(days, shiftDate(monday, 7), versionId, [swap])?.id, days[0]!.id)
  assert.equal(scheduledDay(days, monday, 'altra-versione', [swap])?.id, days[0]!.id)
  assert.deepEqual(days.map(day => day.label), ['Lun', 'Mer', 'Ven'])
  assert.equal(scheduledDay(days, monday, versionId, [], { start: shiftDate(monday, 7), weeks: 1 })?.id, days[0]!.id, 'nessuno scambio: proposta preesistente preservata anche fuori ciclo')
})
test('A/B e scambi indipendenti: nessuna duplicazione, undo preserva l’altro scambio', () => {
  const ab = newDaySwap({ ...args, targetDate: wednesday }, emptyDiary())
  const other = newDaySwap({ ...args, sourceDate: friday, targetDate: sunday }, emptyDiary())
  let data = applyDaySwap(applyDaySwap(emptyDiary(), ab), other)
  assert.equal(scheduledDay(days, monday, versionId, data.swaps)?.id, days[1]!.id)
  assert.equal(scheduledDay(days, wednesday, versionId, data.swaps)?.id, days[0]!.id)
  data = applyDaySwap(data, { ...ab, cancelled: true })
  assert.equal(scheduledDay(days, monday, versionId, data.swaps)?.id, days[0]!.id)
  assert.equal(scheduledDay(days, sunday, versionId, data.swaps)?.id, days[2]!.id)
  assert.equal(data.sessions.length, 0)
})
test('martedì recupero lunedì: sorgente passata ammessa, destinazione passata respinta', () => {
  assert.equal(swapBlocked(swap, emptyDiary(), tuesday), null)
  assert.match(swapBlocked({ ...swap, sourceDate: tuesday, targetDate: monday }, emptyDiary(), tuesday)!, /destinazione/)
  assert.throws(() => newDaySwap({ ...args, targetDate: shiftDate(tuesday, 7) }, emptyDiary()), /stessa settimana/)
  assert.throws(() => newDaySwap({ ...args, cycle: { start: tuesday, weeks: 1 } }, emptyDiary()), /ciclo/)
})
test('ogni sessione avviata blocca entrambe le date, anche vuota e storica senza versionId', () => {
  for (const date of [monday, tuesday]) for (const value of [session(date), { ...session(date), completedAt: `${date}T11:00:00Z` }, { ...session(date), versionId: undefined }]) {
    assert.match(swapBlocked(swap, { ...emptyDiary(), sessions: [value] }, monday)!, /già avviato/)
  }
  assert.match(swapBlocked(swap, applyDaySwap(emptyDiary(), swap), monday)!, /Annulla prima/)
})
test('progressi: un solo slot martedì, nessun lunedì saltato, etichetta snapshot conservata', () => {
  const cycle = { start: monday, weeks: 2 }, done = { ...session(), completedAt: `${tuesday}T11:00:00Z` }
  let weeks = weeklyProgress(days, [], cycle, tuesday, [swap], versionId)
  assert.deepEqual(weeks[0]!.slots.map(slot => [slot.label, slot.date, slot.state]), [['Mar', tuesday, 'planned'], ['Mer', wednesday, 'planned'], ['Ven', friday, 'planned']])
  weeks = weeklyProgress(days, [done], cycle, tuesday, [swap], versionId)
  assert.equal(weeks[0]!.slots[0]!.state, 'done')
  assert.equal(weeks[1]!.slots[0]!.date, shiftDate(monday, 7))
  assert.equal(adherence(weeks).done, 1)
  assert.equal(done.day.label, 'Lun')
  assert.equal(weeklyProgress(days, [{ ...done, date: monday }], cycle, tuesday, [swap], versionId)[0]!.slots[0]!.state, 'planned')
})
test('modifiche esercizi: blocco preventivo; partner successivo segue il calendario effettivo', () => {
  const change = { id: 'change', planId, versionId, sourceDate: shiftDate(monday, -1), partner: { date: tuesday }, cancelled: false } as ExerciseChange
  assert.match(swapBlocked(swap, { ...emptyDiary(), changes: [change] }, monday)!, /modifica datata/)
  const moved = newDaySwap({ ...args, sourceDate: wednesday, targetDate: friday }, emptyDiary())
  const selected = { id: raw.exercise_id, name: raw.name, variant: '', equipment: '', loadConvention: 'total' as const, loadUnit: 'kg' as const, perSide: false, note: '', measurementMode: 'reps' as const, muscleGroup: null, archivedAt: null, revision: 1 }
  const partners = futurePartners({ source: days[0]!.exercises[0]!, selected, session: session(monday), sessions: [], days, changes: [], swaps: [moved] })
  assert.ok(partners.some(partner => partner.date === friday && partner.dayId === days[1]!.id))
  assert.ok(partners.some(partner => partner.date === wednesday && partner.dayId === days[2]!.id))
})
test('replay e lettura incrementale conservano pasti, scelte manuali e tombstone degli scambi', () => {
  const base = { ...emptyDiary(), dayTypes: { [monday]: 'training' as const }, mealLogs: {} }
  const view = applyDaySwap(base, swap)
  assert.deepEqual(view.dayTypes, base.dayTypes); assert.deepEqual(view.mealLogs, base.mealLogs)
  const merged = mergeDiary(view, {}, { sessions: [], sets: [], meals: [], days: [], swaps: [{ ...swap, cancelled: true }], activeSessionIds: [], cursor: null })
  assert.equal(scheduledDay(days, monday, versionId, merged.data.swaps)?.id, days[0]!.id)
})

function fixture() {
  let server: DiaryData = emptyDiary(), offline = false, lost = false, reject = false
  const calls: string[] = []
  const transport: DiaryTransport = {
    loadAll: async () => ({ data: structuredClone(server), revisions: {} }),
    swap: async op => {
      calls.push(op.type)
      if (offline) throw new DiaryFailure('unavailable')
      if (reject) throw new DiaryFailure('conflict')
      server = applyDaySwap(server, { ...op.swap, cancelled: op.type === 'undo-swap' })
      if (lost) { lost = false; throw new DiaryFailure('unavailable') }
      return server.swaps!.find(item => item.id === op.swap.id)!
    },
    start: async args => { calls.push('start'); throw new DiaryFailure(args.expectedSchedule ? 'unavailable' : 'conflict') },
    insert: async () => { throw new Error('unexpected insert') }, update: async () => null, fetch: async () => null, discard: async () => true,
  }
  return { transport, calls, offline: (value: boolean) => { offline = value }, lost: () => { lost = true }, reject: () => { reject = true } }
}
test('persistenza: offline, reload per account, retry risposta persa e undo con ID stabile', async () => {
  const f = fixture(), storage = memoryStorage()
  let store = new DiaryStore(f.transport, storage, 'A')
  try {
    await store.refresh(); f.offline(true)
    const pending = store.swapDays(args)
    await store.flush()
    assert.equal(store.getSnapshot().sync, 'waiting')
    store.stop(); store = new DiaryStore(f.transport, storage, 'A')
    await store.flush()
    assert.equal(store.getSnapshot().view.swaps?.[0]?.id, pending.id)
    const b = new DiaryStore(f.transport, storage, 'B'); assert.equal(b.getSnapshot().pending, 0); b.stop()
    f.offline(false); f.lost(); await store.flush(); await store.flush()
    assert.equal(store.getSnapshot().pending, 0)
    assert.equal(store.getSnapshot().view.swaps?.length, 1)
    assert.equal(store.undoSwap(pending.id), true)
    await store.flush(); assert.equal(store.getSnapshot().view.swaps?.[0]?.cancelled, true)
  } finally { store.stop() }
})
test('coda: avvio locale blocca undo; scambio respinto ferma l’avvio dipendente anche dopo scarto', async () => {
  const f = fixture(), storage = memoryStorage(), store = new DiaryStore(f.transport, storage, 'A')
  try {
    await store.refresh(); const pending = store.swapDays(args)
    const id = store.startSession({ date: tuesday, day: days[0]!, planId, versionId, timeZone: args.timeZone, expectedSchedule: scheduleExpectation(days, tuesday, versionId, [pending]) })
    assert.ok(id); assert.equal(store.undoSwap(pending.id), false)
    f.reject(); await store.flush()
    assert.equal(store.getSnapshot().conflicts.length, 1)
    assert.equal(f.calls.includes('start'), false)
    store.useOnline(store.getSnapshot().conflicts[0]!.id); await store.flush()
    assert.equal(f.calls.includes('start'), false)
    assert.equal(store.getSnapshot().view.sessions[0]?.id, id)
    assert.ok(store.getSnapshot().conflicts.some(item => item.sessionId === id))
  } finally { store.stop() }
})

test('avvio: una vista del calendario superata non avvia localmente una scheda diversa', () => {
  const store = new DiaryStore(null, memoryStorage(), 'local')
  try {
    store.swapDays(args)
    assert.equal(store.startSession({ date: monday, day: days[0]!, planId, versionId, timeZone: args.timeZone, expectedSchedule: { dayId: days[0]!.id, swapId: null } }), null)
    assert.equal(store.getSnapshot().view.sessions.length, 0)
    assert.match(store.getSnapshot().message, /calendario è cambiato/)
  } finally { store.stop() }
})
