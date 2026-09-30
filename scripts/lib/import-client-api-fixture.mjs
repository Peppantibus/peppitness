import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createClient } from '@supabase/supabase-js'
import { prepareImportJob, parseServerJob } from '../../supabase/functions/_shared/import/jobs.ts'
import { defaultSelectionOptions } from '../../src/import/contracts/index.ts'
import { sequentialLocalIds } from '../../src/import/review/draft.ts'
import { applyImportEvent, createImportSession } from '../../src/import/review/state.ts'
import { memoryBackend, ReviewStore } from '../../src/import/review/local-storage.ts'
import { reserveDietIds, reserveWorkoutIds } from '../../src/features/import/review-model.ts'
import { applyDecision } from '../../src/import/review/decisions.ts'
import { ImportReviewStore } from '../../src/persistence/import-review-store.ts'
import { createImportsRepository, ImportsFailure } from '../../src/persistence/imports-repository.ts'
import { commitFixtureCases } from './import-commit-fixtures.mjs'

/**
 * Task 21. Repository e coordinatore dell'app contro le RPC reali 14/18/19/20, con l'SDK Supabase e le
 * sessioni utente A/B del runner: job pronti creati dalle API server (nessuna chiamata provider), riapertura
 * dell'analisi compatibile, conferma con una sola RPC, risposta persa prima/dopo il commit, ricevuta,
 * duplicato e copia esplicita, conflitto di selezione, ricevuta `deleted`, isolamento dell'altro account.
 * L'endpoint Edge non è coinvolto (prova dedicata: scripts/import-edge-local-check.mjs).
 */
const profile = { promptVersion: 'fixture/1', provider: 'synthetic', model: 'synthetic', rulesVersion: 'client-21/1' }
const settle = () => new Promise(done => setTimeout(done, 0))

