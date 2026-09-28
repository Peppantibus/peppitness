import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '@supabase/supabase-js'
import type { Session } from '@supabase/supabase-js'
import { emptyExercise } from '../src/domain/exercises.ts'
import { copyProgram, duplicateDay, forkProgram, moveItem, newDay, newPrescription, newProgram, programPayload, sameContent, sameCycle, sameProgram, validateProgram } from '../src/domain/programs.ts'
import type { ProgramDocument, SavedProgram } from '../src/domain/programs.ts'
import { createProgramsRepository, ProgramsFailure } from '../src/persistence/programs-repository.ts'
import type { ProgramsRepository } from '../src/persistence/programs-repository.ts'
import { ProgramsStore } from '../src/persistence/programs-store.ts'

const owner = '11111111-1111-4111-8111-111111111111'
const exercise = { ...emptyExercise(), id: '22222222-2222-4222-8222-222222222222', revision: 1, name: 'Esercizio sintetico' }
function document(): ProgramDocument {
  const doc = newProgram(), day = newDay([])
  day.exercises = [{ ...newPrescription(exercise), sets: '2', optionalSets: '1', repsMin: '8', repsMax: '10', restSeconds: '90', rir: '2,5', rpe: '' }]
  return { ...doc, title: 'Programma sintetico', guidance: 'Istruzioni', days: [day] }
}
function saved(doc = document(), revision = 1): SavedProgram {
  return { document: structuredClone(doc), plan: { id: doc.planId, name: doc.title, revision: 1, activeVersionId: null, archivedAt: null }, version: { id: doc.id, planId: doc.planId, title: doc.title, guidance: doc.guidance, number: 1, revision, status: 'draft' } }
}
function fixture(initial?: SavedProgram) {
  const rows = new Map<string, SavedProgram>(initial ? [[initial.version.id, structuredClone(initial)]] : [])
  const writes: { kind: string; id: string; revision: number }[] = []
  const repo: ProgramsRepository = {
    list: async () => [...rows.values()].map(row => ({ plan: row.plan, versions: [row.version] })),
    get: async id => structuredClone(rows.get(id) ?? null),
    save: async (doc, revision) => {
      writes.push({ kind: 'save', id: doc.id, revision })
      const previous = rows.get(doc.id)
      if ((previous?.version.revision ?? 0) !== revision) throw new ProgramsFailure('conflict')
      if (previous?.version.status === 'published') throw new ProgramsFailure('unavailable')
      const row = saved(doc, revision + 1)
      row.plan = previous?.plan ?? [...rows.values()].find(item => item.plan.id === doc.planId)?.plan ?? row.plan
      row.version.number = previous?.version.number ?? rows.size + 1
      rows.set(doc.id, row)
    },
    publish: async row => {
      writes.push({ kind: 'publish', id: row.version.id, revision: row.version.revision })
      const current = rows.get(row.version.id)!
      if (current.version.revision !== row.version.revision || current.plan.revision !== row.plan.revision) throw new ProgramsFailure('conflict')
      rows.set(row.version.id, { ...current, version: { ...current.version, status: 'published', revision: current.version.revision + 1 }, plan: { ...current.plan, revision: current.plan.revision + 1, activeVersionId: current.version.id } })
    },
    revise: async () => { throw new Error('Revision fixture not configured') },
    activate: async () => { throw new Error('Activation fixture not configured') },
    setCycle: async () => { throw new Error('Cycle fixture not configured') },
    deletePlans: async planId => {
      let count = 0
      for (const [id, row] of rows) if (planId === null || row.plan.id === planId) { rows.delete(id); count++ }
      return count
    },
  }
  return { rows, writes, repo }
}
async function opened(initial = saved()) { const f = fixture(initial), store = new ProgramsStore(f.repo); await store.load(); await store.open(initial.version.id); return { ...f, store, initial } }
const signal = () => new AbortController().signal

test('bozza vuota salvabile con titolo, pubblicazione richiede sedute ed esercizi', () => {
  const doc = newProgram()
  assert.ok(validateProgram(doc)); doc.title = 'Prima bozza'
  assert.equal(validateProgram(doc), null); assert.ok(validateProgram(doc, true))
  doc.days.push(newDay([])); assert.equal(validateProgram(doc), null); assert.ok(validateProgram(doc, true))
})

