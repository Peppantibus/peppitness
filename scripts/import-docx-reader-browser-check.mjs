// Prova del reader DOCX nel browser reale (task 03): worker module same-origin, lazy loading,
// golden, annullamento e chiusura, con la CSP di public/_headers. Non dipende dalla UI.
//
// Bootstrap del browser (profilo dedicato, mai quello personale), in un terminale separato:
//   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --remote-debugging-port=9223 `
//     --user-data-dir="$PWD\.browser-profile" about:blank
// Poi: node scripts/import-docx-reader-browser-check.mjs   (TEST_DEBUG_URL per un altro endpoint CDP)
//
// Lo script costruisce con Vite un entry di prova isolato in artifacts/import-docx-harness-<pid>/
// (mai nella build pubblica), lo serve su 127.0.0.1 con porta libera, carica il worker reale e le
// fixture da tests/fixtures/import/docx, confronta i risultati con i golden e alla fine chiude la
// scheda, il server e cancella soltanto la cartella che ha creato.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { buildDocx, para } from './lib/docx-fixtures.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const debugUrl = process.env.TEST_DEBUG_URL ?? 'http://127.0.0.1:9223'
const fixtures = join(root, 'tests', 'fixtures', 'import', 'docx')
const harnessDir = join(root, 'artifacts', `import-docx-harness-${process.pid}`)
const manifest = JSON.parse(await readFile(join(fixtures, 'manifest.json'), 'utf8'))

const headers = await readFile(join(root, 'public', '_headers'), 'utf8')
const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)[1].replace(' __SUPABASE_ORIGIN__', '').trim()

let server = null
let socket = null
let targetId = null
const cleanup = async () => {
  if (socket) { try { socket.close() } catch { /* già chiuso */ } }
  if (targetId) await fetch(`${debugUrl}/json/close/${targetId}`).catch(() => {})
  // Le connessioni keep-alive del browser non devono tenere aperto il server.
  if (server) { server.closeAllConnections(); await new Promise(done => server.close(done)) }
  await rm(harnessDir, { recursive: true, force: true })
}

