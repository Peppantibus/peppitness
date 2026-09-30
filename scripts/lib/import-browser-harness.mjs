// Harness browser riutilizzabile per le prove dell'importazione (task 11, poi 12/13 e 22).
// Solo Chrome DevTools Protocol, nessuna dipendenza aggiuntiva.
//
// - ensureChrome(): usa il Chrome di test già in ascolto su TEST_DEBUG_URL (default 127.0.0.1:9223) oppure ne
//   avvia uno headless con un profilo dedicato e temporaneo in artifacts/ (mai quello personale). Percorso del
//   binario: CHROME_PATH, altrimenti i percorsi standard di Windows/macOS/Linux.
// - ensurePreview(): usa la preview già in ascolto su TEST_BASE_URL (default 127.0.0.1:4173) oppure avvia
//   `vite preview` sulla build esistente in dist/ (serve prima `npm.cmd run build`).
// - Ogni funzione restituisce stop(): termina soltanto i processi avviati da questo harness e cancella
//   soltanto le cartelle che ha creato.
// - openTab(): scheda CDP con evaluate/until/click/setFiles/viewport/screenshot, richieste ed errori registrati;
//   gli eventi Fetch possono essere instradati a gestori propri (per trattenere o far fallire uno script).
// - buildComponentHarness()/serveStatic(): build Vite isolata di componenti React con stato sintetico, servita
//   su 127.0.0.1 con la CSP di public/_headers; non entra mai nella build dell'app.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const debugUrl = process.env.TEST_DEBUG_URL ?? 'http://127.0.0.1:9223'
export const baseUrl = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:4173'
export const pause = ms => new Promise(done => setTimeout(done, ms))

const reachable = async url => {
  try { const response = await fetch(url, { signal: AbortSignal.timeout(1500) }); return response.ok } catch { return false }
}
async function waitUntil(check, what, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) { if (await check()) return; await pause(100) }
  throw new Error(`${what} non disponibile`)
}
function stopProcess(child) {
  if (!child || child.exitCode !== null) return Promise.resolve()
  return new Promise(done => {
    child.once('exit', () => done())
    // Windows: termina l'albero del processo avviato (Chrome crea processi figli), non altri.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
    else child.kill('SIGTERM')
    setTimeout(done, 5000)
  })
}

export function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].filter(Boolean)
  return candidates.find(candidate => existsSync(candidate)) ?? null
}

/** Chrome di test: riusa quello in ascolto, altrimenti lo avvia con profilo temporaneo dedicato. */
export async function ensureChrome({ url = debugUrl } = {}) {
  if (await reachable(`${url}/json/version`)) return { started: false, stop: async () => {} }
  const binary = chromePath()
  if (!binary) throw new Error(`Chrome non trovato: imposta CHROME_PATH oppure avvia un Chrome di test con --remote-debugging-port su ${url}`)
  const port = new URL(url).port
  const profile = join(root, 'artifacts', `chrome-profile-${process.pid}`)
  await mkdir(profile, { recursive: true })
  const child = spawn(binary, ['--headless=new', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--disable-sync', 'about:blank'], { stdio: 'ignore' })
  await waitUntil(() => reachable(`${url}/json/version`), 'Chrome di test')
  return { started: true, stop: async () => { await stopProcess(child); await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {}) } }
}

/** Preview dell'app: riusa quella in ascolto, altrimenti avvia `vite preview` sulla build esistente. */
export async function ensurePreview({ url = baseUrl } = {}) {
  if (await reachable(url)) return { started: false, stop: async () => {} }
  if (!existsSync(join(root, 'dist', 'index.html'))) throw new Error('Build assente: eseguire prima `npm.cmd run build`.')
  const { port, hostname } = new URL(url)
  const child = spawn(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--host', hostname, '--port', port, '--strictPort'], { cwd: root, stdio: 'ignore' })
  await waitUntil(() => reachable(url), 'Preview dell\'app')
  return { started: true, stop: () => stopProcess(child) }
}

/** CSP dell'app (public/_headers) senza l'origine Supabase, per i server di prova. */
export async function appCsp() {
  const headers = await readFile(join(root, 'public', '_headers'), 'utf8')
  return /Content-Security-Policy:\s*(.+)/.exec(headers)[1].replace(' __SUPABASE_ORIGIN__', '').trim()
}

/**
 * Scheda CDP. `fetchHandlers`: funzioni (params) => boolean chiamate per ogni Fetch.requestPaused; se una
 * restituisce true l'evento è suo, altrimenti passa a `socketProxy` (es. installAuthFixture delle API simulate).
 */
export async function openTab({ url = debugUrl, timeout = 20000 } = {}) {
  const target = await fetch(`${url}/json/new?about:blank`, { method: 'PUT' }).then(response => response.json())
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  let sequence = 0
  const pending = new Map()
  const socketProxy = new EventTarget()
  const tab = { id: target.id, socket, socketProxy, requests: [], errors: [], dialogs: [], fetchHandlers: [], closed: false }
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve: done, reject, timer } = pending.get(message.id)
      clearTimeout(timer); pending.delete(message.id)
      if (message.error) reject(new Error(`CDP ${message.error.code}: ${message.error.message}`)); else done(message.result)
      return
    }
    if (message.method === 'Network.requestWillBeSent') tab.requests.push(message.params.request.url)
    if (message.method === 'Runtime.exceptionThrown') tab.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') tab.errors.push(`${message.params.entry.text} ${message.params.entry.url ?? ''}`)
    if (message.method === 'Page.javascriptDialogOpening') { tab.dialogs.push(message.params.type); void tab.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {}) }
    if (message.method === 'Fetch.requestPaused' && tab.fetchHandlers.some(handler => handler(message.params))) return
    socketProxy.dispatchEvent(Object.assign(new Event('message'), { data: event.data }))
  })
  tab.send = (method, params = {}) => new Promise((done, reject) => {
    const id = ++sequence
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, timeout)
    pending.set(id, { resolve: done, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  tab.evaluate = async expression => {
    const response = await tab.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  tab.until = async (expression, what = expression, attempts = 200) => {
    for (let attempt = 0; attempt < attempts; attempt++) { if (await tab.evaluate(expression).catch(() => false)) return; await pause(50) }
    throw new Error(`Condizione non raggiunta: ${what}`)
  }
  tab.click = async selector => {
    const point = await tab.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Elemento assente: ' + ${JSON.stringify(selector)}); element.scrollIntoView({ block: 'center' }); const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 } })()`)
    await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    await pause(80)
  }
  tab.key = async (key, code = key, keyCode = 0) => {
    await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode })
    await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode })
    await pause(50)
  }
  /** Sceglie file dal disco in un <input type=file> (come il selettore del sistema), con evento change. */
  tab.setFiles = async (selector, files) => {
    const { root: document } = await tab.send('DOM.getDocument', { depth: 0 })
    const { nodeId } = await tab.send('DOM.querySelector', { nodeId: document.nodeId, selector })
    if (!nodeId) throw new Error(`Campo file assente: ${selector}`)
    await tab.send('DOM.setFileInputFiles', { nodeId, files })
  }
  tab.viewport = async (width, height, mobile = false) => { await tab.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }); await pause(120) }
  tab.screenshot = async path => {
    const result = await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.from(result.data, 'base64'))
  }
  tab.navigate = async (address, ready) => { await tab.send('Page.navigate', { url: address }); if (ready) await tab.until(ready) }
  tab.close = async () => {
    if (tab.closed) return
    tab.closed = true
    try { socket.close() } catch { /* già chiuso */ }
    await fetch(`${url}/json/close/${tab.id}`).catch(() => {})
  }
  for (const domain of ['Page', 'Runtime', 'Log', 'Network', 'DOM']) await tab.send(`${domain}.enable`)
  return tab
}

