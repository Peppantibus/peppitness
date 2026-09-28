// Prova del reader PDF nel browser reale (task 05): worker module same-origin con PDF.js e motore
// del reader, caricamento lazy, golden identici a Node, annullamento seguito da un nuovo file,
// chiusura, rendering lazy su canvas con annullamento, decodificatore CCITT/JBIG2 locale, tempo e
// heap del worker sulla fixture limite, precache PWA del worker. Usa la CSP di public/_headers.
// Non dipende dalla UI né dal reader DOCX.
//
// Bootstrap del browser (profilo dedicato, mai quello personale), in un terminale separato:
//   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --headless=new --remote-debugging-port=9223 `
//     --user-data-dir="$PWD\.browser-profile" about:blank
// Poi: node scripts/import-pdf-reader-browser-check.mjs   (TEST_DEBUG_URL per un altro endpoint CDP)
//
// Lo script costruisce con Vite un entry di prova isolato in artifacts/import-pdf-harness-<pid>/
// (mai nella build pubblica), lo serve su 127.0.0.1 con porta libera, carica worker e fixture da
// tests/fixtures/import/pdf e alla fine chiude la scheda, il server e cancella soltanto la cartella
// che ha creato. Il PDF limite (30 pagine, quasi 10 MiB) è generato in memoria, mai scritto su disco.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { buildPdf, image, manyPages, noiseImage, text } from './lib/pdf-fixtures.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const debugUrl = process.env.TEST_DEBUG_URL ?? 'http://127.0.0.1:9223'
const fixtures = join(root, 'tests', 'fixtures', 'import', 'pdf')
const harnessDir = join(root, 'artifacts', `import-pdf-harness-${process.pid}`)
const manifest = JSON.parse(await readFile(join(fixtures, 'manifest.json'), 'utf8'))

// Stessi decodificatori e stessa cartella della build dell'app (src/import/readers/pdf-assets.ts).
const assetsSource = await readFile(join(root, 'src', 'import', 'readers', 'pdf-assets.ts'), 'utf8')
const assetDirectory = /PDFJS_ASSET_DIRECTORY = '([^']+)'/.exec(assetsSource)[1]
const decoderFiles = [...(/PDFJS_DECODER_FILES = \[([^\]]+)\]/.exec(assetsSource)[1].matchAll(/'([^']+)'/g))].map(match => match[1])
// Stessa soglia di precache della build PWA (vite.pwa.config.mjs).
const pwaSource = await readFile(join(root, 'vite.pwa.config.mjs'), 'utf8')
const precacheLimit = /maximumFileSizeToCacheInBytes: ([\d *]+)/.exec(pwaSource)[1].split('*').reduce((total, factor) => total * Number(factor.trim()), 1)
const decoderPlugin = {
  name: 'pdfjs-decoder-assets',
  async generateBundle(_, bundle) {
    // Stessa condizione di vite.config.ts: la build contiene i worker PDF.
    if (!Object.keys(bundle).some(name => /pdf-(render-)?worker/.test(name))) return
    for (const name of decoderFiles) this.emitFile({ type: 'asset', fileName: `${assetDirectory}/${name}`, source: await readFile(join(root, 'node_modules', 'pdfjs-dist', 'wasm', name)) })
  },
}

const headers = await readFile(join(root, 'public', '_headers'), 'utf8')
const csp = /Content-Security-Policy:\s*(.+)/.exec(headers)[1].replace(' __SUPABASE_ORIGIN__', '').trim()

