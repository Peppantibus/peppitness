// Prova browser del task 22: percorso completo nell'app reale (build di produzione in preview), con reader reale
// nel worker e API simulate via CDP (auth, piani, diario e import: scripts/lib/import-flow-fixture.mjs, provider
// simulato). Scheda e dieta: file → lettura → analisi esplicita (risposta persa recuperata per chiave) → revisione con
// edit reali → anteprima → conferma con una sola RPC → esito; nessuna scrittura prima della conferma; ricarica con
// bozza e prenotazioni conservate; follow spento per default e acceso solo per scelta; risposta del salvataggio
// persa riconciliata con la ricevuta; conflitto di selezione e copia esplicita; dominio sbagliato; offline; cambio account.
// Non è una prova SQL/RLS né dell'Edge reale: quelle sono i test 19/20/21 e l'E2E del 24.
//
// Comando (PowerShell, dalla radice, dopo `npm.cmd run build`):
//   node scripts/import-flow-browser-check.mjs
// Autonomo: riusa (o avvia) la preview su 127.0.0.1:4173 e il Chrome di test su 127.0.0.1:9223 con profilo
// temporaneo, e chiude solo ciò che ha avviato. File sintetici generati in artifacts/import-flow/.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readDocx } from '../src/import/readers/docx.ts'
import { fixtureSession, fixtureStorageKey, installAuthFixture } from './lib/browser-auth-fixture.mjs'
import { buildDocx, para, tbl, tc, tr } from './lib/docx-fixtures.mjs'
import { baseUrl, ensureChrome, ensurePreview, journalRecordsExpression, openTab, pause, root } from './lib/import-browser-harness.mjs'
import { remapExtraction } from './lib/import-flow-fixture.mjs'

const fixtures = join(root, 'tests', 'fixtures', 'import')
const readJson = async path => JSON.parse(await readFile(join(fixtures, path), 'utf8'))
const out = join(root, 'artifacts', 'import-flow')
const checks = []
const pass = label => { checks.push(label); console.log(`  ✓ ${label}`) }
const started = []
let tab = null

// --- File sintetici e proposte del provider simulato -------------------------------------------------
const files = {
  workout: buildDocx({ body: [para('Scheda esempio', { style: 'Titolo1' }), para('Seduta A', { style: 'Titolo2' }), tbl(3, [tr([tc('Squat'), tc('3 x 8-10'), tc('recupero non indicato')])])].join('') }),
  diet: buildDocx({ body: [para('Menu esempio', { style: 'Titolo1' }), para('Giorno di allenamento', { style: 'Titolo2' }), para('Colazione: yogurt bianco 170 g. In alternativa allo yogurt: latte 200 ml.')].join('') }),
}
const documents = {}
for (const kind of ['workout', 'diet']) documents[kind] = (await readDocx({ bytes: files[kind], metadata: { format: 'docx', mediaType: null }, signal: new AbortController().signal })).document
const proposals = {
  workout: remapExtraction(await readJson('extractions/workout-spec-example.json'), await readJson('documents/workout-spec-example.json'), documents.workout),
  diet: remapExtraction(await readJson('extractions/diet-spec-example.json'), await readJson('documents/diet-spec-example.json'), documents.diet),
}
// Dato mancante nella dieta: la quantità dell'alimento non viene estratta e va completata in revisione.
proposals.diet.days[0].meals[0].foods[0].quantityText = null
proposals.diet.evidence = proposals.diet.evidence.filter(entry => !entry.path.endsWith('/quantityText'))
const wrongDomain = await readJson('extractions/workout-wrong-domain.json')

const owner = fixtureSession('a').user.id
const SQUAT = '31000000-0000-4000-8000-000000000001'

