// Nuovi flussi del diario: stati vuoti, programma seguito, piano alimentare, annullamento seduta.
// Chrome di test su 9223 e preview su 4173; API Supabase simulate, nessun contatto col cloud.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fixtureSession, fixtureStorageKey, installAuthFixture } from './lib/browser-auth-fixture.mjs'
import { sampleMeals, sampleWorkoutDays, seedFollowedPlans } from './lib/diary-fixture.mjs'

const baseUrl = 'http://127.0.0.1:4173', debugUrl = 'http://127.0.0.1:9223'
const checks = [], errors = []
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
  if (response.exceptionDetails) throw new Error(`Errore nel test browser diario: ${expression}`)
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
async function clickText(selector, text) { await evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.includes(${JSON.stringify(text)})).click()`) }
async function route(path) { await evaluate(`location.hash=${JSON.stringify(path)}`) }
async function widths(label) {
  for (const width of [320, 390, 768, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 })
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `${label}: overflow a ${width}px`)
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
}
async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(`artifacts/${name}.png`, Buffer.from(result.data, 'base64'))
}

try {
  await mkdir('artifacts', { recursive: true })
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  const mock = await installAuthFixture(send, socket, baseUrl)
  const owner = fixtureSession().user.id
  const seed = await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear(); localStorage.setItem(${JSON.stringify(fixtureStorageKey)},${JSON.stringify(JSON.stringify(fixtureSession()))});` })

  // 1. Account vuoto: stati vuoti con azione principale, nessun dato inventato.
  await send('Page.navigate', { url: `${baseUrl}/#/scheda` })
  await until('document.querySelector(".plan-empty")?.textContent.includes("Nessun programma da seguire")')
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seed.identifier })
  assert.ok(await evaluate('document.querySelector(".plan-empty a").getAttribute("href") === "#/scheda/programmi/nuovo"'))
  assert.equal(await evaluate('Boolean(document.querySelector(".exercise-card"))'), false, 'Nessun esercizio inventato sotto un account')
  await widths('Scheda vuota'); await screenshot('diary-scheda-vuota')
  await route('/dieta')
  await until('document.querySelector(".plan-empty")?.textContent.includes("Nessun piano alimentare")')
  assert.equal(await evaluate('Boolean(document.querySelector(".meal-card"))'), false)
  checks.push('stati vuoti Scheda e Dieta')

  // 2. Editor del piano alimentare: creazione, validazione, salvataggio, piano seguito.
  await route('/dieta/piani'); await until('Boolean(document.querySelector(".meal-plan-new"))')
  await click('.meal-plan-new'); await until('Boolean(document.querySelector("#meal-plan-name"))')
  await input('#meal-plan-name', 'Piano sintetico')
  await click('.meal-add-day'); await until('Boolean(document.querySelector(".meal-day-name"))')
  await click('.meal-add'); await until('Boolean(document.querySelector(".meal-name"))')
  await click('.meal-plan-save')
  await until('document.querySelector(".program-message")?.textContent.includes("pasto 1")')
  assert.equal(mock.diary?.meal_plans.length ?? 0, 0, 'Bozza invalida non inviata')
  await input('.meal-name', 'Colazione')
  await click('.meal-add-food'); await until('Boolean(document.querySelector(".meal-food-name"))')
  await input('.meal-food-name', 'Yogurt bianco'); await input('.meal-food-quantity', '150 g')
  await input('textarea[id$="-alternatives"]', 'Pane e ricotta\n')
  await widths('Editor piano'); await screenshot('diary-editor-piano')
  await click('.meal-plan-save')
  await until('document.querySelector(".program-message")?.textContent.includes("salvato online")')
  assert.equal(mock.diary.meal_plans.length, 1)
  assert.deepEqual(mock.diary.meal_plans[0].document.days[0].meals[0].alternatives, ['Pane e ricotta'], 'Righe vuote rimosse, testo invariato')
  await clickText('.program-actions button', 'Torna ai piani'); await until('Boolean(document.querySelector(".meal-plan-card"))')
  await clickText('.meal-plan-card button', 'Segui questo piano')
  await until('document.querySelector(".meal-plan-card")?.textContent.includes("Piano seguito")')
  await route('/dieta'); await until('document.querySelectorAll(".meal-card").length === 1')
  assert.ok(await evaluate('document.querySelector(".meal-card").textContent.includes("Colazione")'))
  checks.push('editor piano alimentare e piano seguito')

  // 3. Programma pubblicato non ancora seguito: scelta esplicita, poi Scheda reale.
  const other = seedFollowedPlans({}, owner, { workoutDays: sampleWorkoutDays, meals: sampleMeals })
  seedFollowedPlans(mock, owner, { workoutDays: sampleWorkoutDays, meals: sampleMeals })
  // Il seed segue già piani: si rimuove la selezione del programma per provare la scelta.
  mock.diary.active_plans = mock.diary.active_plans.filter(row => row.owner_id !== owner || row.meal_plan_id !== other.mealPlanId)
  mock.diary.meal_plans = mock.diary.meal_plans.filter(row => row.id !== other.mealPlanId)
  await route('/dieta/piani'); await route('/scheda')
  await until('document.querySelector(".plan-empty")?.textContent.includes("Scegli il programma")')
  await click('.plan-choice')
  await until('Boolean(document.querySelector(".workout-overview"))')
  assert.equal(mock.diary.active_plans.find(row => row.owner_id === owner).workout_plan_id, other.planId)
  assert.ok(await evaluate('document.querySelector(".workout-summary").textContent.includes("Full body")'))
  checks.push('scelta esplicita del programma seguito')

  // 4. Seduta avviata e annullata: nessuna seduta resta online.
  await click('.workout-summary .primary'); await until('Boolean(document.querySelector(".session-page"))')
  await until('!document.querySelector(".sync-status") || document.querySelector(".sync-status").textContent.includes("Sincronizzato")')
  for (let i = 0; i < 60 && !mock.diary.workout_sessions.length; i++) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(mock.diary.workout_sessions.length, 1, 'Seduta avviata online')
  await click('.session-more'); await until('Boolean(document.querySelector("dialog[open] .session-discard"))')
  await screenshot('diary-annulla-seduta')
  await click('dialog[open] .session-discard')
  await until('Boolean(document.querySelector(".workout-overview")) && !document.querySelector(".resume-banner")')
  for (let i = 0; i < 60 && mock.diary.workout_sessions.length; i++) await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(mock.diary.workout_sessions.length, 0, 'Seduta annullata anche online')
  checks.push('annullamento seduta in corso')

  // 5. Programma: la Scheda resta disponibile dalla copia sul dispositivo senza rete.
  mock.failProgramReads = true; mock.failDiary = true
  await send('Page.reload')
  await until('Boolean(document.querySelector(".workout-overview"))')
  await until('document.querySelector(".plans-message")?.textContent.includes("copia salvata")')
  mock.failProgramReads = false; mock.failDiary = false
  checks.push('Scheda disponibile offline dalla copia locale')

  assert.deepEqual(errors, [], 'Errori console')
  assert.deepEqual(mock.failures, [], 'Nessuna richiesta inattesa nel mock')
  const report = { status: 'passed', mode: 'API Supabase simulate, nessun contatto col cloud', checks, date: new Date().toISOString() }
  await writeFile('artifacts/diary-browser-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  socket.close()
  await fetch(`${debugUrl}/json/close/${target.id}`).catch(() => undefined)
}