const step = message => process.stderr.write(`· ${message}
`)
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
  const modulePath = file => relative(harnessDir, join(root, 'src', 'import', 'readers', file)).replaceAll('\\', '/')
  await writeFile(join(harnessDir, 'index.html'), '<!doctype html><html lang="it"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Harness reader PDF</title></head><body><script type="module" src="./harness.ts"></script></body></html>')
  await writeFile(join(harnessDir, 'harness.ts'), `
import { createPdfWorkerReader } from '${modulePath('worker-client.ts')}'
import { openPdfSourceView } from '${modulePath('pdf-render.ts')}'
const stats = { created: [] as string[], terminated: 0 }
const Native = Worker
// Conteggio di creazioni e chiusure dei worker reali, senza cambiarne il comportamento.
;(globalThis as any).Worker = class extends Native {
  constructor(url: string | URL, options?: WorkerOptions) { super(url, options); stats.created.push(String(url)) }
  terminate() { stats.terminated++; super.terminate() }
}
const violations: string[] = []
document.addEventListener('securitypolicyviolation', event => violations.push(event.violatedDirective + ' ' + event.blockedURI))
let reader = createPdfWorkerReader()
const bytesOf = async (name: string) => new Uint8Array(await (await fetch('/fixtures/' + name)).arrayBuffer())
const outcome = (promise: Promise<unknown>) => promise.then(result => ({ ok: true, result }), (error: any) => ({ ok: false, name: error?.name, code: error?.code, message: error?.message }))
const dark = (canvas: HTMLCanvasElement, box?: number[]) => {
  const context = canvas.getContext('2d')!
  const [x, y, w, h] = box ? [Math.floor(box[0] * canvas.width), Math.floor(box[1] * canvas.height), Math.max(1, Math.ceil(box[2] * canvas.width)), Math.max(1, Math.ceil(box[3] * canvas.height))] : [0, 0, canvas.width, canvas.height]
  const data = context.getImageData(x, y, w, h).data
  let count = 0
  for (let index = 0; index < data.length; index += 4) if (data[index]! + data[index + 1]! + data[index + 2]! < 300 && data[index + 3]! > 0) count++
  return count
}
;(window as any).harness = {
  stats: () => ({ ...stats, violations }),
  read: async (name: string) => {
    const bytes = await bytesOf(name)
    const started = performance.now()
    const result = await outcome(reader.read({ bytes, metadata: { format: 'pdf', mediaType: '' }, signal: new AbortController().signal }))
    return { ...result, elapsed: performance.now() - started }
  },
  cancelThenRead: async (slow: string, next: string, delay: number) => {
    const controller = new AbortController()
    const slowBytes = await bytesOf(slow)
    const nextBytes = await bytesOf(next)
    const started = performance.now()
    const first = outcome(reader.read({ bytes: slowBytes, metadata: { format: 'pdf', mediaType: null }, signal: controller.signal }))
    await new Promise(done => setTimeout(done, delay))
    controller.abort()
    const cancelled = await first
    const cancelledAfter = performance.now() - started
    const second = await outcome(reader.read({ bytes: nextBytes, metadata: { format: 'pdf', mediaType: null }, signal: new AbortController().signal }))
    return { cancelled, cancelledAfter, second }
  },
  close: () => { reader.close(); reader = createPdfWorkerReader() },
  render: async (name: string, page: number, scale: number, box?: number[]) => {
    const canvas = document.createElement('canvas')
    const view = await openPdfSourceView(await bytesOf(name))
    try {
      const rendered = await view.renderPage(page, canvas, { scale })
      return { ok: true, pageCount: view.pageCount, ...rendered, dark: dark(canvas), darkInBox: box ? dark(canvas, box) : null }
    } finally { await view.close() }
  },
  renderCancel: async (name: string, page: number, scale: number) => {
    const view = await openPdfSourceView(await bytesOf(name))
    const controller = new AbortController()
    const pending = outcome(view.renderPage(page, document.createElement('canvas'), { scale, signal: controller.signal }))
    await new Promise(done => setTimeout(done, 1))
    controller.abort()
    const result = await pending
    await view.close()
    return result
  },
}
;(window as any).harnessReady = true
`)
  const harnessBuild = (outDir, plugins = []) => build({
    configFile: false,
    root: harnessDir,
    logLevel: 'warn',
    plugins: [decoderPlugin, ...plugins],
    build: { outDir: join(harnessDir, outDir), emptyOutDir: true, target: 'safari16', sourcemap: false },
  })
  step('build dell’harness')
  await harnessBuild('dist')
  step('build PWA dell’harness')

  // --- Build PWA dell'harness: il worker PDF e i decodificatori entrano nel precache ---------
  await harnessBuild('dist-pwa', [VitePWA({
    registerType: 'prompt', injectRegister: false, manifest: false,
    workbox: { globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'], maximumFileSizeToCacheInBytes: precacheLimit, runtimeCaching: [] },
  })])
  const assets = await readdir(join(harnessDir, 'dist-pwa', 'assets'))
  const workerChunk = assets.find(name => /^pdf-worker.*\.js$/.test(name))
  assert.ok(workerChunk, `chunk del worker PDF assente: ${assets}`)
  const workerSize = (await stat(join(harnessDir, 'dist-pwa', 'assets', workerChunk))).size
  const serviceWorker = await readFile(join(harnessDir, 'dist-pwa', 'sw.js'), 'utf8')
  assert.ok(serviceWorker.includes(`assets/${workerChunk}`), `worker PDF (${workerSize} byte) fuori dal precache (soglia ${precacheLimit})`)
  for (const name of decoderFiles) assert.ok(serviceWorker.includes(`${assetDirectory}/${name}`), `${name} fuori dal precache`)
  assert.doesNotMatch(serviceWorker, /\.pdf|fixtures/, 'nessun documento nel precache')
  const distFiles = (await readdir(join(harnessDir, 'dist-pwa'), { recursive: true })).map(String)
  assert.ok(!distFiles.some(name => /\.(pdf|docx)$/.test(name)), 'nessun documento nella build')

  // PDF limite generato al volo: 30 pagine con immagini non comprimibili, sotto i 10 MiB.
  const limit = buildPdf({ pages: Array.from({ length: 30 }, (_, index) => ({ width: 595, height: 842, content: [text(56, 790, `Pagina ${index + 1}: Squat 3 x 10`), image('Foto', 56, 420, 480, 300)], images: { Foto: noiseImage(577, 577, index + 1) } })) })
  const long = manyPages(30)
  const allowed = new Map(manifest.cases.flatMap(item => [item.sourceFile, item.expected].filter(Boolean)).map(name => [name, join(fixtures, name)]))

  // --- Server statico con la CSP dell'app -----------------------------------------------------
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf' }
  server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    const send = (body, type) => { response.writeHead(200, { 'Content-Type': type, 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' }); response.end(body) }
    if (path === '/fixtures/limit.pdf') { send(limit, types['.pdf']); return }
    if (path === '/fixtures/long.pdf') { send(long, types['.pdf']); return }
    let file = null
    if (path.startsWith('/fixtures/')) file = allowed.get(path.slice('/fixtures/'.length)) ?? null
    else {
      const candidate = resolve(harnessDir, 'dist', `.${path === '/' ? '/index.html' : path}`)
      if (candidate.startsWith(join(harnessDir, 'dist'))) file = candidate
    }
    try {
      send(await readFile(file), types[extname(file)] ?? 'application/octet-stream')
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
  const workerSessions = new Map()
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
    if (message.method === 'Target.attachedToTarget' && message.params.targetInfo.type === 'worker') {
      // Richieste ed errori dei worker non passano dalla sessione della pagina: vanno osservati a parte.
      const sessionId = message.params.sessionId
      workerSessions.set(sessionId, message.params.targetInfo.url)
      for (const method of ['Network.enable', 'Runtime.enable']) socket.send(JSON.stringify({ id: ++sequence, method, params: {}, sessionId }))
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((done, reject) => {
    const id = ++sequence
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 60000)
    pending.set(id, { resolve: done, reject, timeout })
    socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
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
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  step(`harness su ${origin}`)
  await send('Page.navigate', { url: origin })
  for (let attempt = 0; attempt < 100 && !(await evaluate('Boolean(window.harnessReady)')); attempt++) await new Promise(done => setTimeout(done, 50))
  assert.equal(await evaluate('Boolean(window.harnessReady)'), true, 'harness non avviato')

  // Lazy loading: né worker né PDF.js prima della prima lettura.
  const workerRequests = () => requests.filter(url => /pdf-worker/.test(url))
  assert.deepEqual(workerRequests(), [], 'worker scaricato prima della lettura')
  assert.deepEqual((await evaluate('harness.stats()')).created, [])

  // Golden identici a quelli del motore in Node.
  step('golden')
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

  step('fixture limite')
  // Fixture limite: tempo nella pagina e heap del worker campionato via CDP.
  const readerSession = [...workerSessions].find(([, url]) => /pdf-worker/.test(url))?.[0]
  assert.ok(readerSession, 'sessione CDP del worker PDF')
  const heapOf = async () => { const usage = await send('Runtime.getHeapUsage', {}, readerSession); return usage.usedSize + (usage.embedderHeapUsedSize ?? 0) + (usage.backingStorageSize ?? 0) }
  const heapBefore = await heapOf()
  let heapPeak = heapBefore
  let sampling = true
  const sampler = (async () => { while (sampling) { heapPeak = Math.max(heapPeak, await heapOf().catch(() => 0)); await new Promise(done => setTimeout(done, 20)) } })()
  const limitRead = await evaluate(`harness.read('limit.pdf')`)
  sampling = false
  await sampler
  assert.equal(limitRead.ok, true, limitRead.message)
  assert.equal(limitRead.result.metadata.pageCount, 30)
  assert.ok(limitRead.result.metadata.inventory.every(entry => entry.issueCodes.includes('image_without_text')))
  const heapAfter = await heapOf()

  // Annullamento a metà di una lettura lunga, poi un altro file: la risposta tardiva non arriva al nuovo.
  step('annullamento')
  const cancelDelay = Math.max(5, Math.round(limitRead.elapsed / 3))
  const run = await evaluate(`harness.cancelThenRead('limit.pdf', 'pdf-table.pdf', ${cancelDelay})`)
  assert.deepEqual([run.cancelled.ok, run.cancelled.code], [false, 'cancelled'])
  assert.ok(run.cancelledAfter < 1000, `annullamento lento: ${run.cancelledAfter} ms`)
  assert.equal(run.second.ok, true, run.second.message)
  assert.deepEqual(run.second.result, JSON.parse(await readFile(join(fixtures, 'pdf-table.expected.json'), 'utf8')))
  await new Promise(done => setTimeout(done, 2500))
  const afterCancel = await evaluate('harness.stats()')
  assert.equal(afterCancel.terminated, 0, 'il motore ha confermato l’annullamento senza terminare il worker')

  // Chiusura: il worker termina; una nuova istanza lo ricrea alla lettura successiva.
  await evaluate('harness.close()')
  assert.equal((await evaluate('harness.stats()')).terminated, 1)
  const reopened = await evaluate(`harness.read('pdf-simple.pdf')`)
  assert.equal(reopened.ok, true)
  assert.equal((await evaluate('harness.stats()')).created.filter(url => /pdf-worker/.test(url)).length, 2)

  step('rendering')
  // Rendering lazy: pagina disegnata, bbox del titolo sopra pixel scuri, decodificatore CCITT locale.
  const simple = JSON.parse(await readFile(join(fixtures, 'pdf-simple.expected.json'), 'utf8'))
  const title = simple.document.blocks[0]
  const rendered = await evaluate(`harness.render('pdf-simple.pdf', 1, 1.5, ${JSON.stringify(title.bbox)})`)
  assert.deepEqual([rendered.ok, rendered.pageCount, rendered.width, rendered.height], [true, 1, 893, 1263])
  assert.ok(rendered.dark > 1000 && rendered.darkInBox > 100, `rendering vuoto: ${rendered.dark} / ${rendered.darkInBox}`)
  const scan = await evaluate(`harness.render('pdf-ccitt-scan.pdf', 1, 0.5)`)
  assert.equal(scan.ok, true)
  assert.ok(requests.some(url => url === `${origin}/${assetDirectory}/jbig2_nowasm_fallback.js`), 'decodificatore CCITT/JBIG2 locale caricato')
  const cancelledRender = await evaluate(`harness.renderCancel('limit.pdf', 1, 3)`)
  assert.deepEqual([cancelledRender.ok, cancelledRender.code], [false, 'cancelled'])

  const final = await evaluate('harness.stats()')
  assert.deepEqual(final.violations, [], 'violazioni CSP')
  assert.deepEqual(errors, [], 'errori in console')
  assert.ok(requests.every(url => url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank'), `richieste esterne: ${requests.filter(url => !url.startsWith(origin))}`)
  const mib = value => (value / 1048576).toFixed(1)
  console.log(`import-pdf-reader-browser-check: PASS (${manifest.cases.length} fixture; limite ${mib(limit.length)} MiB/30 pagine in ${Math.round(limitRead.elapsed)} ms, heap worker ${mib(heapBefore)}→picco ${mib(heapPeak)}→${mib(heapAfter)} MiB; annullamento dopo ${Math.round(run.cancelledAfter)} ms; worker PDF ${mib(workerSize)} MiB nel precache PWA)`)
} finally {
  await cleanup()
}
