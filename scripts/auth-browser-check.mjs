import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fixturePassword, fixtureSession, fixtureStorageKey, installAuthFixture } from './lib/browser-auth-fixture.mjs'
import { sampleMeals, sampleWorkoutDays, seedFollowedPlans } from './lib/diary-fixture.mjs'

const baseUrl = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:4173'
const debugUrl = process.env.TEST_DEBUG_URL ?? 'http://127.0.0.1:9223'
const target = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let sequence = 0
const pending = new Map(), runtimeErrors = []
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  if (pending.has(message.id)) {
    const task = pending.get(message.id); pending.delete(message.id); clearTimeout(task.timeout)
    if (message.error) task.reject(new Error(`CDP ${message.error.code}`)); else task.resolve(message.result)
  }
  if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.text)
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
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error('Errore JavaScript nel test browser')
  return result.result.value
}
async function until(expression) {
  for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error(`Condizione non raggiunta: ${expression}`)
}
async function input(selector, value) {
  await evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true})); })()`)
}
async function click(selector) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`) }
async function route(path) { await evaluate(`location.hash=${JSON.stringify(path)}`) }
async function login(account, password = fixturePassword) {
  await input('#login-email', `${account}@example.invalid`)
  await input('#login-password', password)
  await click('.auth-form button')
}

