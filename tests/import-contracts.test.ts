import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as contracts from '../src/import/contracts/index.ts'
import * as bridge from '../supabase/functions/_shared/import/contracts.ts'
import { array, enumeration, nullable, object, string, validate } from '../src/import/contracts/schema.ts'
import {
  DocumentReaderError, extractionJsonSchema, reviewDecisionSchema, extractionSchemaIds, normalizeSourceText, parseExtractionJson, throwIfCancelled,
  validateDietExtraction, validateDocumentReadResult, validateExtraction, validateNormalizedDocument, validateWorkoutExtraction,
  type DocumentReader, type ExtractionKind, type NormalizedDocument, type ValidationResult,
} from '../src/import/contracts/index.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'tests', 'fixtures', 'import')
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(fixtures, path), 'utf8'))
const clone = <T>(value: T): T => structuredClone(value)
// JSON delle fixture, modificato liberamente per costruire i casi.
type Json = any

const errorKeys = (result: ValidationResult<unknown>) => result.ok ? [] : result.errors.map(error => `${error.path} ${error.code}`).sort()
function assertValid<T>(result: ValidationResult<T>, label = ''): T {
  if (!result.ok) assert.fail(`${label} non valido: ${JSON.stringify(result.errors, null, 1)}`)
  return result.value
}
const kindOf = (schemaId: string): ExtractionKind => {
  const kind = (Object.keys(extractionSchemaIds) as ExtractionKind[]).find(key => extractionSchemaIds[key] === schemaId)
  assert.ok(kind, `schemaId sconosciuto: ${schemaId}`)
  return kind
}

// --- JSON Pointer e patch RFC 6902 minimi, solo per costruire i casi negativi del manifest.
const tokens = (pointer: string) => pointer === '' ? [] : pointer.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
function resolvePointer(value: Json, pointer: string): { found: boolean; value?: Json } {
  let current = value
  for (const token of tokens(pointer)) {
    if (Array.isArray(current) ? !/^(0|[1-9]\d*)$/.test(token) || Number(token) >= current.length : current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) return { found: false }
    current = current[token]
  }
  return { found: true, value: current }
}
function applyPatch(base: Json, operations: { op: 'add' | 'replace' | 'remove'; path: string; value?: Json }[]) {
  const target = clone(base)
  for (const operation of operations) {
    const path = tokens(operation.path)
    const key = path.pop()!
    const parent = resolvePointer(target, path.length ? `/${path.join('/')}` : '').value
    assert.ok(parent && typeof parent === 'object', `patch non applicabile: ${operation.path}`)
    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : Number(key)
      if (operation.op === 'add') parent.splice(index, 0, operation.value)
      else if (operation.op === 'replace') parent[index] = operation.value
      else parent.splice(index, 1)
    } else if (operation.op === 'remove') {
      assert.ok(Object.hasOwn(parent, key)); delete parent[key]
    } else {
      assert.ok(operation.op === 'add' || Object.hasOwn(parent, key), `replace su chiave assente: ${operation.path}`)
      parent[key] = operation.value
    }
  }
  return target
}

