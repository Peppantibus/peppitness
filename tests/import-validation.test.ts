import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  domainLimits, validateReviewDraft, validateValidationIssue,
  type ExtractionKind, type NormalizedDocument, type ReviewDraft, type ValidationIssue,
} from '../src/import/contracts/index.ts'
import {
  issueCatalog, proposalRuleItems, validateDraft, validateProposal, validationIssueCodes, type ProposalValidation,
} from '../src/import/validation/validate.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'tests', 'fixtures', 'import')
// JSON delle fixture, modificato liberamente per costruire i casi.
type Json = any
const readJson = (path: string): Json => JSON.parse(readFileSync(join(fixtures, path), 'utf8'))

// --- Patch RFC 6902 minime (add/replace/remove), come nel manifest dei contratti.
const tokens = (pointer: string) => pointer === '' ? [] : pointer.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
function applyPatch(base: Json, operations: Json[]) {
  const target = structuredClone(base)
  for (const operation of operations) {
    const path = tokens(operation.path)
    const key = path.pop()!
    let parent = target
    for (const token of path) parent = parent[token]
    assert.ok(parent && typeof parent === 'object', `patch non applicabile: ${operation.path}`)
    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : Number(key)
      if (operation.op === 'add') parent.splice(index, 0, operation.value)
      else if (operation.op === 'replace') parent[index] = operation.value
      else parent.splice(index, 1)
    } else if (operation.op === 'remove') delete parent[key]
    else parent[key] = operation.value
  }
  return target
}
const load = (ref: Json) => ref.json !== undefined ? ref.json : ref.file ? readJson(ref.file) : applyPatch(readJson(ref.base), ref.patch ?? [])
const brief = (issue: ValidationIssue) => ({ code: issue.code, severity: issue.severity, sourcePath: issue.sourcePath, sourceRefs: issue.sourceRefs })
const codes = (result: { issues: ValidationIssue[] }) => result.issues.map(issue => issue.code)
function draftOf<K extends ExtractionKind>(result: ProposalValidation<K>) {
  assert.equal(result.status, 'draft', result.status === 'rejected' ? `rifiutato: ${result.reason}` : '')
  return result as Extract<ProposalValidation<K>, { status: 'draft' }>
}
const manifest = readJson('manifest.json') as { cases: Json[] }
const validationManifest = readJson('validation/manifest.json') as { formatVersion: number; cases: Json[] }

test('06: i casi positivi del corpus 01 hanno problemi attesi rivisti e identici alla validazione', () => {
  for (const item of manifest.cases.filter(entry => entry.candidate === null)) {
    assert.ok(Array.isArray(item.expectedIssues), `${item.id}: expectedIssues da compilare`)
    const proposal = readJson(item.expectedProposal)
    const result = validateProposal(item.domain, readJson(item.expectedBlocks), proposal)
    if (proposal.outcome !== 'extracted') {
      assert.deepEqual(result, { status: 'rejected', kind: item.domain, reason: proposal.outcome, errors: [] }, item.id)
      assert.deepEqual(item.expectedIssues, [], item.id)
      continue
    }
    assert.deepEqual(draftOf(result).issues.map(brief), item.expectedIssues, item.id)
  }
})

test('06: i casi della validazione (riga sbagliata, citazione inventata, omissioni, ostili, limiti, rifiuti) coincidono con i golden', () => {
  assert.equal(validationManifest.formatVersion, 1)
  const ids = new Set<string>()
  const referenced = new Set<string>()
  for (const item of validationManifest.cases) {
    assert.ok(!ids.has(item.id), `ID ripetuto ${item.id}`); ids.add(item.id)
    for (const ref of [item.document, item.proposal]) if (ref.file) referenced.add(ref.file)
    const result = validateProposal(item.domain, load(item.document), load(item.proposal))
    if (item.expected.status === 'rejected') {
      assert.equal(result.status, 'rejected', item.id)
      assert.equal(result.status === 'rejected' && result.reason, item.expected.reason, item.id)
    } else assert.deepEqual(draftOf(result).issues.map(brief), item.expected.issues, item.id)
  }
  const files = ['documents', 'extractions'].flatMap(folder => readdirSync(join(fixtures, 'validation', folder)).map(name => `validation/${folder}/${name}`))
  assert.deepEqual([...referenced].sort(), files.sort(), 'ogni fixture di validazione è referenziata')
  for (const path of files) assert.ok(!relative(fixtures, join(fixtures, path)).startsWith('..'))
})

