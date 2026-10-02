// App/reader/IndexedDB/SDK reali; API e diario simulati. Zero chiamate a provider.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixtureSession, fixtureStorageKey, installAuthFixture } from './lib/browser-auth-fixture.mjs'
import { baseUrl, ensureChrome, ensurePreview, openTab, pause, root } from './lib/import-browser-harness.mjs'
import { structuredDocx, syntheticExamples } from './generate-structured-templates.mjs'
const out = join(root, 'artifacts/import-structured')
await mkdir(out, { recursive: true })
const checks = [], pass = message => { checks.push(message); console.log(`PASS ${message}`) }
let chrome, preview, tab
const recordsExpression = `new Promise((resolve,reject)=>{const r=indexedDB.open('peppitness-structured-import-v1');r.onsuccess=()=>{const db=r.result;const q=db.transaction('drafts').objectStore('drafts').getAll();q.onsuccess=()=>{db.close();resolve(q.result)};q.onerror=()=>reject(q.error)}})`
async function button(label) { await tab.until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled)`); await tab.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`); await pause(100) }
async function choose(kind, file) {
  await tab.evaluate(`location.hash=${JSON.stringify(kind === 'workout' ? '#/scheda/importa' : '#/dieta/importa')}`)
  await tab.until(`Boolean(document.querySelector('.si-file input[type=file]:not(:disabled)'))`)
  await tab.setFiles('.si-file input[type=file]', [file])
  await tab.until(`Boolean(document.querySelector('[data-structured=${kind}]'))`)
  await pause(200)
}
async function type(label, value) {
  const selector = `textarea[aria-label=${JSON.stringify(label)}]`
  await tab.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select() })()`)
  await tab.send('Input.insertText', { text: value }); await pause(200)
}
try {
  preview = await ensurePreview(); chrome = await ensureChrome(); tab = await openTab()
  const mock = await installAuthFixture(tab.send, tab.socketProxy, baseUrl, {})
  await tab.navigate(baseUrl); await tab.evaluate(`localStorage.setItem(${JSON.stringify(fixtureStorageKey)},${JSON.stringify(JSON.stringify(fixtureSession('a')))});location.hash='#/scheda/importa';location.reload()`)
  await tab.until(`Boolean(document.querySelector('.si-template'))`)
  for (const kind of ['workout', 'diet']) {
    const file = join(root, `public/templates/peppitness-${kind}-v1.docx`)
    const before = mock.importFlow?.commits.length ?? 0
    await choose(kind, file)
    assert.equal((mock.importFlow?.commits.length ?? 0), before)
    assert.equal(mock.exerciseWrites.length, 0)
    assert.equal(mock.importFlow?.analyses.length ?? 0, 0)
    assert.equal(await tab.evaluate(`document.querySelectorAll('.si-preview [role=alert],.si-preview > label select').length`), 0)
    const rows = await tab.evaluate(recordsExpression)
    const record = rows.find(r => r.kind === kind)
    assert.equal(record.draft.tables.find(t => t.section === (kind === 'workout' ? 'Allenamento' : 'Alimenti')).rows.length, kind === 'workout' ? 3 : 5)
    assert.equal(record.command, null)
    pass(`${kind}: tutte le righe, zero LLM, zero scritture e zero conferme per campo`)
    await tab.send('Page.reload'); await tab.until(`Boolean(document.querySelector('[data-structured=${kind}]'))`)
    assert.match(await tab.evaluate(`document.querySelector('.si-file').textContent`), /Bozza recuperata/)
    await tab.viewport(390, 844, true)
    assert.ok(await tab.evaluate('document.documentElement.scrollWidth<=innerWidth'))
    await tab.screenshot(join(out, `${kind}-mobile.png`))
    await tab.viewport(1440, 1000)
    await type('Titolo', `Esempio browser ${kind}`)
    await tab.until(`!document.querySelector('.si-confirm').disabled`)
    await tab.click('.si-follow input')
    await button('Continua al salvataggio')
    assert.ok(await tab.evaluate(`Boolean(document.querySelector('.si-save'))`))
    if (kind === 'diet') mock.importFlow.loseCommit = true
    await tab.evaluate(`document.querySelector('.si-save').click();document.querySelector('.si-save')?.click()`)
    await tab.until(`Boolean(document.querySelector(${JSON.stringify(kind === 'diet' ? '.si-pending' : '.si-saved')}))`)
    if (kind === 'diet') {
      await tab.until(`!document.querySelector('.si-pending button').disabled`)
      await tab.send('Page.reload'); await tab.until(`Boolean(document.querySelector('.si-saved'))`)
    }
    assert.equal(mock.importFlow.commits.length, before + 1)
    assert.equal(mock.importFlow.commits.at(-1).command.provenance.analysis.jobId, null)
    assert.equal(mock.importFlow.jobs.size, 0)
    pass(`${kind}: bozza dopo reload, edit, unica conferma, doppio clic e commit${kind === 'diet' ? ', risposta persa recuperata dopo reload' : ''}`)
    await tab.evaluate(`location.hash=${JSON.stringify(kind === 'workout' ? '#/scheda' : '#/dieta')}`)
    await tab.until(`document.body.textContent.includes(${JSON.stringify(`Esempio browser ${kind}`)})`)
    if (kind === 'workout') {
      await tab.until(`document.body.textContent.includes('Squat esempio')`)
      assert.equal(mock.exercises.size, 2)
      const prescription = mock.programTables.workout_prescriptions[0]
      assert.equal(prescription.sets, 2); assert.equal(prescription.optional_sets, 0)
    } else {
      const meal = mock.diary.meal_plans[0].document.days[0].meals[0]
      assert.equal(meal.foods.length, 2); assert.equal(meal.alternatives.length, 1)
      assert.match(meal.note, /Bianco/)
    }
    pass(`${kind}: piano seguito visibile nel diario, quantità/dosi/note/opzioni conservate`)
  }
  const invalid = structuredClone(syntheticExamples.workout)
  invalid.sections.Allenamento[0][2] = '2-3'; invalid.sections.Allenamento[1][3] = '8'
  const file = join(out, 'invalid.docx'); await writeFile(file, structuredDocx('workout', invalid))
  await choose('workout', file)
  assert.ok(await tab.evaluate(`document.querySelectorAll('.si-preview [aria-invalid=true]').length>=2`))
  assert.ok(await tab.evaluate(`document.querySelector('.si-confirm').disabled`))
  await type('Allenamento riga 2, Serie', '2'); await type('Allenamento riga 3, Ripetizioni', '')
  await tab.until(`!document.querySelector('.si-confirm').disabled`)
  pass('righe invalide e dosi contraddittorie: errori inline, correzione mirata, nessuna conferma aggiuntiva')
  const other = await openTab()
  try {
    await installAuthFixture(other.send, other.socketProxy, baseUrl, mock)
    await other.navigate(`${baseUrl}/#/scheda/importa`, `Boolean(document.querySelector('[data-structured=workout]'))`)
    await type('Titolo', 'Titolo dalla prima scheda')
    await other.evaluate(`(() => {const e=document.querySelector('textarea[aria-label=Titolo]'); e.focus(); e.select()})()`)
    await other.send('Input.insertText', { text: 'Edit concorrente respinto' })
    await other.until(`document.querySelector('.si-file [role=alert]')?.textContent.includes('altra scheda')`)
    assert.equal((await tab.evaluate(recordsExpression)).find(r=>r.kind==='workout').draft.title.text,'Titolo dalla prima scheda')
    await other.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Ricarica la bozza').click()`)
    await other.until(`document.querySelector('textarea[aria-label=Titolo]')?.value==='Titolo dalla prima scheda'`)
    pass('IndexedDB reale: due schede, conflitto respinto senza sovrascrivere e ricarica della bozza')
  } finally { await other.close() }
  const independent = { title: 'Circuito sintetico indipendente 18', sections: { Allenamento: [], Istruzioni: Array.from({length:9},(_,i)=>[`Istruzione sintetica ${i+1}: aumenti soltanto dopo verifica.`]) } }
  for (const session of ['A','B','C']) for (let i=0;i<6;i++) independent.sections.Allenamento.push([session,`Esercizio sintetico ${i+1}`,'2','8-10','','75',i===0?'Terza facoltativa da S5.':'Nota sintetica.'])
  const eighteen = join(out,'independent-18.docx'); await writeFile(eighteen,structuredDocx('workout',independent))
  await choose('workout',eighteen)
  await tab.until(`!document.querySelector('.si-confirm').disabled`)
  assert.match(await tab.evaluate(`document.querySelector('.si-preview').textContent`),/3 sedute · 18 esercizi/)
  assert.equal(await tab.evaluate(`document.querySelectorAll('.si-preview [role=alert]').length`),0)
  assert.match(await tab.evaluate(`document.querySelector('.si-catalog h3').textContent`),/\(6\)/)
  await button('Continua al salvataggio'); await button('Conferma e salva'); await tab.until(`Boolean(document.querySelector('.si-saved'))`)
  const complete = mock.importFlow.commits.at(-1).command.payload.resolved
  assert.equal(complete.days.flatMap(d=>d.prescriptions).length,18)
  assert.equal(complete.guidance.split('\n').length,9)
  pass('caso indipendente 3 sedute/18 esercizi/9 istruzioni: zero problemi, sei identità nuove deduplicate, conferma finale unica e import completo')
  assert.equal(mock.failures.length, 0, mock.failures.join('\n'))
  assert.ok(!mock.requests.some(r => r.includes('extract-plan')))
  assert.deepEqual(tab.errors.filter(e => !e.includes('ERR_CONNECTION_CLOSED')), [])
  await writeFile(join(out, 'browser-report.json'), JSON.stringify({ result: 'PASS', mode: 'browser-api-simulated', checks, providerRequests: 0, personal: false }, null, 2))
} finally { await tab?.close(); await chrome?.stop(); await preview?.stop() }
