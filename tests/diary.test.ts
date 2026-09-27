import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOp, emptyDiary, mealLogKey, replay, setValues, suggestedDay, workoutDaysFromProgram } from '../src/domain/diary.ts'
import type { DiaryData } from '../src/domain/diary.ts'
import type { Meal, WorkoutDay } from '../src/domain/types.ts'
import type { ProgramDocument } from '../src/domain/programs.ts'
import { buildDiary, DiaryFailure } from '../src/persistence/diary-repository.ts'
import type { DiaryTransport, Row, RowKey } from '../src/persistence/diary-repository.ts'
import { DiaryStore, memoryStorage } from '../src/persistence/diary-store.ts'

const OWNER = '11111111-1111-4111-8111-111111111111'
const DAY = 'dddddddd-0000-4000-8000-000000000001'
const P1 = 'eeeeeeee-0000-4000-8000-000000000001'
const EX = 'aaaaaaaa-0000-4000-8000-000000000001'
const MEAL = '99999999-0000-4000-8000-000000000021'
const PLAN = '99999999-0000-4000-8000-000000000001'
const meal: Meal = { id: MEAL, name: 'Colazione', timeLabel: '07:30', description: 'Yogurt', items: ['Yogurt · 150 g'], alternative: '', alternatives: [], additions: [], note: '' }
const snapshotExercise = { id: P1, exercise_id: EX, name: 'Squat di prova', variant: '', equipment: 'bilanciere', load_convention: 'total', load_unit: 'kg', per_side: false, exercise_note: '', mode: 'reps', sets: 2, optional_sets: 1, reps_min: 8, reps_max: 10, duration_seconds: null, rest_seconds: 90, rir: 2, rpe: null, note: '' }
const snapshot = { label: 'A', title: 'Seduta A', note: '', plan_title: 'Programma', version_number: 1, exercises: [snapshotExercise] }
const day: WorkoutDay = { id: DAY, label: 'A', title: 'Seduta A', subtitle: 'Programma', exercises: [{ id: P1, exerciseId: EX, name: 'Squat di prova', area: 'bilanciere', sets: 2, optionalSets: 1, target: '8–10', mode: 'reps', restSeconds: 90, note: '', loadUnit: 'kg', comparison: { variant: '', equipment: 'bilanciere', loadConvention: 'total', perSide: false } }] }

/** Server simulato con le stesse regole di revisione/unicità del database. */
function fakeServer() {
  const tables: Record<string, Row[]> = { workout_sessions: [], workout_set_logs: [], meal_logs: [], diary_days: [] }
  const calls: string[] = []
  let offline = false
  let loseNextResponse = false
  const match = (row: Row, key: RowKey) => Object.entries(key).every(([column, value]) => row[column] === value)
  const reply = <T>(value: T): T => { if (loseNextResponse) { loseNextResponse = false; throw new DiaryFailure('unavailable') } return value }
  const transport: DiaryTransport = {
    async loadAll() {
      if (offline) throw new DiaryFailure('unavailable')
      return buildDiary(tables.workout_sessions!, tables.workout_set_logs!, tables.meal_logs!, tables.diary_days!)
    },
    async start(args) {
      calls.push('start')
      if (offline) throw new DiaryFailure('unavailable')
      const existing = tables.workout_sessions!.find(row => row.id === args.sessionId)
      if (existing) return reply(existing)
      if (tables.workout_sessions!.some(row => row.status === 'active')) throw new DiaryFailure('conflict')
      const row = { id: args.sessionId, owner_id: OWNER, plan_id: PLAN, day_id: args.dayId, diary_date: args.date, day_snapshot: snapshot, status: 'active', started_at: '2026-09-28T08:00:00Z', completed_at: null, revision: 1 }
      tables.workout_sessions!.push(row)
      return reply(row)
    },
    async insert(table, values) {
      calls.push(`insert:${table}`)
      if (offline) throw new DiaryFailure('unavailable')
      const key = table === 'workout_set_logs' ? ['session_id', 'prescription_id', 'set_index'] : table === 'meal_logs' ? ['diary_date', 'meal_id'] : ['diary_date']
      if (tables[table]!.some(row => key.every(column => row[column] === values[column]))) throw new DiaryFailure('conflict')
      const row = { owner_id: OWNER, ...values, revision: 1 }
      tables[table]!.push(row)
      return reply(row)
    },
    async update(table, key, values, next) {
      calls.push(`update:${table}`)
      if (offline) throw new DiaryFailure('unavailable')
      const row = tables[table]!.find(item => match(item, key))
      if (!row) return null
      if (next !== (row.revision as number) + 1) throw new DiaryFailure('conflict')
      Object.assign(row, values, { revision: next }, table === 'workout_sessions' && values.status === 'completed' ? { completed_at: '2026-09-28T09:00:00Z' } : {})
      return reply({ ...row })
    },
    async fetch(table, key) {
      calls.push(`fetch:${table}`)
      if (offline) throw new DiaryFailure('unavailable')
      const row = tables[table]!.find(item => match(item, key))
      return row ? { ...row } : null
    },
    async discard(sessionId) {
      calls.push('discard')
      const index = tables.workout_sessions!.findIndex(row => row.id === sessionId && row.status === 'active')
      if (index < 0) return false
      tables.workout_sessions!.splice(index, 1)
      tables.workout_set_logs = tables.workout_set_logs!.filter(row => row.session_id !== sessionId)
      return true
    },
  }
  return { tables, calls, transport, setOffline: (value: boolean) => { offline = value }, loseNext: () => { loseNextResponse = true } }
}

