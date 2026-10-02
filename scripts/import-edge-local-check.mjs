// Prova reale della Edge Function extract-plan sul solo stack locale (task 17).
// Uso: `node scripts/import-edge-local-check.mjs --write-env` (una volta, crea supabase/functions/.env
// sintetico e ignorato), poi in un terminale dedicato `npx.cmd supabase functions serve extract-plan`,
// infine da un altro terminale `node scripts/import-edge-local-check.mjs [--summary]`.
// Stesse protezioni del runner HTTP: solo http://127.0.0.1:<porta locale>, chiavi dalla CLI in memoria,
// nessun log di token, documenti o risposte. Il provider è il trasporto sintetico lato server: nessuna rete.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { projectRoot, publicErrorCode, readLocalStatus, localWorkdir } from './lib/local-supabase.mjs'
import { importLocalSql, sqlLiteral as lit } from './lib/import-local-db.mjs'
import { validateImportJobResult } from '../src/import/contracts/jobs.ts'
import { createOpenAIProvider } from '../supabase/functions/_shared/import/openai-provider.ts'
import { readProviderConfig } from '../supabase/functions/_shared/import/provider.ts'
import { IMPORT_PROMPT_VERSION } from '../supabase/functions/_shared/import/prompts.ts'
import { syntheticMarkers } from '../supabase/functions/_shared/import/synthetic-transport.ts'

const envPath = new URL('../supabase/functions/.env', import.meta.url)
const MODEL = 'synthetic-edge-2026-01-01'
const ORIGIN = 'http://127.0.0.1:4173'
const SECRET_MARK = 'Contenuto riservato sintetico'
const syntheticEnv = {
  IMPORT_PROVIDER: 'openai', IMPORT_MODEL: MODEL, IMPORT_PROMPT_VERSION,
  IMPORT_MAX_OUTPUT_TOKENS: '4000', IMPORT_RETRY_MAX_OUTPUT_TOKENS: '6000', IMPORT_PROVIDER_TIMEOUT_MS: '3000',
  IMPORT_ANALYSIS_DEADLINE_MS: '30000', IMPORT_MAX_RETRY_WAIT_SECONDS: '5', IMPORT_ALLOWED_ORIGINS: `${ORIGIN},http://127.0.0.1:5173`,
  IMPORT_TEST_TRANSPORT: 'synthetic', OPENAI_API_KEY: 'sk-synthetic-local-edge-not-a-real-key',
}

function readEnvFile() {
  if (!existsSync(envPath)) return null
  return Object.fromEntries(readFileSync(envPath, 'utf8').split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]))
}
if (process.argv.includes('--write-env')) {
  const current = readEnvFile()
  if (current && current.IMPORT_TEST_TRANSPORT !== 'synthetic') {
    console.error('FAIL supabase/functions/.env esiste e non è sintetico: non viene sovrascritto.')
    process.exit(1)
  }
  writeFileSync(envPath, `# Secrets SINTETICI per la prova locale di extract-plan (ignorato da git). Nessuna chiave reale.\n${Object.entries(syntheticEnv).map(([key, value]) => `${key}=${value}`).join('\n')}\n`)
  console.log('Scritto supabase/functions/.env sintetico. Avviare ora: npx.cmd supabase functions serve extract-plan')
  process.exit(0)
}

let checks = 0
const summaryOnly = process.argv.includes('--summary')
const cleanupIds = new Set()
let config
const results = { dockerLogs: 'non eseguito' }
function check(condition, label) {
  if (!condition) throw new Error(label)
  checks++
  if (!summaryOnly) console.log(`PASS ${label}`)
}
const phase = text => { if (summaryOnly) console.log(`IN CORSO ${text}`) }