// --- Formato del manifest (test format v1), chiuso come i contratti.
const fixturePath = nullable(string({ minLength: 1, maxLength: 200, pattern: /^(documents|extractions)\/[a-z0-9-]+\.json$/ }))
const caseSchema = object({
  id: string({ minLength: 1, maxLength: 80, pattern: /^[a-z0-9-]+$/ }),
  domain: enumeration(['workout', 'diet']),
  summary: string({ minLength: 1, maxLength: 400 }),
  tags: array(string({ minLength: 1, maxLength: 40 }), { maxItems: 20 }),
  readerVersion: nullable(string({ minLength: 1, maxLength: 100 })),
  schemaId: nullable(enumeration([extractionSchemaIds.workout, extractionSchemaIds.diet])),
  sourceFile: nullable(string({ minLength: 1, maxLength: 200 })),
  expectedBlocks: fixturePath,
  expectedProposal: fixturePath,
  candidate: nullable(object({})), // verificato a parte: forme alternative base+patch, value, json
  expectedContractErrors: array(object({ path: string({ maxLength: 200 }), code: string({ minLength: 1, maxLength: 40 }) }), { maxItems: 50 }),
  // Task 06: problemi applicativi attesi dalla validazione semantica (verificati in tests/import-validation.test.ts).
  expectedIssues: nullable(array(object({
    code: string({ minLength: 1, maxLength: 64, pattern: /^[a-z][a-z0-9_]*$/ }),
    severity: enumeration(['blocking', 'confirmation', 'info']),
    sourcePath: nullable(string({ maxLength: 1000 })),
    sourceRefs: array(string({ minLength: 1, maxLength: 200 }), { maxItems: 50 }),
  }), { maxItems: 100 })),
  // Task 07: decisioni della revisione in formato contratto 02, con ID locali `i<n>` nell'ordine di enumerateProposalItems
  // (createReviewDraft + sequentialLocalIds('i')); verificate in tests/import-review-state.test.ts.
  userDecisions: nullable(array(reviewDecisionSchema, { maxItems: 100 })),
  expectedDomainOutput: nullable(object({})),
})
interface Candidate { target: 'normalized-document' | 'workout-extraction' | 'diet-extraction'; base?: string; patch?: Json[]; value?: Json; json?: string }
interface FixtureCase {
  id: string; domain: ExtractionKind; readerVersion: string | null; schemaId: string | null; sourceFile: string | null
  expectedBlocks: string | null; expectedProposal: string | null; candidate: Candidate | null
  expectedContractErrors: { path: string; code: string }[]
}
const manifest = readJson('manifest.json') as { formatVersion: number; description: string; cases: Json[] }
const cases = manifest.cases as FixtureCase[]
const positives = cases.filter(item => item.candidate === null)
const negatives = cases.filter(item => item.candidate !== null)

function runCandidate(candidate: Candidate): ValidationResult<unknown> {
  if (candidate.json !== undefined) {
    assert.equal(candidate.target === 'normalized-document', false)
    return parseExtractionJson(candidate.target === 'workout-extraction' ? 'workout' : 'diet', candidate.json)
  }
  const value = candidate.value !== undefined ? candidate.value : applyPatch(readJson(candidate.base!), candidate.patch ?? [])
  if (candidate.target === 'normalized-document') return validateNormalizedDocument(value)
  return validateExtraction(candidate.target === 'workout-extraction' ? 'workout' : 'diet', value)
}

test('il manifest del corpus è chiuso, univoco e referenzia solo fixture sintetiche esistenti', () => {
  assert.equal(manifest.formatVersion, 1)
  const ids = new Set<string>()
  const referenced = new Set<string>()
  for (const item of manifest.cases) {
    const { candidate, ...rest } = item
    assertValid(validate(caseSchema, { ...rest, candidate: null }), `caso ${item.id}`)
    assert.ok(!ids.has(item.id), `ID ripetuto ${item.id}`); ids.add(item.id)
    for (const path of [item.expectedBlocks, item.expectedProposal, candidate?.base]) if (path) referenced.add(path)
    assert.equal(item.sourceFile, null, 'i binari arriveranno con i task dei reader')
    if (candidate === null) {
      assert.ok(item.expectedBlocks && item.expectedProposal && item.schemaId && item.readerVersion, `caso positivo incompleto ${item.id}`)
      assert.deepEqual(item.expectedContractErrors, [])
    } else {
      assert.ok(['normalized-document', 'workout-extraction', 'diet-extraction'].includes(candidate.target))
      const forms = ['base', 'value', 'json'].filter(key => Object.hasOwn(candidate, key))
      assert.equal(forms.length, 1, `candidate di ${item.id} deve avere una sola forma`)
      const keys = forms[0] === 'base' ? ['target', 'base', 'patch'] : ['target', forms[0]!]
      assert.deepEqual(Object.keys(candidate).sort(), keys.sort())
      assert.ok(item.expectedContractErrors.length > 0, `caso negativo senza errore atteso ${item.id}`)
    }
  }
  const files = ['documents', 'extractions'].flatMap(folder => readdirSync(join(fixtures, folder)).map(name => `${folder}/${name}`))
  assert.deepEqual([...referenced].sort(), files.sort(), 'ogni fixture è referenziata e ogni riferimento esiste')
  for (const path of files) assert.ok(!relative(fixtures, join(fixtures, path)).startsWith('..'))
})