async function settle(store: DiaryStore) { await store.flush() }

test('dominio: il contesto del primo pasto registrato non segue modifiche successive', () => {
  let data: DiaryData = emptyDiary()
  data = applyOp(data, { type: 'meal', opId: '1', date: '2026-09-24', planId: PLAN, meal, status: 'modified', note: 'Nota ieri', dayType: 'training' })
  data = applyOp(data, { type: 'meal', opId: '2', date: '2026-09-25', planId: PLAN, meal, status: 'followed', note: '', dayType: 'rest' })
  data = applyOp(data, { type: 'day', opId: '3', date: '2026-09-24', dayType: 'rest' })
  data = applyOp(data, { type: 'meal', opId: '4', date: '2026-09-24', planId: PLAN, meal: { ...meal, name: 'Nome successivo' }, status: 'skipped', note: 'Correzione', dayType: 'rest' })
  const yesterday = data.mealLogs[mealLogKey('2026-09-24', MEAL)]!
  assert.equal(yesterday.snapshot.name, 'Colazione')
  assert.equal(yesterday.dayType, 'training')
  assert.equal(yesterday.status, 'skipped')
  assert.equal(data.mealLogs[mealLogKey('2026-09-25', MEAL)]!.status, 'followed')
})

test('dominio: valori delle serie normalizzati; input incompleti trattenuti', () => {
  assert.deepEqual(setValues({ load: '12,5', amount: '10', completed: true }, 'reps'), { load: 12.5, amount: 10, completed: true })
  assert.deepEqual(setValues({ load: '', amount: '', completed: false }, 'reps'), { load: null, amount: null, completed: false })
  assert.equal(setValues({ load: '12,', amount: '', completed: false }, 'reps'), null)
  assert.equal(setValues({ load: '', amount: '8,5', completed: false }, 'reps'), null)
  assert.deepEqual(setValues({ load: '', amount: '32,5', completed: true }, 'seconds'), { load: null, amount: 32.5, completed: true })
  assert.equal(setValues({ load: '', amount: '', completed: true }, 'reps'), null)
})

