import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { emptyDiary } from '../src/domain/diary.ts'
import type { DiaryData } from '../src/domain/diary.ts'
import type { ServerArchive, ServerCopy } from '../src/persistence/diary-archive.ts'
import { keyValueArchive } from '../src/persistence/diary-archive.ts'
import { buildDiary, createDiaryTransport, DiaryFailure, latestCursor, mergeDiary, serverTime } from '../src/persistence/diary-repository.ts'
import type { DiaryChanges, DiaryTransport, Row } from '../src/persistence/diary-repository.ts'
import { CURSOR_OVERLAP_MS, DiaryStore, FULL_REFRESH_MS, memoryStorage } from '../src/persistence/diary-store.ts'

// Archivio del diario: coda piccola in localStorage, copia confermata a parte, letture incrementali.
const OWNER = '11111111-1111-4111-8111-111111111111'
const S1 = '33333333-3333-4333-8333-000000000001', S2 = '33333333-3333-4333-8333-000000000002'
const P1 = 'eeeeeeee-0000-4000-8000-000000000001', EX = 'aaaaaaaa-0000-4000-8000-000000000001'
const DAY = 'dddddddd-0000-4000-8000-000000000001', PLAN = '99999999-0000-4000-8000-000000000001'
const MEAL = '99999999-0000-4000-8000-000000000021'
const exercise = { id: P1, exercise_id: EX, name: 'Squat di prova', variant: '', equipment: '', load_convention: 'total', load_unit: 'kg', per_side: false, exercise_note: '', mode: 'reps', sets: 2, optional_sets: 0, reps_min: 8, reps_max: 10, duration_seconds: null, rest_seconds: 90, rir: null, rpe: null, note: '' }
const sessionRow = (id: string, status: 'active' | 'completed', updated = '2026-10-01T08:00:00.123456+00:00', revision = 1) => ({
  id, owner_id: OWNER, plan_id: PLAN, day_id: DAY, diary_date: '2026-10-01', day_snapshot: { label: 'A', title: 'Seduta A', note: '', plan_title: 'P', version_number: 1, exercises: [exercise] },
  status, started_at: '2026-10-01T08:00:00Z', completed_at: status === 'completed' ? '2026-10-01T09:00:00Z' : null, revision, updated_at: updated,
})
const setRow = (session: string, index: number, load: number, updated = '2026-10-01T08:10:00+00:00') => ({ id: crypto.randomUUID(), owner_id: OWNER, session_id: session, prescription_id: P1, set_index: index, load, amount: 8, completed: true, revision: 1, updated_at: updated })
const mealRow = (date: string, status = 'followed', updated = '2026-10-02T12:00:00+00:00') => ({ id: crypto.randomUUID(), owner_id: OWNER, diary_date: date, meal_id: MEAL, meal_plan_id: PLAN, status, note: '', day_type: 'training', revision: 1, updated_at: updated,
  meal_snapshot: { id: MEAL, name: 'Pranzo', timeLabel: '', description: '', items: [], alternative: '', alternatives: [], additions: [], note: '' } })
const noChanges = (extra: Partial<DiaryChanges> = {}): DiaryChanges => ({ sessions: [], sets: [], meals: [], days: [], activeSessionIds: [], cursor: null, ...extra })
const flushed = () => new Promise(resolve => setTimeout(resolve, 10))

// ------------------------------------------------------------------ unione delle modifiche
test('merge: seduta completata altrove conserva le serie lette; nuove serie e pasti applicati', () => {
  const base = buildDiary([sessionRow(S1, 'active')], [setRow(S1, 0, 60)], [], [])
  const merged = mergeDiary(base.data, base.revisions, noChanges({ sessions: [sessionRow(S1, 'completed', undefined, 2)], sets: [setRow(S1, 1, 62.5)], meals: [mealRow('2026-10-02')], activeSessionIds: [] }))
  const session = merged.data.sessions[0]!
  assert.equal(session.completedAt, '2026-10-01T09:00:00Z')
  assert.deepEqual(session.results[P1]!.map(set => set.load), ['60', '62,5'], 'serie già lette e nuove insieme')
  assert.equal(merged.revisions[`session:${S1}`], 2)
  assert.equal(merged.data.mealLogs[`2026-10-02:${MEAL}`]?.status, 'followed')
  assert.notEqual(merged.data, base.data, 'la copia di partenza non viene modificata')
  assert.equal(base.data.sessions[0]!.completedAt, undefined)
})

test('merge: seduta attiva annullata su un altro dispositivo esce dalla copia con le sue serie', () => {
  const base = buildDiary([sessionRow(S1, 'active'), sessionRow(S2, 'completed')], [setRow(S1, 0, 60)], [], [])
  const merged = mergeDiary(base.data, base.revisions, noChanges({ activeSessionIds: [] }))
  assert.deepEqual(merged.data.sessions.map(session => session.id), [S2], 'completate mai rimosse')
  assert.equal(Object.keys(merged.revisions).some(key => key.includes(S1)), false)
  const kept = mergeDiary(base.data, base.revisions, noChanges({ activeSessionIds: [S1] }))
  assert.equal(kept.data.sessions.length, 2, 'ancora attiva sul server: resta')
})

