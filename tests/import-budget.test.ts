import test from 'node:test'
import assert from 'node:assert/strict'
import {
  estimateCostMicros, conservativeInputTokens, normalizeUsage, usageKnown, createBudgetAdapter,
  runBudgetedAttempt, type BudgetCall, type BudgetReservation, type BudgetRpc, type ProviderUsage,
} from '../supabase/functions/_shared/import/budget.ts'
import { sha256Hex } from '../supabase/functions/_shared/import/canonical.ts'

const owner = '11111111-1111-4111-8111-111111111111'
const rid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const jobId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const unknown = { inputTokens: null, outputTokens: null, reasoningTokens: null }
const call = (): BudgetCall => ({ ownerId: owner, reservationId: rid, serializedRequest: '{"prompt":"synthetic","schema":{},"segments":[]}', maxOutputTokens: 10,
  job: { job: { jobId, analysisRequestId: rid, kind: 'workout', status: 'running', extraction: null, validationIssues: [], error: null,
    expiresAt: '2026-10-06T20:00:00Z', usageSummary: { providerCalls: 0, ...unknown, cached: false, costEstimate: null } },
    revision: 1, draftRevision: 1, leaseToken: rid, leaseExpiresAt: '2026-09-29T20:02:00Z', attemptCount: 0, providerOutcome: 'not_started', created: true } })
async function reservation(): Promise<BudgetReservation> {
  return { reservationId: rid, jobId, attempt: null, state: 'reserved', requestHash: await sha256Hex(call().serializedRequest),
    inputUpperTokens: 10, maxOutputTokens: 10, provider: 'synthetic', model: 'synthetic', currency: 'USD',
    configVersion: 'test/1', priceVersion: 'price/1', reservedMicros: 30, actualMicros: null, sendGranted: false, job: call().job }
}
async function harness(failAt?: 'reserve' | 'dispatch') {
  const recorded: { name: string; args: Record<string, unknown> }[] = []
  const value = await reservation()
  let sent = false
  const rpc: BudgetRpc = async (name, args) => {
    recorded.push({ name, args })
    if ((name === 'reserve_import_budget' && failAt === 'reserve') || (name === 'dispatch_import_attempt' && failAt === 'dispatch')) throw new Error('Blocked before provider')
    if (name === 'reserve_import_budget') return structuredClone(value)
    if (name === 'dispatch_import_attempt') {
      const grant = !sent; sent = true
      return { ...value, state: 'sent', attempt: 1, sendGranted: grant }
    }
    if (name === 'reconcile_import_usage') {
      return { ...value, state: args.p_outcome === 'known' ? 'settled' : 'uncertain', attempt: 1, actualMicros: args.p_outcome === 'known' ? 13 : null }
    }
    return null
  }
  return { adapter: createBudgetAdapter(rpc), recorded }
}

test('budget: vettori interi condivisi SQL, arrotondamento conservativo e overflow', () => {
  for (const [i, o, pi, po, expected] of [[1, 1, 1, 1, 2], [100, 200, 1000000, 2000000, 500], [0, 0, 1, 1, 0], [5, 4, 1000000, 2000000, 13]]) {
    assert.equal(estimateCostMicros(i!, o!, pi!, po!), expected)
  }
  for (const bad of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => estimateCostMicros(bad, 0, 1, 1))
  assert.throws(() => estimateCostMicros(Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER, 1), /overflow/)
})

test('budget: stima UTF-8 comprende prompt/schema/segmenti e framing', () => {
  const body = JSON.stringify({ prompt: 'test', schema: { title: 'è' }, segments: ['α', 'β'] })
  assert.equal(conservativeInputTokens(body, 256), new TextEncoder().encode(body).length + 256)
  assert.ok(conservativeInputTokens(body, 0) > body.length)
  assert.throws(() => conservativeInputTokens('', 0))
  assert.throws(() => conservativeInputTokens(body, -1))
})

