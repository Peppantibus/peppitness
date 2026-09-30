import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createJobsAdapter, prepareImportJob, parseServerJob, type AnalysisProfile, type ServerJob,
} from '../supabase/functions/_shared/import/jobs.ts'
import { validateImportJobResult } from '../src/import/contracts/jobs.ts'
import * as canonical from '../src/import/mapping/canonical.ts'
import * as bridge from '../supabase/functions/_shared/import/canonical.ts'

const owner = '11111111-1111-4111-8111-111111111111'
const requestId = '22222222-2222-4222-8222-222222222222'
const read = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/import/${file}.json`, import.meta.url), 'utf8'))
const request = () => ({ analysisRequestId: requestId, kind: 'workout', expectedSchemaVersion: '1.0', normalizedDocument: read('documents/workout-incomplete') })
const profile: AnalysisProfile = { promptVersion: 'synthetic/1', provider: 'synthetic', model: 'synthetic', rulesVersion: 'rules/1' }
const usage = { providerCalls: 0, inputTokens: null, outputTokens: null, reasoningTokens: null, cached: false, costEstimate: null }
const stored = (): ServerJob => ({
  job: { jobId: owner, analysisRequestId: requestId, kind: 'workout', status: 'running', extraction: null,
    validationIssues: [], usageSummary: usage, error: null, expiresAt: '2026-10-06T20:00:00.000Z' },
  revision: 1, draftRevision: 1, leaseToken: requestId, leaseExpiresAt: '2026-09-29T20:02:00Z',
  attemptCount: 0, providerOutcome: 'not_started', created: true,
})

test('jobs: hash completo server, sensibile a contenuto/dominio/schema e mai sourceHash solo', async () => {
  const input = request()
  const first = await prepareImportJob(owner, input, profile)
  assert.equal(first.p_normalized_hash, await canonical.normalizedHash(input.normalizedDocument))
  assert.equal(first.p_input_hash, await canonical.canonicalHash({ hash: 'peppitness.analysis-input.v1', request: input }))
  input.normalizedDocument.blocks[0].text = 'Altro titolo'
  const changed = await prepareImportJob(owner, input, profile)
  assert.notEqual(changed.p_input_hash, first.p_input_hash)
  assert.notEqual(changed.p_normalized_hash, first.p_normalized_hash)
  assert.equal(changed.p_document.sourceHash, first.p_document.sourceHash)
  const diet = await prepareImportJob(owner, { ...request(), kind: 'diet' }, profile)
  assert.notEqual(diet.p_input_hash, first.p_input_hash)
  assert.equal(diet.p_normalized_hash, first.p_normalized_hash)
  await assert.rejects(prepareImportJob(owner, { ...request(), expectedSchemaVersion: 'future' }, profile))
})

test('jobs: replay indipendente dal profilo server, cache include tutte le versioni', async () => {
  const first = await prepareImportJob(owner, request(), profile)
  for (const key of ['promptVersion', 'provider', 'model', 'rulesVersion'] as const) {
    const next = await prepareImportJob(owner, request(), { ...profile, [key]: 'next' })
    assert.equal(next.p_input_hash, first.p_input_hash)
    assert.notDeepEqual(next.p_versions, first.p_versions)
  }
  const otherOwner = await prepareImportJob(requestId, request(), profile)
  assert.notEqual(first.p_owner_id, otherOwner.p_owner_id)
  assert.equal(first.p_input_hash, otherOwner.p_input_hash, 'owner appartiene alla chiave DB, non al documento')
})

test('jobs: snapshot prima degli await, proprietà extra/client hash e profili assenti respinti', async () => {
  const input = request(), config = { ...profile }
  const pending = prepareImportJob(owner, input, config)
  input.normalizedDocument.blocks[0].text = 'Mutato durante hash'
  config.model = 'changed'
  const args = await pending
  assert.notEqual(args.p_document.blocks[0]?.text, input.normalizedDocument.blocks[0].text)
  assert.equal(args.p_versions.model, profile.model)
  for (const extra of [{ ownerId: requestId }, { normalizedHash: '0'.repeat(64) }, { model: 'client' }]) {
    await assert.rejects(prepareImportJob(owner, { ...request(), ...extra }, profile))
  }
  await assert.rejects(prepareImportJob('invalid', request(), profile))
  await assert.rejects(prepareImportJob(owner, request(), { ...profile, model: '' }))
  await assert.rejects(prepareImportJob(owner, request(), { ...profile, provider: undefined } as unknown as AnalysisProfile))
})

test('jobs: validazione prima del trasporto, nessun risultato quasi valido o messaggio grezzo', async () => {
  const calls: unknown[] = []
  const adapter = createJobsAdapter(async (name, args) => { calls.push({ name, args }); return stored() })
  await assert.rejects(adapter.create(owner, { ...request(), owner }, profile))
  await assert.rejects(adapter.complete(owner, stored(), { extraction: read('extractions/diet-spec-example'), validationIssues: [], usageSummary: usage }))
  await assert.rejects(adapter.fail(owner, stored(), 'limit_exceeded'))
  assert.equal(calls.length, 0)
  await adapter.complete(owner, stored(), { extraction: read('extractions/workout-incomplete'), validationIssues: [], usageSummary: usage })
  const call = calls[0] as { name: string; args: Record<string, unknown> }
  assert.equal(call.name, 'complete_import_job')
  assert.equal(call.args.p_owner_id, owner)
  assert.equal(call.args.p_expected_revision, 1)
  assert.equal(call.args.p_expected_draft_revision, 1)
  assert.equal(call.args.p_lease_token, requestId)
  assert.equal(Object.hasOwn(call.args, 'provider'), false)
})

test('jobs: envelope server separato dal protocollo pubblico, errori SQL propagati', async () => {
  assert.equal(validateImportJobResult(stored().job).ok, true)
  assert.equal(validateImportJobResult(stored()).ok, false)
  assert.deepEqual(parseServerJob(stored()), stored())
  for (const mutation of [{ revision: 0 }, { draftRevision: 0 }, { attemptCount: -1 }, { leaseToken: '' }, { providerOutcome: 'future' }, { job: { ...stored().job, status: 'ready' } }]) {
    assert.throws(() => parseServerJob({ ...stored(), ...mutation }))
  }
  const conflict = Object.assign(new Error('Import revision conflict'), { code: 'PT409' })
  const adapter = createJobsAdapter(async () => { throw conflict })
  await assert.rejects(adapter.touch(owner, stored()), error => error === conflict)
  const missing = createJobsAdapter(async () => null)
  assert.equal(await missing.find(owner, requestId), null)
  await assert.rejects(missing.create(owner, request(), profile))
})

test('jobs: ponte canonical unico e tentativi non esposti dall’adapter prima del ledger', () => {
  assert.equal(bridge.normalizedHash, canonical.normalizedHash)
  assert.equal(bridge.canonicalHash, canonical.canonicalHash)
  const api = createJobsAdapter(async () => stored())
  assert.deepEqual(Object.keys(api).sort(), ['complete', 'create', 'expire', 'fail', 'find', 'touch'])
})
