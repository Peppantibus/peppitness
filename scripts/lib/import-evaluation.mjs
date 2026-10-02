// Task 25: server-side benchmark. No frontend imports, no database mutations.
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { createOpenAIProvider } from '../../supabase/functions/_shared/import/openai-provider.ts'
import { readProviderConfig } from '../../supabase/functions/_shared/import/provider.ts'
import { IMPORT_PROMPT_VERSION } from '../../supabase/functions/_shared/import/prompts.ts'
import { extractionSchemaIds, validateNormalizedDocument, validateExtraction } from '../../src/import/contracts/index.ts'
import { validateProposal, VALIDATION_RULES_VERSION, validationIssueCodes } from '../../src/import/validation/validate.ts'
import { conservativeInputTokens, estimateCostMicros } from '../../supabase/functions/_shared/import/budget.ts'
import { compactExtraction, PROVIDER_FORMAT_VERSION } from '../../supabase/functions/_shared/import/compact.ts'

export const EVALUATION_VERSION = 'peppitness.import-evaluation.v1'
export const fixtureRoot = resolve('tests/fixtures/import')
export const digest = value => createHash('sha256').update(value).digest('hex')
export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
export function fixture(path) {
  const absolute = resolve(fixtureRoot, path)
  if (!absolute.startsWith(fixtureRoot + sep) || path.includes('e2e')) throw new Error('Invalid evaluation fixture path')
  return readJson(absolute)
}
export function pointer(value, path) {
  for (const key of path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined
    value = value[key]
  }
  return value
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const metric = () => ({ total: 0, correct: 0, errors: [] })
const coverageWarnings = new Set(['section_not_covered', 'page_not_covered', 'uncovered_numeric_content', 'unassigned_content', 'source_not_read'])
const relevantWarning = (validation, label) => validation.status === 'rejected' || validation.issues.some(issue =>
  issue.severity !== 'info' && label.warningCodes.includes(issue.code) &&
  ((issue.sourcePath && (issue.sourcePath === label.path || issue.sourcePath.startsWith(label.path + '/') || label.path.startsWith(issue.sourcePath + '/'))) ||
    (coverageWarnings.has(issue.code) && label.sourceRefs.length > 0 && label.sourceRefs.some(ref => issue.sourceRefs.includes(ref)))))

/** Labels are independently reviewed source truth, never candidate output. No confidence aggregate. */
export function scoreCase(entry, document, data, status = 'completed') {
  const validation = status === 'completed' ? validateProposal(entry.domain, document, data)
    : { status: 'rejected', reason: status, issues: [] }
  const metrics = Object.fromEntries(['numeric', 'associations', 'conditions'].map(key => [key, metric()]))
  const discrepancies = []
  for (const category of Object.keys(metrics)) for (const label of entry.labels[category]) {
    const actual = category === 'associations'
      ? { value: pointer(data, label.path), sourceRefs: (Array.isArray(data?.evidence) ? data.evidence : []).filter(e => e?.path === label.path && Array.isArray(e.spans)).flatMap(e => e.spans.map(s => s?.blockId).filter(id => typeof id === 'string')).sort() }
      : pointer(data, label.path)
    const expected = category === 'associations' ? { value: label.value, sourceRefs: [...label.sourceRefs].sort() } : label.value
    metrics[category].total++
    if (equal(actual, expected)) metrics[category].correct++
    else {
      const error = { category, path: label.path, signaled: relevantWarning(validation, label) }
      metrics[category].errors.push(error)
      discrepancies.push(error)
    }
  }
  const omissions = []
  for (const label of entry.labels.elements) if (pointer(data, label.path) === undefined) {
    omissions.push({ path: label.path, signaled: relevantWarning(validation, label) })
  }
  const knownPaths = new Set(entry.labels.elements.map(e => e.path))
  const unexpected = []
  function walk(value, path = '') {
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      const next = `${path}/${key}`
      if (Array.isArray(child) && ['sessions', 'exercises', 'days', 'meals', 'foods', 'globalRules', 'complexRules'].includes(key)) {
        child.forEach((_, i) => { const p = `${next}/${i}`; if (!knownPaths.has(p)) unexpected.push({ category: 'unexpected', path: p, signaled: relevantWarning(validation, { path: p, sourceRefs: [], warningCodes: ['alternative_in_base', 'conditional_in_base', 'wrong_context', 'missing_evidence'] }) }) })
      }
      walk(child, next)
    }
  }
  walk(data)
  discrepancies.push(...unexpected)
  const reviewable = validation.status === 'draft'
  return {
    ...metrics, omissions: { totalExpected: entry.labels.elements.length, omitted: omissions.length, unflagged: omissions.filter(e => !e.signaled).length, errors: omissions },
    unexpected, criticalErrors: { observed: discrepancies.length, unflagged: discrepancies.filter(e => !e.signaled).length },
    validation: validation.status === 'draft' ? { status: 'draft', issues: validation.issues.map(({ code, severity, sourcePath, sourceRefs }) => ({ code, severity, sourcePath, sourceRefs })) } : { status: 'rejected', reason: validation.reason },
    reviewable, exactExtraction: reviewable && discrepancies.length === 0 && omissions.length === 0,
  }
}

