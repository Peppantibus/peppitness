import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prepareImportJob, parseServerJob, jobServerRpcNames } from '../../supabase/functions/_shared/import/jobs.ts'
import { validateImportJobResult } from '../../src/import/contracts/jobs.ts'
import { budgetRpcNames } from '../../supabase/functions/_shared/import/budget.ts'
import { importBudgetApiChecks } from './import-budget-api-fixture.mjs'
import { importReceiptsApiChecks } from './import-receipts-api-fixture.mjs'

// Unico punto di estensione import per 15/18/19/20. Privilegi admin ammessi SOLO
// per queste API server, oltre al bootstrap Auth già presente nel runner.
export const importServerPaths = Object.freeze([...Object.values(jobServerRpcNames), ...Object.values(budgetRpcNames)].map(name => `/rest/v1/rpc/${name}`))
const fixture = name => JSON.parse(readFileSync(new URL(`../../tests/fixtures/import/${name}.json`, import.meta.url), 'utf8'))

export async function importApiChecks(context, a, b) {
  const { request, check, expectOk, expectDenied, concurrentRequests, isRevisionConflict } = context
  const rpc = (name, body, token, admin = false) => request(`/rest/v1/rpc/${name}`, { method: 'POST', body, token, admin })
  const server = (name, body) => rpc(name, body, undefined, true)
  const read = (jobId, token = a.token) => rpc('get_import_job', { p_job_id: jobId }, token)
  const profile = { promptVersion: 'fixture/1', provider: 'synthetic', model: 'synthetic', rulesVersion: 'fixture/1' }
  const input = { analysisRequestId: randomUUID(), kind: 'workout', expectedSchemaVersion: '1.0', normalizedDocument: fixture('documents/workout-incomplete') }
  const args = await prepareImportJob(a.id, input, profile)
  const raced = await concurrentRequests([server('create_import_job', args), server('create_import_job', args)])
  const created = raced.map(result => parseServerJob(expectOk(result, 'import: create concorrente server')))
  check(created[0].job.jobId === created[1].job.jobId && created.filter(x => x.created).length === 1, 'import: replay concorrente crea un solo job')
  const current = created[0]
  const jobId = current.job.jobId
  check(current.job.status === 'running' && current.attemptCount === 0, 'import: creazione non avvia provider')

  for (const actor of [a, b]) {
    const forgedOwner = actor.id === a.id ? b.id : a.id
    // Payload distinti con colonne reali: PGRST204 non prova un diniego di accesso.
    for (const [method, jobBody, draftBody] of [
      ['POST', {
        id: randomUUID(), owner_id: forgedOwner, analysis_request_id: randomUUID(), kind: input.kind,
        input_hash: args.p_input_hash, normalized_hash: args.p_normalized_hash, versions: args.p_versions,
        lease_token: randomUUID(), lease_expires_at: current.leaseExpiresAt,
      }, {
        job_id: jobId, owner_id: forgedOwner, normalized_document: input.normalizedDocument,
        schema_version: input.expectedSchemaVersion, expires_at: current.job.expiresAt,
      }],
      ['PATCH', { owner_id: forgedOwner, status: 'ready', lease_token: randomUUID(), revision: 2 }, {
        owner_id: forgedOwner, extraction: fixture('extractions/workout-incomplete'), revision: 2,
      }],
      ['DELETE', undefined],
    ]) {
      expectDenied(await request(`/rest/v1/import_jobs${method === 'POST' ? '' : `?id=eq.${jobId}`}`, { method, body: jobBody, token: actor.token }), `import: ${method} jobs client respinto`)
      expectDenied(await request(`/rest/v1/import_drafts${method === 'POST' ? '' : `?job_id=eq.${jobId}`}`, { method, body: draftBody, token: actor.token }), `import: ${method} drafts client respinto`)
    }
    expectDenied(await rpc('create_import_job', args, actor.token), 'import: create server non accessibile al client')
  }
  for (const table of ['import_jobs', 'import_drafts']) {
    const columns = table === 'import_jobs' ? 'id,status' : '*'
    expectDenied(await request(`/rest/v1/${table}?select=${columns}`), `import: ${table} anonimo respinto`)
    const rows = expectOk(await request(`/rest/v1/${table}?select=${columns}&owner_id=eq.${a.id}`, { token: b.token }), 'import: filtro owner altrui')
    check(rows.length === 0, 'import: RLS B non vede A')
  }
  expectDenied(await rpc('get_import_job', { p_job_id: jobId }), 'import: get anonimo respinto')
  check(expectOk(await read(jobId, b.token), 'import: lookup B') === null, 'import: B non recupera job A')
  const running = expectOk(await read(jobId), 'import: lookup A')
  check(validateImportJobResult(running).ok && running.status === 'running', 'import: protocollo pubblico valido')
  expectDenied(await request(`/rest/v1/import_jobs?id=eq.${jobId}&select=lease_token`, { token: a.token }), 'import: lease non leggibile dal browser')

  const changed = structuredClone(input)
  changed.normalizedDocument.blocks[0].text = 'Titolo sintetico diverso'
  check(isRevisionConflict(await server('create_import_job', await prepareImportJob(a.id, changed, profile))), 'import: chiave uguale input differente HTTP409')
  const otherOwner = parseServerJob(expectOk(await server('create_import_job', await prepareImportJob(b.id, input, profile)), 'import: chiave B'))
  check(otherOwner.job.jobId !== jobId, 'import: idempotenza per account')

  // Risultato sintetico con ZERO chiamate, identità server solo nel test locale.
  const result = { extraction: fixture('extractions/workout-incomplete'), validationIssues: [],
    usageSummary: { providerCalls: 0, inputTokens: null, outputTokens: null, reasoningTokens: null, cached: false, costEstimate: null } }
  const completion = { p_owner_id: a.id, p_job_id: jobId, p_expected_revision: current.revision,
    p_expected_draft_revision: current.draftRevision, p_lease_token: current.leaseToken, p_result: result }
  for (const actor of [a, b]) expectDenied(await rpc('complete_import_job', completion, actor.token), 'import: complete non accessibile al client')
  check(isRevisionConflict(await server('complete_import_job', { ...completion, p_expected_draft_revision: 99 })), 'import: bozza obsoleta HTTP409')
  check(expectOk(await read(jobId), 'import: rollback complete').status === 'running', 'import: nessun ready parziale')
  const completed = await concurrentRequests([server('complete_import_job', completion), server('complete_import_job', completion)])
  check(completed.filter(x => x.ok).length === 1 && completed.filter(isRevisionConflict).length === 1, 'import: complete concorrente una sola scrittura')
  // Risposta originale ignorata: recupero mediante nuova richiesta autenticata.
  const recovered = expectOk(await read(jobId), 'import: recupero dopo risposta persa')
  check(validateImportJobResult(recovered).ok && recovered.status === 'ready' && recovered.extraction.title === result.extraction.title, 'import: ready e risultato recuperati insieme')
  const draft = expectOk(await request(`/rest/v1/import_drafts?job_id=eq.${jobId}`, { token: a.token }), 'import: documento recuperabile')
  check(draft.length === 1 && draft[0].revision === 2 && draft[0].normalized_document.sourceHash === input.normalizedDocument.sourceHash, 'import: fonte e proposta private versionate')
  const cached = parseServerJob(expectOk(await server('create_import_job', await prepareImportJob(a.id, { ...input, analysisRequestId: randomUUID() }, profile)), 'import: cache privata'))
  check(cached.job.status === 'ready' && cached.job.usageSummary.cached && cached.attemptCount === 0, 'import: cache senza nuova chiamata')
  const isolated = parseServerJob(expectOk(await server('create_import_job', await prepareImportJob(b.id, { ...input, analysisRequestId: randomUUID() }, profile)), 'import: cache isolata'))
  check(isolated.job.status === 'running', 'import: B non riusa analisi A')
  const newProfile = parseServerJob(expectOk(await server('create_import_job', await prepareImportJob(a.id, { ...input, analysisRequestId: randomUUID() }, { ...profile, model: 'next' })), 'import: cache versionata'))
  check(newProfile.job.status === 'running', 'import: modello diverso non riusa cache')

  // Stessa chiave, input diversi in concorrenza: uno solo entra, nessun job parziale.
  const contested = { ...input, analysisRequestId: randomUUID() }
  const different = structuredClone(contested); different.normalizedDocument.blocks[0].text = 'Altro input concorrente'
  const conflict = await concurrentRequests([server('create_import_job', await prepareImportJob(a.id, contested, profile)), server('create_import_job', await prepareImportJob(a.id, different, profile))])
  check(conflict.filter(x => x.ok).length === 1 && conflict.filter(isRevisionConflict).length === 1, 'import: input concorrenti uno solo accettato')
  const failed = parseServerJob(expectOk(await server('fail_import_job', {
    p_owner_id: a.id, p_job_id: newProfile.job.jobId, p_expected_revision: newProfile.revision,
    p_lease_token: newProfile.leaseToken, p_code: 'provider_outcome_uncertain',
  }), 'import: esito incerto persistito'))
  check(failed.providerOutcome === 'uncertain' && failed.job.usageSummary.inputTokens === null && failed.job.error.retryable === false, 'import: incerto non è consumo zero o retry')
  const replay = parseServerJob(expectOk(await server('create_import_job', await prepareImportJob(a.id, { ...input, analysisRequestId: newProfile.job.analysisRequestId }, profile)), 'import: replay fallito'))
  check(replay.job.status === 'failed' && replay.job.jobId === failed.job.jobId, 'import: replay non riavvia analisi')
  await importBudgetApiChecks(context, a, b)
  await importReceiptsApiChecks(context, a, b)
}
