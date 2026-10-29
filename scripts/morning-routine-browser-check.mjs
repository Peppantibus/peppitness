// Whole application with local Auth/PostgREST and synthetic accounts only.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {build} from 'vite'
import react from '@vitejs/plugin-react'
import {morningLocalFixture,syntheticMorningRoutine} from './lib/morning-routine-local-fixture.mjs'
import {ensureChrome,openTab,serveStatic,appCsp,pause} from './lib/import-browser-harness.mjs'
import {localDate,shiftDate} from '../src/domain/dates.ts'
const f=await morningLocalFixture(),directory=resolve('artifacts/morning-routine-local'),checks=[]
let server,chrome,otherChrome,tab,other
const check=label=>{checks.push(label);console.log('PASS '+label)}
try{
 await mkdir(directory,{recursive:true})
 await build({configFile:false,plugins:[react()],logLevel:'silent',define:{'import.meta.env.VITE_SUPABASE_URL':JSON.stringify(f.config.apiUrl),'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY':JSON.stringify(f.config.publishableKey)},build:{outDir:resolve(directory,'dist'),emptyOutDir:true,sourcemap:false,target:'safari16'}})
 server=await serveStatic({dist:resolve(directory,'dist'),port:4174,csp:(await appCsp()).replace("connect-src 'self'",`connect-src 'self' ${f.config.apiUrl}`)})
 const doc=syntheticMorningRoutine(),seed=await f.a.client.rpc('save_morning_routine',{p_document:doc,p_expected_revision:0,p_request_id:randomUUID()});assert.ifError(seed.error)
 chrome=await ensureChrome();tab=await openTab();await tab.send('Page.bringToFront')
 const authKey='sb-'+new URL(f.config.apiUrl).hostname.split('.')[0]+'-auth-token'
 await tab.send('Storage.clearDataForOrigin',{origin:server.origin,storageTypes:'all'})
 await tab.send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem(${JSON.stringify(authKey)},${JSON.stringify(JSON.stringify(f.a.session))})`})
 let offline=false
 tab.fetchHandlers.push(params=>{if(!params.request.url.startsWith(f.config.apiUrl+'/'))return false;void tab.send(offline?'Fetch.failRequest':'Fetch.continueRequest',offline?{requestId:params.requestId,errorReason:'InternetDisconnected'}:{requestId:params.requestId});return true})
 await tab.send('Fetch.enable',{patterns:[{urlPattern:f.config.apiUrl+'/*'}]})
 await tab.viewport(390,844,true)
 await tab.navigate(server.origin+'/#/scheda','!!document.querySelector(".morning-entry") && document.querySelector(".morning-entry").textContent.includes("Routine sintetica")')
 const today=localDate(),weekday=new Date(today+'T12:00:00Z').getUTCDay()||7,base=shiftDate(today,-((weekday-3+7)%7)),strength=shiftDate(base,-1)
 const input=async(selector,value)=>{await tab.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);await pause(80)}
 await input('input[type=date]',strength);await tab.click('.morning-entry');await tab.until('document.querySelector("#routine-duration")?.textContent==="14 min"')
 assert.equal(await tab.evaluate('document.querySelectorAll(".morning-movement").length'),9);check('Scheda → routine: programma privato e rinforzo del giorno, 14 minuti')
 await tab.click('[aria-label="Giorno successivo"]');await tab.until('document.querySelector("#routine-duration")?.textContent==="10 min"');assert.equal(await tab.evaluate('document.querySelectorAll(".morning-movement").length'),7);check('Cambio giorno: sola base, 10 minuti')
 for(const theme of ['dark','light'])for(const width of [320,390,768,1440]){
  await tab.viewport(width,width<768?844:1000,width<768);await tab.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};scrollTo(0,0)`)
  assert.equal(await tab.evaluate('document.documentElement.scrollWidth<=innerWidth'),true)
  assert.equal(await tab.evaluate('!!document.querySelector(".morning-finish-hint,.morning-reminders,.morning-eyebrow")'),false)
  await tab.screenshot(resolve(directory,`routine-${theme}-${width}.png`))
 }check('8 combinazioni schermo/tema: nessun overflow, intestazione snella e solo pulsante nel footer')
 await tab.viewport(390,844,true);await tab.click('.morning-edit');await tab.until('!!document.querySelector("#save-routine")')
 const remove='.routine-editor-section:first-of-type .routine-remove-inline'
 await tab.click(remove);await tab.until('!!document.querySelector("dialog[open]")');assert.equal(await tab.evaluate('document.querySelectorAll(".routine-editor-movement").length'),9)
 assert.match(await tab.evaluate('document.querySelector("dialog[open]").textContent'),/Movimento sintetico 1/)
 await tab.click('dialog[open] .secondary');assert.equal(await tab.evaluate('document.querySelectorAll(".routine-editor-movement").length'),9)
 await tab.click(remove);await tab.click('dialog[open] .danger');assert.equal(await tab.evaluate('document.querySelectorAll(".routine-editor-movement").length'),8)
 await tab.click('[aria-label="Annulla modifiche"]');await tab.until('document.querySelector("dialog[open]")?.textContent.includes("Uscire")');await tab.click('dialog[open] .danger');await tab.until('!!document.querySelector(".morning-edit")')
 assert.equal(await tab.evaluate('document.querySelectorAll(".morning-movement").length'),7);check('X: conferma con nome, Annulla conserva, Rimuovi modifica solo la bozza; uscita confermata scarta')
 await tab.click('.morning-edit');await input('#routine-name','Routine modificata');await tab.click('[aria-label="Rinforzo Mer"]');await tab.click('#save-routine')
 await tab.until('document.querySelector(".morning-heading h1")?.textContent.includes("Routine modificata")');await tab.until(`JSON.parse(localStorage.getItem('peppitness:morning-routine:v1:${f.a.owner}')).queue.length===0`)
 assert.equal(await tab.evaluate('document.querySelector("#routine-duration").textContent'),'14 min');check('Modifica nome/giorni salvata su RPC reali e totale aggiornato')
 await tab.evaluate('location.hash="/scheda"');await tab.until('!!document.querySelector(".date-panel")');await input('input[type=date]',today);await tab.click('.morning-entry');await tab.until('!!document.querySelector("#mark-routine-done")')
 offline=true;await tab.click('#mark-routine-done');await tab.until('document.querySelector(".morning-status")?.textContent.includes("Fatta")')
 await tab.send('Page.reload');await tab.until('document.querySelector(".morning-status")?.textContent.includes("Fatta")')
 assert.equal(await tab.evaluate(`JSON.parse(localStorage.getItem('peppitness:morning-routine:v1:${f.a.owner}')).queue.length`),1)
 offline=false;await tab.evaluate('dispatchEvent(new Event("online"))');await tab.until(`JSON.parse(localStorage.getItem('peppitness:morning-routine:v1:${f.a.owner}')).queue.length===0`)
 let logged=await f.a.client.from('morning_routine_days').select('*').eq('date',today).single();assert.ifError(logged.error);assert.equal(logged.data.snapshot.title,'Routine modificata');check('API offline: completamento, reload e invio al ritorno della connessione')
 await tab.click('.morning-edit');await input('#routine-name','Nuovo nome');await tab.click('#save-routine');await tab.until('!!document.querySelector(".morning-edit")')
 assert.match(await tab.evaluate('document.querySelector(".morning-heading h1").textContent'),/Routine modificata/);check('Giornata completata conserva lo snapshot dopo una modifica')
 await tab.click('.morning-undo');await tab.until('!!document.querySelector("dialog[open]")');await tab.click('dialog[open] .secondary');assert.equal(await tab.evaluate('!!document.querySelector("#mark-routine-done")'),false)
 await tab.click('.morning-undo');await tab.click('dialog[open] .danger');await tab.until('!!document.querySelector("#mark-routine-done")');await tab.until(`JSON.parse(localStorage.getItem('peppitness:morning-routine:v1:${f.a.owner}')).queue.length===0`)
 logged=await f.a.client.from('morning_routine_days').select('*').eq('date',today).single();assert.ifError(logged.error);assert.equal(logged.data.snapshot,null);check('Annullamento completamento richiede conferma e persiste online')
 // Refresh during an open editor must retain the revision the editor started from.
 await tab.click('.morning-edit');await tab.until('!!document.querySelector("#save-routine")')
 const before=await f.a.client.from('morning_routines').select('*').single();assert.ifError(before.error)
 const concurrent=await f.a.client.rpc('save_morning_routine',{p_document:{...before.data.document,title:'Nome da altro dispositivo'},p_expected_revision:before.data.revision,p_request_id:randomUUID()});assert.ifError(concurrent.error)
 await tab.evaluate('dispatchEvent(new Event("online"))');await tab.until(`JSON.parse(localStorage.getItem('peppitness:morning-routine:v1:${f.a.owner}')).routine.revision===${before.data.revision+1}`)
 await input('#routine-name','Bozza locale precedente');await tab.click('#save-routine');await tab.until('document.querySelector(".morning-sync")?.textContent.includes("altro dispositivo")')
 assert.match(await tab.evaluate('document.querySelector(".morning-heading h1").textContent'),/Bozza locale precedente/)
 await tab.click('.morning-sync .button.secondary');await tab.until('!!document.querySelector("dialog[open]")');await tab.click('dialog[open] .secondary')
 assert.equal(await tab.evaluate(`JSON.parse(localStorage.getItem('peppitness:morning-routine:v1:${f.a.owner}')).queue.length`),1)
 await tab.click('.morning-sync .button.secondary');await tab.click('dialog[open] .danger');await tab.until('document.querySelector(".morning-heading h1")?.textContent.includes("Nome da altro dispositivo")')
 check('Editor aperto prima di una rilettura: conflitto preservato, scelta online con conferma')
 otherChrome=await ensureChrome({url:'http://127.0.0.1:9224'});other=await openTab({url:'http://127.0.0.1:9224'})
 await other.send('Storage.clearDataForOrigin',{origin:server.origin,storageTypes:'all'});await other.send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem(${JSON.stringify(authKey)},${JSON.stringify(JSON.stringify(f.b.session))})`})
 await other.navigate(server.origin+'/#/scheda/mattino','document.querySelector("h1")?.textContent.includes("La tua routine del mattino")')
 assert.equal(await other.evaluate(`localStorage.getItem('peppitness:morning-routine:v1:${f.a.owner}')`),null);check('Secondo account/profilo reale: nessuna routine o cache del primo')
 await other.click('a[href="#/scheda/mattino/modifica"]');await other.until('!!document.querySelector("#save-routine")')
 await other.click('.routine-editor-section:first-of-type .routine-add');await other.click('#save-routine');await other.until('!!document.querySelector("#mark-routine-done")')
 await other.until(`JSON.parse(localStorage.getItem('peppitness:morning-routine:v1:${f.b.owner}')).queue.length===0`)
 const bSaved=await f.b.client.from('morning_routines').select('*').single();assert.ifError(bSaved.error);assert.equal(bSaved.data.document.base.length,1)
 await other.click('.morning-edit');await other.click('.routine-remove-inline');await other.click('dialog[open] .danger');await other.click('#save-routine');await other.until('document.querySelector(".routine-editor-footer [role=alert]")?.textContent.includes("almeno un esercizio")')
 check('Account senza routine: creazione privata e blocco del salvataggio senza base')
 assert.ok(tab.requests.every(url=>!/^https?:/.test(url)||[server.origin,f.config.apiUrl].includes(new URL(url).origin)))
 const expectedConflict=message=>message.includes('status of 409')&&message.includes('/rpc/save_morning_routine')
 assert.equal(tab.errors.filter(expectedConflict).length,1)
 assert.deepEqual(tab.errors.filter(message=>!message.includes('ERR_INTERNET_DISCONNECTED')&&!message.includes('net::ERR_FAILED')&&!expectedConflict(message)),[])
 assert.deepEqual(other.errors,[]);assert.ok(other.requests.every(url=>!/^https?:/.test(url)||[server.origin,f.config.apiUrl].includes(new URL(url).origin)))
 await writeFile(resolve(directory,'browser-results.json'),JSON.stringify({pass:true,checks,cloudRequests:0,expectedHttpConflict:1},null,2));console.log(JSON.stringify({pass:true,checks:checks.length}))
}finally{await tab?.close();await other?.close();await chrome?.stop();await otherChrome?.stop();await server?.stop();await f.cleanup()}
