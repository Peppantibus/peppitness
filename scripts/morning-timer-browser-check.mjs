// Componenti reali e fixture in memoria, senza Auth o database.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { buildComponentHarness, ensureChrome, openTab, pause, serveStatic } from './lib/import-browser-harness.mjs'

const serveIndex = process.argv.indexOf('--serve')
const preview = serveIndex !== -1
const fixture = preview ? process.argv[serveIndex + 1] : undefined
const previewRoutine = fixture ? JSON.parse(await readFile(fixture, 'utf8')) : null
const harness = await buildComponentHarness({ name: 'morning-timer', entry: at => `
import React, { useState, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { useRoute } from '${at('app/route')}'
import { Layout } from '${at('components/Layout')}'
import { localDate } from '${at('domain/dates')}'
import { MorningRoutineCard } from '${at('features/MorningRoutine')}'
import { MorningRoutinePage } from '${at('features/MorningRoutinePage')}'
import { MorningRoutineStore } from '${at('persistence/morning-routine-store')}'
import '${at('styles.css')}'
const data = new Map()
const store = new MorningRoutineStore(null, { get: key => data.get(key) ?? null, set: (key, value) => data.set(key, value), remove: key => data.delete(key) }, 'synthetic')
store.start()
const item = (name, minutes, area, dose, note) => ({ id: crypto.randomUUID(), name, minutes, area, dose, note })
const fixture = ${JSON.stringify(previewRoutine)}
const saved = store.save(fixture ?? {
  title: 'Mobilità del mattino',
  base: [
    item('Circonduzioni delle spalle', .5, 'Spalle', '6 per verso', 'Esegui movimenti lenti e controllati.'),
    item('Rotazioni delle anche', 1.5, 'Anche', '6 per lato', 'Alterna i lati con calma.'),
  ],
  extra: [item('Ponte glutei', 2, 'Glutei', '2 × 8 rip.', 'Prenditi una breve pausa tra le serie.')],
  strengthDays: [2, 4, 6],
  note: '',
})
if (!saved) throw new Error('Fixture della mobilità non valida.')
const today = fixture ? localDate() : '2026-11-17'
const onDirty = () => {}
const root = document.getElementById('root')
document.querySelector('main#main-content').replaceWith(root)
document.title = 'Mobilità giornaliera · peppitness'
if (!location.hash) location.replace('#/scheda/mattino')
const theme = new URLSearchParams(location.search).get('tema')
if (theme === 'scuro') document.documentElement.dataset.theme = 'dark'
if (!${preview}) {
  window.testClock = Date.now()
  Date.now = () => window.testClock
  localStorage.setItem('peppitness:rest-alert', 'off')
}
function App() {
  const [date, setDate] = useState(today)
  const { isMorning, isMorningEditor } = useRoute()
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot)
  return <Layout section="scheda" subpage={isMorning} focus={isMorningEditor}>
    {isMorning
      ? <MorningRoutinePage store={store} state={state} date={date} today={today} onDate={setDate} editing={isMorningEditor} onDirty={onDirty} />
      : <><h1>Scheda</h1><MorningRoutineCard state={state} date={date} /></>}
  </Layout>
}
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>)
` })

if (preview) {
  const server = await serveStatic({ dist: harness.dist, port: 5188 })
  console.log(`Anteprima Mobilità giornaliera: ${server.origin}/#/scheda/mattino`)
} else {
  await verify()
}

