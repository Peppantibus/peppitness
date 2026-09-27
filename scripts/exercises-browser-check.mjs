import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fixturePassword, fixtureSession, fixtureStorageKey, installAuthFixture } from './lib/browser-auth-fixture.mjs'

const baseUrl = 'http://127.0.0.1:4173', debugUrl = 'http://127.0.0.1:9223'
const mock = {}, pages = [], checks = [], errors = []
async function page() {
  const target = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), task = pending.get(message.id)
    if (task) {
      pending.delete(message.id); clearTimeout(task.timeout)
      if (message.error) task.reject(new Error(`CDP ${message.error.code}`)); else task.resolve(message.result)
    }
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
    if (message.method === 'Page.javascriptDialogOpening') void send('Page.handleJavaScriptDialog', { accept: true })
  })
  function send(method, params = {}) {
    const id = ++sequence
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)) }, 10000)
      pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (response.exceptionDetails) throw new Error('Errore nel test browser catalogo')
    return response.result.value
  }
  async function until(expression) {
    for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error(`Condizione non raggiunta: ${expression}`)
  }
  async function input(selector, value) {
    await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`)
  }
  async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`) }
  async function route(path) { await evaluate(`location.hash=${JSON.stringify(path)}`) }
  async function close() { socket.close(); await fetch(`${debugUrl}/json/close/${target.id}`).catch(() => undefined) }
  const result = { send, evaluate, until, input, click, route, close }
  pages.push(result)
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await installAuthFixture(send, socket, baseUrl, mock)
  return result
}
const listReady = 'Boolean(document.querySelector(".catalog-toolbar"))'
const formReady = 'Boolean(document.querySelector("#exercise-name")) && !document.querySelector(".catalog-form > fieldset").disabled'
const saved = 'document.querySelector(".catalog-message")?.textContent.includes("salvato online")'
const conflict = 'Boolean(document.querySelector(".catalog-conflict"))'
try {
  await mkdir('artifacts', { recursive: true })
  const a = await page()
  const seed = await a.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear(); localStorage.setItem(${JSON.stringify(fixtureStorageKey)},${JSON.stringify(JSON.stringify(fixtureSession()))});` })
  await a.send('Page.navigate', { url: `${baseUrl}/#/scheda` }); await a.until('Boolean(document.querySelector(".section-menu-button"))')
  await a.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seed.identifier })
  await a.click('.section-menu-button'); await a.until('Boolean(document.querySelector(".section-menu a[href=\\"#/scheda/catalogo\\"]"))')
  await a.click('.section-menu a[href="#/scheda/catalogo"]'); await a.until(listReady)
  await a.click('.catalog-scope button[aria-pressed="false"]')
  assert.equal(mock.exercises.size, 0)
  assert.equal(mock.exerciseWrites.length, 0)
  assert.ok(await a.evaluate('document.querySelector(".empty-state").textContent.includes("catalogo è vuoto")'))
  checks.push('ingresso dalla scheda, account vuoto e nessuna creazione automatica')

  await a.click('.catalog-toolbar .primary'); await a.until(formReady)
  await a.input('#exercise-name', '   '); await a.click('.catalog-form button[type=submit]')
  await a.until('document.querySelector(".catalog-message")?.textContent.includes("Inserisci un nome")')
  assert.equal(mock.exercises.size, 0)
  await a.input('#exercise-name', 'Spinta sintetica')
  await a.input('#exercise-variant', 'Seduto'); await a.input('#exercise-equipment', 'Macchina A')
  await a.input('#exercise-note', '<b>Nota di prova</b>')
  await a.route('/impostazioni'); await a.until('Boolean(document.querySelector(".preferences-panel"))')
  await a.route('/scheda/catalogo'); await a.until(formReady)
  assert.equal(await a.evaluate('document.querySelector("#exercise-name").value'), 'Spinta sintetica')
  await a.click('.catalog-close'); await a.until('Boolean(document.querySelector("dialog[open]"))')
  await a.click('dialog .secondary'); await a.until('!document.querySelector("dialog")')
  checks.push('validazione, bozza nella navigazione e conferma prima dello scarto')
  for (const width of [320, 390, 768, 1440]) {
    await a.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 })
    assert.ok(await a.evaluate('document.documentElement.scrollWidth <= innerWidth'), `Overflow editor ${width}`)
  }
  await a.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await a.evaluate('scrollTo(0,0)')
  const screenshot = await a.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile('artifacts/exercises-mobile.png', Buffer.from(screenshot.data, 'base64'))
  checks.push('editor senza overflow a 320/390/768/1440 px')

  // Perdita della risposta dell'INSERT, dopo commit: un solo ID deve essere creato.
  mock.loseExerciseResponse = true
  await a.click('.catalog-form button[type=submit]'); await a.until(saved)
  assert.equal(mock.exercises.size, 1); assert.equal(mock.exerciseWrites.length, 1)
  assert.ok(await a.evaluate('document.querySelector(".catalog-message").textContent.includes("conferma recuperata")'))
  assert.equal(await a.evaluate('document.querySelector("#exercise-equipment").matches(":disabled")'), true)
  await a.click('.catalog-close'); await a.send('Page.reload'); await a.until(listReady)
  await a.click('.catalog-scope button[aria-pressed="false"]')
  assert.equal(await a.evaluate('document.querySelectorAll(".catalog-card").length'), 1)
  assert.equal(await a.evaluate('document.querySelector(".catalog-note").textContent'), '<b>Nota di prova</b>')
  assert.equal(await a.evaluate('Boolean(document.querySelector(".catalog-note b"))'), false)
  const first = [...mock.exercises.values()][0]
  checks.push('insert con risposta persa, UUID unico, reload e testo trattato senza HTML')

  await a.click('.catalog-edit'); await a.until(formReady)
  await a.input('#exercise-name', 'Spinta rinominata'); await a.click('#exercise-archived')
  await a.click('.catalog-form button[type=submit]'); await a.until(saved); await a.click('.catalog-close')
  assert.equal(await a.evaluate('document.querySelectorAll(".catalog-card").length'), 0)
  await a.input('#exercise-filter', 'archived')
  assert.equal(await a.evaluate('document.querySelectorAll(".catalog-card").length'), 1)
  await a.input('#exercise-search', 'rinominata macchina'); assert.equal(await a.evaluate('document.querySelectorAll(".catalog-card").length'), 1)
  await a.input('#exercise-search', 'inesistente'); assert.equal(await a.evaluate('document.querySelectorAll(".catalog-card").length'), 0)
  await a.input('#exercise-search', '')
  await a.click('.catalog-edit'); await a.until(formReady); await a.click('#exercise-archived')
  await a.click('.catalog-form button[type=submit]'); await a.until(saved); await a.click('.catalog-close')
  await a.input('#exercise-filter', 'active')
  assert.equal([...mock.exercises.values()][0].id, first.id)
  assert.equal([...mock.exercises.values()][0].archived_at, null)
  checks.push('rinomina, ricerca, archiviazione e ripristino sullo stesso ID')

  await a.click('.catalog-copy'); await a.until(formReady)
  assert.equal(await a.evaluate('document.querySelector("#exercise-equipment").matches(":disabled")'), false)
  await a.input('#exercise-name', 'Variante sintetica'); await a.input('#exercise-equipment', 'Macchina B')
  await a.input('#exercise-load', 'bodyweight'); await a.input('#exercise-mode', 'seconds'); await a.input('#exercise-unit', 'lb'); await a.click('#exercise-side')
  await a.click('.catalog-form button[type=submit]'); await a.until(saved); await a.click('.catalog-close')
  assert.equal(mock.exercises.size, 2)
  const variant = [...mock.exercises.values()].find(row => row.name === 'Variante sintetica')
  assert.notEqual(variant.id, first.id); assert.equal(variant.equipment, 'Macchina B'); assert.equal(variant.measurement_mode, 'seconds'); assert.equal(variant.per_side, true)
  assert.equal([...mock.exercises.values()].find(row => row.id === first.id).equipment, 'Macchina A')
  checks.push('nuova variante con altro ID; corpo libero, secondi, libbre e per lato')

  const b = await page(); await b.send('Page.navigate', { url: `${baseUrl}/#/scheda/catalogo` }); await b.until(listReady)
  await b.click('.catalog-scope button[aria-pressed="false"]')
  await a.click('.catalog-edit'); await b.click('.catalog-edit'); await b.until(formReady)
  await a.input('#exercise-note', 'Nota A'); await a.click('.catalog-form button[type=submit]'); await a.until(saved)
  await b.input('#exercise-note', 'Nota B'); await b.click('.catalog-form button[type=submit]'); await b.until(conflict)
  assert.ok(await b.evaluate('document.querySelector(".catalog-conflict").textContent.includes("Nota A")'))
  assert.equal(await b.evaluate('document.querySelector("#exercise-note").value'), 'Nota B')
  await b.click('.catalog-conflict .primary'); await b.until(saved)
  await a.input('#exercise-note', 'Bozza A'); await a.click('.catalog-form button[type=submit]'); await a.until(conflict)
  await a.click('.catalog-conflict .secondary'); await a.until('!document.querySelector(".catalog-conflict")')
  assert.equal(await a.evaluate('document.querySelector("#exercise-note").value'), 'Nota B')
  checks.push('due schede concorrenti, confronto completo, scelta locale e online')

  mock.failExerciseReads = true; mock.failExerciseWrites = true
  await a.input('#exercise-note', 'Nota senza rete'); await a.click('.catalog-form button[type=submit]')
  await a.until('document.querySelector(".catalog-actions button")?.textContent === "Verifica online" || [...document.querySelectorAll(".catalog-form button")].some(b=>b.textContent === "Verifica online")')
  assert.equal(await a.evaluate('document.querySelector("#exercise-note").value'), 'Nota senza rete')
  assert.equal(await a.evaluate('document.querySelector(".catalog-close").disabled'), true)
  mock.failExerciseReads = false; mock.failExerciseWrites = false
  await a.click('.catalog-form .catalog-actions .secondary'); await a.until(conflict)
  await a.click('.catalog-conflict .primary'); await a.until(saved)
  checks.push('rete assente: bozza conservata, verifica obbligatoria prima del reinvio')

  await a.input('#exercise-note', 'Bozza da lasciare')
  await a.route('/impostazioni'); await a.until('Boolean(document.querySelector(".account-panel > button:not(:disabled)"))')
  await a.click('.account-panel > button'); await a.until('Boolean(document.querySelector("dialog[open]"))')
  await a.click('.account-actions .secondary'); await a.until('!document.querySelector("dialog")')
  await a.route('/scheda/catalogo'); await a.until(formReady)
  assert.equal(await a.evaluate('document.querySelector("#exercise-note").value'), 'Bozza da lasciare')
  await a.route('/impostazioni'); await a.until('Boolean(document.querySelector(".account-panel > button:not(:disabled)"))')
  await a.click('.account-panel > button'); await a.until('Boolean(document.querySelector("dialog[open]"))')
  await a.click('.account-actions .primary'); await a.until('Boolean(document.querySelector("#login-email"))')
  await a.input('#login-email', 'b@example.invalid'); await a.input('#login-password', fixturePassword); await a.click('.auth-form button')
  await a.until('Boolean(document.querySelector(".account-panel"))')
  await a.route('/scheda/catalogo'); await a.until(listReady)
  await a.click('.catalog-scope button[aria-pressed="false"]')
  assert.equal(await a.evaluate('document.querySelectorAll(".catalog-card").length'), 0)
  assert.equal(await a.evaluate('Boolean(document.querySelector("#exercise-name"))'), false)
  checks.push('logout con bozza, ritorno senza perdita, scarto esplicito e account B separato')

  const sharedId = '33333333-3333-4333-8333-333333333333'
  mock.sharedExercises.set(sharedId, { id: sharedId, name: 'Squat condiviso', variant: '', equipment: 'Bilanciere', load_convention: 'total', load_unit: 'kg', measurement_mode: 'reps', per_side: false, note: '' })
  await a.click('.catalog-scope button:first-child'); await a.click('.catalog-actions .secondary')
  await a.until('document.querySelector(".catalog-card h2")?.textContent === "Squat condiviso"')
  for (const width of [320, 390, 768, 1440]) {
    await a.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 })
    assert.ok(await a.evaluate('document.documentElement.scrollWidth <= innerWidth'), `Overflow catalogo comune ${width}`)
  }
  await a.click('.catalog-card .catalog-actions button'); await a.until('document.querySelector(".catalog-card .catalog-actions")?.textContent.includes("Nei tuoi esercizi")')
  assert.equal([...mock.exercises.values()].filter(row => row.source_template_id === sharedId && row.owner_id === fixtureSession('b').user.id).length, 1)
  assert.equal([...mock.exercises.values()].filter(row => row.source_template_id === sharedId && row.owner_id === fixtureSession('a').user.id).length, 0)
  await a.send('Page.reload'); await a.until(listReady)
  assert.ok(await a.evaluate('document.querySelector(".catalog-card .catalog-actions")?.textContent.includes("Nei tuoi esercizi")'))
  assert.equal([...mock.exercises.values()].filter(row => row.source_template_id === sharedId).length, 1)
  checks.push('catalogo comune visibile, adozione idempotente e copia privata solo per account B')

  mock.failExerciseReads = true; await a.send('Page.reload')
  await a.until('document.querySelector("[role=alert]")?.textContent.includes("caricare gli esercizi")')
  assert.equal(await a.evaluate('Boolean(document.querySelector(".catalog-toolbar"))'), false)
  mock.failExerciseReads = false
  await a.click('.empty-state button'); await a.until(listReady)
  checks.push('errore di lettura distinto da archivio vuoto, riprova riuscita')
  assert.deepEqual(mock.failures, []); assert.deepEqual(errors, [])
  const report = { status: 'passed', mode: 'SDK reale, HTTP simulato; nessuna richiesta al cloud e nessuna prova RLS', checks, date: new Date().toISOString() }
  await writeFile('artifacts/exercises-browser-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { for (const p of pages) await p.close() }
