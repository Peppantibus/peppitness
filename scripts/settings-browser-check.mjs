import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fixturePassword, fixtureSession, fixtureStorageKey, installAuthFixture } from './lib/browser-auth-fixture.mjs'
import { sampleMeals, sampleWorkoutDays, seedFollowedPlans } from './lib/diary-fixture.mjs'

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
    if (response.exceptionDetails) throw new Error('Errore nel test browser preferenze: ' + expression.slice(0, 200))
    return response.result.value
  }
  async function until(expression) {
    for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
    throw new Error(`Condizione non raggiunta: ${expression}`)
  }
  async function input(selector, value) {
    await evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
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
const formReady = 'Boolean(document.querySelector("#display-name")) && !document.querySelector(".preferences-form > fieldset").disabled'
const saved = 'document.querySelector(".preferences-message")?.textContent.includes("salvate online")'
const conflict = 'Boolean(document.querySelector(".preferences-conflict"))'
try {
  await mkdir('artifacts', { recursive: true })
  const a = await page()
  for (const account of ['a', 'b']) seedFollowedPlans(mock, fixtureSession(account).user.id, { workoutDays: sampleWorkoutDays, meals: sampleMeals })
  const seed = await a.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear(); localStorage.setItem(${JSON.stringify(fixtureStorageKey)},${JSON.stringify(JSON.stringify(fixtureSession()))});` })
  await a.send('Page.navigate', { url: `${baseUrl}/#/impostazioni` }); await a.until(formReady)
  await a.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seed.identifier })
  assert.equal(mock.settings.size, 0)
  assert.equal(await a.evaluate('document.querySelector("#display-name").value'), '')
  assert.equal(mock.requests.some(path => path.startsWith('POST /rest') && path !== 'POST /rest/v1/rpc/is_mfa_satisfied'), false)
  checks.push('account vuoto senza scrittura automatica')
  await a.input('#display-name', 'Preferenze fixture A')
  await a.click('.weekday-options input[value="1"]')
  await a.click('.weekday-options input[value="5"]')
  await a.route('/scheda'); await a.until('Boolean(document.querySelector(".workout-overview"))')
  await a.route('/impostazioni'); await a.until(formReady)
  assert.equal(await a.evaluate('document.querySelector("#display-name").value'), 'Preferenze fixture A')
  checks.push('bozza conservata nella navigazione')
  for (const width of [320, 390, 768, 1440]) {
    await a.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 })
    assert.ok(await a.evaluate('document.documentElement.scrollWidth <= innerWidth'), `Overflow ${width}`)
  }
  await a.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  const screenshot = await a.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  await writeFile('artifacts/settings-mobile.png', Buffer.from(screenshot.data, 'base64'))
  checks.push('modulo a quattro larghezze senza overflow')
  await a.input('#time-zone', 'Unknown/Zone'); await a.click('.preferences-form .button-row > button')
  await a.until('document.querySelector(".preferences-message")?.textContent.includes("fuso orario valido")')
  assert.equal(mock.settings.size, 0)
  await a.input('#time-zone', 'Europe/Rome'); await a.click('.preferences-form .button-row > button'); await a.until(saved)
  await a.send('Page.reload'); await a.until(formReady)
  assert.equal(await a.evaluate('document.querySelector("#display-name").value'), 'Preferenze fixture A')
  assert.equal(await a.evaluate('document.querySelectorAll(".weekday-options input:checked").length'), 2)
  checks.push('validazione, primo salvataggio e rilettura dopo reload')

  const b = await page()
  await b.send('Page.navigate', { url: `${baseUrl}/#/impostazioni` }); await b.until(formReady)
  assert.equal(await b.evaluate('document.querySelector("#display-name").value'), 'Preferenze fixture A')
  await a.input('#display-name', 'Prima scheda'); await a.click('.preferences-form .button-row > button'); await a.until(saved)
  await b.input('#display-name', 'Seconda scheda'); await b.click('.preferences-form .button-row > button'); await b.until(conflict)
  assert.ok(await b.evaluate('document.querySelector(".preferences-conflict").textContent.includes("Prima scheda")'))
  assert.equal(await b.evaluate('document.querySelector("#display-name").value'), 'Seconda scheda')
  await b.click('.preferences-actions .primary'); await b.until(saved)
  await a.input('#display-name', 'Bozza da scartare'); await a.click('.preferences-form .button-row > button'); await a.until(conflict)
  await a.click('.preferences-actions .secondary'); await a.until('!document.querySelector(".preferences-conflict")')
  assert.equal(await a.evaluate('document.querySelector("#display-name").value'), 'Seconda scheda')
  checks.push('due schede: conflitto, scelta locale e scelta online')

  mock.loseSettingsResponse = true
  await a.input('#display-name', 'Risposta persa'); await a.click('.preferences-form .button-row > button'); await a.until(saved)
  assert.ok(await a.evaluate('document.querySelector(".preferences-message").textContent.includes("conferma recuperata")'))
  checks.push('commit riuscito con risposta persa recuperato tramite lettura')
  mock.failSettingsReads = true; mock.failSettingsWrites = true
  await a.input('#display-name', 'Bozza senza rete'); await a.click('.preferences-form .button-row > button')
  await a.until('document.querySelector(".preferences-form .button-row > button")?.textContent === "Verifica online"')
  assert.equal(await a.evaluate('document.querySelector("#display-name").value'), 'Bozza senza rete')
  assert.equal(mock.settings.get(fixtureSession().user.id).display_name, 'Risposta persa')
  mock.failSettingsReads = false; mock.failSettingsWrites = false
  await a.click('.preferences-form .button-row > button'); await a.until(conflict)
  await a.click('.preferences-actions .primary'); await a.until(saved)
  checks.push('rete assente: bozza conservata e verifica obbligatoria prima del nuovo invio')

  const dateIn = zone => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  const zone = ['Pacific/Honolulu', 'Pacific/Kiritimati'].find(value => dateIn(value) !== dateIn('Europe/Rome'))
  assert.ok(zone)
  await a.input('#time-zone', zone); await a.click('.preferences-form .button-row > button'); await a.until(saved)
  await a.route('/scheda'); await a.until('Boolean(document.querySelector("input[type=date]"))')
  assert.equal(await a.evaluate('document.querySelector("input[type=date]").value'), dateIn(zone))
  await a.input('input[type=date]', '2001-05-15')
  await a.route('/impostazioni'); await a.until(formReady)
  await a.input('#time-zone', 'Europe/Rome'); await a.click('.preferences-form .button-row > button'); await a.until(saved)
  await a.route('/scheda'); await a.until('Boolean(document.querySelector("input[type=date]"))')
  assert.equal(await a.evaluate('document.querySelector("input[type=date]").value'), '2001-05-15')
  await a.route('/impostazioni'); await a.until(formReady)
  checks.push('fuso applicato a oggi, data storica selezionata conservata')

  await a.input('#display-name', 'Modifica non salvata')
  await a.click('.account-panel > button'); await a.until('Boolean(document.querySelector("dialog[open]"))')
  await a.click('.account-actions .secondary'); await a.until('!document.querySelector("dialog")')
  assert.equal(await a.evaluate('document.querySelector("#display-name").value'), 'Modifica non salvata')
  await a.click('.account-panel > button'); await a.until('Boolean(document.querySelector("dialog[open]"))')
  await a.click('.account-actions .danger'); await a.until('Boolean(document.querySelector("#login-email"))')
  await a.input('#login-email', 'b@example.invalid'); await a.input('#login-password', fixturePassword); await a.click('.auth-form button')
  await a.until(formReady)
  assert.equal(await a.evaluate('document.querySelector("#display-name").value'), '')
  assert.equal(await a.evaluate('document.querySelectorAll(".weekday-options input:checked").length'), 0)
  checks.push('logout con bozza e account B senza preferenze di A')
  mock.failSettingsReads = true
  await a.send('Page.reload')
  await a.until('document.querySelector(".preferences-panel [role=alert]")?.textContent.includes("caricare")')
  assert.equal(await a.evaluate('Boolean(document.querySelector("#display-name"))'), false)
  mock.failSettingsReads = false
  await a.click('.preferences-panel > button'); await a.until(formReady)
  checks.push('errore iniziale con riprova, senza form falsamente vuoto')
  assert.deepEqual(mock.failures, [])
  assert.deepEqual(errors, [])
  const report = { status: 'passed', mode: 'SDK reale, HTTP simulato; nessuna richiesta al cloud e nessuna prova RLS', checks, date: new Date().toISOString() }
  await writeFile('artifacts/settings-browser-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally { for (const p of pages) await p.close() }
