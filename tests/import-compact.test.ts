import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compactExtraction, compactDocumentPayload, expandCompactExtraction, WORKOUT_RULE_TARGET_PATTERN } from '../supabase/functions/_shared/import/compact.ts'
import { strictProviderSchema, strictSchemaStats, strictSchemaLimits } from '../supabase/functions/_shared/import/openai-provider.ts'
import { analysisProfile } from '../supabase/functions/_shared/import/server-config.ts'
import { readProviderConfig } from '../supabase/functions/_shared/import/provider.ts'
import { IMPORT_PROMPT_VERSION, documentPayload, dietPromptExample } from '../supabase/functions/_shared/import/prompts.ts'
import { validateProposal } from '../src/import/validation/validate.ts'
import { validateExtraction, validateNormalizedDocument, type DietExtraction, type NormalizedDocument, type WorkoutExtraction } from '../src/import/contracts/index.ts'
import { threeSessionFixture } from './fixtures/import/recovery/workout-three-sessions.ts'

const fixture = (path: string) => JSON.parse(readFileSync(`tests/fixtures/import/${path}`, 'utf8'))
const autoQuotes = (value: WorkoutExtraction | DietExtraction) => {
  const encoded = compactExtraction(structuredClone(value))
  for (const group of encoded.evidence) for (const span of group.spans) span.quote = null
  return encoded
}

test('compact: every annotated golden round-trips without changing quotes, fields or validator findings', () => {
  for (const entry of fixture('evaluation/manifest.json').cases) {
    const document = fixture(entry.input), golden = fixture(entry.golden)
    const expanded = expandCompactExtraction(entry.domain, document, compactExtraction(golden))
    assert.deepEqual(expanded, golden, entry.id)
    assert.deepEqual(validateProposal(entry.domain, document, expanded), validateProposal(entry.domain, document, golden), entry.id)
  }
})

test('compact: strict provider schemas satisfy limits and use references instead of repeated field paths', () => {
  for (const kind of ['workout', 'diet'] as const) {
    const stats = strictSchemaStats(strictProviderSchema(kind))
    for (const key of Object.keys(stats) as (keyof typeof stats)[]) assert.ok(stats[key] <= strictSchemaLimits[key], key)
    const schema = strictProviderSchema(kind) as any
    assert.deepEqual(schema.properties.evidence.items.required, ['at', 'fields', 'spans'])
    if (kind === 'workout') {
      assert.equal(schema.properties.complexRules.items.properties.targetPaths.items.pattern, WORKOUT_RULE_TARGET_PATTERN)
      const pattern = new RegExp(WORKOUT_RULE_TARGET_PATTERN)
      assert.equal(pattern.test('/sessions/0/exercises/1'), true)
      assert.equal(pattern.test('/sessions/2'), true)
      assert.equal(pattern.test('/sessions/0/exercises/1/sets'), false)
      assert.equal(pattern.test('/sessions/01'), false)
    }
  }
})

test('compact: 3 sessions / 18 exercises preserve ranges and delayed optional sets; missing sessions stay visible', () => {
  const { document, extraction } = threeSessionFixture()
  assert.equal(validateNormalizedDocument(document).ok, true)
  assert.equal(validateExtraction('workout', extraction).ok, true)
  const expanded = expandCompactExtraction('workout', document, autoQuotes(extraction)) as WorkoutExtraction
  assert.equal(expanded.sessions.length, 3)
  assert.equal(expanded.sessions.flatMap(s => s.exercises).length, 18)
  assert.deepEqual(expanded.sessions[0]!.exercises[0]!.restSeconds, { min: 90, max: 120 })
  assert.deepEqual(expanded.sessions[0]!.exercises[0]!.rir, { min: 2, max: 3 })
  assert.equal(expanded.sessions[2]!.exercises[5]!.optionalSets, null)
  assert.equal(expanded.sessions[2]!.exercises[5]!.sets, null)
  const checked = validateProposal('workout', document, expanded)
  assert.equal(checked.status, 'draft')
  if (checked.status !== 'draft') return
  assert.ok(checked.issues.some(i => i.code === 'complex_rule_unresolved'))
  assert.equal(checked.issues.some(i => ['missing_evidence', 'numeric_not_in_quote', 'text_not_in_quote', 'wrong_context'].includes(i.code)), false)
  const missing = structuredClone(expanded)
  missing.sessions = missing.sessions.slice(0, 1)
  missing.complexRules = []
  missing.evidence = missing.evidence.filter(e => !/^\/sessions\/[12]|^\/complexRules/.test(e.path))
  const partial = validateProposal('workout', document, missing)
  assert.equal(partial.status, 'draft')
  if (partial.status === 'draft') assert.ok(partial.issues.some(i => i.code === 'section_not_covered'))
  assert.ok(compactDocumentPayload(document).length < documentPayload(document).length)
})

