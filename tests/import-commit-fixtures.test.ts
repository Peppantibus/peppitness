import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { importCommitFixturesInclude, renderImportCommitFixtures } from '../scripts/generate-import-commit-fixtures.mjs'
import { catalogSeed, commitFixtureCases, instantiateCommand } from '../scripts/lib/import-commit-fixtures.mjs'
import { validateCommitCommand, provisionalExerciseRefs } from '../src/import/contracts/index.ts'

type Json = any
const read = (path: string): Json => JSON.parse(readFileSync(new URL(`./fixtures/import/${path}`, import.meta.url), 'utf8'))
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const prefixed = (prefix: string, value: unknown) => JSON.parse(JSON.stringify(value).replace(UUID, id => `${prefix}${id.slice(8)}`))

test('19/20: include pgTAP dei comandi generato dai mapper 09/10', async () => {
  const included = readFileSync(new URL(`../${importCommitFixturesInclude}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  assert.equal(included, await renderImportCommitFixtures(), 'rigenerare con node scripts/generate-import-commit-fixtures.mjs')
})

test('19/20: comandi del corpus validi, payload = golden 09/10 con UUID distinti per caso', () => {
  const cases = commitFixtureCases()
  assert.deepEqual(cases.map(c => c.id), ['workout-spec-example', 'workout-incomplete', 'workout-ranges-unicode', 'workout-abc-no-days', 'workout-out-of-bounds',
    'workout-partially-interpretable', 'workout-catalog', 'diet-spec-example', 'diet-alternatives-additions', 'diet-reviewed-conditions'])
  for (const [index, c] of cases.entries()) {
    assert.ok(validateCommitCommand(c.kind, c.command).ok, c.id)
    assert.equal(c.command.provenance.analysis.source.sourceHash, c.document.sourceHash, c.id)
    assert.ok(c.command.provenance.items.every((item: Json) => item.sourcePointer === null || typeof item.sourcePointer === 'string'), c.id)
    if (index < 6) assert.deepEqual(c.command.payload.resolved, prefixed(`1900${String(index + 1).padStart(4, '0')}`, read(`mapping/workout/${c.id}.json`).expected.resolved), c.id)
  }
  const byId = Object.fromEntries(cases.map(c => [c.id, c]))
  // Golden 10: piano 80000000-…-002, giornate/pasti 010 + indice; qui con il prefisso del caso.
  const diet = (id: string, golden: string, prefix: string) => {
    const plan = read(`mapping/diet/${golden}.json`)
    assert.deepEqual(byId[id].command.payload.resolved.plan, prefixed(prefix, plan.expected ?? plan), id)
  }
  diet('diet-spec-example', 'diet-spec-example', '20000011')
  diet('diet-alternatives-additions', 'diet-alternatives-additions', '20000012')
  diet('diet-reviewed-conditions', 'reviewed-conditions', '20000013')
  const catalog = byId['workout-catalog'].command.payload.resolved.catalog
  assert.deepEqual(catalog.map((b: Json) => b.choice.source), ['existing', 'shared'])
  assert.equal(catalog[0].choice.personalId, catalogSeed.existing[0]!.id)
  assert.equal(catalog[1].choice.templateId, catalogSeed.shared[0]!.id)
})

test('19/20: copia per account reale con UUID nuovi, salvo quelli conservati', () => {
  const source = commitFixtureCases().find(c => c.id === 'workout-catalog')!.command
  const job = '11111111-2222-4333-8444-555555555555'
  const copy = instantiateCommand(source, { [source.provenance.analysis.jobId]: job })
  assert.ok(validateCommitCommand('workout', copy).ok)
  assert.equal(copy.provenance.analysis.jobId, job)
  assert.notEqual(copy.requestId, source.requestId)
  assert.notEqual(copy.payload.resolved.planId, source.payload.resolved.planId)
  assert.equal(provisionalExerciseRefs(copy.payload.resolved).size, provisionalExerciseRefs(source.payload.resolved).size)
  assert.deepEqual(JSON.parse(JSON.stringify(copy).replace(UUID, 'x')), JSON.parse(JSON.stringify(source).replace(UUID, 'x')))
})

