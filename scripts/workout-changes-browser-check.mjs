// App completa, Auth/PostgREST/database locali reali. Solo il calendario è fissato al lunedì.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { workoutChangesFixture } from './lib/workout-changes-local-fixture.mjs'
import { ensureChrome, openTab, serveStatic, pause } from './lib/import-browser-harness.mjs'
import { shiftDate } from '../src/domain/dates.ts'

const directory = resolve('artifacts/workout-changes'), checks = [], pageErrors = []
await mkdir(directory, { recursive: true })
const chrome = await ensureChrome()
let server, tab, fixture
const check = (condition, name) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`) }
const textClick = async (selector, text) => {
  await tab.evaluate(`document.querySelectorAll('[data-browser-target]').forEach(el=>el.removeAttribute('data-browser-target'))`)
  await tab.evaluate(`(() => { const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el => el.textContent.trim()===${JSON.stringify(text)}); if(!el) throw Error('Pulsante assente: '+${JSON.stringify(text)}); el.setAttribute('data-browser-target','click'); })()`)
  await tab.click('[data-browser-target="click"]')
  await tab.evaluate(`document.querySelector('[data-browser-target="click"]')?.removeAttribute('data-browser-target')`)
}
const input = async (selector, value) => tab.evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)}); if(!el) throw Error('Campo assente'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
const synced = async () => tab.until(`JSON.parse(localStorage.getItem(${JSON.stringify(`peppitness:diary:v2:${fixture.a.owner}`)})||'{}').queue?.length===0`, 'coda sincronizzata')
const replace = async name => {
  await tab.evaluate(`(() => {const el=[...document.querySelectorAll('.set-panel')].find(el=>el.querySelector('h2')?.textContent===${JSON.stringify(name)});const button=[...el.querySelectorAll('.replacement-actions button')].find(el=>el.textContent==='Sostituisci'); button.setAttribute('data-browser-target','click');})()`)
  await tab.click('[data-browser-target="click"]')
  await tab.until(`!!document.querySelector('dialog[open] .wz-search input')`)
  await tab.evaluate(`document.querySelectorAll('[data-browser-target]').forEach(el=>el.removeAttribute('data-browser-target'))`)
  await pause(250)
}
const choose = async name => {
  const query = 'dialog[open] .wz-search input'
  await tab.click(query)
  await tab.send('Input.insertText', { text: name })
  await tab.until(`!![...document.querySelectorAll('dialog[open] .wz-results button')].find(el=>el.querySelector('strong')?.textContent===${JSON.stringify(name)})`)
  await tab.evaluate(`(() => { const el=[...document.querySelectorAll('dialog[open] .wz-results button')].find(el=>el.querySelector('strong')?.textContent===${JSON.stringify(name)});el.setAttribute('data-browser-target','choose');})()`)
  await tab.click('[data-browser-target="choose"]')
  await tab.until(`!!document.querySelector('.replacement-proposal')`)
}
const layout = async label => {
  for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
    await tab.viewport(width, 844, true)
    await tab.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
    const dimensions = await tab.evaluate(`(() => {const d=document.querySelector('dialog[open]');return {page:document.documentElement.scrollWidth<=innerWidth,dialog:!d||d.scrollWidth<=d.clientWidth+1,buttons:[...document.querySelectorAll('dialog[open] .wz-results button,.replacement-actions button,dialog[open] .replacement-proposal .button')].filter(el=>el.getClientRects().length).every(el=>el.getBoundingClientRect().height>=43)}})()`)
    assert.ok(dimensions.page && dimensions.dialog && dimensions.buttons, `${label} ${width} ${theme}: ${JSON.stringify(dimensions)}`)
    await tab.screenshot(resolve(directory, `${label}-${width}-${theme}.png`))
  }
  checks.push(`${label}: 320/390 chiaro/scuro, pannello e touch target`)
}
const boot = async () => {
  tab = await openTab()
  await tab.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Rome' })
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const NativeDate=Date, fixed=NativeDate.parse(${JSON.stringify(`${fixture.monday}T10:00:00.000Z`)}), boot=performance.now();
    class FixtureDate extends NativeDate { constructor(...args){super(...(args.length?args:[fixed+performance.now()-boot]));} static now(){return fixed+performance.now()-boot;} }
    window.Date=FixtureDate;
    localStorage.setItem('sb-127-auth-token',${JSON.stringify(JSON.stringify(fixture.a.session))});
    localStorage.setItem('peppitness:returning-device','1');
  })()` })
  await tab.viewport(390, 844, true)
  await tab.navigate(`${server.origin}/#/scheda`, `!!document.querySelector('.workout-start')`)
  await tab.until(`!!localStorage.getItem(${JSON.stringify(`peppitness:catalog:v1:${fixture.a.owner}`)})`)
  await textClick('.workout-start', 'Inizia allenamento')
  await tab.until(`!!document.querySelector('.session-page .replacement-actions button')`)
  await synced()
}
try {
  fixture = await workoutChangesFixture()
  const previous = { url: process.env.VITE_SUPABASE_URL, key: process.env.VITE_SUPABASE_PUBLISHABLE_KEY }
  try {
    process.env.VITE_SUPABASE_URL = fixture.config.apiUrl
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = fixture.config.publishableKey
    await build({ configFile: false, envDir: directory, plugins: [react()], root: process.cwd(), logLevel: 'warn',
      build: { outDir: resolve(directory, 'app'), target: 'safari16', emptyOutDir: true } })
  } finally {
    if (previous.url === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = previous.url
    if (previous.key === undefined) delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY; else process.env.VITE_SUPABASE_PUBLISHABLE_KEY = previous.key
  }
  const headers = await readFile('public/_headers', 'utf8')
  server = await serveStatic({ dist: resolve(directory, 'app'), csp: /Content-Security-Policy:\s*(.+)/.exec(headers)[1].replace('__SUPABASE_ORIGIN__', fixture.config.apiUrl) })
  // Ogni richiesta applicativa è locale; niente API simulate.
  await boot()
  await replace('Chest press')
  check(await tab.evaluate(`document.querySelector('[aria-label="Più avanti questa settimana"]')?.textContent.includes('mercoledì')`), 'Accesso dopo Inizia allenamento e futuri evidenziati')
  await layout('ricerca')
  await choose('Lat machine')
  check(await tab.evaluate(`document.querySelectorAll('.replacement-swap').length===2`), 'Più partner presentati senza selezione arbitraria')
  await layout('proposta-scambio')
  await textClick('dialog .button', 'Scambia con mercoledì')
  await tab.until(`document.querySelector('.set-panel h2')?.textContent==='Lat machine'`)
  await input('.set-panel input[aria-label*="carico"]', '22,5')
  await input('.set-panel input[aria-label*="ripetizioni"]', '8')
  await synced()
  await tab.send('Page.reload')
  await tab.until(`document.querySelector('.set-panel h2')?.textContent==='Lat machine' && document.querySelector('.set-panel input[aria-label*="carico"]')?.value==='22,5'`)
  check(true, 'Scambio e prima serie conservati al reload con database reale')
  await tab.click('.session-finish')
  await tab.until(`!!document.querySelector('.session-finish-confirm')`)
  await tab.click('.session-finish-confirm')
  await synced()
  await textClick('dialog button', 'Fatto')
  await tab.evaluate(`location.hash='/scheda'`)
  await tab.until(`!!document.querySelector('input[type="date"]')`)
  await input('input[type="date"]', shiftDate(fixture.monday, 2))
  await tab.until(`document.querySelector('.workout-start')?.textContent.includes('Inizia') && document.querySelector('.workout-page')?.textContent.includes('Chest press') || [...document.querySelectorAll('.exercise-list h3')].some(el=>el.textContent==='Chest press')`)
  await textClick('.workout-start', 'Inizia allenamento')
  await tab.until(`document.querySelector('.set-panel h2')?.textContent==='Chest press'`)
  check(await tab.evaluate(`document.querySelector('.set-panel .prescription-line')?.textContent.includes('3 ×')`), 'Anteprima e avvio del mercoledì ricevono chest con la propria dose')
  check(tab.requests.every(url => !/^https?:/.test(url) || ['127.0.0.1', 'localhost'].includes(new URL(url).hostname)), 'Browser senza contatti cloud')
  pageErrors.push(...tab.errors)
  await tab.close(); tab = null; await fixture.cleanup(); fixture = null

  fixture = await workoutChangesFixture(); await boot()
  await replace('Chest press'); await choose('Lat machine'); await textClick('dialog .button', 'Sostituisci solo oggi')
  await tab.until(`document.querySelector('.set-panel h2')?.textContent==='Lat machine'`)
  await synced()
  const todayOnly = await fixture.a.client.from('workout_changes').select('change_doc')
  check(todayOnly.data[0].change_doc.partner === null, 'Alternativa esplicita Sostituisci solo oggi senza scambio')
  await textClick('.replacement-actions button', 'Annulla')
  await tab.until(`document.querySelector('.set-panel h2')?.textContent==='Chest press'`)
  await synced()
  await replace('Chest press'); await choose('Spinta con manubri')
  check(await tab.evaluate(`!document.querySelector('.replacement-swap') && document.querySelector('.replacement-proposal input[aria-label="Serie"]').value==='3'`), 'Catalogo assente dalla scheda: solo sostituzione con dose proposta')
  await textClick('dialog .button', 'Sostituisci')
  await tab.until(`document.querySelector('.set-panel h2')?.textContent==='Spinta con manubri'`)
  await input('.set-panel input[aria-label*="carico"]', '12,5'); await input('.set-panel input[aria-label*="ripetizioni"]', '10')
  await synced(); await tab.send('Page.reload')
  await tab.until(`document.querySelector('.set-panel h2')?.textContent==='Spinta con manubri' && document.querySelector('.set-panel input[aria-label*="carico"]')?.value==='12,5'`)
  check(true, 'Sostituzione dal catalogo e prima registrazione persistono al reload')
  const future = await fixture.a.client.from('workout_prescriptions').select('exercise_id,sets').eq('day_id', fixture.days[1].id)
  check(future.data[0].exercise_id === fixture.find('Lat machine').id && future.data[0].sets === 5, 'Altre sedute invariate nella sostituzione semplice')
  pageErrors.push(...tab.errors)
  await tab.close(); tab = null; await fixture.cleanup(); fixture = null

  fixture = await workoutChangesFixture(); await boot()
  // Offline anche l'API: HTML e asset restano sul server locale per poter provare il reload della coda.
  await tab.send('Network.setBlockedURLs', { urls: [`${fixture.config.apiUrl}/*`] })
  await replace('Stairs Master'); await choose('Tapis roulant')
  check(await tab.evaluate(`!document.querySelector('.replacement-swap') && document.querySelector('input[aria-label="Minuti"]').value==='10'`), 'Cardio futuro da 15 min: nessuno scambio, oggi proposti 10 min offline')
  await layout('cardio')
  await input('input[aria-label="Minuti"]', '10,5')
  await textClick('dialog .button', 'Sostituisci')
  await tab.until(`!![...document.querySelectorAll('.set-panel h2')].find(el=>el.textContent==='Tapis roulant')`)
  await tab.send('Page.reload')
  await tab.until(`!![...document.querySelectorAll('.set-panel h2')].find(el=>el.textContent==='Tapis roulant')`)
  check(await tab.evaluate(`document.body.textContent.includes('10,5 min')`), 'Cardio modificato e reload offline: nessuna doppia conversione')
  await tab.evaluate(`(() => {const el=[...document.querySelectorAll('.set-panel')].find(el=>el.querySelector('h2')?.textContent==='Tapis roulant'); [...el.querySelectorAll('button')].find(el=>el.textContent==='Annulla').click()})()`)
  await tab.until(`!![...document.querySelectorAll('.set-panel h2')].find(el=>el.textContent==='Stairs Master')`)
  await tab.send('Network.setBlockedURLs', { urls: [] })
  await tab.evaluate(`window.dispatchEvent(new Event('online'))`)
  await synced()
  const rows = await fixture.a.client.from('workout_changes').select('change_doc')
  check(rows.data.length === 1 && rows.data[0].change_doc.cancelled && rows.data[0].change_doc.partner === null && rows.data[0].change_doc.after.duration_seconds === 630, 'Annullamento offline sincronizzato con ricevuta unica, solo lato attuale')
  // Ripete con 10 minuti ed esegue il nuovo cardio: 600 secondi nel DB.
  await replace('Stairs Master'); await choose('Tapis roulant'); await textClick('dialog .button', 'Sostituisci')
  await tab.until(`!!document.querySelector('input[aria-label^="Tapis roulant, serie 1, minuti"]')`)
  await input('input[aria-label^="Tapis roulant, serie 1, minuti"]', '10')
  await synced()
  const set = await fixture.a.client.from('workout_set_logs').select('amount,exercise_id')
  check(set.data.some(row => row.amount === 600 && row.exercise_id === fixture.find('Tapis roulant').id), 'Minuti registrati come 600 secondi sulla nuova identità')
  const untouched = await fixture.a.client.from('workout_prescriptions').select('duration_seconds').eq('id', fixture.days[1].exercises[1].id)
  check(untouched.data[0].duration_seconds === 900, 'Cardio futuro invariato a 900 secondi')
  await replace('Chest press'); await choose('Plank')
  check(await tab.evaluate(`document.querySelector('input[aria-label="Secondi"]').value===''`), 'Ripetizioni → tempo: durata richiesta, nessuna conversione inventata')
  await textClick('dialog .button', 'Sostituisci')
  check(await tab.evaluate(`!!document.querySelector('.replacement-proposal [role="alert"]')`), 'Dose incompatibile incompleta non applicata')
  await input('input[aria-label="Secondi"]', '30'); await textClick('dialog .button', 'Sostituisci')
  await tab.until(`document.querySelector('.set-panel h2')?.textContent==='Plank'`)
  await input('input[aria-label^="Plank, serie 1, secondi"]', '30'); await synced()
  const seconds = await fixture.a.client.from('workout_set_logs').select('amount,exercise_id')
  check(seconds.data.some(row=>row.amount===30 && row.exercise_id===fixture.find('Plank').id), 'Nuovo plank resta in secondi; cardio registrato su un’altra card non blocca la sostituzione')
  await tab.screenshot(resolve(directory, 'sessione-cardio.png'))
  // Errori di rete offline attesi; nessuna eccezione JS.
  check(![...pageErrors, ...tab.errors].some(error => /TypeError|ReferenceError|Maximum update/.test(error)), 'Nessuna eccezione JavaScript nei flussi verificati')
  await writeFile(resolve(directory, 'browser.json'), JSON.stringify({ result: 'PASS', checks }, null, 2))
} catch (error) {
  if (tab) {
    await tab.screenshot(resolve(directory, 'failure.png')).catch(() => {})
    console.error((await tab.evaluate('document.body.innerText').catch(() => '')).slice(0, 3500))
    console.error(tab.errors.filter(error => !error.includes('Failed to load resource')).slice(-6))
  }
  throw error
} finally {
  await tab?.close(); await fixture?.cleanup(); await server?.stop(); await chrome.stop()
}