test('dominio: versione pubblicata e snapshot producono la stessa seduta; rotazione suggerita', () => {
  const document: ProgramDocument = { planId: 'p', id: 'v', title: 'Programma', guidance: '', days: [
    { id: DAY, label: 'A', title: 'Seduta A', note: '', exercises: [{ id: P1, exercise: { id: EX, name: 'Squat di prova', variant: '', equipment: 'bilanciere', loadConvention: 'total', loadUnit: 'kg', measurementMode: 'reps', perSide: false, note: '' }, sets: '2', optionalSets: '1', repsMin: '8', repsMax: '10', durationSeconds: '', restSeconds: '90', rir: '2', rpe: '', note: '' }] },
    { id: 'day-b', label: 'B', title: 'Seduta B', note: '', exercises: [] },
  ] }
  const days = workoutDaysFromProgram(document)
  const fromSnapshot = buildDiary([{ id: 'ffffffff-0000-4000-8000-000000000001', owner_id: OWNER, plan_id: PLAN, day_id: DAY, diary_date: '2026-09-28', day_snapshot: snapshot, status: 'completed', started_at: '2026-09-28T08:00:00Z', completed_at: '2026-09-28T09:00:00Z', revision: 2 }], [], [], [])
  const session = fromSnapshot.data.sessions[0]!
  assert.deepEqual(session.day.exercises[0], days[0]!.exercises[0])
  assert.equal(session.results[P1]!.length, 3)
  assert.equal(days[0]!.exercises[0]!.effortLabel, 'RIR 2')
  assert.equal(suggestedDay(days, [])?.label, 'A')
  assert.equal(suggestedDay(days, [session])?.label, 'B')
  // Nuova versione con ID diversi: la rotazione segue l'etichetta.
  assert.equal(suggestedDay(days.map(item => ({ ...item, id: `${item.id}-v2` })), [session])?.label, 'B')
})

test('seduta: avvio, serie e completamento restano sul dispositivo e arrivano in ordine', async () => {
  const server = fakeServer(), storage = memoryStorage()
  const store = new DiaryStore(server.transport, storage, OWNER)
  await store.refresh()
  const id = store.startSession({ date: '2026-09-28', day, planId: 'plan', versionId: 'version', timeZone: 'Europe/Rome' })!
  assert.ok(id)
  assert.equal(store.startSession({ date: '2026-09-29', day, planId: 'plan', versionId: 'version', timeZone: 'Europe/Rome' }), null, 'una sola seduta in corso')
  for (const load of ['1', '12', '12,', '12,5']) store.updateSet(id, P1, 0, { load, amount: '', completed: false })
  store.updateSet(id, P1, 0, { load: '12,5', amount: '10', completed: true })
  assert.equal(store.getSnapshot().restTimer?.setIndex, 0, 'recupero avviato da Fatto')
  assert.equal(store.getSnapshot().pending, 2, 'modifiche della stessa serie unite in un solo invio')
  // Un nuovo store sulla stessa memoria ritrova coda e vista: nessuna perdita al reload.
  const reloaded = new DiaryStore(server.transport, storage, OWNER)
  assert.equal(reloaded.getSnapshot().view.sessions[0]!.results[P1]![0]!.load, '12,5')
  await settle(reloaded)
  assert.deepEqual(server.calls, ['start', 'insert:workout_set_logs'])
  assert.equal(server.tables.workout_set_logs![0]!.load, 12.5)
  assert.equal(reloaded.getSnapshot().sync, 'synced')
  reloaded.completeSession(id)
  await settle(reloaded)
  assert.equal(server.tables.workout_sessions![0]!.status, 'completed')
  assert.equal(reloaded.getSnapshot().restTimer, null)
  await reloaded.refresh()
  const saved = reloaded.getSnapshot().view.sessions[0]!
  assert.equal(saved.completedAt, '2026-09-28T09:00:00Z')
  assert.deepEqual(saved.results[P1]![0], { load: '12,5', amount: '10', completed: true })
  store.stop(); reloaded.stop()
})

