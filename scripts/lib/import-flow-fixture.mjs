// Modello HTTP sintetico dell'importazione (task 22) per la prova browser del flusso completo: endpoint
// extract-plan con provider simulato, job/bozze private, ricevute e RPC di conferma 19/20. Riproduce le regole
// osservabili dall'app (una ricevuta per chiave, replay prima di tutto, PT409 di selezione, piano+versione+
// sedute o piano alimentare, selezione solo con follow) sulle stesse tabelle simulate di programmi e diario.
// NON è una prova SQL/RLS: quelle restano i test pgTAP/HTTP 19/20 e l'E2E del 24.
import { commandHash, contentHash } from '../../src/import/mapping/canonical.ts'
import { exerciseChoiceValues } from '../../src/import/contracts/index.ts'

export const importFlowPaths = [
  '/functions/v1/extract-plan', '/rest/v1/rpc/get_import_job', '/rest/v1/import_jobs', '/rest/v1/import_drafts',
  '/rest/v1/rpc/get_import_receipt', '/rest/v1/import_receipts', '/rest/v1/rpc/commit_workout_import', '/rest/v1/rpc/commit_diet_import',
  '/rest/v1/rpc/discard_import_job', '/rest/v1/rpc/renew_import_job',
]

function ownerOf(request) {
  const authorization = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
  return JSON.parse(Buffer.from(authorization?.split('.')[1] ?? '', 'base64url').toString()).sub
}
const wantsObject = request => Object.entries(request.headers).some(([name, value]) => name.toLowerCase() === 'accept' && value.includes('vnd.pgrst.object'))
const reply = (request, list) => wantsObject(request) ? list.length === 1 ? { status: 200, data: list[0] } : { status: 406, data: { code: 'PGRST116' } } : { status: 200, data: list }
const now = () => new Date().toISOString()
const publicJob = ({ owner: _owner, document: _document, ...job }) => structuredClone(job)

/** Rimappa i blocchi citati da una proposta del corpus sui blocchi con lo stesso testo del documento letto davvero. */
export function remapExtraction(extraction, fixtureDocument, document) {
  const byText = new Map(document.blocks.map(block => [`${block.kind}\u0000${block.text}`, block.id]))
  const ids = new Map(fixtureDocument.blocks.map(block => [block.id, byText.get(`${block.kind}\u0000${block.text}`)]))
  return JSON.parse(JSON.stringify(extraction), (key, value) => {
    if ((key === 'blockId') && typeof value === 'string') return ids.get(value) ?? value
    if (key === 'sourceRefs' && Array.isArray(value)) return value.map(id => ids.get(id) ?? id)
    return value
  })
}