async function http(path, { method = 'GET', body, token, apikey, headers = {}, raw = false, admin = false } = {}) {
  if (typeof body === 'string') raw = true
  const key = apikey ?? (admin ? config.adminKey : config.publicKey)
  const all = { apikey: key, ...headers }
  if (body !== undefined && !raw) all['Content-Type'] = 'application/json'
  if (token) all.Authorization = `Bearer ${token}`
  else if (admin && key.startsWith('eyJ')) all.Authorization = `Bearer ${key}`
  let response
  let text
  const started = Date.now()
  try {
    response = await fetch(`${config.apiUrl}${path}`, {
      method, headers: all, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60_000),
    })
    text = await response.text()
  } catch {
    throw new Error(`Richiesta locale ${method} ${path.split('?')[0]} fallita dopo ${Date.now() - started} ms.`)
  }
  let data = null
  if (text) { try { data = JSON.parse(text) } catch { data = null } }
  return { status: response.status, ok: response.ok, data, text, headers: response.headers, ms: Date.now() - started }
}
const fn = (body, token, headers = {}) => http('/functions/v1/extract-plan', { method: 'POST', body, token, headers })
const rpc = (name, body, token) => http(`/rest/v1/rpc/${name}`, { method: 'POST', body, token })
const errorCode = result => result.data?.error === null ? 'ok' : result.data?.error?.code ?? publicErrorCode(result.data)

function jobOf(result, label) {
  check([200, 202].includes(result.status) && validateImportJobResult(result.data).ok, `${label} (HTTP ${result.status}, ${errorCode(result)})`)
  return result.data
}

