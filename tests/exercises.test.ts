import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import type { Session } from '@supabase/supabase-js'
import { emptyExercise, sameExercise, sameExerciseIdentity, searchExercises, validateExercise } from '../src/domain/exercises.ts'
import type { CatalogExercise, ExerciseValues } from '../src/domain/exercises.ts'
import { createExercisesRepository, ExercisesFailure } from '../src/persistence/exercises-repository.ts'
import type { ExercisesRepository } from '../src/persistence/exercises-repository.ts'
import { ExercisesStore } from '../src/persistence/exercises-store.ts'

const owner = '11111111-1111-4111-8111-111111111111'
const id = '22222222-2222-4222-8222-222222222222'
const original: CatalogExercise = { ...emptyExercise(), id, revision: 1, name: 'Esercizio sintetico', variant: 'Seduto', equipment: 'Macchina A' }
const signal = () => new AbortController().signal
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture() {
  const rows = new Map<string, CatalogExercise>()
  const writes: { id: string; revision: number | null }[] = []
  const repository: ExercisesRepository = {
    list: async () => structuredClone([...rows.values()]),
    listShared: async () => [],
    get: async key => structuredClone(rows.get(key) ?? null),
    adopt: async () => { throw new ExercisesFailure('unavailable') },
    save: async (key, values, revision) => {
      writes.push({ id: key, revision })
      if ((rows.get(key)?.revision ?? null) !== revision) throw new ExercisesFailure('conflict')
      const row = { ...values, id: key, revision: (revision ?? 0) + 1 }
      rows.set(key, row); return row
    },
  }
  return { rows, writes, repository }
}

test('catalogo: validazione testo, corpo libero, per lato, durata, unità; identità separata dal nome', () => {
  assert.ok(validateExercise(emptyExercise()))
  assert.ok(validateExercise({ ...original, name: '   ' }))
  assert.ok(validateExercise({ ...original, name: 'x'.repeat(121) }))
  assert.ok(validateExercise({ ...original, note: 'x'.repeat(4001) }))
  assert.ok(validateExercise({ ...original, equipment: 'x'.repeat(121) }))
  assert.ok(validateExercise({ ...original, note: '\0' }))
  assert.ok(validateExercise({ ...original, archivedAt: 'invalid' }))
  assert.equal(validateExercise({ ...original, name: '🏋'.repeat(120), loadConvention: 'bodyweight', measurementMode: 'seconds', perSide: true, loadUnit: 'lb' }), null)
  assert.ok(sameExerciseIdentity(original, { ...original, name: 'Rinominato', note: 'Nuova nota' }))
  for (const change of [{ equipment: 'Altra macchina' }, { variant: 'Altro' }, { loadUnit: 'lb' }, { loadConvention: 'single-dumbbell' }, { measurementMode: 'seconds' }, { perSide: true }]) {
    assert.equal(sameExerciseIdentity(original, { ...original, ...change } as ExerciseValues), false)
  }
  assert.ok(sameExercise({ ...original, archivedAt: '2026-09-27T10:00:00.000Z' }, { ...original, archivedAt: '2026-09-27T12:00:00+02:00' }))
})

test('ricerca per nome/variante/macchina, accenti e archivio reversibile', () => {
  const rows = [original, { ...original, id: owner, name: 'Mobilità', archivedAt: '2026-09-27T00:00:00Z' }]
  assert.deepEqual(searchExercises(rows, 'SINTETICO macchina', 'active'), [original])
  assert.equal(searchExercises(rows, 'mobilita', 'archived').length, 1)
  assert.equal(searchExercises(rows, '', 'active').length, 1)
  assert.equal(searchExercises(rows, '', 'all').length, 2)
})

test('creazione esplicita con UUID stabile e doppio invio bloccato fino alla risposta', async () => {
  const f = fixture(), pending = deferred<CatalogExercise>()
  f.repository.save = async (key, value, revision) => { f.writes.push({ id: key, revision }); return pending.promise.then(() => ({ ...value, id: key, revision: 1 })) }
  const store = new ExercisesStore(f.repository)
  await store.load(); assert.equal(f.writes.length, 0)
  store.open(); store.edit({ ...original })
  const key = store.getSnapshot().draft!.id
  const saving = store.save(); await store.save(); store.open(original); await store.load()
  assert.deepEqual(f.writes, [{ id: key, revision: null }])
  assert.equal(store.getSnapshot().rows.length, 0)
  assert.equal(store.pending, true)
  pending.resolve(original); await saving
  assert.equal(store.getSnapshot().rows[0]?.id, key)
  assert.equal(store.pending, false)
  store.stop()
})