test('prescrizioni: virgola, zero recupero/RIR, facoltative distinte, RPE e intervalli validati', () => {
  const doc = document(), item = doc.days[0]!.exercises[0]!
  const payload = programPayload(doc).p_days[0]!.exercises[0]!
  assert.equal(payload.rir, 2.5); assert.equal(payload.rpe, null); assert.equal(payload.sets, 2); assert.equal(payload.optional_sets, 1)
  assert.equal('exercise_snapshot' in payload, false)
  for (const [key, value] of [['sets', ''], ['sets', '2.5'], ['optionalSets', '-1'], ['repsMax', '7'], ['rir', '11'], ['rpe', '0'], ['restSeconds', '86401']]) {
    const changed = structuredClone(doc); Object.assign(changed.days[0]!.exercises[0]!, { [key!]: value }); assert.ok(validateProgram(changed), key)
  }
  item.restSeconds = '0'; item.rir = '0'; assert.equal(validateProgram(doc), null)
  item.exercise.measurementMode = 'seconds'; item.durationSeconds = '30'; assert.ok(validateProgram(doc))
  item.repsMin = ''; item.repsMax = ''; assert.equal(validateProgram(doc), null)
})

test('duplicazioni e riordino: ID nuovi per figli, esercizio stabile e nessuna mutazione originale', () => {
  const doc = document(), before = structuredClone(doc)
  const day = duplicateDay(doc.days[0]!, doc.days)
  assert.notEqual(day.id, doc.days[0]!.id); assert.notEqual(day.exercises[0]!.id, doc.days[0]!.exercises[0]!.id)
  assert.equal(day.exercises[0]!.exercise.id, exercise.id); assert.notEqual(day.label, doc.days[0]!.label)
  const fork = forkProgram(doc)
  assert.equal(fork.planId, doc.planId); assert.notEqual(fork.id, doc.id); assert.notEqual(fork.days[0]!.id, doc.days[0]!.id)
  assert.deepEqual(doc, before)
  assert.deepEqual(moveItem([1, 2, 3], 2, -1), [1, 3, 2]); assert.deepEqual(moveItem([1], 0, -1), [1])
  doc.days.push(structuredClone(doc.days[0]!)); assert.ok(validateProgram(doc))
  doc.days[1] = day; assert.equal(validateProgram(doc), null)
})

test('rinnovo: nuovo programma con stessa settimana tipo e identità distinte', () => {
  const source = document(), copy = copyProgram(source)
  assert.notEqual(copy.planId, source.planId)
  assert.notEqual(copy.id, source.id)
  assert.notEqual(copy.days[0]!.id, source.days[0]!.id)
  assert.notEqual(copy.days[0]!.exercises[0]!.id, source.days[0]!.exercises[0]!.id)
  assert.equal(copy.days[0]!.exercises[0]!.exercise.id, source.days[0]!.exercises[0]!.exercise.id)
  assert.equal(copy.days[0]!.label, source.days[0]!.label)
  assert.equal(validateProgram(copy, true), null)
})

test('eliminazione programma e tutti i programmi aggiorna l’elenco', async () => {
  const first = saved(), fake = fixture(first), store = new ProgramsStore(fake.repo)
  await store.load()
  assert.equal(await store.deletePlans(first.plan.id), true)
  assert.equal(store.getSnapshot().index.length, 0)
  assert.equal(fake.rows.size, 0)
  fake.rows.set(first.version.id, first)
  await store.load()
  assert.equal(await store.deletePlans(null), true)
  assert.equal(store.getSnapshot().index.length, 0)
})

test('confronto riconciliazione: include ordine, prescrizioni e ID, esclude nome snapshot rinnovato dal server', () => {
  const doc = document(), other = structuredClone(doc)
  other.days[0]!.exercises[0]!.exercise.name = 'Nome aggiornato nel catalogo'
  other.days[0]!.exercises[0]!.rir = '2.5'
  assert.ok(sameProgram(doc, other))
  other.days[0]!.exercises[0]!.sets = '3'; assert.equal(sameProgram(doc, other), false)
  assert.equal(sameProgram(doc, forkProgram(doc)), false)
})

