import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  catalogExerciseValuesSchema, commitRpcArgs, defaultImportLimits, defaultSelectionOptions, domainLimits, enumerateProposalItems,
  extractionIssueSchema, extractionJsonSchema, finishMapping, findProvisionalRefs, hasBlockingIssue, importCommitModes, importJobStatuses, importLocalStates,
  importRpcNames, jsonDepthExceeds, normalizedDocumentLimitViolations, provisionalExerciseRefs, receiptMismatches, resolveImportLimits,
  resolvedPayloadContract, toJsonSchema, validate, validateCommitCommand, validateExerciseChoice, validateExtractPlanRequest,
  validateImportJobResult, validateImportReceipt, validateReviewDraft, validateValidationIssue, workoutCommitCommandSchema,
  extractPlanErrorBodySchema,
  type CommitCommand, type ContractError, type ImportReceipt, type NormalizedDocument, type ResolvedDietImport, type ResolvedWorkoutImport,
  type ValidationIssue, type ValidationResult, type WorkoutCommitCommand,
} from '../src/import/contracts/index.ts'
import {
  canonicalHash, canonicalJson, canonicalNumber, CANONICAL_MAX_DEPTH, CanonicalJsonError, commandHash, contentHash, normalizedHash, sha256Hex,
} from '../src/import/mapping/canonical.ts'
import { validateExercise } from '../src/domain/exercises.ts'
import { MEAL_PLAN_MAX_BYTES, mealPlanLimits, mealPlanTooLarge, validateMealPlanDraft, type MealPlanDraft } from '../src/domain/meal-plans.ts'
import { programPayload, validateProgram, type ProgramDocument } from '../src/domain/programs.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'tests', 'fixtures', 'import')
const contractsDir = join(fixtures, 'contracts')
const readJson = (path: string): any => JSON.parse(readFileSync(join(fixtures, path), 'utf8'))
const clone = <T>(value: T): T => structuredClone(value)
// JSON delle fixture, modificato liberamente per costruire i casi.
type Json = any

const errorKeys = (result: ValidationResult<unknown> | ContractError[]) =>
  (Array.isArray(result) ? result : result.ok ? [] : result.errors).map(error => `${error.path} ${error.code}`).sort()
const expectErrors = (result: ValidationResult<unknown> | ContractError[], expected: string[], label = '') =>
  assert.deepEqual(errorKeys(result), [...expected].sort(), label)
function assertValid<T>(result: ValidationResult<T>, label = ''): T {
  if (!result.ok) assert.fail(`${label} non valido: ${JSON.stringify(result.errors, null, 1)}`)
  return result.value
}
const mutate = <T>(value: T, change: (draft: Json) => void): T => { const draft = clone(value); change(draft); return draft }

const workoutBasic = readJson('contracts/commands/workout-basic.json') as WorkoutCommitCommand
const dietBasic = readJson('contracts/commands/diet-basic.json') as CommitCommand
const validateWorkout = (value: unknown) => validateCommitCommand('workout', value)
const validateDiet = (value: unknown) => validateCommitCommand('diet', value)

/** Proiezione di preview descritta in commit.ts, qui solo per confrontare i bounds con il dominio. */
function previewProgram(resolved: ResolvedWorkoutImport): ProgramDocument {
  const choices = new Map(resolved.catalog.map(binding => [binding.ref, binding.choice]))
  const text = (value: number | null) => value === null ? '' : String(value)
  return {
    planId: resolved.planId, id: resolved.versionId, title: resolved.title, guidance: resolved.guidance,
    days: resolved.days.map(day => ({
      id: day.id, label: day.label, title: day.title, note: day.note,
      exercises: day.prescriptions.map(item => {
        const choice = choices.get(item.exerciseRef)!
        return {
          id: item.id, exercise: { id: item.exerciseRef, ...(choice.source === 'new' ? choice.values : choice.seen) },
          sets: String(item.sets), optionalSets: String(item.optionalSets), repsMin: text(item.repsMin), repsMax: text(item.repsMax),
          durationSeconds: text(item.durationSeconds), restSeconds: String(item.restSeconds), rir: text(item.rir), rpe: text(item.rpe), note: item.note,
        }
      }),
    })),
  }
}
const domainAcceptsWorkout = (resolved: ResolvedWorkoutImport) => validateProgram(previewProgram(resolved), true) === null
const domainAcceptsDiet = (resolved: ResolvedDietImport) => validateMealPlanDraft(resolved.plan as MealPlanDraft) === null && mealPlanTooLarge(resolved.plan.document) === null

// ---------------------------------------------------------------------------
// Canonicalizzazione e vettori
// ---------------------------------------------------------------------------

test('vettori canonici: forma scritta a mano, SHA-256 indipendente e gruppi di equivalenza', async () => {
  const file = readJson('contracts/canonical-vectors.json')
  assert.equal(file.canonicalization, 'peppitness.canonical-json.v1')
  const byGroup = new Map<string, string>()
  for (const vector of file.vectors) {
    const canonical = canonicalJson(JSON.parse(vector.json))
    assert.equal(canonical, vector.canonical, vector.id)
    assert.equal(createHash('sha256').update(vector.canonical, 'utf8').digest('hex'), vector.sha256, `${vector.id}: sha256 fissato`)
    assert.equal(await sha256Hex(canonical), vector.sha256, `${vector.id}: WebCrypto`)
    assert.equal(await canonicalHash(JSON.parse(vector.json)), vector.sha256)
    const seen = byGroup.get(vector.group)
    if (seen !== undefined) assert.equal(canonical, seen, `${vector.id}: stesso gruppo`)
    byGroup.set(vector.group, canonical)
  }
  const forms = [...byGroup.values()]
  assert.equal(new Set(forms).size, forms.length, 'gruppi diversi hanno forme diverse')
  for (const group of ['object-order', 'array-reordered', 'decimals', 'string-escapes', 'unicode-nfc', 'unicode-nfd', 'key-code-points', 'null-member', 'missing-member', 'empty-string', 'empty-list']) {
    assert.ok(byGroup.has(group), `vettore mancante: ${group}`)
  }
})

test('canonicalizzazione: numeri in notazione semplice e valori non JSON rifiutati', () => {
  const numbers: [number, string][] = [[0, '0'], [-0, '0'], [1.5, '1.5'], [1e-7, '0.0000001'], [-1.25e-9, '-0.00000000125'], [1e21, '1000000000000000000000'],
    [1.5e22, '15000000000000000000000'], [123.456, '123.456'], [Number.MAX_SAFE_INTEGER, '9007199254740991'], [5e-324, `0.${'0'.repeat(323)}5`]]
  for (const [value, expected] of numbers) assert.equal(canonicalNumber(value), expected, String(value))
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => canonicalJson([value]), CanonicalJsonError)
  const invalid: unknown[] = [undefined, { a: undefined }, () => 1, new Date(0), new Map(), [1, , 3], 'x\u0000', 'a\ud800', 1n, Symbol('s')]
  for (const value of invalid) assert.throws(() => canonicalJson(value), CanonicalJsonError, String(typeof value))
  let deep: unknown = 1
  for (let depth = 0; depth < CANONICAL_MAX_DEPTH; depth++) deep = [deep]
  assert.doesNotThrow(() => canonicalJson(deep))
  assert.throws(() => canonicalJson([deep]), CanonicalJsonError)
  assert.equal(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 })), '{"a":2,"b":1}')
})

