import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { threeSessionFixture } from './fixtures/import/recovery/workout-three-sessions.ts'
import { createReviewDraft, sequentialLocalIds } from '../src/import/review/draft.ts'
import { applyCatalogBatch, applyScalarBatch, applyScopeBatch, catalogBatchOffers, scalarBatchGroups } from '../src/import/review/batch.ts'
import { setField, verifyDraft } from '../src/import/review/decisions.ts'
import { validateDraft } from '../src/import/validation/validate.ts'
import type { CatalogSnapshot } from '../src/import/matching/exercises.ts'

function setup() {
  const { document, extraction } = threeSessionFixture()
  const draft = createReviewDraft({ kind: 'workout', extraction, proposalId: '90000000-0000-4000-8000-000000000009', jobId: null,
    source: { sourceHash: document.sourceHash, readerVersion: document.readerVersion, textNormalizationVersion: 'peppitness.text-normalization.v1' }, localIds: sequentialLocalIds() })
  return { document, draft }
}
test('batch: one explicit scalar choice records 18 individual decisions; source ranges stay immutable', () => {
  const { draft } = setup()
  const group = scalarBatchGroups(draft).find(g => g.field === 'restSeconds')!
  assert.equal(group.items.length, 18)
  const next = applyScalarBatch(draft, group, 100)
  assert.equal(next.decisions.length, 18)
  assert.ok(next.decisions.every(d => d.op === 'set' && d.reason === 'timer_choice'))
  assert.ok(next.current.filter(i => i.collection === 'exercises').every(i => JSON.stringify((i.values as any).restSeconds) === JSON.stringify({ min: 100, max: 100 })))
  assert.deepEqual(draft.proposal.extraction.sessions[0]!.exercises[0]!.restSeconds, { min: 90, max: 120 })
  assert.equal(verifyDraft(next).ok, true)
  assert.throws(() => applyScalarBatch(draft, group, 150))
  assert.throws(() => applyScalarBatch(draft, group, 100.5))
  assert.throws(() => applyScalarBatch(next, group, 100))
  const changed = setField(draft, group.items[17]!.localId, 'restSeconds', { min: 95, max: 110 })
  assert.throws(() => applyScalarBatch(changed as typeof draft, group, 100))
  assert.equal(draft.decisions.length, 0, 'a late failure never mutates the input')
})
test('batch: phase scope preserves the delayed optional condition and leaves prescriptions unresolved', () => {
  const { document, draft } = setup()
  const rule = draft.current.find(i => i.collection === 'complexRules')!
  const original = (rule.values as any).text
  const next = applyScopeBatch(draft, document, [rule.localId], 'Importo le settimane 1–4; gestisco il passaggio a mano.')
  assert.equal(next.decisions.length, 2)
  assert.ok((next.current.find(i => i.localId === rule.localId)!.values as any).text.startsWith(original))
  const exercise = next.current.filter(i => i.collection === 'exercises').at(-1)!
  assert.equal((exercise.values as any).sets, null)
  assert.equal((exercise.values as any).optionalSets, null)
  assert.ok(validateDraft(document, next).issues.some(i => i.code === 'sets_missing'))
  assert.equal(verifyDraft(next).ok, true)
  assert.throws(() => applyScopeBatch(draft, document, [rule.localId], ' '))
})
test('batch: exact unambiguous catalog matches require explicit review; revisions/conflicts/incomplete reads stop adoption', () => {
  const { draft } = setup()
  const item = draft.current.find(i => i.collection === 'exercises')!
  const snapshot: CatalogSnapshot = JSON.parse(readFileSync('tests/fixtures/import/matching/catalog.json', 'utf8'))
  const catalog = { ...snapshot, shared: [], personal: [snapshot.personal[0]!] }
  const renamed = setField(draft, item.localId, 'name', 'Squat') as typeof draft
  const offers = catalogBatchOffers(renamed, catalog)
  assert.equal(offers.length, 1)
  assert.equal(renamed.current.find(i => i.localId === item.localId)!.catalog, null)
  const next = applyCatalogBatch(renamed, catalog, offers)
  assert.equal(next.current.find(i => i.localId === item.localId)!.catalog?.source, 'existing')
  assert.equal(verifyDraft(next).ok, true)
  const changed = { ...catalog, personal: catalog.personal.map(row => ({ ...row, revision: row.revision + 1 })) }
  assert.throws(() => applyCatalogBatch(renamed, changed, offers))
  assert.deepEqual(catalogBatchOffers(renamed, { ...catalog, complete: false }), [])
  const conflict = setField(renamed, item.localId, 'equipment', 'macchina') as typeof draft
  assert.deepEqual(catalogBatchOffers(conflict, catalog), [])
  assert.throws(() => applyCatalogBatch(conflict, catalog, offers))
  assert.deepEqual(catalogBatchOffers(renamed, snapshot), [], 'multiple exact names need a separate choice')
})