// --- Interazioni -------------------------------------------------------------------------------------
const text = selector => `(document.querySelector(${JSON.stringify(selector)})?.textContent ?? '')`
const buttonByText = (label, scope = '') => `[...document.querySelectorAll(${JSON.stringify(`${scope} button`.trim())})].find(element => element.textContent.trim() === ${JSON.stringify(label)})`
async function press(finder, what) {
  const point = await tab.evaluate(`(() => { const element = (${finder}); if (!element) return null; element.scrollIntoView({ block: 'center' }); const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, disabled: Boolean(element.disabled) } })()`)
  if (!point) throw new Error(`Elemento assente: ${what}`)
  if (point.disabled) throw new Error(`Elemento disattivato: ${what}`)
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: point.x, y: point.y })
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: point.x, y: point.y })
  await pause(100)
}
const pressText = (label, scope) => press(buttonByText(label, scope), label)
async function type(selector, value) {
  await tab.evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) throw new Error('Campo assente: ${selector}'); element.scrollIntoView({ block: 'center' }); element.focus(); element.select?.() })()`)
  await tab.send('Input.insertText', { text: value })
  await tab.evaluate('document.activeElement.blur()')
  await pause(120)
}
const settleRequests = async () => { for (let count = -1; count !== tab.requests.length;) { count = tab.requests.length; await pause(500) } }
/** Scritture di piani, catalogo, selezione o ricevute: devono comparire solo dopo «Salva». */
const writes = mock => mock.requests.filter(line => /^(POST|PATCH|DELETE) \/rest\/v1\/(rpc\/(commit_|save_|publish_|adopt_|activate_|delete_)|workout_|meal_plans|active_plans|exercises)/.test(line))
const records = () => tab.evaluate(journalRecordsExpression)
const noOverflow = 'document.documentElement.scrollWidth <= window.innerWidth'

/** Sceglie un file nel percorso del dominio e attende la lettura di QUEL file (non della sessione precedente). */
async function choose(kind, file = `${kind === 'workout' ? 'scheda' : 'dieta'}-sintetica.docx`) {
  const route = kind === 'workout' ? '#/scheda/importa' : '#/dieta/importa'
  await tab.evaluate(`location.hash = ${JSON.stringify(route)}`)
  await tab.until(`Boolean(document.querySelector('.import-drop input[type=file]')) || Boolean(document.querySelector('.import-change input[type=file]'))`, `pagina ${kind}`)
  const previous = await tab.evaluate(`document.querySelector('.import-file-card')?.dataset.session ?? null`)
  const selector = await tab.evaluate(`document.querySelector('.import-drop input[type=file]') ? '.import-drop input[type=file]' : '.import-change input[type=file]'`)
  await tab.setFiles(selector, [join(out, file)])
  await tab.until(`document.querySelector('.import-file-card')?.dataset.session !== ${JSON.stringify(previous)} && ${text('.import-file-name')} === ${JSON.stringify(file)}
    && ${text('.import-summary h2')} === 'Documento letto'`, `lettura ${file}`)
  await pause(400) // layout della fonte assestato prima dei clic successivi
}
/** Revisione della scheda con gli stessi passi di un utente: calendario, recupero, serie facoltative, catalogo. */
async function resolveWorkout() {
  await tab.until(`Boolean(document.querySelector('[data-review=workout] .wr-exercise'))`, 'revisione scheda')
  const id = await tab.evaluate(`document.querySelector('.wr-exercise').dataset.localId`)
  await pressText('A rotazione')
  await press(`document.getElementById('rv-item-${id}')`, 'riga esercizio')
  await tab.until(`Boolean(document.getElementById('rv-${id}-restSeconds'))`)
  await type(`#rv-${id}-restSeconds`, '90')
  await pressText('Nessuna serie facoltativa', `#rv-detail-${id}`)
  await press(`document.getElementById('rv-${id}-catalog-pick')`, 'picker del catalogo')
  await tab.until(`Boolean(document.querySelector('dialog[open] [data-candidate="${SQUAT}"] button'))`, 'Squat personale fra i candidati')
  await press(`document.querySelector('dialog[open] [data-candidate="${SQUAT}"] button')`, 'scegli Squat')
  await tab.until(`!document.querySelector('dialog[open]')`)
  await tab.until(`Boolean(document.querySelector('[data-preview=workout]'))`, 'anteprima della scheda')
}
const previewIds = () => tab.evaluate(`[...document.querySelectorAll('[data-preview=workout] [data-prescription]')].map(element => element.dataset.prescription)`)