test('impronte dei comandi: vettori fissati e relazioni fra commandHash e contentHash', async () => {
  const file = readJson('contracts/hash-vectors.json')
  const hashes = new Map<string, { command: string; content: string }>()
  const listed = new Set<string>()
  for (const vector of file.vectors) {
    const command = readJson(`contracts/${vector.command}`)
    assertValid(validateCommitCommand(vector.kind, command), vector.id)
    const current = { command: await commandHash(command), content: await contentHash(command.payload) }
    assert.equal(current.command, vector.commandHash, `${vector.id}: commandHash`)
    assert.equal(current.content, vector.contentHash, `${vector.id}: contentHash`)
    hashes.set(vector.id, current)
    listed.add(vector.command)
  }
  const files = readdirSync(join(contractsDir, 'commands')).map(name => `commands/${name}`)
  assert.deepEqual([...listed].sort(), files.sort(), 'ogni comando ha il proprio vettore')
  const get = (id: string) => hashes.get(id)!
  // ID tecnici, ref provvisori, localKey, ID/revisione personale, requestId e proposta diversi: stesso significato.
  assert.equal(get('workout-same-content').content, get('workout-basic').content)
  assert.equal(get('diet-same-content').content, get('diet-basic').content)
  assert.equal(get('workout-follow').content, get('workout-basic').content, 'le opzioni non sono contenuto')
  assert.equal(get('diet-follow-first-selection').content, get('diet-basic').content)
  assert.notEqual(get('workout-reordered').content, get('workout-basic').content, 'l’ordine è contenuto')
  assert.notEqual(get('workout-nfd-title').content, get('workout-basic').content, 'nessuna normalizzazione Unicode')
  const commandHashes = [...hashes.values()].map(item => item.command)
  assert.equal(new Set(commandHashes).size, commandHashes.length, 'ogni comando ha un commandHash proprio')
  const allHashes = [...hashes.values()].flatMap(item => [item.command, item.content])
  assert.ok(allHashes.every(hash => /^[0-9a-f]{64}$/.test(hash)))
})

test('ogni modifica del comando cambia commandHash; solo i valori cambiano contentHash', async () => {
  const base = { command: await commandHash(workoutBasic), content: await contentHash(workoutBasic.payload) }
  const renameRef = (draft: Json, from: string, to: string) => {
    for (const binding of draft.payload.resolved.catalog) if (binding.ref === from) binding.ref = to
    for (const day of draft.payload.resolved.days) for (const item of day.prescriptions) if (item.exerciseRef === from) item.exerciseRef = to
  }
  const technical: [string, (draft: Json) => void][] = [
    ['requestId', draft => { draft.requestId = 'e0000000-0000-4000-8000-000000000099' }],
    ['planId', draft => { draft.payload.resolved.planId = '10000000-0000-4000-8000-000000000099' }],
    ['id prescrizione', draft => { draft.payload.resolved.days[0].prescriptions[0].id = '10000000-0000-4000-8000-000000000098'; draft.provenance.items[2].targetId = '10000000-0000-4000-8000-000000000098' }],
    ['ref provvisorio', draft => renameRef(draft, '10000000-0000-4000-8000-000000000032', '10000000-0000-4000-8000-000000000097')],
    ['localKey', draft => { draft.payload.resolved.catalog[1].choice.localKey = 'altra-chiave' }],
    ['revisione vista', draft => { draft.payload.resolved.catalog[0].choice.revision = 4 }],
    ['provenienza', draft => { draft.provenance.analysis.proposalVersion = 2 }],
    ['follow', draft => { draft.selectionOptions = { follow: true, expectedActiveRevision: 1 } }],
    ['revisione attesa', draft => { draft.selectionOptions = { follow: true, expectedActiveRevision: 2 } }],
  ]
  const commandHashes = new Set([base.command])
  for (const [label, change] of technical) {
    const command = mutate(workoutBasic, change)
    assertValid(validateWorkout(command), label)
    const hash = await commandHash(command)
    assert.ok(!commandHashes.has(hash), `${label}: il comando modificato richiede una nuova chiave`)
    commandHashes.add(hash)
    assert.equal(await contentHash(command.payload), base.content, `${label}: non è contenuto`)
  }
  const meaningful: [string, (draft: Json) => void][] = [
    ['serie', draft => { draft.payload.resolved.days[0].prescriptions[0].sets = 5 }],
    ['nome esercizio visto', draft => { draft.payload.resolved.catalog[0].choice.seen.name = 'Panca inclinata' }],
    ['identità del nuovo esercizio', draft => { draft.payload.resolved.catalog[1].choice.values.loadConvention = 'total' }],
    ['ordine delle sedute', draft => { draft.payload.resolved.days.reverse() }],
    ['ciclo', draft => { draft.payload.resolved.cycle = null }],
    ['titolo', draft => { draft.payload.resolved.title = 'Altra scheda' }],
  ]
  for (const [label, change] of meaningful) {
    const command = mutate(workoutBasic, change)
    assertValid(validateWorkout(command), label)
    assert.notEqual(await contentHash(command.payload), base.content, `${label}: cambia il significato`)
    assert.notEqual(await commandHash(command), base.command)
  }
  // La nota del catalogo non è identità: stesso contenuto, comando diverso.
  const note = mutate(workoutBasic, draft => { draft.payload.resolved.catalog[2].choice.seen.note = 'Nota cambiata' })
  assert.equal(await contentHash(note.payload), base.content)
  assert.notEqual(await commandHash(note), base.command)
  // Stessa fonte, due domini: l'hash del contenuto include il tipo.
  assert.notEqual(await contentHash(dietBasic.payload), base.content)
})

test('normalizedHash: calcolato sul documento canonico, indipendente dall’ordine delle chiavi', async () => {
  const document = readJson('documents/workout-incomplete.json') as NormalizedDocument
  const reordered = Object.fromEntries(Object.entries(document).reverse()) as NormalizedDocument
  const hash = await normalizedHash(document)
  assert.equal(await normalizedHash(reordered), hash)
  assert.notEqual(hash, document.sourceHash, 'sourceHash dei byte e normalizedHash sono impronte diverse')
  assert.notEqual(await normalizedHash(mutate(document, draft => { draft.blocks[0].text += '.' })), hash)
  assert.equal(hash, await sha256Hex(canonicalJson({ hash: 'peppitness.normalized-hash.v1', document })))
})

// ---------------------------------------------------------------------------
// Comandi
// ---------------------------------------------------------------------------

test('comandi: round-trip JSON, argomenti RPC congelati, nuovo piano e follow=false di default', () => {
  for (const name of readdirSync(join(contractsDir, 'commands'))) {
    const command = readJson(`contracts/commands/${name}`)
    const roundTrip = JSON.parse(JSON.stringify(command))
    const value = assertValid(validateCommitCommand(command.payload.kind, roundTrip), name)
    assert.deepEqual(value, command)
    const args = commitRpcArgs(value)
    assert.deepEqual(Object.keys(args), ['p_request_id', 'p_resolved_payload', 'p_provenance', 'p_selection_options'])
    assert.equal(args.p_request_id, value.requestId)
    assert.equal(args.p_resolved_payload, value.payload)
    assert.equal(args.p_provenance, value.provenance)
    assert.equal(args.p_selection_options, value.selectionOptions)
  }
  assert.deepEqual(importRpcNames, { workout: 'commit_workout_import', diet: 'commit_diet_import', receipt: 'get_import_receipt' })
  assert.deepEqual([...importCommitModes], ['create_new'])
  assert.deepEqual(defaultSelectionOptions, { follow: false, expectedActiveRevision: null })
  assert.ok(Object.isFrozen(defaultSelectionOptions))
  assert.equal(workoutBasic.selectionOptions.follow, false)
  const schema = toJsonSchema(workoutCommitCommandSchema, { id: 'peppitness.import-commit.v1', title: 'Comando scheda' }) as Json
  assert.equal(schema.additionalProperties, false)
  assert.ok(Array.isArray(schema.properties.payload.properties.resolved.properties.catalog.items.properties.choice.oneOf))
})

