import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import type { Session } from '@supabase/supabase-js'
import { defaultSettings, sameSettings, validateSettings, isWorkoutWeekday } from '../src/domain/settings.ts'
import type { SavedSettings, SettingsValues } from '../src/domain/settings.ts'
import { createSettingsRepository, SettingsFailure } from '../src/persistence/settings-repository.ts'
import type { SettingsRepository } from '../src/persistence/settings-repository.ts'
import { SettingsStore } from '../src/persistence/settings-store.ts'

const original: SavedSettings = { displayName: 'Fixture', timeZone: 'Europe/Rome', workoutWeekdays: [1, 5], revision: 1 }
const edited: SettingsValues = { ...original, displayName: 'Modifica locale' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('preferenze: limiti, fusi e giorni ISO; ordine dei giorni irrilevante', () => {
  assert.equal(validateSettings(defaultSettings()), null)
  assert.equal(validateSettings({ ...original, timeZone: 'not/a/zone' }) !== null, true)
  for (const workoutWeekdays of [[0], [8], [1, 1], [1.5]]) assert.ok(validateSettings({ ...original, workoutWeekdays }))
  assert.ok(validateSettings({ ...original, displayName: 'x'.repeat(121) }))
  assert.ok(sameSettings(original, { ...original, workoutWeekdays: [5, 1] }))
  assert.ok(isWorkoutWeekday('2026-09-27', [7]))
  assert.equal(isWorkoutWeekday('2026-09-28', [7]), false)
})

test('nessuna creazione automatica; doppio invio bloccato, successo solo dopo conferma', async () => {
  const response = deferred<SavedSettings>()
  let writes = 0
  const store = new SettingsStore({ load: async () => null, save: async (_, revision) => { writes++; assert.equal(revision, null); return response.promise } })
  await store.load()
  assert.equal(writes, 0)
  store.edit(edited)
  const saving = store.save()
  await store.save()
  assert.equal(writes, 1)
  assert.equal(store.getSnapshot().saved, null)
  assert.equal(store.getSnapshot().phase, 'saving')
  response.resolve({ ...edited, revision: 1 }); await saving
  assert.equal(store.dirty, false)
  assert.equal(store.getSnapshot().saved?.displayName, edited.displayName)
  store.stop()
})

test('risposta persa dopo commit: rilettura conferma il salvataggio senza duplicarlo', async () => {
  let remote: SavedSettings | null = null, writes = 0
  const store = new SettingsStore({ load: async () => remote, save: async value => {
    writes++; remote = { ...value, revision: 1 }; throw new Error('timeout')
  } })
  await store.load(); store.edit(edited); await store.save()
  assert.equal(store.getSnapshot().phase, 'ready')
  assert.equal(store.dirty, false)
  assert.equal(writes, 1)
  assert.match(store.getSnapshot().message, /conferma recuperata/)
  store.stop()
})

test('conflitto conserva la bozza e richiede una scelta; nuovo conflitto non sovrascrive', async () => {
  let remote = original
  const attempts: (number | null)[] = []
  const repository: SettingsRepository = { load: async () => remote, save: async (_, revision) => {
    attempts.push(revision); remote = { ...remote, revision: remote.revision + 1, displayName: 'Altro dispositivo' }
    throw new SettingsFailure('conflict')
  } }
  const store = new SettingsStore(repository)
  await store.load(); store.edit(edited); await store.save()
  assert.equal(store.getSnapshot().phase, 'conflict')
  assert.equal(store.getSnapshot().draft.displayName, edited.displayName)
  assert.equal(store.getSnapshot().remote?.revision, 2)
  await store.save(); assert.deepEqual(attempts, [1])
  await store.save(true); assert.deepEqual(attempts, [1, 2])
  assert.equal(store.getSnapshot().phase, 'conflict')
  assert.equal(store.getSnapshot().remote?.revision, 3)
  store.useRemote()
  assert.equal(store.dirty, false)
  assert.equal(store.getSnapshot().saved?.displayName, 'Altro dispositivo')
  store.stop()
})

test('rete assente: nessun retry di scrittura e bozza preservata fino alla verifica', async () => {
  let offline = false, writes = 0
  const store = new SettingsStore({ load: async () => { if (offline) throw new Error('network'); return original }, save: async () => { writes++; offline = true; throw new Error('network') } })
  await store.load(); store.edit(edited); await store.save()
  assert.equal(store.getSnapshot().phase, 'uncertain')
  await store.save(); assert.equal(writes, 1)
  assert.equal(store.getSnapshot().draft.displayName, edited.displayName)
  offline = false; await store.check()
  assert.equal(store.getSnapshot().phase, 'conflict')
  assert.equal(store.getSnapshot().draft.displayName, edited.displayName)
  store.stop()
})

test('errore iniziale distinto da archivio vuoto: scrittura impossibile prima della lettura', async () => {
  let writes = 0
  const store = new SettingsStore({ load: async () => { throw new Error('network') }, save: async () => { writes++; return original } })
  await store.load(); await store.save()
  assert.equal(store.getSnapshot().phase, 'error')
  assert.equal(writes, 0)
  store.stop()
})

test('logout annulla le richieste e ignora risposte tardive, anche se il server ha risposto', async () => {
  const pending = deferred<SavedSettings>()
  let signal: AbortSignal | undefined
  const store = new SettingsStore({ load: async () => original, save: async (_, __, requestSignal) => { signal = requestSignal; return pending.promise } })
  await store.load(); store.edit(edited)
  const saving = store.save()
  store.stop(); assert.equal(signal?.aborted, true)
  const state = store.getSnapshot()
  pending.resolve({ ...edited, revision: 2 }); await saving
  assert.equal(store.getSnapshot(), state)
})

test('letture fuori ordine non rimpiazzano lo stato più recente', async () => {
  const pending = deferred<SavedSettings>()
  let calls = 0
  const store = new SettingsStore({ load: async () => ++calls === 1 ? pending.promise : { ...original, revision: 2 }, save: async () => original })
  const first = store.load(); await store.load()
  pending.resolve(original); await first
  assert.equal(store.getSnapshot().saved?.revision, 2)
  store.stop()
})

const owner = '11111111-1111-4111-8111-111111111111'
const row = { owner_id: owner, display_name: 'Fixture', time_zone: 'Europe/Rome', workout_weekdays: [1, 5], revision: 1 }
function sdkFixture(respond: (request: Request) => Promise<Response>) {
  const client = createClient('http://127.0.0.1:54321', 'public-fixture', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (url, init) => respond(new Request(url, init)) } })
  client.auth.getSession = async () => ({ data: { session: { user: { id: owner }, access_token: 'fixture-owner-token' } as Session }, error: null })
  return client
}
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })

test('adattatore con SDK reale: filtro proprietario, revisione +1, solo colonne consentite', async () => {
  const requests: Request[] = []
  const client = sdkFixture(async request => {
    requests.push(request)
    return json(request.method === 'GET' ? [row] : { ...row, revision: 2 })
  })
  const repository = createSettingsRepository(client, owner)
  assert.deepEqual(await repository.load(new AbortController().signal), original)
  const saved = await repository.save(edited, 1, new AbortController().signal)
  assert.equal(saved.revision, 2)
  const update = requests[1]!
  assert.equal(update.method, 'PATCH')
  assert.equal(new URL(update.url).searchParams.get('owner_id'), `eq.${owner}`)
  assert.equal(update.headers.get('Authorization'), 'Bearer fixture-owner-token')
  assert.deepEqual(await update.json(), { display_name: edited.displayName, time_zone: edited.timeZone, workout_weekdays: edited.workoutWeekdays, revision: 2 })
})

test('adattatore: insert senza owner e senza upsert; PT409/23505 riconosciuti', async () => {
  for (const code of ['PT409', '23505']) {
    const client = sdkFixture(async request => {
      assert.equal(request.method, 'POST')
      assert.equal('owner_id' in await request.json(), false)
      assert.equal(request.headers.get('Prefer')?.includes('resolution='), false)
      return json({ code, message: 'private server text' }, 409)
    })
    await assert.rejects(createSettingsRepository(client, owner).save(edited, null, new AbortController().signal), error => error instanceof SettingsFailure && error.kind === 'conflict' && !error.message.includes('private'))
  }
})

test('adattatore: sessione diversa non invia richieste, risposta di altro proprietario respinta', async () => {
  let requests = 0
  const client = sdkFixture(async () => { requests++; return json([{ ...row, owner_id: 'other' }]) })
  await assert.rejects(createSettingsRepository(client, owner).load(new AbortController().signal), SettingsFailure)
  assert.equal(requests, 1)
  await assert.rejects(createSettingsRepository(client, 'other').save(edited, null, new AbortController().signal), error => error instanceof SettingsFailure && error.kind === 'session')
  assert.equal(requests, 1)
})