test('save e pubblicazione perdono la risposta: rilettura per ID conferma senza duplicare', async () => {
  const f = fixture(), store = new ProgramsStore(f.repo)
  const save = f.repo.save, publish = f.repo.publish
  f.repo.save = async (...args) => { await save(...args); throw new Error('response lost') }
  f.repo.publish = async (...args) => { await publish(...args); throw new Error('response lost') }
  await store.load(); assert.equal(f.writes.length, 0); store.create()
  const original = store.getSnapshot().document!
  store.edit({ ...document(), id: original.id, planId: original.planId })
  await store.save(); assert.equal(store.getSnapshot().phase, 'ready'); assert.equal(f.rows.size, 1); assert.equal(store.pending, false)
  await store.publish(); assert.equal(store.getSnapshot().base?.version.status, 'published')
  assert.deepEqual(f.writes.map(item => item.kind), ['save', 'publish'])
  assert.equal(store.pending, false); store.stop()
})

test('doppio invio e pubblicazione con bozza non salvata bloccati', async () => {
  const { store, repo, writes, initial } = await opened()
  store.edit({ ...initial.document, title: 'Modificato' }); await store.publish(); assert.equal(writes.length, 0)
  let resolve!: () => void
  const gate = new Promise<void>(done => { resolve = done }), save = repo.save
  repo.save = async (...args) => { await gate; await save(...args) }
  const running = store.save(); await store.save(); store.close(); store.create(); await store.publish()
  assert.equal(store.getSnapshot().phase, 'saving'); resolve(); await running
  assert.equal(writes.length, 1); assert.equal(store.pending, false); store.stop()
})

test('conflitto ripetuto conserva bozza, confronto e revisione scelta senza sovrascrittura cieca', async () => {
  const { store, rows, writes, initial } = await opened()
  store.edit({ ...initial.document, title: 'Locale' })
  rows.set(initial.version.id, saved({ ...initial.document, title: 'Online' }, 2))
  await store.save(); assert.equal(store.getSnapshot().phase, 'conflict'); assert.equal(store.getSnapshot().document?.title, 'Locale')
  await store.save(); assert.equal(writes.length, 1)
  rows.set(initial.version.id, saved({ ...initial.document, title: 'Nuova modifica online' }, 3))
  await store.save(true); assert.equal(store.getSnapshot().remote?.version.revision, 3)
  await store.save(true); assert.equal(store.getSnapshot().base?.version.revision, 4); assert.equal(store.pending, false)
  store.stop()
})

test('conflitto sulla revisione del programma durante pubblicazione non è falso successo', async () => {
  const { store, rows, initial } = await opened()
  rows.set(initial.version.id, { ...initial, plan: { ...initial.plan, revision: 2 } })
  await store.publish(); assert.equal(store.getSnapshot().phase, 'conflict'); assert.equal(store.canReplace, false)
  assert.equal(store.getSnapshot().remote?.version.status, 'draft')
  store.useRemote(); await store.publish(); assert.equal(store.getSnapshot().base?.version.status, 'published')
  store.stop()
})

test('pubblicata altrove: preserva modifiche locali in nuova bozza, senza riscrivere la versione', async () => {
  const { store, rows, initial } = await opened()
  store.edit({ ...initial.document, guidance: 'Modifica locale' })
  const online = { ...initial, version: { ...initial.version, status: 'published' as const, revision: 2 } }
  rows.set(initial.version.id, online)
  await store.save(); assert.equal(store.canReplace, false); store.fork()
  assert.equal(store.getSnapshot().base, null); assert.notEqual(store.getSnapshot().document?.id, initial.document.id)
  assert.equal(store.getSnapshot().document?.guidance, 'Modifica locale')
  await store.save(); assert.equal(rows.size, 2); assert.deepEqual(rows.get(initial.version.id), online)
  store.stop()
})

