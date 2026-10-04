import assert from 'node:assert/strict'
import test from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { emptyDiary } from '../src/domain/diary.ts'
import { createDiaryTransport, DiaryFailure } from '../src/persistence/diary-repository.ts'
import type { DiaryTransport } from '../src/persistence/diary-repository.ts'
import { DiaryStore, memoryStorage } from '../src/persistence/diary-store.ts'

// Sessione aal1 dove il server richiede aal2: la RLS restituisce zero righe e respinge le scritture.
// Nulla di ciò che è registrato sul dispositivo deve diventare un rifiuto definitivo o un diario vuoto.
const OWNER = '11111111-1111-4111-8111-111111111111'
const DATE = '2026-10-04'
const flushed = () => new Promise(resolve => setTimeout(resolve, 10))

function rejectingTransport(mfa: boolean) {
  const calls: string[] = []
  const transport = {
    loadAll: async () => ({ data: emptyDiary(), revisions: {} }),
    insert: async () => { calls.push('insert'); throw new DiaryFailure('rejected') },
    mfaSatisfied: async () => { calls.push('mfa'); return mfa },
  } as unknown as DiaryTransport
  return { transport, calls }
}

test('MFA non soddisfatta: la scrittura respinta resta in coda, nessun conflitto da scartare', async () => {
  const { transport, calls } = rejectingTransport(false)
  const store = new DiaryStore(transport, memoryStorage(), OWNER)
  await store.refresh()
  store.setDayType(DATE, 'rest')
  await store.flush(); await flushed()
  const state = store.getSnapshot()
  assert.deepEqual(calls, ['insert', 'mfa'])
  assert.equal(state.pending, 1, 'operazione ancora in coda')
  assert.equal(state.conflicts.length, 0, 'nessun rifiuto definitivo')
  assert.equal(state.sync, 'waiting')
  assert.equal(state.view.dayTypes[DATE], 'rest', 'la vista conserva la registrazione')
  store.stop()
})

test('MFA soddisfatta: un rifiuto vero del database resta un rifiuto', async () => {
  const { transport } = rejectingTransport(true)
  const store = new DiaryStore(transport, memoryStorage(), OWNER)
  await store.refresh()
  store.setDayType(DATE, 'rest')
  await store.flush(); await flushed()
  assert.equal(store.getSnapshot().pending, 0)
  assert.equal(store.getSnapshot().conflicts[0]?.kind, 'rejected')
  store.stop()
})

test('verifica MFA non raggiungibile: nel dubbio nuovo tentativo, non rifiuto', async () => {
  const transport = {
    loadAll: async () => ({ data: emptyDiary(), revisions: {} }),
    insert: async () => { throw new DiaryFailure('rejected') },
    mfaSatisfied: async () => { throw new DiaryFailure('unavailable') },
  } as unknown as DiaryTransport
  const store = new DiaryStore(transport, memoryStorage(), OWNER)
  await store.refresh()
  store.setDayType(DATE, 'rest')
  await store.flush(); await flushed()
  assert.equal(store.getSnapshot().pending, 1)
  assert.equal(store.getSnapshot().conflicts.length, 0)
  store.stop()
})

test('MFA non soddisfatta: l’annullamento di una seduta nascosta dalla RLS non viene dato per fatto', async () => {
  const session = { id: '33333333-3333-4333-8333-333333333333', planId: OWNER, date: DATE, day: { id: OWNER, label: 'A', title: 'A', subtitle: '', exercises: [] }, startedAt: `${DATE}T08:00:00Z`, results: {} }
  const transport = {
    loadAll: async () => ({ data: { ...emptyDiary(), sessions: [session] }, revisions: { [`session:${session.id}`]: 1 } }),
    discard: async () => false,
    fetch: async () => null,
    mfaSatisfied: async () => false,
  } as unknown as DiaryTransport
  const store = new DiaryStore(transport, memoryStorage(), OWNER)
  await store.refresh()
  store.discardSession(session.id)
  await store.flush(); await flushed()
  assert.equal(store.getSnapshot().pending, 1, 'annullamento ancora da inviare')
  assert.equal(store.getSnapshot().sync, 'waiting')
  store.stop()
})