test('le fixture positive rispettano i contratti e i loro valori restano intatti', () => {
  assert.ok(positives.length >= 9)
  for (const item of positives) {
    const raw = readJson(item.expectedBlocks!)
    const document = assertValid(validateNormalizedDocument(raw), item.expectedBlocks!)
    assert.equal(document, raw, 'il validatore non copia né converte')
    assert.equal(document.readerVersion, item.readerVersion)
    assert.equal(document.sourceHash, createHash('sha256').update(`synthetic:${item.id}`).digest('hex'), 'hash sintetico convenzionale')

    const proposal = readJson(item.expectedProposal!)
    const kind = kindOf(item.schemaId!)
    assert.equal(kind, item.domain)
    const value = assertValid(validateExtraction(kind, proposal), item.expectedProposal!)
    assert.equal(value, proposal)
    assert.deepEqual(value, readJson(item.expectedProposal!))
    assert.equal(value.kind, kind)
  }
})

test('integrità del corpus: prove, citazioni e riferimenti puntano a campi e blocchi reali', () => {
  for (const item of positives) {
    const document = readJson(item.expectedBlocks!) as NormalizedDocument
    const proposal = readJson(item.expectedProposal!) as Json
    const blocks = new Map(document.blocks.map(block => [block.id, block.text]))
    const refs = (list: string[], label: string) => list.forEach(id => assert.ok(blocks.has(id), `${item.id}: ${label} cita ${id}`))
    for (const evidence of proposal.evidence) {
      const target = resolvePointer(proposal, evidence.path)
      assert.ok(target.found && target.value !== null, `${item.id}: evidence su campo assente o null ${evidence.path}`)
      for (const span of evidence.spans) {
        assert.ok(blocks.get(span.blockId)?.includes(span.quote), `${item.id}: citazione assente in ${span.blockId}: ${span.quote}`)
      }
    }
    for (const issue of proposal.issues) {
      assert.ok(resolvePointer(proposal, issue.path).found, `${item.id}: issue su percorso assente ${issue.path}`)
      refs(issue.sourceRefs, 'issue')
    }
    for (const entry of proposal.unassigned) refs(entry.sourceRefs, 'unassigned')
    for (const rule of proposal.complexRules ?? []) {
      refs(rule.sourceRefs, 'complexRule')
      rule.targetPaths.forEach((path: string) => assert.ok(resolvePointer(proposal, path).found, `${item.id}: targetPath ${path}`))
    }
    for (const rule of proposal.globalRules ?? []) refs(rule.sourceRefs, 'globalRule')
  }
})

test('le fixture negative producono esattamente gli errori annotati', () => {
  assert.ok(negatives.length >= 30)
  for (const item of negatives) {
    const result = runCandidate(item.candidate!)
    assert.equal(result.ok, false, `${item.id} doveva essere rifiutato`)
    assert.deepEqual(errorKeys(result), item.expectedContractErrors.map(error => `${error.path} ${error.code}`).sort(), item.id)
  }
})

const workoutExample = () => readJson('extractions/workout-spec-example.json') as Json
const dietExample = () => readJson('extractions/diet-spec-example.json') as Json
const documentExample = () => readJson('documents/workout-spec-example.json') as Json

test('gli esempi completi della specifica sono accettati con null e problemi conservati', () => {
  const workout = assertValid(validateWorkoutExtraction(workoutExample()))
  const squat = workout.sessions[0]!.exercises[0]!
  assert.equal(squat.restSeconds, null)
  assert.deepEqual(squat.repetitions, { min: 8, max: 10 })
  assert.equal(workout.sessions[0]!.weekday, null)
  assert.deepEqual(workout.issues.map(issue => [issue.code, issue.path]), [['missing', '/sessions/0/exercises/0/restSeconds']])
  const diet = assertValid(validateDietExtraction(dietExample()))
  assert.equal(diet.days[0]!.meals[0]!.timeText, null)
  assert.deepEqual(diet.days[0]!.meals[0]!.alternatives, ['In alternativa allo yogurt: latte 200 ml.'])
})

