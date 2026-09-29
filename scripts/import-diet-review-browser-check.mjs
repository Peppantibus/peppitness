// Prova browser del task 13: revisione del piano alimentare importato montata con stato sintetico nell'harness
// isolato del task 11 (build Vite dei soli componenti, server locale con la CSP dell'app, Chrome CDP dedicato). Usa i
// moduli reali: bozza e decisioni (07), validazione (06), mapper (10). Nessuna preview dell'app, nessun endpoint o
// RPC, nessuna rete: fetch/XHR/beacon sono registrati e rifiutati nella pagina.
//
// Comando (PowerShell, dalla radice del progetto):
//   node scripts/import-diet-review-browser-check.mjs
// Se su 127.0.0.1:9223 non c'è un Chrome di test lo avvia headless con un profilo temporaneo in artifacts/ (mai
// quello personale) e alla fine chiude solo ciò che ha avviato. Variabili: TEST_DEBUG_URL, CHROME_PATH.
// Fonti: soltanto fixture sintetiche di tests/fixtures/import. Screenshot in artifacts/import-diet-review/.
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildComponentHarness, ensureChrome, openTab, pause, root, serveStatic } from './lib/import-browser-harness.mjs'

const fixtures = join(root, 'tests', 'fixtures', 'import')
const readJson = async path => JSON.parse(await readFile(join(fixtures, path), 'utf8'))
const shots = join(root, 'artifacts', 'import-diet-review')
const checks = []
const pass = label => { checks.push(label); console.log(`  ✓ ${label}`) }
const started = []
const tabs = []
const cleanups = []