async function verify() {
  const checks = []
  const check = label => { checks.push(label); console.log('PASS ' + label) }
  let chrome, tab, server
  try {
    server = await serveStatic({ dist: harness.dist })
    chrome = await ensureChrome()
    tab = await openTab()
    await tab.viewport(390, 844, true)
    await tab.navigate(server.origin + '/#/scheda/mattino', 'document.querySelectorAll(".morning-movement").length === 3')
    const start = index => tab.click(`.morning-group:first-child .morning-movement:nth-child(${index + 1}) .morning-timer-start`)
    const checkButton = index => `.morning-group:first-child .morning-movement:nth-child(${index + 1}) .morning-movement-check`
    const isChecked = index => tab.evaluate(`document.querySelector('${checkButton(index)}').getAttribute('aria-pressed') === 'true'`)
    const advance = async ms => {
      await tab.evaluate(`window.testClock += ${ms}; document.dispatchEvent(new Event('visibilitychange'))`)
      await pause(80)
    }
    const count = () => tab.evaluate('document.querySelector("[role=timer]")?.textContent')
    const timerStatus = () => tab.evaluate('document.querySelector(".morning-timer-meta [role=status]").textContent')
    const toggle = () => tab.click('.morning-timer-toggle')
    const closeTimer = () => tab.click('.morning-timer-reset')
    const timerFits = () => tab.evaluate(`(() => {
      const timer = document.querySelector('.morning-exercise-timer').getBoundingClientRect()
      const nav = document.querySelector('.bottom-nav').getBoundingClientRect()
      const controls = document.querySelectorAll('.morning-exercise-timer button, .morning-timer-start, .morning-movement-check')
      return [...controls].every(el => el.getBoundingClientRect().height >= 44)
        && document.querySelector('.morning-timer-controls').getBoundingClientRect().right <= timer.right - 8
        && (!nav.height || timer.bottom <= nav.top)
    })()`)
    await tab.evaluate('document.documentElement.dataset.theme = "light"')
    assert.equal(await tab.evaluate('document.querySelector(".morning-heading h1").textContent'), 'Mobilità giornaliera.')
    await pause(200)
    await tab.screenshot(resolve(harness.dir, 'routine-mobile.png'))
    await tab.click(checkButton(0))
    assert.equal(await isChecked(0), true)
    assert.equal(await isChecked(1), false)
    assert.equal(await tab.evaluate('document.querySelector(".morning-movement details").open'), false)
    await tab.click(checkButton(0))
    assert.equal(await isChecked(0), false)
    assert.equal(await count(), undefined)
    check('Spunta manuale reversibile e indipendente da istruzioni e timer')
    await start(0)
    await closeTimer()
    assert.equal(await count(), undefined)
    assert.equal(await isChecked(0), false)
    await start(0)
    await toggle()
    assert.equal(await count(), '00:30')
    await tab.click('.morning-timer-done')
    assert.equal(await count(), undefined)
    assert.equal(await isChecked(0), true)
    assert.equal(await isChecked(1), false)
    assert.match(await tab.evaluate('document.querySelector(".morning-status").textContent'), /Da fare/)
    await tab.click(checkButton(0))
    check('Fatto conclude e spunta anche un timer in pausa. Chiudi ferma il timer senza spunta')
    await start(0)
    assert.equal(await count(), '00:30')
    assert.equal(await tab.evaluate('document.querySelector(".morning-movement details").open'), false)
    assert.equal(await tab.evaluate('document.activeElement.classList.contains("morning-timer-toggle")'), true)
    await tab.click('.morning-movement summary')
    assert.equal(await tab.evaluate('document.querySelector(".morning-movement details").open'), true)
    assert.equal(await count(), '00:30')
    check('Il timer parte a istruzioni chiuse, riceve il focus e continua quando si aprono le istruzioni')
    await tab.evaluate('window.testClock += 1000')
    await tab.until('document.querySelector("[role=timer]")?.textContent === "00:29"')
    await advance(4500)
    assert.equal(await count(), '00:25')
    check('Avvio dai mezzi minuti salvati e conteggio basato sulla scadenza')
    await toggle()
    await advance(60000)
    assert.equal(await count(), '00:25')
    assert.equal(await timerStatus(), 'In pausa')
    await toggle()
    await advance(1000)
    assert.equal(await count(), '00:24')
    check('Pausa congelata e ripresa con il tempo residuo')
    for (const theme of ['light', 'dark']) for (const width of [320, 390, 768, 1024, 1440]) {
      await tab.viewport(width, width < 768 ? 844 : 1000, width < 768)
      await tab.evaluate(`document.documentElement.dataset.theme = '${theme}'`)
      assert.equal(await tab.evaluate('document.documentElement.scrollWidth <= innerWidth'), true)
      assert.equal(await timerFits(), true)
      await tab.screenshot(resolve(harness.dir, `${theme}-${width}.png`))
    }
    check('320/390/768/1024/1440 px nei due temi: nessun overflow, controlli touch di almeno 44 px, navigazione libera')
    await tab.viewport(390, 600, true)
    const top = await tab.evaluate('document.querySelector(".morning-exercise-timer").getBoundingClientRect().top')
    await tab.evaluate('scrollTo(0, document.documentElement.scrollHeight)')
    assert.equal(await tab.evaluate('scrollY > 100'), true)
    assert.equal(await tab.evaluate('document.querySelector(".morning-exercise-timer").getBoundingClientRect().top'), top)
    check('Il timer resta visibile durante lo scorrimento su mobile')
    await tab.viewport(390, 844, true)
    await start(1)
    assert.equal(await count(), '01:30')
    assert.equal(await tab.evaluate('document.querySelectorAll(".morning-exercise-timer").length'), 1)
    check('Un solo timer: un altro esercizio sostituisce quello precedente')
    await advance(91000)
    assert.equal(await count(), '00:00')
    assert.equal(await timerStatus(), 'Tempo terminato')
    assert.match(await tab.evaluate('document.querySelector(".morning-status").textContent'), /Da fare/)
    assert.equal(await isChecked(0), false)
    assert.equal(await isChecked(1), true)
    for (const width of [320, 1024]) {
      await tab.viewport(width, 844, width < 720)
      assert.equal(await timerFits(), true, `Pulsanti del timer scaduto a ${width}px`)
    }
    await tab.viewport(390, 844, true)
    await advance(5000)
    assert.equal(await count(), '00:00')
    await toggle()
    assert.equal(await count(), '01:30')
    await closeTimer()
    assert.equal(await count(), undefined)
    assert.equal(await isChecked(1), true)
    assert.match(await tab.evaluate('document.activeElement.getAttribute("aria-label")'), /Rotazioni delle anche/)
    await tab.click('.morning-movement details[open] summary')
    await tab.evaluate('document.documentElement.dataset.theme = "light"; scrollTo(0, 0)')
    await pause(200)
    await tab.screenshot(resolve(harness.dir, 'exercise-completed-mobile.png'))
    check('Scadenza anche al ritorno alla pagina, niente valori negativi, ricomincia e chiudi; completamento manuale')
    check('La scadenza del timer spunta l’esercizio pertinente. La spunta resta dopo la chiusura')
    await tab.click('.morning-strength .morning-timer-start')
    assert.equal(await count(), '02:00')
    await tab.click('[aria-label="Giorno precedente"]')
    assert.equal(await count(), undefined)
    assert.equal(await isChecked(1), false)
    assert.equal(await tab.evaluate('document.querySelectorAll(".morning-strength").length'), 0)
    assert.equal(await tab.evaluate('document.activeElement.getAttribute("aria-label")'), 'Giorno precedente')
    check('Timer anche nel rinforzo; cambio giorno azzera e rimuove il rinforzo non previsto')
    await start(0)
    await tab.click('.morning-edit')
    await tab.until('!!document.querySelector(".morning-editor")')
    assert.equal(await tab.evaluate('document.querySelector("#routine-name").value'), 'Mobilità giornaliera')
    assert.equal(await count(), undefined)
    await tab.click('[aria-label="Annulla modifiche"]')
    await tab.until('!!document.querySelector(".morning-edit")')
    assert.equal(await count(), undefined)
    await tab.click(checkButton(0))
    await start(0)
    await tab.click('#mark-routine-done')
    assert.equal(await count(), undefined)
    assert.equal(await isChecked(0), true)
    assert.equal(await isChecked(1), false)
    assert.match(await tab.evaluate('document.querySelector(".morning-status").textContent'), /Fatta/)
    check('Modifica e completamento della routine fermano il timer')
    await tab.click('.morning-undo')
    await tab.until('!!document.querySelector("dialog[open]")')
    await tab.click('dialog[open] .danger')
    assert.match(await tab.evaluate('document.querySelector(".morning-status").textContent'), /Da fare/)
    await tab.click('[aria-label="Giorno successivo"]')
    await tab.click('[aria-label="Giorno successivo"]')
    assert.equal(await tab.evaluate('document.querySelector("#mark-routine-done").disabled'), true)
    assert.match(await tab.evaluate('document.querySelector(".morning-status").textContent'), /In programma/)
    check('Annullamento del completamento e consultazione dei giorni futuri')
    await tab.click('.morning-back-link')
    await tab.until('!!document.querySelector(".morning-entry")')
    assert.equal(await tab.evaluate('document.querySelector(".morning-entry-copy strong").textContent'), 'Mobilità giornaliera')
    check('Il nome precedente è visualizzato come Mobilità giornaliera in pagina, editor e Scheda')
    assert.deepEqual(tab.errors, [])
    assert.ok(tab.requests.every(url => !/^https?:/.test(url) || new URL(url).origin === server.origin))
    check('Nessun errore JavaScript e nessuna richiesta esterna')
    await writeFile(resolve(harness.dir, 'results.json'), JSON.stringify({ pass: true, checks }, null, 2))
    console.log(JSON.stringify({ pass: true, checks: checks.length, artifacts: harness.dir }))
  } catch (error) {
    console.error(JSON.stringify({ errors: tab?.errors, body: await tab?.evaluate('document.body.innerText').catch(() => '') }))
    throw error
  } finally {
    await tab?.close()
    await chrome?.stop()
    await server?.stop()
  }
}
