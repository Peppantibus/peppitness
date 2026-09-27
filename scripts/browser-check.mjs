// Smoke test browser senza dipendenze aggiuntive: Chrome DevTools Protocol.
// Richiede preview su 127.0.0.1:4173 e Chrome di test con debugging su 9223.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fixtureSession, fixtureStorageKey, fixtureSupabaseOrigin, installAuthFixture } from './lib/browser-auth-fixture.mjs'
import { sampleMeals, sampleWorkoutDays, seedFollowedPlans } from './lib/diary-fixture.mjs'

const baseUrl = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:4173'
const debugUrl = process.env.TEST_DEBUG_URL ?? 'http://127.0.0.1:9223'
const target = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let sequence = 0
const pending = new Map()
const errors = []
const requests = []
const browserDialogs = []
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject, timeout } = pending.get(message.id)
    clearTimeout(timeout)
    pending.delete(message.id)
    if (message.error) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text)
  if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
  if (message.method === 'Page.javascriptDialogOpening') {
    browserDialogs.push(message.params.type)
    void send('Page.handleJavaScriptDialog', { accept: true })
  }
})
function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }, 10000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(expression) {
  for (let i = 0; i < 80; i++) { if (await evaluate(expression)) return; await pause(50) }
  throw new Error(`Condizione non raggiunta: ${expression}`)
}
async function route(path) { await evaluate(`window.location.hash = ${JSON.stringify(path)}`); await pause(120) }
async function click(selector) {
  const point = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Elemento assente: ' + ${JSON.stringify(selector)}); element.scrollIntoView({block:'center'}); const rect = element.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}; })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await pause(100)
}
async function setInput(selector, value, tag = 'HTMLInputElement') {
  await evaluate(`(() => {const element = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(${tag}.prototype, 'value').set.call(element, ${JSON.stringify(value)}); element.dispatchEvent(new Event('input', {bubbles:true})); element.dispatchEvent(new Event('change', {bubbles:true})); })()`)
  await pause(80)
}
async function viewport(width, height, mobile = false) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  await pause(120)
}
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(`artifacts/${name}.png`, Buffer.from(result.data, 'base64'))
}