async function run() {
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'scheda-sintetica.docx'), files.workout)
  await writeFile(join(out, 'dieta-sintetica.docx'), files.diet)
  started.push(await ensureChrome(), await ensurePreview())
  tab = await openTab()
  await tab.send('Network.setCacheDisabled', { cacheDisabled: true })
  await tab.send('Storage.clearDataForOrigin', { origin: new URL(baseUrl).origin, storageTypes: 'local_storage,indexeddb' })
  const mock = await installAuthFixture(tab.send, tab.socketProxy, baseUrl)
  mock.exercises.set(`${owner}:${SQUAT}`, { id: SQUAT, owner_id: owner, name: 'Squat', variant: '', equipment: 'bilanciere', load_convention: 'total', load_unit: 'kg', measurement_mode: 'reps', per_side: false, note: '', revision: 1, archived_at: null, source_template_id: null })
  mock.importFlow = {
    jobs: new Map(), receipts: new Map(), analyses: [], commits: [],
    // Provider simulato: proposta del corpus sui blocchi letti davvero; un piano alimentare nel percorso scheda è «dominio sbagliato».
    extractionFor: (kind, document) => kind === 'workout' && document.blocks.some(block => block.text === 'Menu esempio') ? structuredClone(wrongDomain) : structuredClone(proposals[kind]),
  }
  await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] })
  await tab.viewport(390, 844, true)
  await tab.navigate(baseUrl, 'document.readyState === "complete"')
  await tab.evaluate(`localStorage.setItem(${JSON.stringify(fixtureStorageKey)}, ${JSON.stringify(JSON.stringify(fixtureSession('a')))}); location.hash = '#/scheda'`)
  await tab.send('Page.reload')
  await tab.until(`Boolean(document.querySelector('.plan-empty a[href="#/scheda/importa"]'))`, 'Scheda vuota')

  // 1. Scheda: file letto senza rete dell'import; analisi solo al clic, risposta persa recuperata per chiave.
  await choose('workout')
  await settleRequests()
  assert.equal(mock.importFlow.analyses.length, 0, 'nessuna analisi alla sola selezione')
  assert.ok(!mock.requests.some(line => /import_|extract-plan/.test(line)), 'nessuna richiesta d’importazione prima del clic')
  assert.match(await tab.evaluate(text('.import-disclosure')), /OpenAI/)
  assert.doesNotMatch(await tab.evaluate(text('.import-summary')), /si ferma alla lettura/, 'azione intermedia dell’11 rimossa')
  mock.importFlow.loseAnalysis = true
  await press(`document.querySelector('.import-analyze')`, 'Analizza')
  await resolveWorkout()
  assert.deepEqual([mock.importFlow.analyses.length, mock.importFlow.providerCalls], [1, 1], 'risposta persa: job ritrovato senza seconda analisi')
  pass('scheda: nessuna chiamata alla selezione, avviso su contenuti e provider, analisi esplicita, risposta persa recuperata per chiave')

  // 2. Revisione con edit reali e anteprima; nessuna scrittura; ricarica con bozza e prenotazioni intatte.
  const ids = await previewIds()
  assert.equal(ids.length, 1)
  assert.equal(writes(mock).length, 0, 'nessuna scrittura prima della conferma')
  await tab.send('Page.reload')
  await tab.until(`Boolean(document.querySelector('[data-preview=workout]'))`, 'revisione ripresa dopo la ricarica')
  assert.deepEqual(await previewIds(), ids, 'stessi ID prenotati dopo la ricarica')
  assert.deepEqual((await records()).map(record => [record.ownerId, record.kind, record.bytes]), [[owner, 'workout', false]])
  assert.ok(mock.importFlow.renewed?.length >= 1, 'revisione ripresa: analisi rinnovata sul server (23)')
  pass('revisione: edit tracciati, anteprima dal mapping, zero scritture, ricarica con decisioni e ID prenotati conservati')

  // 3. Conferma: segui spento per default (anche senza piani), una sola RPC, comando = anteprima, esito e rilettura.
  await pressText('Continua alla conferma')
  await tab.until(`Boolean(document.querySelector('[data-confirmation=workout]'))`)
  assert.equal(await tab.evaluate(`document.querySelector('.import-follow input').checked`), false, 'Inizia a seguirlo spento per default')
  assert.ok(await tab.evaluate(noOverflow), 'conferma senza scorrimento orizzontale a 390 px')
  assert.deepEqual(await previewIds(), ids, 'anteprima esatta nella conferma')
  await press(`document.querySelector('.import-save')`, 'Salva il programma')
  await tab.until(`Boolean(document.querySelector('.import-saved[data-result=committed]'))`, 'programma salvato')
  const [first] = mock.importFlow.commits
  assert.equal(mock.importFlow.commits.length, 1)
  assert.deepEqual(first.command.payload.resolved.days.flatMap(day => day.prescriptions.map(item => item.id)), ids, 'comando = anteprima')
  assert.deepEqual(first.command.selectionOptions, { follow: false, expectedActiveRevision: null })
  assert.deepEqual(first.command.payload.resolved.catalog.map(binding => binding.choice.source), ['existing'])
  assert.equal(await tab.evaluate(`document.querySelector('.import-saved').dataset.followed`), 'false')
  assert.ok(!mock.requests.some(line => /save_workout|publish_workout|active_plans/.test(line) && /^(POST|PATCH|DELETE) /.test(line)), 'nessun save/publish/choose manuale')
  await tab.evaluate(`location.hash = '#/scheda'`)
  await tab.until(`[...document.querySelectorAll('.plan-choices button')].some(button => button.textContent === 'Scheda esempio')`, 'programma importato fra quelli da seguire')
  pass('conferma: segui spento per default, una RPC con il comando dell’anteprima, programma creato e riletto, non seguito')

  // 4. Stesso file di nuovo: l'import concluso e lasciato non ha più contenuti sul server (23), quindi nuova analisi;
  //    duplicato, conflitto di selezione, copia seguita.
  const firstJob = first.command.provenance.analysis.jobId
  await choose('workout')
  assert.equal(mock.importFlow.jobs.get(firstJob).status, 'expired', 'contenuti dell’import lasciato scartati sul server')
  await press(`document.querySelector('.import-analyze')`, 'Analizza')
  await resolveWorkout()
  assert.equal(mock.importFlow.providerCalls, 2, 'nessuna analisi compatibile rimasta: nuova analisi esplicita')
  await pressText('Continua alla conferma')
  await tab.until(`Boolean(document.querySelector('[data-confirmation=workout]'))`)
  await press(`document.querySelector('.import-follow input')`, 'Inizia a seguirlo')
  await press(`document.querySelector('.import-save')`, 'Salva')
  await tab.until(`Boolean(document.querySelector('.import-duplicate'))`, 'duplicato proposto')
  assert.equal(mock.importFlow.commits.length, 1, 'duplicato: nessun invio')
  // Un altro dispositivo cambia la selezione dopo la lettura: il follow deve fallire senza scrivere.
  mock.diary ??= { active_plans: [], meal_plans: [], workout_sessions: [], workout_set_logs: [], meal_logs: [], diary_days: [] }
  mock.diary.active_plans.push({ owner_id: owner, workout_plan_id: null, meal_plan_id: null, revision: 3 })
  await press(`document.querySelector('.import-copy')`, 'Crea comunque una copia')
  await tab.until(`${text('[data-confirmation=workout]')}.includes('Il piano seguito è cambiato')`, 'conflitto di selezione visibile')
  assert.equal(mock.importFlow.receipts.size, 1, 'conflitto: nulla salvato')
  await pause(600) // selezione riletta dall'app
  await press(`document.querySelector('.import-save')`, 'di nuovo Salva, copia già scelta')
  await tab.until(`document.querySelector('.import-saved')?.dataset.followed === 'true'`, 'copia salvata e seguita')
  const [, rejected, copied] = mock.importFlow.commits
  assert.notEqual(rejected.command.requestId, copied.command.requestId, 'nuova chiave solo dopo il rifiuto certo')
  assert.deepEqual(copied.command.selectionOptions, { follow: true, expectedActiveRevision: 3 })
  await tab.evaluate(`location.hash = '#/scheda'`)
  await tab.until(`${text('main')}.includes('Squat')`, 'Scheda con il programma importato seguito')
  pass('import lasciato scartato sul server, duplicato con copia esplicita, PT409 di selezione visibile, nuova chiave e follow atomico')

  // 5. Dieta: analisi già pronta della stessa fonte riaperta senza costi, dato mancante completato, offline blocca
  //    l'invio, risposta persa riconciliata con la ricevuta.
  const readyDiet = crypto.randomUUID()
  mock.importFlow.jobs.set(readyDiet, { owner, document: structuredClone(documents.diet), jobId: readyDiet, analysisRequestId: crypto.randomUUID(), kind: 'diet', status: 'ready',
    extraction: structuredClone(proposals.diet), validationIssues: [], usageSummary: { providerCalls: 1, inputTokens: 1, outputTokens: 1, reasoningTokens: null, cached: false, costEstimate: null },
    error: null, expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
  const calls = mock.importFlow.providerCalls
  await choose('diet')
  await press(`document.querySelector('.import-analyze')`, 'Analizza la dieta')
  await tab.until(`Boolean(document.querySelector('.import-reopen'))`, 'analisi compatibile proposta')
  assert.match(await tab.evaluate(text('.import-compatible')), /senza costi/)
  await press(`document.querySelector('.import-reopen')`, 'Riapri l’analisi pronta')
  await tab.until(`Boolean(document.querySelector('[data-review=diet] .dr-food'))`, 'revisione dieta')
  assert.ok(await tab.evaluate(noOverflow), 'revisione senza scorrimento orizzontale a 390 px')
  assert.equal(mock.importFlow.providerCalls, calls, 'riapertura senza nuova analisi')
  assert.equal(await tab.evaluate(`document.querySelectorAll('[data-preview=diet]').length`), 0, 'quantità mancante: nessuna anteprima')
  const food = await tab.evaluate(`document.querySelector('.dr-food').dataset.localId`)
  await type(`#rv-${food}-quantityText`, '170 g')
  await tab.until(`Boolean(document.querySelector('[data-preview=diet]'))`, 'anteprima della dieta')
  await pressText('Continua alla conferma')
  await tab.until(`Boolean(document.querySelector('[data-confirmation=diet]'))`)
  await tab.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await tab.until(`document.querySelector('.import-save').disabled`, 'offline: salvataggio bloccato')
  await tab.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await tab.until(`!document.querySelector('.import-save').disabled`, 'di nuovo online')
  await press(`document.querySelector('.import-follow input')`, 'segui la dieta')
  const before = mock.importFlow.commits.length
  mock.importFlow.loseCommit = true
  await press(`document.querySelector('.import-save')`, 'Salva il piano')
  await tab.until(`document.querySelector('.import-saved')?.dataset.followed === 'true'`, 'dieta salvata dopo la ricevuta')
  assert.ok(await tab.evaluate(noOverflow), 'esito senza scorrimento orizzontale a 390 px')
  await tab.screenshot(join(out, 'dieta-salvata-390.png'))
  assert.equal(mock.importFlow.commits.length - before, 1, 'una sola RPC nonostante la risposta persa')
  const saved = mock.importFlow.commits.at(-1).command.payload.resolved.plan
  assert.equal(saved.document.days[0].meals[0].foods[0].quantity, '170 g', 'valore completato nel comando')
  await tab.evaluate(`location.hash = '#/dieta'`)
  await tab.until(`${text('main')}.includes('Colazione')`, 'Dieta con il piano importato')
  pass('dieta: analisi pronta riaperta senza costi, mancante completato, offline senza invii, risposta persa riconciliata, piano seguito solo per scelta')

  // 6. Dominio sbagliato: proposta senza contenuto, passaggio all'altro percorso senza analisi automatica.
  const analyses = mock.importFlow.analyses.length
  await choose('workout', 'dieta-sintetica.docx')
  await press(`document.querySelector('.import-analyze')`, 'Analizza come scheda')
  await tab.until(`document.querySelector('.import-outcome')?.dataset.outcome === 'wrong_document_type'`, 'dominio sbagliato')
  await press(`document.querySelector('.import-switch')`, 'Importa come piano alimentare')
  await tab.until(`location.hash === '#/dieta/importa' && ${text('.import-summary h2')} === 'Documento letto'`, 'documento passato alla dieta')
  assert.equal(mock.importFlow.analyses.length, analyses + 1, 'nessuna analisi automatica nel nuovo percorso')
  // Le importazioni concluse e poi sostituite lasciano il server senza contenuti (scarto esplicito, 23).
  assert.ok(mock.importFlow.discarded?.length >= 1 && mock.importFlow.discarded.every(id => mock.importFlow.jobs.get(id)?.status === 'expired'), 'contenuti scartati sul server')
  pass('dominio sbagliato: nulla salvabile, cambio di percorso con lo stesso testo letto e nuova analisi solo esplicita')

  // 7. Cambio account: nessun dato di A resta o compare per B.
  await tab.evaluate(`localStorage.setItem(${JSON.stringify(fixtureStorageKey)}, ${JSON.stringify(JSON.stringify(fixtureSession('b')))}); location.hash = '#/scheda/importa'`)
  await tab.send('Page.reload')
  await tab.until(`Boolean(document.querySelector('.import-drop input[type=file]'))`, 'B senza importazioni')
  await settleRequests()
  assert.ok((await records()).every(record => record.ownerId !== owner), 'journal di A rimosso al cambio account')
  assert.deepEqual(mock.failures, [])
  assert.deepEqual(tab.errors.filter(error => !/Failed to load resource|net::ERR/.test(error)), [])
  pass('cambio account: journal e stato di A non visibili a B; nessun errore o richiesta inattesa')
}

try {
  await run()
  console.log(`import-flow-browser-check: PASS (${checks.length} controlli)`)
} catch (error) {
  if (tab) await tab.screenshot(join(out, 'failure.png')).catch(() => {})
  console.error(`import-flow-browser-check: FAIL — ${error?.stack ?? error}`)
  process.exitCode = 1
} finally {
  await tab?.close()
  for (const service of started.reverse()) await service.stop()
}