test('merge: serie di una seduta mai letta → errore (si ripiega su una lettura completa)', () => {
  assert.throws(() => mergeDiary(emptyDiary(), {}, noChanges({ sets: [setRow(S1, 0, 60)] })), DiaryFailure)
})

test('cursore: updated_at più recente, microsecondi accettati', () => {
  assert.equal(latestCursor(null, [{ updated_at: '2026-10-01T08:00:00.999999+00:00' }, { updated_at: '2026-10-01T07:00:00+00:00' }, {}]), '2026-10-01T08:00:00.999999+00:00')
  assert.equal(latestCursor('2026-10-02T00:00:00+00:00', [{ updated_at: '2026-10-01T00:00:00+00:00' }]), '2026-10-02T00:00:00+00:00')
  assert.ok(Number.isFinite(serverTime('2026-10-01T08:00:00.123456+00:00')))
})

// ------------------------------------------------------------------ store: letture e archivio
function server(initial: DiaryData = emptyDiary()) {
  const calls: string[] = []
  let changes: DiaryChanges = noChanges()
  const transport: DiaryTransport = {
    loadAll: async () => { calls.push('full'); return { data: structuredClone(initial), revisions: {}, cursor: '2026-10-01T10:00:00+00:00' } },
    loadChanges: async since => { calls.push(`changes:${since}`); return changes },
    insert: async (_table, values) => ({ owner_id: OWNER, ...values, revision: 1 }) as Row,
  } as unknown as DiaryTransport
  return { transport, calls, setChanges: (value: DiaryChanges) => { changes = value } }
}

test('dopo una lettura completa la successiva è incrementale (cursore meno il margine); dopo 24 ore di nuovo completa', async () => {
  const { transport, calls, setChanges } = server()
  const storage = memoryStorage()
  const store = new DiaryStore(transport, storage, OWNER)
  await store.refresh()
  setChanges(noChanges({ meals: [mealRow('2026-10-02')], cursor: '2026-10-02T12:00:00+00:00' }))
  await store.refresh()
  const since = new Date(Date.parse('2026-10-01T10:00:00Z') - CURSOR_OVERLAP_MS).toISOString()
  assert.deepEqual(calls, ['full', `changes:${since}`])
  assert.equal(store.getSnapshot().view.mealLogs[`2026-10-02:${MEAL}`]?.status, 'followed')
  // Lettura completa ormai vecchia: si rilegge tutto.
  const archive = keyValueArchive(storage, OWNER)
  const copy = (await archive.load())!
  await archive.save({ ...copy, fullAt: new Date(Date.now() - FULL_REFRESH_MS - 1000).toISOString() })
  store.stop()
  const reopened = new DiaryStore(transport, storage, OWNER)
  await reopened.refresh()
  assert.equal(calls.at(-1), 'full')
  reopened.stop()
})

test('modifiche non applicabili alla copia: ripiego immediato sulla lettura completa', async () => {
  const { transport, calls, setChanges } = server()
  const store = new DiaryStore(transport, memoryStorage(), OWNER)
  await store.refresh()
  setChanges(noChanges({ sets: [setRow(S1, 0, 60)] }))
  await store.refresh()
  assert.equal(calls.filter(call => call === 'full').length, 2)
  assert.equal(store.getSnapshot().phase, 'ready')
  store.stop()
})

test('ogni tasto scrive solo la coda: la copia confermata si salva dopo letture e invii', async () => {
  const history = buildDiary(Array.from({ length: 40 }, (_, i) => sessionRow(`33333333-3333-4333-8333-${String(i).padStart(12, '0')}`, 'completed')), [], [], [])
  const { transport } = server(history.data)
  const writes: string[] = []
  const base = memoryStorage()
  const storage = { ...base, set: (key: string, value: string) => { writes.push(key); base.set(key, value) } }
  const store = new DiaryStore(transport, storage, OWNER)
  await store.refresh(); await flushed()
  const serverKey = `peppitness:diary:v2:${OWNER}:server`
  assert.ok(writes.includes(serverKey), 'copia confermata salvata dopo la lettura')
  writes.length = 0
  for (const type of ['rest', 'training', 'rest'] as const) store.setDayType('2026-10-03', type)
  assert.ok(writes.length > 0 && writes.every(key => key === store.storageKey), 'solo la coda durante le modifiche')
  assert.ok(base.get(store.storageKey)!.length < 2000, 'coda di pochi byte anche con molta storia')
  assert.ok(base.get(serverKey)!.length > 20_000)
  await store.flush(); await flushed()
  assert.ok(writes.includes(serverKey), 'invio confermato: copia confermata aggiornata')
  store.stop()
})

