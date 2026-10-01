import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import {
  loadCorpus, fixture, scoreCase, validateRealConfig, reserveAttempt, offlineConfig, versions,
} from '../scripts/lib/import-evaluation.mjs'
import { runOffline, reportFor, compareReports, scoreRealRecords } from '../scripts/import-evaluate.mjs'

const corpus = loadCorpus()
const entry = (id: string) => corpus.cases.find((c: any) => c.id === id)!
const observed = (id: string) => {
  const c = entry(id), response = fixture(c.offlineAttempts.at(-1).response)
  return { c, document: fixture(c.input), data: JSON.parse(response.body.output[0].content[0].text) }
}

test('evaluation corpus: 42 manual source cases, family split isolated, both domains held out; no E2E truth', () => {
  assert.equal(corpus.cases.length, 42)
  const hashes = new Map<string, string>(), families = new Map<string, string>()
  for (const c of corpus.cases) {
    assert.equal(c.annotation.reviewed, true)
    assert.equal(c.annotation.timingKind, 'manual synthetic scenario estimate; not measured user time')
    assert.doesNotMatch(JSON.stringify(c), /fixtures\/import\/e2e|synthetic-e2e/)
    for (const [map, key] of [[hashes, fixture(c.input).sourceHash], [families, c.family]] as const) {
      if (map.has(key)) assert.equal(map.get(key), c.split)
      map.set(key, c.split)
    }
    assert.ok(c.expectedProblems !== null)
    for(const a of c.offlineAttempts) assert.match(fixture(a.response).provenance, /not a real model/)
  }
  assert.equal(corpus.cases.filter((c: any) => c.split === 'held-out').length, 11)
  for(const domain of ['diet','workout']) assert.ok(corpus.cases.some((c: any) => c.domain === domain && c.split === 'held-out'))
  const leaked = structuredClone(corpus)
  leaked.cases.find((c: any) => c.id === 'workout-wrong-row-number').split = 'held-out'
  assert.throws(() => loadCorpus(leaked), /Held-out source leakage/)
})

test('scorer: clean truth, real number from wrong row, association with wrong source, missing food without warning', () => {
  const clean = observed('diet-alternatives-additions')
  const good = scoreCase(clean.c, clean.document, clean.data)
  assert.equal(good.numeric.correct, good.numeric.total)
  assert.equal(good.associations.correct, good.associations.total)
  assert.equal(good.conditions.correct, good.conditions.total)
  assert.equal(good.criticalErrors.observed, 0)
  const wrong = observed('workout-wrong-row-number')
  const scored = scoreCase(wrong.c, wrong.document, wrong.data)
  assert.equal(scored.numeric.errors.length, 1)
  assert.equal(scored.numeric.errors[0].path, '/sessions/0/exercises/0/sets')
  assert.equal(scored.numeric.errors[0].signaled, true)
  const swapped = structuredClone(clean.data)
  swapped.evidence.find((e: any) => e.path === '/days/0/meals/0/foods/0/name').spans[0].blockId = 't:1:r:3'
  assert.equal(scoreCase(clean.c, clean.document, swapped).associations.errors.length, 1)
  const omitted = structuredClone(clean.data)
  omitted.days[0].meals[0].foods.pop()
  omitted.evidence = omitted.evidence.filter((e: any) => !e.path.startsWith('/days/0/meals/0/foods/1'))
  const missing = scoreCase(clean.c, clean.document, omitted)
  assert.equal(missing.omissions.omitted, 1)
  assert.equal(missing.omissions.unflagged, 1, 'other warnings on the meal must not conceal a missing food')
  assert.equal(scoreCase(clean.c,clean.document,{evidence:{wrong:'shape'}}).validation.status,'rejected')
})

test('scorer: local/global conditions and unexpected base foods are distinct from numerical correctness', () => {
  const base = observed('diet-alternatives-additions')
  const bad = structuredClone(base.data)
  bad.days[0].meals[2].additions = []
  bad.globalRules = []
  const scored = scoreCase(base.c, base.document, bad)
  assert.equal(scored.numeric.errors.length, 0)
  assert.ok(scored.conditions.errors.length >= 2)
  const injected = observed('diet-conditional-in-base')
  const extra = scoreCase(injected.c, injected.document, injected.data)
  assert.equal(extra.unexpected.length, 1)
  assert.equal(extra.unexpected[0].signaled, true)
})

test('real configuration: absent secrets/authorization/budget/prices and foreign retry model fail before transport', () => {
  const today = '2026-09-30'
  const config: any = { enabled: true, authorization: { paidCalls: true, reference: 'synthetic-test-only' }, allowedModels: ['synthetic-evaluation-v1'],
    maxSpendMicros: 10000, maxCalls: 10, maxInputTokens: 100000, framingTokens: 1024, criticalRepetitions: 3,
    prices: { 'synthetic-evaluation-v1': { currency: 'USD', verifiedOn: today, source: 'https://openai.com/api/pricing/', inputMicrosPerMillion: 100000, outputMicrosPerMillion: 500000 } } }
  const env = { IMPORT_PROVIDER: 'openai', IMPORT_MODEL: 'synthetic-evaluation-v1', IMPORT_MAX_OUTPUT_TOKENS: '16000', IMPORT_PROMPT_VERSION: offlineConfig().promptVersion, OPENAI_API_KEY: 'synthetic-test-only' }
  assert.throws(() => validateRealConfig(config, {}, today))
  for (const change of [{ enabled: false }, { enabled:'false' }, { maxSpendMicros: 0 }, { maxCalls: 251 }, { criticalRepetitions: 1 }, { authorization: null }, { allowedModels: [] }, {allowedModels:env.IMPORT_MODEL}, { prices: {} }]) assert.throws(() => validateRealConfig({ ...config, ...change }, env, today))
  assert.throws(() => validateRealConfig(config, { ...env, IMPORT_RETRY_MODEL: 'other' }, today))
  assert.throws(() => validateRealConfig(config, { ...env, IMPORT_TEST_TRANSPORT: 'synthetic' }, today))
  assert.throws(() => validateRealConfig(config, env, '2026-10-01'))
  assert.equal(validateRealConfig(config, env, today).provider.profiles.standard.model, env.IMPORT_MODEL)
  const prepared = { serializedRequest: 'abc', maxOutputTokens: 1000 }
  const price = config.prices[env.IMPORT_MODEL]
  assert.throws(() => reserveAttempt({ ...config, maxInputTokens: 2 }, prepared, price, 0, 0))
  assert.throws(() => reserveAttempt(config, prepared, price, 0, config.maxCalls))
  assert.throws(() => reserveAttempt(config, prepared, price, config.maxSpendMicros, 0))
})

