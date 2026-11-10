// Interazioni reali touch/mouse/tastiera sul componente della seduta, con soli dati sintetici.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { buildComponentHarness, ensureChrome, openTab, pause, serveStatic } from './lib/import-browser-harness.mjs'

let harness, chrome, server, tab
const check = (value, name) => { assert.ok(value, name); console.log(`PASS ${name}`) }
const ids = () => tab.evaluate(`[...document.querySelectorAll('[data-reorder-id]')].map(el=>el.dataset.reorderId)`)
const card = id => `[data-reorder-id="${id}"]`
const heading = id => `${card(id)} .set-card-heading`
const point = selector => tab.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center',behavior:'instant'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
const key = value => tab.key(value, value === ' ' ? 'Space' : value)
const focus = selector => tab.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`)
const moveKey = async (id, destination) => { await focus(card(id)); await key('Enter'); await key(destination); await key('Enter'); await pause(60) }
const touch = (type, p) => tab.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ ...p, id: 1, radiusX: 4, radiusY: 4 }] : [] })
const reload = async () => { await tab.send('Page.reload'); await tab.until(`!!document.querySelector('.session-cards')`); await pause(80) }

try {
  harness = await buildComponentHarness({ name: 'session-order', entry: at => `
    import React, {useState} from 'react'
    import {createRoot} from 'react-dom/client'
    import {SessionView} from '${at('features/Workout.tsx')}'
    import {forgetSessionOrder} from '${at('persistence/session-order.ts')}'
    import '${at('styles.css')}'
    const names=['Chest press','Rematore','Polpacci','Plank','Lat machine','Curl','Leg press','Spinte','Rematore','Cyclette','Affondi','Crunch']
    const exercises=names.map((name,i)=>({id:'e'+i,exerciseId:'catalog'+(i===8?1:i),name,sets:2,target:'8–12',mode:'reps',restSeconds:60,note:''}))
    const seed=(id='session-test')=>({id,date:'2026-11-09',startedAt:new Date().toISOString(),day:{id:'d',label:'A',title:'Seduta A',subtitle:'',exercises},results:Object.fromEntries(exercises.map(e=>[e.id,[{load:'',amount:'',completed:false},{load:'',amount:'',completed:false}]]))})
    function App(){
      const [session,setSession]=useState(()=>JSON.parse(localStorage.getItem('fixture-session')||'null')||seed())
      const save=next=>{localStorage.setItem('fixture-session',JSON.stringify(next));setSession(next)}
      return <><div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        <button className="fixture-reset" onClick={()=>{forgetSessionOrder();save(seed())}}>Reset</button>
        <button className="fixture-new" onClick={()=>save(seed('different-session'))}>Nuova seduta</button>
        <button className="fixture-single" onClick={()=>save({...seed('single'),day:{...seed().day,exercises:[exercises[0]]}})}>Un esercizio</button>
        <button className="fixture-add" onClick={()=>save({...session,day:{...session.day,exercises:[...session.day.exercises.slice(0,1),{...exercises[0],id:'new',name:'Esercizio aggiunto'},...session.day.exercises.slice(1)]},results:{...session.results,new:[{load:'',amount:'',completed:false}]}})}>Aggiungi dopo Chest press</button>
        <button className="fixture-remove" onClick={()=>save({...session,day:{...session.day,exercises:session.day.exercises.filter(e=>e.id!=='new')}})}>Rimuovi aggiunto</button>
      </div><SessionView key={session.id} session={session} sessions={[session]} onChange={(id,i,value)=>save({...session,results:{...session.results,[id]:session.results[id].map((v,j)=>i===j?value:v)}})} onComplete={()=>save({...session,completedAt:new Date().toISOString()})}/></>
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` })
  chrome = await ensureChrome()
  server = await serveStatic({ dist: harness.dist })
  tab = await openTab()
  await tab.viewport(390, 844, true)
  await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 })
  await tab.navigate(server.origin, `document.querySelectorAll('.set-panel[data-reorder-active]').length===12`)
  const canonical = await ids()
  check(!await tab.evaluate(`document.body.textContent.includes('Fallo dopo') || !!document.querySelector('.defer-exercise, .exercise-drag-handle')`), 'Riordino dalla card senza maniglia o comandi aggiuntivi')

  // I campi non attivano mai il riordino. Una bozza con virgola sopravvive al montaggio compatto.
  await tab.evaluate(`(()=>{const el=document.querySelector('[data-reorder-id="e2"] input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'22,');el.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const tap = await point(heading('e2'))
  await touch('touchStart', tap); await pause(80); await touch('touchEnd')
  check(!await tab.evaluate(`!!document.querySelector('.is-reordering')`), 'Un tocco breve sulla card non sposta esercizi')
  assert.deepEqual(await ids(), canonical)

  // Scroll touch normale su un bordo della card, senza attendere la pressione lunga.
  await tab.evaluate(`window.scrollTo(0,0)`)
  const beforeScroll = await tab.evaluate('scrollY')
  await touch('touchStart', { x: 5, y: 650 })
  for (let y = 620; y >= 320; y -= 30) { await touch('touchMove', { x: 5, y }); await pause(25) }
  await touch('touchEnd'); await pause(150)
  check(await tab.evaluate(`scrollY>${beforeScroll} && !document.querySelector('.is-reordering')`), 'Scorrimento touch normale anche iniziando sulla card')

  const inputPoint = await point(`${card('e2')} input`)
  await touch('touchStart', inputPoint); await pause(400); await touch('touchEnd')
  check(!await tab.evaluate(`!!document.querySelector('.is-reordering')`), 'Pressione lunga sui campi mantiene la modifica dei valori')
  await focus(`${card('e2')} input`); await key('Enter'); await key('ArrowUp')
  check(!await tab.evaluate(`!!document.querySelector('.is-reordering')`), 'La tastiera nei campi non attiva il riordino')
  const buttonPoint = await point(`${card('e0')} .set-check`)
  await touch('touchStart', buttonPoint); await pause(400); await touch('touchEnd')
  check(!await tab.evaluate(`!!document.querySelector('.is-reordering')`), 'Pressione lunga sui pulsanti non trascina la card')

  const start = await point(heading('e2'))
  await touch('touchStart', start); await pause(400)
  await tab.until(`!!document.querySelector('.is-reordering')`)
  check(await tab.evaluate(`(()=>{const rect=document.querySelector('[data-reorder-id="e2"]').getBoundingClientRect();const center=rect.top+rect.height/2;return Math.abs(center-${start.y})<4 || (scrollY===0 && center<${start.y})})()`), 'Compattazione mantiene la card sotto il dito entro il limite superiore della pagina')
  check(await tab.evaluate(`getComputedStyle(document.querySelector('.set-rows')).display==='none' && !document.querySelector('.exercise-drag-preview')`), 'Schede compatte senza riquadro flottante durante il trascinamento')
  const firstRow = await tab.evaluate(`(()=>{const r=document.querySelector('[data-reorder-id="e0"]').getBoundingClientRect();return {x:180,y:r.top+8}})()`)
  await touch('touchMove', firstRow); await pause(100)
  check((await ids())[0] === 'e2', 'Polpacci trascinati prima della Chest press in un gesto touch')
  await tab.screenshot(resolve(harness.dir, 'touch-drag.png'))
  await touch('touchEnd'); await tab.until(`!document.querySelector('.is-reordering')`); await pause(80)
  check(await tab.evaluate(`document.querySelector('[data-reorder-id="e2"] input').value==='22,'`), 'Valori e virgola della bozza conservati dopo il rilascio')
  check(await tab.evaluate(`document.activeElement?.dataset.reorderId==='e2'`), 'Focus ripristinato sulla card spostata')
  await reload()
  check((await ids())[0] === 'e2', 'Ordine conservato riaprendo la stessa seduta')

  // Riordino inverso e annullamento da tastiera, inclusi nomi uguali con ID diversi.
  await moveKey('e2', 'End')
  check((await ids()).at(-1) === 'e2', 'Spostamento alla fine dalla card con la tastiera')
  const beforeCancel = await ids()
  await focus(card('e8')); await key(' '); await key('Home'); await key('Escape')
  assert.deepEqual(await ids(), beforeCancel)
  check(await tab.evaluate(`!document.querySelector('.is-reordering')`), 'Escape annulla anche con esercizi omonimi')
  await focus(card('e8')); await key('Enter'); await key('ArrowUp'); await key('Enter')
  check((await ids()).indexOf('e8') === beforeCancel.indexOf('e8') - 1, 'Le frecce muovono la singola occorrenza corretta')

  // Il mouse usa la stessa logica e conserva la cattura anche dopo il primo cambio di posizione.
  await tab.send('Emulation.setTouchEmulationEnabled', { enabled: false })
  const mouse = await point(heading('e0'))
  await tab.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...mouse })
  await pause(170)
  await tab.until(`!!document.querySelector('.is-reordering')`)
  const nextRow = await tab.evaluate(`(()=>{const r=document.querySelector('[data-reorder-id="e3"]').getBoundingClientRect();return {x:180,y:r.bottom-4}})()`)
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, ...nextRow })
  await pause(80)
  check((await ids()).indexOf('e0') > (await ids()).indexOf('e3'), 'Mouse trascina verso il basso')
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: 180, y: 780 })
  const beforeAuto = await tab.evaluate('scrollY')
  await pause(900)
  check(await tab.evaluate(`scrollY>${beforeAuto} && !!document.querySelector('.is-reordering')`), 'Scorrimento automatico al bordo mantenendo il trascinamento')
  await tab.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: 180, y: 780 })
  await tab.until(`!document.querySelector('.is-reordering')`)
  const moved = await ids()
  await reload(); assert.deepEqual(await ids(), moved)

  // Interruzione del sistema: rollback senza salvare la bozza d'ordine.
  await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true })
  const cancelled = await point(`${card('e4')} .prescription-line`)
  await touch('touchStart', cancelled); await pause(370)
  await touch('touchMove', { x: 180, y: 250 }); await pause(50)
  await touch('touchCancel')
  await tab.until(`!document.querySelector('.is-reordering')`)
  // Il ripristino del focus e dello scroll termina nel frame successivo al rollback.
  await pause(80)
  assert.deepEqual(await ids(), moved)
  console.log('PASS pointercancel annulla lo spostamento senza cambiare l’ordine salvato')

  await tab.click('.fixture-add')
  const withAdded = await ids()
  check(withAdded.indexOf('new') === withAdded.indexOf('e0') + 1, 'Aggiunta mantiene il riordino e segue il proprio riferimento')
  await tab.click('.fixture-remove'); assert.deepEqual(await ids(), moved)

  // Anche il riepilogo di una card completata si trascina, ma un tocco breve continua ad aprirlo.
  await tab.evaluate(`document.querySelectorAll('[data-reorder-id="e11"] input').forEach((el,i)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,i%2===0?'10':'8');el.dispatchEvent(new Event('input',{bubbles:true}))})`)
  await tab.click(`${card('e11')} .set-row:nth-child(2) .set-check`)
  await tab.click(`${card('e11')} .set-row:nth-child(3) .set-check`)
  await tab.until(`document.querySelector('[data-reorder-id="e11"]').classList.contains('is-collapsed')`)
  const completedIndex = moved.indexOf('e11'), previousId = moved[completedIndex - 1]
  const summary = await point(`${card('e11')} .set-summary`)
  await touch('touchStart', summary); await pause(400)
  await tab.until(`!!document.querySelector('.is-reordering')`)
  const destination = await tab.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(card(previousId))}).getBoundingClientRect();return {x:180,y:r.top+8}})()`)
  await touch('touchMove', destination); await pause(70); await touch('touchEnd'); await pause(100)
  check((await ids()).indexOf('e11')===completedIndex-1 && await tab.evaluate(`document.querySelector('[data-reorder-id="e11"]').classList.contains('is-collapsed')`), 'Pressione lunga sul riepilogo sposta la card completata senza aprirla al rilascio')
  await tab.click(`${card('e11')} .set-summary`)
  check(await tab.evaluate(`!document.querySelector('[data-reorder-id="e11"]').classList.contains('is-collapsed')`), 'Un tocco breve continua ad aprire il riepilogo completato')
  await tab.click(`${card('e11')} .exercise-menu-trigger`)
  await tab.click(`${card('e11')} .set-collapse`)
  await moveKey('e11', 'ArrowDown'); assert.deepEqual(await ids(), moved)

  for (const width of [320, 390, 768, 1440]) {
    await tab.viewport(width, 844, width < 720)
    for (const theme of ['light', 'dark']) {
      await tab.evaluate(`document.documentElement.dataset.theme='${theme}';window.scrollTo(0,0)`)
      check(await tab.evaluate('document.documentElement.scrollWidth<=innerWidth'), `Nessun overflow: ${width}px, tema ${theme}`)
      await tab.screenshot(resolve(harness.dir, `${width}-${theme}.png`))
    }
  }
  await tab.click('.session-finish'); await tab.click('.session-finish-confirm')
  check(await tab.evaluate(`!document.querySelector('.set-panel[data-reorder-active]')`), 'Nessun riordino nelle sedute completate')
  assert.deepEqual(await ids(), canonical)
  await tab.click('.session-correct')
  check(await tab.evaluate(`!document.querySelector('.set-panel[data-reorder-active]')`), 'La correzione dello storico mantiene l’ordine prescritto')
  await tab.click('.fixture-new'); assert.deepEqual(await ids(), canonical)
  check(await tab.evaluate(`document.querySelector('[data-reorder-id="e2"] input').value===''`), 'Nuova seduta indipendente da ordine e valori della precedente')
  await tab.click('.fixture-single')
  check(!await tab.evaluate(`!!document.querySelector('.set-panel[data-reorder-active]')`), 'Nessun riordino se c’è un solo esercizio')

  // Migrazione dei rinvii già presenti; logout pulisce entrambe le chiavi tramite il controllo reset.
  await tab.click('.fixture-reset')
  await tab.evaluate(`localStorage.removeItem('peppitness:workout-order:v1');localStorage.setItem('peppitness:workout-later:v1',JSON.stringify({sessionId:'session-test',ids:['e0','e2']}))`)
  await reload()
  check((await ids()).slice(-2).join(',') === 'e0,e2', 'Rinvii preesistenti recuperati nel nuovo ordine')
  await moveKey('e2', 'Home')
  check(await tab.evaluate(`!localStorage.getItem('peppitness:workout-later:v1') && !!localStorage.getItem('peppitness:workout-order:v1')`), 'Il primo riordino migra l’archivio precedente')
  await tab.click('.fixture-reset')
  check(await tab.evaluate(`!localStorage.getItem('peppitness:workout-later:v1') && !localStorage.getItem('peppitness:workout-order:v1')`), 'Pulizia dei dati locali del riordino')
  assert.deepEqual(tab.errors, [])
  console.log(`PASS nessun errore JavaScript; schermate in ${harness.dir}`)
} finally {
  await tab?.close(); await server?.stop(); await chrome?.stop()
}