test('offline: la coda attende, poi riprende senza duplicare; risposta persa verificata', async () => {
  const server = fakeServer()
  const store = new DiaryStore(server.transport, memoryStorage(), OWNER)
  await store.refresh()
  server.setOffline(true)
  const id = store.startSession({ date: '2026-09-28', day, planId: 'plan', versionId: 'version', timeZone: 'Europe/Rome' })!
  store.updateSet(id, P1, 1, { load: '20', amount: '8', completed: true })
  await settle(store)
  assert.equal(store.getSnapshot().sync, 'waiting')
  assert.equal(store.getSnapshot().pending, 2)
  server.setOffline(false)
  server.loseNext()
  await settle(store)
  assert.equal(store.getSnapshot().sync, 'waiting', 'risposta persa: operazione ancora in coda')
  await settle(store)
  assert.equal(server.tables.workout_sessions!.length, 1, 'avvio idempotente')
  assert.equal(server.tables.workout_set_logs!.length, 1)
  server.loseNext()
  store.updateSet(id, P1, 1, { load: '22', amount: '8', completed: true })
  await settle(store)
  await settle(store)
  assert.equal(server.tables.workout_set_logs![0]!.load, 22)
  assert.equal(server.tables.workout_set_logs![0]!.revision, 2, 'nessun doppio update dopo la risposta persa')
  assert.equal(store.getSnapshot().sync, 'synced')
  store.stop()
})

test('conflitto: valore diverso online non viene sovrascritto senza una scelta', async () => {
  const server = fakeServer()
  const phone = new DiaryStore(server.transport, memoryStorage(), OWNER)
  const laptop = new DiaryStore(server.transport, memoryStorage(), OWNER)
  await phone.refresh(); await laptop.refresh()
  phone.recordMeal('2026-09-28', PLAN, meal, 'followed', '')
  laptop.recordMeal('2026-09-28', PLAN, meal, 'modified', 'Meno yogurt')
  await settle(phone); await settle(laptop)
  assert.equal(server.tables.meal_logs!.length, 1)
  assert.equal(server.tables.meal_logs![0]!.status, 'followed')
  const conflict = laptop.getSnapshot().conflicts[0]!
  assert.equal(laptop.getSnapshot().sync, 'conflict')
  assert.match(conflict.remote, /followed/)
  assert.equal(laptop.getSnapshot().view.mealLogs[mealLogKey('2026-09-28', MEAL)]!.status, 'followed', 'la vista mostra il valore online')
  laptop.keepMine(conflict.id)
  await settle(laptop)
  assert.equal(server.tables.meal_logs![0]!.status, 'modified')
  assert.equal(server.tables.meal_logs![0]!.revision, 2)
  phone.setDayType('2026-09-28', 'rest'); await settle(phone)
  laptop.setDayType('2026-09-28', 'training'); await settle(laptop)
  const second = laptop.getSnapshot().conflicts[0]!
  laptop.useOnline(second.id)
  assert.equal(laptop.getSnapshot().view.dayTypes['2026-09-28'], 'rest')
  assert.equal(server.tables.diary_days![0]!.day_type, 'rest')
  phone.stop(); laptop.stop()
})

