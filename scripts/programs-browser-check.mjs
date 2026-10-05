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
    if (response.exceptionDetails) throw new Error(`Errore nel test browser programmi: ${expression}`)
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

const listReady = 'Boolean(document.querySelector(".program-wizard-new"))'
const formReady = 'Boolean(document.querySelector("#program-title")) && !document.querySelector(".program-form > fieldset").disabled'
const saved = 'document.querySelector(".program-message")?.textContent.includes("Bozza salvata online")'
const published = 'Boolean(document.querySelector(".program-fork"))'
const conflict = 'Boolean(document.querySelector(".program-conflict"))'
const owner = fixtureSession().user.id
const firstId = '66666666-6666-4666-8666-666666666666', timedId = '77777777-7777-4777-8777-777777777777'
const exercise = { owner_id: owner, name: 'Spinta sintetica', variant: 'Seduto', equipment: 'Macchina A', load_convention: 'total', load_unit: 'kg', measurement_mode: 'reps', per_side: false, note: '', archived_at: null, revision: 1 }
mock.exercises = new Map([[`${owner}:${firstId}`, { ...exercise, id: firstId }], [`${owner}:${timedId}`, { ...exercise, id: timedId, name: 'Tenuta sintetica', load_convention: 'bodyweight', measurement_mode: 'seconds', per_side: true }]])
async function confirm(page) { await page.until('Boolean(document.querySelector("dialog[open]"))'); await page.click('dialog .primary'); await page.until('!document.querySelector("dialog")') }
async function add(page, id) { await page.input('.program-exercise-select', id); await page.click('.program-add-exercise') }
const field = (key, index = 1) => `.program-prescription:nth-of-type(${index}) [data-field="${key}"]`