try {
  // --- Entry di prova isolato ---------------------------------------------------------------
  await mkdir(harnessDir, { recursive: true })
  const client = relative(harnessDir, join(root, 'src', 'import', 'readers', 'worker-client.ts')).replaceAll('\\', '/')
  await writeFile(join(harnessDir, 'index.html'), '<!doctype html><html lang="it"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Harness reader DOCX</title></head><body><script type="module" src="./harness.ts"></script></body></html>')
  await writeFile(join(harnessDir, 'harness.ts'), `
import { createDocxWorkerReader } from '${client}'
const stats = { created: 0, terminated: 0 }
const Native = Worker
// Conteggio di creazioni e chiusure del worker reale, senza cambiarne il comportamento.
;(globalThis as any).Worker = class extends Native {
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); stats.created++ }
  terminate() { stats.terminated++; super.terminate() }
}
const violations: string[] = []
document.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective + ' ' + event.blockedURI))
let reader = createDocxWorkerReader()
const bytesOf = async (name: string) => new Uint8Array(await (await fetch('/fixtures/' + name)).arrayBuffer())
const outcome = (promise: Promise<unknown>) => promise.then(result => ({ ok: true, result }), (error: any) => ({ ok: false, name: error?.name, code: error?.code, message: error?.message }))
;(window as any).harness = {
  stats: () => ({ ...stats, violations }),
  read: async (name: string) => outcome(reader.read({ bytes: await bytesOf(name), metadata: { format: 'docx', mediaType: '' }, signal: new AbortController().signal })),
  cancelThenRead: async (slow: string, next: string, delay: number) => {
    const controller = new AbortController()
    const slowBytes = await bytesOf(slow)
    const nextBytes = await bytesOf(next)
    const started = performance.now()
    const first = outcome(reader.read({ bytes: slowBytes, metadata: { format: 'docx', mediaType: null }, signal: controller.signal }))
    await new Promise(done => setTimeout(done, delay))
    controller.abort()
    const cancelled = await first
    const cancelledAfter = performance.now() - started
    const second = await outcome(reader.read({ bytes: nextBytes, metadata: { format: 'docx', mediaType: null }, signal: new AbortController().signal }))
    return { cancelled, cancelledAfter, second }
  },
  close: () => { reader.close(); reader = createDocxWorkerReader() },
}
;(window as any).harnessReady = true
`)
  await build({
    configFile: false,
    root: harnessDir,
    logLevel: 'warn',
    build: { outDir: join(harnessDir, 'dist'), emptyOutDir: true, target: 'safari16', sourcemap: false },
  })

  // Documento grande generato al volo, solo per rendere osservabile l'annullamento a metà lettura.
  const large = buildDocx({ body: Array.from({ length: 40_000 }, (_, index) => para(`Esercizio ${index}: 3 x 10, recupero 60 secondi`)).join('') })
  const allowed = new Map(manifest.cases.flatMap(item => [item.sourceFile, item.expected].filter(Boolean)).map(name => [name, join(fixtures, name)]))

  // --- Server statico con la CSP dell'app -----------------------------------------------------
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.docx': 'application/octet-stream' }
  server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    let file = null
    if (path === '/fixtures/large.docx') { response.writeHead(200, { 'Content-Type': types['.docx'] }); response.end(large); return }
    if (path.startsWith('/fixtures/')) file = allowed.get(path.slice('/fixtures/'.length)) ?? null
    else {
      const candidate = resolve(harnessDir, 'dist', `.${path === '/' ? '/index.html' : path}`)
      if (candidate.startsWith(join(harnessDir, 'dist'))) file = candidate
    }
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' })
      response.end(body)
    } catch {
      response.writeHead(404); response.end()
    }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`

  // --- CDP ------------------------------------------------------------------------------------
  const target = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
  targetId = target.id
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  let sequence = 0
  const pending = new Map()
  const requests = []
  const errors = []
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve: done, reject, timeout } = pending.get(message.id)
      clearTimeout(timeout); pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error))); else done(message.result)
    }
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text)
  })
  const send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 30000)
    pending.set(id, { resolve: done, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  await send('Page.navigate', { url: origin })
  for (let attempt = 0; attempt < 100 && !(await evaluate('Boolean(window.harnessReady)')); attempt++) await new Promise(done => setTimeout(done, 50))
  assert.equal(await evaluate('Boolean(window.harnessReady)'), true, 'harness non avviato')

  // Lazy loading: nessun worker prima della prima lettura.
  const workerRequests = () => requests.filter(url => /docx-worker/.test(url))
  assert.deepEqual(workerRequests(), [], 'worker scaricato prima della lettura')
  assert.equal((await evaluate('harness.stats()')).created, 0)

  // Golden identici a quelli del motore in Node.
  for (const item of manifest.cases) {
    const outcome = await evaluate(`harness.read(${JSON.stringify(item.sourceFile)})`)
    if (item.expectedError) {
      assert.deepEqual([outcome.ok, outcome.code], [false, item.expectedError], item.id)
      continue
    }
    assert.equal(outcome.ok, true, `${item.id}: ${outcome.message}`)
    assert.deepEqual(outcome.result, JSON.parse(await readFile(join(fixtures, item.expected), 'utf8')), item.id)
  }
  assert.equal(workerRequests().length, 1, 'worker caricato una sola volta')
  assert.ok(workerRequests().every(url => url.startsWith(origin)), 'worker same-origin')
  assert.equal((await evaluate('harness.stats()')).created, 1)

  // Annullamento a metà di una lettura lunga, poi un altro file: la risposta tardiva non arriva al nuovo.
  const run = await evaluate(`harness.cancelThenRead('large.docx', 'docx-tables.docx', 40)`)
  assert.deepEqual([run.cancelled.ok, run.cancelled.code], [false, 'cancelled'])
  assert.ok(run.cancelledAfter < 1000, `annullamento lento: ${run.cancelledAfter} ms`)
  assert.equal(run.second.ok, true, run.second.message)
  assert.deepEqual(run.second.result, JSON.parse(await readFile(join(fixtures, 'docx-tables.expected.json'), 'utf8')))
  await new Promise(done => setTimeout(done, 2500))
  const afterCancel = await evaluate('harness.stats()')
  assert.deepEqual([afterCancel.created, afterCancel.terminated], [1, 0], 'il motore ha confermato l’annullamento senza terminare il worker')

  // Chiusura: il worker termina; una nuova istanza lo ricrea alla lettura successiva.
  await evaluate('harness.close()')
  assert.equal((await evaluate('harness.stats()')).terminated, 1)
  const reopened = await evaluate(`harness.read('docx-paragraphs.docx')`)
  assert.equal(reopened.ok, true)
  const final = await evaluate('harness.stats()')
  assert.deepEqual([final.created, final.terminated], [2, 1])

  assert.deepEqual(final.violations, [], 'violazioni CSP')
  assert.deepEqual(errors, [], 'errori in console')
  assert.ok(requests.every(url => url.startsWith(origin) || url.startsWith('data:') || url === 'about:blank'), `richieste esterne: ${requests.filter(url => !url.startsWith(origin))}`)
  console.log(`import-docx-reader-browser-check: PASS (${manifest.cases.length} fixture, annullamento dopo ${Math.round(run.cancelledAfter)} ms, worker creati ${final.created}, terminati ${final.terminated})`)
} finally {
  await cleanup()
}
