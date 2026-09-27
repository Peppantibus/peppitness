// Creazione guidata di programma settimanale e piano alimentare, su mobile e desktop.
// Chrome di test su 9223 e preview su 4173; API Supabase simulate, nessun contatto col cloud.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fixtureSession, fixtureStorageKey, installAuthFixture } from './lib/browser-auth-fixture.mjs'

const baseUrl = process.env.TEST_BASE_URL ?? 'http://127.0.0.1:4173', debugUrl = process.env.TEST_DEBUG_URL ?? 'http://127.0.0.1:9223'
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
  if (response.exceptionDetails) throw new Error(`Errore nel test browser wizard: ${expression}`)
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
async function clickText(selector, text) { await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.includes(${JSON.stringify(text)})); if (!el) throw new Error('assente'); el.click() })()`) }
async function route(path) { await evaluate(`location.hash=${JSON.stringify(path)}`) }
async function heading() { return evaluate('document.querySelector("#wizard-heading")?.textContent ?? ""') }
async function mobile(width = 390) { await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 2, mobile: true }) }
async function widths(label) {
  for (const width of [320, 390, 768, 1440]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 })
    assert.ok(await evaluate('document.documentElement.scrollWidth <= innerWidth'), `${label}: overflow a ${width}px`)
  }
  await mobile()
}
async function screenshot(name) {
  await new Promise(resolve => setTimeout(resolve, 400))
  const result = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(`artifacts/${name}.png`, Buffer.from(result.data, 'base64'))
}

try {
  await mkdir('artifacts', { recursive: true })
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  const mock = await installAuthFixture(send, socket, baseUrl)
  const owner = fixtureSession().user.id
  await mobile()
  const seed = await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear(); localStorage.setItem(${JSON.stringify(fixtureStorageKey)},${JSON.stringify(JSON.stringify(fixtureSession()))});` })
  await send('Page.navigate', { url: `${baseUrl}/#/scheda` })
  await until('document.querySelector(".plan-empty")?.textContent.includes("Nessun programma")')
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seed.identifier })

  // 1. Dallo stato vuoto al wizard, a tutto schermo su mobile.
  await click('.plan-empty a.button')
  await until('Boolean(document.querySelector("#wizard-name"))')
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".bottom-nav")).display'), 'none', 'barra nascosta durante la creazione')
  assert.equal(await evaluate('document.querySelector(".wizard-next").disabled'), true, 'Avanti disabilitato senza nome')
  await input('#wizard-name', 'Forza settimanale')
  assert.ok(await evaluate('document.querySelector(".wz-weeks[aria-pressed=true]")?.textContent.includes("8 settimane")'), 'durata proposta: 8 settimane')
  await clickText('.wz-weeks', '6 settimane')
  await input('.wz-date input', '2026-09-28')
  await until('document.querySelector(".wz-cycle-note")?.textContent.includes("dal 28 settembre fino a domenica 8 novembre")')
  await screenshot('wizard-nome')
  await click('.wizard-next'); await until('document.querySelector("#wizard-heading")?.textContent === "Lunedì"')
  checks.push('stato vuoto → nome → lunedì, schermo senza barra')

  // 2. Lunedì: gruppi, nuovo esercizio creato dal pannello, valori con un tocco.
  await clickText('.wz-groups .wz-chip', 'Petto'); await clickText('.wz-groups .wz-chip', 'Tricipiti')
  await click('.wz-add'); await until('Boolean(document.querySelector("#wizard-search"))')
  await input('#wizard-search', 'Panca piana')
  await click('.wz-create-start'); await until('Boolean(document.querySelector(".wz-create-confirm"))')
  await clickText('.wz-segment button', 'Un manubrio')
  await input('#wizard-equipment', 'Panca')
  await screenshot('wizard-crea-esercizio')
  await click('.wz-create-confirm')
  await until('document.querySelector(".wz-sheet-footer .button")?.textContent.includes("1 aggiunto")')
  assert.equal(mock.exerciseWrites.filter(item => item.method === 'POST').length, 1, 'esercizio creato una volta nel catalogo')
  await click('.wz-sheet-footer .button'); await until('!document.querySelector("dialog[open]")')
  await until('document.querySelectorAll(".wz-exercise").length === 1')
  assert.equal(await evaluate('document.querySelector(".wz-exercise input[id$=-sets]").value'), '', 'serie non inventate')
  await click('.wizard-next')
  await until('document.querySelector(".wz-error")?.textContent.includes("serie")')
  assert.equal(await heading(), 'Lunedì', 'campi mancanti: si resta sul giorno')
  await clickText('.wz-exercise .wz-field:has(input[id$="-sets"]) .wz-chip', '4')
  assert.equal(await evaluate('document.querySelector(".wz-field:has(input[id$=-sets]) .wz-error")'), null, 'errore rimosso appena corretto')
  await clickText('.wz-exercise .wz-chip', '8–10')
  await clickText('.wz-exercise .wz-chip', '1′30″')
  assert.equal(await evaluate('document.querySelector(".wz-exercise input[id$=-rest]").value'), '90')
  await widths('Wizard lunedì'); await screenshot('wizard-lunedi')
  checks.push('gruppi muscolari, esercizio nuovo dal pannello, scorciatoie, validazione per campo')

  // 3. Martedì riposo → avanza da solo; mercoledì copia di lunedì; poi riposo fino a domenica.
  await click('.wizard-next'); await until('document.querySelector("#wizard-heading")?.textContent === "Martedì"')
  await click('.wizard-rest'); await until('document.querySelector("#wizard-heading")?.textContent === "Mercoledì"')
  await clickText('.wz-copy .wz-chip', 'lunedì'); await until('document.querySelectorAll(".wz-exercise").length === 1')
  assert.equal(await evaluate('document.querySelector(".wz-exercise input[id$=-sets]").value'), '4', 'copia con i valori di lunedì')
  await click('.wizard-next'); await until('document.querySelector("#wizard-heading")?.textContent === "Giovedì"')
  assert.equal(await evaluate('document.querySelector(".wz-pill.is-rest[aria-label^=Martedì]") !== null'), true, 'martedì segnato come riposo')
  for (const name of ['Venerdì', 'Sabato', 'Domenica']) { await click('.wizard-rest'); await until(`document.querySelector("#wizard-heading")?.textContent === "${name}"`) }
  assert.ok(await evaluate('document.querySelector(".wizard-save")?.textContent.includes("Salva programma")'), 'domenica: pulsante Salva')
  await screenshot('wizard-domenica')
  await click('.wizard-rest')
  await until('document.querySelector("#wizard-heading")?.textContent === "Programma salvato"')
  const methods = mock.programWrites.map(item => item.method)
  assert.deepEqual(methods, ['save_workout_draft', 'publish_workout_version', 'cycle'])
  assert.deepEqual([mock.programWrites[2].body.cycle_start, mock.programWrites[2].body.cycle_weeks], ['2026-09-28', 6], 'ciclo salvato sul programma')
  assert.deepEqual(mock.programWrites[0].body.p_days.map(day => [day.label, day.title]), [['Lun', 'Petto · Tricipiti'], ['Mer', 'Petto · Tricipiti']])
  assert.equal(mock.diary.active_plans.find(row => row.owner_id === owner)?.workout_plan_id, mock.programWrites[0].body.p_plan_id, 'primo programma seguito automaticamente')
  await screenshot('wizard-salvato')
  checks.push('riposo con avanzamento automatico, copia di un giorno, salvataggio + pubblicazione + programma seguito')

  // 4. Scheda del giorno: lunedì allenamento, martedì riposo.
  await click('.wizard-next'); await until('Boolean(document.querySelector(".date-panel"))')
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector(".bottom-nav")).display'), 'none', 'barra di nuovo visibile')
  await input('input[type="date"]', '2026-09-28'); await until('Boolean(document.querySelector(".workout-overview"))')
  assert.ok(await evaluate('document.querySelector(".workout-summary").textContent.includes("Petto · Tricipiti")'))
  assert.ok(await evaluate('document.querySelector(".workout-program-meta").textContent.includes("SETTIMANA ")'), 'card con la settimana del ciclo')
  assert.ok(await evaluate('document.querySelector(".workout-day-tabs [aria-pressed=true]").textContent.includes("Oggi")'))
  await input('input[type="date"]', '2026-09-29'); await until('Boolean(document.querySelector(".rest-day"))')
  await screenshot('scheda-riposo')
  await clickText('.rest-day .wz-chip', 'Lunedì'); await until('Boolean(document.querySelector(".workout-overview"))')
  await input('input[type="date"]', '2026-09-28'); await until('Boolean(document.querySelector(".workout-summary"))')
  await screenshot('scheda-lunedi')
  await click('.section-menu-button'); await until('document.querySelectorAll(".section-menu a").length === 4')
  await screenshot('scheda-menu')
  await click('.section-menu a[href="#/scheda/storico"]'); await until('!document.querySelector("dialog[open]") && location.hash === "#/scheda/storico"')
  await route('/scheda/progressi'); await until('Boolean(document.querySelector(".cycle-card"))')
  assert.equal(await evaluate('document.querySelectorAll(".week-rows li").length'), 6, 'una riga per ogni settimana del ciclo')
  assert.equal(await evaluate('document.querySelectorAll(".progress-section > .week-rows li").length'), 1, 'settimana rilevante visibile subito')
  assert.equal(await evaluate('document.querySelector(".progress-week-history").open'), false, 'altre settimane raccolte')
  assert.equal(await evaluate('document.querySelectorAll(".progress-section > .week-rows li:first-child .slot").length'), 2, 'lunedì e mercoledì previsti')
  assert.equal(await evaluate('document.querySelectorAll(".trend-card").length'), 1, 'un andamento per esercizio')
  await widths('Progressi'); await screenshot('progressi')
  checks.push('ciclo di 6 settimane salvato; Progressi con costanza e andamento')
  await route('/scheda'); await until('Boolean(document.querySelector(".summary-edit"))')
  await click('.summary-edit'); await until('Boolean(document.querySelector("#wizard-name"))')
  assert.equal(await evaluate('document.querySelector("#wizard-name").value'), 'Forza settimanale', 'Modifica apre il programma seguito')
  await click('.wizard-top .icon-button[aria-label="Chiudi"]'); await until('Boolean(document.querySelector("dialog[open] .primary"))')
  await click('dialog[open] .primary'); await until('Boolean(document.querySelector(".program-wizard-new"))')
  await route('/scheda'); await until('Boolean(document.querySelector(".workout-summary"))')
  checks.push('menu di sezione con storico, programmi ed esercizi; Modifica programma dalla Scheda')
  checks.push('Scheda: seduta del giorno della settimana, riposo con possibilità di allenarsi comunque')

  // 5. Dieta: wizard in tre passi, riposo copiato dall'allenamento.
  await route('/dieta'); await until('document.querySelector(".plan-empty")?.textContent.includes("Nessun piano")')
  await click('.plan-empty a.button'); await until('Boolean(document.querySelector("#meal-wizard-name-input"))')
  await input('#meal-wizard-name-input', 'Piano base')
  await click('.wizard-next'); await until('document.querySelector("#wizard-heading")?.textContent === "Giorni di allenamento"')
  await clickText('.wz-add-meal .wz-chip', 'Colazione'); await until('Boolean(document.querySelector(".wz-meal"))')
  await input('.wz-meal .meal-food-name', 'Yogurt'); await input('.wz-meal .meal-food-quantity', '150 g')
  await clickText('.wz-add-meal .wz-chip', 'Pranzo'); await until('document.querySelectorAll(".wz-meal").length === 2')
  await input('.wz-meal:nth-of-type(2) .meal-food-name', 'Riso')
  await widths('Wizard dieta'); await screenshot('wizard-dieta')
  await click('.wizard-next'); await until('document.querySelector("#wizard-heading")?.textContent === "Giorni di riposo"')
  await clickText('.wz-choice-card', 'Parti dai pasti'); await until('document.querySelectorAll(".wz-meal").length === 2')
  await input('.wz-meal:nth-of-type(2) .meal-food-name', 'Farro')
  await click('.wizard-save'); await until('document.querySelector("#wizard-heading")?.textContent === "Piano salvato"')
  const plan = mock.diary.meal_plans.find(row => row.owner_id === owner)
  assert.deepEqual(plan.document.days.map(day => [day.dayType, day.meals.map(meal => meal.foods[0]?.name)]), [['training', ['Yogurt', 'Riso']], ['rest', ['Yogurt', 'Farro']]])
  assert.equal(mock.diary.active_plans.find(row => row.owner_id === owner)?.meal_plan_id, plan.id, 'primo piano seguito automaticamente')
  checks.push('wizard dieta: pasti con scorciatoie, riposo copiato e modificato, piano seguito')

  // 6. Tipo di giornata dalla scheda settimanale, modificabile.
  await click('.wizard-next'); await until('Boolean(document.querySelector(".meal-card"))')
  await input('input[type="date"]', '2026-09-29')
  await until('document.querySelector(".segmented [aria-pressed=true]")?.textContent.includes("Riposo")')
  assert.ok(await evaluate('document.querySelector(".side-column").textContent.includes("Dalla tua scheda")'))
  assert.ok(await evaluate('[...document.querySelectorAll(".meal-card")].some(card => card.textContent.includes("Farro"))'), 'pasti del riposo')
  await input('input[type="date"]', '2026-09-28')
  await until('document.querySelector(".segmented [aria-pressed=true]")?.textContent.includes("Palestra")')
  assert.ok(await evaluate('[...document.querySelectorAll(".meal-card")].some(card => card.textContent.includes("Riso"))'), 'pasti dell’allenamento')
  checks.push('Dieta: tipo di giornata dedotto dalla scheda settimanale')

  // 7. Modifica di un programma pubblicato: nuova versione dal wizard.
  await route('/scheda/programmi'); await until('Boolean(document.querySelector(".program-edit"))')
  await widths('Elenco programmi'); await screenshot('programmi-elenco')
  await click('.program-edit'); await until('Boolean(document.querySelector("#wizard-name"))')
  await click('.wizard-next'); await until('document.querySelector("#wizard-heading")?.textContent === "Lunedì"')
  await click('.wz-pill:nth-child(5)'); await until('document.querySelector("#wizard-heading")?.textContent === "Venerdì"')
  await clickText('.wz-copy .wz-chip', 'mercoledì')
  await click('.wz-pill:nth-child(7)'); await until('document.querySelector("#wizard-heading")?.textContent === "Domenica"')
  await click('.wizard-save'); await until('document.querySelector("#wizard-heading")?.textContent === "Programma salvato"')
  assert.equal(mock.programTables.workout_plan_versions.filter(row => row.owner_id === owner && row.status === 'published').length, 2, 'la prima versione resta')
  assert.deepEqual(mock.programWrites.at(-2).body.p_days.map(day => day.label), ['Lun', 'Mer', 'Ven'])
  checks.push('modifica: nuova versione pubblicata, precedente conservata')

  assert.deepEqual(errors, [], 'Errori console')
  assert.deepEqual(mock.failures, [], 'Nessuna richiesta inattesa nel mock')
  const report = { status: 'passed', mode: 'API Supabase simulate, nessun contatto col cloud', checks, date: new Date().toISOString() }
  await writeFile('artifacts/wizard-browser-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  socket.close()
  await fetch(`${debugUrl}/json/close/${target.id}`).catch(() => undefined)
}