test('mancante, zero e false restano tre significati distinti', () => {
  const zero = workoutExample()
  Object.assign(zero.sessions[0].exercises[0], { optionalSets: 0, restSeconds: { min: 0, max: 0 }, perSide: false })
  const exercise = assertValid(validateWorkoutExtraction(zero)).sessions[0]!.exercises[0]!
  assert.equal(exercise.optionalSets, 0)
  assert.deepEqual(exercise.restSeconds, { min: 0, max: 0 })
  assert.equal(exercise.perSide, false)

  const missing = workoutExample()
  delete missing.sessions[0].exercises[0].perSide
  assert.deepEqual(errorKeys(validateWorkoutExtraction(missing)), ['/sessions/0/exercises/0/perSide missing_key'])
  const undefinedValue = workoutExample()
  undefinedValue.sessions[0].exercises[0].perSide = undefined
  assert.deepEqual(errorKeys(validateWorkoutExtraction(undefinedValue)), ['/sessions/0/exercises/0/perSide type'])
  const coerced = workoutExample()
  coerced.sessions[0].exercises[0].perSide = 'false'
  assert.deepEqual(errorKeys(validateWorkoutExtraction(coerced)), ['/sessions/0/exercises/0/perSide type'])
  const emptyCollection = dietExample()
  emptyCollection.days[0].meals[0].foods = []
  assert.ok(validateDietExtraction(emptyCollection).ok, 'una collezione vuota resta valida per il contratto')
})

test('NaN e Infinity dall’API interna sono rifiutati, i valori finiti fuori dominio no', () => {
  const cases: [string, (value: Json) => void, string][] = [
    ['sets NaN', value => { value.sessions[0].exercises[0].sets = Number.NaN }, '/sessions/0/exercises/0/sets not_finite'],
    ['min -Infinity', value => { value.sessions[0].exercises[0].repetitions.min = -Infinity }, '/sessions/0/exercises/0/repetitions/min not_finite'],
    ['weeks Infinity', value => { value.cycle.weeks = Infinity }, '/cycle/weeks not_finite'],
    ['weekday decimale', value => { value.sessions[0].weekday = 1.5 }, '/sessions/0/weekday not_integer'],
    ['weekday zero', value => { value.sessions[0].weekday = 0 }, '/sessions/0/weekday below_minimum'],
  ]
  for (const [label, mutate, expected] of cases) {
    const value = workoutExample(); mutate(value)
    assert.deepEqual(errorKeys(validateWorkoutExtraction(value)), [expected], label)
  }
  const bbox = documentExample()
  Object.assign(bbox.blocks[0], { page: 1, bbox: [Number.NaN, 0, 0.1, 0.1] })
  assert.deepEqual(errorKeys(validateNormalizedDocument(bbox)), ['/blocks/0/bbox/0 not_finite'])

  const outOfBounds = readJson('extractions/workout-out-of-bounds.json') as Json
  const value = assertValid(validateWorkoutExtraction(outOfBounds))
  const burpee = value.sessions[0]!.exercises[0]!
  assert.deepEqual([burpee.sets, burpee.optionalSets, burpee.repetitions, burpee.restSeconds, burpee.rpe, value.cycle.weeks],
    [5000, 2.5, { min: 0, max: 20000 }, { min: 100000, max: 100000 }, { min: 12, max: 12 }, 60], 'nessun clamp o arrotondamento')
  assert.ok([...value.title!].length > 160)
  const huge = workoutExample()
  huge.sessions[0].exercises[0].sets = 1e300
  assert.ok(validateWorkoutExtraction(huge).ok, 'un numero finito enorme resta diagnosticabile nella bozza')
})