test('errore noto del database conserva bozza correggibile; rete assente impone verifica', async () => {
  const { store, repo, initial } = await opened()
  store.edit({ ...initial.document, title: 'Modificato' })
  repo.save = async () => { throw new ProgramsFailure('invalid') }
  await store.save(); assert.equal(store.getSnapshot().phase, 'ready'); assert.equal(store.dirty, true)
  repo.save = async () => { throw new Error('offline') }; repo.get = async () => { throw new Error('offline') }
  await store.save(); assert.equal(store.getSnapshot().phase, 'uncertain'); store.close(); await store.publish(); await store.load()
  assert.equal(store.getSnapshot().document?.title, 'Modificato')
  repo.get = async () => initial; await store.check(); store.useRemote()
  assert.equal(store.getSnapshot().phase, 'ready'); assert.equal(store.dirty, false); store.stop()
})

test('versione pubblicata sola lettura, nuova bozza con ID figli nuovi; snapshot precedente intatto', async () => {
  const initial = saved(); initial.version.status = 'published'
  const { store, writes } = await opened(initial)
  store.edit({ ...initial.document, title: 'Non consentito' }); await store.save(); await store.publish()
  assert.equal(writes.length, 0); assert.deepEqual(store.getSnapshot().document, initial.document)
  store.fork(); assert.equal(store.dirty, true)
  assert.notEqual(store.getSnapshot().document?.days[0]?.exercises[0]?.id, initial.document.days[0]!.exercises[0]!.id)
  store.stop()
})

function revisionFixture(used = false) {
  const initial = saved(); initial.version.status = 'published'; initial.version.revision = 2
  initial.plan.revision = 2; initial.plan.activeVersionId = initial.version.id
  initial.plan.cycle = { start: '2026-09-28', weeks: 8 }
  const f = fixture(initial)
  const attempts: string[] = []
  f.repo.list = async () => {
    const rows = [...f.rows.values()]
    const current = rows.find(row => row.version.id === rows[0]?.plan.activeVersionId) ?? rows.at(-1)!
    return [{ plan: structuredClone(current.plan), versions: rows.map(row => structuredClone(row.version)) }]
  }
  f.repo.revise = async ({ base, document: doc, cycle, newVersionId }) => {
    attempts.push(newVersionId)
    const retried = f.rows.get(newVersionId)
    if (retried) return { outcome: 'created', versionId: newVersionId, planRevision: retried.plan.revision }
    const current = f.rows.get(base.version.id)!
    if (current.plan.revision !== base.plan.revision || current.version.revision !== base.version.revision) throw new ProgramsFailure('conflict')
    const contentChanged = !sameContent(doc, current.document)
    const nameChanged = doc.title.trim() !== current.plan.name
    const cycleChanged = !sameCycle(cycle, current.plan.cycle)
    if (!contentChanged && !nameChanged && !cycleChanged) return { outcome: 'unchanged', versionId: base.version.id, planRevision: current.plan.revision }
    const plan = { ...current.plan, name: doc.title.trim(), cycle, revision: current.plan.revision + 1 }
    if (contentChanged && used) {
      const next = forkProgram(doc); next.id = newVersionId
      const row: SavedProgram = { plan: { ...plan, activeVersionId: newVersionId }, version: { ...current.version, id: newVersionId, number: 2, revision: 2, title: doc.title, guidance: doc.guidance }, document: next }
      f.rows.set(newVersionId, row); f.rows.set(base.version.id, { ...current, plan: row.plan })
      return { outcome: 'created', versionId: newVersionId, planRevision: row.plan.revision }
    }
    const version = { ...current.version, revision: current.version.revision + (contentChanged || nameChanged ? 1 : 0), title: doc.title, guidance: doc.guidance }
    f.rows.set(base.version.id, { plan, version, document: structuredClone(doc) })
    return { outcome: contentChanged ? 'updated' : 'metadata', versionId: base.version.id, planRevision: plan.revision }
  }
  return { ...f, initial, attempts }
}

test('revisione: apertura pulita, uscita pulita e nessuna RPC senza modifiche', async () => {
  const f = revisionFixture(), store = new ProgramsStore(f.repo)
  await store.load(); await store.open(f.initial.version.id); store.revise()
  assert.equal(store.dirty, false); assert.equal(store.pending, false)
  assert.equal(await store.saveRevision(), 'unchanged'); assert.equal(f.attempts.length, 0)
  store.close(); assert.equal(store.getSnapshot().document, null)
})

