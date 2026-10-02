// Browser/SDK/Auth/RPC/PostgreSQL reali, esclusivamente loopback. Nessun Edge o provider.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { readLocalStatus } from './lib/local-supabase.mjs'
import { ensureChrome, openTab, pause, root, serveStatic } from './lib/import-browser-harness.mjs'
import { commitRpcArgs, validateImportReceipt } from '../src/import/contracts/commit.ts'
import { commandHash, contentHash } from '../src/import/mapping/canonical.ts'
const config = readLocalStatus() // Fail closed: rifiuta URL cloud prima di qualunque scrittura.
const out = join(root, 'artifacts/import-structured-local'), origin = 'http://127.0.0.1:4183'
const users = [], checks = [], pass = label => { checks.push(label); console.log(`PASS ${label}`) }
let server, chrome, tab
async function request(path, { token, admin = false, method = 'GET', body, allowed = [200, 201, 204] } = {}) {
  const key = admin ? config.adminKey : config.publicKey
  const response = await fetch(config.apiUrl + path, { method, signal: AbortSignal.timeout(20000), redirect: 'error', headers: { apikey: key, ...(token || admin ? { Authorization: `Bearer ${token ?? key}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const data = await response.json().catch(() => null)
  assert.ok(allowed.includes(response.status), `${method} ${path.split('?')[0]}: HTTP ${response.status} ${data?.code ?? ''}`)
  return data
}
async function actor() {
  const email = `structured-${randomUUID()}@example.invalid`, password = `Aa1!${randomUUID()}`
  const user = await request('/auth/v1/admin/users', { admin: true, method: 'POST', body: { email, password, email_confirm: true } })
  users.push(user.id ?? user.user.id)
  return request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } })
}
const records = () => tab.evaluate(`new Promise((resolve,reject)=>{const r=indexedDB.open('peppitness-structured-import-v1');r.onsuccess=()=>{const db=r.result;const q=db.transaction('drafts').objectStore('drafts').getAll();q.onsuccess=()=>{db.close();resolve(q.result)};q.onerror=()=>reject(q.error)}})`)
const rpc = (name, body, token, allowed) => request(`/rest/v1/rpc/${name}`, { method: 'POST', body, token, allowed })
try {
  await mkdir(out, { recursive: true })
  const build = spawnSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.pwa.config.mjs', '--outDir', join(out, 'dist')], { cwd: root, env: { ...process.env, VITE_SUPABASE_URL: config.apiUrl, VITE_SUPABASE_PUBLISHABLE_KEY: config.publishableKey }, encoding: 'utf8', windowsHide: true, timeout: 120000 })
  await writeFile(join(out, 'build.log'), build.stdout + build.stderr); assert.equal(build.status, 0, 'build PWA locale')
  const headers = await readFile(join(out, 'dist/_headers'), 'utf8')
  server = await serveStatic({ dist: join(out, 'dist'), port: 4183, csp: /Content-Security-Policy:\s*(.+)/.exec(headers)[1] })
  const a = await actor(), b = await actor(), token = a.access_token
  chrome = await ensureChrome(); tab = await openTab()
  await tab.send('Storage.clearDataForOrigin', { origin, storageTypes: 'all' })
  const violations = []
  let lost = 0
  tab.fetchHandlers.push(p => {
    const url = new URL(p.request.url)
    if (p.responseStatusCode && url.pathname.endsWith('/rpc/commit_diet_import') && p.responseStatusCode === 200 && !lost) {
      lost++; void tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionClosed' }).catch(() => {}); return true
    }
    if (['http:', 'https:'].includes(url.protocol) && (![origin, config.apiUrl].includes(url.origin) || url.pathname.includes('/functions/v1/'))) {
      violations.push(url.origin + url.pathname); void tab.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {}); return true
    }
    void tab.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {}); return true
  })
  await tab.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }, { urlPattern: '*/rpc/commit_diet_import', requestStage: 'Response' }] })
  await tab.navigate(origin, 'document.readyState === "complete"')
  await tab.evaluate(`localStorage.setItem('sb-127-auth-token',${JSON.stringify(JSON.stringify(a))});location.hash='#/scheda/importa';location.reload()`)
  for (const kind of ['workout', 'diet']) {
    await tab.evaluate(`location.hash=${JSON.stringify(kind === 'workout' ? '#/scheda/importa' : '#/dieta/importa')}`)
    await tab.until(`Boolean(document.querySelector('.si-file input:not(:disabled)'))`)
    await tab.setFiles('.si-file input[type=file]', [join(root, `public/templates/peppitness-${kind}-v1.docx`)])
    await tab.until(`Boolean(document.querySelector('.si-confirm:not(:disabled)'))`)
    assert.equal((await request('/rest/v1/exercises?select=id', { token })).length, kind === 'workout' ? 0 : 2)
    assert.equal((await request(`/rest/v1/${kind === 'workout' ? 'workout_plans' : 'meal_plans'}?select=id`, { token })).length, 0)
    const first = (await records()).find(r => r.kind === kind)
    await tab.send('Page.reload'); await tab.until(`Boolean(document.querySelector('.si-confirm:not(:disabled)'))`)
    assert.equal((await records()).find(r => r.kind === kind).draft.proposalId, first.draft.proposalId)
    assert.equal(await tab.evaluate(`document.querySelectorAll('.si-preview [role=alert]').length`), 0)
    await tab.until(`Boolean(document.querySelector('.si-follow input:not(:disabled)'))`)
    await tab.click('.si-follow input'); await tab.click('.si-confirm')
    await tab.evaluate(`document.querySelector('.si-save').click();document.querySelector('.si-save')?.click()`)
    if (kind === 'diet') {
      await tab.until(`Boolean(document.querySelector('.si-pending button:not(:disabled)'))`)
      await tab.send('Page.reload')
    }
    await tab.until(`Boolean(document.querySelector('.si-saved'))`, `${kind} commit`, 600)
    const saved = (await records()).find(r => r.kind === kind), command = saved.command
    assert.equal(command.selectionOptions.follow, true)
    assert.ok(validateImportReceipt(saved.receipt).ok)
    assert.equal(saved.receipt.commandHash, await commandHash(command)); assert.equal(saved.receipt.contentHash, await contentHash(command.payload))
    assert.equal(command.provenance.analysis.jobId, null)
    const replay = await rpc(`commit_${kind}_import`, commitRpcArgs(command), token)
    assert.deepEqual(replay, saved.receipt)
    assert.equal(await rpc('get_import_receipt', { p_request_id: command.requestId }, b.access_token), null)
    await rpc(`commit_${kind}_import`, commitRpcArgs(command), undefined, [401, 403])
    await rpc(`commit_${kind}_import`, commitRpcArgs(command), b.access_token, [403, 409])
    if (kind === 'workout') {
      const exercise = (await request('/rest/v1/exercises?select=*', { token }))
      assert.equal(exercise.length, 2)
      const prescriptions = await request('/rest/v1/workout_prescriptions?select=sets,optional_sets,rest_seconds,note,reps_min,reps_max,duration_seconds&order=position', { token })
      assert.equal(prescriptions.length, 3)
      assert.ok(prescriptions.every(p => p.optional_sets === 0))
    } else {
      const [plan] = await request('/rest/v1/meal_plans?select=*', { token })
      assert.deepEqual(plan.document, command.payload.resolved.plan.document)
    }
    await tab.evaluate(`location.hash=${JSON.stringify(kind === 'workout' ? '#/scheda' : '#/dieta')}`)
    if (kind === 'workout') {
      await tab.until(`Boolean(document.querySelector('.workout-summary .primary'))`); await tab.click('.workout-summary .primary'); await tab.until(`Boolean(document.querySelector('.session-page'))`)
      let sessions = []
      for (let i = 0; i < 80; i++) { sessions = await request('/rest/v1/workout_sessions?select=day_snapshot', { token }); if (sessions.length) break; await pause(100) }
      const [session] = sessions
      assert.ok(session, 'seduta sincronizzata nel database')
      assert.equal(session.day_snapshot.exercises.length, 2)
      assert.equal(session.day_snapshot.exercises[0].sets, 2); assert.equal(session.day_snapshot.exercises[0].optional_sets, 0)
      assert.equal(session.day_snapshot.exercises[0].rest_seconds, 90)
    } else {
      await tab.until(`Boolean(document.querySelector('.meal-quick'))`); await tab.click('.meal-quick')
      let logs = []
      for (let i = 0; i < 80; i++) { logs = await request('/rest/v1/meal_logs?select=meal_snapshot', { token }); if (logs.length) break; await pause(100) }
      assert.equal(logs.length, 1); assert.equal(logs[0].meal_snapshot.items.length, 2); assert.equal(logs[0].meal_snapshot.alternatives.length, 1)
    }
    pass(`${kind}: browser reale DOCX → bozza/reload → una conferma → RPC atomica → replay → registrazione diario`)
  }
  assert.equal(lost, 1)
  for (const table of ['workout_plans', 'meal_plans', 'exercises', 'import_receipts']) assert.deepEqual(await request(`/rest/v1/${table}?select=*`, { token: b.access_token }), [])
  for (const [table, column] of [['import_jobs','id'], ['import_drafts','job_id']]) assert.deepEqual(await request(`/rest/v1/${table}?select=${column}`, { token }), [])
  assert.deepEqual(violations, [])
  assert.ok(!tab.requests.some(url => url.includes('/functions/v1/')))
  const errors = tab.errors.filter(e => !e.includes('ERR_CONNECTION_CLOSED'))
  assert.deepEqual(errors, [])
  pass('zero job, zero Edge/LLM, RLS A/B/anonimo e commit altrui respinto, risposta persa, doppio clic e replay senza duplicati')
  await writeFile(join(out, 'report.json'), JSON.stringify({ result: 'PASS', mode: 'real-local-browser-auth-postgres-no-provider', checks, providerRequests: 0, cloud: 'NOT_RUN' }, null, 2))
} catch (error) {
  if (tab) { await tab.screenshot(join(out, 'failure.png')).catch(() => {}); await writeFile(join(out, 'failure.txt'), await tab.evaluate('document.body.innerText').catch(() => '')).catch(() => {}) }
  throw error
} finally {
  await tab?.close(); await chrome?.stop(); await server?.stop()
  for (const id of users) await request(`/auth/v1/admin/users/${id}`, { admin: true, method: 'DELETE' })
  if (users.length) console.log(`Cleanup: ${users.length} account sintetici locali rimossi.`)
}