test('forme sconosciute, prototipi e testi non codificabili sono rifiutati', () => {
  for (const value of [null, 'scheda', 42, [], new Date(), new Map(), Object.create({ kind: 'workout' })]) {
    assert.deepEqual(errorKeys(validateWorkoutExtraction(value)), [' type'], String(value))
  }
  const proto = JSON.parse('{"__proto__": {"x": 1}}')
  assert.ok(errorKeys(validateWorkoutExtraction(proto)).includes('/__proto__ unknown_key'))
  const slash = workoutExample(); slash['a/b~c'] = true
  assert.ok(errorKeys(validateWorkoutExtraction(slash)).includes('/a~1b~0c unknown_key'), 'chiavi escape RFC 6901 negli errori')

  const unicode = workoutExample()
  unicode.title = 'Scheda d’inverno – 1\'30" · ½ · 💪 · e\u0301'
  assert.ok(validateWorkoutExtraction(unicode).ok)
  for (const bad of ['a\u0000b', 'x\uD800', '\uDC00y']) {
    const value = workoutExample(); value.title = bad
    assert.deepEqual(errorKeys(validateWorkoutExtraction(value)), ['/title invalid_text'], JSON.stringify(bad))
  }
  const astral = workoutExample(); astral.title = '💪'.repeat(contracts.contractLimits.textChars)
  assert.ok(validateWorkoutExtraction(astral).ok, 'i limiti contano code point, non unità UTF-16')
  astral.title += 'x'
  assert.deepEqual(errorKeys(validateWorkoutExtraction(astral)), ['/title too_long'])
})

test('JSON illeggibile, forma errata e fuori limite sono esiti distinti', () => {
  assert.deepEqual(errorKeys(parseExtractionJson('workout', '{"schemaVersion":')), [' invalid_json'])
  assert.deepEqual(errorKeys(parseExtractionJson('workout', '{}')), Object.keys(workoutExample()).map(key => `/${key} missing_key`).sort())
  assert.ok(parseExtractionJson('workout', JSON.stringify(readJson('extractions/workout-out-of-bounds.json'))).ok)
  assert.ok(parseExtractionJson('diet', JSON.stringify(dietExample())).ok)
})

test('un input ostile produce un elenco di errori limitato', () => {
  const value = workoutExample()
  value.sessions = Array.from({ length: 1000 }, () => ({ label: 1, title: 2, weekday: 'x', notes: null, exercises: {} }))
  const result = validateWorkoutExtraction(value)
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.errors.length, contracts.contractLimits.errors + 1)
    assert.equal(result.errors.at(-1)!.code, 'too_many_errors')
  }
  const tooMany = workoutExample()
  tooMany.guidance = Array.from({ length: contracts.contractLimits.items + 1 }, () => 'x')
  assert.deepEqual(errorKeys(validateWorkoutExtraction(tooMany)), ['/guidance too_many_items'])
})

test('due root schema distinti, oggetti chiusi e chiavi tutte obbligatorie', () => {
  const workout = extractionJsonSchema('workout') as Json
  const diet = extractionJsonSchema('diet') as Json
  assert.equal(workout.$id, 'peppitness.workout-extraction.v1')
  assert.equal(diet.$id, 'peppitness.diet-extraction.v1')
  assert.equal(workout.properties.kind.const, 'workout')
  assert.equal(diet.properties.kind.const, 'diet')
  assert.equal(workout.properties.schemaVersion.const, '1.0')
  assert.equal(workout.anyOf ?? workout.oneOf, undefined, 'nessuna union alla radice')
  const objects: Json[] = []
  const walk = (node: Json) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    if (node.type === 'object') objects.push(node)
    Object.values(node).forEach(walk)
  }
  walk(workout); walk(diet)
  assert.ok(objects.length >= 20)
  for (const node of objects) {
    assert.equal(node.additionalProperties, false)
    assert.deepEqual(node.required, Object.keys(node.properties))
  }
  // Runtime e tipi coerenti con la forma normativa: stesse chiavi, stessi nullable (il tipo è verificato da tsc).
  const exercise = workout.properties.sessions.items.properties.exercises.items
  assert.deepEqual(exercise.required, ['name', 'variant', 'equipment', 'measurementMode', 'sets', 'optionalSets', 'repetitions', 'durationSeconds',
    'restSeconds', 'rir', 'rpe', 'perSide', 'loadUnit', 'loadConvention', 'loadInstruction', 'tempoInstruction', 'prescriptionText', 'notes'])
  assert.deepEqual(exercise.properties.prescriptionText, { type: 'string', maxLength: contracts.contractLimits.textChars })
  assert.deepEqual(exercise.properties.perSide, { anyOf: [{ type: 'boolean' }, { type: 'null' }] })
  assert.equal(workout.properties.sessions.items.properties.weekday.anyOf[0].maximum, 7)
  assert.deepEqual(Object.keys(workout.properties), Object.keys(workoutExample()))
  assert.deepEqual(Object.keys(diet.properties), Object.keys(dietExample()))
  assert.match(workout.properties.evidence.items.properties.path.pattern, /\)\+\$$/, 'evidence mai sulla radice')
  assert.equal(JSON.stringify(extractionJsonSchema('workout')), JSON.stringify(workout), 'derivazione deterministica')
})

