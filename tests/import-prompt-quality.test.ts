import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dietPromptExample, extractionPrompts, IMPORT_PROMPT_VERSION } from '../supabase/functions/_shared/import/prompts.ts'
import { createOpenAIProvider } from '../supabase/functions/_shared/import/openai-provider.ts'
import { mergeSegmentExtractions, planSegments } from '../supabase/functions/_shared/import/segments.ts'
import { offlineConfig, recordedTransport } from '../scripts/lib/import-evaluation.mjs'
import { validateProposal } from '../src/import/validation/validate.ts'
import { extractionSchemaIds, type DietExtraction, type NormalizedDocument } from '../src/import/contracts/index.ts'

const fixture = <T>(path: string): T => JSON.parse(readFileSync(`tests/fixtures/import/${path}`, 'utf8')) as T
const document = fixture<NormalizedDocument>('evaluation/documents/diet-week-evidence.json')
const golden = fixture<DietExtraction>('evaluation/goldens/diet-week-complete-evidence.json')

test('prompt example: exact alternatives and all critical fields pass the real validator', () => {
  const example = structuredClone(dietPromptExample)
  const source: NormalizedDocument = {
    readerVersion: 'synthetic-prompt/1', sourceHash: 'c'.repeat(64), readingIssues: [],
    blocks: example.blocks.map(({ id, text }) => ({
      id, text, kind: id.startsWith('h:') ? 'heading' : 'paragraph',
      headingIds: id === 'h:1' ? ['h:0'] : id === 'p:1' ? ['h:0', 'h:1'] : [],
      page: null, tableId: null, row: null, column: null, rowSpan: null, columnSpan: null, parentId: null, origin: 'native', bbox: null,
    })),
  }
  const checked = validateProposal('diet', source, example.extraction)
  assert.equal(checked.status, 'draft')
  if (checked.status !== 'draft') return
  assert.deepEqual(checked.issues.filter(i => i.severity === 'blocking'), [])
  assert.equal(checked.issues.some(i => ['unverified_detail', 'evidence_too_coarse', 'extra_quote_not_found'].includes(i.code)), false)
  // Test the example actually sent in the prompt, not a separate golden that can drift.
  assert.deepEqual(JSON.parse(extractionPrompts.diet.split('Esempio JSON completo e sintetico (id e valori solo illustrativi):\n')[1]!), example)
  const rewritten = structuredClone(example.extraction)
  rewritten.days[0]!.meals[0]!.alternatives[0] = 'Yogurt greco → latte 200 ml'
  const bad = validateProposal('diet', source, rewritten)
  assert.equal(bad.status, 'draft')
  if (bad.status === 'draft') assert.ok(bad.issues.some(i => i.code === 'text_not_in_quote' && i.sourcePath === '/days/0/meals/0/alternatives/0'))

  const addedAlternative = structuredClone(example.extraction)
  addedAlternative.days[0]!.meals[0]!.foods.push({ name: 'latte', quantityText: '200 ml', notes: [] })
  addedAlternative.evidence.push(
    { path: '/days/0/meals/0/foods/2/name', spans: [{ blockId: 'p:1', quote: 'latte' }] },
    { path: '/days/0/meals/0/foods/2/quantityText', spans: [{ blockId: 'p:1', quote: '200 ml' }] },
  )
  const extra = validateProposal('diet', source, addedAlternative)
  assert.equal(extra.status, 'draft')
  if (extra.status === 'draft') assert.ok(extra.issues.some(i => i.code === 'alternative_in_base' && i.sourcePath === '/days/0/meals/0/foods/2/name'))

  const optionalSource = structuredClone(source)
  optionalSource.blocks.find(b => b.id === 'p:1')!.text = 'Opzione B: ' + optionalSource.blocks.find(b => b.id === 'p:1')!.text
  const optional = validateProposal('diet', optionalSource, example.extraction)
  assert.equal(optional.status, 'draft')
  if (optional.status === 'draft') assert.ok(optional.issues.some(i => i.code === 'alternative_in_base' && i.sourcePath === '/days/0/meals/0/foods/0/name'))

  const unclosedSource = structuredClone(source)
  unclosedSource.blocks.find(b => b.id === 'p:1')!.text = 'Yogurt greco 170 g (in alternativa latte 200 ml'
  const unclosed = structuredClone(example.extraction)
  unclosed.days[0]!.meals[0]!.foods = [unclosed.days[0]!.meals[0]!.foods[0]!]
  unclosed.days[0]!.meals[0]!.alternatives[0] = unclosedSource.blocks.find(b => b.id === 'p:1')!.text
  unclosed.evidence = unclosed.evidence.filter(e => !e.path.startsWith('/days/0/meals/0/foods/1'))
  unclosed.evidence.find(e => e.path === '/days/0/meals/0/alternatives/0')!.spans[0]!.quote = unclosed.days[0]!.meals[0]!.alternatives[0]!
  const ambiguous = validateProposal('diet', unclosedSource, unclosed)
  assert.equal(ambiguous.status, 'draft')
  if (ambiguous.status === 'draft') assert.ok(ambiguous.issues.some(i => i.code === 'alternative_in_base' && i.sourcePath === '/days/0/meals/0/foods/0/name'))
})