test('rinomina e archiviazione/ripristino mantengono ID; cambio identità richiede nuova bozza', async () => {
  const f = fixture(); f.rows.set(id, original)
  const store = new ExercisesStore(f.repository); await store.load(); store.open(original)
  store.edit({ ...original, equipment: 'Macchina B' })
  assert.equal(store.getSnapshot().draft?.values.equipment, 'Macchina A')
  store.edit({ ...original, name: 'Nome corretto', archivedAt: '2026-09-27T00:00:00Z' }); await store.save()
  assert.equal(f.rows.get(id)?.revision, 2); assert.equal(f.rows.size, 1)
  store.edit({ ...store.getSnapshot().draft!.values, archivedAt: null }); await store.save()
  assert.equal(f.rows.get(id)?.revision, 3); assert.equal(f.rows.get(id)?.archivedAt, null)
  store.close(); store.open(f.rows.get(id), true)
  assert.notEqual(store.getSnapshot().draft?.id, id)
  assert.equal(store.getSnapshot().draft?.base, null)
  store.edit({ ...store.getSnapshot().draft!.values, equipment: 'Macchina B' }); await store.save()
  assert.equal(f.rows.size, 2); assert.equal(f.rows.get(id)?.equipment, 'Macchina A')
  store.stop()
})

test('risposta persa dopo insert recuperata per UUID, senza duplicati', async () => {
  const f = fixture(), save = f.repository.save
  f.repository.save = async (...args) => { await save(...args); throw new Error('lost response') }
  const store = new ExercisesStore(f.repository); await store.load(); store.open(); store.edit(original); await store.save()
  assert.equal(f.rows.size, 1); assert.equal(f.writes.length, 1)
  assert.equal(store.getSnapshot().phase, 'ready'); assert.equal(store.pending, false)
  assert.match(store.getSnapshot().message, /conferma recuperata/)
  store.stop()
})

test('due editor: conflitto preserva bozza e note/archiviazione online; sovrascrittura solo su scelta', async () => {
  const f = fixture(); f.rows.set(id, original)
  const a = new ExercisesStore(f.repository), b = new ExercisesStore(f.repository)
  await a.load(); await b.load(); a.open(original); b.open(original)
  a.edit({ ...original, note: 'Nota A', archivedAt: '2026-09-27T00:00:00Z' }); await a.save()
  b.edit({ ...original, name: 'Nome B' }); await b.save()
  assert.equal(b.getSnapshot().phase, 'conflict'); assert.equal(b.getSnapshot().draft?.values.name, 'Nome B')
  assert.equal(b.getSnapshot().remote?.note, 'Nota A'); assert.ok(b.getSnapshot().remote?.archivedAt)
  await b.save(); assert.equal(f.writes.length, 2)
  f.rows.set(id, { ...f.rows.get(id)!, revision: 3, note: 'Un’altra modifica' })
  await b.save(true); assert.equal(b.getSnapshot().phase, 'conflict')
  assert.equal(b.getSnapshot().remote?.revision, 3)
  await b.save(true); assert.equal(f.rows.get(id)?.revision, 4); assert.equal(f.rows.get(id)?.name, 'Nome B')
  a.edit({ ...a.getSnapshot().draft!.values, name: 'Altra bozza' }); await a.save(); a.useRemote()
  assert.equal(a.getSnapshot().draft?.values.name, 'Nome B'); assert.equal(a.pending, false)
  a.stop(); b.stop()
})

test('senza rete conserva la bozza e vieta reinvio/refresh/chiusura prima della verifica', async () => {
  const f = fixture(), get = f.repository.get
  f.repository.save = async (key, _, revision) => { f.writes.push({ id: key, revision }); throw new Error('offline') }
  f.repository.get = async () => { throw new Error('offline') }
  const store = new ExercisesStore(f.repository); await store.load(); store.open(); store.edit(original)
  const key = store.getSnapshot().draft!.id
  await store.save(); assert.equal(store.getSnapshot().phase, 'uncertain')
  await store.save(); await store.load(); store.close(); store.open(original, true)
  assert.equal(f.writes.length, 1); assert.equal(store.getSnapshot().draft?.id, key)
  f.repository.get = get; await store.check()
  assert.equal(store.canReplaceRemote, true); assert.equal(store.getSnapshot().phase, 'conflict')
  store.useRemote(); assert.equal(store.pending, false)
  store.stop()
})