test('offline: zero network, exact repeated reports, refusals/429/retry/incomplete/unknown usage/uncertain cost counted', async () => {
  const previous = globalThis.fetch
  let network = 0
  globalThis.fetch = (() => { network++; throw new Error('Forbidden network') }) as typeof fetch
  try {
    const a = await runOffline(), b = await runOffline()
    assert.deepEqual(a, b)
    assert.equal(network, 0)
    assert.equal(a.rows.length, 124)
    assert.ok(Object.values(a.releaseGates).every(g => g === 'OPEN'))
    const retry = a.rows.find((r: any) => r.id === 'diet-global-training')!
    assert.deepEqual(retry.attempts.map((t: any) => t.status), ['rate_limited','completed'])
    assert.equal(retry.attempts[0].accountedCostMicros, 0)
    const unknown = a.rows.find((r: any) => r.id === 'diet-missing-quantity')!
    assert.equal(unknown.attempts[0].costKind, 'conservative_reservation')
    const uncertain = a.rows.find((r: any) => r.id === 'workout-timeout')!
    assert.equal(uncertain.attempts.length, 1)
    assert.equal(uncertain.attempts[0].delivery, 'uncertain')
    assert.ok(uncertain.attempts[0].accountedCostMicros > 0)
    assert.match(a.interpretation, /do not establish real model quality/)
    assert.equal(compareReports([a,b]).chosenModel, null)
    assert.equal(a.costPerAcceptedImportMicros, null)
    const incomplete = reportFor(corpus, a.rows.slice(0,1), 'real')
    assert.equal(incomplete.releaseGates.realCorpus, 'OPEN')
    assert.throws(() => scoreRealRecords(corpus, { mode: 'real', corpusHash: a.corpusHash, versions: { ...versions(), prompt: 'other' }, rows: [] }))
  } finally { globalThis.fetch = previous }
})

test('CLI: no default paid mode; disabled real template exits before network; private results only', () => {
  for(const args of [[],['--offline','--real'],['--real','--config','tests/fixtures/import/evaluation/real-config.example.json']]) {
    const result = spawnSync(process.execPath,['scripts/import-evaluate.mjs',...args],{encoding:'utf8'})
    assert.equal(result.status, 1)
    assert.doesNotMatch(result.stderr, /sk-|Bearer|api\.openai\.com/)
  }
  const template = JSON.parse(readFileSync('tests/fixtures/import/evaluation/real-config.example.json','utf8'))
  assert.equal(template.enabled, false)
  assert.equal(template.authorization.paidCalls, false)
  assert.deepEqual(template.allowedModels, [])
  assert.deepEqual(template.prices, {})
})

test('real report gates and candidate selection: whole held-out/repetitions, measured correction, cost including rejected imports and retries', () => {
  const rows = corpus.cases.flatMap((c: any) => Array.from({length:c.critical?3:1},(_,i)=>{
    const data = fixture(c.golden)
    return {id:c.id,split:c.split,domain:c.domain,repetition:i+1,data,status:'completed',
      score:scoreCase(c,fixture(c.input),data),correctionSeconds:10,acceptedByReviewer:c.id!=='workout-wrong-domain',
      attempts:[{status:'completed',model:'test-a',usage:{inputTokens:10,outputTokens:10},costKind:'usage_at_profile_price',accountedCostMicros:20,latencyMs:1}]}
  }))
  const a = reportFor(corpus,rows,'real',{model:'test-a',providerModelDrift:false})
  const b = reportFor(corpus,rows.map((r: any)=>({...r,attempts:[...r.attempts.map((a: any)=>({...a,model:'test-b'})),{status:'incomplete',model:'test-b',costKind:'usage_at_profile_price',accountedCostMicros:50,latencyMs:1,usage:{inputTokens:10,outputTokens:10}}]})),'real',{model:'test-b',providerModelDrift:false})
  assert.equal(a.releaseGates.noUnflaggedCriticalErrors,'PASS')
  assert.equal(a.releaseGates.manualCorrectionMeasured,'PASS')
  assert.equal(a.releaseGates.cloudDeployment,'OPEN')
  assert.equal(compareReports([a,b]).chosenModel,'test-a')
  assert.ok(a.costPerAcceptedImportMicros>20,'rejected-document costs remain counted')
  assert.equal(compareReports([{...a,providerModelDrift:true},b]).chosenModel,'test-b')
  const missing = reportFor(corpus,rows.filter((r: any)=>r.repetition===1),'real')
  assert.equal(missing.releaseGates.realCorpus,'OPEN')
  const unmeasured = reportFor(corpus,rows.map((r: any)=>({...r,correctionSeconds:null})),'real')
  assert.equal(unmeasured.releaseGates.manualCorrectionMeasured,'OPEN')
})