test('compact: a correct source ID never certifies a different number, column or invented quote', () => {
  const { document, extraction } = threeSessionFixture()
  for (const fault of ['number', 'column', 'row', 'quote'] as const) {
    const wire = autoQuotes(extraction)
    const at = '/sessions/0/exercises/1'
    const group = wire.evidence.find(e => e.at === at && e.fields.includes('sets'))!
    if (fault === 'number') wire.sessions[0]!.exercises[1]!.sets = 9
    if (fault === 'column') group.spans[0]!.blockId = 't:0:r:2:c:4'
    if (fault === 'row') { group.spans[0]!.blockId = 't:0:r:1:c:1'; wire.sessions[0]!.exercises[1]!.sets = 2 }
    if (fault === 'quote') group.spans[0]!.quote = '9 serie inventate'
    if (fault === 'column') {
      assert.throws(() => expandCompactExtraction('workout', document, wire), /column does not match/)
      group.spans[0]!.quote = '2–3'
      assert.throws(() => expandCompactExtraction('workout', document, wire), /column does not match/)
      continue
    }
    const checked = validateProposal('workout', document, expandCompactExtraction('workout', document, wire))
    assert.equal(checked.status, 'draft')
    if (checked.status === 'draft') assert.ok(checked.issues.some(i => i.sourcePath === `${at}/sets` && i.severity !== 'info'), fault)
  }
})

test('compact: one source row can serve an entire exercise without bypassing column or phase checks', () => {
  const { document, extraction } = threeSessionFixture()
  const wire = autoQuotes(extraction)
  const groups = new Map<string, typeof wire.evidence[number]>()
  for (const group of wire.evidence) {
    if (!/^\/sessions\/\d+\/exercises\/\d+$/.test(group.at)) { groups.set(JSON.stringify(group), group); continue }
    const id = group.spans[0]!.blockId.replace(/:c:\d+$/, '')
    const previous = groups.get(group.at)
    if (previous) previous.fields.push(...group.fields)
    else groups.set(group.at, { at: group.at, fields: [...group.fields], spans: [{ blockId: id, quote: null }] })
  }
  wire.evidence = [...groups.values()]
  const check = () => validateProposal('workout', document, expandCompactExtraction('workout', document, wire))
  const good = check()
  assert.equal(good.status, 'draft')
  if (good.status === 'draft') assert.equal(good.issues.some(i => ['numeric_not_in_quote', 'text_not_in_quote', 'wrong_context', 'missing_evidence'].includes(i.code)), false)
  assert.ok(JSON.stringify(wire).length < JSON.stringify(extraction).length * 0.75)
  wire.sessions[0]!.exercises[1]!.sets = 2 // same number exists in RIR column, not sets column
  const wrong = check()
  assert.equal(wrong.status, 'draft')
  if (wrong.status === 'draft') assert.ok(wrong.issues.some(i => i.sourcePath === '/sessions/0/exercises/1/sets' && i.severity !== 'info'))
  assert.equal(wire.sessions[2]!.exercises[5]!.optionalSets, null)
})