export function loadCorpus(manifest = fixture('evaluation/manifest.json')) {
  if (manifest.version !== EVALUATION_VERSION || manifest.cases.length < 30 || manifest.cases.length > 50) throw new Error('Invalid evaluation corpus')
  for(const policy of Object.values(manifest.warningPolicies??{})) if(!Array.isArray(policy) || policy.some(code=>!validationIssueCodes.includes(code))) throw new Error('Unknown warning code in annotated policy')
  const ids = new Set(), families = new Map(), hashes = new Map()
  for (const entry of manifest.cases) {
    for(const labels of Object.values(entry.labels)) for(const label of labels) {
      if(!manifest.warningPolicies?.[label.warningPolicy]) throw new Error('Missing warning policy')
      label.warningCodes=manifest.warningPolicies[label.warningPolicy]
    }
    if (ids.has(entry.id) || !['development', 'held-out'].includes(entry.split)) throw new Error('Invalid split or duplicate case')
    ids.add(entry.id)
    const document = fixture(entry.input)
    if (!validateNormalizedDocument(document).ok) throw new Error(`Invalid document: ${entry.id}`)
    for (const [map, key] of [[families, entry.family], [hashes, document.sourceHash]]) {
      if (map.has(key) && map.get(key) !== entry.split) throw new Error('Held-out source leakage')
      map.set(key, entry.split)
    }
    if (!entry.annotation?.reviewed || !Number.isFinite(entry.annotation.offlineCorrectionSeconds) || !entry.offlineAttempts.length) throw new Error('Missing manual annotations')
    const golden = fixture(entry.golden)
    if(!validateExtraction(entry.domain, golden).ok) throw new Error('Invalid annotated golden')
    for (const category of ['numeric', 'conditions', 'associations']) for (const label of entry.labels[category]) {
      if (!equal(pointer(golden, label.path), label.value)) throw new Error('Golden/label mismatch')
    }
  }
  if (!manifest.cases.some(c => c.split === 'held-out' && c.domain === 'diet') || !manifest.cases.some(c => c.split === 'held-out' && c.domain === 'workout')) throw new Error('Unbalanced held-out')
  return manifest
}

export const offlineConfig = () => readProviderConfig({ IMPORT_PROVIDER: 'openai', IMPORT_MODEL: 'synthetic-evaluation-v1', IMPORT_PROMPT_VERSION,
  IMPORT_MAX_OUTPUT_TOKENS: '16000', IMPORT_RETRY_MAX_OUTPUT_TOKENS: '24000', OPENAI_API_KEY: 'synthetic-offline-never-sent' }).config