test('06: ogni problema rispetta il contratto 02 e il catalogo applicativo, senza confidence del modello', () => {
  const all = [
    ...manifest.cases.filter(entry => entry.candidate === null).map(entry => validateProposal(entry.domain, readJson(entry.expectedBlocks), readJson(entry.expectedProposal))),
    ...validationManifest.cases.map(entry => validateProposal(entry.domain, load(entry.document), load(entry.proposal))),
  ].flatMap(result => result.status === 'draft' ? result.issues : [])
  assert.ok(all.length > 100)
  for (const issue of all) {
    const checked = validateValidationIssue(issue)
    assert.ok(checked.ok, JSON.stringify(checked))
    const entry = issueCatalog[issue.code as keyof typeof issueCatalog]
    assert.ok(entry, `codice fuori catalogo: ${issue.code}`)
    assert.equal(issue.severity, entry.severity, issue.code)
    assert.equal(issue.stage, entry.stage, issue.code)
    assert.deepEqual(issue.resolutions, [...entry.resolutions], issue.code)
    assert.ok(!/confidence|fiducia|%/i.test(issue.message), issue.message)
  }
})

test('06: severità stabili; un problema critico non si chiude con una spunta', () => {
  for (const code of validationIssueCodes) {
    const entry = issueCatalog[code]
    const issue: ValidationIssue = { code, severity: entry.severity, stage: entry.stage, localId: null, sourcePath: '', sourceRefs: [], message: entry.description, resolutions: [...entry.resolutions] }
    assert.ok(validateValidationIssue(issue).ok, code)
    if (entry.severity === 'blocking') assert.ok(!(entry.resolutions as readonly string[]).includes('confirmed_missing'), code)
  }
  // Valori prescrittivi mancanti o contraddetti: servono un valore scritto o la rimozione, mai solo una conferma.
  for (const code of ['sets_missing', 'repetitions_missing', 'duration_missing', 'rest_missing', 'measurement_mode_missing', 'exercise_name_missing',
    'food_name_missing', 'missing_evidence', 'quote_not_found', 'wrong_context', 'value_contradicts_source', 'local_override_ignored', 'value_out_of_bounds'] as const) {
    const resolutions = issueCatalog[code].resolutions as readonly string[]
    assert.equal(issueCatalog[code].severity, 'blocking', code)
    assert.ok(!resolutions.includes('confirmed_missing') && !resolutions.includes('scope_choice') && !resolutions.includes('none'), code)
  }
  // Conferme vere: quantità dieta e serie facoltative accettano il vuoto solo per scelta esplicita.
  assert.deepEqual(issueCatalog.food_quantity_missing.resolutions, ['confirmed_missing', 'user_edit'])
  assert.deepEqual(issueCatalog.optional_sets_missing.resolutions, ['confirmed_missing', 'user_edit'])
  assert.equal(issueCatalog.meal_time_missing.severity, 'info')
  assert.equal(issueCatalog.intensity_not_prescribed.severity, 'info')
  assert.equal(issueCatalog.day_type_missing.severity, 'confirmation')
})