test('compact: missing source, malformed pointers and mixed evidence are explicit failures; old DTOs stay readable', () => {
  const { document, extraction } = threeSessionFixture()
  assert.equal(expandCompactExtraction('workout', document, extraction), extraction)
  for (const mutation of [
    (wire: any) => { wire.evidence[0].spans[0].blockId = 'absent' },
    (wire: any) => { wire.evidence[0].fields = ['bad~pointer'] },
    (wire: any) => { wire.evidence.push(extraction.evidence[0]) },
    (wire: any) => { wire.evidence[0].extra = true },
  ]) {
    const wire = autoQuotes(extraction); mutation(wire)
    assert.throws(() => expandCompactExtraction('workout', document, wire), TypeError)
  }
})

test('compact: generated diet quotes keep an alternative out of the base meal and preserve seven-day omissions', () => {
  const document: NormalizedDocument = { sourceHash: 'a'.repeat(64), readerVersion: 'synthetic/1', readingIssues: [],
    blocks: dietPromptExample.blocks.map(b => ({ ...b, kind: b.id.startsWith('h:') ? 'heading' : 'paragraph', headingIds: [], page: null,
      tableId: null, row: null, column: null, rowSpan: null, columnSpan: null, parentId: null, origin: 'native', bbox: null })) }
  const bad = structuredClone(dietPromptExample.extraction)
  bad.days[0]!.meals[0]!.foods.push({ name: 'latte', quantityText: '200 ml', notes: [] })
  bad.evidence.push({ path: '/days/0/meals/0/foods/2/name', spans: [{ blockId: 'p:1', quote: 'latte' }] },
    { path: '/days/0/meals/0/foods/2/quantityText', spans: [{ blockId: 'p:1', quote: '200 ml' }] })
  const checked = validateProposal('diet', document, expandCompactExtraction('diet', document, autoQuotes(bad)))
  assert.equal(checked.status, 'draft')
  if (checked.status === 'draft') assert.ok(checked.issues.some(i => i.code === 'alternative_in_base' && i.sourcePath === '/days/0/meals/0/foods/2/name'))
  const week = fixture('evaluation/goldens/diet-week-complete-evidence.json') as DietExtraction
  const weekSource = fixture('evaluation/documents/diet-week-evidence.json')
  const partial = structuredClone(week)
  partial.days.splice(6, 1)
  partial.evidence = partial.evidence.filter(e => !e.path.startsWith('/days/6'))
  const missing = validateProposal('diet', weekSource, expandCompactExtraction('diet', weekSource, autoQuotes(partial)))
  assert.equal(missing.status, 'draft')
  if (missing.status === 'draft') assert.ok(missing.issues.some(i => i.code === 'section_not_covered'))
})

test('cache: reasoning/output changes produce different profiles with the same six persisted version keys', () => {
  const config = (settings: Record<string, string> = {}) => {
    const read = readProviderConfig({ IMPORT_PROVIDER: 'openai', IMPORT_MODEL: 'gpt-6-luna', IMPORT_PROMPT_VERSION, IMPORT_MAX_OUTPUT_TOKENS: '16000', OPENAI_API_KEY: 'synthetic-only', ...settings })
    assert.equal(read.enabled, true)
    return analysisProfile((read as any).config)
  }
  const medium = config({ IMPORT_REASONING_EFFORT: 'medium' })
  assert.notEqual(medium.rulesVersion, config({ IMPORT_REASONING_EFFORT: 'low' }).rulesVersion)
  assert.notEqual(medium.rulesVersion, config({ IMPORT_REASONING_EFFORT: 'medium', IMPORT_MAX_OUTPUT_TOKENS: '12000' }).rulesVersion)
  assert.notEqual(medium.rulesVersion, config({ IMPORT_REASONING_EFFORT: 'medium', IMPORT_RETRY_MAX_OUTPUT_TOKENS: '14000' }).rulesVersion)
  assert.ok(medium.rulesVersion.length < 200)
})