// ------------------------------------------------------------ trasporto reale con client simulato
function jwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: OWNER, role: 'authenticated', ...claims })}.firma`
}
function fakeClient(options: { aal: 'aal1' | 'aal2'; mfa?: boolean; rpcError?: { code: string; message: string } }) {
  const calls: string[] = []
  const builder = (result: () => unknown) => {
    const chain: Record<string, unknown> = {}
    for (const method of ['setHeader', 'abortSignal', 'retry', 'eq', 'order', 'range', 'select', 'match', 'single', 'maybeSingle']) chain[method] = () => chain
    chain.then = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject)
    return chain
  }
  const client = {
    auth: { getSession: async () => ({ data: { session: { user: { id: OWNER }, access_token: jwt({ aal: options.aal }) } }, error: null }) },
    rpc: (name: string) => {
      calls.push(`rpc:${name}`)
      if (name === 'is_mfa_satisfied') return builder(() => ({ data: options.mfa ?? true, error: null }))
      return builder(() => ({ data: null, error: options.rpcError ?? null }))
    },
    from: (table: string) => { calls.push(`from:${table}`); return builder(() => ({ data: [], error: null })) },
  } as unknown as SupabaseClient
  return { client, calls }
}
const signal = () => new AbortController().signal
const startArgs = { sessionId: OWNER, versionId: OWNER, dayId: OWNER, date: DATE, timeZone: 'Europe/Rome' }

test('trasporto: con aal1 e MFA richiesta la lettura completa si ferma prima delle tabelle', async () => {
  const { client, calls } = fakeClient({ aal: 'aal1', mfa: false })
  await assert.rejects(createDiaryTransport(client, OWNER).loadAll(signal()), (error: unknown) => error instanceof DiaryFailure && error.kind === 'session')
  assert.deepEqual(calls, ['rpc:is_mfa_satisfied'], 'nessuna tabella letta')
})

test('trasporto: aal2 nel token non richiede la verifica al server; aal1 senza requisito legge', async () => {
  const strong = fakeClient({ aal: 'aal2' })
  await createDiaryTransport(strong.client, OWNER).loadAll(signal())
  assert.ok(!strong.calls.includes('rpc:is_mfa_satisfied'))
  assert.ok(strong.calls.includes('from:workout_sessions'))
  const weak = fakeClient({ aal: 'aal1', mfa: true })
  await createDiaryTransport(weak.client, OWNER).loadAll(signal())
  assert.deepEqual(weak.calls.slice(0, 2), ['rpc:is_mfa_satisfied', 'from:workout_sessions'])
})

test('trasporto: «MFA required» da una RPC è sessione da verificare, gli altri 42501 restano rifiuti', async () => {
  const mfa = fakeClient({ aal: 'aal1', rpcError: { code: '42501', message: 'MFA required' } })
  await assert.rejects(createDiaryTransport(mfa.client, OWNER).start(startArgs, signal()), (error: unknown) => error instanceof DiaryFailure && error.kind === 'session')
  const denied = fakeClient({ aal: 'aal2', rpcError: { code: '42501', message: 'Workout version not available' } })
  await assert.rejects(createDiaryTransport(denied.client, OWNER).start(startArgs, signal()), (error: unknown) => error instanceof DiaryFailure && error.kind === 'rejected')
})

test('lettura respinta per MFA: il diario confermato sul dispositivo resta quello di prima', async () => {
  const storage = memoryStorage()
  const seed = new DiaryStore({ loadAll: async () => ({ data: { ...emptyDiary(), dayTypes: { [DATE]: 'rest' } }, revisions: { [`day:${DATE}`]: 1 } }) } as unknown as DiaryTransport, storage, OWNER)
  await seed.refresh(); seed.stop()
  const store = new DiaryStore({ loadAll: async () => { throw new DiaryFailure('session') } } as unknown as DiaryTransport, storage, OWNER)
  await store.refresh()
  assert.equal(store.getSnapshot().phase, 'ready')
  assert.equal(store.getSnapshot().view.dayTypes[DATE], 'rest')
  store.stop()
})