test('comandi rifiutati: owner, modalità, versioni, discriminanti del catalogo e selezione', () => {
  const choice = '/payload/resolved/catalog'
  const cases: [string, (draft: Json) => void, string[]][] = [
    ['owner alla radice', draft => { draft.owner_id = 'a0000000-0000-4000-8000-000000000001' }, ['/owner_id unknown_key']],
    ['owner nel payload', draft => { draft.payload.ownerId = 'a0000000-0000-4000-8000-000000000001' }, ['/payload/ownerId unknown_key']],
    ['modalità di revisione', draft => { draft.payload.mode = 'new_version' }, ['/payload/mode const']],
    ['protocollo sconosciuto', draft => { draft.payload.protocolVersion = 'peppitness.import-commit.v2' }, ['/payload/protocolVersion const']],
    ['requestId maiuscolo', draft => { draft.requestId = draft.requestId.toUpperCase() }, ['/requestId pattern']],
    ['revisione attesa senza follow', draft => { draft.selectionOptions.expectedActiveRevision = 3 }, ['/selectionOptions/expectedActiveRevision selection_options']],
    ['opzioni incomplete', draft => { delete draft.selectionOptions.expectedActiveRevision }, ['/selectionOptions/expectedActiveRevision missing_key']],
    ['revisione zero', draft => { draft.selectionOptions = { follow: true, expectedActiveRevision: 0 } }, ['/selectionOptions/expectedActiveRevision below_minimum']],
    ['fonte catalogo sconosciuta', draft => { draft.payload.resolved.catalog[2].choice.source = 'template' }, [`${choice}/2/choice/source enum`]],
    ['discriminante assente', draft => { delete draft.payload.resolved.catalog[2].choice.source }, [`${choice}/2/choice/source missing_key`]],
    ['existing senza revisione', draft => { delete draft.payload.resolved.catalog[0].choice.revision }, [`${choice}/0/choice/revision missing_key`]],
    ['new con ID personale inventato', draft => { draft.payload.resolved.catalog[1].choice.personalId = 'a0000000-0000-4000-8000-000000000005' }, [`${choice}/1/choice/personalId unknown_key`]],
    ['shared con valori confermati invece di visti', draft => { const c = draft.payload.resolved.catalog[2].choice; c.values = c.seen; delete c.seen }, [`${choice}/2/choice/seen missing_key`, `${choice}/2/choice/values unknown_key`]],
    ['nuovo esercizio senza metadati', draft => { draft.payload.resolved.catalog[1].choice.values.loadUnit = null }, [`${choice}/1/choice/values/loadUnit enum`]],
    ['ref esistente diverso dall’ID personale', draft => {
      draft.payload.resolved.catalog[0].ref = '10000000-0000-4000-8000-000000000090'
      draft.payload.resolved.days[0].prescriptions[0].exerciseRef = '10000000-0000-4000-8000-000000000090'
    }, [`${choice}/0/ref binding_mismatch`]],
    ['ref provvisorio uguale a un personale', draft => {
      draft.payload.resolved.catalog[2].ref = 'a0000000-0000-4000-8000-000000000001'
      draft.payload.resolved.days[1].prescriptions[0].exerciseRef = 'a0000000-0000-4000-8000-000000000001'
    }, [`${choice}/2/ref duplicate_id`, `${choice}/2/ref binding_mismatch`, '/payload/resolved/days/1/prescriptions/0 mode_mismatch']],
    ['associazione inutilizzata', draft => { draft.payload.resolved.catalog.push({ ref: '10000000-0000-4000-8000-000000000091', choice: { ...draft.payload.resolved.catalog[1].choice, localKey: 'mai-usato' } }) }, [`${choice}/3 unused_binding`]],
    ['stessa scelta in due associazioni', draft => {
      draft.payload.resolved.catalog.push({ ref: '10000000-0000-4000-8000-000000000092', choice: draft.payload.resolved.catalog[1].choice })
      draft.payload.resolved.days[1].prescriptions[1].exerciseRef = '10000000-0000-4000-8000-000000000092'
    }, [`${choice}/3/choice duplicate_ref`]],
    ['riferimento senza associazione', draft => { draft.payload.resolved.days[0].prescriptions[0].exerciseRef = '10000000-0000-4000-8000-000000000093' }, ['/payload/resolved/days/0/prescriptions/0/exerciseRef dangling_ref', `${choice}/0 unused_binding`]],
    ['UUID tecnico ripetuto', draft => { draft.payload.resolved.days[1].id = draft.payload.resolved.days[0].prescriptions[0].id }, ['/payload/resolved/days/1/id duplicate_id', '/provenance/items/4/targetId dangling_ref']],
    ['etichette uguali', draft => { draft.payload.resolved.days[1].label = '1' }, ['/payload/resolved/days/1/label duplicate_id']],
    ['durata su esercizio a ripetizioni', draft => { draft.payload.resolved.days[0].prescriptions[0].durationSeconds = 30 }, ['/payload/resolved/days/0/prescriptions/0 mode_mismatch']],
    ['ripetizioni su esercizio a tempo', draft => { draft.payload.resolved.days[1].prescriptions[0].repsMin = 10; draft.payload.resolved.days[1].prescriptions[0].repsMax = 10 }, ['/payload/resolved/days/1/prescriptions/0 mode_mismatch']],
    ['intervallo invertito', draft => { draft.payload.resolved.days[1].prescriptions[1].repsMin = 16 }, ['/payload/resolved/days/1/prescriptions/1/repsMin range_order']],
    ['recupero mancante', draft => { draft.payload.resolved.days[0].prescriptions[0].restSeconds = null }, ['/payload/resolved/days/0/prescriptions/0/restSeconds type']],
    ['serie facoltative mancanti', draft => { draft.payload.resolved.days[0].prescriptions[0].optionalSets = null }, ['/payload/resolved/days/0/prescriptions/0/optionalSets type']],
    ['intervallo DTO al posto dello scalare', draft => { draft.payload.resolved.days[0].prescriptions[0].restSeconds = { min: 90, max: 120 } }, ['/payload/resolved/days/0/prescriptions/0/restSeconds type']],
    ['RIR con esponente', draft => { draft.payload.resolved.days[0].prescriptions[0].rir = 1e-7 }, ['/payload/resolved/days/0/prescriptions/0/rir pattern']],
    ['evidence nel comando', draft => { draft.payload.resolved.evidence = [] }, ['/payload/resolved/evidence unknown_key']],
    ['ciclo a metà', draft => { draft.payload.resolved.cycle = { start: '2026-10-05', weeks: null } }, ['/payload/resolved/cycle/weeks type']],
    ['data inesistente', draft => { draft.payload.resolved.cycle.start = '2026-02-30' }, ['/payload/resolved/cycle/start invalid_date']],
    ['data fuori intervallo', draft => { draft.payload.resolved.cycle.start = '1999-12-31' }, ['/payload/resolved/cycle/start invalid_date']],
    ['nessuna seduta', draft => { draft.payload.resolved.days = []; draft.payload.resolved.catalog = []; draft.provenance.items = [] }, ['/payload/resolved/days too_few_items', '/payload/resolved/catalog too_few_items']],
    ['seduta vuota', draft => { draft.payload.resolved.days[1].prescriptions = [] }, ['/payload/resolved/days/1/prescriptions too_few_items']],
    ['titolo con spazi', draft => { draft.payload.resolved.title = ' Scheda' }, ['/payload/resolved/title not_trimmed']],
    ['titolo vuoto', draft => { draft.payload.resolved.title = '' }, ['/payload/resolved/title too_short']],
    ['controllo nel testo', draft => { draft.payload.resolved.days[0].note = 'a\u0007b' }, ['/payload/resolved/days/0/note invalid_text']],
    ['provenienza di un altro dominio', draft => { draft.provenance.kind = 'diet' }, ['/provenance/kind kind_mismatch']],
    ['provenienza verso un elemento assente', draft => { draft.provenance.items[1].targetId = '10000000-0000-4000-8000-000000000094' }, ['/provenance/items/1/targetId dangling_ref']],
    ['provenienza verso un ref provvisorio', draft => { draft.provenance.items[1].targetId = '10000000-0000-4000-8000-000000000031' }, ['/provenance/items/1/targetId dangling_ref']],
    ['elemento locale ripetuto', draft => { draft.provenance.items[2].localId = 's0' }, ['/provenance/items/2/localId duplicate_id']],
  ]
  for (const [label, change, expected] of cases) expectErrors(validateWorkout(mutate(workoutBasic, change)), expected, label)
  expectErrors(validateWorkout(dietBasic), ['/payload/kind const', '/payload/resolved/catalog missing_key', '/payload/resolved/cycle missing_key', '/payload/resolved/days missing_key',
    '/payload/resolved/guidance missing_key', '/payload/resolved/plan unknown_key', '/payload/resolved/planId missing_key', '/payload/resolved/title missing_key', '/payload/resolved/versionId missing_key'], 'dieta come scheda')

  const plan = '/payload/resolved/plan'
  const dietCases: [string, (draft: Json) => void, string[]][] = [
    ['proprietà extra nel documento', draft => { draft.payload.resolved.plan.document.evidence = [] }, [`${plan}/document/evidence unknown_key`]],
    ['provenienza nel documento', draft => { draft.payload.resolved.plan.document.days[0].meals[0].sourceRefs = [] }, [`${plan}/document/days/0/meals/0/sourceRefs unknown_key`]],
    ['tipo di giornata ignoto', draft => { draft.payload.resolved.plan.document.days[0].dayType = null }, [`${plan}/document/days/0/dayType enum`]],
    ['quantità non confermata', draft => { draft.payload.resolved.plan.document.days[0].meals[0].foods[0].quantity = null }, [`${plan}/document/days/0/meals/0/foods/0/quantity type`]],
    ['giornata senza pasti', draft => { draft.payload.resolved.plan.document.days[0].meals = []; draft.provenance.items.splice(2) }, [`${plan}/document/days/0/meals too_few_items`]],
    ['piano senza giornate', draft => { draft.payload.resolved.plan.document.days = []; draft.provenance.items.splice(1) }, [`${plan}/document/days too_few_items`]],
    ['nome del piano con spazi', draft => { draft.payload.resolved.plan.name = 'Menu ' }, [`${plan}/name not_trimmed`]],
    ['alimento senza nome', draft => { draft.payload.resolved.plan.document.days[0].meals[0].foods[0].name = '   ' }, [`${plan}/document/days/0/meals/0/foods/0/name blank_text`]],
    ['pasto ripetuto', draft => { draft.payload.resolved.plan.document.days[0].meals[1].id = draft.payload.resolved.plan.document.days[0].meals[0].id }, [`${plan}/document/days/0/meals/1/id duplicate_id`, '/provenance/items/3/targetId dangling_ref', '/provenance/items/4/targetId dangling_ref']],
    ['ID del piano riusato', draft => { draft.payload.resolved.plan.document.days[0].id = draft.payload.resolved.plan.id; draft.provenance.items[1].targetId = draft.payload.resolved.plan.id }, [`${plan}/document/days/0/id duplicate_id`]],
    ['provenienza di scheda', draft => { draft.provenance.analysis.schemaId = 'peppitness.workout-extraction.v1' }, ['/provenance/analysis/schemaId kind_mismatch']],
  ]
  for (const [label, change, expected] of dietCases) expectErrors(validateDiet(mutate(dietBasic, change)), expected, label)
})

