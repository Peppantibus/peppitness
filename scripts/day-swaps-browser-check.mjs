// App intera e backend locali reali, due viewport/temi e dati esclusivamente sintetici.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { workoutChangesFixture } from './lib/workout-changes-local-fixture.mjs'
import { ensureChrome, openTab, serveStatic, pause } from './lib/import-browser-harness.mjs'
import { shiftDate } from '../src/domain/dates.ts'
import { newMealPlan, newPlanDay, newPlanMeal, mealFromPlan } from '../src/domain/meal-plans.ts'
import { createPlansRepository } from '../src/persistence/plans-repository.ts'

const directory = resolve('artifacts/day-swaps'), checks = []
await mkdir(directory, { recursive: true })
const chrome = await ensureChrome()
let fixture, tab, server
const check = (condition, label) => { assert.ok(condition, label); checks.push(label); console.log(`PASS ${label}`) }
const clickText = async (selector, text) => {
  await tab.evaluate(`document.querySelectorAll('[data-swap-test]').forEach(el=>el.removeAttribute('data-swap-test'));(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!el)throw Error('Pulsante assente: '+${JSON.stringify(text)});el.setAttribute('data-swap-test','click')})()`)
  await tab.click('[data-swap-test="click"]')
}
const pickSource = async value => {
  if (await tab.evaluate(`document.querySelector('.day-swap-source-toggle').dataset.date===${JSON.stringify(value)} && !!document.querySelector('input[name="swap-target"]')`)) return
  if (!await tab.evaluate(`!!document.querySelector('input[name="swap-source"]')`)) await tab.click('.day-swap-source-toggle')
  await tab.click(`.day-swap-choice:has(input[name="swap-source"][value="${value}"])`)
  await tab.until(`!!document.querySelector('input[name="swap-target"]')`)
}
const pickTarget = value => tab.click(`.day-swap-choice:has(input[name="swap-target"][value="${value}"])`)
const synced = () => tab.until(`!!document.querySelector('[data-sync="synced"]') && !document.querySelector('[data-sync="pending"], [data-sync="sending"], [data-sync="waiting"], [data-sync="conflict"]')`, 'diario sincronizzato', 500)
const route = async path => { await tab.evaluate(`location.hash=${JSON.stringify(path)}`); await pause(150) }
const layout = async label => {
  for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
    await tab.viewport(width, 844, true); await tab.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await pause(200)
    check(await tab.evaluate(`(()=>{const d=document.querySelector('dialog[open]');return document.documentElement.scrollWidth<=innerWidth&&(!d||d.scrollWidth<=d.clientWidth+1)})()`), `${label}: ${width}px ${theme} senza overflow`)
    check(await tab.evaluate(`(()=>{const root=document.querySelector('dialog[open]')||document.querySelector('.rest-day')||document.querySelector('.workout-summary');return !!root&&[...root.querySelectorAll('button,input,select')].every(el=>!!(el.getAttribute('aria-label')||el.textContent.trim()||el.closest('label')?.textContent.trim()))})()`), `${label}: ${width}px ${theme} controlli con nome accessibile`)
    await tab.screenshot(resolve(directory, `${label}-${width}-${theme}.png`))
  }
}
try {
  fixture = await workoutChangesFixture()
  const monday = shiftDate(fixture.monday, 7), tuesday = shiftDate(monday, 1), wednesday = shiftDate(monday, 2)
  const plan = newMealPlan(), planDay = newPlanDay([])
  plan.name = 'Pasti sintetici'; plan.document = { guidance: '', days: [{ ...planDay, dayType: 'any', meals: [{ ...newPlanMeal(), name: 'Colazione sintetica', foods: [{ name: 'Alimento sintetico', quantity: '100 g' }] }] }] }
  const mealPlan = await createPlansRepository(fixture.a.client, fixture.a.owner).saveMealPlan(plan, null, AbortSignal.timeout(15000))
  await fixture.a.client.from('active_plans').update({ meal_plan_id: mealPlan.id, revision: 2 }).eq('owner_id', fixture.a.owner).throwOnError()
  await fixture.a.client.from('diary_days').insert({ diary_date: monday, day_type: 'training' }).throwOnError()
  await fixture.a.client.from('meal_logs').insert({ diary_date: monday, meal_id: plan.document.days[0].meals[0].id, meal_plan_id: mealPlan.id, status: 'followed', note: 'Nota da conservare', day_type: 'training', meal_snapshot: mealFromPlan(plan.document.days[0].meals[0]) }).throwOnError()
  const mealBefore = (await fixture.a.client.from('meal_logs').select('*')).data
  const previous = { url: process.env.VITE_SUPABASE_URL, key: process.env.VITE_SUPABASE_PUBLISHABLE_KEY }
  try {
    process.env.VITE_SUPABASE_URL = fixture.config.apiUrl; process.env.VITE_SUPABASE_PUBLISHABLE_KEY = fixture.config.publishableKey ?? fixture.config.publicKey
    await build({ configFile: false, plugins: [react()], logLevel: 'warn', build: { outDir: resolve(directory, 'browser-app'), emptyOutDir: true, target: 'safari16' } })
  } finally {
    if (previous.url === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = previous.url
    if (previous.key === undefined) delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY; else process.env.VITE_SUPABASE_PUBLISHABLE_KEY = previous.key
  }
  const headers = await readFile('public/_headers', 'utf8')
  server = await serveStatic({ dist: resolve(directory, 'browser-app'), csp: /Content-Security-Policy:\s*(.+)/.exec(headers)[1].replace('__SUPABASE_ORIGIN__', fixture.config.apiUrl) })
  tab = await openTab(); await tab.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Rome' })
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const NativeDate=Date,fixed=NativeDate.parse(${JSON.stringify(`${tuesday}T10:00:00Z`)}),boot=performance.now();class FixtureDate extends NativeDate{constructor(...args){super(...(args.length?args:[fixed+performance.now()-boot]))}static now(){return fixed+performance.now()-boot}}window.Date=FixtureDate;localStorage.setItem('sb-127-auth-token',${JSON.stringify(JSON.stringify({ ...fixture.a.session, expires_at: Date.parse(`${tuesday}T10:00:00Z`) / 1000 + 3600 }))});localStorage.setItem('peppitness:returning-device','1')})()` })
  await tab.viewport(390, 844, true)
  await tab.navigate(`${server.origin}/#/scheda`, `!!document.querySelector('.rest-day')`); await synced()
  check(await tab.evaluate(`document.querySelectorAll('.rest-day .button.primary').length===1 && !document.querySelector('.rest-day-options').open && !document.querySelector('.rest-day').innerText.includes('Lunedì sintetico')`), 'Riposo: una CTA primaria e schede manuali nascoste nel link')
  await tab.click('.rest-day-options > summary'); await tab.click('.rest-day-sessions > summary'); await tab.click('.rest-day-session-list button')
  await tab.until(`!!document.querySelector('.workout-summary')`)
  check(await tab.evaluate(`document.querySelector('#workout-title').textContent.includes('Lunedì sintetico') && !document.querySelectorAll('.week-day')[1].querySelector('.is-planned')`), 'Scelta manuale dal riposo mostra la scheda senza spostare il calendario')
  check((await fixture.a.client.from('workout_day_swaps').select('id')).data.length===0 && (await fixture.a.client.from('workout_sessions').select('id')).data.length===0, 'Scelta manuale non crea scambi o sessioni')
  await tab.click('.workout-card-menu-button'); await tab.click('dialog button[aria-label="Scegli un’altra seduta"]')
  await tab.until(`!!document.querySelector('.session-picker')`); await tab.click('.session-picker li:nth-child(2) button')
  await tab.until(`document.querySelector('#workout-title')?.textContent.includes('Mercoledì sintetico')`)
  check(true, 'Menu: scelta di un’altra seduta apre il pannello manuale e conserva il riposo programmato')
  await tab.click('.workout-return-rest'); await tab.until(`!!document.querySelector('.rest-day')`)
  check(await tab.evaluate(`!document.querySelector('.rest-day-options').open`), 'Torna al riposo richiude la scelta manuale')
  await tab.click('.week-day:nth-child(1)'); await tab.until(`!!document.querySelector('.workout-summary')`)
  await layout('anteprima')
  check(await tab.evaluate(`document.querySelector('.workout-summary').getBoundingClientRect().height < 236 && document.querySelector('.workout-card-menu-button').getBoundingClientRect().height >= 40 && !document.querySelector('.workout-summary .day-swap-open')`), 'Card compatta: solo avvio primario e menu con area di tocco conservata')
  await tab.click('.workout-card-menu-button'); await tab.until(`!!document.querySelector('.workout-card-menu')`)
  await layout('menu-allenamento')
  check(await tab.evaluate(`document.querySelector('.workout-card-menu').textContent.includes('La programmazione non cambia') && !!document.querySelector('.workout-card-menu [aria-label="Sposta allenamento"]')`), 'Menu distingue scelta manuale e scambio del calendario')
  await tab.click('dialog button[aria-label="Sposta allenamento"]'); await tab.until(`!!document.querySelector('.day-swap-panel')`)
  check(await tab.evaluate(`document.querySelectorAll('dialog[open]').length===1 && document.querySelector('.day-swap-source-toggle').dataset.date===${JSON.stringify(monday)}`), 'Sposta dal menu apre il pannello con la sorgente già scelta e un solo dialog')
  await tab.key('Escape', 'Escape', 27)
  check(await tab.evaluate(`document.activeElement.classList.contains('workout-card-menu-button')`), 'Sposta dal menu conserva il focus dopo Escape')
  await tab.click('.week-day:nth-child(2)'); await tab.until(`!!document.querySelector('.rest-day')`)
  await layout('riposo')
  await clickText('.rest-day .day-swap-controls button', 'Sposta un allenamento qui')
  check(await tab.evaluate(`!!document.querySelector('dialog[open][aria-label="Sposta allenamento"]')`), 'Accesso dal riposo di martedì')
  check(await tab.evaluate(`!document.querySelector('.day-swap-panel select') && document.querySelector('fieldset legend').textContent.includes('Quale allenamento')`), 'Pannello dal riposo senza select native, selezione sorgente esplicita')
  await layout('sorgente')
  await pickSource(monday)
  await tab.click('.day-swap-source-toggle'); await tab.click(`.day-swap-choice:has(input[name="swap-source"][value="${monday}"])`)
  check(await tab.evaluate(`!!document.querySelector('input[name="swap-target"]') && document.querySelector('.day-swap-source-toggle').dataset.date===${JSON.stringify(monday)}`), 'Riconfermare la sorgente selezionata torna alle destinazioni senza cambiare i valori')
  await tab.evaluate(`document.querySelector('input[name="swap-target"]:checked').focus()`)
  await tab.key('ArrowDown', 'ArrowDown', 40)
  check(await tab.evaluate(`document.querySelector('input[name="swap-target"]:checked').value===${JSON.stringify(wednesday)}`), 'Tastiera: freccia seleziona la prossima destinazione disponibile')
  await tab.key('ArrowUp', 'ArrowUp', 38)
  check(await tab.evaluate(`document.querySelector('input[name="swap-target"]:checked').value===${JSON.stringify(tuesday)} && document.querySelector('.day-swap-choice.is-selected').getBoundingClientRect().height>=44`), 'Tastiera: ritorno a oggi e area di tocco ampia')
  check(await tab.evaluate(`document.querySelector('.day-swap-effects').textContent.includes('Riposo') && document.querySelector('input[name="swap-target"]:checked').value===${JSON.stringify(tuesday)}`), 'Recupero lunedì non avviato con destinazione oggi e anteprima dei due effetti')
  check(await tab.evaluate(`document.querySelector('input[name="swap-target"][value="${monday}"]').disabled`), 'Destinazione passata disabilitata con spiegazione')
  check(await tab.evaluate(`!document.querySelector('.day-swap-panel .button.primary').disabled`), 'Conferma abilitata dopo scelta valida')
  await layout('pannello')
  check(await tab.evaluate(`(()=>{const d=document.querySelector('dialog[open]'),b=d.querySelector('.button.primary');return b.getBoundingClientRect().bottom<=d.getBoundingClientRect().bottom})()`), 'Conferma del pannello visibile insieme al riepilogo a 390 px')
  await tab.key('Escape', 'Escape', 27)
  check(await tab.evaluate(`!document.querySelector('dialog[open]') && document.activeElement.textContent==='Sposta un allenamento qui'`), 'Escape chiude senza cambiare calendario e ripristina focus')
  await clickText('.rest-day .day-swap-controls button', 'Sposta un allenamento qui'); await pickSource(monday)
  await clickText('dialog button', 'Sposta'); await synced()
  check(await tab.evaluate(`!!document.querySelector('.workout-start') && document.querySelector('#workout-title').textContent.includes('Lunedì sintetico')`), 'Dopo lo scambio martedì propone A immediatamente')
  check(await tab.evaluate(`!document.querySelectorAll('.week-day')[0].querySelector('.is-planned') && !!document.querySelectorAll('.week-day')[1].querySelector('.is-planned')`), 'Calendario sposta il marcatore dal lunedì al martedì')
  await tab.click('.week-day:nth-child(1)'); await tab.until(`!!document.querySelector('.rest-day')`)
  check(await tab.evaluate(`document.querySelector('.day-swap-notice').textContent.includes('Annulla spostamento')`), 'Lunedì riposo e annullamento sempre raggiungibile')
  await route('/dieta'); await tab.until(`!!document.querySelector('.day-type') || !!document.querySelector('.day-type-hint')?.textContent.includes('Dalla tua scheda') && [...document.querySelectorAll('.day-type [aria-pressed="true"]')].some(el=>el.textContent.includes('Palestra'))`)
  check(await tab.evaluate(`!document.querySelector('.day-type-hint')?.textContent.includes('Dalla tua scheda') && [...document.querySelectorAll('.day-type [aria-pressed="true"]')].some(el=>el.textContent.includes('Palestra'))`), 'Scelta manuale del lunedì conservata dopo cambio calendario')
  await tab.click('.week-day:nth-child(2)')
  check(await tab.evaluate(`document.body.textContent.includes('Dalla tua scheda: giorno di allenamento')`), 'Dieta suggerisce allenamento martedì dal calendario effettivo')
  await route('/scheda'); await tab.until(`!!document.querySelector('.day-swap-notice')`)
  await tab.send('Page.reload'); await tab.until(`!!document.querySelector('.workout-start') && !!document.querySelector('.day-swap-notice')`); await synced()
  check(true, 'Reload recupera lo spostamento dal diario persistente')
  await clickText('.day-swap-notice button', 'Annulla spostamento'); await synced(); await tab.until(`!!document.querySelector('.rest-day')`)
  check(await tab.evaluate(`!!document.querySelectorAll('.week-day')[0].querySelector('.is-planned') && !document.querySelectorAll('.week-day')[1].querySelector('.is-planned')`), 'Undo ripristina le due giornate e i marcatori')
  await clickText('.rest-day .day-swap-controls button', 'Sposta un allenamento qui'); await pickSource(monday)
  await pickTarget(wednesday)
  check(await tab.evaluate(`document.querySelector('.day-swap-effects').textContent.includes('Mercoledì sintetico') && [...document.querySelectorAll('dialog button')].some(el=>el.textContent==='Scambia')`), 'Anteprima A/B con singola conferma Scambia')
  await clickText('dialog button', 'Scambia'); await synced(); await clickText('.day-swap-notice button', 'Annulla spostamento'); await synced()
  // Cache reali e coda: offline, reload, poi avvio dipendente, poi riconnessione.
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: `${fixture.config.apiUrl}/*` }] })
  const offlineHandler = event => { void tab.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'InternetDisconnected' }); return true }
  tab.fetchHandlers.push(offlineHandler)
  await tab.evaluate(`window.dispatchEvent(new Event('offline'))`)
  await clickText('.rest-day .day-swap-controls button', 'Sposta un allenamento qui'); await pickSource(monday); await clickText('dialog button', 'Sposta')
  await tab.until(`!!document.querySelector('[data-sync="waiting"]')`)
  check(!await tab.evaluate(`!!document.querySelector('[data-sync="synced"]')`), 'Scambio offline dichiarato salvato sul dispositivo')
  await tab.send('Page.reload'); await tab.until(`!!document.querySelector('.workout-start') && !!document.querySelector('.day-swap-notice')`)
  check(await tab.evaluate(`!!document.querySelector('[data-sync="waiting"], [data-sync="pending"], [data-sync="sending"]')`), 'Reload offline conserva lo scambio non sincronizzato')
  await clickText('.workout-start', 'Inizia allenamento'); await tab.until(`!!document.querySelector('.session-page')`)
  check((await fixture.a.client.from('workout_sessions').select('id')).data.length === 0, 'Avvio offline resta locale e non anticipa lo scambio')
  await tab.send('Fetch.disable'); tab.fetchHandlers.splice(tab.fetchHandlers.indexOf(offlineHandler), 1)
  await tab.evaluate(`window.dispatchEvent(new Event('online'))`); await synced()
  if (await tab.evaluate(`!!document.querySelector('.stale-later')`)) await tab.click('.stale-later')
  const active = (await fixture.a.client.from('workout_sessions').select('*')).data
  check(active.length === 1 && active[0].diary_date === tuesday && active[0].day_snapshot.label === 'Lun', 'Riconnessione: scambio prima dell’avvio nella data effettiva')
  await route('/scheda'); await tab.until(`!!document.querySelector('.day-swap-notice')`)
  check(await tab.evaluate(`![...document.querySelectorAll('.day-swap-controls button')].some(el=>/Annulla spostamento|Sposta allenamento/.test(el.textContent))`), 'Dopo avvio nessuno scambio o undo eseguibile sulle date coinvolte')
  await route('/scheda/seduta'); await tab.until(`!!document.querySelector('.session-finish')`)
  await tab.evaluate(`document.querySelector('.session-finish').click()`); await tab.until(`!!document.querySelector('.session-finish-confirm')`); await tab.click('.session-finish-confirm'); await synced()
  await clickText('dialog button', 'Fatto'); await route('/scheda'); await tab.until(`!!document.querySelector('.week-strip')`)
  check(await tab.evaluate(`!!document.querySelectorAll('.week-day')[1].querySelector('.is-done') && !document.querySelectorAll('.week-day')[0].querySelector('.is-done')`), 'Calendario del completato marca martedì e non lunedì')
  await route('/scheda/progressi'); await tab.until(`!!document.querySelector('.week-slots')`)
  check(await tab.evaluate(`!!document.querySelector('.week-rows li.is-current .slot.is-done[aria-label^="Mar"]') && !document.querySelector('.week-rows li.is-current .slot[aria-label^="Lun"]')`), 'Progressi mostrano Mar completato senza duplicare Lun')
  check(JSON.stringify((await fixture.a.client.from('meal_logs').select('*')).data) === JSON.stringify(mealBefore), 'Pasti, note e snapshot già registrati invariati')
  const dayTypes = (await fixture.a.client.from('diary_days').select('*')).data
  check(dayTypes.length === 1 && dayTypes[0].day_type === 'training' && dayTypes[0].diary_date === monday, 'Scelta manuale tipo giornata invariata nel database')
  check(tab.requests.every(url => !/^https?:/.test(url) || new URL(url).hostname === '127.0.0.1'), 'Nessuna richiesta cloud')
  const unexpected = tab.errors.filter(error => !/ERR_INTERNET_DISCONNECTED|ERR_BLOCKED_BY_CLIENT|Failed to fetch|net::ERR_FAILED/.test(error))
  check(unexpected.length === 0, `Nessun errore browser inatteso: ${unexpected.join('; ')}`)
  await writeFile(resolve(directory, 'browser.json'), JSON.stringify({ result: 'PASS', checks }, null, 2))
} catch (error) {
  if (tab) { console.log(await tab.evaluate('document.body.innerText')); console.log(tab.errors); await tab.screenshot(resolve(directory, 'failure.png')) }
  throw error
} finally { await tab?.close(); await server?.stop(); await chrome.stop(); await fixture?.cleanup() }
