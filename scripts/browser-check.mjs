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
  // Il tipo di giornata precede i pasti che determina.
  assert.ok(await evaluate(`Boolean(document.querySelector('.day-type').compareDocumentPosition(document.querySelector('.meal-list')) & Node.DOCUMENT_POSITION_FOLLOWING)`), 'Tipo di giornata prima dei pasti')
  await screenshot('desktop-dieta')

  for (const width of [320, 390, 768, 1440]) {
    await viewport(width, 844, width < 720)
    assert.ok(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), `Dieta: overflow a ${width}px`)
    if (width === 320) await screenshot('mobile-320-dieta')
  }
  await viewport(390, 844, true)
  await screenshot('mobile-dieta')
  assert.ok(await evaluate(`document.querySelector('.meal-card').getBoundingClientRect().top < 844 - 70`), 'Primo pasto visibile senza scorrere')
  // Stato del salvataggio: icona compatta con dettagli su richiesta.
  await click('.topbar .sync-indicator')
  await until(`Boolean(document.querySelector('dialog[open] .sync-details'))`)
  await click('dialog[open] .sync-details .secondary')
  await until(`!document.querySelector('dialog')`)
  assert.ok(await evaluate(`!/demo|dimostrativ|anteprima/i.test(document.body.innerText)`))

  // Registrazione rapida: un tocco segna «Seguito», l'avviso permette di annullare.
  assert.equal(await evaluate(`document.querySelector('.meal-quick').getAttribute('aria-pressed')`), 'false')
  await click('.meal-quick')
  await until(`document.querySelector('.meal-quick').getAttribute('aria-pressed') === 'true'`)
  assert.equal(await evaluate(`document.querySelector('.meal-card .status').textContent`), 'Seguito')
  assert.ok(await evaluate(`document.querySelector('.quick-toast').textContent.includes('seguito')`))
  await screenshot('mobile-dieta-rapida')
  await click('.quick-toast .toast-action')
  await until(`!document.querySelector('.quick-toast') && document.querySelector('.meal-quick').getAttribute('aria-pressed') === 'false'`)
  assert.equal(await evaluate(`document.querySelector('.meal-card .status')`), null, 'Annulla ripristina lo stato precedente')

  // Dettaglio, modifica, ritorno alla pagina e isolamento tra date.
  await click('.meal-card-link')
  await until(`Boolean(document.querySelector('dialog[open]'))`)
  assert.equal(await evaluate(`document.querySelector('dialog button[type="submit"]').disabled`), true, 'Salva attivo solo dopo la scelta')
  assert.equal(await evaluate(`document.querySelectorAll('dialog input[name="meal-status"]').length`), 3)
  await click('input[value="modified"]')
  await until(`document.activeElement?.id === 'meal-note'`)
  await screenshot('mobile-pasto')
  await setInput('#meal-note', 'Nota dimostrativa: alternativa scelta.', 'HTMLTextAreaElement')
  await click('dialog button[type="submit"]')
  await until(`!document.querySelector('dialog')`)
  assert.equal(await evaluate(`document.querySelector('.meal-card .status').textContent`), 'Modificato')
  assert.equal(await evaluate(`Boolean(document.querySelector('.meal-card .meal-quick.is-static'))`), true, 'Pasto modificato: niente spunta rapida')
  await click('.meal-card-link')
  assert.equal(await evaluate(`document.querySelector('#meal-note').value`), 'Nota dimostrativa: alternativa scelta.')
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await until(`!document.querySelector('dialog')`)
  const originalDate = await evaluate(`document.querySelector('input[type="date"]').value`)
  await setInput('input[type="date"]', '2025-01-17')
  await until(`document.querySelector('.past-notice')?.textContent.includes('passata')`)
  assert.equal(await evaluate(`document.querySelector('.meal-card .status')`), null)
  await click('.meal-card-link')
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
    if (width === 320) await screenshot('mobile-320-scheda')
    if (width === 1440) await screenshot('desktop-scheda')
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
  // Stessa seduta e stessa data: la card è «in corso», senza banner doppione.
  assert.equal(await evaluate(`Boolean(document.querySelector('.resume-banner'))`), false, 'Nessun banner se la seduta in corso è quella mostrata')
  assert.ok(await evaluate(`document.querySelector('.workout-kicker').textContent.startsWith('In corso')`))
  assert.ok(await evaluate(`document.querySelector('.workout-live-progress').textContent.includes('1 di 11 serie')`))
  assert.equal(await evaluate(`document.querySelector('.workout-start').textContent`), 'Riprendi allenamento')
  await screenshot('mobile-scheda-in-corso')
  // Altra data: il banner resta e il pulsante della card nomina la seduta aperta.
  await setInput('input[type="date"]', '2025-01-18')
  await until(`Boolean(document.querySelector('.resume-banner'))`)
  assert.ok(await evaluate(`document.querySelector('.workout-start').classList.contains('secondary') && document.querySelector('.workout-start').textContent.includes('(in corso)')`))
  assert.ok(await evaluate(`Boolean(document.querySelector('.workout-blocked'))`))
  await screenshot('mobile-scheda-altra-seduta')
  await click('.resume-banner')
  assert.equal(await evaluate(`document.querySelector('.set-grid input').value`), '12,5')
  await screenshot('mobile-seduta')
  await evaluate(`window.scrollTo(0, 0)`)
  if (await evaluate(`Boolean(document.querySelector('.rest-timer'))`)) {
    // Durante il recupero «Termina» non è fissa: in fondo alla seduta, raggiungibile e mai sotto il timer.
    await evaluate(`window.scrollTo(0, document.body.scrollHeight)`)
    assert.ok(await evaluate(`document.querySelector('.session-actions').getBoundingClientRect().bottom <= document.querySelector('.rest-timer').getBoundingClientRect().top`), '«Termina» raggiungibile sopra il timer')
    await evaluate(`window.scrollTo(0, 0)`)
  } else assert.ok(await evaluate(`document.querySelector('.session-actions').getBoundingClientRect().bottom <= window.innerHeight + 1`), '«Termina» visibile senza scorrere')
  assert.equal(await evaluate(`Boolean(document.querySelector('.comparison-tabs, .session-letter'))`), false, 'Niente schede né lettera della seduta')
  await click('.session-actions .primary')
  await until(`Boolean(document.querySelector('dialog[open] .session-finish-confirm'))`)
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('serie previste')`), 'Conferma se mancano serie')
  await click('dialog[open] .session-finish-confirm')
  // Riepilogo di fine seduta sopra lo storico: prima volta per questa seduta, nessun confronto.
  await until(`Boolean(document.querySelector('dialog[open] .session-summary'))`)
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('Allenamento completato') && document.querySelector('dialog[open]').textContent.includes('Prima volta per questa seduta')`), 'Riepilogo della prima seduta')
  await pause(350)
  await screenshot('mobile-riepilogo-prima')
  await click('dialog[open] .session-summary-close')
  await until(`!document.querySelector('dialog[open]')`)
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
  assert.ok(await evaluate(`document.querySelector('.session-switch button[aria-pressed="true"]').getAttribute('aria-label').includes('suggerita')`))
  assert.ok(await evaluate(`document.querySelector('.session-switch button[aria-pressed="true"]').getAttribute('aria-label').includes('Full body B')`))
  assert.ok(await evaluate(`document.querySelector('.workout-kicker').textContent.includes('suggerita')`))
  await click('.session-switch button:first-child')
  await click('.workout-summary .primary')
  await until(`document.querySelector('.previous-inline')?.textContent.includes('12,5 kg')`)
  assert.equal(await evaluate(`document.querySelector('.set-grid input').value`), '')
  assert.equal(await evaluate(`document.querySelector('.set-grid input:nth-of-type(2)').value`), '')
  await click('.reuse-loads')
  assert.equal(await evaluate(`document.querySelector('.set-grid input').value`), '12,5')
  assert.equal(await evaluate(`document.querySelector('.set-grid input:nth-of-type(2)').value`), '')
  assert.equal(await evaluate(`document.querySelector('.set-check').getAttribute('aria-pressed')`), 'false')
  await click('.history-peek')
  await until(`Boolean(document.querySelector('dialog[open] .previous-results'))`)
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('12,5 kg')`))
  await pause(350)
  assert.ok(await evaluate(`document.querySelector('dialog[open]').getBoundingClientRect().bottom <= window.innerHeight + 1`), 'Pannello dal basso interamente visibile')
  await screenshot('mobile-precedente')
  await click('dialog[open] .dialog-close')
  await until(`!document.querySelector('dialog')`)

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
  await click('.workout-start')
  await evaluate(`window.originalNow = Date.now; Date.now = () => window.originalNow() + 120000`)
  await until(`Boolean(document.querySelector('.rest-ended'))`)
  assert.ok(await evaluate(`document.querySelector('.timer-label').textContent.includes('terminato')`))
  await click('[aria-label="Chiudi recupero"]')
  await evaluate(`Date.now = window.originalNow`)
  assert.equal(await evaluate(`document.querySelector('.set-check').getAttribute('aria-pressed')`), 'true')
  for (const row of [3, 4]) {
    const base = `.session-cards > .set-panel:first-child .set-row:nth-child(${row})`
    await setInput(`${base} input:nth-of-type(1)`, '12,5')
    await setInput(`${base} input:nth-of-type(2)`, '10')
    await click(`${base} .set-check`)
  }
  await until(`document.querySelector('.session-cards > .set-panel:first-child').classList.contains('is-collapsed')`)
  assert.ok(await evaluate(`document.querySelector('.set-summary').textContent.includes('12,5 kg')`), 'Riepilogo dell\'esercizio completato')
  await screenshot('mobile-seduta-ridotta')
  await click('.set-summary')
  await until(`!document.querySelector('.session-cards > .set-panel:first-child').classList.contains('is-collapsed')`)
  await click('.set-collapse')
  await until(`document.querySelector('.session-cards > .set-panel:first-child').classList.contains('is-collapsed')`)
  if (await evaluate(`Boolean(document.querySelector('.rest-timer'))`)) await click('.timer-dismiss')
  // Serie compilata ma senza spunta: la fine seduta propone di segnarla; una serie senza risultato resta vuota.
  const secondExercise = '.session-cards > .set-panel:nth-child(2)'
  await setInput(`${secondExercise} .set-row:nth-child(2) input:nth-of-type(1)`, '20')
  await setInput(`${secondExercise} .set-row:nth-child(2) input:nth-of-type(2)`, '8')
  await setInput(`${secondExercise} .set-row:nth-child(3) input:nth-of-type(1)`, '20')
  await click('.session-actions .primary')
  await until(`Boolean(document.querySelector('dialog[open] .session-mark-complete'))`)
  assert.equal(await evaluate(`document.querySelector('dialog[open] .session-mark-complete').textContent`), 'Segna la serie compilata e termina', 'Solo la serie con risultato valido')
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('vuote e resteranno non completate')`), 'Le serie vuote restano non completate')
  await screenshot('mobile-fine-seduta')
  await click('dialog[open] .session-mark-complete')
  await until(`Boolean(document.querySelector('dialog[open] .session-summary'))`)
  assert.ok(await evaluate(`document.querySelector('dialog[open]').textContent.includes('volta scorsa')`), 'Riepilogo con il confronto alla seduta precedente')
  await pause(350)
  await screenshot('mobile-riepilogo')
  await click('dialog[open] .session-summary-close')
  await until(`!document.querySelector('dialog[open]')`)
  await until(`document.querySelectorAll('.history-card').length === 2`)
  assert.equal(await evaluate(`Boolean(document.querySelector('.rest-timer'))`), false, 'Nessun timer dopo le spunte in blocco')

  await route('/impostazioni')
  assert.ok(await evaluate(`document.querySelector('main').textContent.includes('Preferenze')`))
  assert.equal(await evaluate(`document.querySelectorAll('.bottom-nav a[aria-current]').length`), 0, 'Impostazioni: nessuna tab evidenziata')
  assert.equal(await evaluate(`document.querySelector('main .subpage-back').getAttribute('href')`), '#/scheda', 'Ritorno alla sezione di provenienza')
  assert.ok(await evaluate(`!/demo|dimostrativ|anteprima/i.test(document.body.innerText)`))
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await until(`document.querySelector('main').textContent.includes('Rete assente')`)
  await route('/dieta')
  assert.equal(await evaluate(`document.querySelectorAll('.meal-card').length`), 4)
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })

  // Sincronizzazione: pasti, giornate, sedute e serie arrivano al server simulato.
  await route('/dieta')
  await until(`document.querySelector('.sync-indicator')?.dataset.sync === 'synced'`)
  const diary = authFixture.diary
  assert.equal(diary.meal_logs.length, 2, 'Due pasti registrati online')
  assert.equal(diary.workout_sessions.filter(row => row.status === 'completed').length, 2, 'Due sedute completate online')
  assert.ok(diary.workout_set_logs.some(row => row.load === 12.5 && row.amount === 10 && row.completed), 'Serie 12,5 × 10 salvata con valori numerici')
  assert.ok(diary.workout_set_logs.some(row => row.load === 20 && row.amount === 8 && row.completed), 'Serie compilata segnata come fatta a fine seduta')
  assert.ok(!diary.workout_set_logs.some(row => row.load === 20 && row.amount === null && row.completed), 'Serie senza risultato mai segnata come fatta')
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