test('testo canonico V1: spazi e a capo normalizzati, segni prescrittivi intatti', () => {
  assert.equal(contracts.TEXT_NORMALIZATION_VERSION, 'peppitness.text-normalization.v1')
  const cases: [string, string][] = [
    ['  Squat\t3\u00A0x\u202F10  ', 'Squat 3 x 10'],
    ['Riga 1\r\nRiga 2\rRiga 3', 'Riga 1\nRiga 2\nRiga 3'],
    ['A\n\n\n\nB', 'A\n\nB'],
    ['A \n B', 'A\nB'],
    ['Pa\u00ADnca\u200B piana\uFEFF', 'Panca piana'],
    ['e\u0301', '\u00E9'],
    ['x\u0007y\u000Bz', 'x y\nz'],
  ]
  for (const [input, expected] of cases) assert.equal(normalizeSourceText(input), expected, JSON.stringify(input))
  const preserved = '3 x 8–12 + 1 / 2 · 1\'30" · 90″ · 2′ · all’elastico · ½ · ≥ 60% · — «nota»'
  assert.equal(normalizeSourceText(preserved), preserved)
  for (const [input] of cases) assert.equal(normalizeSourceText(normalizeSourceText(input)), normalizeSourceText(input), 'idempotente')
})

function readResult(overrides: Json = {}) {
  const document = documentExample()
  return {
    document,
    metadata: {
      readerVersion: document.readerVersion, format: 'docx', textNormalizationVersion: 'peppitness.text-normalization.v1',
      byteLength: 1234, pageCount: null,
      inventory: [{ id: 'body', kind: 'body', page: null, status: 'read', blockIds: document.blocks.map((block: Json) => block.id), issueCodes: [] }],
      ...overrides,
    },
  }
}

test('protocollo reader: metadati fuori dal documento e aree senza testo visibili nei readingIssues', () => {
  assertValid(validateDocumentReadResult(readResult()))

  const header = readResult()
  header.metadata.inventory.push({ id: 'header:1', kind: 'header', page: null, status: 'not_read', blockIds: [], issueCodes: [] })
  assert.deepEqual(errorKeys(validateDocumentReadResult(header)), ['/metadata/inventory/1/issueCodes inventory'])
  header.metadata.inventory[1]!.issueCodes = ['component_not_read']
  assert.deepEqual(errorKeys(validateDocumentReadResult(header)), ['/metadata/inventory/1/issueCodes/0 inventory'])
  header.document.readingIssues.push({ code: 'component_not_read', sourceRefs: [], message: 'Intestazione presente ma non letta.' })
  assertValid(validateDocumentReadResult(header), 'area non letta dichiarata')

  const docxPage = readResult(); docxPage.document.blocks[0].page = 2
  assert.deepEqual(errorKeys(validateDocumentReadResult(docxPage)), ['/document/blocks/0/page reader_mismatch'])
  assert.deepEqual(errorKeys(validateDocumentReadResult(readResult({ format: 'pdf' }))), ['/metadata/pageCount reader_mismatch'])
  assert.deepEqual(errorKeys(validateDocumentReadResult(readResult({ readerVersion: 'docx/2' }))), ['/metadata/readerVersion reader_mismatch'])

  const scan = readResult({ format: 'pdf', pageCount: 2 })
  scan.document.blocks.forEach((block: Json) => { block.page = 1 })
  scan.document.readingIssues.push({ code: 'no_text_layer', sourceRefs: [], message: 'Pagina 2 senza testo: richiede lettura da immagine.' })
  scan.metadata.inventory.push({ id: 'page:2', kind: 'page', page: 2, status: 'no_text', blockIds: [], issueCodes: ['no_text_layer'] })
  assertValid(validateDocumentReadResult(scan), 'pagina scansionata dichiarata senza testo inventato')
  scan.metadata.inventory[1]!.blockIds = ['p:1']
  assert.deepEqual(errorKeys(validateDocumentReadResult(scan)), ['/metadata/inventory/1/blockIds inventory'])
  scan.metadata.inventory[1]!.blockIds = []; scan.metadata.inventory[1]!.page = 3
  assert.deepEqual(errorKeys(validateDocumentReadResult(scan)), ['/metadata/inventory/1/page inventory'])

  const dangling = readResult(); dangling.metadata.inventory[0]!.blockIds.push('p:99')
  assert.deepEqual(errorKeys(validateDocumentReadResult(dangling)), ['/metadata/inventory/0/blockIds/6 dangling_ref'])
  const nested = readResult(); nested.document.blocks[0].id = 'p:2'
  assert.ok(errorKeys(validateDocumentReadResult(nested)).includes('/document/blocks/1/id duplicate_id'), 'errori del documento con percorso completo')
})

