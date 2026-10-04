import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fixtureSession, fixtureStorageKey, installAuthFixture } from './lib/browser-auth-fixture.mjs'
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


try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  const mock = await installAuthFixture(send, socket, baseUrl)
  for (const account of ['a', 'b']) seedFollowedPlans(mock, fixtureSession(account).user.id, { workoutDays: sampleWorkoutDays, meals: sampleMeals })

  // 1) Requisito attivo, nessun fattore: registrazione obbligatoria, app nascosta finché non verificata.
  mock.mfaSatisfied = false
  const seed = await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear(); localStorage.setItem(${JSON.stringify(fixtureStorageKey)},${JSON.stringify(JSON.stringify(fixtureSession()))});` })
  await send('Page.navigate', { url: baseUrl })
  await until('Boolean(document.querySelector("#mfa-code"))')
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seed.identifier })
  assert.equal(await evaluate('Boolean(document.querySelector(".meal-card"))'), false, 'App non visibile prima della verifica')
  assert.equal(await evaluate('document.querySelector(".mfa-qr")?.getAttribute("alt")?.includes("QR")'), true, 'QR mostrato con CSP data:')
  assert.equal(await evaluate('document.querySelector(".mfa-secret")?.textContent'), 'JBSWY3DPEHPK3PXP')
  assert.equal(mock.mfaEnrolled, 1)
  for (const width of [320, 390, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 })
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `MFA overflow ${width}`)
  }
  // Codice errato: messaggio controllato, campo svuotato, app ancora nascosta.
  await input('#mfa-code', '000000'); await click('.auth-form button')
  await until('document.querySelector("[role=alert]")?.textContent.includes("non corretto")')
  assert.equal(await evaluate('document.querySelector("#mfa-code").value'), '')
  assert.equal(await evaluate('Boolean(document.querySelector(".meal-card"))'), false)
  // Codice corretto: si apre l'app.
  await input('#mfa-code', '123456'); await click('.auth-form button')
  await until('document.querySelectorAll(".meal-card").length === 4')
  assert.equal(mock.mfaVerified, 1)

  // 2) Fattore già verificato: solo challenge, nessuna nuova iscrizione.
  mock.mfaSatisfied = false
  mock.mfaFactors = [{ id: 'factor-fixture', factor_type: 'totp', status: 'verified', friendly_name: 'peppitness' }]
  await send('Page.reload')
  await until('Boolean(document.querySelector("#mfa-code"))')
  assert.equal(await evaluate('Boolean(document.querySelector(".mfa-qr"))'), false, 'Nessun QR con fattore esistente')
  assert.equal(mock.mfaEnrolled, 1, 'Nessuna nuova iscrizione')
  await input('#mfa-code', '123456'); await click('.auth-form button')
  await until('document.querySelectorAll(".meal-card").length === 4')

  // 3) Backend senza requisito (o raggiungibile): nessuna schermata aggiuntiva.
  mock.mfaSatisfied = true
  await send('Page.reload')
  await until('document.querySelectorAll(".meal-card").length === 4')
  assert.equal(await evaluate('Boolean(document.querySelector("#mfa-code"))'), false)
  // 3b) Verifica non raggiungibile ma «non richiesto» già confermato dal server per questo account: l'app si apre.
  const notRequiredKey = `peppitness:mfa-not-required:v1:${fixtureSession().user.id}`
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(notRequiredKey)})`), '1', 'risposta «non richiesto» ricordata')
  mock.failMfaStatus = true
  await send('Page.reload')
  await until('document.querySelectorAll(".meal-card").length === 4')
  // 3c) Verifica non raggiungibile e nessuna conferma precedente: niente app, solo Riprova/Esci.
  await evaluate(`localStorage.removeItem(${JSON.stringify(notRequiredKey)})`)
  await send('Page.reload')
  await until('document.querySelector("#auth-title")?.textContent.includes("non riuscita")')
  assert.equal(await evaluate('Boolean(document.querySelector(".meal-card"))'), false, 'App nascosta senza verifica')
  assert.equal(await evaluate('Boolean(document.querySelector("#mfa-code"))'), false, 'Nessuna iscrizione senza risposta del server')
  mock.failMfaStatus = false
  await evaluate('[...document.querySelectorAll(".auth-card button")].find(b => b.textContent === "Riprova").click()')
  await until('document.querySelectorAll(".meal-card").length === 4')
  // 3d) Il server dice «richiesto»: la conferma precedente viene dimenticata.
  mock.mfaSatisfied = false; mock.mfaFactors = [{ id: 'factor-fixture', factor_type: 'totp', status: 'verified', friendly_name: 'peppitness' }]
  await send('Page.reload')
  await until('Boolean(document.querySelector("#mfa-code"))')
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(notRequiredKey)})`), null, 'conferma dimenticata')
  mock.mfaSatisfied = true
  await send('Page.reload'); await until('document.querySelectorAll(".meal-card").length === 4')
  // 4) Attivazione volontaria dall'account (requisito server spento).
  mock.mfaFactors = []
  await send('Page.reload'); await until('document.querySelectorAll(".meal-card").length === 4')
  await evaluate('location.hash="/impostazioni"'); await until('Boolean(document.querySelector(".account-panel"))')
  await until('[...document.querySelectorAll(".account-panel button")].some(b => b.textContent === "Attiva")')
  await evaluate('[...document.querySelectorAll(".account-panel button")].find(b => b.textContent === "Attiva").click()')
  await until('Boolean(document.querySelector("#mfa-setup-code"))')
  await input('#mfa-setup-code', '000000'); await click('dialog button[type="submit"]')
  await until('document.querySelector("dialog [role=alert]")?.textContent.includes("non corretto")')
  await input('#mfa-setup-code', '123456'); await click('dialog button[type="submit"]')
  await until('!document.querySelector("dialog") && document.querySelector(".account-panel [role=status]")?.textContent.includes("Attiva")')
  assert.equal(await evaluate(`localStorage.getItem(${JSON.stringify(notRequiredKey)})`), null, 'attivazione: conferma «non richiesto» dimenticata')
  assert.deepEqual(runtimeErrors, [])
  assert.deepEqual(mock.failures, [])
  const report = { status: 'passed', mode: 'Auth HTTP simulato, nessuna richiesta al cloud', checks: ['enrollment obbligatorio', 'QR sotto CSP', 'codice errato', 'codice corretto', 'challenge con fattore esistente', 'verifica irraggiungibile: apertura solo con conferma precedente', 'Riprova', 'conferma dimenticata se richiesto o attivato', 'nessun requisito', 'attivazione volontaria da Account', '3 larghezze'] }
  await mkdir('artifacts', { recursive: true })
  await writeFile('artifacts/mfa-gate-browser-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  socket.close()
  await fetch(`${debugUrl}/json/close/${target.id}`, { method: 'GET' }).catch(() => undefined)
}