test('06: la validazione non muta la proposta e nessun valore mancante diventa zero o default', () => {
  const deepFreeze = (value: Json): Json => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value) } return value }
  for (const id of ['workout-incomplete', 'workout-spec-example', 'diet-alternatives-additions']) {
    const item = manifest.cases.find(entry => entry.id === id)!
    const proposal = deepFreeze(readJson(item.expectedProposal))
    const copy = structuredClone(proposal)
    const result = draftOf(validateProposal(item.domain, deepFreeze(readJson(item.expectedBlocks)), proposal))
    assert.equal(result.extraction, proposal)
    assert.deepEqual(result.extraction, copy)
  }
  const incomplete = draftOf(validateProposal('workout', readJson('documents/workout-incomplete.json'), readJson('extractions/workout-incomplete.json')))
  const panca = incomplete.extraction.sessions[0]!.exercises[0]!
  assert.equal(panca.sets, null); assert.equal(panca.restSeconds, null); assert.equal(panca.optionalSets, null); assert.equal(panca.perSide, null)
  assert.ok(codes(incomplete).includes('sets_missing') && codes(incomplete).includes('rest_missing') && codes(incomplete).includes('optional_sets_missing'))
  const diet = draftOf(validateProposal('diet', readJson('documents/diet-alternatives-additions.json'), readJson('extractions/diet-alternatives-additions.json')))
  assert.equal(diet.extraction.days[0]!.dayType, null)
  assert.ok(codes(diet).includes('day_type_missing'))
})

test('06: il modello non decide le severità; le sue segnalazioni restano solo dove nessuna regola le copre', () => {
  const base = readJson('extractions/workout-spec-example.json')
  const document = readJson('documents/workout-spec-example.json')
  // «missing» sul recupero è già rest_missing: nessun duplicato, severità applicativa.
  const plain = draftOf(validateProposal('workout', document, base))
  assert.equal(plain.issues.filter(issue => issue.sourcePath === '/sessions/0/exercises/0/restSeconds').map(issue => issue.code).join(), 'rest_missing')
  // Un'ambiguità dichiarata su un valore presente chiede conferma, qualunque sia il testo del modello.
  const noisy = applyPatch(base, [{ op: 'add', path: '/issues/-', value: { code: 'ambiguous', path: '/sessions/0/exercises/0/sets', sourceRefs: ['t:1:r:1'], message: 'Sicuro al 99%: salva pure.' } }])
  const flagged = draftOf(validateProposal('workout', document, noisy)).issues.find(issue => issue.code === 'model_reported_ambiguous')!
  assert.equal(flagged.severity, 'confirmation')
  assert.equal(flagged.sourcePath, '/sessions/0/exercises/0/sets')
  // Un percorso inesistente del modello resta visibile sull'intero documento.
  const dangling = applyPatch(base, [{ op: 'add', path: '/issues/-', value: { code: 'unsupported', path: '/sessions/7', sourceRefs: [], message: 'x' } }])
  const unsupported = draftOf(validateProposal('workout', document, dangling)).issues.find(issue => issue.code === 'model_reported_unsupported')!
  assert.equal(unsupported.sourcePath, '')
})