try {
  await mkdir('artifacts', { recursive: true })
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  await send('Storage.clearDataForOrigin', { origin: new URL(baseUrl).origin, storageTypes: 'local_storage,indexeddb' })
  const authFixture = await installAuthFixture(send, socket, new URL(baseUrl).origin)
  // Account sintetico con programma e piano alimentare già seguiti (API simulate).
  seedFollowedPlans(authFixture, fixtureSession().user.id, { workoutDays: sampleWorkoutDays, meals: sampleMeals })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem(${JSON.stringify(fixtureStorageKey)}, ${JSON.stringify(JSON.stringify(fixtureSession()))})` })
  await viewport(1440, 1150)
  await send('Page.navigate', { url: baseUrl })
  await until(`document.querySelectorAll('.meal-card').length === 4`)
  assert.equal(await evaluate(`document.documentElement.lang`), 'it')
  await screenshot('desktop-dieta')

  for (const width of [320, 390, 768, 1440]) {
    await viewport(width, 844, width < 720)
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), `Dieta: overflow a ${width}px`)
  }
  await viewport(390, 844, true)
  await screenshot('mobile-dieta')
  assert.ok(await evaluate(`!/demo|dimostrativ|anteprima/i.test(document.body.innerText)`))

  // Dettaglio, modifica, ritorno alla pagina e isolamento tra date.
  await click('.meal-card')
  await until(`Boolean(document.querySelector('dialog[open]'))`)
  await click('input[value="modified"]')
  await setInput('#meal-note', 'Nota dimostrativa: alternativa scelta.', 'HTMLTextAreaElement')
  await click('dialog button[type="submit"]')
  await until(`!document.querySelector('dialog')`)
  assert.equal(await evaluate(`document.querySelector('.meal-card .status').textContent`), 'Modificato')
  await click('.meal-card')
  assert.equal(await evaluate(`document.querySelector('#meal-note').value`), 'Nota dimostrativa: alternativa scelta.')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until(`!document.querySelector('dialog')`)
  const originalDate = await evaluate(`document.querySelector('input[type="date"]').value`)
  await setInput('input[type="date"]', '2025-01-17')
  await until(`document.querySelector('.past-notice')?.textContent.includes('passata')`)
  assert.equal(await evaluate(`document.querySelector('.meal-card .status')`), null)
  await click('.meal-card')
  await click('input[value="followed"]')
  await click('dialog button[type="submit"]')
  await setInput('input[type="date"]', originalDate)
  assert.equal(await evaluate(`document.querySelector('.meal-card .status').textContent`), 'Modificato')
  await route('/dieta/storico')
  assert.equal(await evaluate(`document.querySelectorAll('.history-card').length`), 2)

  // Seduta, validazione, ripresa cambiando data e dettaglio storico.
  await route('/scheda')
  await screenshot('mobile-scheda')
  for (const width of [320, 390, 768, 1440]) {
    await viewport(width, 844, width < 720)
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), `Scheda: overflow a ${width}px`)
  }
  await viewport(390, 844, true)
  await route('/scheda/progressi')
  assert.ok(await evaluate(`Boolean(document.querySelector('.cycle-card h2'))`))
  assert.equal(await evaluate(`document.querySelectorAll('.progress-tiles .progress-tile').length`), 2)
  assert.equal(await evaluate(`document.querySelectorAll('.progress-section > .week-rows li').length`), 1)
  for (const width of [320, 390, 768, 1440]) {
    await viewport(width, 844, width < 720)
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), `Progressi: overflow a ${width}px`)
  }
  await viewport(390, 844, true)
  await screenshot('mobile-progressi')
  await click('.progress-week-history summary')
  assert.ok(await evaluate(`document.querySelector('.progress-week-history').open`))
  await route('/scheda')
  await click('.exercise-card')
  assert.ok(await evaluate(`document.querySelector('dialog').textContent.includes('Goblet squat')`))
  await click('.dialog-close')
  await click('.workout-summary .primary')
  await until(`Boolean(document.querySelector('.session-page'))`)
  await click('.set-check')
  assert.ok(await evaluate(`document.querySelector('[role="alert"]').textContent.includes('Inserisci il risultato')`))
  await setInput('.set-grid input', '12,5')
  await setInput('.set-grid input:nth-of-type(2)', '10')
  await click('.set-check')
  assert.equal(await evaluate(`document.querySelector('.set-check').getAttribute('aria-pressed')`), 'true')
  await route('/scheda')
  await setInput('input[type="date"]', '2025-01-18')
  await click('.resume-banner')
  assert.equal(await evaluate(`document.querySelector('.set-grid input').value`), '12,5')
  await screenshot('mobile-seduta')
  await click('.session-actions .primary')
  await until(`document.querySelectorAll('.history-card').length === 1`)
  await click('.history-card')
  assert.equal(await evaluate(`document.querySelector('.set-grid input').readOnly`), true)
  assert.ok(await evaluate(`document.querySelector('.session-progress').textContent.includes('1 di 11 serie')`))

  // La settimana seguente deve mostrare il carico effettivamente registrato.
  await route('/scheda')
  const nextWeek = new Date(originalDate + 'T12:00:00Z')
  nextWeek.setUTCDate(nextWeek.getUTCDate() + 7)
  await setInput('input[type="date"]', nextWeek.toISOString().slice(0, 10))
  // Dopo la A la scheda suggerisce la B, senza sceglierla da sola: si torna alla A a mano.
  assert.ok(await evaluate(`document.querySelector('.workout-day-tabs button[aria-pressed="true"]').textContent.includes('Suggerita')`))
  assert.ok(await evaluate(`document.querySelector('.workout-day-tabs button[aria-pressed="true"]').textContent.includes('Full body B')`))
  await click('.workout-day-tabs button:first-child')
  await click('.workout-summary .primary')
  await until(`document.querySelector('.previous-inline')?.textContent.includes('12,5 kg')`)
  assert.equal(await evaluate(`document.querySelector('.set-grid input').value`), '')
  assert.equal(await evaluate(`document.querySelector('.set-grid input:nth-of-type(2)').value`), '')
  await click('.reuse-loads')
  assert.equal(await evaluate(`document.querySelector('.set-grid input').value`), '12,5')
  assert.equal(await evaluate(`document.querySelector('.set-grid input:nth-of-type(2)').value`), '')
  assert.equal(await evaluate(`document.querySelector('.set-check').getAttribute('aria-pressed')`), 'false')
  await click('.comparison-tabs button:nth-child(2)')
  await until(`Math.abs(document.querySelector('.comparison-viewport').scrollLeft - document.querySelector('.comparison-viewport').clientWidth) < 1`)
  await screenshot('mobile-precedente')
  assert.ok(await evaluate(`document.querySelector('.previous-panel').textContent.includes('12,5 kg')`))
  await click('.comparison-tabs button:first-child')
  await until(`document.querySelector('.comparison-viewport').scrollLeft === 0`)

  // Gesto touch reale: scorrere a sinistra apre la card precedente.
  await send('Emulation.setTouchEmulationEnabled', { enabled: true })
  const swipe = await evaluate(`(() => { const el = document.querySelector('.set-header'); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x:r.right-18, y:r.top+12}; })()`)
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [swipe] })
  for (let step = 1; step <= 8; step++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: swipe.x - step * 27, y: swipe.y }] })
    await pause(25)
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await until(`document.querySelector('.comparison-tabs button:nth-child(2)').getAttribute('aria-selected') === 'true'`)
  await until(`Math.abs(document.querySelector('.comparison-viewport').scrollLeft - document.querySelector('.comparison-viewport').clientWidth) < 1`)
  await click('.comparison-tabs button:first-child')
  await until(`document.querySelector('.comparison-viewport').scrollLeft === 0`)
  await send('Emulation.setTouchEmulationEnabled', { enabled: false })

  // Timer, incremento, pausa, ripresa e scadenza dopo un salto dell'orologio.
  await setInput('.set-grid input:nth-of-type(2)', '11')
  await click('.set-check')
  await until(`Boolean(document.querySelector('.rest-timer'))`)
  await screenshot('mobile-recupero')
  assert.ok(await evaluate(`document.querySelector('.timer-count').textContent.startsWith('01:')`))
  await click('[aria-label="Pausa recupero"]')
  const pausedCount = await evaluate(`document.querySelector('.timer-count').textContent`)
  await pause(1100)
  assert.equal(await evaluate(`document.querySelector('.timer-count').textContent`), pausedCount)
  await click('.timer-extra')
  assert.notEqual(await evaluate(`document.querySelector('.timer-count').textContent`), pausedCount)
  await click('[aria-label="Riprendi recupero"]')
  for (const width of [320, 390, 768, 1440]) {
    await viewport(width, 844, width < 720)
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), `Seduta: overflow a ${width}px`)
  }
  await viewport(1440, 1000)
  await evaluate(`window.scrollTo(0,0)`)
  await screenshot('desktop-seduta')
  await viewport(390, 844, true)
  await route('/scheda')
  assert.ok(await evaluate(`Boolean(document.querySelector('.rest-timer'))`))
  await click('.resume-banner')
  await evaluate(`window.originalNow = Date.now; Date.now = () => window.originalNow() + 120000`)
  await until(`document.querySelector('.timer-count').textContent === '00:00'`)
  assert.ok(await evaluate(`document.querySelector('.timer-label').textContent.includes('terminato')`))
  await click('[aria-label="Chiudi recupero"]')
  await evaluate(`Date.now = window.originalNow`)
  assert.equal(await evaluate(`document.querySelector('.set-check').getAttribute('aria-pressed')`), 'true')
  await click('.session-actions .primary')
  assert.equal(await evaluate(`document.querySelectorAll('.history-card').length`), 2)

  await route('/impostazioni')
  assert.ok(await evaluate(`document.querySelector('main').textContent.includes('Preferenze')`))
  assert.ok(await evaluate(`!/demo|dimostrativ|anteprima/i.test(document.body.innerText)`))
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await until(`document.querySelector('main').textContent.includes('Rete assente')`)
  await route('/dieta')
  assert.equal(await evaluate(`document.querySelectorAll('.meal-card').length`), 4)
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })

  // Sincronizzazione: pasti, giornate, sedute e serie arrivano al server simulato.
  await route('/dieta')
  await until(`document.querySelector('.quiet-note')?.textContent.includes('Sincronizzato')`)
  const diary = authFixture.diary
  assert.equal(diary.meal_logs.length, 2, 'Due pasti registrati online')
  assert.equal(diary.workout_sessions.filter(row => row.status === 'completed').length, 2, 'Due sedute completate online')
  assert.ok(diary.workout_set_logs.some(row => row.load === 12.5 && row.amount === 10 && row.completed), 'Serie 12,5 × 10 salvata con valori numerici')
  assert.equal(new Set(diary.workout_set_logs.map(row => `${row.session_id}:${row.prescription_id}:${row.set_index}`)).size, diary.workout_set_logs.length, 'Nessuna serie duplicata')

  // Ricaricamento: il diario persiste; niente dati inventati o reset silenzioso.
  await send('Page.reload')
  await until(`document.querySelector('.meal-card .status')?.textContent === 'Modificato'`)
  await route('/scheda/storico')
  await until(`document.querySelectorAll('.history-card').length === 2`)
  await click('.history-card')
  await click('.session-correct')
  assert.equal(await evaluate(`document.querySelector('.set-grid input').readOnly`), false, 'Storico correggibile su richiesta')
  assert.deepEqual(errors, [], 'Errori console')
  const external = requests.filter(url => /^https?:/.test(url) && !url.startsWith(new URL(baseUrl).origin + '/'))
  assert.deepEqual(authFixture.failures, [], 'Nessuna richiesta inattesa nel mock')
  assert.ok(external.every(value => new URL(value).origin === fixtureSupabaseOrigin), 'Solo richieste Supabase intercettate dal mock')
  assert.ok(authFixture.requests.every(request => !/^(POST|PATCH|DELETE) \/rest\/v1\/(user_settings|exercises|workout_plans)/.test(request)), 'Nessuna scrittura su preferenze, catalogo o programmi durante la regressione UI')
  const report = { status: 'passed', widths: [320, 390, 768, 1440], runtimeErrors: errors, mockedApiRequests: authFixture.requests, mode: 'Richieste API intercettate, nessun contatto col cloud', reloadDialogs: browserDialogs, checks: ['navigazione', 'dialog e Escape', 'stati pasti e note', 'isolamento date', 'storico pasti', 'validazione serie', 'ripresa seduta', 'storico sedute', 'precedente dopo una settimana', 'copia solo carichi', 'swipe touch precedente', 'timer pausa/ripresa/incremento/scadenza', 'offline nella pagina già aperta', 'sincronizzazione diario', 'persistenza al reload', 'storico correggibile'], date: new Date().toISOString() }
  await writeFile('artifacts/browser-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  socket.close()
  await fetch(`${debugUrl}/json/close/${target.id}`).catch(() => undefined)
}
