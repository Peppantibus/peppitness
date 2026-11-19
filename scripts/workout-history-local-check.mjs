import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { historyRoute } from '../src/domain/workout-history.ts'
import { createWorkoutProgramHref, cycleRecapKey } from '../src/domain/cycle-recap.ts'
import { formatDate, shiftDate } from '../src/domain/dates.ts'
import { workoutDaysFromProgram } from '../src/domain/diary.ts'
import { newPrescription, programPayload } from '../src/domain/programs.ts'
import { createDiaryTransport } from '../src/persistence/diary-repository.ts'
import { DiaryStore, memoryStorage } from '../src/persistence/diary-store.ts'
import { appCsp, ensureChrome, openTab, pause, serveStatic } from './lib/import-browser-harness.mjs'
import { workoutChangesFixture } from './lib/workout-changes-local-fixture.mjs'

const fixture = await workoutChangesFixture()
const { a, b, config, today } = fixture
const transport = createDiaryTransport(a.client, a.owner)
const diary = new DiaryStore(transport, memoryStorage(), a.owner)
const out = resolve('artifacts/workout-history')
let chrome, server, tab
const signal = () => AbortSignal.timeout(15_000)
const check = (value, description) => { assert.ok(value, description); console.log(`PASS ${description}`) }
const result = async query => {
  const { data, error } = await query
  assert.ifError(error)
  return data
}

async function createProgram(title, start, weeks) {
  const exercise = { ...newPrescription(fixture.find('Chest press')), sets: '1', repsMin: '6', repsMax: '6' }
  const document = { planId: randomUUID(), id: randomUUID(), title, guidance: '', days: [
    { id: randomUUID(), label: 'A', title: `${title} A`, note: '', exercises: [exercise] },
  ] }
  await result(a.client.rpc('save_workout_draft', { ...programPayload(document), p_expected_revision: 0 }))
  await result(a.client.rpc('publish_workout_version', { p_version_id: document.id, p_expected_revision: 1, p_expected_plan_revision: 1 }))
  await result(a.client.from('workout_plans').update({ cycle_start: start, cycle_weeks: weeks, revision: 3 }).eq('id', document.planId))
  return { document, day: workoutDaysFromProgram(document)[0], cycle: { start, weeks } }
}

async function follow(planId) {
  const selection = await result(a.client.from('active_plans').select('revision').single())
  await result(a.client.from('active_plans').update({ workout_plan_id: planId, revision: selection.revision + 1 }).eq('owner_id', a.owner))
}

async function flush() {
  await diary.flush()
  assert.equal(diary.getSnapshot().pending, 0)
  assert.deepEqual(diary.getSnapshot().conflicts, [])
}

async function session(program, date, load, reps, alternate = false) {
  const id = diary.startSession({ date, timeZone: 'Europe/Rome', day: program.day, cycle: program.cycle,
    planId: program.document.planId, versionId: program.document.id })
  assert.ok(id)
  const exercise = program.day.exercises[0]
  if (alternate) {
    diary.setDifferentMachine(id, exercise.id, true)
    diary.setDifferentMachine(id, exercise.id, false)
    assert.equal(diary.getSnapshot().view.sessions.find(item => item.id === id).differentMachines?.[exercise.id], undefined)
    diary.setDifferentMachine(id, exercise.id, true)
  }
  diary.updateSet(id, exercise.id, 0, { load: String(load), amount: String(reps), completed: true })
  diary.completeSession(id)
  await flush()
  return id
}