test('un riferimento sparito o un’identità diversa non sono sovrascrivibili', async () => {
  const f = fixture(); f.rows.set(id, original)
  const store = new ExercisesStore(f.repository); await store.load(); store.open(original)
  f.rows.delete(id); store.edit({ ...original, name: 'Modifica' }); await store.save()
  assert.equal(store.canReplaceRemote, false)
  await store.save(true); assert.equal(f.rows.size, 0)
  store.useRemote(); store.open(); store.edit(original)
  const key = store.getSnapshot().draft!.id
  f.rows.set(key, { ...original, id: key, equipment: 'Identità differente' }); await store.save()
  assert.equal(store.canReplaceRemote, false)
  store.stop()
})

test('errore iniziale non è un archivio vuoto; nessun salvataggio prima della lettura', async () => {
  const f = fixture(); f.repository.list = async () => { throw new Error('offline') }
  const store = new ExercisesStore(f.repository); await store.load(); store.open(); await store.save()
  assert.equal(store.getSnapshot().phase, 'error'); assert.equal(f.writes.length, 0)
  store.stop()
})

test('letture tardive e risposta dopo cambio account ignorate, richieste annullate', async () => {
  const f = fixture(), old = deferred<CatalogExercise[]>()
  let calls = 0
  f.repository.list = async () => ++calls === 1 ? old.promise : [original]
  const store = new ExercisesStore(f.repository), first = store.load()
  await store.load(); old.resolve([]); await first
  assert.equal(store.getSnapshot().rows.length, 1)
  const pending = deferred<CatalogExercise>(); let operationSignal: AbortSignal | undefined
  f.repository.save = async (_, __, ___, nextSignal) => { operationSignal = nextSignal; return pending.promise }
  store.open(original); store.edit({ ...original, name: 'Modificato' })
  const saving = store.save(); store.stop()
  assert.equal(operationSignal?.aborted, true)
  const snapshot = store.getSnapshot(); pending.resolve({ ...original, revision: 2 }); await saving
  assert.equal(store.getSnapshot(), snapshot)
})

test('catalogo comune: visibile senza creare copie, adozione una sola volta e archivio rispettato', async () => {
  const f = fixture()
  const template = { ...original, id: '33333333-3333-4333-8333-333333333333', name: 'Squat comune' }
  let calls = 0
  f.repository.listShared = async () => [template]
  f.repository.adopt = async templateId => {
    calls++
    assert.equal(templateId, template.id)
    const saved = { ...template, id, sourceTemplateId: template.id }
    f.rows.set(id, saved)
    return saved
  }
  const store = new ExercisesStore(f.repository)
  await store.load()
  assert.equal(store.getSnapshot().sharedRows.length, 1)
  assert.equal(store.getSnapshot().rows.length, 0)
  const first = await store.adoptShared(template.id)
  assert.equal(first?.id, id)
  assert.equal((await store.adoptShared(template.id))?.id, id)
  assert.equal(calls, 1)
  f.rows.set(id, { ...first!, archivedAt: '2026-09-27T00:00:00Z' })
  await store.load()
  assert.equal(await store.adoptShared(template.id), null)
  assert.equal(calls, 1)
})

const row = { owner_id: owner, id, name: original.name, variant: original.variant, equipment: original.equipment, load_convention: 'total', load_unit: 'kg', measurement_mode: 'reps', per_side: false, note: '', archived_at: null, revision: 1 }
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function sdkFixture(respond: (request: Request) => Promise<Response>) {
  const client = createClient('http://127.0.0.1:54321', 'public-fixture', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (url, init) => respond(new Request(url, init)) } })
  client.auth.getSession = async () => ({ data: { session: { user: { id: owner }, access_token: 'fixture-token' } as Session }, error: null })
  return client
}

