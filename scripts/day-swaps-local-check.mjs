// Auth/PostgREST/PostgreSQL reali, esclusivamente account sintetici nello stack locale.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { workoutChangesFixture } from './lib/workout-changes-local-fixture.mjs'
import { createDiaryTransport, DiaryFailure, sessionFromRow } from '../src/persistence/diary-repository.ts'
import { DiaryStore, memoryStorage } from '../src/persistence/diary-store.ts'
import { newDaySwap, scheduleExpectation, scheduledDay } from '../src/domain/day-swaps.ts'
import { emptyDiary } from '../src/domain/diary.ts'
import { shiftDate } from '../src/domain/dates.ts'
import { futurePartners } from '../src/domain/exercise-changes.ts'
import { adherence, weeklyProgress } from '../src/domain/progress.ts'

const checks = [], stores = [], fixture = await workoutChangesFixture()
const { a, b, document, days, find } = fixture
const transport = createDiaryTransport(a.client, a.owner), signal = () => AbortSignal.timeout(15000)
const monday = shiftDate(fixture.monday, 7), tuesday = shiftDate(monday, 1), wednesday = shiftDate(monday, 2), friday = shiftDate(monday, 4), sunday = shiftDate(monday, 6)
const args = { planId: document.planId, versionId: document.id, days, sourceDate: monday, targetDate: tuesday, timeZone: 'Europe/Rome' }
const check = (condition, label) => { assert.ok(condition, label); checks.push(label); console.log(`PASS ${label}`) }
const reject = async (fn, label) => { await assert.rejects(fn); check(true, label) }
const send = swap => transport.swap({ type: 'swap', opId: swap.id, swap }, signal())
const undo = (swap, request = randomUUID()) => transport.swap({ type: 'undo-swap', opId: request, swap }, signal())
const start = (date, day, expectation) => transport.start({ sessionId: randomUUID(), versionId: document.id, dayId: day.id, date, timeZone: 'Europe/Rome', expectedSchedule: expectation }, signal())
const remove = id => transport.discard(id, signal())
try {
  const original = structuredClone((await a.client.from('workout_days').select('*').order('id')).data)
  const swap = newDaySwap(args, emptyDiary())
  const applied = await Promise.all([send(swap), send(swap)])
  check(applied.every(value => value.id === swap.id) && !applied[0].cancelled, 'Doppia richiesta concorrente applicata una sola volta')
  check((await transport.loadAll(signal())).data.sessions.length === 0, 'Pianificazione senza sessioni')
  await reject(() => send({ ...swap, targetDate: wednesday }), 'ID riutilizzato con comando diverso respinto')
  const full = (await transport.loadAll(signal())).data
  check(scheduledDay(days, monday, document.id, full.swaps) === undefined && scheduledDay(days, tuesday, document.id, full.swaps).id === days[0].id, 'Lunedì riposo e martedì seduta originale da lettura completa')
  const incremental = await transport.loadChanges(new Date().toISOString(), signal())
  check(incremental.swaps.some(item => item.id === swap.id), 'Lettura incrementale include eccezioni anche senza altre scritture')
  check(scheduledDay(days, shiftDate(monday, 7), document.id, full.swaps).id === days[0].id && !scheduledDay(days, tuesday, randomUUID(), full.swaps), 'Settimana successiva e altra versione indipendenti')
  check(JSON.stringify((await a.client.from('workout_days').select('*').order('id')).data) === JSON.stringify(original), 'Programma pubblicato invariato')
  const foreign = createDiaryTransport(b.client, b.owner)
  check((await foreign.loadAll(signal())).data.swaps.length === 0, 'RLS: altro account non legge eccezioni')
  await reject(() => foreign.swap({ type: 'swap', opId: swap.id, swap }, signal()), 'Altro account non ripete la richiesta')
  await reject(() => foreign.swap({ type: 'undo-swap', opId: randomUUID(), swap }, signal()), 'Altro account non annulla eccezioni')
  check(Boolean((await a.client.from('workout_day_swaps').update({ cancelled: true }).eq('id', swap.id)).error), 'Scritture dirette vietate')
  await reject(() => send(newDaySwap({ ...args, targetDate: wednesday }, emptyDiary())), 'Scambi sovrapposti respinti sul server')
  await reject(() => send({ ...swap, id: randomUUID(), targetDate: shiftDate(tuesday, 7) }), 'Date in settimane diverse respinte')
  await reject(() => send({ ...swap, id: randomUUID(), timeZone: 'UTC' }), 'Fuso diverso da quello dell’account respinto')
  await reject(() => start(tuesday, days[0], { dayId: null, swapId: null }), 'Avvio con calendario obsoleto respinto')
  await reject(() => start(tuesday, days[1], { dayId: days[0].id, swapId: swap.id }), 'Avvio normale con scheda diversa dall’effettiva respinto')
  await reject(() => start(tuesday, days[0]), 'Vecchio client deve rileggere il calendario spostato')
  const idempotentUndo = randomUUID()
  await undo(swap, idempotentUndo); await undo(swap, idempotentUndo)
  check((await transport.loadAll(signal())).data.swaps.find(item => item.id === swap.id).cancelled, 'Undo idempotente prima dell’avvio')

  const ab = newDaySwap({ ...args, targetDate: wednesday }, emptyDiary())
  const independent = newDaySwap({ ...args, sourceDate: friday, targetDate: sunday }, emptyDiary())
  await send(ab); await send(independent); await undo(independent)
  let data = (await transport.loadAll(signal())).data
  check(scheduledDay(days, monday, document.id, data.swaps).id === days[1].id && scheduledDay(days, wednesday, document.id, data.swaps).id === days[0].id, 'A/B scambiate, undo indipendente conserva A/B')
  let row = await start(wednesday, days[0], scheduleExpectation(days, wednesday, document.id, data.swaps))
  check(row.diary_date === wednesday && row.day_snapshot.label === 'Lun', 'Nuovo avvio nella data effettiva senza alterare etichetta snapshot')
  await reject(() => undo(ab), 'Undo respinto con sessione attiva ma vuota')
  await reject(() => send({ ...swap, id: randomUUID() }), 'Scambio respinto con sessione avviata su una delle due giornate')
  await a.client.from('workout_sessions').update({ status: 'completed', revision: row.revision + 1 }).eq('id', row.id).throwOnError()
  await reject(() => undo(ab), 'Undo respinto dopo completamento')
  data = (await transport.loadAll(signal())).data
  const progress = weeklyProgress(days, data.sessions, { start: monday, weeks: 2 }, wednesday, data.swaps, document.id)
  check(progress[0].slots.some(slot => slot.date === wednesday && slot.state === 'done') && adherence(progress).done === 1, 'Completamento associato alla data effettiva nei Progressi')
  // Altra settimana per esercitare offline e concorrenza, senza toccare lo storico completato.
  const later = shiftDate(monday, 14), laterTuesday = shiftDate(later, 1)
  const storage = memoryStorage(), calls = []
  let offline = true, lose = false
  const wrapped = { ...transport,
    swap: async (op, abort) => { calls.push(op.type); if (offline) throw new DiaryFailure('unavailable'); const result = await transport.swap(op, abort); if (lose) { lose = false; throw new DiaryFailure('unavailable') } return result },
    start: async (op, abort) => { calls.push('start'); if (offline) throw new DiaryFailure('unavailable'); return transport.start(op, abort) },
  }
  let store = new DiaryStore(wrapped, storage, a.owner); stores.push(store)
  await store.refresh()
  const queued = store.swapDays({ ...args, sourceDate: later, targetDate: laterTuesday })
  const started = store.startSession({ date: laterTuesday, day: days[0], planId: document.planId, versionId: document.id, timeZone: args.timeZone, expectedSchedule: scheduleExpectation(days, laterTuesday, document.id, [queued]) })
  check(Boolean(started) && !store.undoSwap(queued.id), 'Avvio locale accodato blocca undo immediatamente')
  await store.flush(); check(store.getSnapshot().sync === 'waiting', 'Offline mai dichiarato sincronizzato')
  store.stop(); store = new DiaryStore(wrapped, storage, a.owner); stores.push(store)
  await store.flush(); check(store.getSnapshot().pending === 2, 'Reload conserva ordine scambio e avvio')
  offline = false; lose = true; await store.flush(); await store.flush()
  check(store.getSnapshot().pending === 0 && store.getSnapshot().view.sessions.some(item => item.id === started), 'Risposta scambio persa: retry con stesso ID prima dell’avvio dipendente')
  const synced = (await transport.loadAll(signal())).data
  check(synced.swaps.filter(item => item.id === queued.id).length === 1 && synced.sessions.filter(item => item.id === started).length === 1, 'Nessun doppio scambio o doppia sessione dopo retry')
  await remove(started)
  const raceDate = shiftDate(later, 14), raceTarget = shiftDate(raceDate, 1), race = newDaySwap({ ...args, sourceDate: raceDate, targetDate: raceTarget }, emptyDiary())
  const outcome = await Promise.allSettled([send(race), start(raceDate, days[0], { dayId: days[0].id, swapId: null })])
  check(outcome.filter(item => item.status === 'fulfilled').length === 1, 'Concorrenza scambio/avvio: una sola transazione ammessa')
  if (outcome[1].status === 'fulfilled') await remove(outcome[1].value.id)
  if (outcome[0].status === 'fulfilled') await undo(race)
  const conflictDate = shiftDate(later, 28), conflictTarget = shiftDate(conflictDate, 1)
  let callsToStart = 0
  const guarded = { ...transport, start: async (...params) => { callsToStart++; return transport.start(...params) } }
  const conflictStore = new DiaryStore(guarded, memoryStorage(), a.owner); stores.push(conflictStore)
  await conflictStore.refresh()
  const conflictSwap = conflictStore.swapDays({ ...args, sourceDate: conflictDate, targetDate: conflictTarget })
  const dependent = conflictStore.startSession({ date: conflictTarget, day: days[0], planId: document.planId, versionId: document.id, timeZone: args.timeZone, expectedSchedule: scheduleExpectation(days, conflictTarget, document.id, [conflictSwap]) })
  const remoteStart = await start(conflictDate, days[0], { dayId: days[0].id, swapId: null })
  await conflictStore.flush()
  check(conflictStore.getSnapshot().conflicts.length === 1 && callsToStart === 0, 'Altro dispositivo avvia: scambio respinto e avvio dipendente non inviato')
  conflictStore.useOnline(conflictStore.getSnapshot().conflicts[0].id); await conflictStore.flush()
  check(callsToStart === 0 && conflictStore.getSnapshot().conflicts.some(item => item.sessionId === dependent), 'Scarto dello scambio non sblocca silenziosamente l’avvio dipendente')
  conflictStore.stop(); await remove(remoteStart.id)
  // Sostituzione creata DOPO lo spostamento: Mer si trova Gio.
  const effectiveWed = shiftDate(fixture.monday, 2), effectiveThu = shiftDate(fixture.monday, 3)
  if (effectiveThu >= fixture.today) {
    const exerciseSwap = newDaySwap({ ...args, sourceDate: effectiveWed, targetDate: effectiveThu }, emptyDiary())
    await send(exerciseSwap)
    row = await start(fixture.today, days[0], { ...scheduleExpectation(days, fixture.today, document.id, [exerciseSwap]), manualChoice: true })
    const current = sessionFromRow(row).session, selected = find('Lat machine'), source = current.day.exercises[0]
    const partners = futurePartners({ source, selected, session: current, sessions: [current], days, changes: [], swaps: [exerciseSwap] })
    const partner = partners.find(item => item.date === effectiveThu)
    check(Boolean(partner), 'Partner di sostituzione risolto nella data spostata')
    if (partner) {
      const id = randomUUID(), change = { id, sessionId: current.id, planId: document.planId, versionId: document.id, sourceDate: current.date, sourceDayId: current.day.id, sourceId: source.id,
        timeZone: 'Europe/Rome', createdAt: new Date().toISOString(), before: source.snapshot, after: { ...partner.before, id: source.id }, partner, cancelled: false }
      await transport.change({ type: 'change', opId: id, sessionId: current.id, change, exerciseRevision: selected.revision }, signal())
      check(true, 'Server accetta sostituzione verso calendario effettivo')
      await reject(() => undo(exerciseSwap), 'Undo giornate bloccato da modifica datata successiva')
    }
    await remove(current.id)
  }
  const revisionFixture = await workoutChangesFixture()
  try {
    const rTransport = createDiaryTransport(revisionFixture.a.client, revisionFixture.a.owner)
    const rSwap = newDaySwap({ ...args, planId: revisionFixture.document.planId, versionId: revisionFixture.document.id, days: revisionFixture.days }, emptyDiary())
    await rTransport.swap({ type: 'swap', opId: rSwap.id, swap: rSwap }, signal())
    const { programPayload } = await import('../src/domain/programs.ts')
    const root = (await revisionFixture.a.client.from('workout_plans').select('revision').eq('id', revisionFixture.document.planId).single()).data
    const version = (await revisionFixture.a.client.from('workout_plan_versions').select('revision').eq('id', revisionFixture.document.id).single()).data
    const revised = await revisionFixture.a.client.rpc('save_workout_revision', {
      p_plan_id: revisionFixture.document.planId, p_base_version_id: revisionFixture.document.id, p_expected_plan_revision: root.revision, p_expected_version_revision: version.revision,
      p_new_version_id: randomUUID(), p_title: revisionFixture.document.title, p_guidance: 'Nuova istruzione sintetica', p_days: programPayload(revisionFixture.document).p_days, p_cycle_start: null, p_cycle_weeks: null,
    })
    assert.ifError(revised.error)
    check(revised.data.outcome === 'created' && revised.data.version_id !== revisionFixture.document.id, 'Una versione con scambi e senza sessioni genera una nuova versione quando modificata')
    check(!scheduledDay(revisionFixture.days, tuesday, revised.data.version_id, [rSwap]), 'Eccezioni della versione precedente non applicate alla nuova')
  } finally { await revisionFixture.cleanup() }
  await mkdir('artifacts/day-swaps', { recursive: true })
  await writeFile('artifacts/day-swaps/local-api.json', JSON.stringify({ result: 'PASS', checks }, null, 2))
} finally {
  stores.forEach(store => store.stop()); await fixture.cleanup()
  console.log('Fixture sintetiche eliminate')
}