try {
  await mkdir('artifacts', { recursive: true })
  const a = await page()
  const seed = await a.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.clear(); localStorage.setItem(${JSON.stringify(fixtureStorageKey)},${JSON.stringify(JSON.stringify(fixtureSession()))});` })
  await a.send('Page.navigate', { url: `${baseUrl}/#/scheda` }); await a.until('Boolean(document.querySelector(".section-menu-button"))')
  await a.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seed.identifier })
  await a.click('.section-menu-button'); await a.until('Boolean(document.querySelector(".section-menu a"))')
  await a.click('.section-menu a[href="#/scheda/programmi"]'); await a.until(listReady)
  assert.equal(mock.programWrites.length, 0)
  await a.click('.program-wizard-new'); await a.until('Boolean(document.querySelector(".wizard-advanced"))'); await a.click('.wizard-advanced'); await a.until(formReady)
  await a.input('#program-title', 'Programma sintetico'); await a.input('#program-guidance', 'Istruzioni generali <b>testo</b>')
  await a.click('.program-save'); await a.until(saved)
  assert.equal(mock.programTables.workout_plans.length, 1)
  await a.click('.program-publish'); await confirm(a)
  await a.until('document.querySelector(".program-message")?.textContent.includes("almeno una seduta")')
  assert.equal(mock.programWrites.filter(row => row.method.startsWith('publish')).length, 0)
  checks.push('archivio vuoto, prima bozza atomica e pubblicazione vuota impedita')

  await a.click('.program-add-day')
  await a.input('.program-day-label', 'Mattina'); await a.input('.program-day-title', 'Forza sintetica')
  await add(a, firstId)
  for (const [key, value] of Object.entries({ sets: '2', optionalSets: '1', repsMin: '8', repsMax: '10', restSeconds: '90', rir: '2,5' })) await a.input(field(key), value)
  await a.click('.prescription-copy')
  await a.input(field('sets', 2), '3')
  await a.click('.program-prescription:nth-of-type(2) .prescription-up')
  assert.equal(await a.evaluate(`document.querySelector(${JSON.stringify(field('sets'))}).value`), '3')
  await a.click('.program-prescription:nth-of-type(2) .prescription-remove'); await confirm(a)
  await add(a, timedId)
  for (const [key, value] of Object.entries({ sets: '1', durationSeconds: '30', restSeconds: '60', rpe: '7,5' })) await a.input(field(key, 2), value)
  assert.equal(await a.evaluate('document.querySelectorAll(".program-prescription:nth-of-type(2) [data-field=repsMin]").length'), 0)
  await a.click('.program-prescription:nth-of-type(2) .prescription-up')
  await a.click('.day-copy')
  assert.equal(await a.evaluate('document.querySelectorAll(".program-day").length'), 2)
  await a.input('.program-day:nth-of-type(2) .program-day-label', 'Sera')
  await a.input('.program-day:nth-of-type(2) .program-day-title', 'Richiamo sintetico')
  await a.click('.program-day:nth-of-type(2) .day-up')
  assert.equal(await a.evaluate('document.querySelector(".program-day-title").value'), 'Richiamo sintetico')
  await a.click('.program-day:nth-of-type(2) .day-copy')
  await a.click('.program-day:nth-of-type(3) .day-remove'); await confirm(a)
  const writesBeforeValidation = mock.programWrites.length
  await a.input('.program-day-label', 'Mattina'); await a.click('.program-save')
  await a.until('document.querySelector(".program-message")?.textContent.includes("etichetta diversa")')
  assert.equal(mock.programWrites.length, writesBeforeValidation)
  await a.input('.program-day-label', 'Sera')
  checks.push('sedute libere, duplicazione/riordino/rimozione, ID e label, reps/secondi e decimali italiani')

  await a.click('a[href="#/scheda/catalogo"]'); await a.until('Boolean(document.querySelector(".catalog-toolbar"))')
  await a.route('/scheda/programmi'); await a.until(formReady)
  assert.equal(await a.evaluate('document.querySelector("#program-title").value'), 'Programma sintetico')
  assert.equal(await a.evaluate('document.querySelectorAll(".program-day").length'), 2)
  await a.click('.program-close'); await a.until('Boolean(document.querySelector("dialog[open]"))'); await a.click('dialog .secondary')
  for (const width of [320, 390, 768, 1440]) {
    await a.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 720 })
    assert.ok(await a.evaluate('document.documentElement.scrollWidth <= innerWidth'), `Overflow programmi ${width}`)
  }
  await a.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await a.evaluate('scrollTo(0,0)')
  const screenshot = await a.send('Page.captureScreenshot', { format: 'png' })
  await writeFile('artifacts/programs-mobile.png', Buffer.from(screenshot.data, 'base64'))
  await a.evaluate('document.querySelector(".program-prescription").scrollIntoView({block:"start"})')
  const prescriptionScreenshot = await a.send('Page.captureScreenshot', { format: 'png' })
  await writeFile('artifacts/programs-prescription-mobile.png', Buffer.from(prescriptionScreenshot.data, 'base64'))
  checks.push('bozza preservata andando al catalogo, scarto confermato, editor a quattro larghezze')

  mock.loseProgramSave = true
  await a.click('.program-save'); await a.until(saved)
  assert.equal(mock.programTables.workout_plans.length, 1); assert.equal(mock.programTables.workout_plan_versions.length, 1)
  assert.equal(mock.programTables.workout_days.length, 2); assert.equal(mock.programTables.workout_prescriptions.length, 4)
  assert.equal(new Set(mock.programTables.workout_prescriptions.map(row => row.id)).size, 4)
  assert.ok(mock.programTables.workout_prescriptions.some(row => row.rpe === 7.5))
  assert.ok(mock.programTables.workout_prescriptions.some(row => row.sets === 3 && row.optional_sets === 1 && row.rir === 2.5))
  await a.click('.program-close'); await a.send('Page.reload'); await a.until(listReady)
  await a.click('.program-version'); await a.until(formReady)
  assert.equal(await a.evaluate('document.querySelectorAll(".program-day").length'), 2)
  checks.push('save con risposta persa, documento intero verificato, nessun duplicato, reload e riapertura')

  const b = await page(); await b.send('Page.navigate', { url: `${baseUrl}/#/scheda/programmi` }); await b.until(listReady); await b.click('.program-version'); await b.until(formReady)
  await a.input('#program-guidance', 'Istruzioni A'); await a.click('.program-save'); await a.until(saved)
  await b.input('#program-guidance', 'Istruzioni B'); await b.click('.program-save'); await b.until(conflict)
  assert.ok(await b.evaluate('document.querySelector(".program-conflict").textContent.includes("Istruzioni A")'))
  assert.equal(await b.evaluate('document.querySelector("#program-guidance").value'), 'Istruzioni B')
  await b.click('.program-conflict .primary'); await b.until(saved)
  await a.input('#program-guidance', 'Altra modifica A'); await a.click('.program-save'); await a.until(conflict)
  await a.click('.program-conflict .secondary'); await a.until(formReady)
  assert.equal(await a.evaluate('document.querySelector("#program-guidance").value'), 'Istruzioni B')
  checks.push('due tab: conflitto dell’intero documento, scelta locale e caricamento online')

  const beforeFailure = structuredClone(mock.programTables)
  mock.rejectProgramSave = true
  await a.input('#program-title', 'Salvataggio respinto'); await a.click('.program-save')
  await a.until('document.querySelector(".program-message")?.textContent.includes("respinto")')
  assert.deepEqual(mock.programTables, beforeFailure)
  assert.equal(await a.evaluate('document.querySelector("#program-title").value'), 'Salvataggio respinto')
  await a.input('#program-title', 'Programma sintetico'); await a.input('#program-guidance', 'Bozza senza rete')
  mock.failProgramReads = true; mock.failProgramWrites = true
  await a.click('.program-save'); await a.until('Boolean(document.querySelector(".program-check"))')
  assert.equal(await a.evaluate('Boolean(document.querySelector(".program-close"))'), false)
  mock.failProgramReads = false; mock.failProgramWrites = false
  await a.click('.program-check'); await a.until(conflict); await a.click('.program-conflict .primary'); await a.until(saved)
  checks.push('rifiuto del server senza mezzo documento, bozza correggibile, rete assente e verifica prima del reinvio')

  mock.loseProgramPublish = true
  await a.click('.program-publish'); await confirm(a); await a.until(published)
  assert.equal(await a.evaluate('Boolean(document.querySelector("#program-title"))'), false)
  const publishedVersion = structuredClone(mock.programTables.workout_plan_versions[0])
  const publishedDays = structuredClone(mock.programTables.workout_days)
  const publishedPrescriptions = structuredClone(mock.programTables.workout_prescriptions)
  assert.equal(publishedVersion.status, 'published')
  assert.equal(mock.programTables.workout_plans[0].active_version_id, publishedVersion.id)
  checks.push('pubblicazione con risposta persa recuperata, versione corrente e sola lettura')

  await b.input('#program-guidance', 'Nuova versione da conflitto'); await b.click('.program-save'); await b.until(conflict)
  assert.equal(await b.evaluate('Boolean(document.querySelector(".program-conflict .primary"))'), false)
  await b.click('.program-conflict .secondary:last-child'); await b.until(formReady)
  await b.input('#program-title', 'Seconda versione'); await b.click('.program-save'); await b.until(saved)
  assert.equal(mock.programTables.workout_plan_versions.length, 2)
  assert.deepEqual(mock.programTables.workout_plan_versions.find(row => row.id === publishedVersion.id), publishedVersion)
  assert.deepEqual(mock.programTables.workout_days.filter(row => row.version_id === publishedVersion.id), publishedDays)
  assert.deepEqual(mock.programTables.workout_prescriptions.filter(row => publishedDays.some(day => day.id === row.day_id)), publishedPrescriptions)
  await b.click('.program-publish'); await confirm(b); await b.until(published)
  assert.equal(new Set(mock.programTables.workout_days.map(row => row.id)).size, 4)
  assert.equal(new Set(mock.programTables.workout_prescriptions.map(row => row.id)).size, 8)
  await b.click('.program-close'); await b.send('Page.reload'); await b.until(listReady)
  assert.equal(await b.evaluate('document.querySelectorAll(".program-version").length'), 2)
  assert.ok(await b.evaluate('document.querySelector(".program-version").textContent.includes("Seconda versione")'))
  await b.click('.program-version:last-child'); await b.until(published)
  assert.ok(await b.evaluate('document.querySelector(".program-preview").textContent.includes("Bozza senza rete")'))
  checks.push('pubblicata altrove: nuova bozza locale, nuovi ID figli, seconda pubblicazione e prima versione intatta dopo reload')

  await b.click('.program-close'); await b.until(listReady)
  await b.click('.program-edit'); await b.until(formReady)
  assert.equal(await b.evaluate('document.querySelector(".program-save").disabled'), true, 'editor avanzato pulito all’apertura')
  await b.input('#program-guidance', 'Aggiornamento avanzato')
  const beforeRevision = mock.programTables.workout_plan_versions.length
  await b.click('.program-save'); await b.until('document.querySelector(".program-message")?.textContent.includes("Programma aggiornato")')
  assert.equal(mock.programWrites.at(-1).method, 'save_workout_revision')
  assert.equal(mock.programTables.workout_plan_versions.length, beforeRevision, 'versione non usata aggiornata anche dall’editor avanzato')
  checks.push('editor avanzato: apertura pulita e salvataggio tramite save_workout_revision')

  await a.click('.program-fork'); await a.until(formReady)
  await a.input('#program-title', 'Bozza prima di uscire')
  await a.route('/impostazioni'); await a.until('Boolean(document.querySelector(".account-panel > button:not(:disabled)"))')
  await a.click('.account-panel > button'); await a.until('Boolean(document.querySelector("dialog[open]"))'); await a.click('.account-actions .secondary')
  await a.route('/scheda/programmi'); await a.until(formReady)
  assert.equal(await a.evaluate('document.querySelector("#program-title").value'), 'Bozza prima di uscire')
  await a.route('/impostazioni'); await a.until('Boolean(document.querySelector(".account-panel > button:not(:disabled)"))')
  await a.click('.account-panel > button'); await a.until('Boolean(document.querySelector("dialog[open]"))'); await a.click('.account-actions .danger')
  await a.until('Boolean(document.querySelector("#login-email"))'); await a.input('#login-email', 'b@example.invalid'); await a.input('#login-password', fixturePassword); await a.click('.auth-form button')
  await a.until('Boolean(document.querySelector(".account-panel"))'); await a.route('/scheda/programmi'); await a.until(listReady)
  assert.equal(await a.evaluate('document.querySelectorAll(".program-version").length'), 0)
  checks.push('bozza nel logout: annullamento, scarto esplicito e account B senza programmi di A')

  mock.failProgramReads = true; await a.send('Page.reload'); await a.until('document.querySelector("[role=alert]")?.textContent.includes("caricare i programmi")')
  assert.equal(await a.evaluate('Boolean(document.querySelector(".program-wizard-new"))'), false)
  mock.failProgramReads = false; await a.click('.empty-state .primary'); await a.until(listReady)
  checks.push('errore iniziale distinto da archivio vuoto, riprova senza creazione automatica')
  assert.deepEqual(mock.failures, []); assert.deepEqual(errors, [])
  const report = { status: 'passed', mode: 'SDK reale, API/RPC simulate; nessun contatto cloud o prova SQL/RLS', checks, date: new Date().toISOString() }
  await writeFile('artifacts/programs-browser-report.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2))
} finally { for (const p of pages) await p.close() }
