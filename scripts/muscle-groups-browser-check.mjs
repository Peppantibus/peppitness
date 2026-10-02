// App reale, API simulate: nessuna chiamata cloud/provider e solo dati inventati.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fixtureSession, fixtureStorageKey, installAuthFixture } from './lib/browser-auth-fixture.mjs'
import { baseUrl, ensureChrome, ensurePreview, openTab, pause, root } from './lib/import-browser-harness.mjs'
import { join } from 'node:path'
const out = join(root, 'artifacts/muscle-groups-browser'), checks = []
const pass = text => { checks.push(text); console.log(`PASS ${text}`) }
let chrome, preview, tab
async function input(selector, value) {
  await tab.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)throw new Error('Campo assente');Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event(el.tagName==='SELECT'?'change':'input',{bubbles:true})); })()`)
  await pause(80)
}
const click = selector => tab.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
async function route(path, ready) { await tab.evaluate(`location.hash=${JSON.stringify(path)}`); await tab.until(ready) }
async function widths(label) {
  for(const width of [320,390,768,1440]) {
    await tab.viewport(width, 844, width < 768)
    assert.equal(await tab.evaluate('document.documentElement.scrollWidth > innerWidth'),false,`${label} overflow ${width}`)
  }
  await tab.viewport(390,844,true)
}
try {
  await mkdir(out,{recursive:true}); preview=await ensurePreview(); chrome=await ensureChrome(); tab=await openTab()
  const owner = fixtureSession().user.id
  const raw = (id,name,group) => ({ id,owner_id:owner,name,variant:'',equipment:'',load_convention:'total',load_unit:'kg',measurement_mode:'reps',per_side:false,note:'',archived_at:null,revision:1,muscle_group:group })
  const chest='15111111-1111-4111-8111-111111111111', back='15222222-2222-4222-8222-222222222222', missing='15333333-3333-4333-8333-333333333333'
  const sharedRows = [raw(chest,'Chest press','Petto'),raw(back,'Lat machine','Schiena'),raw(missing,'Movimento sintetico',null)]
  const mock = await installAuthFixture(tab.send,tab.socketProxy,baseUrl,{ sharedExercises:new Map(sharedRows.map(row=>[row.id,row])) })
  await tab.navigate(baseUrl); await tab.evaluate(`localStorage.clear();localStorage.setItem(${JSON.stringify(fixtureStorageKey)},${JSON.stringify(JSON.stringify(fixtureSession()))});location.hash='#/scheda/catalogo';location.reload()`)
  await tab.until(`document.querySelectorAll('.catalog-card').length===3`)
  assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('.catalog-group-title')].map(e=>e.firstChild.textContent)`),['Petto','Schiena','Da classificare'])
  await input('#exercise-group-filter','Petto'); await tab.until(`document.querySelectorAll('.catalog-card').length===1`)
  assert.equal(await tab.evaluate(`document.querySelector('.catalog-card h3').textContent`),'Chest press')
  await widths('catalogo filtrato'); await tab.screenshot(join(out,'catalogo-petto.png'))
  pass('catalogo comune raggruppato e filtrabile, categoria sempre esplicita')
  await click('.catalog-card .button'); await tab.until(`document.querySelector('.catalog-card').textContent.includes('Nei tuoi esercizi')`)
  const adopted = [...mock.exercises.values()][0]; assert.equal(adopted.muscle_group,'Petto'); assert.equal(adopted.source_template_id,chest)
  await click('.catalog-scope button[aria-pressed="false"]'); await tab.until(`Boolean(document.querySelector('.catalog-edit'))`)
  await click('.catalog-edit'); await tab.until(`Boolean(document.querySelector('#exercise-muscle-group'))`)
  assert.equal(await tab.evaluate(`document.querySelector('#exercise-muscle-group').disabled`),false)
  await input('#exercise-muscle-group','Spalle'); await click('.catalog-form button[type=submit]')
  await tab.until(`document.querySelector('.catalog-message')?.textContent.includes('salvato online')`)
  assert.equal([...mock.exercises.values()][0].id,adopted.id); assert.equal([...mock.exercises.values()][0].muscle_group,'Spalle')
  await click('.catalog-close'); await input('#exercise-group-filter','Spalle'); await tab.until(`document.querySelectorAll('.catalog-card').length===1`)
  await tab.send('Page.reload'); await tab.until(`Boolean(document.querySelector('.catalog-toolbar'))`)
  await click('.catalog-scope button[aria-pressed="false"]'); await input('#exercise-group-filter','Spalle')
  await tab.until(`document.querySelector('.catalog-card .muscle-group-badge')?.textContent==='Spalle'`)
  pass('adozione copia il gruppo, riclassificazione mantiene ID e persiste dopo reload')
  await click('.catalog-toolbar .primary'); await tab.until(`Boolean(document.querySelector('#exercise-name'))`)
  await input('#exercise-name','Panca piana'); assert.equal(await tab.evaluate(`document.querySelector('#exercise-muscle-group').value`),'Petto')
  await input('#exercise-muscle-group',''); await input('#exercise-name','Panca piana sintetica')
  assert.equal(await tab.evaluate(`document.querySelector('#exercise-muscle-group').value`),'')
  await click('.catalog-form button[type=submit]'); await tab.until(`document.querySelector('.catalog-message')?.textContent.includes('salvato online')`)
  assert.equal([...mock.exercises.values()].find(row=>row.name==='Panca piana sintetica').muscle_group,null)
  await click('.catalog-close'); await input('#exercise-group-filter','unclassified'); await tab.until(`document.querySelectorAll('.catalog-card').length===1`)
  pass('nuovo esercizio con suggerimento modificabile e Da classificare esplicito')
  await route('#/scheda/programmi/nuovo',`Boolean(document.querySelector('#wizard-name'))`)
  await input('#wizard-name','Programma gruppi sintetico'); await click('.wizard-next'); await tab.until(`Boolean(document.querySelector('.wz-add'))`)
  await click('.wz-add'); await tab.until(`Boolean(document.querySelector('#wizard-group-filter'))`)
  await input('#wizard-group-filter','Schiena'); await tab.until(`document.querySelectorAll('.wz-results li').length===1`)
  assert.equal(await tab.evaluate(`document.querySelector('.wz-results strong').textContent`),'Lat machine')
  await click('.wz-results button'); await tab.until(`document.querySelector('.wz-sheet-footer .button')?.textContent.includes('1 aggiunto')`)
  await input('#wizard-group-filter','Gambe'); await input('#wizard-search','Squat sintetico'); await click('.wz-create-start'); await tab.until(`Boolean(document.querySelector('#wizard-muscle-group'))`)
  assert.equal(await tab.evaluate(`document.querySelector('#wizard-muscle-group').value`),'Gambe')
  await click('.wz-create-confirm'); await tab.until(`document.querySelector('.wz-sheet-footer .button')?.textContent.includes('2 aggiunti')`)
  await click('.wz-sheet-footer .button'); await tab.until(`document.querySelectorAll('.wz-exercise').length===2`)
  assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('.wz-exercise .muscle-group-badge')].map(e=>e.textContent)`),['Schiena','Gambe'])
  await widths('wizard e gruppi'); await tab.screenshot(join(out,'wizard-gruppi.png'))
  pass('wizard filtra/adotta/crea per gruppo e mostra categorie nelle prescrizioni')
  await click('.wizard-top button[aria-label="Chiudi"]')
  await tab.until(`Boolean(document.querySelector('dialog[open]'))`); await click('dialog .primary'); await tab.until(`!document.querySelector('.wizard')`)
  // Nuova bozza avanzata: verifica optgroup per gruppi nelle due provenienze.
  await route('#/scheda/programmi/nuovo',`Boolean(document.querySelector('#wizard-name'))`)
  await tab.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('editor avanzato')).click()`)
  await tab.until(`Boolean(document.querySelector('.program-add-day'))`); await click('.program-add-day'); await tab.until(`Boolean(document.querySelector('.program-picker'))`)
  const groupSelector=await tab.evaluate(`document.querySelector('.program-picker .muscle-group-select select').id`)
  await input(`[id="${groupSelector}"]`,'Schiena')
  assert.deepEqual(await tab.evaluate(`[...document.querySelectorAll('.program-exercise-select optgroup')].map(e=>e.label)`),['I tuoi · Schiena'])
  await widths('editor avanzato'); await tab.screenshot(join(out,'editor-gruppi.png'))
  pass('editor avanzato filtra e raggruppa le opzioni, nessun overflow mobile/desktop')
  assert.deepEqual(mock.failures,[]); assert.deepEqual(tab.errors,[])
  assert.equal(mock.requests.some(url=>url.includes('/functions/v1/')),false)
  await writeFile(join(out,'report.json'),JSON.stringify({passed:checks.length,checks},null,2))
  console.log(`PASS ${checks.length} gruppi browser`)
} finally { await tab?.close(); await preview?.stop(); await chrome?.stop() }