const ready = selector => tab.until(`!!document.querySelector(${JSON.stringify(selector)})`)
const go = async (path, selector) => {
  await tab.evaluate(`location.hash = ${JSON.stringify(path)}`)
  await ready(selector)
}
const tabButton = name => `.workout-history-tabs button:nth-child(${['attuale', 'passati', 'liberi'].indexOf(name) + 1})`
const chooseProgram = async program => {
  const id = JSON.stringify(program.document.planId)
  await go('/scheda', '.plan-selector select')
  await tab.until(`[...document.querySelectorAll('.plan-selector option')].some(item => item.value === ${id})`)
  await tab.evaluate(`(()=>{const field=document.querySelector('.plan-selector select');field.value=${id};field.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await tab.until(`document.querySelector('.plan-selector select')?.value === ${id} && !document.querySelector('.plan-selector select:disabled')`)
}

try {
  const complete = await createProgram('Full body', shiftDate(today, -56), 8)
  const interrupted = await createProgram('Forza e mobilità', shiftDate(today, -12), 8)
  const next = await createProgram('Nuovo ciclo', today, 10)
  const extendable = await createProgram('Ciclo da estendere', shiftDate(today, -56), 8)
  await diary.refresh()
  await follow(complete.document.planId)
  await session(complete, complete.cycle.start, 20, 6)
  await session(complete, shiftDate(complete.cycle.start, 22), 40, 6)
  const best = await session(complete, shiftDate(complete.cycle.start, 42), 60, 6)
  const alternate = await session(complete, shiftDate(complete.cycle.start, 45), 140, 6, true)
  const normal = await session(complete, shiftDate(complete.cycle.start, 50), 60, 4)
  await follow(extendable.document.planId)
  const extendedSession = await session(extendable, extendable.cycle.start, 20, 6)
  await follow(interrupted.document.planId)
  await session(interrupted, shiftDate(today, -10), 30, 6)
  await follow(complete.document.planId)

  const freeId = diary.startFreeSession(today, 'Europe/Rome')
  assert.ok(freeId)
  const exercise = { ...newPrescription(fixture.find('Tapis roulant')), sets: '1', durationSeconds: '1800', restSeconds: '0' }
  const cardio = workoutDaysFromProgram({ ...next.document, days: [{ ...next.document.days[0], exercises: [exercise] }] })[0].exercises[0]
  diary.editSession(freeId, { action: 'add', exercise: { ...cardio.snapshot, session_added: true }, position: { kind: 'end' }, allowDuplicate: false })
  diary.updateSet(freeId, cardio.id, 0, { load: '', amount: '1800', completed: true })
  diary.completeSession(freeId)
  await flush()

  const data = (await transport.loadAll(signal())).data
  const recapKey = cycleRecapKey(complete.document.planId, complete.cycle)
  const interruptedKey = cycleRecapKey(interrupted.document.planId, interrupted.cycle)
  const find = id => data.sessions.find(item => item.id === id)
  check(find(best).cycleRecorded && find(best).cycle.start === complete.cycle.start, 'Periodo reale salvato con la seduta')
  check(find(alternate).differentMachines[complete.day.exercises[0].id] && !find(normal).differentMachines, 'Spunta persistita solo nella seduta scelta')
  check(data.interruptedCycles.includes(interruptedKey), 'Il cambio di programma registra un ciclo interrotto')
  check((await createDiaryTransport(b.client, b.owner).loadAll(signal())).data.interruptedCycles.length === 0, 'Un altro account non legge le interruzioni')

  // La config pubblica accetta la porta locale standard. Il progetto di prova può
  // usare un'altra porta loopback per convivere con lo stack di sviluppo.
  const apiPort = new URL(config.apiUrl).port
  const localPort = {
    name: 'workout-history-local-port',
    enforce: 'pre',
    transform(source, id) {
      if (apiPort !== '54321' && id.replaceAll('\\', '/').endsWith('/src/auth/config.ts')) {
        const withTestPort = source.replace(/parsed\.port\s*===\s*['"]54321['"]/, `parsed.port === '${apiPort}'`)
        assert.notEqual(withTestPort, source, 'Porta del frontend di collaudo sostituita')
        return withTestPort
      }
    },
  }
  await build({ configFile: false, envFile: false, logLevel: 'warn', plugins: [localPort, react()],
    define: { 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(config.apiUrl), 'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(config.publishableKey ?? config.publicKey) },
    build: { outDir: resolve(out, 'app'), emptyOutDir: true, target: 'safari16' } })
  server = await serveStatic({ dist: resolve(out, 'app'), csp: (await appCsp()).replace(/connect-src ([^;]+)/, `connect-src $1 ${config.apiUrl}`) })
  chrome = await ensureChrome()
  tab = await openTab()
  await tab.send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Rome' })
  await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('sb-127-auth-token', ${JSON.stringify(JSON.stringify(a.session))}); localStorage.setItem('peppitness:returning-device','1');` })
  await tab.viewport(390, 844, true)
  await tab.navigate(`${server.origin}/#/scheda`, `!!document.querySelector('.cycle-finish-program')`)
  check(await tab.evaluate(`!!document.querySelector('.cycle-extend-program') && !document.querySelector('.workout-summary') && !document.querySelector('.cycle-end a[href="#/scheda/riepilogo"]')`), 'Alla scadenza scegli tra fine ed estensione')
  await go(historyRoute('passati'), '.workout-history-cycle')
  check(await tab.evaluate(`[...document.querySelectorAll('.workout-history-cycle summary')].some(row => row.textContent.includes('Full body') && row.textContent.includes('Da chiudere'))`), 'La scadenza lascia il ciclo da chiudere')
  await go('/scheda', '.cycle-finish-program')
  await tab.screenshot(resolve(out, 'scadenza-390.png'))
  await tab.click('.cycle-finish-program')
  const openWrapped = '.cycle-end a[href="#/scheda/riepilogo"]'
  await ready(openWrapped)
  let saved
  for (let attempt = 0; attempt < 40 && !saved; attempt++) {
    saved = (await transport.loadAll(signal())).data.cycleRecaps[recapKey]
    if (!saved) await pause(100)
  }
  check(saved?.unseen && saved.report.sessions === 5, 'Termina salva il Wrapped anche prima di guardarlo')
  const closedExtension = await a.client.rpc('extend_workout_cycle', { p_plan_id: complete.document.planId, p_cycle_start: complete.cycle.start,
    p_cycle_weeks: 8, p_new_weeks: 9, p_expected_revision: 3 })
  check(closedExtension.error?.code === 'PT409', 'Il server preserva il ciclo già concluso se arriva un’estensione da una scheda vecchia')
  await tab.send('Page.reload')
  await ready(openWrapped)
  await tab.click(openWrapped)
  await ready('.cycle-deck--opening')
  check(await tab.evaluate(`document.querySelector('.cycle-deck button[aria-pressed]').getAttribute('aria-pressed') === 'true'`), 'Il Wrapped parte in automatico')
  await tab.click('.cycle-deck-slide h1')
  check(await tab.evaluate(`document.querySelector('.cycle-deck button[aria-pressed]').getAttribute('aria-pressed') === 'false'`), 'Il tocco mette in pausa la storia')
  await tab.click('.cycle-deck-progress button[aria-label$="Gli esercizi"]')
  await ready('.cycle-deck--exercises')
  check(await tab.evaluate(`(()=>{const t=document.querySelector('.cycle-deck-slide').innerText;return t.includes('60 kg × 6') && t.includes('Settimana 7') && !t.includes('140 kg') && !t.includes('60 kg × 4')})()`), 'Confronto con 60 × 6 della settimana 7, senza macchinario diverso')
  await tab.key('End', 'End', 35)
  await ready('.cycle-story-history-link')
  await ready('.cycle-story-next-program')
  check(await tab.evaluate(`document.querySelector('.cycle-deck-print').textContent === 'Salva PDF'`), 'La stampa PDF resta accessibile')
  for (let attempt = 0; attempt < 40 && saved?.unseen; attempt++) {
    saved = (await transport.loadAll(signal())).data.cycleRecaps[recapKey]
    if (saved?.unseen) await pause(100)
  }
  check(saved && !saved.unseen && saved.report.sessions === 5 && saved.report.record?.value.includes('60 kg') && !saved.report.record?.value.includes('140'), 'Visione salvata con totali e record del macchinario abituale')
  check(Object.keys((await createDiaryTransport(b.client, b.owner).loadAll(signal())).data.cycleRecaps).length === 0, 'Un altro account non legge il riepilogo')
  await tab.click('.cycle-deck-header a')
  await ready('.plan-selector select')
  const newProgram = `.cycle-end-primary[href="${createWorkoutProgramHref}"]`
  check(await tab.evaluate(`!document.querySelector('${openWrapped}') && !!document.querySelector('${newProgram}')`), 'Dopo la visione la Scheda propone la creazione di un nuovo programma')
  await go(historyRoute('attuale'), '.workout-history-empty')
  check(await tab.evaluate(`!document.querySelector('.workout-history-wrapped') && document.querySelector('.workout-history-empty').textContent.includes('concluso')`), 'Attuale non mostra il programma concluso ancora selezionato')
  await tab.click(tabButton('passati'))
  await ready('.workout-history-cycle')
  const archived = '.workout-history-cycle .workout-history-wrapped'
  await tab.evaluate(`[...document.querySelectorAll('.workout-history-cycle summary')].find(el=>el.innerText.includes('Full body')).click()`)
  await ready(archived)
  check(await tab.evaluate(`document.querySelectorAll('${archived}').length === 1`), 'Il Wrapped si ritrova in Passati prima di cambiare programma')
  await chooseProgram(next)
  await go(historyRoute('attuale'), '.workout-history-empty')
  check(await tab.evaluate(`document.querySelector('.workout-history-current').textContent.includes('Nuovo ciclo')`), 'Attuale mostra il nuovo programma e nessuna seduta del ciclo precedente')
  await tab.click(tabButton('passati'))
  await ready('.workout-history-cycle')
  check(await tab.evaluate(`(()=>{const t=document.querySelector('.workout-history-cycles').innerText;return t.includes('Full body')&&t.includes('Concluso')&&t.includes('Forza e mobilità')&&t.includes('Interrotto')})()`), 'Passati mostra i cicli distinti e il loro stato')
  await tab.evaluate(`[...document.querySelectorAll('.workout-history-cycle summary')].find(el=>el.innerText.includes('Full body')).click()`)
  await ready(archived); await tab.click(archived); await ready('.cycle-deck--opening')
  await tab.click('.cycle-deck-header a')
  await tab.until(`location.hash === '#/scheda/storico/passati'`)
  await tab.click(tabButton('liberi'))
  await ready('.workout-history-session-list a')
  check(await tab.evaluate(`document.querySelector('.workout-history-session-list a').textContent.includes('30 min cardio')`), 'Liberi mostra la seduta e i suoi minuti cardio')
  await tab.click('.workout-history-session-list a'); await ready('.session-status.finished')
  check(await tab.evaluate(`document.querySelector('.subpage-back').getAttribute('href') === '#/scheda/storico/liberi'`), 'La scheda della seduta torna alla tab di origine')

  await go(historyRoute('passati'), '.workout-history-cycle')
  for (const width of [320, 390, 1440]) {
    await tab.viewport(width, 844, width < 720)
    check(await tab.evaluate('document.documentElement.scrollWidth <= innerWidth'), `Storico leggibile a ${width} px`)
    await tab.screenshot(resolve(out, `storico-${width}.png`))
  }
  await tab.viewport(390, 844, true)
  await chooseProgram(extendable)
  await ready('.cycle-extend-program')
  await tab.click('.cycle-extend-program')
  await ready('.cycle-confirm-extension')
  await tab.click('.cycle-confirm-extension')
  await ready('.workout-summary')
  const extended = (await transport.loadAll(signal())).data
  check(extended.sessions.find(item => item.id === extendedSession)?.cycle.weeks === 9 && !extended.cycleRecaps[cycleRecapKey(extendable.document.planId, extendable.cycle)], 'Estensione continua lo stesso ciclo e conserva le sedute')
  await go(historyRoute('attuale'), '.workout-history-session-list a')
  check(await tab.evaluate(`document.querySelector('.workout-history-current').textContent.includes('1 seduta')`), 'La seduta esistente resta in Attuale dopo l’estensione')
  await chooseProgram(complete)
  await ready(newProgram)
  await tab.click(newProgram)
  const blankChoice = '.program-start-choice[href="#/scheda/programmi/nuovo"]'
  const copyChoice = '.program-start-choice[href="#/scheda/programmi/rinnova"]'
  await ready(copyChoice)
  check(await tab.evaluate(`document.querySelector('${copyChoice}').textContent.includes('Full body')`), 'La CTA offre la copia del programma concluso')
  await tab.click(blankChoice)
  await ready('#wizard-name')
  check(await tab.evaluate(`document.querySelector('#wizard-name').value === ''`), 'Parti da zero apre una bozza vuota')
  await tab.click('.wizard-top button[aria-label="Chiudi"]')
  const title = 'Full body · nuovo ciclo'
  const start = shiftDate(today, 4)
  await go(createWorkoutProgramHref.slice(1), copyChoice)
  await tab.click(copyChoice)
  await ready('.program-cycle-fields input')
  check(await tab.evaluate(`document.querySelector('#program-title').value === 'Full body' && !!document.querySelector('.program-prescription')`), 'La copia conserva nome, sedute ed esercizi anche per un programma a rotazione')
  await tab.evaluate(`(()=>{
    const input=(selector, value)=>{
      const field=document.querySelector(selector)
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,value)
      field.dispatchEvent(new Event('input',{bubbles:true}))
      field.dispatchEvent(new Event('change',{bubbles:true}))
    }
    input('#program-title',${JSON.stringify(title)})
    input('.program-cycle-fields input',${JSON.stringify(start)})
    const weeks=document.querySelector('.program-cycle-fields select')
    weeks.value='9'; weeks.dispatchEvent(new Event('change',{bubbles:true}))
  })()`)
  await tab.click('.program-save')
  await ready('.program-publish:not(:disabled)')
  await tab.click('.program-publish')
  await ready('dialog[open] button.primary')
  await tab.click('dialog[open] button.primary')
  await ready('.program-preview')
  const plans = await result(a.client.from('workout_plans').select('id,name,active_version_id,cycle_start,cycle_weeks'))
  const copy = plans.find(plan => plan.name === title)
  check(copy?.id !== complete.document.planId && copy?.cycle_start === start && copy?.cycle_weeks === 9, 'La copia pubblicata ha un nuovo ID e la propria data di inizio e durata')
  const copiedDays = await result(a.client.from('workout_days').select('id,label,title').eq('version_id', copy.active_version_id))
  check(copiedDays[0]?.id !== complete.day.id && copiedDays[0]?.title === complete.day.title, 'La copia contiene la struttura con nuove identità')
  check((await transport.loadAll(signal())).data.cycleRecaps[recapKey]?.report.sessions === 5, 'Lo storico e il Wrapped del programma di origine restano insieme')
  await chooseProgram({ document: { planId: copy.id } })
  await ready('.cycle-upcoming')
  const startingDate = formatDate(start, { weekday: 'long', day: 'numeric', month: 'long' })
  check(await tab.evaluate(`document.querySelector('.cycle-upcoming').textContent.includes(${JSON.stringify(startingDate)}) && !document.querySelector('.workout-summary')`), 'Prima della data di inizio la Scheda mostra quando parte il nuovo ciclo')
  await tab.click('.free-workout-choice')
  await ready('.free-workout-start')
  await tab.click('.free-workout-start')
  await ready('.free-workout-empty')
  await tab.until(`Boolean(document.querySelector('[data-sync="synced"]')) && !document.querySelector('[data-sync="pending"],[data-sync="sending"]')`)
  const free = (await transport.loadAll(signal())).data.sessions.find(item => !item.completedAt)
  check(free?.kind === 'free' && !free.planId && !free.cycle, 'L’allenamento libero è disponibile prima che inizi il ciclo e resta indipendente')
  assert.deepEqual(tab.errors, [])
  check(tab.requests.filter(url => /^https?:/.test(url)).every(url => new URL(url).hostname === '127.0.0.1'), 'Browser collegato esclusivamente al loopback')
} catch (error) {
  if (tab) {
    console.error(await tab.evaluate('document.body.innerText').catch(() => ''))
    console.error(tab.errors)
    await tab.screenshot(resolve(out, 'failure.png')).catch(() => {})
  }
  throw error
} finally {
  diary.stop()
  await tab?.close()
  await server?.stop()
  await chrome?.stop()
  await fixture.cleanup()
}