test('SDK reale: paginazione continua anche se il limite del server è inferiore; proprietario e cursore espliciti', async () => {
  const requests: Request[] = []
  const client = sdkFixture(async request => { requests.push(request); return json(requests.length === 1 ? [row] : []) })
  const rows = await createExercisesRepository(client, owner).list(signal())
  assert.deepEqual(rows, [original]); assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(new URL(request.url).searchParams.get('owner_id'), `eq.${owner}`)
    assert.equal(request.headers.get('Authorization'), 'Bearer fixture-token')
  }
  assert.equal(new URL(requests[1]!.url).searchParams.get('id'), `gt.${id}`)
})

test('SDK reale: insert con UUID senza upsert/owner; update solo nome/note/archivio e revisione +1', async () => {
  const requests: Request[] = []
  const client = sdkFixture(async request => { requests.push(request); return json({ ...row, revision: request.method === 'PATCH' ? 2 : 1 }) })
  const repository = createExercisesRepository(client, owner)
  await repository.save(id, original, null, signal()); await repository.save(id, original, 1, signal())
  const inserted = await requests[0]!.json()
  assert.equal(inserted.id, id); assert.equal('owner_id' in inserted, false)
  assert.equal(requests[0]!.headers.get('Prefer')?.includes('resolution='), false)
  const update = requests[1]!
  assert.equal(new URL(update.url).searchParams.get('owner_id'), `eq.${owner}`)
  assert.equal(new URL(update.url).searchParams.get('id'), `eq.${id}`)
  assert.deepEqual(await update.json(), { name: original.name, note: '', archived_at: null, revision: 2 })
})

test('SDK reale: 409 e risposta vuota sono conflitti, nessun testo privato mostrato', async () => {
  for (const code of ['PT409', '23505', 'empty']) {
    let requests = 0
    const client = sdkFixture(async () => { requests++; return code === 'empty' ? json([]) : json({ code, message: 'private server text' }, 409) })
    await assert.rejects(createExercisesRepository(client, owner).save(id, original, 1, signal()), error => error instanceof ExercisesFailure && error.kind === 'conflict' && !error.message.includes('private'))
    assert.equal(requests, 1)
  }
})

test('SDK reale: sessione diversa non invia; risposte di altro owner/ID o invalide respinte', async () => {
  let requests = 0
  const client = sdkFixture(async () => { requests++; return json(row) })
  await assert.rejects(createExercisesRepository(client, 'another').get(id, signal()), error => error instanceof ExercisesFailure && error.kind === 'session')
  assert.equal(requests, 0)
  for (const patch of [{ owner_id: 'another' }, { id: owner }, { load_unit: 'invalid' }, { revision: 0 }, { per_side: 'false' }, { name: '  ' }]) {
    const invalid = sdkFixture(async () => json({ ...row, ...patch }))
    await assert.rejects(createExercisesRepository(invalid, owner).get(id, signal()), ExercisesFailure)
  }
})

test('SDK reale: catalogo comune senza filtro owner e adozione tramite RPC con rilettura personale', async () => {
  const templateId = '33333333-3333-4333-8333-333333333333'
  const shared = { ...row, id: templateId }
  const requests: Request[] = []
  const client = sdkFixture(async request => {
    requests.push(request)
    const url = new URL(request.url)
    if (url.pathname === '/rest/v1/shared_exercises') return json(requests.filter(item => new URL(item.url).pathname === url.pathname).length === 1 ? [shared] : [])
    if (url.pathname === '/rest/v1/rpc/adopt_shared_exercise') return json(id)
    return json({ ...row, source_template_id: templateId })
  })
  const repository = createExercisesRepository(client, owner)
  assert.equal((await repository.listShared(signal()))[0]?.id, templateId)
  const adopted = await repository.adopt(templateId, signal())
  assert.equal(adopted.id, id)
  assert.equal(adopted.sourceTemplateId, templateId)
  const rpc = requests.find(request => new URL(request.url).pathname.endsWith('/adopt_shared_exercise'))!
  assert.deepEqual(await rpc.json(), { p_template_id: templateId })
  assert.ok(requests.filter(request => new URL(request.url).pathname === '/rest/v1/shared_exercises').every(request => !new URL(request.url).searchParams.has('owner_id')))
  assert.ok(requests.every(request => request.headers.get('Authorization') === 'Bearer fixture-token'))
})
