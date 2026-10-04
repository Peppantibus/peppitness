import { randomUUID, randomBytes } from 'node:crypto'
import { readLocalStatus, publicErrorCode } from './lib/local-supabase.mjs'

// Admin solo bootstrap Auth delle fixture locali.
// Test accessi alle tabelle con chiave pubblica e sessioni utente reali.
let checks = 0
const summaryOnly = process.argv.includes('--summary')
const cleanupIds = new Set()
let config

function check(condition, label) {
  if (!condition) throw new Error(label)
  checks++
  if (!summaryOnly) console.log(`PASS ${label}`)
}

function responseSummary(results) {
  return results.map(result => `HTTP ${result.status}/${result.ok ? 'ok' : publicErrorCode(result.data)}`).join(', ')
}

function isRevisionConflict(result) {
  return result.status === 409 && publicErrorCode(result.data) === 'PT409'
}

async function concurrentRequests(requests) {
  // Attendere entrambe prima di rimuovere le fixture, anche se una richiesta fallisce.
  const results = await Promise.allSettled(requests)
  const errors = results.filter(result => result.status === 'rejected')
  if (errors.length) throw new Error(errors.map(result => result.reason.message).join('; '))
  return results.map(result => result.value)
}

async function request(path, { method = 'GET', body, token, admin = false, representation = false } = {}) {
  if (admin && !path.startsWith('/auth/v1/admin/users')) throw new Error('Privilegi amministrativi limitati alle fixture Auth.')
  const key = admin ? config.adminKey : config.publicKey
  const headers = { apikey: key, 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  else if (admin && key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`
  if (representation) headers.Prefer = 'return=representation'
  let response
  let raw
  const started = Date.now()
  try {
    response = await fetch(`${config.apiUrl}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    raw = await response.text()
  } catch (error) {
    const cause = error?.name === 'TimeoutError' ? 'timeout' : 'rete o redirect'
    // Solo metodo e percorso statico: omette filtri, ID, token e messaggi del trasporto.
    throw new Error(`Richiesta API locale: ${method} ${path.split('?')[0]}, ${cause} dopo ${Date.now() - started} ms.`)
  }
  let data = null
  if (raw) {
    try { data = JSON.parse(raw) } catch { throw new Error(`Risposta API non JSON, HTTP ${response.status}.`) }
  }
  return { ok: response.ok, status: response.status, data }
}

function expectOk(result, label) {
  check(result.ok, `${label} (HTTP ${result.status}, codice ${result.ok ? 'ok' : publicErrorCode(result.data)})`)
  return result.data
}
function expectDenied(result, label, codes = ['42501']) {
  check(!result.ok && codes.includes(publicErrorCode(result.data)),
    `${label} (HTTP ${result.status}, codice ${publicErrorCode(result.data)})`)
}
function rememberCreatedUser(data) {
  const user = data?.user ?? data
  if (typeof user?.id === 'string' && /^[0-9a-f-]{36}$/i.test(user.id)) cleanupIds.add(user.id)
  return user
}

async function createFixture(label) {
  const email = `peppitness-${label}-${randomUUID()}@peppitness.local`
  const password = `Aa1!${randomBytes(24).toString('base64url')}`
  const response = await request('/auth/v1/admin/users', {
    method: 'POST', admin: true,
    body: { email, password, email_confirm: true, app_metadata: { peppitness_test: true } },
  })
  if (response.ok) rememberCreatedUser(response.data)
  const user = rememberCreatedUser(expectOk(response, `Creazione account locale ${label}`))
  check(Boolean(user?.id), `Identificativo fixture ${label} disponibile`)
  const session = expectOk(await request('/auth/v1/token?grant_type=password', {
    method: 'POST', body: { email, password },
  }), `Login email/password ${label}`)
  check(typeof session?.access_token === 'string' && session.user?.id === user.id, `Sessione ${label} associata alla fixture`)
  return { id: user.id, token: session.access_token, refreshToken: session.refresh_token }
}

async function tableChecks(table, a, b) {
  if (summaryOnly) console.log(`IN CORSO ${table}: accessi, proprieta e concorrenza.`)
  const exercise = table === 'exercises'
  const aId = exercise ? randomUUID() : a.id
  const bId = exercise ? randomUUID() : b.id
  const idColumn = exercise ? 'id' : 'owner_id'
  const field = exercise ? 'name' : 'display_name'
  const endpoint = `/rest/v1/${table}`
  const target = `${endpoint}?${idColumn}=eq.${aId}`
  const ownB = `${endpoint}?${idColumn}=eq.${bId}`
  const payload = id => exercise ? { id, name: 'Esercizio inventato API' } : { display_name: 'Persona inventata API' }
  const rowsA = expectOk(await request(endpoint, { method: 'POST', token: a.token, body: payload(aId), representation: true }), `${table}: A inserisce`)
  check(rowsA?.length === 1 && rowsA[0].owner_id === a.id, `${table}: proprietario dalla sessione A`)
  expectOk(await request(endpoint, { method: 'POST', token: b.token, body: payload(bId) }), `${table}: B inserisce`)

  for (const [method, body] of [['GET', undefined], ['POST', payload(randomUUID())], ['PATCH', { [field]: 'Anon', revision: 2 }], ['DELETE', undefined]]) {
    expectDenied(await request(method === 'POST' ? endpoint : target, { method, body }), `${table}: ${method} senza sessione respinto`)
  }
  const hidden = expectOk(await request(`${target}&select=*`, { token: b.token }), `${table}: lettura ID altrui`)
  check(Array.isArray(hidden) && hidden.length === 0, `${table}: B non vede il record di A`)
  const untouched = expectOk(await request(target, { method: 'PATCH', token: b.token, body: { [field]: 'Modifica di B', revision: 2 }, representation: true }), `${table}: tentativo update altrui`)
  check(Array.isArray(untouched) && untouched.length === 0, `${table}: B non modifica il record di A`)
  expectDenied(await request(target, { method: 'DELETE', token: b.token }), `${table}: B non elimina A`)
  expectDenied(await request(endpoint, { method: 'POST', token: b.token, body: { ...payload(randomUUID()), owner_id: a.id } }), `${table}: proprietario falsificato respinto`)
  expectDenied(await request(ownB, { method: 'PATCH', token: b.token, body: { owner_id: a.id, revision: 2 } }), `${table}: trasferimento proprieta respinto`)

  const updated = expectOk(await request(target, { method: 'PATCH', token: a.token, body: { [field]: 'Prima modifica', revision: 2 }, representation: true }), `${table}: modifica proprietario`)
  check(updated?.length === 1 && updated[0].revision === 2, `${table}: revisione aggiornata`)
  const concurrent = await concurrentRequests(['Dispositivo 1', 'Dispositivo 2'].map(value => request(target, {
    method: 'PATCH', token: a.token, body: { [field]: value, revision: 3 }, representation: true,
  })))
  check(concurrent.filter(result => result.ok && result.data?.[0]?.revision === 3).length === 1
    && concurrent.filter(isRevisionConflict).length === 1,
  `${table}: due scritture concorrenti, una accettata e un conflitto (${responseSummary(concurrent)})`)
  const reloaded = expectOk(await request(`${target}&select=*`, { token: a.token }), `${table}: rilettura indipendente`)
  check(reloaded?.length === 1 && reloaded[0].revision === 3, `${table}: dato recuperato dopo nuova richiesta`)
  const onlyB = expectOk(await request(`${endpoint}?select=*`, { token: b.token }), `${table}: elenco B`)
  check(onlyB?.length === 1 && onlyB[0].owner_id === b.id, `${table}: elenco contiene solo dati di B`)
  if (exercise) {
    expectDenied(await request(target, { method: 'PATCH', token: a.token, body: { variant: 'altra', revision: 4 } }), 'Identita confrontabile protetta tramite API')
    expectOk(await request(target, { method: 'PATCH', token: a.token, body: { archived_at: new Date().toISOString(), revision: 4 } }), 'Archiviazione esercizio tramite API')
    const restored = expectOk(await request(target, { method: 'PATCH', token: a.token, body: { archived_at: null, revision: 5 }, representation: true }), 'Ripristino esercizio tramite API')
    check(restored?.[0]?.id === aId && restored[0].archived_at === null, 'Ripristino mantiene identificativo')
  }
}

async function workoutChecks(a, b) {
  if (summaryOnly) console.log('IN CORSO programmi: isolamento, RPC, concorrenza e versioni.')
  const one = value => Array.isArray(value) ? value[0] : value
  const exercisesA = expectOk(await request('/rest/v1/exercises?select=id,name', { token: a.token }), 'Catalogo A per il programma')
  const exercisesB = expectOk(await request('/rest/v1/exercises?select=id', { token: b.token }), 'Catalogo B per il programma')
  const exerciseA = exercisesA[0]
  const planId = randomUUID(), versionId = randomUUID()
  const makeDays = exerciseId => [{ id: randomUUID(), label: 'A', title: 'Seduta inventata', exercises: [
    { id: randomUUID(), exercise_id: exerciseId, sets: 2, optional_sets: 1, reps_min: 8, reps_max: 10, rest_seconds: 90 },
  ] }]
  const document = {
    p_plan_id: planId, p_version_id: versionId, p_expected_revision: 0,
    p_title: 'Programma inventato API', p_guidance: 'Istruzioni globali di prova', p_days: makeDays(exerciseA.id),
  }
  const save = (body, token = a.token) => request('/rest/v1/rpc/save_workout_draft', { method: 'POST', token, body })
  const publish = (body, token = a.token) => request('/rest/v1/rpc/publish_workout_version', { method: 'POST', token, body })
  let draft = one(expectOk(await save(document), 'RPC salva programma e bozza atomicamente'))
  check(draft?.id === versionId && draft.owner_id === a.id && draft.revision === 1, 'RPC restituisce bozza di A')

  for (const [table, field] of [['workout_plans', 'name'], ['workout_plan_versions', 'title'], ['workout_days', 'title'], ['workout_prescriptions', 'note']]) {
    const path = `/rest/v1/${table}?owner_id=eq.${a.id}`
    const hidden = expectOk(await request(path, { token: b.token }), `${table}: B cerca dati di A`)
    check(Array.isArray(hidden) && hidden.length === 0, `${table}: isolamento lettura API`)
    for (const [method, body] of [['GET', undefined], ['POST', { owner_id: a.id }], ['PATCH', { [field]: 'Anon' }], ['DELETE', undefined]]) {
      expectDenied(await request(method === 'POST' ? `/rest/v1/${table}` : path, { method, body }), `${table}: ${method} anonimo respinto`)
    }
    expectDenied(await request(`/rest/v1/${table}`, { method: 'POST', token: b.token, body: { owner_id: a.id } }), `${table}: inserimento diretto respinto`)
    expectDenied(await request(path, { method: 'DELETE', token: b.token }), `${table}: cancellazione da B respinta`)
    const result = await request(path, { method: 'PATCH', token: b.token, body: { [field]: 'Attacco', ...(table === 'workout_plans' ? { revision: 2 } : {}) }, representation: true })
    if (table === 'workout_plans') check(result.ok && result.data?.length === 0, 'B non modifica il programma di A')
    else expectDenied(result, `${table}: aggiornamento diretto respinto`)
  }
  expectDenied(await request('/rest/v1/rpc/save_workout_draft', { method: 'POST', body: document }), 'RPC salvataggio anonima respinta')
  expectDenied(await request('/rest/v1/rpc/publish_workout_version', { method: 'POST', body: { p_version_id: versionId, p_expected_revision: 1, p_expected_plan_revision: 1 } }), 'RPC pubblicazione anonima respinta')
  expectDenied(await save({ ...document, p_expected_revision: 1 }, b.token), 'B non salva una versione di A')
  expectDenied(await publish({ p_version_id: versionId, p_expected_revision: 1, p_expected_plan_revision: 1 }, b.token), 'B non pubblica una versione di A')
  const rejectedPlan = randomUUID()
  expectDenied(await save({ ...document, p_plan_id: rejectedPlan, p_version_id: randomUUID(), p_days: makeDays(exerciseA.id) }, b.token), 'RPC respinge esercizio appartenente ad A nel piano di B')
  const afterFailure = expectOk(await request(`/rest/v1/workout_plans?id=eq.${rejectedPlan}`, { token: b.token }), 'Controllo rollback programma respinto')
  check(afterFailure?.length === 0, 'Errore non lascia un programma parziale')
  const staleDraft = await save(document)
  check(isRevisionConflict(staleDraft), `Salvataggio con revisione obsoleta respinto (${responseSummary([staleDraft])})`)

  const invalidDays = structuredClone(document.p_days)
  invalidDays[0].exercises.push({ ...invalidDays[0].exercises[0], id: randomUUID(), sets: 0 })
  expectDenied(await save({ ...document, p_expected_revision: 1, p_title: 'Modifica da annullare', p_days: invalidDays }), 'Prescrizione invalida annulla il salvataggio', ['23514'])
  const version = expectOk(await request(`/rest/v1/workout_plan_versions?id=eq.${versionId}`, { token: a.token }), 'Rilettura dopo rollback')
  check(version?.[0]?.revision === 1 && version[0].title === document.p_title, 'Rollback conserva versione originale')
  const raced = await concurrentRequests(['Bozza dispositivo 1', 'Bozza dispositivo 2'].map(title => save({ ...document, p_title: title, p_expected_revision: 1 })))
  check(raced.filter(result => result.ok).length === 1 && raced.filter(isRevisionConflict).length === 1,
    `Salvataggi concorrenti di un programma: una sola modifica accettata (${responseSummary(raced)})`)
  draft = one(raced.find(result => result.ok).data)
  const stalePublication = await publish({ p_version_id: versionId, p_expected_revision: draft.revision, p_expected_plan_revision: 99 })
  check(isRevisionConflict(stalePublication), `Pubblicazione con revisione obsoleta respinta (${responseSummary([stalePublication])})`)
  const published = one(expectOk(await publish({ p_version_id: versionId, p_expected_revision: draft.revision, p_expected_plan_revision: 1 }), 'Pubblicazione programma A'))
  check(published?.status === 'published', 'Versione pubblicata')
  expectDenied(await save({ ...document, p_expected_revision: published.revision }), 'Versione pubblicata non riscrivibile', ['55000'])
  const snapshot = expectOk(await request(`/rest/v1/workout_prescriptions?id=eq.${document.p_days[0].exercises[0].id}`, { token: a.token }), 'Snapshot prescrizione')
  check(snapshot?.[0]?.sets === 2 && snapshot[0].optional_sets === 1, 'Serie facoltative conservate separatamente')
  expectOk(await request(`/rest/v1/exercises?id=eq.${exerciseA.id}`, { method: 'PATCH', token: a.token, body: { name: 'Nome successivo nel catalogo', revision: 6 } }), 'Rinomina catalogo dopo pubblicazione')
  const preserved = expectOk(await request(`/rest/v1/workout_prescriptions?id=eq.${document.p_days[0].exercises[0].id}`, { token: a.token }), 'Rilettura snapshot dopo rinomina')
  check(preserved?.[0]?.exercise_snapshot?.name === snapshot[0].exercise_snapshot.name, 'Snapshot conserva il nome originale')
  const nextId = randomUUID()
  expectOk(await save({ ...document, p_version_id: nextId, p_title: 'Seconda versione', p_days: makeDays(exerciseA.id) }), 'Creazione nuova versione')
  expectOk(await publish({ p_version_id: nextId, p_expected_revision: 1, p_expected_plan_revision: 2 }), 'Pubblicazione nuova versione')
  const plan = expectOk(await request(`/rest/v1/workout_plans?id=eq.${planId}`, { token: a.token }), 'Rilettura programma attivo')
  check(plan?.[0]?.active_version_id === nextId, 'Programma punta alla nuova versione')
  const previous = expectOk(await request(`/rest/v1/workout_prescriptions?id=eq.${document.p_days[0].exercises[0].id}`, { token: a.token }), 'Lettura prescrizione della versione precedente')
  check(previous?.length === 1 && previous[0].exercise_snapshot.name === snapshot[0].exercise_snapshot.name, 'Nuova versione conserva la precedente')
  expectOk(await save({ ...document, p_plan_id: randomUUID(), p_version_id: randomUUID(), p_days: makeDays(exercisesB[0].id) }, b.token), 'B crea il proprio programma separato')
  const days = expectOk(await request(`/rest/v1/workout_days?version_id=eq.${versionId}&select=id`, { token: a.token }), 'Giornata della prima versione')
  return { planId, firstVersionId: versionId, versionId: nextId, planRevision: plan[0].revision, firstDayId: days[0].id, firstPrescriptionId: document.p_days[0].exercises[0].id }
}

async function diaryChecks(a, b, program) {
  if (summaryOnly) console.log('IN CORSO diario: programma seguito, sedute, serie, piani alimentari e pasti.')
  const one = value => Array.isArray(value) ? value[0] : value
  const rpc = (name, body, token) => request(`/rest/v1/rpc/${name}`, { method: 'POST', token, body })
  const tables = ['active_plans', 'workout_sessions', 'workout_set_logs', 'meal_plans', 'diary_days', 'meal_logs']
  for (const table of tables) {
    expectDenied(await request(`/rest/v1/${table}?select=*`), `${table}: lettura anonima respinta`)
    expectDenied(await request(`/rest/v1/${table}`, { method: 'POST', body: {} }), `${table}: scrittura anonima respinta`)
  }

  // Programma seguito e riattivazione esplicita di una versione precedente.
  const selected = expectOk(await request('/rest/v1/active_plans', { method: 'POST', token: a.token, body: { workout_plan_id: program.planId }, representation: true }), 'A sceglie il programma da seguire')
  check(selected?.[0]?.owner_id === a.id && selected[0].revision === 1, 'Selezione legata alla sessione A')
  expectDenied(await request('/rest/v1/active_plans', { method: 'POST', token: b.token, body: { workout_plan_id: program.planId } }), 'B non segue il programma di A', ['23514', '23503'])
  const staleSelection = await request(`/rest/v1/active_plans?owner_id=eq.${a.id}`, { method: 'PATCH', token: a.token, body: { workout_plan_id: null, revision: 1 } })
  check(isRevisionConflict(staleSelection), `Selezione con revisione obsoleta respinta (${responseSummary([staleSelection])})`)
  expectDenied(await rpc('activate_workout_version', { p_version_id: program.firstVersionId, p_expected_plan_revision: program.planRevision }, b.token), 'B non riattiva versioni di A')
  const reactivated = one(expectOk(await rpc('activate_workout_version', { p_version_id: program.firstVersionId, p_expected_plan_revision: program.planRevision }, a.token), 'A riattiva la prima versione pubblicata'))
  check(reactivated?.active_version_id === program.firstVersionId && reactivated.revision === program.planRevision + 1, 'Versione precedente resa corrente senza modificarla')

  // Seduta: avvio idempotente, una sola in corso, snapshot dal server.
  const sessionId = randomUUID()
  const startBody = { p_session_id: sessionId, p_version_id: program.firstVersionId, p_day_id: program.firstDayId, p_diary_date: '2026-09-28', p_time_zone: 'Europe/Rome' }
  expectDenied(await rpc('start_workout_session', startBody), 'Avvio seduta anonimo respinto')
  expectDenied(await rpc('start_workout_session', { ...startBody, p_session_id: randomUUID() }, b.token), 'B non avvia sedute sul programma di A')
  const started = await concurrentRequests([rpc('start_workout_session', startBody, a.token), rpc('start_workout_session', startBody, a.token)])
  check(started.every(result => result.ok && one(result.data)?.id === sessionId), `Avvio ripetuto idempotente (${responseSummary(started)})`)
  const session = one(started[0].data)
  check(session.day_snapshot?.exercises?.[0]?.optional_sets === 1 && session.status === 'active', 'Snapshot con serie facoltative separate')
  const second = await rpc('start_workout_session', { ...startBody, p_session_id: randomUUID() }, a.token)
  check(second.status === 409, `Seconda seduta in corso respinta (${responseSummary([second])})`)
  expectDenied(await request('/rest/v1/workout_sessions', { method: 'POST', token: a.token, body: { id: randomUUID(), plan_id: program.planId, version_id: program.firstVersionId, day_id: program.firstDayId, diary_date: '2026-09-28', time_zone: 'Europe/Rome', day_snapshot: {} } }), 'Sedute create solo tramite RPC')

  const setPath = '/rest/v1/workout_set_logs'
  const setBody = { session_id: sessionId, prescription_id: program.firstPrescriptionId, set_index: 0, load: 12.5, amount: 10, completed: true }
  const inserted = await concurrentRequests([request(setPath, { method: 'POST', token: a.token, body: setBody, representation: true }), request(setPath, { method: 'POST', token: a.token, body: setBody, representation: true })])
  check(inserted.filter(result => result.ok).length === 1 && inserted.filter(result => result.status === 409).length === 1, `Stessa serie da due invii: una sola riga (${responseSummary(inserted)})`)
  expectDenied(await request(setPath, { method: 'POST', token: a.token, body: { ...setBody, set_index: 3 } }), 'Serie oltre la prescrizione respinta', ['23514'])
  expectDenied(await request(setPath, { method: 'POST', token: a.token, body: { ...setBody, set_index: 1, amount: 8.5 } }), 'Ripetizioni decimali respinte', ['23514'])
  expectDenied(await request(setPath, { method: 'POST', token: b.token, body: { ...setBody, set_index: 1 } }), 'B non scrive nella seduta di A', ['23514', '23503', '42501'])
  const setFilter = `${setPath}?session_id=eq.${sessionId}&set_index=eq.0`
  const hiddenSets = expectOk(await request(setFilter, { token: b.token }), 'B cerca le serie di A')
  check(hiddenSets.length === 0, 'Serie di A invisibili a B')
  const raced = await concurrentRequests(['13', '14'].map(load => request(setFilter, { method: 'PATCH', token: a.token, body: { load: Number(load), revision: 2 }, representation: true })))
  check(raced.filter(result => result.ok && result.data?.length === 1).length === 1 && raced.filter(isRevisionConflict).length === 1, `Correzioni concorrenti di una serie: una accettata e un conflitto (${responseSummary(raced)})`)
  const completed = expectOk(await request(`/rest/v1/workout_sessions?id=eq.${sessionId}`, { method: 'PATCH', token: a.token, body: { status: 'completed', revision: 2 }, representation: true }), 'Seduta completata')
  check(completed?.[0]?.completed_at !== null, 'Orario di completamento dal server')
  expectDenied(await request(`/rest/v1/workout_sessions?id=eq.${sessionId}`, { method: 'PATCH', token: a.token, body: { day_snapshot: {}, revision: 3 } }), 'Snapshot della seduta non modificabile')
  const kept = expectOk(await request(`/rest/v1/workout_sessions?id=eq.${sessionId}`, { method: 'DELETE', token: a.token, representation: true }), 'Tentativo di cancellare una seduta completata')
  check(kept.length === 0, 'Seduta completata conservata nello storico')
  const corrected = expectOk(await request(setFilter, { method: 'PATCH', token: a.token, body: { amount: 11, revision: 3 }, representation: true }), 'Correzione dello storico')
  check(corrected?.[0]?.amount === 11, 'Storico correggibile con revisione')
  const discardId = randomUUID()
  expectOk(await rpc('start_workout_session', { ...startBody, p_session_id: discardId, p_diary_date: '2026-09-29' }, a.token), 'Nuova seduta dopo il completamento')
  const discarded = expectOk(await request(`/rest/v1/workout_sessions?id=eq.${discardId}`, { method: 'DELETE', token: a.token, representation: true }), 'Annullamento seduta in corso')
  check(discarded.length === 1, 'Seduta in corso annullabile')

  // Piano alimentare e diario dei pasti.
  const planId = randomUUID(), dayId = randomUUID(), mealId = randomUUID()
  const document = { guidance: '', days: [{ id: dayId, name: 'Palestra', dayType: 'training', note: '', meals: [{ id: mealId, name: 'Colazione', time: '', note: '', alternatives: [], additions: [], foods: [{ name: 'Yogurt', quantity: '150 g' }] }] }] }
  expectOk(await request('/rest/v1/meal_plans', { method: 'POST', token: a.token, body: { id: planId, name: 'Piano inventato API', document } }), 'A salva un piano alimentare')
  expectDenied(await request('/rest/v1/meal_plans', { method: 'POST', token: a.token, body: { id: randomUUID(), name: 'Invalido', document: { ...document, extra: 1 } } }), 'Documento con proprietà sconosciute respinto', ['23514'])
  const hiddenPlans = expectOk(await request(`/rest/v1/meal_plans?id=eq.${planId}`, { token: b.token }), 'B cerca il piano di A')
  check(hiddenPlans.length === 0, 'Piano alimentare di A invisibile a B')
  const staleMeal = await request(`/rest/v1/meal_plans?id=eq.${planId}`, { method: 'PATCH', token: a.token, body: { name: 'Obsoleto', revision: 1 } })
  check(isRevisionConflict(staleMeal), `Piano con revisione obsoleta respinto (${responseSummary([staleMeal])})`)
  const snapshot = { id: mealId, name: 'Colazione', items: ['Yogurt · 150 g'] }
  const logBody = { diary_date: '2026-09-28', meal_id: mealId, meal_plan_id: planId, status: 'modified', note: 'Meno yogurt', day_type: 'rest', meal_snapshot: snapshot }
  expectOk(await request('/rest/v1/meal_logs', { method: 'POST', token: a.token, body: logBody }), 'Pasto registrato')
  const duplicate = await request('/rest/v1/meal_logs', { method: 'POST', token: a.token, body: logBody })
  check(duplicate.status === 409, `Registrazione duplicata respinta (${responseSummary([duplicate])})`)
  expectDenied(await request('/rest/v1/meal_logs', { method: 'POST', token: b.token, body: logBody }), 'B non registra pasti sul piano di A', ['23503', '42501'])
  expectDenied(await request(`/rest/v1/meal_logs?meal_id=eq.${mealId}`, { method: 'PATCH', token: a.token, body: { day_type: 'training', revision: 2 } }), 'Contesto del pasto non modificabile')
  const fixed = expectOk(await request(`/rest/v1/meal_logs?meal_id=eq.${mealId}`, { method: 'PATCH', token: a.token, body: { status: 'followed', note: '', revision: 2 }, representation: true }), 'Correzione del pasto')
  check(fixed?.[0]?.day_type === 'rest' && fixed[0].meal_snapshot.name === 'Colazione', 'Correzione conserva contesto e snapshot')
  expectOk(await request('/rest/v1/diary_days', { method: 'POST', token: a.token, body: { diary_date: '2026-09-28', day_type: 'rest' } }), 'Tipo di giornata salvato')
  const everything = await Promise.all(tables.map(table => request(`/rest/v1/${table}?select=*`, { token: b.token })))
  check(everything.every(result => result.ok && Array.isArray(result.data) && result.data.length === 0), 'B non vede alcun dato del diario di A')
}

async function run() {
  config = readLocalStatus()
  console.log(`Test HTTP sul solo Supabase locale (${config.apiUrl.replace('http://', '')}).`)
  if (summaryOnly) console.log('IN CORSO Auth: login A/B, blocco signup pubblico e anonimo.')
  const a = await createFixture('a')
  const b = await createFixture('b')

  const signup = await request('/auth/v1/signup', {
    method: 'POST', body: { email: `signup-${randomUUID()}@peppitness.local`, password: `Aa1!${randomBytes(24).toString('base64url')}` },
  })
  if (signup.ok) rememberCreatedUser(signup.data)
  expectDenied(signup, 'Registrazione pubblica disabilitata', ['signup_disabled', 'email_provider_disabled'])
  const anonymous = await request('/auth/v1/signup', { method: 'POST', body: {} })
  if (anonymous.ok) rememberCreatedUser(anonymous.data)
  expectDenied(anonymous, 'Accesso anonimo disabilitato', ['anonymous_provider_disabled', 'signup_disabled'])

  await tableChecks('user_settings', a, b)
  await tableChecks('exercises', a, b)
  const program = await workoutChecks(a, b)
  await diaryChecks(a, b, program)
  // URL e chiave pubblica per l'SDK del client (21): mai la chiave amministrativa.
  if (summaryOnly) console.log('IN CORSO sessione: rinnovo e logout.')
  const renewed = expectOk(await request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', body: { refresh_token: a.refreshToken },
  }), 'Rinnovo sessione A')
  check(renewed.user?.id === a.id && typeof renewed.access_token === 'string', 'Rinnovo mantiene identita A')
  expectOk(await request('/rest/v1/user_settings?select=owner_id', { token: renewed.access_token }), 'Sessione rinnovata legge via API')
  expectOk(await request('/auth/v1/logout?scope=global', { method: 'POST', token: renewed.access_token }), 'Logout sessione A')
  expectDenied(await request('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', body: { refresh_token: renewed.refresh_token },
  }), 'Sessione uscita non rinnovabile', ['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found'])
}

let failed = false
let cleaned = 0
try { await run() } catch (error) {
  failed = true
  console.error(`FAIL ${error instanceof Error ? error.message : 'Errore inatteso nel runner.'}`)
} finally {
  for (const id of cleanupIds) {
    try {
      const response = await request(`/auth/v1/admin/users/${id}`, { method: 'DELETE', admin: true })
      if (!response.ok) throw new Error('cleanup')
      cleaned++
    } catch {
      failed = true
      console.error(`FAIL pulizia fixture locale ${id}; rimuoverla da Authentication del solo ambiente locale.`)
    }
  }
}
console.log(`Result: ${failed ? 'FAIL' : 'PASS'}; controlli superati: ${checks}; fixture eliminate: ${cleaned}/${cleanupIds.size}.`)
process.exitCode = failed ? 1 : 0
