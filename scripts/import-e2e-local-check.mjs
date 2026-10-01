// Real browser/SDK/Edge/Auth/PostgreSQL. Only the server provider is synthetic.
// Requires exclusive local stack and Edge: node scripts/import-edge-local-check.mjs --write-env;
// npx supabase functions serve extract-plan. No cloud env file is changed.
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readLocalStatus } from './lib/local-supabase.mjs'
import { importLocalSql, sqlLiteral as lit } from './lib/import-local-db.mjs'
import { ensureChrome, openTab, pause, root, serveStatic } from './lib/import-browser-harness.mjs'
import { buildDocx, para, tbl, tc, tr } from './lib/docx-fixtures.mjs'
import { buildPdf, text as pdfText } from './lib/pdf-fixtures.mjs'
import { readDocx } from '../src/import/readers/docx.ts'
import { createOpenAIProvider } from '../supabase/functions/_shared/import/openai-provider.ts'
import { readProviderConfig } from '../supabase/functions/_shared/import/provider.ts'
import { IMPORT_PROMPT_VERSION } from '../supabase/functions/_shared/import/prompts.ts'

const out = join(root, 'artifacts/import-e2e'), origin = 'http://127.0.0.1:4173'
const report = { mode: 'local-real-provider-synthetic', checks: [], iphone: 'NOT_RUN', result: 'FAIL' }
let config, original, tab, server, chrome
const users = [], marker = `e2e/${randomUUID()}`
const sharedId = randomUUID()
const pass = name => { report.checks.push(name); console.log(`PASS ${name}`) }
async function api(path, { token, admin = false, method = 'GET', body } = {}) {
  const key = admin ? config.adminKey : config.publicKey
  const response = await fetch(config.apiUrl + path, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { apikey: key, Authorization: `Bearer ${token ?? key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) })
  const data = await response.json().catch(() => null)
  assert.ok(response.ok, `local ${method} ${path.split('?')[0]}: ${response.status} ${data?.code ?? ''}`)
  return data
}
async function actor(label) {
  const email = `e2e-${label}-${randomUUID()}@peppitness.local`, password = `Aa1!${randomUUID()}`
  const user = await api('/auth/v1/admin/users', { admin: true, method: 'POST', body: { email, password, email_confirm: true } })
  const id = user.id ?? user.user.id; users.push(id)
  return { id, session: await api('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } }) }
}
const text = sel => `(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '')`
async function press(label, scope = '') {
  await tab.until(`[...document.querySelectorAll(${JSON.stringify(`${scope} button`.trim())})].some(b => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled)`, `button ${label}`)
  await tab.evaluate(`[...document.querySelectorAll(${JSON.stringify(`${scope} button`.trim())})].find(b => b.textContent.trim() === ${JSON.stringify(label)}).click()`)
  await pause(150)
}
async function type(selector, value) {
  await tab.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.focus(); e.select?.() })()`)
  await tab.send('Input.insertText', { text: value }); await tab.evaluate('document.activeElement.blur()'); await pause(150)
}
async function records() {
  return tab.evaluate(`new Promise((resolve,reject)=> { const r=indexedDB.open('peppitness-import'); r.onsuccess=()=>{const db=r.result;const q=db.transaction('sessions').objectStore('sessions').getAll();q.onsuccess=()=>{db.close();resolve(q.result)};q.onerror=()=>reject(q.error)} })`)
}
/**
 * File scelto e analisi esplicita. Se esiste già un'analisi pronta della stessa fonte l'app propone di riaprirla:
 * `compatible` decide in modo esplicito ('reopen' senza costi, 'new' nuova analisi, 'none' = non deve comparire).
 */
async function choose(kind, file, compatible = 'none') {
  await tab.evaluate(`location.hash=${JSON.stringify(kind === 'workout' ? '#/scheda/importa' : '#/dieta/importa')}`)
  await tab.until(`Boolean(document.querySelector('.import-drop input, .import-change input'))`)
  await tab.setFiles('.import-drop input, .import-change input', [join(out, file)])
  await tab.until(`${text('.import-summary h2')} === 'Documento letto' && ${text('.import-file-name')} === ${JSON.stringify(file)}`)
  await pause(300)
  await tab.click('.import-analyze')
  await tab.until(`Boolean(document.querySelector('[data-review=${kind}], .import-reopen'))`, `Edge -> review ${kind}`, 800)
  if (await tab.evaluate(`Boolean(document.querySelector('.import-reopen'))`)) {
    assert.notEqual(compatible, 'none', `analisi compatibile inattesa per ${file}`)
    await tab.click(compatible === 'reopen' ? '.import-reopen' : '.import-analyze-again')
    await tab.until(`Boolean(document.querySelector('[data-review=${kind}]'))`, `Edge -> review ${kind}`, 800)
  }
}
async function resolveWorkout(squat, choice='existing') {
  await press('A rotazione')
  const id=await tab.evaluate(`document.querySelector('.wr-exercise').dataset.localId`)
  await tab.click(`#rv-item-${id}`)
  await type(`#rv-${id}-restSeconds`,'90')
  await press('Nessuna serie facoltativa',`#rv-detail-${id}`)
  await tab.click(`#rv-${id}-catalog-pick`)
  if (choice !== 'new') {
    await tab.until(`Boolean(document.querySelector('[data-candidate="${squat}"] button'))`)
    await tab.click(`[data-candidate="${squat}"] button`)
  } else {
    await press('Nuovo esercizio','dialog[open]')
    for(const label of ['Carico totale','kg','No']) await press(label,'dialog[open] .wr-new')
    await tab.click('dialog[open] .wr-new input[type=checkbox]')
    await press('Usa come nuovo esercizio','dialog[open]')
  }
  await tab.until(`Boolean(document.querySelector('[data-preview=workout]'))`)
}
async function run() {
  config = readLocalStatus() // validates loopback before ALL writes
  assert.match(config.publishableKey, /^sb_publishable_/)
  const env = await readFile(join(root, 'supabase/functions/.env'), 'utf8')
  assert.match(env, /^IMPORT_TEST_TRANSPORT=synthetic$/m)
  assert.match(env, /^IMPORT_MODEL=synthetic-edge-2026-01-01$/m)
  assert.match(env, /^OPENAI_API_KEY=sk-synthetic-local-edge-not-a-real-key$/m)
  assert.ok(env.includes(origin), 'Edge must allow isolated preview origin')
  await mkdir(out, { recursive: true })
  const dist = join(out, 'dist')
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.pwa.config.mjs', '--outDir', dist], {
    cwd: root, env: { ...process.env, VITE_SUPABASE_URL: config.apiUrl, VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey }, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  await writeFile(join(out, 'build.log'), build.stdout + build.stderr)
  assert.equal(build.status, 0, 'isolated local PWA build')
  const headers = await readFile(join(dist, '_headers'), 'utf8')
  server = await serveStatic({ dist, port: 4173, csp: /Content-Security-Policy:\s*(.+)/.exec(headers)[1] })
  chrome = await ensureChrome()
  original = (await importLocalSql('select to_jsonb(c) as config from peppitness_private.import_budget_config c where singleton'))[0].config
  assert.equal(original.enabled, false); assert.equal(original.provider, null)
  await importLocalSql(`do $f$ begin
    perform 1 from peppitness_private.import_budget_config where singleton for update;
    if not exists(select 1 from peppitness_private.import_budget_config c where to_jsonb(c)=${lit(JSON.stringify(original))}::jsonb)
      or exists(select 1 from peppitness_private.import_usage_ledger) or exists(select 1 from peppitness_private.import_budget_retired) then raise exception 'exclusive stack required'; end if;
    update peppitness_private.import_budget_config set enabled=true,config_version=${lit(marker)},price_version='synthetic/1',provider='openai',model='synthetic-edge-2026-01-01',currency='USD',
      project_limit_micros=1000000000000,account_limit_micros=1000000000000,input_micros_per_million=1000000,output_micros_per_million=1000000,
      max_active_per_account=1,daily_analyses=100,max_attempts=2,max_input_tokens=200000,max_output_tokens=16000,framing_tokens=256 where singleton;
    end $f$`)
  await writeFile(join(out,'recovery.json'),JSON.stringify({original,marker,users}))
  const a = await actor('a'), b = await actor('b')
  await writeFile(join(out,'recovery.json'),JSON.stringify({original,marker,users}))
  const token = a.session.access_token
  const squat = randomUUID()
  await api('/rest/v1/exercises', { token, method: 'POST', body: { id: squat, owner_id: a.id, name: 'Squat', variant: '', equipment: 'bilanciere', load_convention: 'total', load_unit: 'kg', measurement_mode: 'reps', per_side: false, note: '' } })
  await importLocalSql(`insert into public.shared_exercises(id,name,variant,equipment,load_convention,load_unit,measurement_mode,per_side,note)
    values(${lit(sharedId)},'Squat','','bilanciere','total','kg','reps',false,'E2E synthetic shared') returning id`)
  const lines = { workout: ['Scheda E2E sintetica', 'Seduta A', 'Squat | 3 x 8-10 | recupero non indicato'],
    diet: ['Dieta E2E sintetica', 'Giorno 1', 'Colazione: yogurt bianco. In alternativa allo yogurt: latte 200 ml.', 'Nei giorni di allenamento lungo aggiungere 20 g di frutta secca a scelta.'] }
  const files = {}
  for (const kind of ['workout','diet']) {
    files[`${kind}.docx`] = buildDocx({ body: lines[kind].map((s,i)=>para(s, i < 2 ? {style:`Titolo${i+1}`} : {})).join('') })
    files[`${kind}.pdf`] = buildPdf({pages:[{content:lines[kind].map((s,i)=>pdfText(40,790-i*35,s,{size: i===0 ? 16 : 10}))}]})
  }
  // Table source keeps the exact prescription text of the annotated answer.
  files['workout.docx'] = buildDocx({body:[para(lines.workout[0],{style:'Titolo1'}),para('Seduta A',{style:'Titolo2'}),tbl(3,[tr([tc('Squat'),tc('3 x 8-10'),tc('recupero non indicato')])])].join('')})
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(out,name),bytes)
  report.files = Object.entries(files).map(([name,bytes])=>({name,sha256:createHash('sha256').update(bytes).digest('hex')}))
  tab = await openTab()
  await tab.send('Storage.clearDataForOrigin', { origin, storageTypes:'all' })
  const violations = []
  tab.fetchHandlers.push(p => {
    const url=new URL(p.request.url)
    if (['http:','https:'].includes(url.protocol) && ![origin,config.apiUrl].includes(url.origin)) {
      violations.push(url.origin); void tab.send('Fetch.failRequest',{requestId:p.requestId,errorReason:'BlockedByClient'}).catch(()=>{}); return true
    }
    void tab.send('Fetch.continueRequest',{requestId:p.requestId}).catch(()=>{});return true
  })
  await tab.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]})
  await tab.navigate(origin,'document.readyState === "complete"')
  const storageKey='sb-127-auth-token'
  await tab.evaluate(`localStorage.setItem(${JSON.stringify(storageKey)},${JSON.stringify(JSON.stringify(a.session))}); location.hash='#/scheda'`)
  await tab.send('Page.reload')
  await tab.until(`Boolean(document.querySelector('a[href="#/scheda/importa"]'))`, 'real SDK session')
  pass('Auth reale A/B; build PWA locale con CSP; rete remota bloccata')
  await choose('workout','workout.docx')
  await resolveWorkout(squat)
  await tab.send('Page.reload')
  await tab.until(`Boolean(document.querySelector('[data-preview=workout]'))`)
  await press('Continua alla conferma')
  assert.equal(await tab.evaluate(`document.querySelector('.import-follow input').checked`),false)
  await tab.click('.import-follow input')
  const wReview=(await records()).find(r=>r.session.kind==='workout').session
  report.versions={reader:wReview.document.readerVersion,schema:wReview.proposal?.schemaVersion ?? '1.0'}
  await tab.click('.import-save')
  await tab.until(`document.querySelector('.import-saved')?.dataset.followed === 'true'`,'real workout commit')
  const ws=(await records()).find(r=>r.session.kind==='workout').session
  const resolved=ws.commit.command.payload.resolved
  const prescriptions=await api(`/rest/v1/workout_prescriptions?day_id=eq.${resolved.days[0].id}&select=*`,{token})
  assert.equal(prescriptions.length,1)
  assert.equal(prescriptions[0].rest_seconds,90); assert.equal(prescriptions[0].sets,3)
  assert.equal(prescriptions[0].reps_min,8); assert.equal(prescriptions[0].reps_max,10)
  await tab.evaluate(`location.hash='#/scheda'`);await tab.send('Page.reload')
  await tab.until(`Boolean(document.querySelector('.workout-summary .primary'))`)
  await tab.click('.workout-summary .primary')
  await tab.until(`Boolean(document.querySelector('.session-page'))`)
  let sessions=[]
  for(let i=0;i<80;i++){sessions=await api('/rest/v1/workout_sessions?select=*',{token});if(sessions.length)break;await pause(100)}
  assert.equal(sessions.length,1)
  const snapshot=sessions[0].day_snapshot
  assert.equal(snapshot.exercises[0].rest_seconds,90)
  assert.equal(snapshot.exercises[0].reps_min,8)
  assert.deepEqual(await api('/rest/v1/workout_set_logs?select=*',{token}),[])
  pass('DOCX workout -> Edge -> review/edit -> follow -> reload -> snapshot diario; nessun carico eseguito inventato')
  await choose('diet','diet.docx')
  // Import della scheda concluso e pagina ricaricata: alla riapertura dell'importazione il journal lo lascia e
  // i contenuti della sua analisi lasciano il server (23); la ricevuta resta.
  const firstJob=ws.commit.command.provenance.analysis.jobId
  let firstStatus
  for(let i=0;i<80;i++){firstStatus=(await api('/rest/v1/rpc/get_import_job',{token,method:'POST',body:{p_job_id:firstJob}}))?.status;if(firstStatus==='expired')break;await pause(100)}
  assert.equal(firstStatus,'expired','contenuti dell’import salvato scartati alla riapertura')
  assert.ok(!(await records()).some(r=>r.session.kind==='workout'),'import concluso fuori dal journal')
  assert.equal((await api(`/rest/v1/rpc/get_import_receipt`,{token,method:'POST',body:{p_request_id:ws.commit.command.requestId}}))?.resultState,'committed')
  await press('Qualsiasi giorno')
  await press('Quantità non indicata: confermo','.dr-food')
  // Global addition requires an explicit scope confirmation.
  for(let i=0;i<5;i++){
    const has=await tab.evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Ho controllato: confermo')`)
    if(!has)break; await press('Ho controllato: confermo')
  }
  await tab.until(`Boolean(document.querySelector('[data-preview=diet]'))`,'diet preview')
  await tab.until('Boolean(navigator.serviceWorker.controller)','PWA controlled')
  await tab.send('Network.emulateNetworkConditions',{offline:true,latency:0,downloadThroughput:-1,uploadThroughput:-1})
  await tab.send('Page.reload')
  await tab.until(`Boolean(document.querySelector('[data-preview=diet]'))`,'offline persisted review')
  await tab.send('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1})
  // Plans are cached after an offline boot; an online reload rereads the active revision before follow.
  await tab.send('Page.reload')
  await tab.until(`Boolean(document.querySelector('[data-preview=diet]'))`,'online review recovery')
  await press('Continua alla conferma')
  await tab.until(`document.querySelector('.import-follow input')?.disabled === false`, 'active selection reloaded online')
  await tab.click('.import-follow input')
  assert.equal(await tab.evaluate(`document.querySelector('.import-follow input').checked`),true)
  let lost=0
  tab.fetchHandlers.unshift(p=>{
    if(p.request.method==='POST' && p.responseStatusCode && p.request.url.endsWith('/rpc/commit_diet_import')) report.commitHttpStatus=p.responseStatusCode
    if(p.request.method==='POST' && p.responseStatusCode===200 && p.request.url.endsWith('/rpc/commit_diet_import') && lost===0){lost++;void tab.send('Fetch.failRequest',{requestId:p.requestId,errorReason:'ConnectionClosed'}).catch(()=>{});return true}
    return false
  })
  await tab.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'},{urlPattern:'*/rpc/commit_diet_import',requestStage:'Response'}]})
  await tab.click('.import-save')
  await tab.until(`document.querySelector('.import-saved')?.dataset.followed === 'true'`,'lost response reconciled',600)
  assert.equal(lost,1)
  const ds=(await records()).find(r=>r.session.kind==='diet').session
  const plan=ds.commit.command.payload.resolved.plan
  const [persisted]=await api(`/rest/v1/meal_plans?id=eq.${plan.id}&select=*`,{token})
  assert.deepEqual(persisted.document,plan.document)
  await tab.evaluate(`location.hash='#/dieta'`);await tab.send('Page.reload')
  await tab.until(`Boolean(document.querySelector('.meal-quick'))`)
  await tab.click('.meal-quick')
  let meals=[]
  for(let i=0;i<80;i++){meals=await api('/rest/v1/meal_logs?select=*',{token});if(meals.length)break;await pause(100)}
  assert.equal(meals.length,1)
  assert.ok(meals[0].meal_snapshot.alternatives.join(' ').includes('latte 200 ml'))
  assert.deepEqual((await api('/rest/v1/workout_sessions?select=day_snapshot',{token}))[0].day_snapshot,snapshot)
  pass('DOCX dieta -> quantità vuota/dayType/scopo -> offline reload -> risposta persa dopo commit -> receipt -> diario; storico workout intatto')
  for(const table of ['import_jobs','import_drafts','import_receipts','meal_plans','workout_plans'])
    assert.deepEqual(await api(`/rest/v1/${table}?select=owner_id`,{token:b.session.access_token}),[])
  const caches=await tab.evaluate(`(async()=>Promise.all((await caches.keys()).map(async k=>({name:k,urls:(await (await caches.open(k)).keys()).map(r=>r.url)}))))()`)
  assert.ok(caches.length>0)
  assert.ok(caches.flatMap(c=>c.urls).every(u=>new URL(u).origin===origin && !/rest\/v1|functions\/v1|auth\/v1|\.docx$|\.pdf$/.test(u)))
  assert.ok(caches.flatMap(c=>c.urls).some(u=>u.includes('docx-worker')))
  assert.ok(caches.flatMap(c=>c.urls).some(u=>u.includes('pdf-worker')))
  assert.deepEqual(violations,[])
  pass('RLS B su dati A; precache solo asset con worker DOCX/PDF; zero cloud/provider dal browser')
  await tab.screenshot(join(out,'diet-desktop.png'))
  // Same synthetic text through the real PDF worker, with a new catalog choice and explicit copy.
  await api(`/rest/v1/workout_sessions?id=eq.${sessions[0].id}`,{token,method:'PATCH',body:{status:'completed',revision:2}})
  await choose('workout','workout.pdf')
  await resolveWorkout(squat,'new')
  await press('Continua alla conferma')
  await tab.until(`document.querySelector('.import-follow input')?.disabled === false`)
  await tab.click('.import-follow input');await tab.click('.import-save')
  await tab.until(`Boolean(document.querySelector('.import-saved, .import-copy'))`)
  if(await tab.evaluate(`Boolean(document.querySelector('.import-copy'))`))await tab.click('.import-copy')
  await tab.until(`document.querySelector('.import-saved')?.dataset.followed === 'true'`)
  const pdfWorkout=(await records()).find(r=>r.session.file.name==='workout.pdf').session
  assert.equal(pdfWorkout.document.readerVersion,'peppitness.pdf-reader.v1')
  assert.equal(pdfWorkout.commit.command.payload.resolved.catalog[0].choice.source,'new')
  await tab.evaluate(`location.hash='#/scheda'`);await tab.send('Page.reload')
  await tab.until(`Boolean(document.querySelector('.workout-summary .primary'))`)
  await pause(1200)
  await tab.click('.workout-summary .primary');await tab.until(`Boolean(document.querySelector('.session-page'))`)
  let pdfSessions=[]
  for(let i=0;i<80;i++){pdfSessions=await api('/rest/v1/workout_sessions?select=*',{token});if(pdfSessions.length===2)break;await pause(100)}
  assert.equal(pdfSessions.length,2)
  assert.deepEqual(pdfSessions.find(s=>s.id===sessions[0].id).day_snapshot,snapshot)
  const pdfSnapshot=pdfSessions.find(s=>s.id!==sessions[0].id).day_snapshot.exercises[0]
  for(const field of ['sets','optional_sets','reps_min','reps_max','rest_seconds'])assert.equal(pdfSnapshot[field],snapshot.exercises[0][field])
  await choose('diet','diet.pdf')
  await press('Qualsiasi giorno');await press('Quantit\u00e0 non indicata: confermo','.dr-food')
  await tab.until(`Boolean(document.querySelector('[data-preview=diet]'))`)
  await press('Continua alla conferma');await tab.click('.import-follow input');await tab.click('.import-save')
  await tab.until(`Boolean(document.querySelector('.import-copy'))`,'explicit duplicate copy')
  await tab.click('.import-copy');await tab.until(`document.querySelector('.import-saved')?.dataset.followed === 'true'`)
  const pdfDiet=(await records()).find(r=>r.session.file.name==='diet.pdf').session
  assert.notEqual(pdfDiet.commit.command.requestId,ds.commit.command.requestId)
  await tab.evaluate(`location.hash='#/dieta'`);await tab.send('Page.reload')
  const pdfMealId=pdfDiet.commit.command.payload.resolved.plan.document.days[0].meals[0].id
  await tab.until(`Boolean(document.querySelector('a[href="#/dieta/pasto/${pdfMealId}"]'))`,'new imported meal loaded')
  await tab.click('.meal-quick')
  let pdfMeals=[]
  for(let i=0;i<80;i++){pdfMeals=await api('/rest/v1/meal_logs?select=*',{token});if(pdfMeals.length===2)break;await pause(100)}
  assert.equal(pdfMeals.length,2)
  assert.deepEqual(pdfMeals.find(m=>m.id===meals[0].id).meal_snapshot,meals[0].meal_snapshot)
  assert.deepEqual(pdfMeals.find(m=>m.id!==meals[0].id).meal_snapshot.alternatives,meals[0].meal_snapshot.alternatives)
  pass('PDF entrambi i domini -> review -> commit -> reload -> diario; new atomico e copia esplicita; snapshot precedenti intatti')
  await choose('workout','workout.docx')
  await resolveWorkout(sharedId,'shared')
  assert.equal((await api(`/rest/v1/exercises?source_template_id=eq.${sharedId}&select=id`,{token})).length,0,'no adoption during review')
  await press('Continua alla conferma')
  await tab.evaluate(`document.querySelector('.import-save').click();document.querySelector('.import-save')?.click()`)
  await tab.until(`Boolean(document.querySelector('.import-saved, .import-copy'))`)
  if(await tab.evaluate(`Boolean(document.querySelector('.import-copy'))`))await tab.click('.import-copy')
  await tab.until(`Boolean(document.querySelector('.import-saved'))`)
  assert.equal((await api(`/rest/v1/exercises?source_template_id=eq.${sharedId}&select=id`,{token})).length,1)
  pass('Scelta shared in review senza scritture; doppio clic; adozione singola nella RPC atomica')
  // A real 413 from the Edge budget, followed by explicit section selection in the UI.
  const segmentedFile = count => buildDocx({body:para('Scheda sezioni sintetica') + Array.from({length:count},(_,i)=>
    para(`Seduta ${String.fromCharCode(65+i)}`,{style:'Titolo1'}) + tbl(2,[tr([tc('Esercizio'),tc('Serie')]),tr([tc(`Squat ${i}`),tc('3 x 10')])])).join('')})
  const two = (await readDocx({bytes:segmentedFile(2),metadata:{format:'docx',mediaType:null},signal:new AbortController().signal})).document
  const providerConfig = readProviderConfig(Object.fromEntries(env.split(/\r?\n/).filter(l=>l.includes('=')).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)])))
  assert.equal(providerConfig.enabled,true)
  const provider = createOpenAIProvider(providerConfig.config)
  const measured = Buffer.byteLength(provider.prepare({kind:'workout',document:two,schemaId:'peppitness.workout-extraction.v1',promptVersion:IMPORT_PROMPT_VERSION,profile:'standard',signal:new AbortController().signal}).serializedRequest)+256
  await importLocalSql(`update peppitness_private.import_budget_config set max_input_tokens=${measured-200} where config_version=${lit(marker)} returning singleton`)
  await writeFile(join(out,'sections.docx'),segmentedFile(3))
  await tab.evaluate(`location.hash='#/scheda/importa'`)
  await tab.until(`Boolean(document.querySelector('.import-change input, .import-drop input'))`)
  await tab.setFiles('.import-change input, .import-drop input',[join(out,'sections.docx')])
  await tab.until(`${text('.import-file-name')} === 'sections.docx' && ${text('.import-summary h2')} === 'Documento letto'`)
  await tab.click('.import-analyze')
  await tab.until(`Boolean(document.querySelector('.import-parts'))`,'real 413 section chooser')
  await tab.click('.import-parts li:nth-child(2) input');await tab.click('.import-narrow')
  await tab.until(`${text('.import-summary h2')} === 'Documento letto in parte'`)
  await tab.click('.import-analyze')
  await tab.until(`Boolean(document.querySelector('[data-review=workout]'))`)
  assert.ok(await tab.evaluate(`${text('[data-review=workout]')}.includes('excluded_by_user')`),'excluded sections disclosed')
  pass('413 reale -> selezione esplicita di sezioni -> analisi della sola parte scelta con esclusioni visibili')
  await importLocalSql(`update peppitness_private.import_budget_config set max_input_tokens=200000 where config_version=${lit(marker)} returning singleton`)
  // Actual SDK account switch clears A's review; B has no import from A.
  await tab.evaluate(`localStorage.setItem(${JSON.stringify(storageKey)},${JSON.stringify(JSON.stringify(b.session))}); location.hash='#/scheda/importa'`)
  await tab.send('Page.reload')
  await tab.until(`Boolean(document.querySelector('.import-drop input'))`,'B has no review from A')
  assert.ok((await records()).every(r=>r.ownerId!==a.id))
  pass('Cambio account reale A -> B: journal e revisione di A rimossi')
  report.result='PASS'
}
try { await run() } catch(error) {
  report.failure=error.message
  console.error(`FAIL ${error.stack}`);process.exitCode=1
  if(tab){ await writeFile(join(out,'failure.txt'),await tab.evaluate('document.body.innerText').catch(()=>''));await tab.screenshot(join(out,'failure.png')).catch(()=>{}) }
} finally {
  await tab?.send('Storage.clearDataForOrigin',{origin,storageTypes:'all'}).catch(()=>{})
  await tab?.close();await server?.stop();await chrome?.stop()
  if(original && config){
    try{
      await importLocalSql(`do $c$ begin
        perform 1 from peppitness_private.import_budget_config where singleton for update;
        delete from public.import_jobs where owner_id in (${users.length?users.map(lit).join(','):"'00000000-0000-4000-8000-000000000000'"});
        if exists(select 1 from peppitness_private.import_budget_config where config_version=${lit(marker)}) then
          if exists(select 1 from peppitness_private.import_usage_ledger) then raise exception 'Unexpected ledger'; end if;
          delete from peppitness_private.import_budget_retired;
          delete from peppitness_private.import_budget_config;
          insert into peppitness_private.import_budget_config select * from jsonb_populate_record(null::peppitness_private.import_budget_config,${lit(JSON.stringify(original))}::jsonb);
        end if;
      end $c$`)
      assert.deepEqual((await importLocalSql('select to_jsonb(c) as config from peppitness_private.import_budget_config c where singleton'))[0].config,original)
      for(const id of users)await api(`/auth/v1/admin/users/${id}`,{admin:true,method:'DELETE'})
      await importLocalSql(`delete from public.shared_exercises where id=${lit(sharedId)} returning id`)
      report.cleanup='PASS'
    }catch(e){report.cleanup='FAIL';report.result='FAIL';console.error(e.message);process.exitCode=1}
  }
  await mkdir(out,{recursive:true});await writeFile(join(out,'report.json'),JSON.stringify(report,null,2)+'\n')
  console.log(`E2E ${report.result}; iPhone NOT_RUN; cleanup ${report.cleanup ?? 'not needed'}`)
}