export async function importFlowFixture(request, url, state) {
  const flow = state.importFlow ??= { jobs: new Map(), receipts: new Map(), analyses: [], commits: [], extractionFor: null }
  const owner = ownerOf(request)
  const path = url.pathname
  const body = request.postData ? JSON.parse(request.postData) : {}

  if (path === '/functions/v1/extract-plan') {
    flow.analyses.push({ owner, analysisRequestId: body.analysisRequestId, kind: body.kind })
    if (flow.analysisError) { const error = flow.analysisError; flow.analysisError = null; return { status: error.status, data: { error: error.error } } }
    let job = [...flow.jobs.values()].find(item => item.owner === owner && item.analysisRequestId === body.analysisRequestId)
    if (!job) {
      const extraction = flow.extractionFor(body.kind, body.normalizedDocument)
      job = { owner, document: body.normalizedDocument, jobId: crypto.randomUUID(), analysisRequestId: body.analysisRequestId, kind: body.kind, status: 'ready', extraction,
        validationIssues: [], usageSummary: { providerCalls: 1, inputTokens: 100, outputTokens: 100, reasoningTokens: null, cached: false, costEstimate: null }, error: null,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString() }
      flow.jobs.set(job.jobId, job)
      flow.providerCalls = (flow.providerCalls ?? 0) + 1
    }
    if (flow.loseAnalysis) { flow.loseAnalysis = false; return { failure: 'ConnectionClosed' } }
    return { status: 200, data: publicJob(job) }
  }
  if (path === '/rest/v1/rpc/get_import_job') {
    const job = flow.jobs.get(body.p_job_id)
    return { status: 200, data: job && job.owner === owner ? publicJob(job) : null }
  }
  if (path === '/rest/v1/import_jobs') {
    const filter = url.searchParams.get('analysis_request_id')?.slice(3)
    const rows = [...flow.jobs.values()].filter(job => job.owner === owner && (!filter || job.analysisRequestId === filter))
      .map(job => ({ id: job.jobId, owner_id: owner, analysis_request_id: job.analysisRequestId }))
    return reply(request, rows)
  }
  if (path === '/rest/v1/import_drafts') {
    const jobId = url.searchParams.get('job_id')?.slice(3)
    const source = url.searchParams.get('normalized_document->>sourceHash')?.slice(3)
    const reader = url.searchParams.get('normalized_document->>readerVersion')?.slice(3)
    const rows = [...flow.jobs.values()].filter(job => job.owner === owner && (!jobId || job.jobId === jobId)
      && (!source || job.document.sourceHash === source) && (!reader || job.document.readerVersion === reader) && job.extraction !== null)
      .map(job => ({ job_id: job.jobId, owner_id: owner, normalized_document: job.document, expires_at: job.expiresAt }))
    return reply(request, rows)
  }
  if (path === '/rest/v1/rpc/discard_import_job') {
    // Scarto esplicito (23): contenuti eliminati subito, job `expired`; altrui o assente → null.
    const job = flow.jobs.get(body.p_job_id)
    flow.discarded = [...flow.discarded ?? [], body.p_job_id]
    if (!job || job.owner !== owner) return { status: 200, data: null }
    Object.assign(job, { status: 'expired', extraction: null, validationIssues: [], document: { ...job.document, blocks: [], readingIssues: [] } })
    return { status: 200, data: publicJob(job) }
  }
  if (path === '/rest/v1/rpc/renew_import_job') {
    // Attività sull'analisi (23): un job proprio pronto scade di nuovo fra 7 giorni.
    const job = flow.jobs.get(body.p_job_id)
    flow.renewed = [...flow.renewed ?? [], body.p_job_id]
    if (!job || job.owner !== owner) return { status: 200, data: null }
    if (job.status === 'ready') job.expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString()
    return { status: 200, data: publicJob(job) }
  }
  if (path === '/rest/v1/rpc/get_import_receipt') {
    const found = flow.receipts.get(`${owner}:${body.p_request_id}`)
    return { status: 200, data: found ? structuredClone(found.receipt) : null }
  }
  if (path === '/rest/v1/import_receipts') {
    const hash = url.searchParams.get('content_hash')?.slice(3), kind = url.searchParams.get('kind')?.slice(3)
    const rows = [...flow.receipts.values()].filter(item => item.owner === owner && item.receipt.contentHash === hash && item.receipt.kind === kind && item.receipt.resultState === 'committed')
      .map(item => ({ owner_id: owner, request_id: item.receipt.requestId, kind: item.receipt.kind, plan_id: item.receipt.planId, version_id: item.receipt.versionId, result_state: 'committed', created_at: item.createdAt }))
    return { status: 200, data: rows }
  }
  // RPC di conferma: replay per chiave, poi selezione, piano e ricevuta in un'unica mutazione.
  const command = { requestId: body.p_request_id, payload: body.p_resolved_payload, provenance: body.p_provenance, selectionOptions: body.p_selection_options }
  flow.commits.push({ owner, path, command: structuredClone(command) })
  const hash = await commandHash(command)
  const key = `${owner}:${command.requestId}`
  const known = flow.receipts.get(key)
  if (known) {
    if (known.hash !== hash) return { status: 409, data: { code: 'PT409', message: 'Import request conflict' } }
    return flow.loseCommit ? (flow.loseCommit = false, { failure: 'ConnectionClosed' }) : { status: 200, data: structuredClone(known.receipt) }
  }
  const job = flow.jobs.get(command.provenance.analysis.jobId)
  if (command.provenance.analysis.jobId !== null && (!job || job.owner !== owner || job.kind !== command.payload.kind)) return { status: 403, data: { code: '42501', message: 'Import reference not available' } }
  state.diary ??= { active_plans: [], meal_plans: [], workout_sessions: [], workout_set_logs: [], meal_logs: [], diary_days: [] }
  const selectionRow = state.diary.active_plans.find(row => row.owner_id === owner) ?? null
  const options = command.selectionOptions
  if (options.follow && (selectionRow?.revision ?? null) !== options.expectedActiveRevision) return { status: 409, data: { code: 'PT409', message: 'Active selection conflict' } }
  const payload = command.payload
  const bindings = []
  let planId, versionId = null
  if (payload.kind === 'workout') {
    const resolved = payload.resolved
    state.programTables ??= { workout_plans: [], workout_plan_versions: [], workout_days: [], workout_prescriptions: [] }
    const tables = state.programTables
    planId = resolved.planId; versionId = resolved.versionId
    const exerciseIds = new Map()
    for (const binding of resolved.catalog) {
      const choice = binding.choice
      if (choice.source === 'existing') {
        const row = state.exercises.get(`${owner}:${choice.personalId}`)
        if (!row || row.archived_at || row.revision !== choice.revision) return { status: 409, data: { code: 'PT409', message: 'Catalog changed' } }
        exerciseIds.set(binding.ref, row.id); bindings.push({ ref: binding.ref, exerciseId: row.id, resolution: 'existing' })
      } else {
        const values = exerciseChoiceValues(choice)
        const id = crypto.randomUUID()
        state.exercises.set(`${owner}:${id}`, { id, owner_id: owner, name: values.name, variant: values.variant, equipment: values.equipment, load_convention: values.loadConvention,
          load_unit: values.loadUnit, measurement_mode: values.measurementMode, per_side: values.perSide, note: values.note, revision: 1, archived_at: null,
          source_template_id: choice.source === 'shared' ? choice.templateId : null })
        exerciseIds.set(binding.ref, id); bindings.push({ ref: binding.ref, exerciseId: id, resolution: choice.source === 'shared' ? 'adopted' : 'created' })
      }
    }
    const stamp = now()
    tables.workout_plans.push({ id: planId, owner_id: owner, name: resolved.title, revision: 2, active_version_id: versionId, archived_at: null,
      cycle_start: resolved.cycle?.start ?? null, cycle_weeks: resolved.cycle?.weeks ?? null, updated_at: stamp })
    tables.workout_plan_versions.push({ id: versionId, owner_id: owner, plan_id: planId, title: resolved.title, guidance: resolved.guidance, version_number: 1, revision: 2, status: 'published', published_at: stamp, updated_at: stamp })
    const choices = new Map(resolved.catalog.map(binding => [binding.ref, exerciseChoiceValues(binding.choice)]))
    resolved.days.forEach((day, position) => {
      tables.workout_days.push({ id: day.id, owner_id: owner, version_id: versionId, position, label: day.label, title: day.title, note: day.note })
      day.prescriptions.forEach((item, index) => {
        const values = choices.get(item.exerciseRef), exerciseId = exerciseIds.get(item.exerciseRef)
        tables.workout_prescriptions.push({ id: item.id, owner_id: owner, day_id: day.id, exercise_id: exerciseId, position: index, mode: values.measurementMode,
          exercise_snapshot: { id: exerciseId, name: values.name, variant: values.variant, equipment: values.equipment, load_convention: values.loadConvention, load_unit: values.loadUnit, per_side: values.perSide, note: values.note, mode: values.measurementMode },
          sets: item.sets, optional_sets: item.optionalSets, reps_min: item.repsMin, reps_max: item.repsMax, duration_seconds: item.durationSeconds, rest_seconds: item.restSeconds, rir: item.rir, rpe: item.rpe, note: item.note })
      })
    })
  } else {
    const plan = payload.resolved.plan
    planId = plan.id
    state.diary.meal_plans.push({ id: plan.id, owner_id: owner, name: plan.name, document: structuredClone(plan.document), archived_at: null, revision: 1 })
  }
  let selection = null
  if (options.follow) {
    const column = payload.kind === 'workout' ? 'workout_plan_id' : 'meal_plan_id'
    if (selectionRow) Object.assign(selectionRow, { [column]: planId, revision: selectionRow.revision + 1 })
    else state.diary.active_plans.push({ owner_id: owner, workout_plan_id: null, meal_plan_id: null, [column]: planId, revision: 1 })
    const row = state.diary.active_plans.find(item => item.owner_id === owner)
    selection = { revision: row.revision, workoutPlanId: row.workout_plan_id, mealPlanId: row.meal_plan_id }
  }
  const receipt = { requestId: command.requestId, kind: payload.kind, commandHash: hash, contentHash: await contentHash(payload), resultState: 'committed', planId, versionId, exerciseBindings: bindings, selection }
  flow.receipts.set(key, { owner, hash, receipt, createdAt: now() })
  if (flow.loseCommit) { flow.loseCommit = false; return { failure: 'ConnectionClosed' } }
  return { status: 200, data: structuredClone(receipt) }
}