const manifest = await readJson('manifest.json')
async function fixtureCase(name) {
  const entry = manifest.cases.find(item => item.id === name)
  return { entry, document: await readJson(entry.expectedBlocks), extraction: await readJson(entry.expectedProposal) }
}
// Prenotazioni dei golden 10: piano …002, elementi …010 + posizione nella bozza corrente.
const uuid = n => `80000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const entrySource = at => `
import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '${at('styles.css')}'
import { DietReview } from '${at('features/import/DietReview.tsx')}'
import { dietReviewOutcome, reserveDietIds } from '${at('features/import/review-model.ts')}'
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
  return <DietReview document={init.document} format="docx" value={value} onChange={onChange} reanalysis={init.reanalysis}
    onAdoptReanalysis={init.reanalysis ? () => { log.adopted++ } : undefined} onDismissReanalysis={init.reanalysis ? () => { log.dismissed++ } : undefined}
    onConfirm={(result: any) => { log.confirmed.push(JSON.parse(JSON.stringify(result))) }} newId={() => 'u' + (++log.newIds)} />
}
;(window as any).harness = {
  mount(spec: any) {
    let draft: any = createReviewDraft({ kind: 'diet', extraction: spec.extraction, proposalId: '80000000-0000-4000-8000-000000000001', jobId: null, source: source as any, localIds: sequentialLocalIds('i') })
    for (const decision of spec.decisions ?? []) draft = applyDecision(draft, decision)
    const reanalysis = spec.reanalysis ? createReviewDraft({ kind: 'diet', extraction: spec.reanalysis, proposalId: '80000000-0000-4000-8000-000000000009', jobId: null, source: source as any, previous: { proposalId: draft.proposal.proposalId, proposalVersion: 1 }, localIds: sequentialLocalIds('n') }) : null
    Object.assign(log, { changes: 0, confirmed: [], adopted: 0, dismissed: 0, newIds: 0 })
    const ids = spec.goldenIds ? { planId: '${uuid(2)}', items: Object.fromEntries(draft.current.map((item: any, n: number) => [item.localId, '80000000-0000-4000-8000-' + String(10 + n).padStart(12, '0')])) } : reserveDietIds(draft, null)
    root.render(<Host key={++mount} init={{ document: spec.document, reanalysis, value: { draft, ids } }} />)
  },
  state() { return JSON.parse(JSON.stringify({ decisions: current.value.draft.decisions, current: current.value.draft.current, ids: current.value.ids })) },
  outcome() {
    const outcome = dietReviewOutcome(current.document, current.value.draft, current.value.ids)
    return JSON.parse(JSON.stringify({ ok: outcome.mapping.ok, value: outcome.mapping.ok ? outcome.mapping.value : null, issues: outcome.mapping.issues, ready: outcome.readiness.ready, findings: outcome.validation.findings.map((f: any) => f.issue.code) }))
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
async function type(tab, selector, value, { leave = true } = {}) {
  await tab.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Campo assente: ${selector}'); element.scrollIntoView({ block: 'center' }); element.focus(); element.select?.() })()`)
  if (value === '') await tab.key('Backspace', 'Backspace', 8)
  else await tab.send('Input.insertText', { text: value })
  if (leave) await tab.evaluate('document.activeElement.blur()')
  await pause(80)
}
const selectValue = (tab, selector, value) => tab.evaluate(`(() => { const select = document.querySelector(${JSON.stringify(selector)}); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, ${JSON.stringify(value)}); select.dispatchEvent(new Event('change', { bubbles: true })) })()`).then(() => pause(80))
const lastDecision = async tab => (await tab.evaluate('harness.state()')).decisions.at(-1)
const noOverflow = 'document.documentElement.scrollWidth <= window.innerWidth'
const confirmButton = buttonByText('Conferma la revisione')

async function run() {
  const harness = await buildComponentHarness({ name: 'import-diet-review-harness', entry: entrySource })
  cleanups.push(harness.cleanup)
  const assets = join(harness.dist, 'assets')
  const bundle = (await Promise.all((await readdir(assets)).filter(file => file.endsWith('.js')).map(file => readFile(join(assets, file), 'utf8')))).join('\n')
  assert.doesNotMatch(bundle, /commit_diet_import|save_meal_plan|meal_plans|supabase/i, 'nessuna scrittura o client di rete nella revisione')
  assert.doesNotMatch(bundle, /WorkoutReview|wr-review/, 'la revisione dieta non dipende dalla UI workout')
  pass('bundle della revisione dieta senza RPC/tabelle dei piani né client Supabase, indipendente dalla UI workout')

  const server = await serveStatic({ dist: harness.dist })
  cleanups.push(server.stop)
  const tab = await openTab(); tabs.push(tab)
  await tab.viewport(390, 844, true)
  await tab.navigate(server.origin, 'Boolean(window.harnessReady)')
  const mount = async spec => {
    await tab.evaluate(`harness.mount(${JSON.stringify(spec)})`)
    await tab.until(`Boolean(document.querySelector('[data-review=diet]'))`, 'revisione montata')
    await pause(60)
  }

  // 1. Golden 10: MealPlanDraft, anteprima e risultato confermato identici.
  const spec = await fixtureCase('diet-spec-example')
  const alt = await fixtureCase('diet-alternatives-additions')
  const conditions = await readJson('mapping/diet/reviewed-conditions.json')
  const goldens = [
    { name: 'diet-spec-example', fixture: spec, decisions: spec.entry.userDecisions, expected: await readJson('mapping/diet/diet-spec-example.json') },
    { name: 'diet-alternatives-additions', fixture: alt, decisions: alt.entry.userDecisions, expected: await readJson('mapping/diet/diet-alternatives-additions.json') },
    { name: 'reviewed-conditions', fixture: spec, decisions: [...spec.entry.userDecisions, ...conditions.additionalDecisions], expected: conditions.expected },
  ]
  for (const golden of goldens) {
    await mount({ document: golden.fixture.document, extraction: golden.fixture.extraction, decisions: golden.decisions, goldenIds: true })
    const outcome = await tab.evaluate('harness.outcome()')
    assert.equal(outcome.ok, true, `${golden.name}: ${JSON.stringify(outcome.issues)}`)
    assert.deepEqual(outcome.value.plan, golden.expected, golden.name)
    assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('[data-preview=diet] [data-meal]')].map(element => element.dataset.meal)`),
      golden.expected.document.days.flatMap(day => day.meals.map(meal => meal.id)), `${golden.name}: pasti in anteprima`)
    for (const day of golden.expected.document.days) for (const meal of day.meals) {
      const selector = `[data-preview=diet] [data-meal="${meal.id}"]`
      assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('${selector} .dr-preview-foods li')].map(element => element.textContent)`), meal.foods.map(food => food.quantity ? `${food.name} · ${food.quantity}` : food.name), `${golden.name}: alimenti base`)
      assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('${selector} .is-alternatives li')].map(element => element.textContent)`), meal.alternatives, `${golden.name}: alternative separate`)
      assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('${selector} .is-additions li')].map(element => element.textContent)`), meal.additions, `${golden.name}: aggiunte separate`)
    }
    if (golden.expected.document.guidance) assert.ok(await tab.evaluate(`${text('[data-preview=diet] .dr-preview-guidance')}.includes(${JSON.stringify(golden.expected.document.guidance)})`))
    const bytes = new TextEncoder().encode(JSON.stringify(golden.expected.document)).length
    assert.equal(await tab.evaluate(`Number(document.querySelector('[data-bytes]').dataset.bytes)`), bytes)
    await pressText(tab, 'Conferma la revisione')
    const confirmed = await tab.evaluate('log.confirmed')
    assert.equal(confirmed.length, 1)
    assert.deepEqual(confirmed[0].mapping.plan, golden.expected, `${golden.name}: conferma`)
  }
  pass('golden 10 (3 casi): MealPlanDraft, anteprima completa (alimenti, alternative, aggiunte, indicazioni, byte) e conferma identici')

  // Note degli alimenti trasferite al pasto: evidenziate con il nome dell'alimento.
  assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('[data-preview=diet] .is-food-note')].map(element => element.textContent.trim())`),
    ['Nota dell’alimento 1 yogurt bianco (alimento 1): Proteine 12 g', 'Nota dell’alimento 1 yogurt bianco (alimento 1): Solo se tollerato'])
  assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('[data-preview=diet] .is-alternatives li')].map(element => element.textContent)`),
    ['Opzione A, intera colazione: latte 200 ml e pane 60 g.', 'Opzione B, intera colazione: yogurt 170 g e frutta 1 porzione.'])
  pass('due colazioni alternative complete restano frasi separate; note degli alimenti evidenziate nel pasto con il nome')

  // 2. Tipo di giornata ignoto: scelta esplicita, «qualsiasi giorno» mai predefinito.
  await mount({ document: alt.document, extraction: alt.extraction })
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), true)
  assert.ok((await tab.evaluate(text('[data-list=open]'))).includes('Indicare se la giornata vale'))
  assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('#rv-i1-dayType-group button[aria-pressed=true]')].map(button => button.textContent)`), ['Non indicato'], 'nessuna scelta preselezionata')
  assert.equal(await tab.evaluate(`document.querySelectorAll('[data-preview=diet]').length`), 0)
  await pressText(tab, 'Qualsiasi giorno', '#rv-i1-dayType-group')
  const dayType = await lastDecision(tab)
  assert.deepEqual([dayType.localId, dayType.field, dayType.before, dayType.after, dayType.reason], ['i1', 'dayType', null, 'any', 'user_edit'])
  await tab.until(`!${confirmButton}.disabled`, 'pronta dopo la scelta del tipo di giornata')
  pass('tipo di giornata ignoto: conferma bloccata, nessuna opzione preselezionata, «Qualsiasi giorno» scelto esplicitamente')

  // Ambiti visibili: base / alternative / aggiunte distinte; regola globale una sola volta.
  const baseText = await tab.evaluate(text('[data-local-id=i2] .dr-scope.is-base'))
  assert.ok(!baseText.includes('Yogurt → latte 200 ml'), 'alternativa fuori dal pasto base')
  assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('[data-local-id=i2] .dr-scope.is-alternatives textarea')].map(element => element.value)`), ['Yogurt → latte 200 ml', 'Opzione B colazione: pane integrale 60 g e marmellata 20 g.'])
  assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('[data-local-id=i8] .dr-scope.is-additions textarea')].map(element => element.value)`), ['Se ti alleni nel pomeriggio aggiungi 30 g di pane'])
  assert.equal(await tab.evaluate(`document.querySelectorAll('.dr-rule').length`), 1)
  const ruleText = 'Nei giorni di allenamento lungo aggiungere 20 g di frutta secca a scelta.'
  assert.equal(await tab.evaluate(`${text('[data-preview=diet]')}.split(${JSON.stringify(ruleText)}).length - 1`), 1, 'regola globale una sola volta in anteprima')
  assert.equal(await tab.evaluate(`[...document.querySelectorAll('[data-preview=diet] .dr-preview-foods li')].length`), 5, 'solo gli alimenti base')
  pass('piano base, alternative e aggiunte in sezioni distinte; regola dell’intero piano una volta; alternative non sommate al base')

  // Regola globale copiata in una nota del pasto: bloccante e visibile.
  await pressText(tab, 'Aggiungi una nota', '[data-local-id=i5] > .rv-field')
  await tab.until(`document.activeElement?.id === 'rv-i5-notes-0'`, 'focus sulla nuova nota')
  await type(tab, '#rv-i5-notes-0', `Ricorda: ${ruleText}`)
  const copied = await tab.evaluate('harness.outcome()')
  assert.equal(copied.ok, false)
  assert.ok(copied.findings.includes('global_rule_in_meal') || copied.issues.some(issue => issue.code === 'diet_global_rule_local_note'))
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), true)
  await press(tab, `document.querySelector('[aria-label="Rimuovi nota del pasto 1"]')`, 'rimuovi la nota copiata')
  await tab.until(`!${confirmButton}.disabled`, 'pronta dopo la rimozione della copia')
  pass('regola dell’intero piano copiata in un pasto: bloccata e segnalata finché non si toglie la copia')

  // 3. Quantità mancante: conferma del vuoto esplicita; «q.b.» e «0» come testo valido.
  await mount({ document: spec.document, extraction: spec.extraction, decisions: [conditions.additionalDecisions[0]] })
  assert.ok((await tab.evaluate(text('[data-list=open]'))).includes('Quantità non indicata'))
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), true)
  await pressText(tab, 'Quantità non indicata: confermo', '[data-local-id=i3]')
  const empty = await lastDecision(tab)
  assert.deepEqual([empty.field, empty.before, empty.after, empty.reason], ['quantityText', null, '', 'confirmed_missing'])
  await tab.until(`!${confirmButton}.disabled`, 'pronta con quantità confermata vuota')
  assert.deepEqual((await tab.evaluate('harness.outcome()')).value.plan.document.days[0].meals[0].foods, [{ name: 'yogurt bianco', quantity: '' }])
  for (const quantity of ['q.b.', 'a piacere', '0']) {
    await type(tab, '#rv-i3-quantityText', quantity)
    assert.equal((await tab.evaluate('harness.outcome()')).value.plan.document.days[0].meals[0].foods[0].quantity, quantity)
  }
  pass('quantità assente: nessuna proposta, conferma del vuoto (confirmed_missing); «q.b.», «a piacere» e «0» restano testo')

  // 4. Aggiunte, rimozioni, riordino e fonte stabile.
  await mount({ document: alt.document, extraction: alt.extraction, decisions: alt.entry.userDecisions })
  await pressText(tab, 'Aggiungi un alimento', '[data-local-id=i5]')
  await tab.until(`document.activeElement?.id === 'rv-u1-name'`, 'focus sul nome del nuovo alimento')
  const addedFood = (await tab.evaluate('harness.state()')).current.find(item => item.localId === 'u1')
  assert.deepEqual(addedFood.values, { name: null, quantityText: null, notes: [] })
  assert.equal(await tab.evaluate(`document.querySelectorAll('[data-local-id=u1] .rv-source-link').length`), 0, 'nessuna fonte per righe dell’utente')
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), true)
  await type(tab, '#rv-u1-name', 'Insalata')
  await type(tab, '#rv-u1-quantityText', 'a piacere')
  await tab.until(`!${confirmButton}.disabled`, 'alimento aggiunto completo')
  assert.ok(await tab.evaluate(`${text('[data-local-id=u1]')}.includes('Modificato da te')`))
  await press(tab, `document.querySelector('[aria-label="Rimuovi alimento Insalata"]')`, 'rimuovi alimento')
  await tab.until(`!document.querySelector('[data-local-id=u1]')`)
  assert.equal((await lastDecision(tab)).op, 'remove')
  await pressText(tab, 'Aggiungi una giornata')
  await tab.until(`document.activeElement?.id === 'rv-u2-name'`, 'focus sul nome della nuova giornata')
  assert.equal(await tab.evaluate(`${confirmButton}.disabled`), true, 'giornata senza pasti bloccata')
  assert.ok((await tab.evaluate(text('[data-list=open]'))).includes('La giornata non ha pasti.'))
  await press(tab, `document.querySelector('[aria-label="Rimuovi giornata"]')`, 'rimuovi giornata vuota')
  await tab.until(`!${confirmButton}.disabled`, 'pronta dopo la rimozione')
  const highlighted = `[...document.querySelectorAll('.source-block.is-highlighted')].map(element => element.dataset.blockId).sort()`
  await press(tab, `document.querySelector('[data-local-id=i6] [aria-label="Mostra nella fonte: Alimento"]')`, 'fonte della pasta')
  const refs = await tab.evaluate(highlighted)
  assert.ok(refs.length > 0)
  await press(tab, `document.getElementById('rv-move-i5-up')`, 'pranzo su')
  await tab.until(`document.activeElement?.id === 'rv-move-i5-down'`, 'focus dopo il riordino')
  const moved = await lastDecision(tab)
  assert.deepEqual([moved.op, moved.localId, moved.fromIndex, moved.toIndex], ['move', 'i5', 1, 0])
  await press(tab, `document.querySelector('[data-local-id=i6] [aria-label="Mostra nella fonte: Alimento"]')`, 'fonte della pasta dopo il riordino')
  assert.deepEqual(await tab.evaluate(highlighted), refs, 'stessi blocchi dopo il riordino')
  const reordered = await tab.evaluate('harness.outcome()')
  assert.deepEqual(reordered.value.plan.document.days[0].meals.map(meal => meal.name), ['Pranzo', 'Colazione', 'Spuntino'])
  const mealIds = (await tab.evaluate('harness.state()')).ids.items
  await selectValue(tab, '[data-local-id=i7] .dr-move select', 'i8')
  const foodMove = await lastDecision(tab)
  assert.deepEqual([foodMove.op, foodMove.localId, foodMove.toParentLocalId], ['move', 'i7', 'i8'])
  const afterFoodMove = await tab.evaluate('harness.outcome()')
  assert.deepEqual(afterFoodMove.value.plan.document.days[0].meals.find(meal => meal.name === 'Spuntino').foods.map(food => food.name), ['Mela', 'olio EVO'])
  assert.deepEqual((await tab.evaluate('harness.state()')).ids.items, mealIds, 'prenotazioni stabili dopo i riordini')
  assert.deepEqual(Object.values(afterFoodMove.value.plan.document.days[0].meals.map(meal => meal.id)).sort(), [mealIds.i2, mealIds.i5, mealIds.i8].sort())
  pass('aggiunta/rimozione di alimenti e giornate, riordino dei pasti e spostamento di un alimento: decisioni tracciate, fonte e prenotazioni stabili')

  // Rimozione di un pasto con problemi: i suoi problemi spariscono con lui, niente residui.
  await mount({ document: alt.document, extraction: alt.extraction })
  await press(tab, `document.querySelector('[aria-label="Rimuovi pasto Spuntino"]')`, 'rimuovi spuntino')
  assert.ok(!(await tab.evaluate('harness.outcome()')).issues.some(issue => issue.localId === 'i8' || issue.localId === 'i9'))
  pass('rimozione di un pasto: alimenti e problemi rimossi insieme, nessun riferimento pendente')

  // 5. Oltre 14 giornate: nessun taglio, bloccante e visibile.
  const extraDays = Array.from({ length: 14 }, (_, n) => ({ op: 'add', decisionId: `x${n}`, localId: `x${n}`, collection: 'days', parentLocalId: 'i0', index: n + 1, values: { name: `Giorno extra ${n + 1}`, dayType: 'any', notes: [] }, reason: 'user_edit' }))
  const extraMeals = extraDays.map((day, n) => ({ op: 'add', decisionId: `y${n}`, localId: `y${n}`, collection: 'meals', parentLocalId: day.localId, index: 0, values: { name: 'Pasto', timeText: null, alternatives: ['Opzione unica: come da documento.'], additions: [], notes: [] }, reason: 'user_edit' }))
  await mount({ document: spec.document, extraction: spec.extraction, decisions: [...extraDays, ...extraMeals] })
  const tooMany = await tab.evaluate('harness.outcome()')
  assert.equal(tooMany.ok, false)
  assert.ok(tooMany.findings.includes('too_many_items'))
  assert.equal((await tab.evaluate('harness.state()')).current.filter(item => item.collection === 'days').length, 15, 'nessuna giornata tagliata')
  assert.ok(await tab.evaluate(`${text('#rv-summary')}.includes('15 giornate (massimo 14)')`))
  pass('oltre 14 giornate: tutte conservate, limite visibile e problema bloccante')

  // 6. Rianalisi: confronto senza sovrascrivere gli edit.
  const changed = structuredClone(alt.extraction)
  changed.days[0].meals[0].foods[1].quantityText = '1 intera'
  await mount({ document: alt.document, extraction: alt.extraction, decisions: alt.entry.userDecisions, reanalysis: changed })
  assert.ok(await tab.evaluate(`${text('.rv-reanalysis')}.includes('Alimento «banana»') && ${text('.rv-reanalysis')}.includes('quantityText')`))
  const kept = (await tab.evaluate('harness.state()')).decisions.length
  await pressText(tab, 'Continua con la revisione attuale')
  await pressText(tab, 'Usa la nuova analisi')
  assert.deepEqual([await tab.evaluate('log.dismissed'), await tab.evaluate('log.adopted')], [1, 1])
  assert.equal((await tab.evaluate('harness.state()')).decisions.length, kept)
  pass('rianalisi: differenze per elemento e campo, scelta al chiamante, edit intatti')

  // 7. Viewport e tastiera.
  await mount({ document: alt.document, extraction: alt.extraction, decisions: alt.entry.userDecisions })
  await mkdir(shots, { recursive: true })
  for (const width of [320, 390, 768, 1440]) {
    await tab.viewport(width, 900, width < 720)
    await tab.until(noOverflow, `nessun overflow a ${width}px`)
    await tab.evaluate(`document.querySelector('[data-local-id=i2]').scrollIntoView()`)
    await tab.screenshot(join(shots, `diet-review-${width}.png`))
  }
  await tab.viewport(390, 844, true)
  await mount({ document: alt.document, extraction: alt.extraction })
  await tab.evaluate(`document.querySelector('#rv-i1-dayType-group button').focus()`)
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: String.fromCharCode(13) })
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await tab.until(`document.querySelector('#rv-i1-dayType-group button[aria-pressed=true]')?.textContent === 'Allenamento'`, 'scelta da tastiera')
  await mount({ document: alt.document, extraction: alt.extraction })
  await press(tab, buttonByText('Vai al punto', '[data-list=open]'), 'vai al tipo di giornata')
  await tab.until(`document.activeElement?.id === 'rv-i1-dayType-group'`, 'focus sul gruppo del tipo di giornata')
  pass('viewport 320/390/768/1440 senza overflow; scelte da tastiera; «Vai al punto» porta il focus al campo')

  assert.deepEqual(await tab.evaluate('log.network'), [], 'nessuna chiamata di rete')
  assert.ok(tab.requests.every(url => url.startsWith(server.origin) || url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank'), tab.requests.join('\n'))
  assert.deepEqual(tab.errors, [])
  pass('nessuna richiesta fuori dal server dei componenti, nessun errore in console')
}

try {
  started.push(await ensureChrome())
  console.log('import-diet-review-browser-check')
  await run()
  await mkdir(shots, { recursive: true })
  await writeFile(join(shots, 'report.json'), JSON.stringify({ status: 'passed', mode: 'harness isolato dei componenti, moduli reali 06/07/10, nessuna rete', checks, date: new Date().toISOString() }, null, 2))
  console.log(`import-diet-review-browser-check: PASS (${checks.length} controlli)`)
} catch (error) {
  for (const tab of tabs) console.error('DIAG', JSON.stringify({ text: await tab.evaluate(`document.querySelector('main')?.innerText.slice(0, 2500) ?? ''`).catch(() => ''), errors: tab.errors }))
  throw error
} finally {
  for (const tab of tabs) await tab.close()
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {})
  for (const process of started.reverse()) await process.stop()
}
