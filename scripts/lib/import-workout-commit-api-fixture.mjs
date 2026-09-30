import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { prepareImportJob, parseServerJob } from '../../supabase/functions/_shared/import/jobs.ts'
import { validateImportReceipt, receiptMismatches, importRpcNames, commitRpcArgs } from '../../supabase/functions/_shared/import/contracts.ts'
import { commandHash } from '../../supabase/functions/_shared/import/canonical.ts'
import { catalogSeed, commitFixtureRows, instantiateCommand } from './import-commit-fixtures.mjs'
import { importLocalSql, sqlLiteral as lit } from './import-local-db.mjs'

/**
 * Task 19. commit_workout_import via HTTP con sessioni reali A/B e anonimo; comandi dei mapper 09
 * (fixture del corpus) con UUID nuovi a ogni esecuzione e job pronti creati dalle API server 14.
 * Solo per tenere aperta una transazione concorrente (lock, errori tardivi deterministici) la RPC
 * reale è invocata via SQL locale con il JWT dell'utente; nessun helper privato è chiamato qui.
 */
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const profile = { promptVersion: 'fixture/1', provider: 'synthetic', model: 'synthetic', rulesVersion: 'commit-workout/1' }

async function settle(promise) {
  try { return { ok: true, value: await promise } } catch (error) { return { ok: false, message: error.message } }
}