/** Injected transport serves immutable HTTP recordings. It has no fetch path. */
export function recordedTransport(recording) {
  return async (_url, init) => {
    if (init.signal.aborted) throw new Error('Aborted synthetic request')
    if (recording.transportError) throw new Error('Synthetic transport failure')
    const body = structuredClone(recording.body)
    const request = JSON.parse(init.body)
    const payload = JSON.parse(request.input[0].content[0].text.split('\n').slice(1).join('\n'))
    const blockIds = new Set(payload.blocks.map(block => block.id))
    for (const message of body?.output ?? []) for (const content of message.content ?? []) {
      if (content.type !== 'output_text') continue
      try {
        const value = JSON.parse(content.text)
        // Legacy faults with unknown sources keep their historical validator-level behavior.
        // Compact unknown-source rejection has independent transport tests.
        if (validateExtraction(value.kind, value).ok && value.evidence.every(e => e.spans.every(s => blockIds.has(s.blockId)))) content.text = JSON.stringify(compactExtraction(value))
      } catch { /* Preserve intentionally malformed recordings. */ }
    }
    return new Response(JSON.stringify(body), { status: recording.httpStatus, headers: recording.headers })
  }
}

const positive = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max
export function validateRealConfig(config, env, today = new Date().toISOString().slice(0, 10)) {
  const provider = readProviderConfig(env)
  if (!provider.enabled || env.IMPORT_TEST_TRANSPORT || config?.enabled !== true || config.authorization?.paidCalls !== true || typeof config.authorization?.reference !== 'string' || !config.authorization.reference.trim()) throw new Error('Real evaluation disabled: explicit authorization, server secrets and budget required')
  const model = provider.config.profiles.standard.model
  if (provider.config.profiles.retry.model !== model || !Array.isArray(config.allowedModels) || !config.allowedModels.includes(model)) throw new Error('Model not authorized')
  const price = config.prices?.[model]
  if (!price || price.currency !== 'USD' || price.verifiedOn !== today || !/^https:\/\/(?:developers\.openai\.com|openai\.com)\//.test(price.source ?? '') || !positive(price.inputMicrosPerMillion, 100_000_000) || !positive(price.outputMicrosPerMillion, 1_000_000_000)) throw new Error('Verify explicit model prices today before execution')
  if (!positive(config.maxSpendMicros, 2_000_000) || !positive(config.maxCalls, 250) || !positive(config.maxInputTokens, 200_000) || !positive(config.framingTokens, 10_000) || !positive(config.criticalRepetitions, 5) || config.criticalRepetitions < 3) throw new Error('Invalid bounded budget/repetitions')
  return { provider: provider.config, price }
}

export function reserveAttempt(budget, prepared, price, spent, calls) {
  const input = conservativeInputTokens(prepared.serializedRequest, budget.framingTokens)
  const reserve = estimateCostMicros(input, prepared.maxOutputTokens, price.inputMicrosPerMillion, price.outputMicrosPerMillion)
  if (input > budget.maxInputTokens || calls >= budget.maxCalls || spent + reserve > budget.maxSpendMicros) throw new Error('Evaluation budget/token limit reached before dispatch')
  return reserve
}

export async function evaluateAttempt(entry, document, config, transport, now) {
  let log
  const provider = createOpenAIProvider(config, { ...(transport ? { transport } : {}), ...(now ? { now } : {}), logger: event => { log = event } })
  const request = { kind: entry.domain, document, schemaId: extractionSchemaIds[entry.domain], promptVersion: config.promptVersion, profile: entry.profile ?? 'standard', signal: new AbortController().signal }
  const prepared = provider.prepare(request)
  return { prepared, async send() {
    try {
      const value = await prepared.send(request.signal)
      return { status: value.status, data: value.data, model: value.model, usage: { inputTokens: value.inputTokens, outputTokens: value.outputTokens, reasoningTokens: value.reasoningTokens }, latencyMs: log.latencyMs }
    } catch (error) {
      if (!error.code) throw error
      return { status: error.code, delivery: error.delivery, retryAfterSeconds: error.retryAfterSeconds, data: null, model: config.profiles[request.profile].model, usage: error.usage, latencyMs: log?.latencyMs ?? null }
    }
  } }
}

export function summarize(rows) {
  const sum = (list, fn) => list.reduce((n, row) => n + fn(row), 0)
  return Object.fromEntries(['development', 'held-out'].map(split => {
    const group = rows.filter(row => row.split === split)
    const latencies = group.flatMap(r => r.attempts.map(a => a.latencyMs).filter(n => Number.isFinite(n))).sort((a,b)=>a-b)
    const outcomes = {}
    for(const attempt of group.flatMap(r=>r.attempts)) outcomes[attempt.status]=(outcomes[attempt.status]??0)+1
    return [split, {
      runs: group.length, cases: new Set(group.map(r => r.id)).size,
      numeric: { correct: sum(group, r => r.score.numeric.correct), total: sum(group, r => r.score.numeric.total) },
      associations: { correct: sum(group, r => r.score.associations.correct), total: sum(group, r => r.score.associations.total) },
      conditions: { correct: sum(group, r => r.score.conditions.correct), total: sum(group, r => r.score.conditions.total) },
      omitted: sum(group, r => r.score.omissions.omitted), unflaggedOmissions: sum(group, r => r.score.omissions.unflagged),
      criticalErrors: sum(group, r => r.score.criticalErrors.observed), unflaggedCriticalErrors: sum(group, r => r.score.criticalErrors.unflagged),
      reviewable: sum(group, r => Number(r.score.reviewable)), exactExtractions: sum(group, r => Number(r.score.exactExtraction)),
      attempts: sum(group, r => r.attempts.length), latencyMs: sum(group, r => r.attempts.reduce((s, a) => s + (a.latencyMs ?? 0), 0)),
      latencyDistributionMs: { median: latencies[Math.floor(latencies.length/2)]??null, p95: latencies[Math.max(0,Math.ceil(latencies.length*0.95)-1)]??null, max:latencies.at(-1)??null }, outcomes,
      inputTokens: sum(group, r => r.attempts.reduce((s, a) => s + (a.usage?.inputTokens ?? 0), 0)), outputTokens: sum(group, r => r.attempts.reduce((s, a) => s + (a.usage?.outputTokens ?? 0), 0)),
      unknownUsageAttempts: sum(group, r => r.attempts.filter(a => a.usage?.inputTokens == null || a.usage?.outputTokens == null).length),
      accountedCostMicros: sum(group, r => r.attempts.reduce((s, a) => s + a.accountedCostMicros, 0)),
      correctionSeconds: sum(group, r => r.correctionSeconds ?? 0), missingCorrectionTimes: group.filter(r => r.correctionSeconds == null).length,
    }]
  }))
}

export function modelGates(rows, manifest, mode) {
  const held = rows.filter(r => r.split === 'held-out')
  const covered = manifest.cases.every(c => rows.filter(r => r.id === c.id).length >= (c.critical ? 3 : 1))
  const evaluated = mode === 'real' && covered && held.length > 0
  return {
    realCorpus: evaluated ? 'PASS' : 'OPEN',
    noUnflaggedCriticalErrors: evaluated ? (held.every(r => r.score.criticalErrors.unflagged === 0) ? 'PASS' : 'FAIL') : 'OPEN',
    noUnflaggedOmissions: evaluated ? (held.every(r => r.score.omissions.unflagged === 0) ? 'PASS' : 'FAIL') : 'OPEN',
    reviewAvailable: evaluated ? (held.every(r => r.score.reviewable) ? 'PASS' : 'FAIL') : 'OPEN',
    manualCorrectionMeasured: evaluated && rows.every(r => r.correctionSeconds !== null && typeof r.acceptedByReviewer === 'boolean') ? 'PASS' : 'OPEN',
    iphone: 'OPEN', cloudDeployment: 'OPEN',
  }
}

export const versions = () => ({ scorer: EVALUATION_VERSION, prompt: IMPORT_PROMPT_VERSION, validator: VALIDATION_RULES_VERSION,
  providerFormat: PROVIDER_FORMAT_VERSION, codec: digest(readFileSync('supabase/functions/_shared/import/compact.ts')),
  schema: extractionSchemaIds, mapping: { workout: digest(readFileSync('src/import/mapping/workout.ts')), diet: digest(readFileSync('src/import/mapping/diet.ts')) },
  adapter: digest(readFileSync('supabase/functions/_shared/import/openai-provider.ts')) })
