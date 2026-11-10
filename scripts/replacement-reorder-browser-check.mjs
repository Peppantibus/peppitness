// Sostituzioni e scambi reali del dominio nella UI riordinabile; nessun accesso al database.
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildComponentHarness, ensureChrome, openTab, pause, serveStatic } from './lib/import-browser-harness.mjs'

let harness, chrome, server, tab
const check = (value, name) => { assert.ok(value, name); console.log(`PASS ${name}`) }
const clickText = async (selector, label) => {
  await tab.evaluate(`(()=>{const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(el=>el.textContent.trim()===${JSON.stringify(label)});if(!el)throw Error('Pulsante assente: '+${JSON.stringify(label)});el.setAttribute('data-target','replacement')})()`)
  await tab.click('[data-target="replacement"]')
  await tab.evaluate(`document.querySelector('[data-target="replacement"]')?.removeAttribute('data-target')`)
}
const card = id => `[data-reorder-id="${id}"]`
const replacement = id => `${card(id)} .replacement-actions button`
const openMenu = async id => {
  if (await tab.evaluate(`document.querySelector(${JSON.stringify(`${card(id)} .exercise-menu-trigger`)}).getAttribute('aria-expanded')==='false'`)) await tab.click(`${card(id)} .exercise-menu-trigger`)
}
const order = () => tab.evaluate(`[...document.querySelectorAll('.set-panel')].map(el=>el.dataset.reorderId)`)
const input = async (selector, value) => {
  await tab.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await pause(30)
}
const load = (id, row) => `${card(id)} .set-row:nth-child(${row + 1}) input:first-of-type`
const amount = (id, row) => `${card(id)} .set-row:nth-child(${row + 1}) input:nth-of-type(2)`
const loads = id => tab.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${card(id)} .set-row input:first-of-type`)})].map(el=>el.value)`)
const chooseLat = async () => {
  await tab.until(`!!document.querySelector('dialog[open] .wz-results')`)
  await tab.evaluate(`(()=>{const el=[...document.querySelectorAll('dialog[open] .wz-results button')].find(el=>el.querySelector('strong')?.textContent==='Lat machine');el.setAttribute('data-target','lat')})()`)
  await tab.click('[data-target="lat"]')
  await tab.until(`!!document.querySelector('dialog[open] .replacement-proposal')`)
}
try {
  harness = await buildComponentHarness({ name: 'replacement-reorder', entry: at => `
    import React,{useState} from 'react'
    import {createRoot} from 'react-dom/client'
    import {SessionView} from '${at('features/Workout.tsx')}'
    import {WorkoutReplacement} from '${at('features/WorkoutReplacement.tsx')}'
    import {dayFromSnapshot,emptyDiary,emptyResults} from '${at('domain/diary.ts')}'
    import {applyExerciseChange,datedDay} from '${at('domain/exercise-changes.ts')}'
    import {initialExercisesState} from '${at('persistence/exercises-store.ts')}'
    import '${at('styles.css')}'
    const chest={id:'chest',exercise_id:'catalog-chest',name:'Leg press a 45°',variant:'',equipment:'',load_convention:'total',load_unit:'kg',per_side:false,exercise_note:'',muscle_group:'Gambe',mode:'reps',sets:2,optional_sets:0,reps_min:8,reps_max:12,duration_seconds:null,rest_seconds:120,rir:null,rpe:null,note:''}
    const calf={...chest,id:'calf',exercise_id:'catalog-calf',name:'Polpacci',muscle_group:'Polpacci'}
    const lat={...chest,id:'lat',exercise_id:'catalog-lat',name:'Lat machine',muscle_group:'Schiena',sets:3}
    const day=(id,label,exercises)=>dayFromSnapshot(id,{label,title:label,note:'',plan_title:'Programma',version_number:1,exercises})
    const days=[day('mon','Lun',[chest,calf]),day('wed','Mer',[lat])]
    const rows=[chest,calf,lat].map(e=>({id:e.exercise_id,name:e.name,muscleGroup:e.muscle_group,variant:'',equipment:e.equipment,loadConvention:'total',loadUnit:'kg',measurementMode:'reps',perSide:false,note:'',archivedAt:null,revision:1}))
    const seed={id:'session',planId:'plan',versionId:'version',timeZone:'Europe/Rome',date:'2026-11-09',startedAt:'2026-11-09T09:00:00Z',day:days[0],results:emptyResults(days[0])}
    function App(){
      const previous={...structuredClone(seed),id:'previous',date:'2026-11-02',startedAt:'2026-11-02T09:00:00Z',completedAt:'2026-11-02T10:00:00Z',results:{chest:[{load:'40',amount:'10',completed:true},{load:'60',amount:'12',completed:true}],calf:[{load:'20',amount:'12',completed:true},{load:'20',amount:'12',completed:true}]}}
      const [data,setData]=useState({...emptyDiary(),sessions:[seed,previous]})
      const session=data.sessions[0],catalog={store:null,state:{...initialExercisesState(),phase:'ready',rows}}
      const store={changeExercise(command){setData(applyExerciseChange(data,command));return true},undoChange(id){const c=data.changes.find(c=>c.id===id);setData(applyExerciseChange(data,{...c,cancelled:true}));return true}}
      const future=datedDay(days[1],'2026-11-11','version',data.changes)
      return <><SessionView session={session} sessions={data.sessions} onComplete={()=>{}} onChange={(id,i,v)=>setData(current=>({...current,sessions:current.sessions.map(s=>s.id!==session.id?s:{...s,results:{...s.results,[id]:s.results[id].map((set,j)=>j===i?v:set)}})}))}
        exerciseActions={exercise=><WorkoutReplacement exercise={exercise} session={session} sessions={data.sessions} days={days} changes={data.changes} catalog={catalog} store={store} today='2026-11-09' enabled announce={()=>{}} onApplied={()=>{}}/>}/>
        <output id='future'>{future.exercises[0].name}</output></>
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` })
  chrome = await ensureChrome(); server = await serveStatic({ dist: harness.dist }); tab = await openTab()
  await tab.viewport(390, 844, true)
  await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  await tab.navigate(server.origin, `document.querySelectorAll('.replacement-actions button').length===2`)
  check(await tab.evaluate(`[...document.querySelectorAll('.replacement-actions button')].every(el=>el.textContent==='Sostituisci' && !el.disabled && el.getBoundingClientRect().height===0)`), 'Sostituisci raccolto nel menu senza una riga di comandi sulla card')
  check(await tab.evaluate(`!document.querySelector('[data-reorder-id="chest"] .set-card-heading').textContent.includes('Carico totale') && document.querySelector('[data-reorder-id="chest"] .prescription-line').textContent.includes('Recupero 2 min') && document.querySelectorAll('[data-reorder-id="chest"] .previous-inline').length===2`), 'Titolo pulito, dose compatta e risultati precedenti conservati')
  for (const theme of ['light','dark']) {
    await tab.evaluate(`document.documentElement.dataset.theme='${theme}'`)
    const clip = await tab.evaluate(`(()=>{const el=document.querySelector('[data-reorder-id="chest"]');el.scrollIntoView({block:'start'});const r=el.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height,scale:1}})()`)
    const shot=await tab.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip})
    await writeFile(resolve(harness.dir,`card-390-${theme}.png`),Buffer.from(shot.data,'base64'))
  }
  check(await tab.evaluate(`(()=>{const card=document.querySelector('[data-reorder-id="chest"]').getBoundingClientRect(),button=document.querySelector('[data-reorder-id="chest"] .reuse-loads').getBoundingClientRect();return card.right-button.right<30 && button.left-card.left<30 && button.width>card.width*.8})()`), 'Riprendi carichi e ripetizioni a tutta larghezza')
  await tab.click(`${card('chest')} .reuse-loads`)
  assert.deepEqual(await loads('chest'), ['40','60'])
  check(await tab.evaluate(`document.querySelector('[data-reorder-id="chest"] .undo-reuse-loads')?.textContent==='Annulla ripresa' && JSON.stringify([...document.querySelectorAll('[data-reorder-id="chest"] .set-row input:nth-of-type(2)')].map(el=>el.value))==='["10","12"]' && !document.querySelector('[data-reorder-id="chest"] .set-check[aria-pressed="true"]')`), 'Ripresa di carichi e ripetizioni senza confermare serie')
  await tab.screenshot(resolve(harness.dir,'undo-loads-390-dark.png'))
  await tab.click(`${card('chest')} .undo-reuse-loads`)
  assert.deepEqual(await loads('chest'), ['',''])
  check(await tab.evaluate(`document.querySelector('[data-reorder-id="chest"] .reuse-loads').textContent==='Riprendi carichi e ripetizioni' && !document.querySelector('[data-reorder-id="chest"] .reuse-loads').disabled && [...document.querySelectorAll('[data-reorder-id="chest"] .set-row input:nth-of-type(2)')].every(el=>el.value==='')`), 'Annulla ripristina i campi vuoti e permette una nuova ripresa')

  await input(load('chest',1),'35')
  await tab.click(`${card('chest')} .reuse-loads`)
  assert.deepEqual(await loads('chest'), ['35','60'])
  await tab.click(`${card('chest')} .undo-reuse-loads`)
  assert.deepEqual(await loads('chest'), ['35',''])
  console.log('PASS I carichi già presenti prima della ripresa restano intatti')
  await input(load('chest',1),'')
  await tab.click(`${card('chest')} .reuse-loads`)
  await input(load('chest',1),'45'); await input(amount('chest',2),'11')
  await tab.click(`${card('chest')} .undo-reuse-loads`)
  assert.deepEqual(await loads('chest'), ['45',''])
  check(await tab.evaluate(`document.querySelector('[data-reorder-id="chest"] .set-row:nth-child(3) input:nth-of-type(2)').value==='11'`), 'Annulla conserva modifiche manuali e ripetizioni inserite dopo la ripresa')
  await input(load('chest',1),''); await input(amount('chest',2),'')

  await tab.click(`${card('chest')} .reuse-loads`)
  await input(amount('chest',1),'10')
  await tab.click(`${card('chest')} .set-row:nth-child(2) .set-check`)
  await tab.click(`${card('chest')} .undo-reuse-loads`)
  assert.deepEqual(await loads('chest'), ['40',''])
  check(await tab.evaluate(`document.querySelector('[data-reorder-id="chest"] .set-check').getAttribute('aria-pressed')==='true'`), 'Annulla conserva la serie già completata')
  await tab.click(`${card('chest')} .set-row:nth-child(2) .set-check`)
  await input(load('chest',1),''); await input(amount('chest',1),'')

  await tab.click(`${card('chest')} .reuse-loads`)
  await tab.click(`${card('calf')} .reuse-loads`)
  await tab.click(`${card('chest')} .undo-reuse-loads`)
  assert.deepEqual(await loads('chest'), ['',''])
  assert.deepEqual(await loads('calf'), ['20','20'])
  await tab.click(`${card('calf')} .undo-reuse-loads`)
  assert.deepEqual(await loads('calf'), ['',''])
  console.log('PASS Annullamento indipendente per ogni esercizio')
  await openMenu('chest')
  check(await tab.evaluate(`document.querySelector('[data-reorder-id="chest"] .history-peek').getBoundingClientRect().height>=44 && document.querySelector('[data-reorder-id="chest"] .replacement-actions button').getBoundingClientRect().height>=44`), 'Sostituisci e Storico accessibili dal menu con bersagli touch comodi')
  await tab.screenshot(resolve(harness.dir,'menu-390-dark.png'))
  await tab.click(`${card('chest')} .history-peek`)
  await tab.until(`!!document.querySelector('dialog[open] .previous-sheet')`)
  check(await tab.evaluate(`document.querySelector('dialog[open]').textContent.includes('40 kg')`), 'Storico aperto dal menu con i risultati precedenti')
  await tab.key('Escape', 'Escape', 27)
  await tab.until(`!document.querySelector('dialog[open]')`)
  await openMenu('chest'); await tab.click(`${card('chest')} .exercise-details`)
  await tab.until(`!!document.querySelector('dialog[open] .detail-facts')`)
  check(await tab.evaluate(`document.querySelector('dialog[open]').textContent.includes('Carico totale')`), 'Convenzione del carico disponibile nei dettagli')
  await tab.key('Escape', 'Escape', 27)
  await tab.until(`!document.querySelector('dialog[open]')`)

  // Riordino tramite la card: i comandi tornano dopo il rilascio.
  const source = await tab.evaluate(`(()=>{const el=document.querySelector('[data-reorder-id="calf"] .set-card-heading');el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+40,y:r.y+r.height/2}})()`)
  const touch = (type, point) => tab.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [{ ...point, id: 1 }] : [] })
  await touch('touchStart', source); await pause(400)
  await tab.until(`!!document.querySelector('.is-reordering')`)
  const destination = await tab.evaluate(`(()=>{const r=document.querySelector('[data-reorder-id="chest"]').getBoundingClientRect();return {x:180,y:r.top+5}})()`)
  await touch('touchMove', destination); await pause(70); await touch('touchEnd'); await pause(100)
  assert.deepEqual(await order(), ['calf', 'chest'])
  await openMenu('chest')
  check(await tab.evaluate(`document.querySelector('[data-reorder-id="chest"] .replacement-actions button').getBoundingClientRect().height>=44 && !document.querySelector('[data-reorder-id="chest"] .replacement-actions button').disabled`), 'Sostituisci accessibile dal menu anche dopo il trascinamento')
  await tab.click(replacement('chest')); await chooseLat()
  check(await tab.evaluate(`document.querySelector('.replacement-swap')?.textContent.includes('mercoledì') || document.querySelector('.replacement-swap button')?.textContent.includes('mercoledì')`), 'Proposta di scambio con la seduta di mercoledì ancora disponibile')
  await clickText('dialog[open] button', 'Scambia con mercoledì')
  await tab.until(`document.querySelector('[data-reorder-id="chest"] h2')?.textContent==='Lat machine'`)
  assert.deepEqual(await order(), ['calf', 'chest'])
  check(await tab.evaluate(`document.querySelector('#future').textContent==='Leg press a 45°'`), 'Scambio applicato a oggi e alla seduta futura mantenendo il riordino')
  await openMenu('chest')
  await clickText(`${card('chest')} .replacement-actions button`, 'Annulla')
  await tab.until(`document.querySelector('[data-reorder-id="chest"] h2')?.textContent==='Leg press a 45°'`)
  await openMenu('chest'); await tab.click(replacement('chest')); await chooseLat(); await clickText('dialog[open] button', 'Sostituisci solo oggi')
  check(await tab.evaluate(`document.querySelector('[data-reorder-id="chest"] h2').textContent==='Lat machine' && document.querySelector('#future').textContent==='Lat machine'`), 'Anche Sostituisci solo oggi resta funzionante')
  await openMenu('chest'); await clickText(`${card('chest')} .replacement-actions button`, 'Annulla')

  // Non nascondere più il comando quando cominciano le registrazioni.
  await tab.evaluate(`(()=>{const el=document.querySelector('[data-reorder-id="chest"] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'20');el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await openMenu('chest')
  check(await tab.evaluate(`(()=>{const b=document.querySelector('[data-reorder-id="chest"] .replacement-actions button');return b.textContent==='Sostituisci' && b.disabled && b.getBoundingClientRect().height>=44 && document.querySelector('[data-reorder-id="chest"]').textContent.includes('Esercizio già iniziato')})()`), 'Il menu spiega perché la sostituzione è bloccata su un esercizio iniziato')
  check(await tab.evaluate(`!document.querySelector('[data-reorder-id="calf"] .replacement-actions button').disabled`), 'Le registrazioni su una card non impediscono di sostituire gli altri esercizi')
  await tab.click(`${card('chest')} .exercise-menu-trigger`)
  for (const width of [320, 390, 1440]) {
    await tab.viewport(width, 844, width < 720)
    for (const theme of ['light', 'dark']) {
      await tab.evaluate(`document.documentElement.dataset.theme='${theme}'`)
      check(await tab.evaluate(`document.documentElement.scrollWidth<=innerWidth`), `Sostituzioni senza overflow a ${width}px, ${theme}`)
      await tab.screenshot(resolve(harness.dir, `${width}-${theme}.png`))
    }
  }
  assert.deepEqual(tab.errors, [])
  console.log(`PASS nessun errore JavaScript; schermate in ${harness.dir}`)
} catch (error) {
  if (tab) {
    console.log(await tab.evaluate(`({dialogs:[...document.querySelectorAll('dialog')].map(d=>({open:d.open,label:d.getAttribute('aria-label'),text:d.textContent.slice(0,300)})),menus:[...document.querySelectorAll('.exercise-menu-trigger')].map(b=>({expanded:b.getAttribute('aria-expanded'),label:b.getAttribute('aria-label')})),active:document.activeElement?.outerHTML.slice(0,200)})`))
    await tab.screenshot(resolve(harness.dir,'failure.png'))
  }
  throw error
} finally { await tab?.close(); await server?.stop(); await chrome?.stop() }
