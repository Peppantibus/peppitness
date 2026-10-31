// Auth, PostgREST e transazioni reali, esclusivamente sullo stack locale sintetico.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { workoutChangesFixture } from './lib/workout-changes-local-fixture.mjs'
import { createDiaryTransport, DiaryFailure, sessionFromRow } from '../src/persistence/diary-repository.ts'
import { DiaryStore, memoryStorage } from '../src/persistence/diary-store.ts'
import { newPrescription } from '../src/domain/programs.ts'
import { workoutDaysFromProgram } from '../src/domain/diary.ts'
import { sessionProgress } from '../src/domain/workout.ts'

const fixture = await workoutChangesFixture(), checks = [], stores = []
const { a, b, document, days, today, find } = fixture
const transport = createDiaryTransport(a.client, a.owner), signal = () => AbortSignal.timeout(15000)
const check = (condition, name) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`) }
const reject = async (fn, name) => { await assert.rejects(fn); check(true, name) }
const read = async id => (await transport.loadAll(signal())).data.sessions.find(item => item.id === id)
const order = session => session.day.exercises.map(item => item.id)
const raw = (name = 'Spinta con manubri', mode = 'reps') => {
  const draft = { ...newPrescription(find(name)), sets: '2', repsMin: mode === 'reps' ? '8' : '', repsMax: mode === 'reps' ? '12' : '', durationSeconds: mode === 'reps' ? '' : '150', restSeconds: '60' }
  return { ...workoutDaysFromProgram({ ...document, days: [{ ...document.days[0], exercises: [draft] }] })[0].exercises[0].snapshot, session_added: true }
}
const op = (session, edit) => ({ type: 'session-edit', opId: randomUUID(), sessionId: session.id, expectedOrder: order(session), edit })
const start = async () => sessionFromRow(await transport.start({ sessionId: randomUUID(), versionId: document.id, dayId: days[0].id, date: today, timeZone: 'Europe/Rome' }, signal())).session
const send = (command, revisions = {}) => transport.editSession(command, revisions, signal())
try {
  let session = await start()
  const programBefore = await a.client.from('workout_prescriptions').select('*').order('id')
  assert.ifError(programBefore.error)
  const added = raw(), add = op(session, { action: 'add', exercise: added, position: { kind: 'after', id: order(session)[0] }, allowDuplicate: false })
  const replies = await Promise.all([send(add), send(add)])
  session = await read(session.id)
  check(session.day.exercises.length === 4 && replies[0].revision === replies[1].revision && order(session)[1] === added.id, 'Aggiunta concorrente idempotente e posizione esatta per ID')
  check(session.day.exercises[1].snapshot.session_added && session.day.exercises[1].comparison.loadConvention === 'single-dumbbell', 'Snapshot completo: origine, identità, convenzione carico')
  await reject(() => send({ ...add, edit: { ...add.edit, position: { kind: 'start' } } }), 'ID richiesta riutilizzato con comando diverso respinto')
  const other = createDiaryTransport(b.client, b.owner)
  await reject(() => other.editSession(add, {}, signal()), 'Altro account non può ripetere la richiesta')
  await reject(() => other.editSession(op(session, { action: 'remove', id: added.id, confirmed: true }), {}, signal()), 'Altro account non può modificare la seduta')
  const forbidden = await a.client.from('workout_sessions').update({ day_snapshot: {} }).eq('id', session.id)
  check(Boolean(forbidden.error), 'Scrittura diretta dello snapshot vietata')
  const stale = op(session, { action: 'add', exercise: raw('Plank', 'seconds'), position: { kind: 'start' }, allowDuplicate: false })
  const second = raw('Tapis roulant', 'seconds')
  session = sessionFromRow(await send(op(session, { action: 'add', exercise: second, position: { kind: 'end' }, allowDuplicate: false }))).session
  await reject(() => send(stale), 'Ordine concorrente cambiato: conflitto esplicito')
  await reject(() => send(op(session, { action: 'add', exercise: { ...raw(), name: 'Nome falsificato' }, position: { kind: 'end' }, allowDuplicate: true })), 'Snapshot catalogo falsificato respinto')
  await reject(() => send(op(session, { action: 'add', exercise: { ...raw(), sets: null }, position: { kind: 'end' }, allowDuplicate: true })), 'Dose incompleta respinta dal backend')
  await reject(() => send(op(session, { action: 'add', exercise: raw(), position: { kind: 'end' }, allowDuplicate: false })), 'Duplicato richiede consenso esplicito anche sul server')
  const duplicate = raw()
  session = sessionFromRow(await send(op(session, { action: 'add', exercise: duplicate, position: { kind: 'after', id: added.id }, allowDuplicate: true }))).session
  check(order(session)[2] === duplicate.id && duplicate.id !== added.id, 'Nomi duplicati: consenso e occorrenze indipendenti')
  const log = await transport.insert('workout_set_logs', { session_id: session.id, prescription_id: added.id, exercise_id: added.exercise_id, set_index: 0, load: 22.5, amount: 8, completed: true }, signal())
  session = await read(session.id)
  const values = structuredClone(session.results)
  session = sessionFromRow(await send(op(session, { action: 'move', id: added.id, position: { kind: 'start' } }))).session
  session = await read(session.id)
  check(order(session)[0] === added.id && JSON.stringify(session.results) === JSON.stringify(Object.fromEntries(order(session).map(id => [id, values[id]]))), 'Spostamento all’inizio conserva tutti i valori e le serie')
  await reject(() => send(op(session, { action: 'move', id: added.id, position: { kind: 'after', id: added.id } })), 'Autoreferenza vietata sul server')
  await reject(() => send(op(session, { action: 'remove', id: days[0].exercises[0].id, confirmed: true })), 'Rimozione di esercizi del programma vietata')
  await reject(() => send(op(session, { action: 'remove', id: added.id, confirmed: false }), { 0: log.revision }), 'Rimozione con valori richiede conferma')
  await reject(() => send(op(session, { action: 'remove', id: added.id, confirmed: true })), 'Registrazioni concorrenti proteggono la rimozione')
  session = sessionFromRow(await send(op(session, { action: 'remove', id: duplicate.id, confirmed: false }))).session
  check(!order(session).includes(duplicate.id), 'Rimozione rapida di un’occorrenza vuota')
  const remove = op(session, { action: 'remove', id: added.id, confirmed: true })
  await send(remove, { 0: log.revision }); await send(remove, { 0: log.revision })
  session = await read(session.id)
  check(!order(session).includes(added.id) && !session.results[added.id], 'Rimozione confermata idempotente elimina solo le sue serie')
  await transport.discard(session.id, signal())

  // Start → add → serie → move → serie → remove, tutti preparati offline. Risposta persa per ciascuna mutazione.
  const cache = memoryStorage(), calls = []
  let offline = false
  const lost = new Set()
  const gate = Object.fromEntries(Object.entries(transport).map(([key, method]) => [key, async (...args) => {
    if (offline) throw new DiaryFailure('unavailable')
    calls.push(key)
    const result = await method(...args)
    if (key === 'editSession' && !lost.has(args[0].opId)) { lost.add(args[0].opId); throw new DiaryFailure('unavailable') }
    return result
  }]))
  let store = new DiaryStore(gate, cache, a.owner); stores.push(store)
  await store.refresh(); offline = true
  const id = store.startSession({ date: today, day: days[0], planId: document.planId, versionId: document.id, timeZone: 'Europe/Rome' })
  const strength = raw(), plank = raw('Plank', 'seconds'), cardio = raw('Tapis roulant', 'seconds')
  for (const exercise of [strength, plank, cardio]) check(store.editSession(id, { action: 'add', exercise, position: { kind: 'end' }, allowDuplicate: exercise === plank }), `Offline: aggiunta ${exercise.name}`)
  check(!store.editSession(id, { action: 'add', exercise: strength, position: { kind: 'start' }, allowDuplicate: true }), 'Doppio tocco con stesso ID locale respinto')
  store.updateSet(id, strength.id, 0, { load: '22,5', amount: '8', completed: true })
  store.updateSet(id, plank.id, 0, { load: '', amount: '30', completed: true })
  store.updateSet(id, cardio.id, 0, { load: '', amount: '150', completed: true })
  check(store.editSession(id, { action: 'move', id: strength.id, position: { kind: 'after', id: days[0].exercises[0].id } }), 'Spostamento offline con dati già annotati')
  store.updateSet(id, strength.id, 0, { load: '25', amount: '9', completed: true })
  check(store.editSession(id, { action: 'remove', id: plank.id, confirmed: true }), 'Rimozione offline con serie ancora in coda')
  const expected = structuredClone(store.getSnapshot().view.sessions.find(item => item.id === id))
  store.stop()
  store = new DiaryStore(gate, cache, a.owner); stores.push(store)
  await store.flush()
  check(JSON.stringify(store.getSnapshot().view.sessions.find(item => item.id === id)) === JSON.stringify(expected), 'Reload offline conserva identità, prescrizione, ordine e valori')
  offline = false
  for (let attempt = 0; attempt < 12 && store.getSnapshot().pending; attempt++) await store.flush()
  check(store.getSnapshot().pending === 0 && !store.getSnapshot().conflicts.length, 'Ritorno online e risposte perse: coda svuotata senza conflitti o duplicati')
  session = await read(id)
  check(order(session).join() === order(expected).join() && session.results[strength.id][0].load === '25' && session.results[cardio.id][0].amount === '150', 'Server conserva ordine finale, carichi e secondi del cardio')
  check(calls.indexOf('start') < calls.indexOf('editSession') && calls.indexOf('editSession') < calls.indexOf('insert'), 'Invii ordinati: avvio → aggiunta → serie')
  check(sessionProgress(session).required === sessionProgress(expected).required, 'Avanzamento coerente dopo sincronizzazione')
  store.completeSession(id); await store.flush(); store.stop()
  session = await read(id)
  check(session.completedAt && order(session).join() === order(expected).join(), 'Storico concluso conserva aggiunte e ordine')
  await reject(() => send(op(session, { action: 'add', exercise: raw(), position: { kind: 'end' }, allowDuplicate: true })), 'Aggiunta a seduta completata vietata dal backend')
  const rename = await a.client.from('exercises').update({ name: 'Nuovo nome del catalogo', revision: find('Spinta con manubri').revision + 1 }).eq('id', strength.exercise_id)
  assert.ifError(rename.error)
  check((await read(id)).day.exercises.find(item => item.id === strength.id).name === 'Spinta con manubri', 'Modifiche successive al catalogo non cambiano lo storico')
  const programAfter = await a.client.from('workout_prescriptions').select('*').order('id')
  assert.ifError(programAfter.error)
  check(JSON.stringify(programBefore.data) === JSON.stringify(programAfter.data), 'Prescrizioni del programma intatte')
  const next = await start()
  check(order(next).join() === days[0].exercises.map(item => item.id).join(), 'Altra seduta e settimane future senza aggiunte o spostamenti ereditati')
  const conflictCache = memoryStorage()
  let staleStore = new DiaryStore(transport, conflictCache, a.owner); stores.push(staleStore)
  await staleStore.refresh()
  const localExercise = raw('Carry', 'seconds')
  check(staleStore.editSession(next.id, { action: 'add', exercise: localExercise, position: { kind: 'end' }, allowDuplicate: false }), 'Client offline prepara aggiunta prima di una modifica concorrente')
  staleStore.updateSet(next.id, localExercise.id, 0, { load: '', amount: '35', completed: true })
  await send(op(next, { action: 'add', exercise: raw('Lat machine'), position: { kind: 'start' }, allowDuplicate: false }))
  await staleStore.flush()
  check(staleStore.getSnapshot().pending === 2 && staleStore.getSnapshot().conflicts.length === 1
    && staleStore.getSnapshot().view.sessions.find(item => item.id === next.id).results[localExercise.id][0].amount === '35', 'Conflitto di ordine conserva aggiunta e serie locali, ferme senza sovrascrivere il secondo client')
  staleStore.stop()
  staleStore = new DiaryStore(transport, conflictCache, a.owner); stores.push(staleStore)
  await staleStore.flush()
  check(staleStore.getSnapshot().pending === 2 && staleStore.getSnapshot().conflicts.length === 1, 'Conflitto e registrazioni persistono dopo reload e retry')
  staleStore.stop()
  await transport.discard(next.id, signal())
  await mkdir('artifacts/session-exercises', { recursive: true })
  await writeFile('artifacts/session-exercises/api.json', JSON.stringify({ result: 'PASS', checks }, null, 2))
} finally {
  stores.forEach(store => store.stop())
  await fixture.cleanup()
  console.log('Fixture locali eliminate')
}
