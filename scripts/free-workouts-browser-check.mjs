// App completa e backend locale reale; account e contenuti esclusivamente sintetici.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { workoutChangesFixture } from './lib/workout-changes-local-fixture.mjs'
import { ensureChrome, openTab, serveStatic, pause } from './lib/import-browser-harness.mjs'
import { shiftDate } from '../src/domain/dates.ts'

const directory = resolve('artifacts/free-workouts'), checks = []
await mkdir(directory, { recursive: true })
const chrome = await ensureChrome()
let fixture, tab, server
const check = (condition, label) => { assert.ok(condition, label); checks.push(label); console.log(`PASS ${label}`) }
const clickText = async (selector, text) => {
  await tab.evaluate(`document.querySelectorAll('[data-free-test]').forEach(el=>el.removeAttribute('data-free-test'));(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!el)throw Error('Pulsante assente: '+${JSON.stringify(text)});el.setAttribute('data-free-test','click')})()`)
  await tab.click('[data-free-test="click"]')
}
const input = async (selector, value) => {
  await tab.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))})()`); await pause(100)
}
const synced = () => tab.until(`!!document.querySelector('[data-sync="synced"]') && !document.querySelector('[data-sync="pending"], [data-sync="sending"], [data-sync="waiting"], [data-sync="conflict"]')`, 'sincronizzato', 500)
const route = async path => { await tab.evaluate(`location.hash=${JSON.stringify(path)}`); await pause(180) }
const layout = async label => {
  for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
    await tab.viewport(width, 844, true); await tab.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`); await pause(200)
    check(await tab.evaluate(`(()=>{const d=document.querySelector('dialog[open]');return document.documentElement.scrollWidth<=innerWidth&&(!d||d.scrollWidth<=d.clientWidth+1)})()`), `${label}: ${width}px ${theme} senza overflow`)
    await tab.screenshot(resolve(directory, `${label}-${width}-${theme}.png`))
  }
}
const choose = async name => {
  await tab.click('.session-add-button'); await tab.until(`!!document.querySelector('dialog .wz-search input')`)
  await input('dialog .wz-search input', name)
  await tab.evaluate(`(()=>{const el=[...document.querySelectorAll('dialog .wz-results button')].find(el=>el.querySelector('strong')?.textContent===${JSON.stringify(name)});if(!el)throw Error('Esercizio assente');el.setAttribute('data-free-test','exercise')})()`)
  await tab.click('[data-free-test="exercise"]'); await tab.until(`!!document.querySelector('.session-exercise-proposal')`)
}
try {
  fixture = await workoutChangesFixture()
  const tuesday = shiftDate(fixture.monday, 1)
  const previous = { url: process.env.VITE_SUPABASE_URL, key: process.env.VITE_SUPABASE_PUBLISHABLE_KEY }
  try {
    process.env.VITE_SUPABASE_URL = fixture.config.apiUrl; process.env.VITE_SUPABASE_PUBLISHABLE_KEY = fixture.config.publishableKey
    await build({ configFile: false, plugins: [react()], logLevel: 'warn', build: { outDir: resolve(directory, 'browser-app'), emptyOutDir: true, target: 'safari16' } })
  } finally {
    if (previous.url === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = previous.url
    if (previous.key === undefined) delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY; else process.env.VITE_SUPABASE_PUBLISHABLE_KEY = previous.key
  }
  const headers = await readFile('public/_headers', 'utf8')
  server = await serveStatic({ dist: resolve(directory, 'browser-app'), csp: /Content-Security-Policy:\s*(.+)/.exec(headers)[1].replace('__SUPABASE_ORIGIN__', fixture.config.apiUrl) })
  tab = await openTab(); await tab.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Rome' })
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const NativeDate=Date,fixed=NativeDate.parse(${JSON.stringify(`${tuesday}T10:00:00Z`)}),boot=performance.now();class FixtureDate extends NativeDate{constructor(...args){super(...(args.length?args:[fixed+performance.now()-boot]))}static now(){return fixed+performance.now()-boot}}window.Date=FixtureDate;localStorage.setItem('sb-127-auth-token',${JSON.stringify(JSON.stringify({ ...fixture.a.session, expires_at: Date.parse(`${tuesday}T10:00:00Z`) / 1000 + 3600 }))});localStorage.setItem('peppitness:returning-device','1')})()` })
  await tab.viewport(390, 844, true); await tab.navigate(`${server.origin}/#/scheda`, `!!document.querySelector('.rest-day')`); await synced()
  await tab.click('.rest-day-options summary'); await tab.click('.free-workout-choice')
  await tab.until(`!!document.querySelector('.free-workout-intro')`)
  check((await fixture.a.client.from('workout_sessions').select('id').setHeader('X-Peppitness-Diary', 'free-v1')).data.length === 0, 'Anteprima libera non crea sessioni')
  await layout('anteprima-libera'); await tab.key('Escape', 'Escape', 27)
  check(await tab.evaluate(`document.activeElement.classList.contains('free-workout-choice')`), 'Escape conserva il focus e non avvia')
  await tab.click('.free-workout-choice'); await tab.click('.free-workout-start'); await tab.until(`!!document.querySelector('.free-workout-empty')`); await synced()
  check(await tab.evaluate(`!document.querySelector('.session-finish') && !!document.querySelector('.session-add-button.primary') && !document.querySelector('.session-progress')`), 'Seduta vuota: aggiunta primaria, nessun completamento o avanzamento fittizio')
  if (await tab.evaluate(`!!document.querySelector('.stale-later')`)) await tab.click('.stale-later')
  await layout('seduta-vuota')
  await route('/scheda'); await tab.until(`!!document.querySelector('.rest-active-resume')`)
  check(await tab.evaluate(`!document.querySelector('.rest-day .day-swap-open,.workout-cancel') && document.querySelector('.rest-active-resume').textContent.includes('Riprendi')`), 'Una seduta già attiva ha una sola CTA di ripresa nel giorno di riposo')
  await tab.click('.rest-active-heading button'); await tab.click('.rest-active-discard')
  await tab.until(`!!document.querySelector('.workout-cancel-keep')`)
  check((await fixture.a.client.from('workout_sessions').select('id').setHeader('X-Peppitness-Diary', 'free-v1')).data.length === 1, 'Annullamento dal menu chiede conferma senza eliminare la seduta')
  await tab.click('.workout-cancel-keep')
  check(await tab.evaluate(`!!document.querySelector('.rest-active-resume') && !document.querySelector('dialog[open]')`), 'Continua conserva la seduta e chiude la conferma')
  await tab.click('.rest-active-resume'); await tab.until(`!!document.querySelector('.session-add-button')`)
  // Offline: catalogo già scaricato, aggiunta e minuti subito visibili, poi reload e sync.
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: `${fixture.config.apiUrl}/*` }] })
  const offlineHandler = event => { void tab.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'InternetDisconnected' }); return true }
  tab.fetchHandlers.push(offlineHandler); await tab.evaluate(`window.dispatchEvent(new Event('offline'))`)
  await choose('Tapis roulant')
  check(await tab.evaluate(`!!document.querySelector('input[aria-label="Minuti svolti"]') && !document.querySelector('input[aria-label="Serie"],input[aria-label="Recupero in secondi"]')`), 'Solo cardio: basta inserire i minuti effettivi')
  await input('input[aria-label="Minuti svolti"]', '60'); await layout('minuti-cardio')
  await clickText('dialog button', 'Aggiungi e registra'); await tab.until(`!!document.querySelector('.set-panel')`); if (await tab.evaluate(`!!document.querySelector('.set-summary')`)) await tab.click('.set-summary')
  await tab.click('.session-note-add'); await input('.session-note textarea', 'Un’ora di cardio libero')
  await tab.until(`!!document.querySelector('[data-sync="waiting"]')`)
  check(await tab.evaluate(`document.querySelector('.set-row input[aria-label*="minuti"]').value==='60' && !document.querySelector('.rest-timer')`), '60 minuti effettivi registrati e nessun recupero fittizio')
  await tab.send('Page.reload'); await tab.until(`!!document.querySelector('.set-panel')`)
  if (await tab.evaluate(`!!document.querySelector('.stale-later')`)) await tab.click('.stale-later')
  if (await tab.evaluate(`!!document.querySelector('.set-summary')`)) await tab.click('.set-summary')
  check(await tab.evaluate(`document.querySelector('.session-note textarea').value==='Un’ora di cardio libero' && document.querySelector('.set-row input[aria-label*="minuti"]').value==='60'`), 'Reload offline conserva attività, minuti e nota')
  await tab.send('Fetch.disable'); tab.fetchHandlers.splice(tab.fetchHandlers.indexOf(offlineHandler), 1)
  await tab.evaluate(`window.dispatchEvent(new Event('online'))`); await synced()
  if (await tab.evaluate(`!!document.querySelector('.stale-later')`)) await tab.click('.stale-later')
  const logs = (await fixture.a.client.from('workout_set_logs').select('*').setHeader('X-Peppitness-Diary', 'free-v1')).data
  check(logs.length === 1 && Number(logs[0].amount) === 3600 && logs[0].completed, 'Riconnessione salva 3600 secondi con una sola registrazione')
  await choose('Spinta con manubri')
  await input('input[aria-label="Serie"]', '1'); await input('input[aria-label="Ripetizioni minime"]', '8'); await input('input[aria-label="Ripetizioni massime"]', '8'); await input('input[aria-label="Recupero in secondi"]', '0')
  await clickText('dialog button', 'Conferma aggiunta'); await tab.until(`document.querySelectorAll('.set-panel').length===2`)
  const strength = await tab.evaluate(`[...document.querySelectorAll('.set-panel')].find(el=>el.querySelector('h2')?.textContent==='Spinta con manubri').id`)
  await input(`#${strength} input[aria-label*="carico"]`, '20'); await input(`#${strength} input[aria-label*="ripetizioni"]`, '8'); await tab.click(`#${strength} .set-check`); await synced()
  check(true, 'Allenamento libero misto: aggiunta progressiva di un esercizio e registrazione carico/ripetizioni')
  await layout('seduta-mista')
  await tab.evaluate(`document.querySelector('.session-finish').click()`); await tab.until(`!!document.querySelector('.session-summary')`); await synced()
  check(await tab.evaluate(`document.querySelector('.free-cardio-total').textContent.includes('60 min')`), 'Riepilogo distingue 60 minuti cardio dal tempo trascorso nell’app')
  await clickText('dialog button', 'Fatto'); await route('/scheda/storico'); await tab.until(`!!document.querySelector('.history-card')`)
  check(await tab.evaluate(`document.querySelector('.history-card').textContent.includes('Allenamento libero') && document.querySelector('.history-card').textContent.includes('60 min cardio')`), 'Storico identifica allenamento libero e durata cardio')
  await tab.click('.history-card'); await tab.until(`!!document.querySelector('.session-status.finished')`)
  check(await tab.evaluate(`document.querySelectorAll('.set-panel').length===2 && !document.querySelector('.session-add-button') && document.body.textContent.includes('Un’ora di cardio libero')`), 'Storico riletto con esercizi, risultati e nota')
  await route('/scheda'); await tab.until(`!!document.querySelector('.week-strip')`)
  check(await tab.evaluate(`document.querySelectorAll('.week-day')[1].getAttribute('aria-label').includes('allenamento libero completato') && !!document.querySelectorAll('.week-day')[0].querySelector('.is-planned')`), 'Calendario: libera completata martedì e lunedì ancora previsto')
  await route('/scheda/progressi'); await tab.until(`!!document.querySelector('.week-slots')`)
  check(await tab.evaluate(`!!document.querySelector('.slot-extra[aria-label="1 allenamento extra"]') && !document.querySelector('.week-slots .slot.is-done')`), 'Progressi: un extra, nessuna seduta prevista segnata fatta')
  check((await fixture.a.client.from('diary_days').select('*')).data.length === 0 && (await fixture.a.client.from('workout_day_swaps').select('*')).data.length === 0, 'Nessuna modifica al tipo giornata Dieta o agli scambi')
  // Avvio da programma e annullamento della libera vuota senza perdere lo storico.
  await route('/scheda'); await tab.click('.week-day:nth-child(1)'); await tab.until(`!!document.querySelector('.workout-card-menu-button')`)
  await tab.click('.workout-card-menu-button'); await tab.click('dialog [aria-label="Scegli un’altra seduta"]'); await tab.click('.free-workout-choice')
  check(await tab.evaluate(`document.querySelectorAll('dialog[open]').length===1 && !!document.querySelector('.free-workout-intro')`), 'Allenamento libero raggiungibile anche dalla scelta di un’altra seduta')
  await tab.click('.free-workout-start'); await tab.until(`!!document.querySelector('.free-workout-empty')`); await synced()
  if (await tab.evaluate(`!!document.querySelector('.stale-later')`)) await tab.click('.stale-later')
  await tab.click('.session-more'); await tab.click('.session-discard'); await tab.click('.session-discard-confirm'); await synced()
  const sessions = (await fixture.a.client.from('workout_sessions').select('*').setHeader('X-Peppitness-Diary', 'free-v1')).data
  check(sessions.length===1 && sessions[0].status==='completed' && sessions[0].session_kind==='free', 'Eliminare una libera vuota conserva quella completata')
  check(tab.requests.every(url => !/^https?:/.test(url) || new URL(url).hostname === '127.0.0.1'), 'Nessuna richiesta cloud')
  const unexpected = tab.errors.filter(error => !/ERR_INTERNET_DISCONNECTED|ERR_BLOCKED_BY_CLIENT|Failed to fetch|net::ERR_FAILED/.test(error))
  check(unexpected.length===0, `Nessun errore browser inatteso: ${unexpected.join('; ')}`)
  await writeFile(resolve(directory, 'browser.json'), JSON.stringify({ result: 'PASS', checks }, null, 2))
} catch(error) {
  if(tab) { console.log(await tab.evaluate('document.body.innerText')); console.log(tab.errors); await tab.screenshot(resolve(directory,'failure.png')) }
  throw error
} finally { await tab?.close(); await server?.stop(); await chrome.stop(); await fixture?.cleanup() }