test('conversione dal formato v1: coda e copia conservate, vecchia chiave rimossa dopo il salvataggio', async () => {
  const storage = memoryStorage()
  const history = buildDiary([sessionRow(S2, 'completed')], [], [], [])
  const op = { type: 'day', opId: crypto.randomUUID(), date: '2026-10-03', dayType: 'rest' }
  storage.set(`peppitness:diary:v1:${OWNER}`, JSON.stringify({ version: 1, server: history.data, revisions: history.revisions, queue: [op], conflicts: [], restTimer: null, refreshedAt: '2026-10-03T08:00:00.000Z', attempted: [], blocked: [] }))
  const offline = { loadAll: async () => { throw new DiaryFailure('unavailable') }, insert: async () => { throw new DiaryFailure('unavailable') } } as unknown as DiaryTransport
  const store = new DiaryStore(offline, storage, OWNER)
  assert.equal(store.getSnapshot().pending, 1, 'coda disponibile subito')
  await flushed()
  const state = store.getSnapshot()
  assert.equal(state.phase, 'ready')
  assert.equal(state.view.sessions[0]?.id, S2, 'storia confermata dalla copia v1')
  assert.equal(state.view.dayTypes['2026-10-03'], 'rest')
  assert.equal(storage.get(`peppitness:diary:v1:${OWNER}`), null, 'vecchia chiave rimossa')
  assert.ok(storage.get(`peppitness:diary:v2:${OWNER}:server`))
  store.stop()
  const reopened = new DiaryStore(offline, storage, OWNER)
  await flushed()
  assert.equal(reopened.getSnapshot().view.sessions[0]?.id, S2)
  assert.equal(reopened.getSnapshot().pending, 1)
  reopened.stop()
})

test('uscita: coda, copia confermata e vecchio formato rimossi, anche con un salvataggio in corso', async () => {
  const storage = memoryStorage()
  let release!: () => void
  const saved: ServerCopy[] = []
  let removed = 0
  const archive: ServerArchive = {
    load: async () => null,
    save: copy => new Promise(resolve => { release = () => { saved.push(copy); resolve() } }),
    remove: async () => { removed++; saved.length = 0 },
  }
  const { transport } = server()
  const store = new DiaryStore(transport, storage, OWNER, archive)
  await store.refresh()
  storage.set(`peppitness:diary:v1:${OWNER}`, '{}')
  store.clearDevice()
  release(); await flushed()
  assert.equal(removed, 1)
  assert.deepEqual(saved, [], 'la rimozione arriva dopo il salvataggio in corso')
  assert.equal(storage.get(store.storageKey), null)
  assert.equal(storage.get(`peppitness:diary:v1:${OWNER}`), null)
})

test('due schede: la copia confermata salvata da una viene adottata dall’altra', async () => {
  const storage = memoryStorage()
  const first = server(), second = server()
  const tabA = new DiaryStore(first.transport, storage, OWNER)
  const tabB = new DiaryStore(second.transport, storage, OWNER)
  await tabA.refresh(); await tabB.refresh(); await flushed()
  first.setChanges(noChanges({ meals: [mealRow('2026-10-04')], cursor: '2026-10-04T12:00:00+00:00' }))
  await tabA.refresh(); await flushed()
  tabB.reloadFromDevice(); await flushed()
  assert.equal(tabB.getSnapshot().view.mealLogs[`2026-10-04:${MEAL}`]?.status, 'followed')
  tabA.stop(); tabB.stop()
})

// ------------------------------------------------------------------ trasporto reale con client simulato
test('trasporto: lettura incrementale con filtro updated_at, sedute attive lette per prime', async () => {
  const calls: string[] = []
  const builder = (table: string, rows: unknown[]) => {
    const chain: Record<string, unknown> = {}
    for (const method of ['setHeader', 'abortSignal', 'retry', 'select', 'order', 'range']) chain[method] = () => chain
    chain.eq = (column: string, value: string) => { if (column !== 'owner_id') calls.push(`${table}:${column}=${value}`); return chain }
    chain.gt = (column: string, value: string) => { calls.push(`${table}:${column}>${value}`); return chain }
    chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve)
    return chain
  }
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: OWNER }, access_token: `${encode({})}.${encode({ aal: 'aal2' })}.x` } }, error: null }) },
    from: (table: string) => builder(table, table === 'meal_logs' ? [mealRow('2026-10-05', 'followed', '2026-10-05T12:00:00.5+00:00')] : table === 'workout_sessions' && !calls.length ? [{ id: S1 }] : []),
  } as unknown as SupabaseClient
  const changes = await createDiaryTransport(client, OWNER).loadChanges!('2026-10-04T00:00:00.000Z', new AbortController().signal)
  assert.equal(calls[0], 'workout_sessions:status=active', 'sedute attive prima delle modifiche')
  assert.ok(['workout_sessions', 'workout_set_logs', 'meal_logs', 'diary_days'].every(table => calls.includes(`${table}:updated_at>2026-10-04T00:00:00.000Z`)))
  assert.deepEqual(changes.activeSessionIds, [S1])
  assert.equal(changes.cursor, '2026-10-05T12:00:00.5+00:00')
})
