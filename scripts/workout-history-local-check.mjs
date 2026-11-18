import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { build } from 'vite'
import { historyRoute } from '../src/domain/workout-history.ts'
import { cycleRecapKey } from '../src/domain/cycle-recap.ts'
import { shiftDate } from '../src/domain/dates.ts'
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

try {
  const complete = await createProgram('Full body', shiftDate(today, -56), 8)
  const interrupted = await createProgram('Forza e mobilità', shiftDate(today, -12), 8)
  const next = await createProgram('Nuovo ciclo', today, 10)
  await diary.refresh()
  await follow(complete.document.planId)
  await session(complete, complete.cycle.start, 20, 6)
  await session(complete, shiftDate(complete.cycle.start, 22), 40, 6)
  const best = await session(complete, shiftDate(complete.cycle.start, 42), 60, 6)
  const alternate = await session(complete, shiftDate(complete.cycle.start, 45), 140, 6, true)
  const normal = await session(complete, shiftDate(complete.cycle.start, 50), 60, 4)
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
  await tab.navigate(`${server.origin}/#/scheda`, `!!document.querySelector('.cycle-recap-invite a')`)
  await tab.click('.cycle-recap-invite a')
  await ready('.cycle-deck--opening')
  check(await tab.evaluate(`document.querySelector('.cycle-deck button[aria-pressed]').getAttribute('aria-pressed') === 'true'`), 'Il Wrapped parte in automatico')
  await tab.click('.cycle-deck-slide h1')
  check(await tab.evaluate(`document.querySelector('.cycle-deck button[aria-pressed]').getAttribute('aria-pressed') === 'false'`), 'Il tocco mette in pausa la storia')
  await tab.click('.cycle-deck-progress button[aria-label$="Gli esercizi"]')
  await ready('.cycle-deck--exercises')
  check(await tab.evaluate(`(()=>{const t=document.querySelector('.cycle-deck-slide').innerText;return t.includes('60 kg × 6') && t.includes('Settimana 7') && !t.includes('140 kg') && !t.includes('60 kg × 4')})()`), 'Confronto con 60 × 6 della settimana 7, senza macchinario diverso')
  await tab.key('End', 'End', 35)
  await ready('.cycle-story-history-link')
  check(await tab.evaluate(`document.querySelector('.cycle-deck-print').textContent === 'Salva PDF'`), 'La stampa PDF resta accessibile')
  let saved
  for (let attempt = 0; attempt < 40 && !saved; attempt++) {
    saved = (await transport.loadAll(signal())).data.cycleRecaps[recapKey]
    if (!saved) await pause(100)
  }
  check(saved?.report.sessions === 5 && saved.report.record?.value.includes('60 kg') && !saved.report.record?.value.includes('140'), 'Wrapped salvato con totali e record del macchinario abituale')
  check(Object.keys((await createDiaryTransport(b.client, b.owner).loadAll(signal())).data.cycleRecaps).length === 0, 'Un altro account non legge il riepilogo')
  await tab.click('.cycle-deck-header a')
  await ready('.plan-selector select')
  check(await tab.evaluate(`!document.querySelector('.cycle-recap-invite')`), 'La CTA sparisce dalla Scheda dopo avere visto il Wrapped')
  await tab.evaluate(`(()=>{const field=document.querySelector('.plan-selector select');field.value=${JSON.stringify(next.document.planId)};field.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  await tab.until(`document.querySelector('.plan-selector select')?.value === ${JSON.stringify(next.document.planId)} && !document.querySelector('.plan-selector select:disabled')`)
  await go(historyRoute('attuale'), '.workout-history-empty')
  check(await tab.evaluate(`document.querySelector('.workout-history-current').textContent.includes('Nuovo ciclo')`), 'Attuale mostra il nuovo programma e nessuna seduta del ciclo precedente')
  await tab.click(tabButton('passati'))
  await ready('.workout-history-cycle')
  check(await tab.evaluate(`(()=>{const t=document.querySelector('.workout-history-cycles').innerText;return t.includes('Full body')&&t.includes('Concluso')&&t.includes('Forza e mobilità')&&t.includes('Interrotto')})()`), 'Passati mostra i cicli distinti e il loro stato')
  const archived = '.workout-history-cycle:has(summary strong) .workout-history-wrapped'
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