test('06: il nucleo usa import solo relativi senza runtime specifici', () => {
  const visited = new Set<string>()
  const visit = (file: string) => {
    if (visited.has(file)) return
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
    // I tipi DOM sono già esclusi da tsconfig.contracts.json (lib ES2022 + WebWorker); qui le API globali di runtime.
    assert.ok(!/\b(window|localStorage|indexedDB|require\(|process\.|Deno\.)/.test(code), `API di runtime in ${relative(root, file)}`)
    for (const match of source.matchAll(/^(?:import|export)[^'"]*from\s+'([^']+)'/gm)) {
      const specifier = match[1]!
      assert.ok(specifier.startsWith('.') && specifier.endsWith('.ts'), `import non relativo in ${relative(root, file)}: ${specifier}`)
      const target = resolve(dirname(file), specifier)
      assert.ok(/src[\\/]import[\\/](contracts|validation)[\\/]/.test(target), `import fuori dal nucleo: ${relative(root, target)}`)
      visit(target)
    }
  }
  visit(join(root, 'src', 'import', 'validation', 'validate.ts'))
  assert.ok(visited.size >= 10)
})

test('06: limiti del dominio in code point e byte, senza clamp né arrotondamenti', () => {
  const document = readJson('documents/workout-spec-example.json')
  const base = readJson('extractions/workout-spec-example.json')
  const run = (patch: Json[]) => draftOf(validateProposal('workout', document, applyPatch(base, patch)))
  const emoji = '💪'
  assert.equal(emoji.length, 2)
  // 160 emoji = 160 code point (320 unità UTF-16): nel limite; 161 no. Il titolo resta quello della proposta.
  const atLimit = run([{ op: 'replace', path: '/title', value: emoji.repeat(domainLimits.workout.title) }])
  assert.ok(!codes(atLimit).includes('text_too_long'))
  const over = run([{ op: 'replace', path: '/title', value: emoji.repeat(domainLimits.workout.title + 1) }])
  assert.ok(over.issues.some(issue => issue.code === 'text_too_long' && issue.sourcePath === '/title'))
  assert.equal([...over.extraction.title!].length, domainLimits.workout.title + 1)
  const numbers = run([
    { op: 'replace', path: '/sessions/0/exercises/0/sets', value: 2.5 },
    { op: 'replace', path: '/sessions/0/exercises/0/restSeconds', value: { min: 86401, max: 86401 } },
    { op: 'replace', path: '/sessions/0/exercises/0/rir', value: { min: 1.5, max: 1.5 } },
    { op: 'replace', path: '/title', value: 'A\u0007B' },
  ])
  const at = (code: string) => numbers.issues.filter(issue => issue.code === code).map(issue => issue.sourcePath)
  assert.deepEqual(at('value_not_integer'), ['/sessions/0/exercises/0/sets'])
  assert.deepEqual(at('value_out_of_bounds'), ['/sessions/0/exercises/0/restSeconds'])
  assert.deepEqual(at('text_invalid'), ['/title'])
  assert.equal(numbers.extraction.sessions[0]!.exercises[0]!.sets, 2.5)

  // Dieta: righe di alternative, numero di pasti e byte del documento (limite inferiore).
  const dietDocument = readJson('documents/diet-spec-example.json')
  const dietBase = readJson('extractions/diet-spec-example.json')
  const meal = dietBase.days[0].meals[0]
  const diet = draftOf(validateProposal('diet', dietDocument, applyPatch(dietBase, [
    { op: 'replace', path: '/days/0/meals', value: [...Array(domainLimits.diet.mealsPerDay + 1)].map(() => meal) },
    { op: 'replace', path: '/days/0/meals/0/alternatives', value: [...Array(domainLimits.diet.linesPerList + 1)].map((_, i) => `Opzione ${i}`) },
  ])))
  assert.ok(diet.issues.some(issue => issue.code === 'too_many_items' && issue.sourcePath === '/days/0'))
  assert.ok(diet.issues.some(issue => issue.code === 'too_many_items' && issue.sourcePath === '/days/0/meals/0/alternatives'))
  const heavy = 'è'.repeat(500) // 1000 byte UTF-8 per riga
  const bytes = draftOf(validateProposal('diet', dietDocument, applyPatch(dietBase, [
    { op: 'replace', path: '/days/0/meals/0/alternatives', value: Array(30).fill(heavy) },
    { op: 'replace', path: '/days/0/meals', value: Array(7).fill(null).map(() => ({ ...meal, alternatives: Array(30).fill(heavy) })) },
  ])))
  assert.ok(bytes.issues.some(issue => issue.code === 'document_too_large' && issue.sourcePath === ''))
  assert.ok(!bytes.issues.some(issue => issue.code === 'text_too_long'), '500 caratteri sono nel limite della riga')
})

// ---------------------------------------------------------------------------
// Bozza corrente (ingresso usato da 07)
// ---------------------------------------------------------------------------

/** Bozza identica alla proposta: ID locali `i0`, `i1`… in ordine di fonte, nessuna decisione. */
function identityDraft(kind: ExtractionKind, extraction: Json): ReviewDraft {
  const items = proposalRuleItems(extraction)
  const ids = new Map(items.map((item, index) => [item.pointer!, `i${index}`]))
  const draft = {
    formatVersion: 'peppitness.review-draft.v1', kind,
    proposal: {
      proposalId: '90000000-0000-4000-8000-000000000009', proposalVersion: 1, previousProposalId: null, jobId: null,
      source: { sourceHash: 'c'.repeat(64), readerVersion: 'synthetic-fixture/1', textNormalizationVersion: 'peppitness.text-normalization.v1' },
      extraction,
    },
    localIds: items.map(item => ({ localId: ids.get(item.pointer!)!, pointer: item.pointer! })),
    decisions: [],
    current: items.map(item => ({
      collection: item.collection, localId: ids.get(item.pointer!)!, parentLocalId: item.parentKey === null ? null : ids.get(item.parentKey)!,
      values: structuredClone(item.values), ...(item.collection === 'exercises' ? { catalog: null } : {}),
    })),
  }
  const checked = validateReviewDraft(draft)
  assert.ok(checked.ok, JSON.stringify(!checked.ok && checked.errors.slice(0, 3)))
  return checked.value
}

test('06: bozza corrente: problemi di prova solo sui campi non modificati, relazioni sui valori correnti', () => {
  const item = validationManifest.cases.find(entry => entry.id === 'workout-wrong-row-number')!
  const document = load(item.document) as NormalizedDocument
  const draft = identityDraft('workout', load(item.proposal))
  const before = validateDraft(document, draft)
  const wrong = before.issues.find(issue => issue.code === 'wrong_context')!
  assert.equal(wrong.localId, 'i2')
  assert.equal(wrong.sourcePath, '/sessions/0/exercises/0/sets')
  assert.ok(before.issues.every(issue => issue.localId !== null))
  // Stessi codici della proposta, ora legati agli ID locali.
  assert.deepEqual(before.issues.map(issue => issue.code), draftOf(validateProposal('workout', document, load(item.proposal))).issues.map(issue => issue.code))

  // L'utente scrive le serie e il recupero: nessuna citazione finta, i problemi di prova e di valore spariscono.
  const edited = structuredClone(draft) as Json
  const panca = edited.current.find((entry: Json) => entry.localId === 'i2')
  panca.values.sets = 3
  panca.values.restSeconds = { min: 120, max: 120 }
  const after = validateDraft(document, edited)
  assert.ok(!after.issues.some(issue => issue.localId === 'i2' && ['wrong_context', 'sets_missing', 'rest_missing'].includes(issue.code)))
  assert.ok(after.provenance.some(entry => entry.localId === 'i2' && entry.field === 'sets' && entry.origin === 'user'))
  // Un valore utente fuori limite resta bloccante: la decisione non aggira il dominio.
  panca.values.sets = 5000
  assert.ok(validateDraft(document, edited).issues.some(issue => issue.localId === 'i2' && issue.code === 'value_out_of_bounds'))
})

test('06: bozze d’esempio del contratto 02: scelte del catalogo, elementi aggiunti e rimossi', () => {
  const workout = readJson('contracts/review/workout-incomplete-draft.json') as ReviewDraft
  const result = validateDraft(readJson('documents/workout-incomplete.json'), workout)
  const of = (localId: string) => result.issues.filter(issue => issue.localId === localId).map(issue => issue.code)
  assert.deepEqual(of('s0e0'), ['intensity_not_prescribed'])
  assert.deepEqual(of('s0e1'), ['intensity_not_prescribed'])
  assert.deepEqual(of('u2'), ['intensity_not_prescribed'], 'elemento aggiunto: nessuna prova richiesta')
  assert.deepEqual(of('u3'), ['intensity_not_prescribed'])
  assert.ok(result.issues.every(issue => issue.code !== 'catalog_choice_required'))
  assert.ok(result.issues.filter(issue => issue.localId === 'u2' || issue.localId === 'u3').every(issue => issue.sourcePath === null))

  const diet = readJson('contracts/review/diet-spec-draft.json') as ReviewDraft
  const dietResult = validateDraft(readJson('documents/diet-spec-example.json'), diet)
  assert.ok(!dietResult.issues.some(issue => issue.localId === 'd0m0f0'), 'alimento rimosso')
  assert.ok(!dietResult.issues.some(issue => issue.code === 'food_quantity_missing' || issue.code === 'meal_time_missing'), 'vuoti confermati come testo vuoto')
  assert.ok(!dietResult.issues.some(issue => issue.code === 'uncovered_numeric_content'), 'la rimozione esplicita non riapre la copertura')
})