test('seduta: avvio respinto se un altro dispositivo ne ha già una; annullamento locale e online', async () => {
  const server = fakeServer()
  const other = new DiaryStore(server.transport, memoryStorage(), OWNER)
  const store = new DiaryStore(server.transport, memoryStorage(), OWNER)
  await other.refresh(); await store.refresh()
  other.startSession({ date: '2026-09-28', day, planId: 'plan', versionId: 'version', timeZone: 'Europe/Rome' })
  await settle(other)
  const mine = store.startSession({ date: '2026-09-28', day, planId: 'plan', versionId: 'version', timeZone: 'Europe/Rome' })!
  store.updateSet(mine, P1, 0, { load: '10', amount: '8', completed: true })
  await settle(store)
  const blocked = store.getSnapshot().conflicts[0]!
  assert.equal(blocked.kind, 'blocked')
  assert.equal(store.getSnapshot().pending, 2, 'avvio e serie restano sul dispositivo, fermi')
  assert.equal(store.getSnapshot().view.sessions.find(item => item.id === mine)!.results[P1]![0]!.load, '10', 'la serie registrata resta visibile')
  assert.equal(server.tables.workout_sessions!.length, 1)
  assert.equal(server.tables.workout_set_logs!.length, 0, 'nessuna serie inviata mentre la seduta è ferma')
  // Riprova prima di chiudere l'altra seduta: di nuovo ferma, nessuna perdita.
  store.keepMine(blocked.id); await settle(store)
  assert.equal(store.getSnapshot().conflicts[0]?.kind, 'blocked')
  assert.equal(store.getSnapshot().pending, 2)
  // L'altra seduta viene completata: Riprova invia avvio e serie.
  await other.refresh()
  other.completeSession(other.getSnapshot().view.sessions.find(item => !item.completedAt)!.id); await settle(other)
  store.keepMine(store.getSnapshot().conflicts[0]!.id); await settle(store)
  assert.equal(store.getSnapshot().sync, 'synced')
  assert.equal(server.tables.workout_set_logs!.filter(row => row.session_id === mine).length, 1, 'serie conservata e inviata')
  store.completeSession(mine); await settle(store)
  // Scarto esplicito di una seduta ferma: solo sul dispositivo, dopo la scelta dell'utente.
  other.startSession({ date: '2026-09-29', day, planId: 'plan', versionId: 'version', timeZone: 'Europe/Rome' }); await settle(other)
  const again = store.startSession({ date: '2026-09-29', day, planId: 'plan', versionId: 'version', timeZone: 'Europe/Rome' })!
  store.updateSet(again, P1, 0, { load: '11', amount: '8', completed: true }); await settle(store)
  store.discardSession(again)
  assert.equal(store.getSnapshot().pending, 0)
  assert.equal(store.getSnapshot().conflicts.length, 0)
  assert.equal(store.getSnapshot().view.sessions.some(item => item.id === again), false)
  await other.refresh()
  other.discardSession(other.getSnapshot().view.sessions.find(item => !item.completedAt)!.id); await settle(other)
  // Annullare una seduta mai inviata non contatta il server.
  const local = new DiaryStore(server.transport, memoryStorage(), OWNER)
  server.setOffline(true)
  const draft = local.startSession({ date: '2026-09-30', day, planId: 'plan', versionId: 'version', timeZone: 'Europe/Rome' })!
  local.discardSession(draft)
  assert.equal(local.getSnapshot().pending, 0)
  assert.equal(local.getSnapshot().view.sessions.length, 0)
  server.setOffline(false)
  await other.refresh()
  other.startSession({ date: '2026-09-30', day, planId: 'plan', versionId: 'version', timeZone: 'Europe/Rome' }); await settle(other)
  other.discardSession(other.getSnapshot().view.sessions.find(item => !item.completedAt)!.id)
  await settle(other)
  assert.equal(server.tables.workout_sessions!.filter(row => row.status === 'active').length, 0)
  other.stop(); store.stop(); local.stop()
})

test('senza Supabase: solo memoria, nessun invio; archivi separati per account', async () => {
  const storage = memoryStorage()
  const local = new DiaryStore(null, storage, 'local')
  local.recordMeal('2026-09-28', 'local', meal, 'followed', '')
  assert.equal(local.getSnapshot().sync, 'local')
  assert.ok(local.hasVolatileData)
  const server = fakeServer()
  const a = new DiaryStore(server.transport, storage, OWNER)
  a.recordMeal('2026-09-28', PLAN, meal, 'followed', '')
  const b = new DiaryStore(server.transport, storage, '22222222-2222-4222-8222-222222222222')
  assert.equal(Object.keys(b.getSnapshot().view.mealLogs).length, 0, 'nessun dato di A sotto B')
  a.clearDevice()
  assert.equal(Object.keys(new DiaryStore(server.transport, storage, OWNER).getSnapshot().view.mealLogs).length, 0, 'uscita esplicita rimuove la copia locale')
  assert.equal(replay(emptyDiary(), []).sessions.length, 0)
  a.stop(); b.stop()
})

