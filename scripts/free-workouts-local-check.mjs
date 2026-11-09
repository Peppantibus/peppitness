import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { workoutChangesFixture } from './lib/workout-changes-local-fixture.mjs'
import { createDiaryTransport, DiaryFailure, sessionFromRow } from '../src/persistence/diary-repository.ts'
import { DiaryStore, memoryStorage } from '../src/persistence/diary-store.ts'
import { newPrescription } from '../src/domain/programs.ts'
import { workoutDaysFromProgram } from '../src/domain/diary.ts'
import { weeklyProgress } from '../src/domain/progress.ts'
import { shiftDate } from '../src/domain/dates.ts'

const fixture = await workoutChangesFixture(), checks = [], stores = []
const { a, b, document, days, today, find } = fixture
const transport = createDiaryTransport(a.client, a.owner), signal = () => AbortSignal.timeout(15000)
const check = (condition, name) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`) }
const reject = async (fn, name) => { await assert.rejects(fn); check(true, name) }
const raw = (name, timed = false) => {
  const prescription = { ...newPrescription(find(name)), sets: timed ? '1' : '2', repsMin: timed ? '' : '8', repsMax: timed ? '' : '12', durationSeconds: timed ? '3600' : '', restSeconds: timed ? '0' : '60' }
  return { ...workoutDaysFromProgram({ ...document, days: [{ ...document.days[0], exercises: [prescription] }] })[0].exercises[0].snapshot, session_added: true }
}
const cardio = raw('Tapis roulant', true)
try {
  const programBefore = (await a.client.from('workout_days').select('*').order('id')).data
  const id = randomUUID(), args = { sessionId: id, date: today, timeZone: 'Europe/Rome' }
  const rows = await Promise.all([transport.startFree(args, signal()), transport.startFree(args, signal())])
  check(rows.every(row => row.id === id && row.session_kind === 'free' && row.plan_id === null && row.version_id === null && row.day_id === null), 'Avvio concorrente idempotente e nessun legame a programmi')
  check(rows[0].day_snapshot.exercises.length === 0 && rows[0].day_snapshot.title === 'Allenamento libero', 'Snapshot vuoto canonico generato sul server')
  await reject(() => transport.startFree({ ...args, date: shiftDate(today, -1) }, signal()), 'Stesso ID con data diversa respinto')
  await reject(() => transport.start({ sessionId: id, versionId: document.id, dayId: days[0].id, date: today, timeZone: 'Europe/Rome' }, signal()), 'Avvio programma non adotta una seduta libera')
  await reject(() => transport.startFree({ ...args, sessionId: randomUUID() }, signal()), 'Seconda seduta attiva respinta')
  const emptyComplete = await a.client.from('workout_sessions').update({ status: 'completed', revision: 2 }).eq('id', id).setHeader('X-Peppitness-Diary', 'free-v1')
  check(emptyComplete.error?.code === '23514', 'Seduta vuota non completabile sul server')
  const other = createDiaryTransport(b.client, b.owner)
  check((await other.loadAll(signal())).data.sessions.length === 0, 'Altro account non legge la seduta')
  await reject(() => other.startFree(args, signal()), 'Altro account non ripete la richiesta')
  const add = { type: 'session-edit', opId: randomUUID(), sessionId: id, expectedOrder: [], edit: { action: 'add', exercise: cardio, position: { kind: 'end' }, allowDuplicate: false } }
  await reject(() => other.editSession(add, {}, signal()), 'Altro account non aggiunge esercizi')
  await Promise.all([transport.editSession(add, {}, signal()), transport.editSession(add, {}, signal())])
  let data = (await transport.loadAll(signal())).data
  check(data.sessions[0].day.exercises.length === 1 && data.sessions[0].day.exercises[0].snapshot.session_added, 'Aggiunta da vuota con ID stabile senza doppioni')
  await transport.discard(id, signal())
  await reject(() => transport.startFree(args, signal()), 'Retry dopo scarto non ricrea una seduta eliminata')
  // Tutto offline in ordine: avvio, aggiunta, risultato effettivo, nota e conclusione.
  const storage = memoryStorage(); let offline = true, lost = true
  const calls = []
  const wrapped = { ...transport, startFree: async (command, abort) => {
    calls.push('start-free'); if (offline) throw new DiaryFailure('unavailable')
    const row = await transport.startFree(command, abort)
    if (lost) { lost = false; throw new DiaryFailure('unavailable') }
    return row
  }, editSession: async (...params) => { calls.push('edit'); return transport.editSession(...params) } }
  let store = new DiaryStore(wrapped, storage, a.owner); stores.push(store); await store.refresh()
  const freeId = store.startFreeSession(today, 'Europe/Rome')
  check(Boolean(freeId) && !store.startFreeSession(today, 'Europe/Rome'), 'Un solo avvio locale anche prima della sincronizzazione')
  check(store.editSession(freeId, { action: 'add', exercise: cardio, position: { kind: 'end' }, allowDuplicate: false }), 'Aggiunta accodata alla seduta libera offline')
  store.updateSet(freeId, cardio.id, 0, { load: '', amount: '3600', completed: true }); store.setSessionNote(freeId, 'Solo cardio, un’ora'); store.completeSession(freeId)
  check(store.getSnapshot().restTimer === null, 'Un’ora cardio non avvia recuperi fittizi')
  await store.flush(); check(store.getSnapshot().sync === 'waiting' && !calls.includes('edit'), 'Offline: avvio prima delle modifiche, stato locale esplicito')
  store.stop(); store = new DiaryStore(wrapped, storage, a.owner); stores.push(store)
  await store.flush(); check(store.getSnapshot().view.sessions[0].results[cardio.id][0].amount === '3600', 'Reload offline conserva minuti, esercizi e completamento')
  offline = false; await store.flush(); await store.flush()
  check(store.getSnapshot().pending === 0 && store.getSnapshot().conflicts.length === 0, 'Risposta persa: retry stesso avvio, poi coda completata')
  data = (await transport.loadAll(signal())).data
  const completed = data.sessions.find(session => session.id === freeId)
  check(data.sessions.length === 1 && completed.kind === 'free' && completed.completedAt && completed.note === 'Solo cardio, un’ora', 'Una sola seduta libera completa riletta dal server')
  check(completed.results[cardio.id][0].amount === '3600' && completed.results[cardio.id][0].completed, '60 minuti persistiti come 3600 secondi effettivi')
  const changes = await transport.loadChanges(new Date(Date.now() - 60000).toISOString(), signal())
  check(changes.sessions.some(row => sessionFromRow(row).session.kind === 'free'), 'Letture incrementali compatibili con riferimenti nulli')
  const progress = weeklyProgress(days, [completed], { start: fixture.monday, weeks: 1 }, shiftDate(today, 1))
  check(progress[0].extra === 1 && progress[0].slots.every(slot => slot.state !== 'done'), 'Libera extra: nessuna seduta del programma completata artificialmente')
  check(JSON.stringify((await a.client.from('workout_days').select('*').order('id')).data) === JSON.stringify(programBefore), 'Programma settimanale invariato')
  const legacySessions = await a.client.from('workout_sessions').select('id,plan_id,version_id,day_id')
  const legacySets = await a.client.from('workout_set_logs').select('id,session_id')
  check(!legacySessions.error && legacySessions.data.length === 0 && !legacySets.error && legacySets.data.length === 0, 'Vecchio client legge il diario senza sedute libere o serie orfane')
  const normal = await transport.start({ sessionId: randomUUID(), versionId: document.id, dayId: days[0].id, date: today, timeZone: 'Europe/Rome' }, signal())
  const legacyProgram = await a.client.from('workout_sessions').select('id,plan_id,version_id,day_id')
  check(!legacyProgram.error && legacyProgram.data.length === 1 && legacyProgram.data[0].id === normal.id && legacyProgram.data[0].plan_id, 'Vecchio client continua a leggere le proprie sedute programmate')
  await transport.discard(normal.id, signal())
  const outcomes = await Promise.allSettled([
    transport.startFree({ ...args, sessionId: randomUUID() }, signal()),
    transport.start({ sessionId: randomUUID(), versionId: document.id, dayId: days[0].id, date: today, timeZone: 'Europe/Rome' }, signal()),
  ])
  check(outcomes.filter(value => value.status === 'fulfilled').length === 1, 'Avvio libero e programmato concorrenti: un solo vincitore')
  for (const outcome of outcomes) if (outcome.status === 'fulfilled') await transport.discard(outcome.value.id, signal())
  const bFree = await other.startFree({ ...args, sessionId: randomUUID() }, signal())
  check(bFree.session_kind === 'free' && (await b.client.from('workout_plans').select('id')).data.length === 0, 'Account senza programmi può registrare una seduta libera')
  await mkdir('artifacts/free-workouts', { recursive: true }); await writeFile('artifacts/free-workouts/local-api.json', JSON.stringify({ result: 'PASS', checks }, null, 2))
} finally { stores.forEach(store => store.stop()); await fixture.cleanup() }