test('revisione: esiti unchanged, metadata, updated e created rispettano lo storico', async () => {
  for (const kind of ['unchanged', 'metadata', 'updated', 'created'] as const) {
    const f = revisionFixture(kind === 'created'), store = new ProgramsStore(f.repo)
    await store.load(); await store.open(f.initial.version.id); store.revise()
    const doc = store.getSnapshot().document!
    if (kind === 'metadata') store.edit({ ...doc, title: 'Nuovo nome' })
    if (kind === 'updated' || kind === 'created') store.edit({ ...doc, guidance: 'Nuove istruzioni' })
    assert.equal(store.dirty, kind !== 'unchanged')
    assert.equal(await store.saveRevision(), kind)
    assert.equal(f.rows.size, kind === 'created' ? 2 : 1)
    if (kind === 'created') assert.deepEqual(f.rows.get(f.initial.version.id)!.document, f.initial.document)
    assert.equal(store.dirty, false)
  }
})

test('revisione: risposta persa conserva ID e riconcilia la nuova versione', async () => {
  const f = revisionFixture(true), store = new ProgramsStore(f.repo), send = f.repo.revise
  let lost = true
  f.repo.revise = async (...args) => { const result = await send(...args); if (lost) { lost = false; throw new Error('response lost') } return result }
  await store.load(); await store.open(f.initial.version.id); store.revise()
  store.edit({ ...store.getSnapshot().document!, guidance: 'Nuove istruzioni' })
  assert.equal(await store.saveRevision(), 'created')
  assert.equal(f.rows.size, 2); assert.equal(store.dirty, false)
  assert.equal(f.attempts.length, 1)
})

test('revisione: retry dopo risposta persa riusa l’ID anche se la rilettura fallisce', async () => {
  const f = revisionFixture(true), store = new ProgramsStore(f.repo), send = f.repo.revise, read = f.repo.list
  let offline = true
  f.repo.revise = async (...args) => { const result = await send(...args); if (offline) throw new Error('response lost'); return result }
  f.repo.list = async (...args) => { if (offline) throw new Error('offline'); return read(...args) }
  f.repo.list = read
  await store.load(); await store.open(f.initial.version.id); store.revise()
  store.edit({ ...store.getSnapshot().document!, guidance: 'Nuove istruzioni' })
  f.repo.list = async (...args) => { if (offline) throw new Error('offline'); return read(...args) }
  assert.equal(await store.saveRevision(), null)
  assert.equal(store.getSnapshot().phase, 'ready'); assert.equal(store.dirty, true)
  offline = false
  assert.equal(await store.saveRevision(), 'created')
  assert.equal(f.attempts.length, 2)
  assert.equal(f.attempts[0], f.attempts[1])
  assert.equal(f.rows.size, 2)
})

test('revisione: esito unchanged del server non provoca rilettura né nuova versione', async () => {
  const f = revisionFixture(), store = new ProgramsStore(f.repo)
  await store.load(); await store.open(f.initial.version.id); store.revise()
  store.edit({ ...store.getSnapshot().document!, guidance: 'Modifica locale' })
  let reads = 0
  f.repo.get = async () => { reads++; return null }
  f.repo.revise = async ({ base }) => ({ outcome: 'unchanged', versionId: base.version.id, planRevision: base.plan.revision })
  assert.equal(await store.saveRevision(), 'unchanged')
  assert.equal(reads, 0); assert.equal(f.rows.size, 1)
})

test('revisione: solo ciclo aggiorna metadata e conserva l’ID della versione', async () => {
  const f = revisionFixture(true), store = new ProgramsStore(f.repo)
  await store.load(); await store.open(f.initial.version.id); store.revise()
  store.setCycleDraft({ start: '2026-10-05', weeks: 6 })
  assert.equal(store.dirty, true)
  assert.equal(await store.saveRevision(), 'metadata')
  assert.equal(f.rows.size, 1)
  assert.equal(store.getSnapshot().base?.version.id, f.initial.version.id)
  assert.deepEqual(store.getSnapshot().base?.plan.cycle, { start: '2026-10-05', weeks: 6 })
})

