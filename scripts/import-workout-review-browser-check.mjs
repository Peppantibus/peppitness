// Prova browser del task 12: revisione della scheda importata montata con stato sintetico nell'harness isolato del
// task 11 (build Vite dei soli componenti, server locale con la CSP dell'app, Chrome CDP dedicato). Usa i moduli
// reali: bozza e decisioni (07), validazione (06), matching (08), mapper (09). Nessuna preview dell'app, nessuna
// rotta di test nel bundle pubblico, nessuna rete: fetch/XHR/beacon sono registrati e rifiutati nella pagina.
//
// Comando (PowerShell, dalla radice del progetto):
//   node scripts/import-workout-review-browser-check.mjs
// Se su 127.0.0.1:9223 non c'è un Chrome di test lo avvia headless con un profilo temporaneo in artifacts/ (mai
// quello personale) e alla fine chiude solo ciò che ha avviato. Variabili: TEST_DEBUG_URL, CHROME_PATH.
// Fonti: soltanto fixture sintetiche di tests/fixtures/import. Screenshot in artifacts/import-workout-review/.
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildComponentHarness, ensureChrome, openTab, pause, root, serveStatic } from './lib/import-browser-harness.mjs'

const fixtures = join(root, 'tests', 'fixtures', 'import')
const readJson = async path => JSON.parse(await readFile(join(fixtures, path), 'utf8'))
const shots = join(root, 'artifacts', 'import-workout-review')
const checks = []
const pass = label => { checks.push(label); console.log(`  ✓ ${label}`) }
const started = []
const tabs = []
const cleanups = []

const manifest = await readJson('manifest.json')
const catalog = await readJson('matching/catalog.json')
async function fixtureCase(name) {
  const entry = manifest.cases.find(item => item.id === name)
  return { entry, document: await readJson(entry.expectedBlocks), extraction: await readJson(entry.expectedProposal) }
}

const entrySource = at => `
import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '${at('styles.css')}'
import { WorkoutReview } from '${at('features/import/WorkoutReview.tsx')}'
import { reserveWorkoutIds, workoutReviewOutcome } from '${at('features/import/review-model.ts')}'
import { createReviewDraft, sequentialLocalIds } from '${at('import/review/draft.ts')}'
import { applyDecision } from '${at('import/review/decisions.ts')}'

const log: any = (window as any).log = { changes: 0, confirmed: [], adopted: 0, dismissed: 0, network: [], newIds: 0 }
// Nessuna rete dalla revisione: ogni tentativo è registrato (e fallisce) prima di qualsiasi montaggio.
window.fetch = ((input: any) => { log.network.push(String(input?.url ?? input)); return Promise.reject(new Error('rete vietata')) }) as any
XMLHttpRequest.prototype.open = function (_method: string, url: string) { log.network.push(String(url)); throw new Error('rete vietata') } as any
navigator.sendBeacon = ((url: any) => { log.network.push(String(url)); return false }) as any

const source = { sourceHash: 'a'.repeat(64), readerVersion: 'synthetic-fixture/1', textNormalizationVersion: 'peppitness.text-normalization.v1' }
const root = createRoot(document.getElementById('root')!)
let mount = 0
let current: any = null
function Host({ init }: any) {
  const [value, setValue] = useState(init.value)
  current = { ...init, value }
  const onChange = useCallback((next: any) => { log.changes++; setValue(next) }, [])
  return <WorkoutReview document={init.document} format="docx" value={value} onChange={onChange} catalog={init.catalog} reanalysis={init.reanalysis}
    onAdoptReanalysis={init.reanalysis ? () => { log.adopted++ } : undefined} onDismissReanalysis={init.reanalysis ? () => { log.dismissed++ } : undefined}
    onConfirm={(result: any) => { log.confirmed.push(JSON.parse(JSON.stringify(result))) }} newId={() => 'u' + (++log.newIds)} />
}
;(window as any).harness = {
  mount(spec: any) {
    let draft: any = createReviewDraft({ kind: 'workout', extraction: spec.extraction, proposalId: '90000000-0000-4000-8000-000000000001', jobId: null, source: source as any, localIds: sequentialLocalIds('i') })
    for (const decision of spec.decisions ?? []) draft = applyDecision(draft, decision)
    const reanalysis = spec.reanalysis ? createReviewDraft({ kind: 'workout', extraction: spec.reanalysis, proposalId: '90000000-0000-4000-8000-000000000009', jobId: null, source: source as any, previous: { proposalId: draft.proposal.proposalId, proposalVersion: 1 }, localIds: sequentialLocalIds('n') }) : null
    Object.assign(log, { changes: 0, confirmed: [], adopted: 0, dismissed: 0, newIds: 0 })
    root.render(<Host key={++mount} init={{ document: spec.document, catalog: spec.catalog, reanalysis, value: { draft, ids: spec.ids ?? reserveWorkoutIds(draft, null) } }} />)
  },
  state() { return JSON.parse(JSON.stringify({ decisions: current.value.draft.decisions, current: current.value.draft.current, ids: current.value.ids })) },
  outcome() {
    const outcome = workoutReviewOutcome(current.document, current.value.draft, current.value.ids)
    return JSON.parse(JSON.stringify({ ok: outcome.mapping.ok, value: outcome.mapping.ok ? outcome.mapping.value : null, issues: outcome.mapping.issues, ready: outcome.readiness.ready }))
  },
}
;(window as any).harnessReady = true
`