test('risposta persa e nuova modifica della stessa serie: nessun falso conflitto', async () => {
  const server = fakeServer()
  const store = new DiaryStore(server.transport, memoryStorage(), OWNER)
  await store.refresh()
  const id = store.startSession({ date: '2026-09-28', day, planId: 'plan', versionId: 'version', timeZone: 'Europe/Rome' })!
  await settle(store)
  server.loseNext()
  store.updateSet(id, P1, 0, { load: '20', amount: '8', completed: true })
  await settle(store)
  assert.equal(server.tables.workout_set_logs![0]!.load, 20, 'il server ha applicato la prima scrittura')
  assert.equal(store.getSnapshot().sync, 'waiting')
  store.updateSet(id, P1, 0, { load: '22', amount: '8', completed: true })
  assert.equal(store.getSnapshot().pending, 2, 'la modifica non si unisce a un invio già tentato')
  await settle(store)
  assert.equal(store.getSnapshot().sync, 'synced', JSON.stringify(store.getSnapshot().conflicts))
  assert.equal(server.tables.workout_set_logs![0]!.load, 22)
  assert.equal(server.tables.workout_set_logs![0]!.revision, 2)
  store.stop()
})

test('due schede dello stesso account: nessuna coda sovrascritta, nessun doppio invio', async () => {
  const server = fakeServer(), storage = memoryStorage()
  const tabA = new DiaryStore(server.transport, storage, OWNER)
  const tabB = new DiaryStore(server.transport, storage, OWNER)
  server.setOffline(true)
  tabA.recordMeal('2026-09-27', PLAN, meal, 'followed', '')
  tabB.setDayType('2026-09-28', 'rest')
  // B non aveva letto la registrazione di A: la sua scrittura la conserva nell'archivio.
  const reopened = new DiaryStore(server.transport, storage, OWNER)
  assert.equal(reopened.getSnapshot().pending, 2)
  tabA.reloadFromDevice()
  assert.equal(tabA.getSnapshot().pending, 2)
  server.setOffline(false)
  await settle(tabA)
  assert.equal(server.tables.meal_logs!.length, 1); assert.equal(server.tables.diary_days!.length, 1)
  tabB.reloadFromDevice()
  assert.equal(tabB.getSnapshot().pending, 0, 'le operazioni inviate da A non restano in B')
  const calls = server.calls.length
  await settle(tabB)
  assert.equal(server.calls.length, calls, 'B non reinvia')
  assert.equal(tabB.getSnapshot().view.dayTypes['2026-09-28'], 'rest')
  tabA.stop(); tabB.stop(); reopened.stop()
})

test('correzione dello storico: valori incompleti scartati alla fine della correzione', async () => {
  const server = fakeServer()
  const store = new DiaryStore(server.transport, memoryStorage(), OWNER)
  await store.refresh()
  const id = store.startSession({ date: '2026-09-28', day, planId: 'plan', versionId: 'version', timeZone: 'Europe/Rome' })!
  store.updateSet(id, P1, 0, { load: '10', amount: '8', completed: true })
  store.completeSession(id)
  await settle(store)
  store.updateSet(id, P1, 0, { load: '10,', amount: '8', completed: false })
  await settle(store)
  assert.equal(store.getSnapshot().pending, 1, 'valore incompleto trattenuto sul dispositivo')
  store.discardIncomplete(id)
  assert.equal(store.getSnapshot().pending, 0)
  assert.deepEqual(store.getSnapshot().view.sessions[0]!.results[P1]![0], { load: '10', amount: '8', completed: true })
  store.stop()
})

test('Riprova ora: un invio rimasto appeso viene interrotto e ripetuto senza duplicati', async () => {
  const server = fakeServer()
  let hang = true
  const transport = { ...server.transport, insert: async (table: Parameters<typeof server.transport.insert>[0], values: Row, signal: AbortSignal) => {
    if (hang) { hang = false; await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DiaryFailure('unavailable')), { once: true })) }
    return server.transport.insert(table, values, signal)
  } }
  const store = new DiaryStore(transport, memoryStorage(), OWNER)
  await store.refresh()
  store.setDayType('2026-09-28', 'rest')
  const stuck = store.flush()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(store.getSnapshot().sync, 'sending')
  store.retryNow()
  await stuck
  for (let i = 0; i < 50 && store.getSnapshot().sync !== 'synced'; i++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(store.getSnapshot().sync, 'synced')
  assert.equal(server.tables.diary_days!.length, 1)
  store.stop()
})
