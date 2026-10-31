// App completa con Auth e database locali reali; dati esclusivamente sintetici.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { workoutChangesFixture } from './lib/workout-changes-local-fixture.mjs'
import { ensureChrome, openTab, serveStatic, pause } from './lib/import-browser-harness.mjs'

const directory = resolve('artifacts/session-exercises'), checks = []
await mkdir(directory, { recursive: true })
const chrome = await ensureChrome()
let fixture, tab, server
const check = (condition, name) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`) }
const clickText = async (selector, text) => {
  await tab.evaluate(`document.querySelectorAll('[data-session-target]').forEach(el=>el.removeAttribute('data-session-target')); (()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!el)throw Error('Pulsante assente: '+${JSON.stringify(text)});el.setAttribute('data-session-target','click')})()`)
  await tab.click('[data-session-target="click"]')
}
const input = async (selector, value) => {
  await tab.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('Campo assente: '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`)
  await pause(80)
}
const synced = () => tab.until(`JSON.parse(localStorage.getItem(${JSON.stringify(`peppitness:diary:v2:${fixture.a.owner}`)})||'{}').queue?.length===0`, 'coda sincronizzata')
const cardIds = () => tab.evaluate(`[...document.querySelectorAll('.set-panel')].map(el=>el.id)`)
const addedCard = (name, occurrence = 0) => tab.evaluate(`[...document.querySelectorAll('.set-panel')].filter(el=>el.querySelector('h2')?.textContent===${JSON.stringify(name)})[${occurrence}]?.id`)
const choose = async name => {
  await input('dialog[open] .wz-search input', name)
  await tab.evaluate(`(()=>{const el=[...document.querySelectorAll('dialog[open] .wz-results button')].find(el=>el.querySelector('strong')?.textContent===${JSON.stringify(name)});if(!el)throw Error('Esercizio assente');el.setAttribute('data-session-target','choice')})()`)
  await tab.click('[data-session-target="choice"]')
  await tab.until(`!!document.querySelector('.session-exercise-proposal')`)
}
const dose = async (timed = false, cardio = false) => {
  await input('dialog input[aria-label="Serie"]', '2')
  if (timed) await input(`dialog input[aria-label="Durata in ${cardio ? 'minuti' : 'secondi'}"]`, cardio ? '2,5' : '30')
  else { await input('dialog input[aria-label="Ripetizioni minime"]', '8'); await input('dialog input[aria-label="Ripetizioni massime"]', '12') }
  await input('dialog input[aria-label="Recupero in secondi"]', '60')
}
const beginAdd = async name => { await tab.click('.session-add-button'); await choose(name) }
const confirmAdd = async () => { await clickText('dialog button', 'Conferma aggiunta'); await tab.until(`!document.querySelector('dialog[open]')`) }
const layout = async label => {
  for (const width of [320, 390]) for (const theme of ['light', 'dark']) {
    await tab.viewport(width, 844, true)
    await tab.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
    const okay = await tab.evaluate(`(()=>{const d=document.querySelector('dialog[open]');const a=document.querySelector('.session-add-button')?.getBoundingClientRect(),f=document.querySelector('.session-finish')?.getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&(!d||d.scrollWidth<=d.clientWidth+1)&&(!a||a.left>=f.right-1&&Math.abs(a.top-f.top)<2)})()`)
    check(okay, `${label}: ${width}px ${theme}, nessun overflow e pulsanti affiancati`)
    await tab.screenshot(resolve(directory, `${label}-${width}-${theme}.png`))
  }
}
try {
  fixture = await workoutChangesFixture()
  const previous = { url: process.env.VITE_SUPABASE_URL, key: process.env.VITE_SUPABASE_PUBLISHABLE_KEY }
  try {
    process.env.VITE_SUPABASE_URL = fixture.config.apiUrl
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY = fixture.config.publishableKey
    await build({ configFile: false, envDir: directory, root: process.cwd(), plugins: [react()], logLevel: 'warn', build: { outDir: resolve(directory, 'browser-app'), emptyOutDir: true, target: 'safari16' } })
  } finally {
    if (previous.url === undefined) delete process.env.VITE_SUPABASE_URL; else process.env.VITE_SUPABASE_URL = previous.url
    if (previous.key === undefined) delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY; else process.env.VITE_SUPABASE_PUBLISHABLE_KEY = previous.key
  }
  const headers = await readFile('public/_headers', 'utf8')
  server = await serveStatic({ dist: resolve(directory, 'browser-app'), csp: /Content-Security-Policy:\s*(.+)/.exec(headers)[1].replace('__SUPABASE_ORIGIN__', fixture.config.apiUrl) })
  tab = await openTab()
  await tab.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Rome' })
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `(()=>{const NativeDate=Date,fixed=NativeDate.parse(${JSON.stringify(`${fixture.monday}T10:00:00Z`)}),boot=performance.now();class FixtureDate extends NativeDate{constructor(...args){super(...(args.length?args:[fixed+performance.now()-boot]))}static now(){return fixed+performance.now()-boot}}window.Date=FixtureDate;localStorage.setItem('sb-127-auth-token',${JSON.stringify(JSON.stringify(fixture.a.session))});localStorage.setItem('peppitness:returning-device','1')})()` })
  await tab.viewport(390, 844, true)
  await tab.navigate(`${server.origin}/#/scheda`, `!!document.querySelector('.workout-start')`)
  await clickText('.workout-start', 'Inizia allenamento')
  await tab.until(`!!document.querySelector('.session-add-button')`); await synced()
  const originalIds = await cardIds(), chest = originalIds[0], stairs = originalIds[1]
  await layout('seduta')
  check(await tab.evaluate(`!document.querySelector('.session-status:not(.finished)') && !document.querySelector('.session-actions').previousElementSibling?.matches('.session-footer-summary')`), 'Nessuna etichetta In corso o contatore ripristinato sopra i pulsanti')
  await beginAdd('Spinta con manubri')
  check(await tab.evaluate(`document.querySelector('dialog select[aria-label="Posizione"]').value==='end' && document.querySelector('dialog input[aria-label="Serie"]').value==='' && document.querySelector('dialog input[aria-label="Recupero in secondi"]').value==='0'`), 'Nessun riferimento: fine lista e prescrizione iniziale indipendente dal precedente')
  await tab.key('Escape', 'Escape', 27)
  // Completa l’esercizio iniziale; il passaggio automatico alla card successiva non cambia il riferimento.
  for (let index = 0; index < 3; index++) {
    await input(`#${chest} .set-row:nth-child(${index + 2}) input[aria-label*="carico"]`, '20')
    await input(`#${chest} .set-row:nth-child(${index + 2}) input[aria-label*="ripetizioni"]`, '8')
    await tab.click(`#${chest} .set-row:nth-child(${index + 2}) .set-check`)
  }
  await tab.until(`document.getElementById(${JSON.stringify(chest)}).classList.contains('is-collapsed')`)
  await pause(450)
  await beginAdd('Spinta con manubri')
  check(await tab.evaluate(`document.querySelector('dialog select[aria-label="Posizione"] option:checked').textContent==='Dopo Chest press'`), 'Proposta dopo il completato conservata attraverso il passaggio automatico')
  await dose(); await layout('aggiunta'); await confirmAdd()
  const strength = await addedCard('Spinta con manubri')
  check((await cardIds())[1] === strength, 'Conferma predefinita inserisce fra completato e successivo')
  check(await tab.evaluate(`document.querySelector('.session-progress progress').max===7 && document.querySelector('.session-progress strong').textContent==='43%'`), 'Nuove serie aggiornano conteggio e percentuale di avanzamento')
  check(await tab.evaluate(`(()=>{const r=document.getElementById(${JSON.stringify(strength)}).getBoundingClientRect();return r.top>=0&&r.top<innerHeight})()`), 'Nuova card portata in vista dopo la conferma')
  await beginAdd('Tapis roulant'); await dose(true, true)
  await input('dialog select[aria-label="Posizione"]', stairs.slice(-36))
  await confirmAdd()
  const cardio = await addedCard('Tapis roulant')
  let ids = await cardIds()
  check(ids.indexOf(cardio) === ids.indexOf(stairs) + 1, 'Scelta esplicita Dopo Stairs Master prevale sul completato')
  check(await tab.evaluate(`document.getElementById(${JSON.stringify(cardio)}).textContent.includes('2,5 min') && !document.getElementById(${JSON.stringify(cardio)}).querySelector('input[aria-label*="carico"]')`), 'Cardio: minuti visibili, durata canonica e nessun carico')
  await beginAdd('Spinta con manubri'); await dose()
  check(await tab.evaluate(`document.querySelector('.session-duplicate')?.textContent.includes('già presente') && [...document.querySelectorAll('dialog button')].find(el=>el.textContent==='Conferma aggiunta').disabled`), 'Duplicato bloccato fino alla scelta esplicita')
  await tab.click('.session-duplicate input')
  await input('dialog select[aria-label="Posizione"]', 'start'); await confirmAdd()
  const duplicate = (await cardIds())[0]
  check(duplicate !== strength, 'Duplicato all’inizio con ID diverso dall’altra occorrenza')
  await beginAdd('Plank')
  check(await tab.evaluate(`new Set([...document.querySelectorAll('dialog select option')].filter(el=>el.textContent.includes('Spinta con manubri')).map(el=>el.textContent)).size===2`), 'Nomi duplicati distinguibili nella scelta della posizione')
  await dose(true); await input('dialog select[aria-label="Posizione"]', 'end')
  await tab.click('.session-duplicate input'); await confirmAdd()
  const plank = (await cardIds()).at(-1)
  check(await tab.evaluate(`!!document.getElementById(${JSON.stringify(plank)}).querySelector('input[aria-label*="secondi"]')`), 'Esercizio a tempo aggiunto alla fine in secondi')
  await input(`#${strength} .set-row input[aria-label*="carico"]`, '22,5')
  await input(`#${strength} .set-row input[aria-label*="ripetizioni"]`, '9')
  await clickText(`#${strength} .session-added-actions button`, 'Sposta')
  await layout('spostamento')
  check(await tab.evaluate(`![...document.querySelectorAll('dialog select option')].some(el=>el.value===${JSON.stringify(strength.slice(-36))})`), 'Sposta esclude l’occorrenza stessa')
  await input('dialog select', 'start'); await clickText('dialog button', 'Conferma spostamento')
  check((await cardIds())[0] === strength && await tab.evaluate(`document.getElementById(${JSON.stringify(strength)}).querySelector('input[aria-label*="carico"]').value==='22,5'`), 'Spostamento conserva i valori già annotati')
  await clickText(`#${stairs} .defer-exercise`, 'Fallo dopo')
  check((await cardIds()).at(-1) === stairs, 'Fallo dopo modifica soltanto l’ordine temporaneo')
  await beginAdd('Lat machine'); await dose(); await input('dialog select', stairs.slice(-36)); await confirmAdd()
  const lat = await addedCard('Lat machine'); ids = await cardIds()
  check(ids.indexOf(lat) === ids.indexOf(stairs) + 1 && !await tab.evaluate(`!!document.querySelector('.exercise-later')`), 'Aggiunta per nome ripristina ordine persistente e inserisce dopo il riferimento rimandato')
  await clickText(`#${duplicate} .session-added-actions button`, 'Sposta')
  await input('dialog select', 'end'); await clickText('dialog button', 'Conferma spostamento')
  await clickText(`#${stairs} .defer-exercise`, 'Fallo dopo')
  await clickText(`#${duplicate} .session-added-actions button`, 'Rimuovi')
  check(!await tab.evaluate(`!!document.getElementById(${JSON.stringify(duplicate)}) || !!document.querySelector('dialog[open]')`), 'Rimuovi senza valori è immediato')
  check((await cardIds()).at(-1) === stairs, 'Rimozione conserva i rinvii Fallo dopo degli altri esercizi')
  await clickText(`#${strength} .session-added-actions button`, 'Rimuovi')
  check(await tab.evaluate(`!!document.querySelector('dialog[open]') && !!document.getElementById(${JSON.stringify(strength)})`), 'Rimuovi con valori chiede conferma e conserva la card')
  await clickText('dialog button', 'Continua')
  await synced()
  // Offline limitato alle API, mentre l’app statica locale rimane raggiungibile anche al reload.
  await tab.send('Network.setBlockedURLs', { urls: [`${fixture.config.apiUrl}/*`] })
  await clickText(`#${strength} .session-added-actions button`, 'Sposta')
  await input('dialog select', 'end'); await clickText('dialog button', 'Conferma spostamento')
  await input(`#${cardio} input[aria-label*="minuti"]`, '3,5')
  await tab.click(`#${cardio} .set-check`)
  await tab.send('Page.reload')
  await tab.until(`document.querySelectorAll('.set-panel').length===7`)
  check((await cardIds()).at(-1) === strength && await tab.evaluate(`document.getElementById(${JSON.stringify(cardio)}).querySelector('input[aria-label*="minuti"]').value==='3,5'`), 'Reload offline conserva aggiunte, ordine e minuti annotati')
  await tab.send('Network.setBlockedURLs', { urls: [] })
  await tab.evaluate(`window.dispatchEvent(new Event('online'))`); await synced()
  check(true, 'Riconnessione sincronizza spostamento e risultati senza duplicazioni')
  await clickText(`#${strength} .session-added-actions button`, 'Rimuovi'); await clickText('dialog button', 'Rimuovi')
  check(!await tab.evaluate(`!!document.getElementById(${JSON.stringify(strength)})`), 'Rimozione confermata elimina l’occorrenza con valori')
  await tab.click('.session-finish'); await tab.until(`!!document.querySelector('.session-finish-confirm')`); await tab.click('.session-finish-confirm'); await synced()
  await clickText('dialog button', 'Fatto')
  await tab.evaluate(`location.hash='/scheda/storico'`)
  await tab.until(`!!document.querySelector('.history-list a')`)
  await tab.click('.history-list a'); await tab.until(`!!document.querySelector('.session-page .session-status.finished')`)
  check(await tab.evaluate(`!document.querySelector('.session-add-button') && !document.querySelector('.session-added-actions') && [...document.querySelectorAll('.set-panel h2')].some(el=>el.textContent==='Tapis roulant')`), 'Storico conserva le aggiunte senza comandi di modifica della struttura')
  await tab.evaluate(`location.hash='/scheda'`); await tab.until(`!!document.querySelector('.workout-start')`)
  await clickText('.workout-start', 'Inizia allenamento'); await tab.until(`!!document.querySelector('.session-more')`)
  await tab.click('.session-more'); await tab.click('.session-discard'); await tab.until(`!!document.querySelector('.session-discard-actions')`)
  await layout('eliminazione-seduta')
  check(await tab.evaluate(`(()=>{const a=document.querySelector('.session-discard-cancel').getBoundingClientRect(),b=document.querySelector('.session-discard-confirm').getBoundingClientRect();return Math.abs(a.top-b.top)<2&&b.left>=a.right-1})()`), 'Conferma eliminazione mantiene Continua ed Elimina affiancati')
  await tab.click('.session-discard-cancel'); check(await tab.evaluate(`!!document.querySelector('.session-page')`), 'Continua conserva la seduta')
  await tab.click('.session-more'); await tab.click('.session-discard'); await tab.click('.session-discard-confirm'); await synced()
  check(!await tab.evaluate(`!!document.querySelector('.session-page')`), 'Elimina rimuove la seduta in corso e conserva lo storico')
  check(tab.requests.every(url => !/^https?:/.test(url) || new URL(url).hostname === '127.0.0.1'), 'Solo richieste locali durante la prova')
  const unexpected = tab.errors.filter(error => !error.includes('ERR_BLOCKED_BY_CLIENT') && !error.includes('Failed to fetch') && !error.includes('net::ERR_FAILED'))
  check(unexpected.length === 0, `Nessun errore browser inatteso: ${unexpected.join('; ')}`)
  await writeFile(resolve(directory, 'browser.json'), JSON.stringify({ result: 'PASS', checks }, null, 2))
} finally {
  await tab?.close(); await server?.stop(); await chrome.stop(); await fixture?.cleanup()
}