export async function importClientApiChecks(context, a, b) {
  const { request, check, expectOk, apiUrl, publicKey } = context
  const server = (name, body) => request(`/rest/v1/rpc/${name}`, { method: 'POST', body, admin: true })
  const clientFor = async actor => {
    const client = createClient(apiUrl, publicKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
    const { error } = await client.auth.setSession({ access_token: actor.token, refresh_token: actor.refreshToken })
    check(!error, 'import 21: sessione SDK dell’utente')
    return client
  }
  const rows = Object.fromEntries(commitFixtureCases().map(row => [row.id, row]))
  const [clientA, clientB] = [await clientFor(a), await clientFor(b)]

  /** Fonte con impronta unica per esecuzione (nessuna cache condivisa con altri casi), job pronto per A. */
  async function readyJob(actor, row) {
    const document = { ...structuredClone(row.document), sourceHash: createHash('sha256').update(randomUUID()).digest('hex') }
    const args = await prepareImportJob(actor.id, { analysisRequestId: randomUUID(), kind: row.kind, expectedSchemaVersion: '1.0', normalizedDocument: document }, profile)
    let job = parseServerJob(expectOk(await server('create_import_job', args), 'import 21: job server'))
    job = parseServerJob(expectOk(await server('complete_import_job', { p_owner_id: actor.id, p_job_id: job.job.jobId, p_expected_revision: job.revision,
      p_lease_token: job.leaseToken, p_expected_draft_revision: job.draftRevision, p_result: { extraction: row.extraction, validationIssues: [],
        usageSummary: { providerCalls: 0, inputTokens: null, outputTokens: null, reasoningTokens: null, cached: false, costEstimate: null } } }), 'import 21: job pronto'))
    return { jobId: job.job.jobId, document }
  }
  /** Motore dell'app con journal in memoria e documento già letto sul "dispositivo". */
  async function deviceWith(actor, client, kind, document, repository = createImportsRepository(client, actor.id)) {
    const backend = memoryBackend(), at = new Date().toISOString(), sessionId = randomUUID()
    const event = value => ({ ...value, ownerId: actor.id, sessionId, at })
    let session = createImportSession({ ownerId: actor.id, sessionId, kind, file: { name: `${kind}.docx`, size: 1, format: 'docx', sourceHash: document.sourceHash }, at })
    session = applyImportEvent(session, event({ type: 'read_started' })).state
    session = applyImportEvent(session, event({ type: 'read_succeeded', document, sourceHash: document.sourceHash })).state
    check((await new ReviewStore(backend).save(session)).ok, 'import 21: lettura nel journal')
    const refreshed = []
    const engine = new ImportReviewStore(actor.id, { journal: new ReviewStore(backend), repository, localIds: sequentialLocalIds('i'),
      refresh: async receipt => { refreshed.push(receipt.planId) }, createReader: () => { throw new Error('nessuna lettura') } })
    engine.start()
    for (let i = 0; i < 200 && engine.getSnapshot().slots[kind].session?.status !== 'reading'; i++) await settle()
    return { engine, backend, refreshed, repository, slot: () => engine.getSnapshot().slots[kind], session: () => engine.getSnapshot().slots[kind].session }
  }
  /** Riapertura dell'analisi compatibile (nessuna nuova analisi) e decisioni del caso applicate come edit. */
  async function reviewed(device, row, jobId) {
    const { engine } = device
    await engine.imports.lookupCompatible(row.kind)
    check(device.slot().network.compatible?.some(item => item.jobId === jobId), `import 21 ${row.kind}: analisi compatibile trovata per fonte/reader/dominio`)
    await engine.imports.reopen(row.kind, jobId)
    check(device.session().status === 'reviewing' && device.session().jobId === jobId, `import 21 ${row.kind}: job riaperto senza nuove chiamate`)
    let draft = device.session().draft
    for (const decision of row.draft.decisions) draft = applyDecision(draft, decision)
    await engine.changeDraft(row.kind, draft)
    return row.kind === 'workout' ? reserveWorkoutIds(draft, null, randomUUID) : reserveDietIds(draft, null, randomUUID)
  }
  const planExists = async (actor, kind, planId) => expectOk(await request(`/rest/v1/${kind === 'workout' ? 'workout_plans' : 'meal_plans'}?select=id&id=eq.${planId}`, { token: actor.token }), 'import 21: lettura piano').length === 1

  // --- Scheda: risposta persa DOPO il commit → ricevuta reale, salvato senza copie. -------------------
  const workout = rows['workout-ranges-unicode']
  const wJob = await readyJob(a, workout)
  const bRepository = createImportsRepository(clientB, b.id)
  check(await bRepository.readJob(wJob.jobId, AbortSignal.timeout(15_000)) === null
    && (await bRepository.findCompatibleAnalysis({ kind: 'workout', sourceHash: wJob.document.sourceHash, readerVersion: wJob.document.readerVersion }, AbortSignal.timeout(15_000))).length === 0,
  'import 21: B non vede job né fonte di A')
  let sessionMismatch = null
  try { await createImportsRepository(clientB, a.id).getReceipt(randomUUID(), AbortSignal.timeout(15_000)) } catch (error) { sessionMismatch = error }
  check(sessionMismatch instanceof ImportsFailure && sessionMismatch.kind === 'session', 'import 21: repository di A con la sessione di B rifiutato prima della rete')

  const wRepository = createImportsRepository(clientA, a.id)
  const lostAfter = { ...wRepository, commitWorkout: async (command, signal) => { await wRepository.commitWorkout(command, signal); throw new ImportsFailure('uncertain') } }
  const wDevice = await deviceWith(a, clientA, 'workout', wJob.document, lostAfter)
  const wIds = await reviewed(wDevice, workout, wJob.jobId)
  await wDevice.engine.imports.confirm('workout', { ids: wIds, selection: defaultSelectionOptions })
  const wSaved = wDevice.session()
  check(wSaved.status === 'saved' && wSaved.receipt.resultState === 'committed' && wSaved.receipt.planId === wIds.planId && wSaved.receipt.versionId === wIds.versionId,
    'import 21 workout: risposta persa dopo il commit, ricevuta reale e stato salvato')
  check(await planExists(a, 'workout', wIds.planId) && isDeepStrictEqual(wDevice.refreshed, [wIds.planId]) && wDevice.slot().network.refresh === 'done', 'import 21 workout: piano creato una volta, rilettura notificata')
  check(isDeepStrictEqual(await wRepository.getReceipt(wSaved.commit.command.requestId, AbortSignal.timeout(15_000)), wSaved.receipt)
    && isDeepStrictEqual(await wRepository.commitWorkout(wSaved.commit.command, AbortSignal.timeout(15_000)), wSaved.receipt), 'import 21 workout: retry dello stesso comando = stessa ricevuta')
  check(await bRepository.getReceipt(wSaved.commit.command.requestId, AbortSignal.timeout(15_000)) === null, 'import 21: B non legge la ricevuta di A')

  // Conflitto di selezione reale, poi «salva senza seguire» con una nuova chiave.
  const wJob2 = await readyJob(a, workout)
  const conflictDevice = await deviceWith(a, clientA, 'workout', wJob2.document)
  const conflictIds = await reviewed(conflictDevice, workout, wJob2.jobId)
  // Stesso contenuto della scheda già importata: la copia è esplicita, così la RPC arriva al controllo della selezione.
  await conflictDevice.engine.imports.confirm('workout', { ids: conflictIds, selection: { follow: true, expectedActiveRevision: 999_999 }, allowDuplicate: true })
  check(conflictDevice.session().status === 'reviewing' && conflictDevice.slot().network.rejection === 'selection_conflict' && !(await planExists(a, 'workout', conflictIds.planId)),
    'import 21 workout: PT409 selezione, nulla scritto, di nuovo in revisione')
  await conflictDevice.engine.imports.confirm('workout', { ids: conflictIds, selection: defaultSelectionOptions, allowDuplicate: true })
  check(conflictDevice.session().status === 'saved' && conflictDevice.session().receipt.selection === null && await planExists(a, 'workout', conflictIds.planId),
    'import 21 workout: nuova conferma senza seguire, salvata')

  // --- Dieta: risposta persa PRIMA dell'arrivo → nessuna ricevuta, retry con la stessa chiave. ---------
  const diet = rows['diet-spec-example']
  const dJob = await readyJob(a, diet)
  const dRepository = createImportsRepository(clientA, a.id)
  let drop = true
  const lostBefore = { ...dRepository, commitDiet: async (command, signal) => { if (drop) { drop = false; throw new ImportsFailure('uncertain') } return dRepository.commitDiet(command, signal) } }
  const dDevice = await deviceWith(a, clientA, 'diet', dJob.document, lostBefore)
  const dIds = await reviewed(dDevice, diet, dJob.jobId)
  await dDevice.engine.imports.confirm('diet', { ids: dIds, selection: defaultSelectionOptions })
  const unknown = dDevice.session()
  check(unknown.status === 'save_unknown' && dDevice.slot().network.problem?.code === 'save_not_found' && !(await planExists(a, 'diet', dIds.planId)),
    'import 21 diet: esito incerto, ricevuta reale assente, nessun piano')
  await dDevice.engine.imports.retrySave('diet')
  const dSaved = dDevice.session()
  check(dSaved.status === 'saved' && dSaved.receipt.requestId === unknown.commit.command.requestId && await planExists(a, 'diet', dIds.planId),
    'import 21 diet: retry con lo stesso requestId, un solo piano')
  const [stored] = expectOk(await request(`/rest/v1/meal_plans?select=name,document&id=eq.${dIds.planId}`, { token: a.token }), 'import 21 diet: piano salvato')
  check(isDeepStrictEqual({ name: stored.name, document: stored.document }, { name: unknown.commit.command.payload.resolved.plan.name, document: unknown.commit.command.payload.resolved.plan.document }),
    'import 21 diet: dati salvati = anteprima del mapping')

  // Stessa dieta importata di nuovo: duplicato proposto, copia esplicita con nuova chiave; poi eliminazione → deleted.
  const dJob2 = await readyJob(a, diet)
  const copyDevice = await deviceWith(a, clientA, 'diet', dJob2.document)
  const copyIds = await reviewed(copyDevice, diet, dJob2.jobId)
  await copyDevice.engine.imports.confirm('diet', { ids: copyIds, selection: defaultSelectionOptions })
  check(copyDevice.session().status === 'ready' && copyDevice.slot().network.duplicates?.some(item => item.planId === dIds.planId) && !(await planExists(a, 'diet', copyIds.planId)),
    'import 21 diet: duplicato proposto senza invio')
  await copyDevice.engine.imports.confirm('diet', { ids: copyIds, selection: defaultSelectionOptions, allowDuplicate: true })
  const copied = copyDevice.session()
  check(copied.status === 'saved' && copied.receipt.contentHash === dSaved.receipt.contentHash && copied.receipt.requestId !== dSaved.receipt.requestId && await planExists(a, 'diet', copyIds.planId),
    'import 21 diet: copia esplicita, stesso contenuto, nuova chiave')
  expectOk(await request('/rest/v1/rpc/delete_meal_plans', { method: 'POST', token: a.token, body: { p_plan_id: copyIds.planId } }), 'import 21 diet: eliminazione della copia')
  const deleted = await dRepository.commitDiet(copied.commit.command, AbortSignal.timeout(15_000))
  check(deleted.resultState === 'deleted' && !(await planExists(a, 'diet', copyIds.planId)), 'import 21 diet: vecchio retry dopo l’eliminazione → deleted, piano non ricreato')
  for (const device of [wDevice, conflictDevice, dDevice, copyDevice]) device.engine.stop()
}
