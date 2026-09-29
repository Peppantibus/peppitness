// Prova del journal locale dell'importazione su IndexedDB reale (task 07): scrittura durevole e ripresa
// dopo ricarica, conflitto fra due schede della stessa origine, isolamento e pulizia per account,
// database creato da una versione più nuova. Non dipende dalla UI (che arriva con i task 11/22).
//
// Bootstrap del browser (profilo dedicato, mai quello personale), in un terminale separato:
//   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --remote-debugging-port=9223 `
//     --user-data-dir="$PWD\.browser-profile" about:blank
// Poi: node scripts/import-review-storage-browser-check.mjs   (TEST_DEBUG_URL per un altro endpoint CDP)
//
// Lo script costruisce con Vite un entry di prova isolato in artifacts/import-review-harness-<pid>/
// (mai nella build pubblica), lo serve su 127.0.0.1 con la CSP dell'app e cancella alla fine soltanto
// la cartella che ha creato; i database IndexedDB di prova hanno un nome proprio e vengono eliminati.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const debugUrl = process.env.TEST_DEBUG_URL ?? 'http://127.0.0.1:9223'
const fixtures = join(root, 'tests', 'fixtures', 'import')
const harnessDir = join(root, 'artifacts', `import-review-harness-${process.pid}`)
const headers = await readFile(join(root, 'public', '_headers'), 'utf8')
const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)[1].replace(' __SUPABASE_ORIGIN__', '').trim()
const DB = `peppitness-import-check-${process.pid}`

let server = null
const tabs = []
const cleanup = async () => {
  for (const tab of tabs) {
    try { tab.socket.close() } catch { /* già chiuso */ }
    await fetch(`${debugUrl}/json/close/${tab.id}`).catch(() => {})
  }
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  await rm(harnessDir, { recursive: true, force: true })
}

async function openTab(origin) {
  const target = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  let sequence = 0
  const pending = new Map()
  const tab = { id: target.id, socket, requests: [], errors: [] }
  tabs.push(tab)
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve: done, reject, timeout } = pending.get(message.id)
      clearTimeout(timeout); pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error))); else done(message.result)
    }
    if (message.method === 'Network.requestWillBeSent') tab.requests.push(message.params.request.url)
    if (message.method === 'Runtime.exceptionThrown') tab.errors.push(message.params.exceptionDetails.text)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') tab.errors.push(message.params.entry.text)
  })
  tab.send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
    pending.set(id, { resolve: done, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
  tab.evaluate = async expression => {
    const response = await tab.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  tab.load = async () => {
    await tab.send('Page.navigate', { url: origin })
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await tab.evaluate('Boolean(window.harnessReady)').catch(() => false)) return
      await new Promise(done => setTimeout(done, 50))
    }
    throw new Error('harness non avviato')
  }
  await tab.send('Page.enable')
  await tab.send('Runtime.enable')
  await tab.send('Log.enable')
  await tab.send('Network.enable')
  await tab.load()
  return tab
}