test('protocollo reader: errori tipizzati e cancellazione senza documento parziale', async () => {
  const limit = new DocumentReaderError('limit_exceeded', 'File troppo grande.', { limit: 'fileBytes', max: 10, actual: 11 })
  assert.equal(limit.code, 'limit_exceeded'); assert.deepEqual(limit.limit, { limit: 'fileBytes', max: 10, actual: 11 })
  assert.equal(new DocumentReaderError('corrupt', 'x', { limit: 'a', max: 1, actual: null }).limit, null)
  assert.deepEqual([...contracts.readerErrorCodes], ['unsupported', 'corrupt', 'limit_exceeded', 'cancelled'])

  // Doppio di test del protocollo: nessun parsing, restituisce la fixture sintetica.
  const reader: DocumentReader = {
    format: 'docx', readerVersion: 'synthetic-fixture/1',
    async read({ signal }) {
      throwIfCancelled(signal)
      await new Promise(resolveRead => setTimeout(resolveRead, 5))
      throwIfCancelled(signal)
      return readResult() as never
    },
  }
  const input = (signal: AbortSignal) => ({ bytes: new Uint8Array([0x50, 0x4b]), metadata: { format: 'docx' as const, mediaType: null }, signal })
  assertValid(validateDocumentReadResult(await reader.read(input(new AbortController().signal))))
  const controller = new AbortController()
  const pending = reader.read(input(controller.signal))
  controller.abort()
  await assert.rejects(pending, (error: unknown) => error instanceof DocumentReaderError && error.code === 'cancelled')
})

test('confine Deno: il ponte riesporta la stessa sorgente, con soli import relativi espliciti', () => {
  for (const name of ['validateWorkoutExtraction', 'validateDietExtraction', 'validateNormalizedDocument', 'normalizeSourceText', 'extractionJsonSchema', 'DocumentReaderError'] as const) {
    assert.equal(bridge[name], contracts[name], `${name} non è una copia`)
  }
  assert.deepEqual(Object.keys(bridge).sort(), Object.keys(contracts).sort())

  const contractsDir = join(root, 'src', 'import', 'contracts')
  const bridgeFile = join(root, 'supabase', 'functions', '_shared', 'import', 'contracts.ts')
  const files = [...readdirSync(contractsDir).map(name => join(contractsDir, name)), bridgeFile]
  const specifier = /(?:^|\n)\s*(?:import|export)\b[^'"]*?\sfrom\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(specifier)) {
      const target = match[1] ?? match[2]!
      assert.match(target, /^\.\.?\/.*\.ts$/, `${relative(root, file)}: import non relativo o senza estensione ${target}`)
      const resolved = resolve(dirname(file), target)
      assert.equal(dirname(resolved), contractsDir, `${relative(root, file)}: import fuori dai contratti ${target}`)
    }
    assert.doesNotMatch(source, /\b(?:window|localStorage|sessionStorage|indexedDB|Deno|process|Buffer|require)\b[.(]/, relative(root, file))
    assert.doesNotMatch(source, /from\s+['"](?:react|@supabase|node:)/, relative(root, file))
  }
})