test('limiti del dominio: inventario uguale alla baseline e stesse decisioni del dominio ai bordi', () => {
  assert.deepEqual({ days: domainLimits.diet.days, meals: domainLimits.diet.mealsPerDay, foods: domainLimits.diet.foodsPerMeal, lines: domainLimits.diet.linesPerList }, mealPlanLimits)
  assert.equal(domainLimits.diet.documentBytes, MEAL_PLAN_MAX_BYTES)

  const workout = workoutBasic.payload.resolved
  assert.ok(domainAcceptsWorkout(workout), 'la preview della fixture passa validateProgram(document, true)')
  assert.doesNotThrow(() => programPayload(previewProgram(workout)))
  const astral = (count: number) => '💪'.repeat(count)
  const workoutEdges: [string, (draft: Json) => void][] = [
    ['sets', draft => { draft.days[0].prescriptions[0].sets = domainLimits.workout.sets.max }],
    ['sets+', draft => { draft.days[0].prescriptions[0].sets = domainLimits.workout.sets.max + 1 }],
    ['sets0', draft => { draft.days[0].prescriptions[0].sets = 0 }],
    ['optional', draft => { draft.days[0].prescriptions[0].optionalSets = domainLimits.workout.optionalSets.max }],
    ['optional+', draft => { draft.days[0].prescriptions[0].optionalSets = domainLimits.workout.optionalSets.max + 1 }],
    ['reps', draft => { draft.days[0].prescriptions[0].repsMax = domainLimits.workout.reps.max }],
    ['reps+', draft => { draft.days[0].prescriptions[0].repsMax = domainLimits.workout.reps.max + 1 }],
    ['reps decimali', draft => { draft.days[0].prescriptions[0].repsMax = 8.5 }],
    ['durata', draft => { draft.days[1].prescriptions[0].durationSeconds = domainLimits.workout.durationSeconds.max }],
    ['durata+', draft => { draft.days[1].prescriptions[0].durationSeconds = domainLimits.workout.durationSeconds.max + 1 }],
    ['recupero', draft => { draft.days[0].prescriptions[0].restSeconds = domainLimits.workout.restSeconds.max }],
    ['recupero+', draft => { draft.days[0].prescriptions[0].restSeconds = domainLimits.workout.restSeconds.max + 1 }],
    ['rir', draft => { draft.days[0].prescriptions[0].rir = domainLimits.workout.rir.max }],
    ['rir+', draft => { draft.days[0].prescriptions[0].rir = 10.5 }],
    ['rpe', draft => { draft.days[0].prescriptions[1].rpe = domainLimits.workout.rpe.min }],
    ['rpe-', draft => { draft.days[0].prescriptions[1].rpe = 0.5 }],
    ['etichetta', draft => { draft.days[0].label = astral(domainLimits.workout.dayLabel) }],
    ['etichetta+', draft => { draft.days[0].label = astral(domainLimits.workout.dayLabel + 1) }],
    ['titolo', draft => { draft.title = 'T'.repeat(domainLimits.workout.title) }],
    ['titolo+', draft => { draft.title = 'T'.repeat(domainLimits.workout.title + 1) }],
    ['guidance+', draft => { draft.guidance = 'g'.repeat(domainLimits.workout.guidance + 1) }],
    ['nota', draft => { draft.days[0].prescriptions[0].note = astral(domainLimits.workout.prescriptionNote) }],
    ['nota+', draft => { draft.days[0].prescriptions[0].note = astral(domainLimits.workout.prescriptionNote + 1) }],
    ['nota seduta+', draft => { draft.days[0].note = 'n'.repeat(domainLimits.workout.dayNote + 1) }],
    ['prescrizioni+', draft => { draft.days[1].prescriptions = Array.from({ length: domainLimits.workout.prescriptionsPerDay + 1 }, (_, index) => ({ ...draft.days[1].prescriptions[1], id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}` })) }],
  ]
  for (const [label, change] of workoutEdges) {
    const resolved = mutate(workout, change)
    const contract = resolvedPayloadContract.workout(resolved).ok
    assert.equal(contract, domainAcceptsWorkout(resolved), `scheda, ${label}: contratto e dominio concordano`)
    assert.equal(contract, !/[+-]$|decimali|0$/.test(label), `scheda, ${label}: esito atteso`)
  }

  const diet = (dietBasic.payload as Json).resolved as ResolvedDietImport
  assert.ok(domainAcceptsDiet(diet))
  const meal = (draft: Json) => draft.plan.document.days[0].meals[0]
  const dietEdges: [string, (draft: Json) => void][] = [
    ['alimenti', draft => { meal(draft).foods = Array.from({ length: domainLimits.diet.foodsPerMeal }, () => ({ name: 'pane', quantity: '' })) }],
    ['alimenti+', draft => { meal(draft).foods = Array.from({ length: domainLimits.diet.foodsPerMeal + 1 }, () => ({ name: 'pane', quantity: '' })) }],
    ['pasti+', draft => { draft.plan.document.days[0].meals = Array.from({ length: domainLimits.diet.mealsPerDay + 1 }, (_, index) => ({ ...meal(draft), id: `30000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}` })) }],
    ['giornate+', draft => { draft.plan.document.days = Array.from({ length: domainLimits.diet.days + 1 }, (_, index) => ({ ...draft.plan.document.days[0], id: `30000000-0000-4000-8000-${String(200 + index).padStart(12, '0')}`, meals: [{ ...meal(draft), id: `30000000-0000-4000-8000-${String(300 + index).padStart(12, '0')}` }] })) }],
    ['righe', draft => { meal(draft).alternatives = Array.from({ length: domainLimits.diet.linesPerList }, () => 'x') }],
    ['righe+', draft => { meal(draft).alternatives = Array.from({ length: domainLimits.diet.linesPerList + 1 }, () => 'x') }],
    ['riga', draft => { meal(draft).additions = [astral(domainLimits.diet.lineChars)] }],
    ['riga+', draft => { meal(draft).additions = [astral(domainLimits.diet.lineChars + 1)] }],
    ['riga vuota-', draft => { meal(draft).additions = [' '] }],
    ['nome alimento+', draft => { meal(draft).foods[0].name = 'a'.repeat(domainLimits.diet.foodName + 1) }],
    ['quantità+', draft => { meal(draft).foods[0].quantity = 'q'.repeat(domainLimits.diet.foodQuantity + 1) }],
    ['orario+', draft => { meal(draft).time = 't'.repeat(domainLimits.diet.mealTime + 1) }],
    ['nome pasto+', draft => { meal(draft).name = 'm'.repeat(domainLimits.diet.mealName + 1) }],
    ['nome giornata+', draft => { draft.plan.document.days[0].name = 'g'.repeat(domainLimits.diet.dayName + 1) }],
    ['nome piano+', draft => { draft.plan.name = 'p'.repeat(domainLimits.diet.name + 1) }],
    ['nota+', draft => { meal(draft).note = 'n'.repeat(domainLimits.diet.note + 1) }],
    ['guidance+', draft => { draft.plan.document.guidance = 'g'.repeat(domainLimits.diet.guidance + 1) }],
    ['byte+', draft => { draft.plan.document.guidance = 'é'.repeat(domainLimits.diet.guidance); draft.plan.document.days[0].note = '€'.repeat(domainLimits.diet.note); meal(draft).note = '😀'.repeat(domainLimits.diet.note); draft.plan.document.days = Array.from({ length: 14 }, (_, index) => ({ ...draft.plan.document.days[0], id: `30000000-0000-4000-8000-${String(400 + index).padStart(12, '0')}`, meals: [{ ...meal(draft), id: `30000000-0000-4000-8000-${String(500 + index).padStart(12, '0')}` }] })) }],
    ['controllo-', draft => { meal(draft).note = 'a\u000bb' }],
  ]
  for (const [label, change] of dietEdges) {
    const resolved = mutate(diet, change)
    const contract = resolvedPayloadContract.diet(resolved).ok
    assert.equal(contract, domainAcceptsDiet(resolved), `dieta, ${label}: contratto e dominio concordano`)
    assert.equal(contract, !/[+-]$/.test(label), `dieta, ${label}: esito atteso`)
  }

  const values = workout.catalog[1]!.choice.source === 'new' ? workout.catalog[1]!.choice.values : assert.fail('fixture')
  const exerciseEdges: [string, Json][] = [
    ['nome', { ...values, name: 'n'.repeat(domainLimits.exercise.name) }], ['nome+', { ...values, name: 'n'.repeat(domainLimits.exercise.name + 1) }],
    ['nome con spazi-', { ...values, name: ' Rematore' }], ['nome vuoto-', { ...values, name: '' }],
    ['variante+', { ...values, variant: 'v'.repeat(domainLimits.exercise.variant + 1) }], ['attrezzo+', { ...values, equipment: 'e'.repeat(domainLimits.exercise.equipment + 1) }],
    ['nota', { ...values, note: astral(domainLimits.exercise.note) }], ['nota+', { ...values, note: astral(domainLimits.exercise.note + 1) }],
  ]
  for (const [label, candidate] of exerciseEdges) {
    const contract = validate(catalogExerciseValuesSchema, candidate).ok
    assert.equal(contract, validateExercise({ ...candidate, archivedAt: null }) === null, `esercizio, ${label}: contratto e dominio concordano`)
    assert.equal(contract, !/[+-]$/.test(label), `esercizio, ${label}`)
  }
})

test('preview: riferimenti provvisori dichiarati, mai confusi con esercizi persistiti', () => {
  const resolved = workoutBasic.payload.resolved
  const provisional = provisionalExerciseRefs(resolved)
  assert.deepEqual([...provisional].sort(), ['10000000-0000-4000-8000-000000000031', '10000000-0000-4000-8000-000000000032'])
  const preview = previewProgram(resolved)
  const ids = preview.days.flatMap(day => day.exercises.map(item => item.exercise.id))
  assert.deepEqual(findProvisionalRefs(ids, resolved).sort(), [...provisional].sort(), 'la preview contiene riferimenti da non passare alle RPC manuali o al diario')
  assert.deepEqual(findProvisionalRefs(['a0000000-0000-4000-8000-000000000001'], resolved), [], 'l’esistente usa l’ID personale reale')
  // Due occorrenze dello stesso nuovo esercizio: un solo ref, prescrizioni distinte.
  const occurrences = resolved.days.flatMap(day => day.prescriptions).filter(item => item.exerciseRef === '10000000-0000-4000-8000-000000000031')
  assert.equal(occurrences.length, 2)
  assert.notEqual(occurrences[0]!.id, occurrences[1]!.id)
  assert.notDeepEqual({ ...occurrences[0], id: '' }, { ...occurrences[1], id: '' })
  // Due occorrenze identiche nel documento restano due prescrizioni, con UUID propri.
  const twin = mutate(workoutBasic, draft => {
    draft.payload.resolved.days[0].prescriptions.push({ ...draft.payload.resolved.days[0].prescriptions[0], id: '10000000-0000-4000-8000-000000000060' })
  })
  assertValid(validateWorkout(twin), 'occorrenze identiche')
  // La RPC restituisce la corrispondenza ref → ID personale reale.
  const receipt = readJson('contracts/receipts/workout-basic-committed.json') as ImportReceipt
  for (const ref of provisional) {
    const binding = receipt.exerciseBindings.find(item => item.ref === ref)!
    assert.notEqual(binding.exerciseId, ref)
    assert.ok(['created', 'adopted', 'already_adopted'].includes(binding.resolution))
  }
})

test('ricevute: forma, stato deleted, selezione risultante e corrispondenza con il comando', async () => {
  const workoutReceipt = assertValid(validateImportReceipt(readJson('contracts/receipts/workout-basic-committed.json')))
  const dietReceipt = assertValid(validateImportReceipt(readJson('contracts/receipts/diet-follow-deleted.json')))
  assert.equal(dietReceipt.resultState, 'deleted')
  assert.deepEqual(receiptMismatches(workoutReceipt, workoutBasic, await commandHash(workoutBasic)), [])
  const dietCommand = readJson('contracts/commands/diet-follow-first-selection.json') as CommitCommand
  assert.deepEqual(receiptMismatches(dietReceipt, dietCommand, await commandHash(dietCommand)), [])

  const cases: [string, ImportReceipt, (draft: Json) => void, string[]][] = [
    ['owner in input', workoutReceipt, draft => { draft.owner_id = 'a0000000-0000-4000-8000-000000000001' }, ['/owner_id unknown_key']],
    ['stato pendente', workoutReceipt, draft => { draft.resultState = 'pending' }, ['/resultState enum']],
    ['scheda senza versione', workoutReceipt, draft => { draft.versionId = null }, ['/versionId kind_mismatch']],
    ['dieta con versione', dietReceipt, draft => { draft.versionId = 'a0000000-0000-4000-8000-000000000099' }, ['/versionId kind_mismatch']],
    ['dieta con esercizi', dietReceipt, draft => { draft.exerciseBindings = workoutReceipt.exerciseBindings }, ['/exerciseBindings kind_mismatch']],
    ['existing con altro ID', workoutReceipt, draft => { draft.exerciseBindings[0].exerciseId = 'a0000000-0000-4000-8000-000000000099' }, ['/exerciseBindings/0 binding_mismatch']],
    ['creato con il ref provvisorio', workoutReceipt, draft => { draft.exerciseBindings[1].exerciseId = draft.exerciseBindings[1].ref }, ['/exerciseBindings/1 binding_mismatch']],
    ['selezione di un altro piano', dietReceipt, draft => { draft.selection.mealPlanId = 'a0000000-0000-4000-8000-000000000099' }, ['/selection selection_options']],
    ['hash non esadecimale', workoutReceipt, draft => { draft.contentHash = 'X'.repeat(64) }, ['/contentHash pattern']],
  ]
  for (const [label, base, change, expected] of cases) expectErrors(validateImportReceipt(mutate(base, change)), expected, label)

  const hash = await commandHash(workoutBasic)
  const mismatches: [string, (draft: Json) => void, string[]][] = [
    ['altro comando', draft => { draft.commandHash = '0'.repeat(64) }, ['/commandHash binding_mismatch']],
    ['altra chiave', draft => { draft.requestId = 'e0000000-0000-4000-8000-000000000099' }, ['/requestId binding_mismatch']],
    ['template risolto come creato', draft => { draft.exerciseBindings[2].resolution = 'created' }, ['/exerciseBindings binding_mismatch']],
    ['associazione mancante', draft => { draft.exerciseBindings.pop() }, ['/exerciseBindings binding_mismatch', '/exerciseBindings binding_mismatch']],
    ['selezione non richiesta', draft => { draft.selection = { revision: 2, workoutPlanId: draft.planId, mealPlanId: null } }, ['/selection selection_options']],
  ]
  for (const [label, change, expected] of mismatches) expectErrors(receiptMismatches(mutate(workoutReceipt, change), workoutBasic, hash), expected, label)
  // Una ricevuta deleted non segnala la selezione come incoerente: il piano non esiste più.
  assert.deepEqual(receiptMismatches(mutate(workoutReceipt, draft => { draft.resultState = 'deleted' }), workoutBasic, hash), [])
})

// ---------------------------------------------------------------------------
// Problemi, revisione e mapping
// ---------------------------------------------------------------------------

const issue = (overrides: Partial<ValidationIssue> = {}): ValidationIssue => ({
  code: 'rest_missing', severity: 'blocking', stage: 'validation', localId: 's0e0', sourcePath: '/sessions/0/exercises/0/restSeconds',
  sourceRefs: ['t:1:r:1'], message: 'Recupero da risolvere.', resolutions: ['user_edit', 'timer_choice', 'remove_item'], ...overrides,
})

test('problemi applicativi: severità dell’app, riferimento locale o nella proposta, risoluzioni coerenti', () => {
  assertValid(validateValidationIssue(issue()))
  assertValid(validateValidationIssue(issue({ code: 'optional_sets_missing', severity: 'confirmation', resolutions: ['confirmed_missing', 'user_edit'] })))
  assertValid(validateValidationIssue(issue({ code: 'meal_time_missing', severity: 'info', localId: null, resolutions: ['none'] })))
  assertValid(validateValidationIssue(issue({ code: 'page_not_read', stage: 'reading', localId: null, sourcePath: '', resolutions: ['reanalyze'] })))
  const cases: [string, Json, string[]][] = [
    ['blocking chiuso da una conferma', issue({ resolutions: ['confirmed_missing'] }), ['/resolutions decision_reason']],
    ['none su blocking', issue({ resolutions: ['none'] }), ['/resolutions decision_reason']],
    ['none insieme ad altro', issue({ severity: 'info', resolutions: ['none', 'user_edit'] }), ['/resolutions decision_reason']],
    ['risoluzioni ripetute', issue({ resolutions: ['user_edit', 'user_edit'] }), ['/resolutions decision_reason']],
    ['nessun riferimento', issue({ localId: null, sourcePath: null }), [' missing_local_id']],
    ['severità del modello', { ...issue(), severity: 'high' }, ['/severity enum']],
    ['confidenza', { ...issue(), confidence: 0.9 }, ['/confidence unknown_key']],
    ['codice non stabile', issue({ code: 'Rest Missing' }), ['/code pattern']],
    ['nessuna risoluzione', issue({ resolutions: [] }), ['/resolutions too_few_items']],
  ]
  for (const [label, value, expected] of cases) expectErrors(validateValidationIssue(value), expected, label)
  const llmIssue = extractionJsonSchema('workout') as Json
  assert.ok(!Object.hasOwn(llmIssue.properties.issues.items.properties, 'severity'), 'il modello non assegna severità')
  assert.ok(validate(extractionIssueSchema, { code: 'missing', path: '', sourceRefs: [], message: 'x', severity: 'blocking' }).ok === false)
})

test('DTO di estrazione senza campi del database', () => {
  const forbidden = new Set(['id', 'ownerId', 'owner_id', 'exerciseId', 'exercise_id', 'personalId', 'templateId', 'planId', 'versionId', 'requestId', 'revision'])
  const visit = (schema: Json, path: string) => {
    if (!schema || typeof schema !== 'object') return
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      assert.ok(!forbidden.has(key), `${path}/${key}: campo DB nel DTO`)
      visit(child, `${path}/${key}`)
    }
    visit(schema.items, `${path}/*`)
    for (const branch of schema.anyOf ?? []) visit(branch, path)
  }
  visit(extractionJsonSchema('workout'), '')
  visit(extractionJsonSchema('diet'), '')
})

test('bozza di revisione: fixture valide, ID locali completi e proposta mai modificata', () => {
  for (const name of readdirSync(join(contractsDir, 'review'))) {
    const draft = readJson(`contracts/review/${name}`)
    const before = clone(draft)
    const value = assertValid(validateReviewDraft(JSON.parse(JSON.stringify(draft))), name)
    assert.deepEqual(draft, before, 'la validazione non modifica la bozza')
    const extraction = readJson(`extractions/${name.startsWith('workout') ? 'workout-incomplete' : 'diet-spec-example'}.json`)
    assert.deepEqual(value.proposal.extraction, extraction, 'la proposta resta quella dell’analisi, con evidence e problemi')
    assert.equal(value.localIds.length, enumerateProposalItems(extraction).length)
  }
  const workout = readJson('contracts/review/workout-incomplete-draft.json')
  assert.deepEqual(enumerateProposalItems(workout.proposal.extraction).map(item => `${item.collection} ${item.pointer}`), [
    'root ', 'sessions /sessions/0', 'exercises /sessions/0/exercises/0', 'exercises /sessions/0/exercises/1',
  ])
  // Due occorrenze dello stesso nuovo esercizio condividono localKey e valori, con prescrizioni distinte.
  const shared = workout.current.filter((item: Json) => item.catalog?.source === 'new')
  assert.equal(shared.length, 2)
  assert.equal(shared[0].catalog.localKey, shared[1].catalog.localKey)
  assert.notDeepEqual(shared[0].values, shared[1].values)
})

test('bozza di revisione: decisioni con riferimenti, campi e motivi verificati', () => {
  const workout = readJson('contracts/review/workout-incomplete-draft.json')
  const diet = readJson('contracts/review/diet-spec-draft.json')
  const cases: [string, Json, (draft: Json) => void, string[]][] = [
    ['ID locale mancante', workout, draft => { draft.localIds.pop() }, ['/localIds missing_local_id', '/decisions/4/localId dangling_ref', '/current/3/localId dangling_ref']],
    ['puntatore inesistente', workout, draft => { draft.localIds[3].pointer = '/sessions/0/exercises/9' }, ['/localIds/3/pointer dangling_ref', '/localIds missing_local_id', '/decisions/4/localId dangling_ref', '/current/3/localId dangling_ref']],
    ['ID locale ripetuto', workout, draft => { draft.localIds[3].localId = 's0e0' }, ['/localIds/3/localId duplicate_id', '/current/3/localId dangling_ref', '/decisions/4/localId dangling_ref']],
    ['campo sconosciuto', workout, draft => { draft.decisions[0].field = 'weight' }, ['/decisions/0/field unknown_field']],
    ['valore del tipo sbagliato', workout, draft => { draft.decisions[0].after = 'quattro' }, ['/decisions/0/after type']],
    ['decisione senza effetto', workout, draft => { draft.decisions[0].after = null }, ['/decisions/0 no_op_decision']],
    ['timer con intervallo', workout, draft => { draft.decisions[1].reason = 'timer_choice'; draft.decisions[1].after = { min: 90, max: 120 } }, ['/decisions/1/reason decision_reason']],
    ['timer su un altro campo', workout, draft => { draft.decisions[0].reason = 'timer_choice' }, ['/decisions/0/reason decision_reason']],
    ['vuoto confermato su un valore presente', workout, draft => { draft.decisions[5].reason = 'confirmed_missing' }, ['/decisions/5/reason decision_reason']],
    ['motivo catalogo su un campo', workout, draft => { draft.decisions[0].reason = 'catalog_choice' }, ['/decisions/0/reason enum']],
    ['catalogo su una seduta', workout, draft => { draft.decisions[3].localId = 's0' }, ['/decisions/3/localId kind_mismatch']],
    ['scelta nuova con ID inventato', workout, draft => { draft.decisions[4].after.personalId = 'a0000000-0000-4000-8000-000000000001' }, ['/decisions/4/after/personalId unknown_key']],
    ['aggiunta con ID esistente', workout, draft => { draft.decisions[8].localId = 's0' }, ['/decisions/8/localId duplicate_id', '/decisions/9/parentLocalId dangling_ref', '/decisions/11/parentLocalId dangling_ref', '/decisions/13/fromParentLocalId dangling_ref', '/decisions/13/toParentLocalId dangling_ref', '/current/4/localId dangling_ref']],
    ['esercizio sotto la radice', workout, draft => { draft.decisions[9].parentLocalId = 'root' }, ['/decisions/9/parentLocalId parent_mismatch']],
    ['aggiunta di una regola', workout, draft => { draft.decisions[8].collection = 'complexRules' }, ['/decisions/8/collection enum']],
    ['aggiunta di una giornata in una scheda', workout, draft => { draft.decisions[8].collection = 'days' }, ['/decisions/8/collection kind_mismatch', '/decisions/9/parentLocalId dangling_ref', '/decisions/11/parentLocalId dangling_ref', '/decisions/13/fromParentLocalId dangling_ref', '/decisions/13/toParentLocalId dangling_ref', '/current/4/localId dangling_ref']],
    ['valori aggiunti non conformi', workout, draft => { draft.decisions[9].values.sets = '3' }, ['/decisions/9/values/sets type']],
    ['riferimento prima dell’aggiunta', workout, draft => { draft.decisions.unshift(draft.decisions.splice(10, 1)[0]) }, ['/decisions/0/localId dangling_ref']],
    ['rimozione della radice', workout, draft => { draft.decisions.push({ op: 'remove', decisionId: 'd99', localId: 'root', reason: 'user_edit' }) }, ['/decisions/14/localId parent_mismatch']],
    ['elemento rimosso ancora presente', workout, draft => { draft.decisions.push({ op: 'remove', decisionId: 'd99', localId: 'u2', reason: 'scope_choice' }) }, ['/current/6/localId dangling_ref']],
    ['decisione ripetuta', workout, draft => { draft.decisions[1].decisionId = 'd1' }, ['/decisions/1/decisionId duplicate_id']],
    ['conferma su campo inesistente', workout, draft => { draft.decisions[6].field = 'phase' }, ['/decisions/6/field unknown_field']],
    ['nuovo esercizio con valori diversi', workout, draft => { draft.current[6].catalog = { ...draft.current[6].catalog, values: { ...draft.current[6].catalog.values, loadConvention: 'total' } } }, ['/current/6/catalog/values binding_mismatch']],
    ['due radici', workout, draft => { draft.current.push({ ...draft.current[0] }) }, ['/current missing_local_id', '/current/7/localId duplicate_id']],
    ['genitore del tipo sbagliato', workout, draft => { draft.current[2].parentLocalId = 'root' }, ['/current/2/parentLocalId parent_mismatch']],
    ['collezione diversa dalla mappa', workout, draft => { draft.current[1] = { ...draft.current[1], collection: 'complexRules', values: { kind: 'other', text: 'x', sourceRefs: [], targetPaths: [] } } }, ['/current/1/collection kind_mismatch', '/current/2/parentLocalId parent_mismatch', '/current/3/parentLocalId parent_mismatch']],
    ['proposta successiva senza precedente', workout, draft => { draft.proposal.proposalVersion = 2 }, ['/proposal/previousProposalId kind_mismatch']],
    ['proposta con estrazione dell’altro dominio', diet, draft => { draft.proposal.extraction = workout.proposal.extraction }, ['/proposal/extraction/kind const', '/proposal/extraction/days missing_key', '/proposal/extraction/globalRules missing_key', '/proposal/extraction/complexRules unknown_key', '/proposal/extraction/cycle unknown_key', '/proposal/extraction/schedule unknown_key', '/proposal/extraction/sessions unknown_key']],
    ['alimento sotto la giornata', diet, draft => { draft.decisions[2].parentLocalId = 'd0' }, ['/decisions/2/parentLocalId parent_mismatch']],
    ['formato sconosciuto', diet, draft => { draft.formatVersion = 'peppitness.review-draft.v2' }, ['/formatVersion const']],
  ]
  for (const [label, base, change, expected] of cases) expectErrors(validateReviewDraft(mutate(base, change)), expected, label)
})

test('mapping: esito salvabile solo senza problemi bloccanti e con payload conforme', () => {
  const resolved = workoutBasic.payload.resolved
  const info = issue({ code: 'rir_absent', severity: 'info', resolutions: ['none'] })
  const ok = finishMapping(resolved, [info], resolvedPayloadContract.workout)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ok && ok.issues, [info])
  const blocked = finishMapping(resolved, [issue()], resolvedPayloadContract.workout)
  assert.equal(blocked.ok, false)
  assert.ok(!Object.hasOwn(blocked, 'value'), 'nessun output «quasi valido» accanto ai problemi')
  const invalid = finishMapping(mutate(resolved, draft => { draft.days[0].prescriptions[0].restSeconds = -1 }), [], resolvedPayloadContract.workout)
  assert.equal(invalid.ok, false)
  assert.deepEqual(invalid.issues.map(item => `${item.code} ${item.severity} ${item.stage}`), ['resolved_contract_violation blocking mapping'])
  assertValid(validateValidationIssue(invalid.issues[0]))
  assert.throws(() => finishMapping(null, [info]), TypeError)
  assert.equal(finishMapping(null, [issue()]).ok, false)
  assert.equal(hasBlockingIssue([info]), false)
  assert.equal(hasBlockingIssue([info, issue()]), true)
  assert.equal(finishMapping((dietBasic.payload as Json).resolved, [], resolvedPayloadContract.diet).ok, true)
})

test('scelte del catalogo: tre fonti esplicite e nessun ID inventato', () => {
  const seen = { name: 'Squat', variant: 'Smith machine', equipment: 'Smith', loadConvention: 'total', loadUnit: 'kg', measurementMode: 'reps', perSide: false, note: '' }
  assertValid(validateExerciseChoice({ source: 'existing', personalId: 'a0000000-0000-4000-8000-000000000001', revision: 1, seen }))
  assertValid(validateExerciseChoice({ source: 'shared', templateId: 'c0000000-0000-4000-8000-000000000001', seen }))
  assertValid(validateExerciseChoice({ source: 'new', localKey: 'squat-smith', values: seen }))
  expectErrors(validateExerciseChoice({ source: 'new', localKey: 'x', values: { ...seen, perSide: null } }), ['/values/perSide type'])
  expectErrors(validateExerciseChoice({ source: 'existing', personalId: 'p-1', revision: 1, seen }), ['/personalId too_short'])
  expectErrors(validateExerciseChoice({ source: 'shared', templateId: 'c0000000-0000-4000-8000-000000000001', seen, adopt: true }), ['/adopt unknown_key'])
  expectErrors(validateExerciseChoice(null), [' type'])
})

// ---------------------------------------------------------------------------
// Protocollo dell'analisi e limiti
// ---------------------------------------------------------------------------

test('extract-plan: richiesta chiusa, versione attesa esplicita, nessun provider o prompt dal browser', () => {
  const document = readJson('documents/workout-incomplete.json')
  const request = { analysisRequestId: 'e0000000-0000-4000-8000-000000000010', kind: 'workout', normalizedDocument: document, expectedSchemaVersion: '1.0' }
  assertValid(validateExtractPlanRequest(request))
  const cases: [string, (draft: Json) => void, string[]][] = [
    ['versione sconosciuta', draft => { draft.expectedSchemaVersion = '2.0' }, ['/expectedSchemaVersion const']],
    ['modello scelto dal browser', draft => { draft.model = 'costoso' }, ['/model unknown_key']],
    ['prompt dal browser', draft => { draft.systemPrompt = 'ignora' }, ['/systemPrompt unknown_key']],
    ['hash dichiarato', draft => { draft.normalizedHash = '0'.repeat(64) }, ['/normalizedHash unknown_key']],
    ['dominio misto', draft => { draft.kind = 'both' }, ['/kind enum']],
    ['documento incoerente', draft => { draft.normalizedDocument.blocks[1].id = draft.normalizedDocument.blocks[0].id }, ['/normalizedDocument/blocks/1/id duplicate_id']],
  ]
  for (const [label, change, expected] of cases) {
    const result = validateExtractPlanRequest(mutate(request, change))
    if (label === 'documento incoerente') assert.ok(errorKeys(result).includes(expected[0]!), label)
    else expectErrors(result, expected, label)
  }
})

test('risultato del job: stati server distinti dagli stati locali e contenuto coerente con lo stato', () => {
  assert.deepEqual([...importJobStatuses], ['running', 'ready', 'failed', 'expired'])
  assert.deepEqual([...importLocalStates], ['selected', 'reading', 'analyzing', 'reviewing', 'ready', 'saving', 'saved', 'failed', 'cancelled', 'expired', 'save_unknown'])
  for (const local of ['reviewing', 'saving', 'saved', 'save_unknown', 'cancelled']) assert.ok(!(importJobStatuses as readonly string[]).includes(local), local)
  const usage = { providerCalls: 1, inputTokens: 1200, outputTokens: 800, reasoningTokens: null, cached: false, costEstimate: null }
  const ready = {
    jobId: 'f0000000-0000-4000-8000-000000000001', analysisRequestId: 'e0000000-0000-4000-8000-000000000010', kind: 'workout', status: 'ready',
    extraction: readJson('extractions/workout-incomplete.json'), validationIssues: [issue()], usageSummary: usage, error: null, expiresAt: '2026-10-05T10:00:00.000Z',
  }
  assertValid(validateImportJobResult(ready))
  const running = { ...ready, status: 'running', extraction: null, validationIssues: [], usageSummary: { ...usage, providerCalls: 0, inputTokens: null, outputTokens: null } }
  assertValid(validateImportJobResult(running))
  const failure = { code: 'provider_outcome_uncertain', message: 'Esito incerto: rileggere il job prima di riprovare.', retryable: false, limit: null }
  assertValid(validateImportJobResult({ ...running, status: 'failed', error: failure }))
  assertValid(validateImportJobResult({ ...running, status: 'expired' }))
  const limit = { code: 'limit_exceeded', message: 'Documento troppo lungo.', retryable: false, limit: { limit: 'normalizedTextChars', max: 200000, actual: 250000 } }
  assertValid(validate(extractPlanErrorBodySchema, { error: limit }))
  const cases: [string, Json, string[]][] = [
    ['pronto senza estrazione', { ...ready, extraction: null }, ['/extraction status_mismatch']],
    ['in corso con estrazione', { ...ready, status: 'running', validationIssues: [] }, ['/extraction status_mismatch']],
    ['fallito senza errore', { ...running, status: 'failed' }, ['/error status_mismatch']],
    ['problemi senza risultato', { ...running, validationIssues: [issue()] }, ['/validationIssues status_mismatch']],
    ['estrazione dell’altro dominio', { ...ready, kind: 'diet' }, ['/extraction/kind kind_mismatch']],
    ['stato locale dal server', { ...ready, status: 'reviewing' }, ['/status enum']],
    ['estrazione non conforme', { ...ready, extraction: { ...ready.extraction, schemaVersion: '2.0' } }, ['/extraction/schemaVersion const']],
    ['limite senza dettaglio', { ...running, status: 'failed', error: { ...limit, limit: null } }, ['/error/limit status_mismatch']],
    ['scadenza senza fuso', { ...ready, expiresAt: '2026-10-05T10:00:00.000' }, ['/expiresAt pattern']],
    ['data impossibile', { ...ready, expiresAt: '2026-13-45T10:00:00Z' }, ['/expiresAt invalid_date']],
  ]
  for (const [label, value, expected] of cases) expectErrors(validateImportJobResult(value), expected, label)
})

test('limiti configurabili: valori iniziali, precedenza del server, profondità e nessun troncamento', () => {
  const MiB = 1024 * 1024
  assert.equal(defaultImportLimits.fileBytes, 10 * MiB)
  assert.equal(defaultImportLimits.pdfPages, 30)
  assert.equal(defaultImportLimits.docxUncompressedBytes, 50 * MiB)
  assert.equal(defaultImportLimits.docxEntries, 2000)
  assert.equal(defaultImportLimits.normalizedTextChars, 200_000)
  assert.equal(defaultImportLimits.providerCallsPerAnalysis, 2)
  assert.deepEqual(resolveImportLimits(), defaultImportLimits)
  const configured = resolveImportLimits({ normalizedTextChars: 400_000, pdfPages: 10, blocks: undefined })
  assert.equal(configured.normalizedTextChars, 400_000, 'il server può alzare un limite')
  assert.equal(configured.pdfPages, 10, 'o abbassarlo')
  assert.equal(configured.blocks, defaultImportLimits.blocks)
  assert.ok(Object.isFrozen(configured))
  for (const bad of [{ pdfPages: 0 }, { pdfPages: 1.5 }, { pdfPages: '30' }, { unknown: 1 }] as Json[]) assert.throws(() => resolveImportLimits(bad), RangeError)

  assert.equal(jsonDepthExceeds(1, 0), false)
  assert.equal(jsonDepthExceeds({ a: [1] }, 2), false)
  assert.equal(jsonDepthExceeds({ a: [1] }, 1), true)
  let deep: unknown = 0
  for (let index = 0; index < 100_000; index++) deep = [deep]
  assert.equal(jsonDepthExceeds(deep, defaultImportLimits.jsonDepth), true, 'nessuna ricorsione sul JSON ostile')
  const request = { analysisRequestId: 'e', kind: 'workout', normalizedDocument: readJson('documents/workout-incomplete.json'), expectedSchemaVersion: '1.0' }
  assert.equal(jsonDepthExceeds(request, defaultImportLimits.jsonDepth), false)

  const document = readJson('documents/workout-incomplete.json') as NormalizedDocument
  const before = clone(document)
  assert.deepEqual(normalizedDocumentLimitViolations(document), [])
  const chars = document.blocks.reduce((total, block) => total + [...block.text].length, 0)
  const tight = resolveImportLimits({ blocks: document.blocks.length - 1, normalizedTextChars: chars - 1 })
  assert.deepEqual(normalizedDocumentLimitViolations(document, tight), [
    { limit: 'blocks', max: document.blocks.length - 1, actual: document.blocks.length },
    { limit: 'normalizedTextChars', max: chars - 1, actual: chars },
  ])
  assert.deepEqual(document, before, 'il documento non viene troncato')
})

test('confine: canonical.ts usa solo Web API e i contratti, importabile da Deno', () => {
  const file = join(root, 'src', 'import', 'mapping', 'canonical.ts')
  const source = readFileSync(file, 'utf8')
  const specifier = /(?:^|\n)\s*(?:import|export)\b[^'"]*?\sfrom\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  const targets = [...source.matchAll(specifier)].map(match => match[1] ?? match[2]!)
  assert.deepEqual(targets, ['../contracts/index.ts'])
  assert.doesNotMatch(source, /\b(?:window|localStorage|sessionStorage|indexedDB|Deno|process|Buffer|require)\b[.(]/)
  const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.contracts.json'), 'utf8'))
  assert.ok(tsconfig.include.includes('src/import/mapping/canonical.ts'), 'typecheck senza DOM né Node')
  assert.equal(relative(root, file).replaceAll('\\', '/'), 'src/import/mapping/canonical.ts')
})