try {
  await mkdir('artifacts', { recursive: true })
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  const mock = await installAuthFixture(send, socket, baseUrl)
  for (const account of ['a', 'b']) seedFollowedPlans(mock, fixtureSession(account).user.id, { workoutDays: sampleWorkoutDays, meals: sampleMeals })
  const clearOnFirstLoad = await send('Page.addScriptToEvaluateOnNewDocument', { source: 'localStorage.clear()' })
  await send('Page.navigate', { url: baseUrl })
  await until('document.readyState === "complete"')
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: clearOnFirstLoad.identifier })
  await send('Page.reload')
  await until('Boolean(document.querySelector("#login-email"))')
  assert.equal(await evaluate('Boolean(document.querySelector(".meal-card"))'), false)
  for (const width of [320, 390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 })
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `Login overflow ${width}`)
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  const screen = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile('artifacts/auth-login-mobile.png', Buffer.from(screen.data, 'base64'))
  await login('a', 'wrong-fixture')
  await until('document.querySelector("[role=alert]")?.textContent.includes("non corrette")')
  assert.equal(await evaluate('document.querySelector("#login-password").value'), '')
  await login('a')
  await until('document.querySelectorAll(".meal-card").length === 4')
  await send('Page.reload')
  await until('document.querySelectorAll(".meal-card").length === 4')
  assert.equal(mock.requests.filter(path => path === 'POST /auth/v1/token').length, 2, 'Reload riusa la sessione')

  // Scadenza sintetica: l’SDK deve rinnovare prima di ripristinare l’app.
  const expired = fixtureSession(); expired.expires_at = Math.floor(Date.now() / 1000) - 30
  await evaluate(`localStorage.setItem(${JSON.stringify(fixtureStorageKey)},${JSON.stringify(JSON.stringify(expired))})`)
  await send('Page.reload')
  await until('document.querySelectorAll(".meal-card").length === 4')
  // Almeno un rinnovo dopo la scadenza. La pagina ancora aperta prima del reload può
  // rinnovare una volta in più se il diario legge la sessione appena alterata dal test.
  const renewals = mock.requests.filter(path => path === 'POST /auth/v1/token').length
  assert.ok(renewals === 3 || renewals === 4, `Rinnovo dopo la scadenza (${renewals} richieste token)`)

  // Registrazione senza rete verso il server: resta sul dispositivo e l'uscita avvisa.
  mock.failDiary = true
  await click('.meal-card-link'); await until('Boolean(document.querySelector("dialog[open]"))')
  await click('input[value="followed"]'); await click('dialog button[type="submit"]')
  await until('!document.querySelector("dialog")')
  await until('document.querySelector(".sync-status")?.textContent.includes("Invio appena torna la connessione")')
  await route('/impostazioni'); await until('Boolean(document.querySelector(".account-email"))')
  assert.equal(await evaluate('document.querySelector(".account-email").textContent'), 'a@example.invalid')
  await click('.account-panel > button'); await until('Boolean(document.querySelector("dialog[open]"))')
  assert.ok(await evaluate('document.querySelector("dialog").textContent.includes("non ancora sincronizzate")'))
  await click('.account-actions .secondary'); await until('!document.querySelector("dialog")')
  await route('/dieta'); await until('document.querySelector(".meal-card .status")?.textContent === "Seguito"')
  mock.failDiary = false
  await click('.sync-status .text-button')
  for (let i = 0; i < 200 && !mock.diary.meal_logs.length; i++) await new Promise(resolve => setTimeout(resolve, 50))
  if (!mock.diary.meal_logs.length) console.error('DIAG', JSON.stringify({ requests: mock.requests.filter(r => !r.startsWith('OPTIONS')).slice(-14), failures: mock.failures, sync: await evaluate('document.querySelector(".sync-status")?.textContent ?? document.querySelector(".sync-indicator")?.dataset.sync') }))
  assert.equal(mock.diary.meal_logs.length, 1, 'Pasto inviato dopo il ritorno della connessione')
  await until('document.querySelector(".sync-indicator")?.dataset.sync === "synced"')
  await route('/impostazioni'); await until('Boolean(document.querySelector(".account-panel"))')
  mock.failLogout = true
  // Nulla in sospeso: uscita diretta, senza richiesta di scarto.
  await click('.account-panel > button'); await until('document.querySelector(".auth-card [role=status]")?.textContent.includes("non è stata confermata")')
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(fixtureStorageKey)})`), null, 'SDK elimina la sessione locale anche se la revoca online fallisce')
  mock.failLogout = false
  await login('a'); await until('Boolean(document.querySelector(".account-panel"))')
  await click('.account-panel > button'); await until('Boolean(document.querySelector("#login-email"))')
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(fixtureStorageKey)})`), null)
  await login('b'); await until('document.querySelector(".account-email")?.textContent === "b@example.invalid"')
  await route('/dieta'); await until('document.querySelectorAll(".meal-card").length === 4 && !document.querySelector(".meal-card .status")')
  assert.equal(await evaluate(`Object.keys(localStorage).some(key => key.includes(${JSON.stringify(fixtureSession('a').user.id)}))`), false, 'Uscita di A: nessuna copia del suo diario sul dispositivo')
  assert.equal(mock.diary.meal_logs.filter(row => row.owner_id === fixtureSession('a').user.id).length, 1, 'Il pasto di A resta online nel suo account')

  // Evento SDK propagato da un’altra scheda: nessun archivio precedente resta visibile.
  await evaluate(`(() => {const channel=new BroadcastChannel(${JSON.stringify(fixtureStorageKey)});channel.postMessage({event:'SIGNED_OUT',session:null});channel.close()})()`)
  await until('Boolean(document.querySelector("#login-email"))')
  assert.equal(await evaluate('Boolean(document.querySelector(".meal-card"))'), false)
  assert.deepEqual(runtimeErrors, [])
  assert.deepEqual(mock.failures, [])
  const report = { status: 'passed', mode: 'Auth HTTP simulato, nessuna richiesta al cloud', checks: ['login mobile', 'errore password', 'login A', 'sessione dopo reload', 'rinnovo SDK', 'annullamento logout con registrazione non sincronizzata', 'invio dopo ritorno della connessione', 'errore logout', 'logout e rimozione sessione', 'account B senza residui di A', 'copia locale del diario rimossa all’uscita', 'logout da altra scheda'], date: new Date().toISOString() }
  await writeFile('artifacts/auth-browser-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  socket.close()
  await fetch(`${debugUrl}/json/close/${target.id}`, { method: 'GET' }).catch(() => undefined)
}