/**
 * Build Vite isolata di componenti (React + stili dell'app) in artifacts/<name>-<pid>/. `entry` è il sorgente
 * TSX del modulo d'ingresso; `at(path)` converte un percorso di src/ in import relativo dalla cartella.
 */
export async function buildComponentHarness({ name, entry }) {
  const dir = join(root, 'artifacts', `${name}-${process.pid}`)
  await mkdir(dir, { recursive: true })
  const at = path => relative(dir, join(root, 'src', path)).replaceAll('\\', '/')
  await writeFile(join(dir, 'index.html'), `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><title>Harness ${name}</title></head><body><main id="main-content"><div id="root"></div></main><script type="module" src="./harness.tsx"></script></body></html>`)
  await writeFile(join(dir, 'harness.tsx'), typeof entry === 'function' ? entry(at) : entry)
  const { build } = await import('vite')
  const react = (await import('@vitejs/plugin-react')).default
  await build({ configFile: false, root: dir, logLevel: 'warn', plugins: [react()], build: { outDir: join(dir, 'dist'), emptyOutDir: true, target: 'safari16', sourcemap: false } })
  return { dir, dist: join(dir, 'dist'), cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/**
 * Server statico su 127.0.0.1 con la CSP dell'app (o `csp` indicata); `extra` mappa percorsi URL → file
 * consentiti (fixture). `setDist()` cambia la cartella servita (per esempio una build successiva della PWA).
 */
export async function serveStatic({ dist, extra = new Map(), csp: policy, port = 0 }) {
  const csp = policy ?? await appCsp()
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf', '.docx': 'application/octet-stream' }
  let served = dist
  const server = createServer(async (request, response) => {
    const path = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
    let file = extra.get(path) ?? null
    if (!file) {
      const candidate = resolve(served, `.${path === '/' ? '/index.html' : path}`)
      if (candidate.startsWith(served)) file = candidate
    }
    try {
      const body = await readFile(file)
      response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' })
      response.end(body)
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise((done, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', done) })
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    setDist: next => { served = next },
    stop: () => { server.closeAllConnections(); return new Promise(done => server.close(done)) },
  }
}

/** Dati IndexedDB del journal d'importazione nella pagina (per verificare contenuti, account e assenza di byte). */
export const journalRecordsExpression = `new Promise((done, fail) => {
  const request = indexedDB.open('peppitness-import')
  request.onupgradeneeded = () => { request.transaction.abort(); done([]) }
  request.onsuccess = () => {
    const db = request.result
    if (!db.objectStoreNames.contains('sessions')) { db.close(); done([]); return }
    const all = db.transaction('sessions').objectStore('sessions').getAll()
    all.onsuccess = () => { db.close(); done(all.result.map(record => ({ ownerId: record.ownerId, kind: record.session.kind, status: record.session.status, file: record.session.file.name, hasDocument: Boolean(record.session.document), bytes: JSON.stringify(record).includes('"bytes"') || Object.values(record.session.file).some(value => value instanceof ArrayBuffer || ArrayBuffer.isView(value)) }))) }
    all.onerror = () => fail(all.error)
  }
  request.onerror = () => done([])
})`