test('budget: usage parziale/assente resta ignoto, reasoning è incluso nel totale output', () => {
  assert.deepEqual(normalizeUsage(null), unknown)
  const partial = normalizeUsage({ inputTokens: 5, outputTokens: null, reasoningTokens: 3 })
  assert.equal(usageKnown(partial), false)
  const known = normalizeUsage({ inputTokens: 5, outputTokens: 4, reasoningTokens: 3 })
  assert.equal(usageKnown(known), true)
  assert.equal(estimateCostMicros(known.inputTokens!, known.outputTokens!, 1000000, 2000000), 13)
  assert.throws(() => normalizeUsage({ inputTokens: 0, outputTokens: 2, reasoningTokens: 3 }))
  assert.throws(() => normalizeUsage({ inputTokens: undefined } as unknown as ProviderUsage))
})

test('budget: provider mai chiamato se reserve o dispatch falliscono', async () => {
  for (const phase of ['reserve', 'dispatch'] as const) {
    const { adapter } = await harness(phase)
    let calls = 0
    await assert.rejects(runBudgetedAttempt(adapter, call(), async () => { calls++; return { value: null, usage: null } }))
    assert.equal(calls, 0)
  }
})

test('budget: ordine reserve-dispatch-provider-reconcile, body misurato e profilo dal DB', async () => {
  const { adapter, recorded } = await harness()
  const result = await runBudgetedAttempt(adapter, call(), async (permit, body) => {
    assert.deepEqual(recorded.map(x => x.name), ['reserve_import_budget', 'dispatch_import_attempt'])
    assert.equal(permit.sendGranted, true)
    assert.equal(permit.provider, 'synthetic')
    assert.equal(body, call().serializedRequest)
    return { value: 'synthetic result', usage: { inputTokens: 5, outputTokens: 4, reasoningTokens: 3 }, retryAfterSeconds: 30 }
  })
  assert.equal(result.status, 'completed')
  assert.equal(recorded[0]?.args.p_input_bytes, new TextEncoder().encode(call().serializedRequest).length)
  assert.equal(recorded[0]?.args.p_request_hash, await sha256Hex(call().serializedRequest))
  assert.equal(Object.hasOwn(recorded[0]!.args, 'price'), false)
  assert.deepEqual(recorded[2]?.args.p_usage, { inputTokens: 5, outputTokens: 4, reasoningTokens: 3 })
  assert.equal(recorded[2]?.args.p_outcome, 'known')
  assert.equal(recorded[2]?.args.p_retry_after_seconds, 30)
})

test('budget: replay concorrente non ripete callback (trasporto simulato; concorrenza DB separata)', async () => {
  const { adapter } = await harness()
  let calls = 0
  const invoke = async () => { calls++; return { value: null, usage: null } }
  const results = await Promise.all([runBudgetedAttempt(adapter, call(), invoke), runBudgetedAttempt(adapter, call(), invoke)])
  assert.equal(calls, 1)
  assert.equal(results.filter(x => x.status === 'not_dispatched').length, 1)
})

test('budget: timeout dopo invio mantiene incerto e non ritenta', async () => {
  const { adapter, recorded } = await harness()
  let calls = 0
  const result = await runBudgetedAttempt(adapter, call(), async () => { calls++; throw new Error('provider private content') })
  assert.equal(calls, 1)
  assert.equal(result.status, 'uncertain')
  assert.equal(result.reservation.reservedMicros, 30)
  assert.equal(result.reservation.actualMicros, null)
  assert.equal(recorded[2]?.args.p_outcome, 'uncertain')
  assert.deepEqual(recorded[2]?.args.p_usage, unknown)
  assert.equal(JSON.stringify(result).includes('provider private content'), false)
})

test('budget: validazione locale prima di RPC, null mai riconciliato come noto', async () => {
  const { adapter, recorded } = await harness()
  await assert.rejects(adapter.reconcile(owner, rid, 'known', null))
  await assert.rejects(adapter.reconcile(owner, rid, 'not_sent', null))
  await assert.rejects(adapter.reserve({ ...call(), maxOutputTokens: 0 }))
  assert.equal(recorded.length, 0)
})

test('budget: permesso per un altro body/job non consente invio', async () => {
  const row = await reservation()
  const adapter = createBudgetAdapter(async name => name === 'reserve_import_budget' ? row :
    { ...row, requestHash: '0'.repeat(64), state: 'sent', attempt: 1, sendGranted: true })
  let calls = 0
  await assert.rejects(runBudgetedAttempt(adapter, call(), async () => { calls++; return { value: null, usage: null } }), /mismatch/)
  assert.equal(calls, 0)
})