try {
  await mkdir(harnessDir, { recursive: true })
  const at = path => relative(harnessDir, join(root, 'src', 'import', 'review', path)).replaceAll('\\', '/')
  await writeFile(join(harnessDir, 'index.html'), '<!doctype html><html lang="it"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Harness journal import</title></head><body><script type="module" src="./harness.ts"></script></body></html>')
  await writeFile(join(harnessDir, 'harness.ts'), `
import { indexedDbBackend, recordKey, ReviewStore } from '${at('local-storage.ts')}'
import { applyImportEvent, createImportSession } from '${at('state.ts')}'
import { createReviewDraft, sequentialLocalIds } from '${at('draft.ts')}'
import { findItem, setField } from '${at('decisions.ts')}'
const DB = ${JSON.stringify(DB)}
const json = async (name: string) => (await fetch('/fixtures/' + name)).json()
const store = () => new ReviewStore(indexedDbBackend(indexedDB, DB))
const held = new Map<string, any>()
const event = (session: any, value: any) => applyImportEvent(session, { ownerId: session.ownerId, sessionId: session.sessionId, at: new Date().toISOString(), ...value })
const summary = (result: any) => result.status === 'ok'
  ? { status: 'ok', revision: result.session.revision, persistence: result.session.persistence, state: result.session.status, sets: findItem(result.session.draft, 'i2')?.values.sets ?? null, decisions: result.session.draft.decisions.length }
  : { status: result.status }
;(window as any).harness = {
  async seed(owner: string, sessionId: string) {
    const document = await json('documents/workout-incomplete.json')
    const extraction = await json('extractions/workout-incomplete.json')
    let session: any = createImportSession({ ownerId: owner, sessionId, kind: 'workout', file: { name: 'scheda.docx', size: 1000, format: 'docx', sourceHash: null }, at: new Date().toISOString() })
    session = event(session, { type: 'read_started' }).state
    session = event(session, { type: 'read_succeeded', document, sourceHash: document.sourceHash }).state
    session = event(session, { type: 'analysis_started', analysisRequestId: 'a-1' }).state
    const draft = createReviewDraft({ kind: 'workout', extraction, proposalId: '90000000-0000-4000-8000-000000000001', jobId: null, source: { sourceHash: document.sourceHash, readerVersion: document.readerVersion, textNormalizationVersion: 'peppitness.text-normalization.v1' }, localIds: sequentialLocalIds('i') })
    session = event(session, { type: 'analysis_succeeded', analysisRequestId: 'a-1', jobId: null, draft, serverExpiresAt: null }).state
    const saved = await store().save(session)
    return { ok: saved.ok, revision: saved.session.revision, persistence: saved.session.persistence }
  },
  /** Legge e tiene in memoria la sessione, come una scheda aperta. */
  async hold(owner: string, sessionId: string) { const result = await store().load(owner, sessionId); if (result.status === 'ok') held.set(sessionId, result.session); return summary(result) },
  /** Modifica la sessione tenuta in memoria e la scrive con la revisione letta. */
  async edit(sessionId: string, sets: number) {
    const session = held.get(sessionId)
    const next = event(session, { type: 'draft_changed', draft: setField(session.draft, 'i2', 'sets', sets, 'user_edit') }).state
    const saved = await store().save(next)
    if (saved.ok) held.set(sessionId, saved.session)
    return saved.ok ? { ok: true, revision: saved.session.revision } : { ok: false, reason: saved.reason, storedRevision: (saved as any).storedRevision ?? null, persistence: saved.session.persistence }
  },
  async load(owner: string, sessionId: string) { return summary(await store().load(owner, sessionId)) },
  async open(owner: string) { return store().open(owner) },
  async clear(owner: string) { await store().clearOwner(owner) },
  async keys() {
    return new Promise((done, fail) => {
      const request = indexedDB.open(DB)
      request.onsuccess = () => { const db = request.result; const all = db.transaction('sessions').objectStore('sessions').getAllKeys(); all.onsuccess = () => { db.close(); done(all.result.map(String)) }; all.onerror = () => fail(all.error) }
      request.onerror = () => fail(request.error)
    })
  },
  async hasBytes() {
    return new Promise((done, fail) => {
      const request = indexedDB.open(DB)
      request.onsuccess = () => { const db = request.result; const all = db.transaction('sessions').objectStore('sessions').getAll(); all.onsuccess = () => { db.close(); done(all.result.some((record: any) => JSON.stringify(record).includes('"bytes"') || Object.values(record.session.file).some(value => value instanceof ArrayBuffer || ArrayBuffer.isView(value as any)))) }; all.onerror = () => fail(all.error) }
      request.onerror = () => fail(request.error)
    })
  },
  async newerDatabase() {
    const name = DB + '-newer'
    await new Promise((done, fail) => { const request = indexedDB.open(name, 5); request.onupgradeneeded = () => request.result.createObjectStore('sessions', { keyPath: 'key' }); request.onsuccess = () => { request.result.close(); done(null) }; request.onerror = () => fail(request.error) })
    const loaded: any = await new ReviewStore(indexedDbBackend(indexedDB, name)).load('owner-a', 's-1')
    const saved = { status: loaded.status, reason: loaded.reason }
    await new Promise(done => { const request = indexedDB.deleteDatabase(name); request.onsuccess = request.onerror = request.onblocked = () => done(null) })
    return saved
  },
  async drop() { await new Promise(done => { const request = indexedDB.deleteDatabase(DB); request.onsuccess = request.onerror = request.onblocked = () => done(null) }) },
  key: recordKey,
}
;(window as any).harnessReady = true
`)
  await build({ configFile: false, root: harnessDir, logLevel: 'warn', build: { outDir: join(harnessDir, 'dist'), emptyOutDir: true, target: 'safari16', sourcemap: false } })

  const allowed = new Map(['documents/workout-incomplete.json', 'extractions/workout-incomplete.json'].map(name => [name, join(fixtures, name)]))
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' }
  server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    let file = null
    if (path.startsWith('/fixtures/')) file = allowed.get(path.slice('/fixtures/'.length)) ?? null
    else {
      const candidate = resolve(harnessDir, 'dist', `.${path === '/' ? '/index.html' : path}`)
      if (candidate.startsWith(join(harnessDir, 'dist'))) file = candidate
    }
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' })
      response.end(body)
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`

  const a = await openTab(origin)
  const b = await openTab(origin)
  try {
    // Scrittura durevole e ripresa dopo ricarica.
    assert.deepEqual(await a.evaluate(`harness.seed('owner-a', 's-1')`), { ok: true, revision: 1, persistence: 'durable' })
    assert.equal(await a.evaluate('harness.hasBytes()'), false, 'byte originali nel journal')
    await a.load()
    assert.deepEqual(await a.evaluate(`harness.hold('owner-a', 's-1')`), { status: 'ok', revision: 1, persistence: 'durable', state: 'reviewing', sets: null, decisions: 0 })

    // Due schede sulla stessa bozza: la seconda scrittura con una revisione vecchia è un conflitto.
    assert.equal((await b.evaluate(`harness.hold('owner-a', 's-1')`)).revision, 1)
    assert.deepEqual(await a.evaluate(`harness.edit('s-1', 4)`), { ok: true, revision: 2 })
    assert.deepEqual(await b.evaluate(`harness.edit('s-1', 5)`), { ok: false, reason: 'conflict', storedRevision: 2, persistence: 'volatile' })
    await b.load()
    assert.deepEqual(await b.evaluate(`harness.load('owner-a', 's-1')`), { status: 'ok', revision: 2, persistence: 'durable', state: 'reviewing', sets: 4, decisions: 1 })

    // Isolamento: un altro account non legge e all'apertura elimina i residui del primo.
    assert.deepEqual(await b.evaluate(`harness.load('owner-b', 's-1')`), { status: 'missing' })
    assert.deepEqual(await a.evaluate(`harness.seed('owner-b', 's-2')`), { ok: true, revision: 1, persistence: 'durable' })
    const opened = await b.evaluate(`harness.open('owner-b')`)
    assert.deepEqual(opened.sessions.map(session => session.sessionId), ['s-2'])
    assert.deepEqual(await b.evaluate('harness.keys()'), [await b.evaluate(`harness.key('owner-b', 's-2')`)])
    await b.evaluate(`harness.clear('owner-b')`)
    assert.deepEqual(await b.evaluate('harness.keys()'), [])

    // Database creato da una versione più nuova: archivio non disponibile, nessuna cancellazione.
    assert.deepEqual(await a.evaluate('harness.newerDatabase()'), { status: 'unavailable', reason: 'newer_database' })

    for (const tab of [a, b]) {
      assert.deepEqual(tab.errors, [], 'errori in console')
      assert.ok(tab.requests.every(url => url.startsWith(origin) || url.startsWith('data:') || url === 'about:blank'), `richieste esterne: ${tab.requests.filter(url => !url.startsWith(origin))}`)
    }
    console.log('import-review-storage-browser-check: PASS (IndexedDB reale: ripresa dopo ricarica, conflitto fra due schede, isolamento e pulizia per account, database più nuovo)')
  } finally {
    await a.evaluate('harness.drop()').catch(() => {})
  }
} finally {
  await cleanup()
}