// ------------------------------------------------------------------------------------------------ interazioni
const text = selector => `(document.querySelector(${JSON.stringify(selector)})?.innerText ?? '')`
const buttonByText = (label, scope = '') => `[...document.querySelectorAll(${JSON.stringify(`${scope} button`.trim())})].find(element => element.textContent.trim() === ${JSON.stringify(label)})`
async function press(tab, finder, what) {
  const point = await tab.evaluate(`(() => { const element = (${finder}); if (!element) return null; element.scrollIntoView({ block: 'center' }); const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, disabled: Boolean(element.disabled) } })()`)
  if (!point) throw new Error(`Elemento assente: ${what}`)
  if (point.disabled) throw new Error(`Elemento disattivato: ${what}`)
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y })
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y })
  await pause(80)
}
const pressText = (tab, label, scope) => press(tab, buttonByText(label, scope), label)
/** Scrive come da tastiera (sostituendo il testo) ed esce dal campo: una decisione per campo. */
async function type(tab, selector, value, { leave = true } = {}) {
  await tab.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Campo assente: ${selector}'); element.scrollIntoView({ block: 'center' }); element.focus(); element.select?.() })()`)
  if (value === '') await tab.key('Backspace', 'Backspace', 8)
  else await tab.send('Input.insertText', { text: value })
  if (leave) await tab.evaluate('document.activeElement.blur()')
  await pause(80)
}
const lastDecision = async tab => (await tab.evaluate('harness.state()')).decisions.at(-1)
const noOverflow = 'document.documentElement.scrollWidth <= window.innerWidth'