test('seven days: recorded adapter output preserves all field evidence; incomplete evidence remains blocking', async () => {
  for (const fault of [false, true]) {
    const recording = fixture<any>(`provider/evaluation/diet-week-${fault ? 'missing' : 'complete'}-evidence-1.json`)
    const provider = createOpenAIProvider(offlineConfig(), { transport: recordedTransport(recording) })
    const response = await provider.prepare({ kind: 'diet', document, schemaId: extractionSchemaIds.diet, promptVersion: IMPORT_PROMPT_VERSION, profile: 'standard', signal: new AbortController().signal }).send(new AbortController().signal)
    assert.equal(response.status, 'completed')
    if (response.status !== 'completed') continue
    const checked = validateProposal('diet', document, response.data)
    assert.equal(checked.status, 'draft')
    if (checked.status !== 'draft') continue
    assert.equal(checked.issues.filter(i => i.code === 'missing_evidence').length, fault ? 54 : 0)
    assert.equal(checked.issues.filter(i => i.code === 'text_not_in_quote').length, fault ? 1 : 0)
    if (!fault) assert.deepEqual(checked.issues.filter(i => i.severity === 'blocking'), [])
  }
})

test('diet segment merge: every day retains its exact quantity/name citations and shared rules are deduplicated', () => {
  const plan = planSegments(document, doc => doc.blocks.length <= 26, 2)
  assert.equal(plan.status, 'segmented')
  if (plan.status !== 'segmented') return
  const results = plan.segments.map(segment => {
    const indices = golden.days.map((_, d) => d).filter(d => segment.ownBlockIds.includes(`h:${d}`))
    const extraction = structuredClone(golden)
    extraction.days = indices.map(d => structuredClone(golden.days[d]!))
    extraction.evidence = extraction.evidence.flatMap(entry => {
      const match = /^\/days\/(\d+)(\/.*)$/.exec(entry.path)
      if (!match) return [entry]
      const index = indices.indexOf(Number(match[1]))
      return index < 0 ? [] : [{ ...entry, path: `/days/${index}${match[2]}` }]
    })
    return { segment, extraction }
  })
  const merged = mergeSegmentExtractions('diet', results)
  assert.deepEqual(merged, golden)
  const checked = validateProposal('diet', document, merged)
  assert.equal(checked.status, 'draft')
  if (checked.status === 'draft') assert.deepEqual(checked.issues.filter(i => i.severity === 'blocking'), [])
})

test('parent-level evidence cannot silently certify a food name', () => {
  const extraction = structuredClone(golden)
  extraction.evidence.find(e => e.path === '/days/3/meals/0/foods/0/name')!.path = '/days/3/meals/0/foods/0'
  const checked = validateProposal('diet', document, extraction)
  assert.equal(checked.status, 'draft')
  if (checked.status === 'draft') {
    assert.ok(checked.issues.some(i => i.code === 'evidence_too_coarse'))
    assert.ok(checked.issues.some(i => i.code === 'missing_evidence' && i.sourcePath === '/days/3/meals/0/foods/0/name'))
  }
})