test('revisione: conflitto conserva la modifica locale e richiede ripartenza online', async () => {
  const f = revisionFixture(), store = new ProgramsStore(f.repo)
  await store.load(); await store.open(f.initial.version.id); store.revise()
  store.edit({ ...store.getSnapshot().document!, guidance: 'Modifica locale' })
  const online = f.rows.get(f.initial.version.id)!
  f.rows.set(online.version.id, { ...online, plan: { ...online.plan, revision: 3 }, document: { ...online.document, guidance: 'Modifica remota' } })
  assert.equal(await store.saveRevision(), null)
  assert.equal(store.getSnapshot().phase, 'conflict')
  assert.equal(store.getSnapshot().document?.guidance, 'Modifica locale')
  assert.equal(store.getSnapshot().remote?.document.guidance, 'Modifica remota')
  store.restartRevision(); assert.equal(store.dirty, false)
  assert.equal(store.getSnapshot().document?.guidance, 'Modifica remota')
})

test('errori di lettura distinti da vuoto, richieste tardive ignorate dopo cambio account', async () => {
  const f = fixture(), store = new ProgramsStore(f.repo)
  f.repo.list = async () => { throw new Error('offline') }; await store.load(); store.create(); assert.equal(store.getSnapshot().document, null)
  f.repo.list = async () => []; await store.retry(); store.create(); const draft = store.getSnapshot().document!
  store.edit({ ...draft, title: 'Locale' })
  let finish!: () => void; let sentSignal: AbortSignal | undefined
  f.repo.save = async (_, __, signal) => { sentSignal = signal; return new Promise<void>(done => { finish = done }) }
  const pending = store.save(); store.stop(); const snapshot = store.getSnapshot()
  assert.equal(sentSignal?.aborted, true); finish(); await pending; assert.equal(store.getSnapshot(), snapshot)
})

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
function sdk(respond: (request: Request) => Promise<Response>) {
  const client = createClient('http://127.0.0.1:54321', 'fixture-public', { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: async (url, init) => respond(new Request(url, init)) } })
  client.auth.getSession = async () => ({ data: { session: { user: { id: owner }, access_token: 'fixture-token' } as Session }, error: null })
  return client
}
function databaseRows(value = saved()) {
  const doc = value.document, day = doc.days[0]!, item = day.exercises[0]!, payload = programPayload(doc).p_days[0]!.exercises[0]!
  return {
    workout_plans: { id: doc.planId, owner_id: owner, name: doc.title, revision: value.plan.revision, active_version_id: null, archived_at: null },
    workout_plan_versions: { id: doc.id, owner_id: owner, plan_id: doc.planId, title: doc.title, guidance: doc.guidance, revision: value.version.revision, version_number: 1, status: value.version.status },
    workout_days: { id: day.id, owner_id: owner, version_id: doc.id, position: 0, label: day.label, title: day.title, note: day.note },
    workout_prescriptions: { ...payload, owner_id: owner, day_id: day.id, position: 0, mode: 'reps', exercise_snapshot: { id: exercise.id, name: exercise.name, variant: '', equipment: '', load_convention: 'total', load_unit: 'kg', mode: 'reps', per_side: false, note: '' }, note: item.note },
  }
}

test('SDK: salvataggio documento soltanto tramite RPC, proprietario assente, snapshot assente', async () => {
  const value = saved(), rows = databaseRows(value), requests: Request[] = []
  const client = sdk(async request => {
    requests.push(request)
    const publish = request.url.endsWith('/publish_workout_version')
    return json([{ ...rows.workout_plan_versions, revision: publish ? 2 : 1, status: publish ? 'published' : 'draft' }])
  })
  const repo = createProgramsRepository(client, owner)
  await repo.save(value.document, 0, signal()); await repo.publish(value, signal())
  assert.equal(requests.length, 2)
  assert.ok(requests[0]!.url.endsWith('/rpc/save_workout_draft'))
  assert.equal(requests[0]!.headers.get('Authorization'), 'Bearer fixture-token')
  const body = await requests[0]!.json()
  assert.equal(body.p_expected_revision, 0); assert.equal('owner_id' in body, false)
  assert.equal('exercise_snapshot' in body.p_days[0].exercises[0], false)
  assert.deepEqual(await requests[1]!.json(), { p_version_id: value.version.id, p_expected_revision: 1, p_expected_plan_revision: 1 })
})