async function run() {
  const harness = await buildComponentHarness({ name: 'import-workout-review-harness', entry: entrySource })
  cleanups.push(harness.cleanup)
  // Il bundle dei componenti non contiene scritture del catalogo né client di rete.
  const assets = join(harness.dist, 'assets')
  const bundle = (await Promise.all((await readdir(assets)).filter(file => file.endsWith('.js')).map(file => readFile(join(assets, file), 'utf8')))).join('\n')
  assert.doesNotMatch(bundle, /adopt_shared_exercise|save_workout_revision|commit_workout_import|supabase/i, 'nessuna scrittura o client di rete nella revisione')
  pass('bundle della revisione senza RPC di catalogo/programmi né client Supabase')

  const server = await serveStatic({ dist: harness.dist })
  cleanups.push(server.stop)
  const tab = await openTab(); tabs.push(tab)
  await tab.viewport(390, 844, true)
  await tab.navigate(server.origin, 'Boolean(window.harnessReady)')
  const mount = async spec => {
    await tab.evaluate(`harness.mount(${JSON.stringify(spec)})`)
    await tab.until(`Boolean(document.querySelector('[data-review=workout]'))`, 'revisione montata')
    await pause(60)
  }

  // 1. Golden 09: bozza con le decisioni del corpus → mapping, anteprima e conferma uguali ai golden.
  for (const name of ['workout-spec-example', 'workout-incomplete', 'workout-ranges-unicode', 'workout-abc-no-days', 'workout-out-of-bounds', 'workout-partially-interpretable']) {
    const { entry, document, extraction } = await fixtureCase(name)
    const golden = await readJson(`mapping/workout/${name}.json`)
    await mount({ document, extraction, decisions: [...entry.userDecisions, ...golden.additionalDecisions], ids: golden.ids, catalog })
    const outcome = await tab.evaluate('harness.outcome()')
    assert.equal(outcome.ok, true, `${name}: ${JSON.stringify(outcome.issues)}`)
    assert.deepEqual(outcome.value, golden.expected, name)
    const shown = await tab.evaluate(`[...document.querySelectorAll('[data-preview=workout] [data-prescription]')].map(element => element.dataset.prescription)`)
    assert.deepEqual(shown, golden.expected.program.days.flatMap(day => day.exercises.map(item => item.id)), `${name}: anteprima`)
    assert.ok(await tab.evaluate(`${text('[data-preview=workout]')}.includes(${JSON.stringify(golden.expected.program.title)})`))
    await pressText(tab, 'Conferma la revisione')
    const confirmed = await tab.evaluate('log.confirmed')
    assert.equal(confirmed.length, 1)
    assert.deepEqual(confirmed[0].mapping, golden.expected, `${name}: conferma`)
    assert.deepEqual(confirmed[0].ids, golden.ids)
  }
  pass('golden 09 (6 casi): mapping, anteprima e risultato confermato identici; ID prenotati passati invariati')

  // 2. Proposta grezza: nessuna conferma possibile, problemi prioritari, niente anteprima «quasi pronta».
  const spec = await fixtureCase('workout-spec-example')
  await mount({ document: spec.document, extraction: spec.extraction, catalog })
  const confirmButton = buttonByText('Conferma la revisione')
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), true)
  assert.equal(await tab.evaluate(`document.querySelectorAll('[data-preview=workout]').length`), 0)
  const openText = await tab.evaluate(text('[data-list=open]'))
  for (const expected of ['Scegliere calendario settimanale o rotazione', 'Associare l’esercizio al catalogo', 'Recupero non indicato', 'Serie facoltative non indicate']) assert.ok(openText.includes(expected), expected)
  const ids0 = (await tab.evaluate('harness.state()')).ids
  pass('proposta grezza: conferma disattivata, anteprima assente, calendario/catalogo/recupero/serie facoltative in evidenza')

  // Calendario esplicito (nessuna spunta generica).
  await pressText(tab, 'A rotazione')
  assert.deepEqual(await lastDecision(tab), { op: 'set', decisionId: (await lastDecision(tab)).decisionId, localId: 'i0', field: 'schedule', before: 'unknown', after: 'rotation', reason: 'user_edit' })
  // Dettaglio dell'esercizio, recupero 0 valido (non «mancante»), poi 120.
  await press(tab, `document.getElementById('rv-item-i2')`, 'riga esercizio')
  await tab.until(`Boolean(document.getElementById('rv-i2-restSeconds'))`)
  await type(tab, '#rv-i2-restSeconds', '0')
  assert.deepEqual((await lastDecision(tab)).after, { min: 0, max: 0 })
  assert.ok(!(await tab.evaluate(text('[data-list=open]'))).includes('Recupero non indicato'), 'recupero 0 accettato')
  await type(tab, '#rv-i2-restSeconds', '120')
  assert.deepEqual(await lastDecision(tab), { ...(await lastDecision(tab)), field: 'restSeconds', before: { min: 0, max: 0 }, after: { min: 120, max: 120 }, reason: 'user_edit' })
  assert.ok(await tab.evaluate(`[...document.querySelectorAll('.rv-origin')].some(element => element.textContent === 'Modificato da te')`))
  await pressText(tab, 'Nessuna serie facoltativa', '#rv-detail-i2')
  assert.deepEqual(await lastDecision(tab), { ...(await lastDecision(tab)), field: 'optionalSets', before: null, after: 0, reason: 'confirmed_missing' })
  pass('calendario, recupero (0 valido, poi 120) e «nessuna serie facoltativa» come decisioni tracciate, origine «Modificato da te»')

  // Picker: annulla senza decisioni, Esc, poi scelta dal catalogo personale senza scritture.
  const before = (await tab.evaluate('harness.state()')).decisions.length
  await press(tab, `document.getElementById('rv-i2-catalog-pick')`, 'apri picker')
  await tab.until(`Boolean(document.querySelector('dialog[open] .wr-picker'))`, 'picker aperto')
  const candidates = await tab.evaluate(`[...document.querySelectorAll('dialog[open] .wr-candidate')].map(element => element.dataset.candidate)`)
  assert.deepEqual(candidates.slice(0, 2).sort(), ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'])
  assert.ok(await tab.evaluate(`${text('dialog[open]')}.includes('Diverso dal documento') || ${text('dialog[open]')}.includes('Il documento non indica')`), 'identità esposta')
  await pressText(tab, 'Annulla', 'dialog[open]')
  await tab.until(`!document.querySelector('dialog[open]')`, 'picker chiuso')
  await press(tab, `document.getElementById('rv-i2-catalog-pick')`, 'apri picker')
  await tab.until(`Boolean(document.querySelector('dialog[open] .wr-picker'))`)
  await tab.key('Escape', 'Escape', 27)
  await tab.until(`!document.querySelector('dialog[open]')`, 'Esc chiude il picker')
  await tab.until(`document.activeElement?.id === 'rv-item-i2'`, 'focus alla riga dopo l’annullamento')
  assert.equal((await tab.evaluate('harness.state()')).decisions.length, before, 'annulla: nessuna decisione')
  await press(tab, `document.getElementById('rv-i2-catalog-pick')`, 'apri picker')
  await tab.until(`Boolean(document.querySelector('dialog[open] .wr-picker'))`)
  await press(tab, `document.querySelector('dialog[open] [data-candidate="11111111-1111-4111-8111-111111111111"] button')`, 'scegli Squat personale')
  await tab.until(`!document.querySelector('dialog[open]')`)
  const chosen = await lastDecision(tab)
  assert.equal(chosen.op, 'catalog'); assert.equal(chosen.after.source, 'existing'); assert.equal(chosen.after.personalId, '11111111-1111-4111-8111-111111111111')
  assert.ok(await tab.evaluate(`${text('#rv-detail-i2')}.includes('Scelto dal catalogo')`))
  pass('picker: candidati 08 con identità, Annulla/Esc senza decisioni e focus alla riga, scelta existing come sola decisione')

  // Ora pronta: anteprima dal mapper, conferma, ID prenotati invariati.
  await tab.until(`Boolean(document.querySelector('[data-preview=workout]'))`, 'anteprima disponibile')
  const ready = await tab.evaluate('harness.outcome()')
  assert.equal(ready.ready, true)
  const state1 = await tab.evaluate('harness.state()')
  assert.deepEqual(state1.ids.items, ids0.items); assert.equal(state1.ids.planId, ids0.planId)
  assert.ok(await tab.evaluate(`${text('[data-preview=workout]')}.includes('Dal tuo catalogo')`))
  await pressText(tab, 'Conferma la revisione')
  assert.deepEqual((await tab.evaluate('log.confirmed'))[0].mapping, ready.value)
  pass('revisione pronta: anteprima e conferma dallo stesso mapping reale, prenotazioni stabili')

  // Aggiunta/rimozione: un esercizio nuovo non ha fonte né valori inventati, blocca e poi si rimuove.
  await pressText(tab, 'Aggiungi un esercizio')
  await tab.until(`document.activeElement?.id === 'rv-u1-name'`, 'focus sul nome del nuovo esercizio')
  const added = (await tab.evaluate('harness.state()')).current.find(item => item.localId === 'u1')
  assert.deepEqual([added.values.sets, added.values.restSeconds, added.values.optionalSets, added.values.measurementMode, added.catalog], [null, null, null, null, null])
  assert.equal(await tab.evaluate(`document.querySelectorAll('#rv-detail-u1 .rv-source-link').length`), 0, 'nessuna fonte per righe dell’utente')
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), true)
  const u1Ids = (await tab.evaluate('harness.state()')).ids
  assert.ok(u1Ids.items.u1)
  await press(tab, `document.querySelector('[aria-label="Rimuovi esercizio Esercizio senza nome"]')`, 'rimuovi esercizio aggiunto')
  await tab.until(`!document.getElementById('rv-item-u1')`)
  assert.equal((await lastDecision(tab)).op, 'remove')
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), false)
  pass('aggiunta di un esercizio: campi vuoti, nessuna fonte, focus al nome, conferma bloccata; rimozione ripristina la prontezza')

  // Testo oltre il limite: nessun taglio, contatore e problema bloccante.
  const long = 'S'.repeat(161)
  await type(tab, '#rv-i0-title', long)
  assert.equal((await tab.evaluate('harness.state()')).current[0].values.title.length, 161)
  assert.ok(await tab.evaluate(`${text('#rv-item-i0')}.includes('oltre il limite')`))
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), true)
  await type(tab, '#rv-i0-title', 'Scheda esempio')
  pass('testo oltre il limite conservato per intero, segnalato e bloccante')

  // 3. Riordino A/B/C: fonte per campo stabile, anteprima nel nuovo ordine, esercizio spostato fra sedute.
  const abc = await fixtureCase('workout-abc-no-days')
  await mount({ document: abc.document, extraction: abc.extraction, decisions: abc.entry.userDecisions, catalog })
  const highlighted = `[...document.querySelectorAll('.source-block.is-highlighted')].map(element => element.dataset.blockId).sort()`
  await press(tab, `document.getElementById('rv-item-i4')`, 'apri Panca')
  await tab.until(`Boolean(document.querySelector('[aria-label="Mostra nella fonte: Nome"]'))`)
  await press(tab, `document.querySelector('#rv-detail-i4 [aria-label="Mostra nella fonte: Nome"]')`, 'fonte del nome')
  const refsBefore = await tab.evaluate(highlighted)
  assert.ok(refsBefore.length > 0)
  await press(tab, `document.getElementById('rv-move-i3-up')`, 'sposta su B')
  await tab.until(`document.activeElement?.id === 'rv-move-i3-down'`, 'focus sullo spostamento dopo il riordino')
  const move = await lastDecision(tab)
  assert.deepEqual([move.op, move.localId, move.fromIndex, move.toIndex], ['move', 'i3', 1, 0])
  await press(tab, `document.querySelector('#rv-detail-i4 [aria-label="Mostra nella fonte: Nome"]')`, 'fonte del nome dopo il riordino')
  assert.deepEqual(await tab.evaluate(highlighted), refsBefore, 'stessi blocchi dopo il riordino')
  const reordered = await tab.evaluate('harness.outcome()')
  assert.deepEqual(reordered.value.program.days.map(day => day.label), ['B', 'A', 'C'])
  assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('[data-preview=workout] .wr-preview-day h4')].map(element => element.textContent.split(' · ')[0])`), ['B', 'A', 'C'])
  await tab.evaluate(`(() => { const select = document.querySelector('#rv-detail-i4 .wr-move-session select'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, 'i5'); select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await pause(80)
  const moved = await lastDecision(tab)
  assert.deepEqual([moved.op, moved.localId, moved.toParentLocalId], ['move', 'i4', 'i5'])
  const afterMove = await tab.evaluate('harness.outcome()')
  assert.equal(afterMove.ok, false, 'seduta B vuota: bloccata, non scartata')
  assert.ok(await tab.evaluate(`${text('[data-list=open]')}.includes('La seduta non ha esercizi.')`))
  pass('riordino sedute e spostamento fra sedute: decisioni move, fonte del campo invariata, anteprima nell’ordine nuovo, seduta vuota bloccante')

  // 4. Intervalli: timer scelto dentro l'intervallo, intervallo del documento in anteprima.
  const ranges = await fixtureCase('workout-ranges-unicode')
  const rangeDecisions = ranges.entry.userDecisions.filter(decision => decision.decisionId !== 'd2')
  await mount({ document: ranges.document, extraction: ranges.extraction, decisions: rangeDecisions, catalog })
  assert.ok((await tab.evaluate(text('[data-list=open]'))).includes('Recupero a intervallo'))
  await press(tab, `document.getElementById('rv-item-i2')`, 'apri trazioni')
  await tab.until(`Boolean(document.getElementById('rv-i2-restSeconds-scalar'))`)
  assert.ok(await tab.evaluate(`${text('#rv-detail-i2')}.includes('documento: 90–120')`))
  await type(tab, '#rv-i2-restSeconds-scalar', '90', { leave: false })
  await pressText(tab, 'Usa questo valore', '#rv-detail-i2')
  const timer = await lastDecision(tab)
  assert.deepEqual([timer.field, timer.before, timer.after, timer.reason], ['restSeconds', { min: 90, max: 120 }, { min: 90, max: 90 }, 'timer_choice'])
  await tab.until(`Boolean(document.querySelector('[data-preview=workout]'))`)
  assert.ok(await tab.evaluate(`${text('[data-preview=workout]')}.includes('Recupero: documento 90–120 s, scelto 90 s')`))
  const golden = await readJson('mapping/workout/workout-ranges-unicode.json')
  assert.deepEqual((await tab.evaluate('harness.outcome()')).value.program.days[0].exercises[0].restSeconds, golden.expected.program.days[0].exercises[0].restSeconds)
  pass('intervallo del recupero: scelta del timer esplicita, intervallo originale e valore scelto in anteprima')

  // 5. Fasi e regole: descrizione scritta + conferma, poi nuova conferma dopo un cambio della scheda.
  const partial = await fixtureCase('workout-partially-interpretable')
  await mount({ document: partial.document, extraction: partial.extraction, decisions: partial.entry.userDecisions, catalog })
  await pressText(tab, 'A rotazione')
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), true)
  assert.ok(await tab.evaluate(`${text('#rv-rules-title')}.length > 0 && document.querySelectorAll('.wr-rule').length === 3`))
  assert.equal(await tab.evaluate(`${buttonByText('Conferma questa scelta', '#rv-item-i6')}.disabled`), true, 'senza descrizione nessuna conferma')
  const scopes = { i6: 'Importo la settimana 1 così com’è; la progressione la applico a mano.', i7: 'Nessuno scarico importato: lo gestisco a mano.', i8: 'Superserie eseguita a mano, esercizi in sequenza.' }
  for (const [localId, description] of Object.entries(scopes)) {
    await type(tab, `#rv-${localId}-text`, description, { leave: false })
    await pressText(tab, 'Conferma questa scelta', `#rv-item-${localId}`)
    const [set, confirm] = (await tab.evaluate('harness.state()')).decisions.slice(-2)
    assert.deepEqual([set.op, set.field, set.after, set.reason, confirm.op, confirm.issueCode, confirm.reason], ['set', 'text', description, 'scope_choice', 'confirm', 'complex_rule_unresolved', 'scope_choice'])
  }
  await tab.until(`!${buttonByText('Conferma la revisione')}.disabled`, 'pronta dopo le scelte di fase')
  const phased = await tab.evaluate('harness.outcome()')
  assert.ok(phased.value.program.guidance.includes('Limite di esecuzione'))
  assert.ok(phased.value.program.guidance.includes(scopes.i6))
  assert.ok(await tab.evaluate(`${text('[data-preview=workout]')}.includes('regola prima della scelta')`), 'testo originale della regola conservato')
  await press(tab, `document.getElementById('rv-item-i2')`, 'apri squat')
  await type(tab, '#rv-i2-restSeconds', '150')
  await tab.until(`${text('#rv-item-i6')}.includes('confermare di nuovo')`, 'scelta di fase da riconfermare')
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), true)
  for (const localId of ['i6', 'i7', 'i8']) await pressText(tab, 'Conferma di nuovo', `#rv-item-${localId}`)
  await tab.until(`!${buttonByText('Conferma la revisione')}.disabled`, 'pronta dopo la nuova conferma')
  pass('fasi/progressioni/superserie: descrizione scritta (scope_choice) + conferma; modifica successiva richiede nuova conferma; testo originale e limite nelle indicazioni')

  // Conferma superata dall'edit: il valore confermato cambia → «da confermare di nuovo».
  await type(tab, '#rv-i2-sets', '4')
  await type(tab, '#rv-i2-sets', '3')
  assert.equal((await tab.evaluate('harness.state()')).current.find(item => item.localId === 'i2').values.sets, 3)
  pass('conferme legate al valore: edit e ritorno al valore confermato tracciati come decisioni')

  // 6. Due sedute nello stesso giorno: il mapping le blocca, visibili, conferma disattivata.
  const weekly = await fixtureCase('workout-ranges-unicode')
  await mount({ document: weekly.document, extraction: weekly.extraction, decisions: weekly.entry.userDecisions, catalog })
  await pressText(tab, 'Aggiungi una seduta')
  await tab.until(`document.activeElement?.id === 'rv-u1-label'`, 'focus sull’etichetta della nuova seduta')
  await type(tab, '#rv-u1-label', 'Lun')
  await type(tab, '#rv-u1-title', 'Seconda seduta')
  await tab.evaluate(`(() => { const select = document.getElementById('rv-u1-weekday'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, '1'); select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await pause(80)
  // Un esercizio nella nuova seduta: il blocco non dipende dalla seduta vuota.
  await press(tab, `document.getElementById('rv-item-i4')`, 'apri stacco')
  await tab.evaluate(`(() => { const select = document.querySelector('#rv-detail-i4 .wr-move-session select'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, 'u1'); select.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await pause(80)
  const twoOnMonday = await tab.evaluate('harness.outcome()')
  assert.equal(twoOnMonday.ok, false)
  assert.ok(twoOnMonday.issues.some(issue => issue.code === 'resolved_contract_violation' && issue.message.includes('/days/1/label')))
  assert.ok(await tab.evaluate(`${text('[data-list=open]')}.includes('Due sedute cadono nello stesso giorno')`))
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), true)
  pass('due sedute nello stesso giorno: bloccate e segnalate, nessuna conferma')

  // 7. Catalogo non letto per intero: suggerimenti visibili, scelta dal catalogo disattivata.
  await mount({ document: spec.document, extraction: spec.extraction, catalog: { ...catalog, complete: false } })
  await press(tab, `document.getElementById('rv-item-i2')`, 'apri esercizio')
  await press(tab, `document.getElementById('rv-i2-catalog-pick')`, 'apri picker')
  await tab.until(`Boolean(document.querySelector('dialog[open] .wr-picker'))`)
  assert.ok(await tab.evaluate(`${text('dialog[open]')}.includes('non è stato letto per intero')`))
  assert.ok(await tab.evaluate(`[...document.querySelectorAll('dialog[open] .wr-candidate button')].every(button => button.disabled)`))
  // Nuovo esercizio: metadati assenti da scegliere, conferma esplicita, nessuna scrittura.
  await pressText(tab, 'Nuovo esercizio', 'dialog[open]')
  assert.equal(await tab.evaluate(`${buttonByText('Usa come nuovo esercizio', 'dialog[open]')}.disabled`), true)
  assert.ok(await tab.evaluate(`${text('dialog[open]')}.includes('Da scegliere')`))
  for (const label of ['Carico totale', 'kg', 'No']) await pressText(tab, label, 'dialog[open] .wr-new')
  await press(tab, `document.querySelector('dialog[open] .wr-new input[type=checkbox]')`, 'conferma dati')
  await pressText(tab, 'Usa come nuovo esercizio', 'dialog[open]')
  await tab.until(`!document.querySelector('dialog[open]')`)
  const created = await lastDecision(tab)
  assert.deepEqual([created.op, created.after.source, created.after.values.loadConvention, created.after.values.perSide], ['catalog', 'new', 'total', false])
  const reserved = (await tab.evaluate('harness.state()')).ids.exercises
  assert.ok(reserved[`new:${created.after.localKey}`], 'ID prenotato per il nuovo esercizio')
  pass('catalogo incompleto: nessuna scelta dal catalogo; nuovo esercizio solo con metadati scelti e confermati, ID prenotato')

  // 8. Rianalisi: confronto senza sovrascrivere gli edit, adozione solo esplicita.
  const changed = structuredClone(spec.extraction)
  changed.title = 'Scheda esempio rivista'
  await mount({ document: spec.document, extraction: spec.extraction, decisions: spec.entry.userDecisions, reanalysis: changed, catalog })
  assert.ok(await tab.evaluate(`${text('.rv-reanalysis')}.includes('Scheda esempio rivista')`))
  const kept = (await tab.evaluate('harness.state()')).decisions.length
  await pressText(tab, 'Continua con la revisione attuale')
  assert.equal(await tab.evaluate('log.dismissed'), 1)
  await pressText(tab, 'Usa la nuova analisi')
  assert.equal(await tab.evaluate('log.adopted'), 1)
  assert.equal((await tab.evaluate('harness.state()')).decisions.length, kept, 'edit non sovrascritti')
  pass('rianalisi: differenze mostrate, scelta demandata al chiamante, edit intatti')

  // 9. Viewport e tastiera.
  await mount({ document: partial.document, extraction: partial.extraction, decisions: partial.entry.userDecisions, catalog })
  await mkdir(shots, { recursive: true })
  for (const width of [320, 390, 768, 1440]) {
    await tab.viewport(width, 900, width < 720)
    await press(tab, `document.getElementById('rv-item-i2')`, 'apri dettaglio')
    await tab.until(noOverflow, `nessun overflow a ${width}px`)
    await tab.screenshot(join(shots, `workout-review-${width}.png`))
    await press(tab, `document.getElementById('rv-item-i2')`, 'chiudi dettaglio')
  }
  await tab.viewport(390, 844, true)
  await tab.evaluate(`document.getElementById('rv-item-i2').focus()`)
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) })
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await tab.until(`document.getElementById('rv-item-i2').getAttribute('aria-expanded') === 'true'`, 'dettaglio aperto da tastiera')
  await press(tab, buttonByText('Vai al punto', '[data-list=open]'), 'vai al primo problema')
  await tab.until(`document.activeElement && document.activeElement !== document.body`, 'focus al punto del problema')
  pass('viewport 320/390/768/1440 senza overflow; dettaglio da tastiera; «Vai al punto» porta il focus')

  assert.deepEqual(await tab.evaluate('log.network'), [], 'nessuna chiamata di rete (catalogo, programmi, API)')
  assert.ok(tab.requests.every(url => url.startsWith(server.origin) || url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank'), tab.requests.join('\n'))
  assert.deepEqual(tab.errors, [])
  pass('nessuna richiesta fuori dal server dei componenti, nessun errore in console')
}

try {
  started.push(await ensureChrome())
  console.log('import-workout-review-browser-check')
  await run()
  await mkdir(shots, { recursive: true })
  await writeFile(join(shots, 'report.json'), JSON.stringify({ status: 'passed', mode: 'harness isolato dei componenti, moduli reali 06–09, nessuna rete', checks, date: new Date().toISOString() }, null, 2))
  console.log(`import-workout-review-browser-check: PASS (${checks.length} controlli)`)
} catch (error) {
  for (const tab of tabs) console.error('DIAG', JSON.stringify({ text: await tab.evaluate(`document.querySelector('main')?.innerText.slice(0, 2500) ?? ''`).catch(() => ''), errors: tab.errors }))
  throw error
} finally {
  for (const tab of tabs) await tab.close()
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {})
  for (const process of started.reverse()) await process.stop()
}