async function createUser(label) {
  const email = `peppitness-edge-${label}-${randomUUID()}@peppitness.local`
  const password = `Aa1!${randomBytes(24).toString('base64url')}`
  const created = await http('/auth/v1/admin/users', { method: 'POST', admin: true, body: { email, password, email_confirm: true, app_metadata: { peppitness_test: true } } })
  const user = created.data?.user ?? created.data
  if (typeof user?.id === 'string') cleanupIds.add(user.id)
  check(created.ok && typeof user?.id === 'string', `Account locale ${label}`)
  const session = await http('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } })
  check(session.ok && session.data?.user?.id === user.id, `Sessione ${label}`)
  return { id: user.id, token: session.data.access_token }
}

/** Solo il segreto JWT locale per firmare token scaduti/falsi; mai stampato. */
function localJwtSecret() {
  const workdir = localWorkdir()
  const windows = process.platform === 'win32'
  const command = `node_modules\\.bin\\supabase.cmd status -o json${workdir ? ` --workdir ${workdir}` : ''}`
  const result = spawnSync(windows ? (process.env.ComSpec ?? 'cmd.exe') : './node_modules/.bin/supabase',
    windows ? ['/d', '/s', '/c', command] : ['status', '-o', 'json', ...(workdir ? ['--workdir', workdir] : [])],
    { cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' } })
  try { const secret = JSON.parse(result.stdout).JWT_SECRET; return typeof secret === 'string' && secret.length >= 32 ? secret : null } catch { return null }
}
function hs256(payload, secret) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}`
  return `${unsigned}.${createHmac('sha256', secret).update(unsigned).digest('base64url')}`
}

// Documenti sintetici: titolo, preambolo, sezioni «Seduta X» con tabella; testo canonico.
function document(tag, sections = 1, { marker = '', filler = '' } = {}) {
  const b = (id, kind, text, extra = {}) => ({ id, kind, text, page: null, tableId: null, row: null, column: null, rowSpan: null, columnSpan: null, parentId: null, headingIds: [], origin: 'native', bbox: null, ...extra })
  const blocks = [b('p:0', 'paragraph', `Scheda edge ${tag}`), b('p:1', 'paragraph', `${SECRET_MARK} ${tag}${marker ? ` ${marker}` : ''}`)]
  for (let s = 0; s < sections; s++) {
    const heading = `h:${s}`
    blocks.push(b(heading, 'heading', `Seduta ${String.fromCharCode(65 + s)}`))
    for (let r = 0; r <= 2; r++) {
      const row = `t:${s}:r:${r}`
      const cells = r === 0 ? ['Esercizio', 'Serie'] : [`Esercizio ${s}-${r}${filler}`, '3 x 10']
      blocks.push(b(row, 'table_row', cells.join(' | '), { tableId: `t:${s}`, row: r, headingIds: [heading] }))
      cells.forEach((text, c) => blocks.push(b(`${row}:c:${c}`, 'table_cell', text, { tableId: `t:${s}`, row: r, column: c, parentId: row, headingIds: [heading] })))
    }
  }
  return { readerVersion: 'synthetic-fixture/1', sourceHash: randomBytes(32).toString('hex'), blocks, readingIssues: [] }
}
const body = (doc, id = randomUUID(), kind = 'workout') => ({ analysisRequestId: id, kind, normalizedDocument: doc, expectedSchemaVersion: '1.0' })
const fixtureDoc = name => JSON.parse(readFileSync(new URL(`../tests/fixtures/import/documents/${name}.json`, import.meta.url), 'utf8'))

async function ledger(jobId) {
  const rows = await importLocalSql(`select state, attempt, input_tokens, output_tokens from peppitness_private.import_usage_ledger where job_id = ${lit(jobId)}::uuid order by attempt nulls last`)
  return rows
}

async function run() {
  config = readLocalStatus()
  const envFile = readEnvFile()
  // Fail closed prima di inviare documenti: la funzione deve usare il trasporto sintetico.
  if (!envFile || envFile.IMPORT_TEST_TRANSPORT !== 'synthetic' || !envFile.OPENAI_API_KEY?.startsWith('sk-synthetic') || envFile.IMPORT_MODEL !== MODEL) {
    throw new Error('supabase/functions/.env sintetico assente: eseguire prima `node scripts/import-edge-local-check.mjs --write-env` e riavviare functions serve.')
  }
  console.log(`Prova Edge extract-plan sul solo Supabase locale (${config.apiUrl.replace('http://', '')}).`)

  const a = await createUser('a')
  const b = await createUser('b')
  const c = await createUser('c')

  phase('boot della funzione e CORS')
  // Il preflight OPTIONS è servito dal gateway Kong locale (Access-Control-Allow-Origin: *) senza
  // raggiungere la funzione: l'origine si verifica sulle POST reali, che il handler controlla.
  let boot
  for (let i = 0; i < 30; i++) {
    boot = await fn('{', a.token)
    if (boot.status === 400) break
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  check(boot.status === 400 && errorCode(boot) === 'invalid_request', `Edge avviata: moduli Deno e contratti condivisi caricati, JSON non valido respinto dal handler (HTTP ${boot.status})`)
  const foreign = await fn(body(document('origin')), a.token, { Origin: 'https://evil.example' })
  check(foreign.status === 403 && errorCode(foreign) === 'invalid_request' && foreign.headers.get('access-control-allow-origin') !== 'https://evil.example', 'POST da origine non configurata respinta dal handler')
  const allowedOrigin = await fn('{', a.token, { Origin: ORIGIN })
  // Il Kong locale riscrive Access-Control-Allow-Origin in `*`: il valore esatto è provato nei test Node.
  check(allowedOrigin.status === 400 && errorCode(allowedOrigin) === 'invalid_request', 'POST dall’origine configurata accettata dal handler (403 solo per origini non configurate)')

  const original = (await importLocalSql('select to_jsonb(cfg) as config from peppitness_private.import_budget_config cfg where singleton'))[0]?.config
  check(original && original.enabled === false && original.provider === null, 'Budget locale disabilitato e senza provider reale prima della prova')
  const marker = `edge-check/${randomUUID()}`
  const baseline = lit(JSON.stringify(original))
  const owners = [a.id, b.id, c.id].map(lit).join(',')
  try {
    phase('kill switch senza budget')
    const disabled = await fn(body(document('disabled')), a.token)
    check(disabled.status === 503 && errorCode(disabled) === 'provider_unavailable', 'Budget disabilitato: HTTP 503, nessuna analisi')
    await importLocalSql(`do $fixture$ begin
      perform 1 from peppitness_private.import_budget_config where singleton for update;
      if not exists(select 1 from peppitness_private.import_budget_config c where to_jsonb(c)=${baseline}::jsonb)
        or exists(select 1 from peppitness_private.import_usage_ledger) or exists(select 1 from peppitness_private.import_budget_retired) then
        raise exception 'Edge fixture requires pristine disabled local configuration';
      end if;
      update peppitness_private.import_budget_config set enabled=true,config_version=${lit(marker)},price_version='synthetic/1',
        provider='openai',model=${lit(MODEL)},currency='USD',project_limit_micros=1000000000000,account_limit_micros=1000000000000,
        input_micros_per_million=1000000,output_micros_per_million=1000000,max_active_per_account=1,daily_analyses=100,
        max_attempts=2,max_input_tokens=200000,max_output_tokens=16000,framing_tokens=256 where singleton;
    end $fixture$`)
    const zeroJobs = await importLocalSql(`select count(*)::int as n from public.import_jobs where owner_id in (${owners})`)
    check(zeroJobs[0].n === 0, 'Nessun job creato dalla richiesta respinta')

    phase('identità, metodi e corpo')
    const valid = body(document('auth'))
    const noAuth = await http('/functions/v1/extract-plan', { method: 'POST', body: valid })
    check(noAuth.status === 401, `Senza JWT utente: 401 (HTTP ${noAuth.status})`)
    check((await fn(valid, 'not-a-jwt')).status === 401, 'JWT malformato: 401')
    const now = Math.floor(Date.now() / 1000)
    const claims = { sub: a.id, role: 'authenticated', aud: 'authenticated', iss: `${config.apiUrl}/auth/v1`, iat: now - 7200 }
    check((await fn(valid, hs256({ ...claims, exp: now + 3600 }, randomBytes(32).toString('hex')))).status === 401, 'JWT firmato con segreto falso: 401')
    const secret = localJwtSecret()
    if (secret) {
      check((await fn(valid, hs256({ ...claims, exp: now - 60 }, secret))).status === 401, 'JWT scaduto: 401')
      const forgedSession = await fn(valid, hs256({ ...claims, exp: now + 3600, session_id: randomUUID() }, secret))
      check(forgedSession.status === 401 && errorCode(forgedSession) === 'unauthenticated', 'JWT firmato ma senza sessione Auth reale: respinto dal handler (verifica server)')
    } else console.log('NON ESEGUITO JWT scaduto: segreto locale non disponibile dalla CLI.')
    const anonKey = await fn(valid, config.publicKey.startsWith('eyJ') ? config.publicKey : undefined, config.publicKey.startsWith('eyJ') ? {} : { Authorization: `Bearer ${config.publicKey}` })
    check(anonKey.status === 401, `Chiave pubblica come Bearer: 401 (HTTP ${anonKey.status})`)
    const get = await http('/functions/v1/extract-plan', { token: a.token })
    check(get.status === 405, 'GET: 405')
    const spoof = await fn({ ...body(document('spoof')), ownerId: b.id }, a.token)
    check(spoof.status === 400 && errorCode(spoof) === 'invalid_request', 'owner dichiarato nel corpo respinto')
    const version = await fn({ ...body(document('version')), expectedSchemaVersion: '2.0' }, a.token)
    check(version.status === 400 && errorCode(version) === 'unsupported_schema_version', 'Versione schema sconosciuta: 400')
    // Il server rifiuta dal Content-Length senza leggere il corpo: a seconda dei tempi il gateway locale chiude la
    // connessione mentre il client sta ancora inviando (502). Il rifiuto è senza effetti, quindi si ripete: serve un 413.
    let oversized, tries = 0
    do { tries++; oversized = await http('/functions/v1/extract-plan', { method: 'POST', raw: true, body: `{"pad":"${'x'.repeat(8 * 1024 * 1024)}"}`, token: a.token, headers: { 'Content-Type': 'application/json' } }) }
    while (oversized.status === 502 && tries < 3)
    check(oversized.status === 413 && oversized.data?.error?.limit?.limit === 'requestBodyBytes', `Corpo oltre 8 MiB: 413 (HTTP ${oversized.status}, tentativi ${tries})`)

    phase('analisi, persistenza, replay, cache e isolamento')
    const first = body(fixtureDoc('workout-spec-example'))
    const ready = jobOf(await fn(first, a.token, { Origin: ORIGIN }), 'A: analisi scheda')
    check(ready.status === 'ready' && ready.extraction.kind === 'workout' && ready.usageSummary.providerCalls === 1 && Array.isArray(ready.validationIssues), 'A: ready con estrazione validata e problemi')
    check(ready.usageSummary.inputTokens > 0 && ready.usageSummary.costEstimate?.currency === 'USD', 'A: usage riconciliato dal ledger')
    const stored = await rpc('get_import_job', { p_job_id: ready.jobId }, a.token)
    check(stored.ok && JSON.stringify(stored.data.extraction) === JSON.stringify(ready.extraction) && stored.data.status === 'ready'
      && JSON.stringify(stored.data.validationIssues) === JSON.stringify(ready.validationIssues), 'A: risultato persistito identico alla risposta (lookup get_import_job)')
    check((await rpc('get_import_job', { p_job_id: ready.jobId }, b.token)).data === null, 'B non recupera il job di A')
    check(!(await rpc('get_import_job', { p_job_id: ready.jobId })).ok, 'Lookup anonimo respinto')
    const firstLedger = await ledger(ready.jobId)
    check(firstLedger.length === 1 && firstLedger[0].state === 'settled', 'Ledger: una chiamata riconciliata')
    const replay = jobOf(await fn(first, a.token), 'A: replay')
    check(replay.jobId === ready.jobId && (await ledger(ready.jobId)).length === 1, 'Replay stesso input: stesso job, nessuna chiamata')
    const changed = structuredClone(first); changed.normalizedDocument.blocks[0].text = 'Titolo cambiato'
    const conflict = await fn(changed, a.token)
    check(conflict.status === 409 && errorCode(conflict) === 'request_conflict', 'Stessa chiave, input diverso: 409')
    const cached = jobOf(await fn(body(first.normalizedDocument), a.token), 'A: cache')
    check(cached.usageSummary.cached === true && cached.usageSummary.providerCalls === 0 && (await ledger(cached.jobId)).length === 0, 'Cache privata: nessuna chiamata')
    const other = jobOf(await fn(body(first.normalizedDocument), b.token), 'B: stesso documento')
    check(other.usageSummary.cached === false && (await ledger(other.jobId)).length === 1, 'B non riusa la cache di A')
    check((await rpc('get_import_job', { p_job_id: other.jobId }, a.token)).data === null, 'A non recupera il job di B')
    const sameKey = jobOf(await fn(first, b.token), 'B: stessa chiave di A')
    check(sameKey.jobId !== ready.jobId, 'Chiave uguale su account diversi: job distinti')

    const racedBody = body(document('race'))
    const raced = await Promise.all([fn(racedBody, a.token), fn(racedBody, a.token)])
    const racedJobs = raced.map(result => jobOf(result, 'A: POST concorrente'))
    check(racedJobs[0].jobId === racedJobs[1].jobId && (await ledger(racedJobs[0].jobId)).length === 1, 'Due POST concorrenti: un job, una chiamata')

    phase('terminazioni del provider e tentativi')
    const refused = jobOf(await fn(body(document('refuse', 1, { marker: syntheticMarkers.refuse })), a.token), 'Rifiuto')
    check(refused.status === 'failed' && refused.error.code === 'provider_refused' && refused.extraction === null, 'Rifiuto: failed senza bozza')
    const incomplete = jobOf(await fn(body(document('incomplete', 1, { marker: syntheticMarkers.incomplete })), a.token), 'Incompleto')
    check(incomplete.status === 'failed' && incomplete.error.code === 'provider_incomplete' && (await ledger(incomplete.jobId)).length === 2, 'Incompleto: secondo tentativo con profilo retry, poi failed; 2 chiamate')
    const limited = await fn(body(document('429', 1, { marker: syntheticMarkers.rateLimitedOnce })), a.token)
    const limitedJob = jobOf(limited, '429 una volta')
    check(limitedJob.status === 'ready' && limitedJob.usageSummary.providerCalls === 2 && limited.ms >= 1000, 'HTTP 429: Retry-After rispettato, secondo tentativo riuscito')
    const invalid = jobOf(await fn(body(document('invalid', 1, { marker: syntheticMarkers.invalidOnce })), a.token), 'Output non valido una volta')
    check(invalid.status === 'ready' && invalid.usageSummary.providerCalls === 2, 'Output non valido: ritentato entro il limite')
    const wrong = jobOf(await fn(body(document('wrong', 1, { marker: syntheticMarkers.wrongDomain })), a.token), 'Dominio sbagliato')
    check(wrong.status === 'ready' && wrong.extraction.outcome === 'wrong_document_type' && wrong.extraction.sessions.length === 0, 'Dominio sbagliato: esito recuperabile senza piano')
    const diet = jobOf(await fn(body(fixtureDoc('diet-spec-example'), randomUUID(), 'diet'), a.token), 'Dieta')
    check(diet.status === 'ready' && diet.extraction.kind === 'diet', 'Dieta: schema e prompt propri')

    phase('segmentazione e selezione esplicita')
    const providerConfig = readProviderConfig(syntheticEnv)
    const provider = createOpenAIProvider(providerConfig.config)
    const measure = doc => new TextEncoder().encode(provider.prepare({ kind: 'workout', document: doc, schemaId: 'peppitness.workout-extraction.v1', promptVersion: syntheticEnv.IMPORT_PROMPT_VERSION, profile: 'standard', signal: new AbortController().signal }).serializedRequest).length + 256
    const two = document('segments', 2)
    await importLocalSql(`update peppitness_private.import_budget_config set max_input_tokens=${measure(two) - 200} where config_version=${lit(marker)} returning singleton`)
    const segmented = jobOf(await fn(body(two), a.token), 'Documento in due segmenti')
    check(segmented.status === 'ready' && segmented.usageSummary.providerCalls === 2 && (await ledger(segmented.jobId)).length === 2, 'Oltre budget: due segmenti, due chiamate prenotate')
    check(JSON.stringify(segmented.extraction.sessions.map(s => s.label)) === '["Seduta A","Seduta B"]'
      && segmented.extraction.evidence.find(e => e.path === '/sessions/1/label')?.spans[0].blockId === 'h:1', 'Ricomposizione in ordine di fonte con evidence rimappate')
    const three = await fn(body(document('segments-3', 3)), a.token)
    check(three.status === 413 && three.data?.error?.limit?.limit === 'providerCallsPerAnalysis' && three.data.error.limit.actual === 3, 'Tre segmenti con due chiamate: selezione esplicita richiesta, nessun taglio')
    await importLocalSql(`update peppitness_private.import_budget_config set max_input_tokens=200000 where config_version=${lit(marker)} returning singleton`)

    phase('timeout, esito incerto e concorrenza per account')
    const hangBody = body(document('hang', 1, { marker: syntheticMarkers.hang }))
    const hanging = fn(hangBody, c.token)
    await new Promise(resolve => setTimeout(resolve, 700))
    const blocked = await fn(body(document('parallel')), c.token)
    check(blocked.status === 409 && errorCode(blocked) === 'request_conflict' && blocked.data.error.retryable === true, 'Seconda analisi concorrente dello stesso account: 409')
    const hung = jobOf(await hanging, 'Timeout provider')
    check(hung.status === 'failed' && hung.error.code === 'provider_outcome_uncertain', 'Timeout dopo l’invio: esito incerto')
    const hungLedger = await ledger(hung.jobId)
    check(hungLedger.length === 1 && hungLedger[0].state === 'uncertain', 'Timeout: riserva mantenuta come incerta, nessun retry')
    const hungReplay = jobOf(await fn(hangBody, c.token), 'Replay dopo timeout')
    check(hungReplay.status === 'failed' && (await ledger(hung.jobId)).length === 1, 'Replay dopo timeout: nessuna nuova chiamata')

    phase('kill switch e assenza di scritture dei piani')
    await importLocalSql(`update peppitness_private.import_budget_config set enabled=false where config_version=${lit(marker)} returning singleton`)
    const killed = await fn(body(document('killed')), a.token)
    check(killed.status === 503, 'Kill switch: nuove analisi sospese')
    check((await rpc('get_import_job', { p_job_id: ready.jobId }, a.token)).data?.status === 'ready', 'Kill switch: lettura dei job continua')
    const plans = await importLocalSql(`select (select count(*) from public.workout_plans where owner_id in (${owners}))::int as workouts,
      (select count(*) from public.meal_plans where owner_id in (${owners}))::int as meals,
      (select count(*) from public.exercises where owner_id in (${owners}))::int as exercises`)
    check(plans[0].workouts === 0 && plans[0].meals === 0 && plans[0].exercises === 0, 'Endpoint non crea piani, diete o esercizi')
    for (const result of [ready, cached, other, segmented, refused]) {
      const text = JSON.stringify(result)
      check(!text.includes('sk-synthetic') && !text.includes('Sei l\'estrattore') && !text.includes('req_synthetic'), 'Risposte senza chiave, prompt o ID del provider')
    }

    phase('log del runtime Edge')
    const logs = spawnSync('docker', ['logs', '--since', '15m', `supabase_edge_runtime_${process.env.PEPPITNESS_SUPABASE_PROJECT ?? 'peppitness'}`], { encoding: 'utf8', windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 })
    if (logs.status === 0) {
      const text = `${logs.stdout}\n${logs.stderr}`
      check(!text.includes(SECRET_MARK) && !text.includes('sk-synthetic') && !text.includes('Esercizio 0-1') && !text.includes('Sei l\'estrattore'), 'Log Edge senza testo del documento, prompt o chiave')
      check(text.includes('"event":"extract_plan"') && text.includes('"event":"provider_response"'), 'Log Edge con soli metadati strutturati')
      results.dockerLogs = 'PASS'
    } else console.log('NON ESEGUITO controllo log Edge: docker logs non disponibile.')
  } finally {
    await importLocalSql(`do $cleanup$ begin
      perform 1 from peppitness_private.import_budget_config where singleton for update;
      delete from public.import_jobs where owner_id in (${owners});
      if exists(select 1 from peppitness_private.import_budget_config where config_version=${lit(marker)}) then
        if exists(select 1 from peppitness_private.import_usage_ledger) then raise exception 'Unexpected ledger during edge cleanup'; end if;
        delete from peppitness_private.import_budget_retired;
        delete from peppitness_private.import_budget_config;
        insert into peppitness_private.import_budget_config select * from jsonb_populate_record(null::peppitness_private.import_budget_config,${baseline}::jsonb);
      end if;
    end $cleanup$`)
    const restored = (await importLocalSql('select to_jsonb(cfg) as config from peppitness_private.import_budget_config cfg where singleton'))[0]?.config
    check(JSON.stringify(restored) === JSON.stringify(original), 'Configurazione budget originale ripristinata')
  }
}

let failed = false
let cleaned = 0
try { await run() } catch (error) {
  failed = true
  console.error(`FAIL ${error instanceof Error ? error.message : 'Errore inatteso.'}`)
} finally {
  for (const id of cleanupIds) {
    try {
      const response = await http(`/auth/v1/admin/users/${id}`, { method: 'DELETE', admin: true })
      if (!response.ok) throw new Error('cleanup')
      cleaned++
    } catch {
      failed = true
      console.error(`FAIL pulizia account locale ${id}`)
    }
  }
}
console.log(`Result: ${failed ? 'FAIL' : 'PASS'}; controlli superati: ${checks}; fixture eliminate: ${cleaned}/${cleanupIds.size}; log Edge: ${results.dockerLogs}.`)
process.exitCode = failed ? 1 : 0
