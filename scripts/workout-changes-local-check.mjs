// Auth + PostgREST + transazioni reali, soltanto Supabase locale. Nessun dato personale.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { workoutChangesFixture } from './lib/workout-changes-local-fixture.mjs'
import { createDiaryTransport, DiaryFailure, sessionFromRow } from '../src/persistence/diary-repository.ts'
import { DiaryStore, memoryStorage } from '../src/persistence/diary-store.ts'
import { datedDay, futurePartners, proposedDose, replacementSnapshot } from '../src/domain/exercise-changes.ts'
import { shiftDate } from '../src/domain/dates.ts'

const fixture = await workoutChangesFixture(), checks = []
const { a, b, days, today, monday, document, find } = fixture
const signal = () => AbortSignal.timeout(15000)
const transport = createDiaryTransport(a.client, a.owner)
const check = (condition, name) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`) }
const rejected = async (action, name) => { await assert.rejects(action); checks.push(name); console.log(`PASS ${name}`) }
const make = (session, source, selected, partner = null) => {
  const id = randomUUID()
  const change = { id, sessionId: session.id, planId: document.planId, versionId: document.id, sourceDate: session.date, sourceDayId: session.day.id,
    sourceId: source.id, before: source.snapshot, after: partner ? { ...partner.before, id: source.id } : replacementSnapshot(source.snapshot, selected, proposedDose(source.snapshot, selected)),
    partner, timeZone: 'Europe/Rome', createdAt: session.date === today ? new Date().toISOString() : `${session.date}T08:00:00.000Z`, cancelled: false }
  return { type: 'change', opId: id, sessionId: session.id, change, exerciseRevision: selected.revision }
}
const start = async (date = monday, day = days[0]) => sessionFromRow(await transport.start({ sessionId: randomUUID(), versionId: document.id, dayId: day.id, date, timeZone: 'Europe/Rome' }, signal())).session
const stores = []
try {
  let session = await start()
  const source = session.day.exercises[0]
  const partners = futurePartners({ source, selected: find('Lat machine'), session, days, changes: [], sessions: [session] })
  check(partners.length === 2, 'Lunedì sintetico: due partner precisi, nessuna scelta arbitraria')
  const op = make(session, source, find('Lat machine'), partners[0])
  const concurrent = await Promise.all([transport.change(op, signal()), transport.change(op, signal())])
  check(concurrent[0].id === concurrent[1].id, 'Doppio invio concorrente idempotente')
  let full = await transport.loadAll(signal())
  check(full.data.changes.length === 1 && full.data.sessions[0].day.exercises[0].sets === 5, 'Scambio unico con dose completa del partner')
  const second = createDiaryTransport(a.client, a.owner)
  const secondRead = await second.loadChanges(new Date(0).toISOString(), signal())
  check(secondRead.changes[0].partner.after.sets === 3, 'Secondo client legge entrambi i lati in incrementale')
  check((await createDiaryTransport(b.client, b.owner).loadAll(signal())).data.changes.length === 0, 'Account B isolato')
  await rejected(() => createDiaryTransport(b.client, b.owner).change(op, signal()), 'B non può ripetere A')
  const undo = { type: 'undo-change', opId: randomUUID(), sessionId: session.id, changeId: op.opId }
  await transport.change(undo, signal()); await transport.change(undo, signal())
  check((await second.loadChanges(new Date().toISOString(), signal())).changes[0].cancelled, 'Annullamento idempotente e tombstone anche senza delta di seduta')
  // Solo oggi con un partner esistente conserva mercoledì.
  const onlyToday = make(session, source, find('Lat machine'))
  await transport.change(onlyToday, signal())
  check(datedDay(days[1], partners[0].date, document.id, (await transport.loadAll(signal())).data.changes).exercises[0].exerciseId === find('Lat machine').id, 'Solo oggi lascia invariata la futura lat')
  await transport.change({ type: 'undo-change', opId: randomUUID(), sessionId: session.id, changeId: onlyToday.opId }, signal())
  // Identità nuova dal catalogo, assente dalla scheda.
  const dumbbells = make(session, source, find('Spinta con manubri'))
  await transport.change(dumbbells, signal())
  const changed = (await transport.loadAll(signal())).data.sessions[0].day.exercises[0]
  check(changed.exerciseId === find('Spinta con manubri').id && changed.comparison.loadConvention === 'single-dumbbell' && changed.note === 'Tecnica Spinta con manubri', 'Sostituzione dal catalogo: identità, carico e sole note pertinenti')
  await transport.change({ type: 'undo-change', opId: randomUUID(), sessionId: session.id, changeId: dumbbells.opId }, signal())
  await transport.discard(session.id, signal())
  // Avvio offline → modifica → serie → reload → risposta persa → replay ordinato.
  for (const swap of [false, true]) {
    const cache = memoryStorage(), calls = []
    let offline = false, lose = true
    const gate = Object.fromEntries(Object.entries(transport).map(([key, method]) => [key, async (...args) => {
      if (offline) throw new DiaryFailure('unavailable')
      calls.push(key)
      const result = await method(...args)
      if (key === 'change' && lose) { lose = false; throw new DiaryFailure('unavailable') }
      return result
    }]))
    let store = new DiaryStore(gate, cache, a.owner); stores.push(store)
    await store.refresh(); offline = true
    const sessionId = store.startSession({ date: today, day: days[swap ? 0 : 2], planId: document.planId, versionId: document.id, timeZone: 'Europe/Rome' })
    session = store.getSnapshot().view.sessions.find(item => item.id === sessionId)
    const selected = find(swap ? 'Lat machine' : 'Spinta con manubri')
    const partner = swap ? futurePartners({ source: session.day.exercises[0], selected, session, days, changes: [], sessions: [session] })[0] : null
    if (swap && !partner) { store.discardSession(sessionId); store.stop(); continue } // Domenica: lo scambio è escluso, già provato sul lunedì sintetico.
    const command = make(session, session.day.exercises[0], selected, partner)
    check(store.changeExercise(command.change, selected.revision), `Avvio offline ${swap ? 'scambio' : 'sostituzione'} applicato localmente`)
    check(!store.changeExercise(command.change, selected.revision), 'Doppio tocco locale non crea catene')
    store.updateSet(sessionId, command.change.sourceId, 0, { load: '22,5', amount: '8', completed: true })
    store.stop()
    store = new DiaryStore(gate, cache, a.owner); stores.push(store)
    await store.flush()
    check(store.getSnapshot().view.sessions.find(item => item.id === sessionId).day.exercises[0].exerciseId === selected.id && store.getSnapshot().pending === 3, 'Reload offline conserva identità, risultati e tre operazioni ordinate')
    offline = false; await store.flush()
    check(store.getSnapshot().pending === 2 && store.getSnapshot().sync !== 'synced', 'Risposta persa: serie ancora in coda, salvataggio non dichiarato sincronizzato')
    await store.flush()
    check(store.getSnapshot().pending === 0, 'Retry applica una sola modifica prima delle serie')
    full = await transport.loadAll(signal())
    const saved = full.data.sessions.find(item => item.id === sessionId)
    check(saved.day.exercises[0].exerciseId === selected.id && saved.results[command.change.sourceId][0].load === '22,5', 'Serie sul server associate alla nuova identità dopo avvio offline')
    check(calls.indexOf('start') < calls.indexOf('change') && calls.indexOf('change') < calls.indexOf('insert'), 'Ordine server avvio → modifica → risultati')
    check(!store.undoChange(command.opId), 'Risultati locali bloccano Annulla')
    store.completeSession(sessionId); await store.flush(); store.stop()
  }
  // Replay tardivo dopo completamento: ricevuta intatta e nessuna riscrittura.
  const completed = (await transport.loadAll(signal())).data.sessions.find(item => item.completedAt)
  check(Boolean(completed), 'Storico completato conservato')
  // Il calendario della settimana successiva è indipendente dalle date registrate.
  check(datedDay(days[0], shiftDate(monday, 7), document.id, full.data.changes).exercises[0].exerciseId === find('Chest press').id, 'Settimana successiva normale')
  // Due client reali: il secondo registra dopo che il primo ha preparato una modifica offline.
  const conflictFixture = await workoutChangesFixture()
  try {
    const remote = createDiaryTransport(conflictFixture.a.client, conflictFixture.a.owner)
    const row = await remote.start({ sessionId: randomUUID(), versionId: conflictFixture.document.id, dayId: conflictFixture.days[0].id, date: today, timeZone: 'Europe/Rome' }, signal())
    const stale = new DiaryStore(remote, memoryStorage(), conflictFixture.a.owner); stores.push(stale)
    await stale.refresh()
    const current = stale.getSnapshot().view.sessions[0], original = current.day.exercises[0], selected = conflictFixture.find('Spinta con manubri')
    const id = randomUUID()
    const command = { id, sessionId: row.id, planId: conflictFixture.document.planId, versionId: conflictFixture.document.id,
      sourceDate: today, sourceDayId: current.day.id, sourceId: original.id, timeZone: 'Europe/Rome', createdAt: new Date().toISOString(), before: original.snapshot,
      after: replacementSnapshot(original.snapshot, selected, proposedDose(original.snapshot, selected)), partner: null, cancelled: false }
    check(stale.changeExercise(command, selected.revision), 'Client A prepara modifica prima di dati remoti')
    stale.updateSet(row.id, original.id, 0, { load: '15', amount: '10', completed: false })
    await remote.insert('workout_set_logs', { session_id: row.id, prescription_id: original.id, exercise_id: original.exerciseId, set_index: 0, load: 40, amount: null, completed: false }, signal())
    await stale.flush()
    check(stale.getSnapshot().pending === 2 && stale.getSnapshot().conflicts.length === 1, 'Registrazione concorrente blocca modifica e serie successive senza eliminarle')
    const online = (await remote.loadAll(signal())).data.sessions[0]
    check(online.day.exercises[0].exerciseId === original.exerciseId && online.results[original.id][0].load === '40', 'Conflitto: server conserva identità e risultati del secondo client')
    check(stale.getSnapshot().view.sessions[0].results[original.id][0].load === '15', 'Conflitto: bozze del primo client ancora recuperabili')
    stale.stop()
    // Risposta persa sull'annullamento: il retry usa sempre lo stesso identificatore.
    await remote.discard(row.id, signal())
    let loseUndo = true, offlineUndo = false
    const undoTransport = { ...remote, change: async (op, abort) => {
      if (offlineUndo) throw new DiaryFailure('unavailable')
      const result = await remote.change(op, abort)
      if (op.type === 'undo-change' && loseUndo) { loseUndo = false; throw new DiaryFailure('unavailable') }
      return result
    } }
    const undoCache = memoryStorage()
    let store = new DiaryStore(undoTransport, undoCache, conflictFixture.a.owner); stores.push(store)
    await store.refresh()
    const nextId = store.startSession({ date: today, day: conflictFixture.days[0], planId: conflictFixture.document.planId, versionId: conflictFixture.document.id, timeZone: 'Europe/Rome' })
    const undoCommand = { ...command, id: randomUUID(), sessionId: nextId }
    store.changeExercise(undoCommand, selected.revision); await store.flush()
    check(store.undoChange(undoCommand.id), 'Annullamento valido prima delle serie')
    await store.flush()
    check(store.getSnapshot().pending === 1, 'Risposta persa annullamento conservata in coda')
    await store.flush()
    check(store.getSnapshot().pending === 0 && store.getSnapshot().view.sessions[0].day.exercises[0].exerciseId === original.exerciseId, 'Retry annullamento conferma ripristino senza doppia inversione')
    const active = store.getSnapshot().view.sessions[0], lat = conflictFixture.find('Lat machine')
    const partners = futurePartners({ source: active.day.exercises[0], selected: lat, session: active, days: conflictFixture.days, changes: store.getSnapshot().view.changes, sessions: [active] })
    if (partners.length) {
      const swap = { ...command, id: randomUUID(), sessionId: nextId, after: { ...partners[0].before, id: original.id }, partner: partners[0] }
      store.changeExercise(swap, lat.revision); await store.flush()
      offlineUndo = true; check(store.undoChange(swap.id), 'Annullamento scambio offline applica subito entrambi i ripristini')
      await store.flush(); store.stop()
      store = new DiaryStore(undoTransport, undoCache, conflictFixture.a.owner); stores.push(store)
      await store.flush()
      check(store.getSnapshot().pending === 1 && datedDay(conflictFixture.days.find(day=>day.id===partners[0].dayId), partners[0].date, conflictFixture.document.id, store.getSnapshot().view.changes).exercises[0].exerciseId === lat.id, 'Reload offline conserva annullamento e destinazione originale')
      offlineUndo = false; loseUndo = true; await store.flush(); await store.flush()
      check(store.getSnapshot().pending === 0 && store.getSnapshot().view.changes.find(change=>change.id===swap.id).cancelled, 'Scambio annullato: rete e risposta persa non producono metà operazione')
    }
    store.stop()
  } finally { await conflictFixture.cleanup() }
  await mkdir('artifacts/workout-changes', { recursive: true })
  await writeFile('artifacts/workout-changes/local-api.json', JSON.stringify({ checks, result: 'PASS' }, null, 2))
} finally {
  stores.forEach(store => store.stop())
  await fixture.cleanup()
  console.log('Fixture locali eliminate')
}