test('SDK: aggregato ordinato e validato, pagina vuota richiesta, revisione riletta', async () => {
  const value = saved(), rows = databaseRows(value), requests: URL[] = []
  const client = sdk(async request => {
    const url = new URL(request.url); requests.push(url)
    assert.equal(url.searchParams.get('owner_id'), `eq.${owner}`)
    const row = rows[url.pathname.split('/').at(-1) as keyof typeof rows]
    return json(url.searchParams.get('id')?.startsWith('gt.') ? [] : [row])
  })
  const result = await createProgramsRepository(client, owner).get(value.version.id, signal())
  assert.ok(result && sameProgram(result.document, value.document))
  assert.equal(requests.filter(url => url.pathname.endsWith('workout_plan_versions')).length, 2)
  assert.ok(requests.some(url => url.searchParams.get('day_id') === `eq.${value.document.days[0]!.id}`))
})

test('SDK: revisione cambiata durante le letture impone ricostruzione, mai documento misto', async () => {
  const value = saved(), rows = databaseRows(value); let reads = 0
  const client = sdk(async request => {
    const url = new URL(request.url), table = url.pathname.split('/').at(-1) as keyof typeof rows
    if (table === 'workout_plan_versions') return json([{ ...rows[table], revision: ++reads }])
    return json(url.searchParams.get('id')?.startsWith('gt.') ? [] : [rows[table]])
  })
  await assert.rejects(createProgramsRepository(client, owner).get(value.version.id, signal()), error => error instanceof ProgramsFailure && error.kind === 'conflict')
  assert.equal(reads, 4)
})

test('SDK: dati di altro owner, snapshot incoerente, revisioni/RPC invalide e sessione errata respinti', async () => {
  const value = saved(), rows = databaseRows(value)
  for (const invalid of [{ ...rows.workout_plan_versions, owner_id: 'other' }, { ...rows.workout_plan_versions, revision: 0 }, { ...rows.workout_plan_versions, id: owner }]) {
    await assert.rejects(createProgramsRepository(sdk(async () => json([invalid])), owner).get(value.version.id, signal()), ProgramsFailure)
  }
  for (const bad of [{ ...rows.workout_prescriptions, position: 2 }, { ...rows.workout_prescriptions, sets: 0 }, { ...rows.workout_prescriptions, exercise_id: owner }]) {
    const client = sdk(async request => {
      const url = new URL(request.url), table = url.pathname.split('/').at(-1) as keyof typeof rows
      return json(url.searchParams.get('id')?.startsWith('gt.') ? [] : [table === 'workout_prescriptions' ? bad : rows[table]])
    })
    await assert.rejects(createProgramsRepository(client, owner).get(value.version.id, signal()), ProgramsFailure)
  }
  let sent = 0; const client = sdk(async () => { sent++; return json([]) })
  await assert.rejects(createProgramsRepository(client, 'another').list(signal()), error => error instanceof ProgramsFailure && error.kind === 'session')
  assert.equal(sent, 0)
  await assert.rejects(createProgramsRepository(client, owner).save(value.document, 0, signal()), ProgramsFailure)
})

test('SDK: errori controllati, nessun retry automatico RPC e nessun testo privato', async () => {
  for (const [code, kind] of [['PT409', 'conflict'], ['23514', 'invalid'], ['55000', 'unavailable']]) {
    let calls = 0
    const client = sdk(async () => { calls++; return json({ code, message: 'private SQL text' }, 409) })
    await assert.rejects(createProgramsRepository(client, owner).save(document(), 0, signal()), error => error instanceof ProgramsFailure && error.kind === kind && !error.message.includes('private'))
    assert.equal(calls, 1)
  }
})