export async function importWorkoutCommitApiChecks(context, a, b) {
  const { request, check, expectOk, expectDenied, concurrentRequests, isRevisionConflict } = context
  const rpc = (name, body, token, admin = false) => request(`/rest/v1/rpc/${name}`, { method: 'POST', body, token, admin })
  const server = (name, body) => rpc(name, body, undefined, true)
  const commit = (command, token) => rpc(importRpcNames.workout, commitRpcArgs(command), token)
  const receipt = (requestId, token) => rpc(importRpcNames.receipt, { p_request_id: requestId }, token)
  const rows = Object.fromEntries((await commitFixtureRows()).map(row => [row.id, row]))
  const code = result => result.data?.code
  const isCode = (result, sqlstate, message) => !result.ok && code(result) === sqlstate && (message === undefined || result.data?.message === message)

  async function readyJob(actor, row) {
    const args = await prepareImportJob(actor.id, { analysisRequestId: randomUUID(), kind: row.kind, expectedSchemaVersion: '1.0', normalizedDocument: row.document }, profile)
    let job = parseServerJob(expectOk(await server('create_import_job', args), 'import 19: job server'))
    if (job.job.status !== 'ready') {
      job = parseServerJob(expectOk(await server('complete_import_job', { p_owner_id: actor.id, p_job_id: job.job.jobId, p_expected_revision: job.revision,
        p_lease_token: job.leaseToken, p_expected_draft_revision: job.draftRevision, p_result: { extraction: row.extraction, validationIssues: [],
          usageSummary: { providerCalls: job.attemptCount, inputTokens: null, outputTokens: null, reasoningTokens: null, cached: false, costEstimate: null } } }),
      'import 19: job pronto'))
    }
    return job.job.jobId
  }
  const fixtureJob = row => row.command.provenance.analysis.jobId
  // Transazione reale tenuta aperta: RPC con il JWT dell'utente, poi attesa prima del commit.
  const held = (actor, command, seconds) => settle(importLocalSql(`do $fixture$ begin
    perform set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: actor.id, role: 'authenticated' }))}, true);
    perform public.commit_workout_import(${lit(command.requestId)}::uuid, ${lit(JSON.stringify(command.payload))}::jsonb,
      ${lit(JSON.stringify(command.provenance))}::jsonb, ${lit(JSON.stringify(command.selectionOptions))}::jsonb);
    perform pg_sleep(${Number(seconds)});
  end $fixture$`))
  const list = async (path, actor) => expectOk(await request(path, { token: actor.token }), `import 19: lettura ${path.split('?')[0]}`)
  const exercises = async actor => list('/rest/v1/exercises?select=id,name,note,revision,archived_at,source_template_id', actor)
  const plans = async actor => (await list('/rest/v1/workout_plans?select=id', actor)).map(row => row.id)
  async function programDays(actor, versionId) {
    const days = await list(`/rest/v1/workout_days?select=id,label,title,note&version_id=eq.${versionId}&order=position`, actor)
    return Promise.all(days.map(async day => ({ label: day.label, title: day.title, note: day.note,
      exercises: (await list(`/rest/v1/workout_prescriptions?select=exercise_snapshot,mode,sets,optional_sets,reps_min,reps_max,duration_seconds,rest_seconds,rir,rpe,note&day_id=eq.${day.id}&order=position`, actor))
        .map(({ exercise_snapshot: s, ...p }) => ({ name: s.name, variant: s.variant, equipment: s.equipment, load_convention: s.load_convention, load_unit: s.load_unit,
          per_side: s.per_side, exercise_note: s.note, mode: p.mode, sets: p.sets, optional_sets: p.optional_sets, reps_min: p.reps_min, reps_max: p.reps_max,
          duration_seconds: p.duration_seconds, rest_seconds: p.rest_seconds, rir: p.rir, rpe: p.rpe, note: p.note })) })))
  }
  // Confronto per valore: jsonb restituisce le chiavi in un altro ordine.
  const sameJson = (x, y) => isDeepStrictEqual(x, y)

  // Catalogo reale: esercizio personale di A creato via API, template comuni solo da SQL locale.
  const templates = [randomUUID(), randomUUID()]
  const [seedExisting] = catalogSeed.existing, [seedShared] = catalogSeed.shared
  await importLocalSql(`do $fixture$ begin
    insert into public.shared_exercises(id, name, variant, equipment, load_convention, load_unit, measurement_mode, per_side, note)
      select t.id, v->>'name', v->>'variant', v->>'equipment', v->>'loadConvention', v->>'loadUnit', v->>'measurementMode', (v->>'perSide')::boolean, v->>'note'
      from unnest(array[${templates.map(lit).join(', ')}]::uuid[]) t(id), (select ${lit(JSON.stringify(seedShared.values))}::jsonb v) s;
  end $fixture$`)
  let failure
  try {
    const v = seedExisting.values
    const [personal] = expectOk(await request('/rest/v1/exercises', { method: 'POST', token: a.token, representation: true, body: {
      name: v.name, variant: v.variant, equipment: v.equipment, load_convention: v.loadConvention, load_unit: v.loadUnit,
      measurement_mode: v.measurementMode, per_side: v.perSide, note: v.note } }), 'import 19: esercizio personale di A')
    const catalogRow = rows['workout-catalog'], newRow = rows['workout-ranges-unicode']
    const jobs = { a: { catalog: await readyJob(a, catalogRow), fresh: await readyJob(a, newRow) }, b: { catalog: await readyJob(b, catalogRow), fresh: await readyJob(b, newRow) } }
    const catalogCommand = (actor, template = templates[0]) => {
      const command = instantiateCommand(catalogRow.command, { [fixtureJob(catalogRow)]: jobs[actor].catalog, [seedExisting.id]: personal.id, [seedShared.id]: template })
      command.payload.resolved.catalog[0].choice.revision = personal.revision
      return command
    }
    const freshCommand = (actor, options) => {
      const command = instantiateCommand(newRow.command, { [fixtureJob(newRow)]: jobs[actor].fresh })
      if (options) command.selectionOptions = options
      return command
    }

    // Anonimo, account altrui e comandi non conformi.
    const exercisesBefore = (await exercises(a)).length
    const first = catalogCommand('a')
    expectDenied(await commit(first), 'import 19: anonimo respinto')
    expectDenied(await commit(first, b.token), 'import 19: B non usa il job di A')
    const foreign = catalogCommand('a'); foreign.provenance.analysis.jobId = jobs.b.catalog
    expectDenied(await commit(foreign, b.token), 'import 19: B non usa l\'esercizio personale di A')
    const extra = catalogCommand('a'); extra.payload.resolved.days[0].prescriptions[0].loadKg = 80
    check(isCode(await commit(extra, a.token), '22023', 'Invalid import command'), 'import 19: chiave sconosciuta 22023')
    const missing = catalogCommand('a'); delete missing.payload.resolved.days[0].prescriptions[0].restSeconds
    check(isCode(await commit(missing, a.token), '22023', 'Invalid import command'), 'import 19: campo mancante 22023')
    // Prescrizione dalla fonte senza decisione sulle serie: il valore deve restare quello estratto.
    const unchanged = freshCommand('a')
    const sourced = unchanged.provenance.items.find(item => /\/exercises\/\d+$/.test(item.sourcePointer ?? '') && !item.decisions.some(d => d.field === 'sets'))
    unchanged.payload.resolved.days.flatMap(day => day.prescriptions).find(p => p.id === sourced.targetId).sets += 1
    check(isCode(await commit(unchanged, a.token), '22023', 'Invalid import command'), 'import 19: valore cambiato senza decisione 22023')
    check((await exercises(a)).length === exercisesBefore && !(await plans(a)).some(id => [first, extra, missing, unchanged].some(c => c.payload.resolved.planId === id)),
      'import 19: rifiuti senza scritture')

    // Commit reale, ricevuta valida e valori letti dal database = preview 09.
    const hash = await commandHash(first)
    const saved = expectOk(await commit(first, a.token), 'import 19: commit A')
    check(validateImportReceipt(saved).ok && receiptMismatches(saved, first, hash).length === 0 && saved.resultState === 'committed'
      && saved.exerciseBindings.map(x => x.resolution).join() === 'existing,adopted' && saved.contentHash === catalogRow.contentHash,
      'import 19: ricevuta valida, hash e binding coerenti col comando')
    check(sameJson(await programDays(a, first.payload.resolved.versionId), catalogRow.expected), 'import 19: programma pubblicato = valori revisionati')
    const [plan] = await list(`/rest/v1/workout_plans?select=name,revision,active_version_id,cycle_start,cycle_weeks&id=eq.${first.payload.resolved.planId}`, a)
    check(plan?.active_version_id === first.payload.resolved.versionId && plan.name === first.payload.resolved.title && plan.cycle_start === null,
      'import 19: versione attiva e ciclo del comando')
    const adopted = (await exercises(a)).filter(x => x.source_template_id === templates[0])
    check(adopted.length === 1 && adopted[0].id === saved.exerciseBindings[1].exerciseId && adopted[0].note === seedShared.values.note, 'import 19: template adottato nella transazione')
    check(sameJson(expectOk(await receipt(first.requestId, a.token), 'import 19: lookup'), saved), 'import 19: risposta persa, lookup = stessa ricevuta')
    check(expectOk(await receipt(first.requestId, b.token), 'import 19: lookup B') === null
      && (await list(`/rest/v1/workout_plans?select=id&id=eq.${first.payload.resolved.planId}`, b)).length === 0, 'import 19: B non vede ricevuta e programma di A')

    // Replay (anche concorrente) e stessa chiave con comando diverso.
    const before = { plans: (await plans(a)).length, exercises: (await exercises(a)).length }
    const replays = await concurrentRequests([commit(first, a.token), commit(first, a.token)])
    check(replays.every(x => x.ok && sameJson(x.data, saved)), 'import 19: doppio invio, stessa ricevuta')
    const changed = structuredClone(first); changed.payload.resolved.title = 'Titolo diverso'
    check(isRevisionConflict(await commit(changed, a.token)), 'import 19: stessa chiave, payload diverso HTTP 409')
    check((await plans(a)).length === before.plans && (await exercises(a)).length === before.exercises, 'import 19: replay senza duplicati di programma o catalogo')

    // Diario: seduta sul programma importato con lo snapshot revisionato.
    const sessionId = randomUUID()
    const session = expectOk(await rpc('start_workout_session', { p_session_id: sessionId, p_version_id: first.payload.resolved.versionId,
      p_day_id: first.payload.resolved.days[0].id, p_diary_date: '2026-10-06', p_time_zone: 'Europe/Rome' }, a.token), 'import 19: seduta sul programma importato')
    const snapshot = session.day_snapshot
    check(sameJson({ label: snapshot.label, title: snapshot.title, note: snapshot.note, exercises: snapshot.exercises.map(({ id, exercise_id, ...rest }) => rest) },
      catalogRow.expected[0]) && snapshot.plan_title === first.payload.resolved.title, 'import 19: diario legge esattamente i valori revisionati')

    // Revisione concorrente all'avvio: versione usata -> v2, snapshot e v1 intatti.
    const days = (await list(`/rest/v1/workout_days?select=id,label,title,note&version_id=eq.${first.payload.resolved.versionId}&order=position`, a))
    const manualDays = await Promise.all(days.map(async day => ({ ...day, exercises: await list(`/rest/v1/workout_prescriptions?select=id,exercise_id,sets,optional_sets,reps_min,reps_max,duration_seconds,rest_seconds,rir,rpe,note&day_id=eq.${day.id}&order=position`, a) })))
    const revision = expectOk(await rpc('save_workout_revision', { p_plan_id: first.payload.resolved.planId, p_base_version_id: first.payload.resolved.versionId,
      p_expected_plan_revision: plan.revision, p_expected_version_revision: 2, p_new_version_id: randomUUID(), p_title: first.payload.resolved.title,
      p_guidance: 'Istruzioni riviste dopo l\'import', p_days: manualDays, p_cycle_start: null, p_cycle_weeks: null }, a.token), 'import 19: revisione del programma importato')
    check(revision.outcome === 'created' && sameJson(await programDays(a, first.payload.resolved.versionId), catalogRow.expected), 'import 19: versione importata usata resta immutabile')
    const [kept] = await list(`/rest/v1/workout_sessions?select=day_snapshot&id=eq.${sessionId}`, a)
    check(sameJson(kept.day_snapshot, snapshot), 'import 19: snapshot della seduta intatto')
    expectOk(await request(`/rest/v1/workout_sessions?id=eq.${sessionId}`, { method: 'PATCH', token: a.token, body: { status: 'completed', revision: 2 } }), 'import 19: seduta completata')

    // Copia esplicita: nuova chiave e nuovi UUID; template già adottato e identico.
    const copy = catalogCommand('a')
    const copied = expectOk(await commit(copy, a.token), 'import 19: copia esplicita')
    check(copied.contentHash === saved.contentHash && copied.planId !== saved.planId && copied.exerciseBindings[1].resolution === 'already_adopted'
      && copied.exerciseBindings[1].exerciseId === saved.exerciseBindings[1].exerciseId, 'import 19: copia ammessa, nessuna seconda adozione')

    // Catalogo cambiato dopo la preview: conflitto, nessuna scrittura.
    expectOk(await request(`/rest/v1/exercises?id=eq.${personal.id}`, { method: 'PATCH', token: a.token, body: { note: 'Nota cambiata', revision: 2 } }), 'import 19: nota cambiata')
    const drift = catalogCommand('a')
    const drifted = await commit(drift, a.token)
    check(isCode(drifted, 'PT409', 'Catalog changed') && drifted.status === 409 && !(await plans(a)).includes(drift.payload.resolved.planId), 'import 19: deriva del catalogo HTTP 409')
    expectOk(await request(`/rest/v1/exercises?id=eq.${adopted[0].id}`, { method: 'PATCH', token: a.token, body: { archived_at: new Date().toISOString(), revision: 2 } }), 'import 19: copia archiviata')
    const archived = catalogCommand('a'); archived.payload.resolved.catalog[0].choice.revision = 2; archived.payload.resolved.catalog[0].choice.seen.note = 'Nota cambiata'
    check(isCode(await commit(archived, a.token), 'PT409', 'Catalog changed')
      && (await exercises(a)).find(x => x.id === adopted[0].id)?.archived_at !== null, 'import 19: copia archiviata mai riattivata')

    // Adozione concorrente dello stesso template da due import di B: una copia, due programmi.
    const bCommands = [catalogCommand('b', templates[1]), catalogCommand('b', templates[1])]
    const [bPersonal] = expectOk(await request('/rest/v1/exercises', { method: 'POST', token: b.token, representation: true, body: {
      name: v.name, variant: v.variant, equipment: v.equipment, load_convention: v.loadConvention, load_unit: v.loadUnit,
      measurement_mode: v.measurementMode, per_side: v.perSide, note: v.note } }), 'import 19: esercizio personale di B')
    for (const command of bCommands) {
      command.payload.resolved.catalog[0].ref = command.payload.resolved.catalog[0].choice.personalId = bPersonal.id
      for (const day of command.payload.resolved.days) for (const p of day.prescriptions) if (p.exerciseRef === personal.id) p.exerciseRef = bPersonal.id
    }
    const adoptions = await concurrentRequests(bCommands.map(command => commit(command, b.token)))
    const bCopies = (await exercises(b)).filter(x => x.source_template_id === templates[1])
    check(adoptions.every(x => x.ok) && bCopies.length === 1 && adoptions.map(x => x.data.exerciseBindings[1].resolution).sort().join() === 'adopted,already_adopted'
      && adoptions.every(x => x.data.exerciseBindings[1].exerciseId === bCopies[0].id), 'import 19: adozione concorrente, una sola copia')

    // Errore tardivo reale: stessa ultima prescrizione in due import, il secondo attende il primo.
    const bBefore = (await exercises(b)).length
    const winner = freshCommand('b')
    const lastId = winner.payload.resolved.days.at(-1).prescriptions.at(-1).id
    const fresh = freshCommand('b')
    // Stesso UUID nella prescrizione e nella provenienza: il controllo iniziale non lo vede ancora.
    const loser = JSON.parse(JSON.stringify(fresh).replaceAll(fresh.payload.resolved.days.at(-1).prescriptions.at(-1).id, lastId))
    const hold = held(b, winner, 2)
    await pause(900)
    const late = await commit(loser, b.token)
    const winnerResult = await hold
    check(winnerResult.ok && isRevisionConflict(late) && late.data?.message === 'Import request conflict', 'import 19: collisione sull\'ultimo figlio, errore tardivo 409')
    const created = winner.payload.resolved.catalog.filter(x => x.choice.source === 'new').length
    check(!(await plans(b)).includes(loser.payload.resolved.planId) && (await exercises(b)).length === bBefore + created
      && expectOk(await receipt(loser.requestId, b.token), 'import 19: lookup perdente') === null, 'import 19: rollback tardivo annulla programma ed esercizi nuovi')

    // Selezione creata in concorrenza: il perdente fallisce dopo la pubblicazione.
    // Bootstrap: la fixture delle ricevute ha già creato la selezione di B; il caso richiede che manchi.
    await importLocalSql(`do $fixture$ begin delete from public.active_plans where owner_id = ${lit(b.id)}; end $fixture$`)
    check((await list('/rest/v1/active_plans?select=revision', b)).length === 0, 'import 19: B senza selezione')
    const followers = [freshCommand('b', { follow: true, expectedActiveRevision: null }), freshCommand('b', { follow: true, expectedActiveRevision: null })]
    const holdFollow = held(b, followers[0], 2)
    await pause(900)
    const secondFollow = await commit(followers[1], b.token)
    check((await holdFollow).ok && isCode(secondFollow, 'PT409', 'Active selection conflict'), 'import 19: selezione concorrente, conflitto tardivo')
    const [bSelection] = await list('/rest/v1/active_plans?select=revision,workout_plan_id,meal_plan_id', b)
    check(bSelection?.revision === 1 && bSelection.workout_plan_id === followers[0].payload.resolved.planId && bSelection.meal_plan_id === null
      && !(await plans(b)).includes(followers[1].payload.resolved.planId) && (await exercises(b)).length === bBefore + 2 * created,
      'import 19: selezione del vincitore, perdente senza programma né esercizi')

    // Avvio seduta e retry durante un import in corso: versione invisibile, poi la stessa ricevuta.
    const pending = freshCommand('a')
    const holdPending = held(a, pending, 2)
    await pause(900)
    const [early, retry] = await Promise.all([
      rpc('start_workout_session', { p_session_id: randomUUID(), p_version_id: pending.payload.resolved.versionId, p_day_id: pending.payload.resolved.days[0].id,
        p_diary_date: '2026-10-07', p_time_zone: 'Europe/Rome' }, a.token),
      commit(pending, a.token)])
    check((await holdPending).ok && !early.ok && code(early) === '42501' && retry.ok && retry.data.planId === pending.payload.resolved.planId
      && (await plans(a)).filter(id => id === pending.payload.resolved.planId).length === 1, 'import 19: nessuna seduta su versione non confermata, retry in corso = stessa ricevuta')

    // Eliminazione concorrente a un import in corso: ricevuta committed se e solo se il programma esiste.
    const racing = freshCommand('a')
    const holdRacing = held(a, racing, 2)
    await pause(900)
    const removed = await rpc('delete_workout_plans', { p_plan_id: null }, a.token)
    check((await holdRacing).ok && removed.ok, 'import 19: delete e import concorrenti completati')
    const alive = new Set(await plans(a))
    const receipts = expectOk(await request('/rest/v1/import_receipts?select=request_id,result_state,plan_id&kind=eq.workout', { token: a.token }), 'import 19: ricevute A')
    check(receipts.length >= 4 && receipts.every(row => (row.result_state === 'committed') === alive.has(row.plan_id)), 'import 19: committed se e solo se il programma esiste')
    check(expectOk(await commit(first, a.token), 'import 19: vecchio retry').resultState === 'deleted' && !(await plans(a)).includes(first.payload.resolved.planId),
      'import 19: tombstone, vecchio retry senza ricreazione')

    // Pulizia dei soli template locali: programmi eliminati, copie adottate rimosse.
    expectOk(await rpc('delete_workout_plans', { p_plan_id: null }, b.token), 'import 19: pulizia programmi B')
    expectOk(await rpc('delete_workout_plans', { p_plan_id: null }, a.token), 'import 19: pulizia programmi A')
  } catch (error) {
    failure = error
    throw error
  } finally {
    // Anche dopo un fallimento: selezione e programmi di A/B (cascata), poi copie adottate e template.
    // Un errore di pulizia non nasconde quello del controllo fallito.
    await importLocalSql(`do $fixture$ begin
      update public.active_plans set workout_plan_id = null, revision = revision + 1
        where owner_id in (${lit(a.id)}, ${lit(b.id)}) and workout_plan_id is not null;
      delete from public.workout_plans where owner_id in (${lit(a.id)}, ${lit(b.id)});
      delete from public.exercises where source_template_id = any(array[${templates.map(lit).join(', ')}]::uuid[]);
      delete from public.shared_exercises where id = any(array[${templates.map(lit).join(', ')}]::uuid[]);
    end $fixture$`).catch(error => { if (!failure) throw error })
  }
}
