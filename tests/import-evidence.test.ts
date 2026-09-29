import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ValidationIssue } from '../src/import/contracts/index.ts'
import { resolvePointer, validateProposal } from '../src/import/validation/validate.ts'

const fixtures = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'tests', 'fixtures', 'import')
type Json = any
const readJson = (path: string): Json => JSON.parse(readFileSync(join(fixtures, path), 'utf8'))

// --- Costruttori minimi di documenti e proposte sintetiche.
const block = (id: string, kind: string, text: string, extra: Json = {}) => ({
  id, kind, text, page: null, tableId: null, row: null, column: null, rowSpan: null, columnSpan: null, parentId: null, headingIds: [], origin: 'native', bbox: null, ...extra,
})
const doc = (blocks: Json[]) => ({ readerVersion: 'synthetic-fixture/1', sourceHash: 'a'.repeat(64), blocks, readingIssues: [] })
const exercise = (values: Json) => ({
  name: null, variant: null, equipment: null, measurementMode: 'reps', sets: null, optionalSets: null, repetitions: null, durationSeconds: null,
  restSeconds: null, rir: null, rpe: null, perSide: null, loadUnit: null, loadConvention: null, loadInstruction: null, tempoInstruction: null,
  prescriptionText: '', notes: [], ...values,
})
const ev = (path: string, ...spans: [string, string][]) => ({ path, spans: spans.map(([blockId, quote]) => ({ blockId, quote })) })
const workout = (sessions: Json[], evidence: Json[], extra: Json = {}) => ({
  schemaVersion: '1.0', kind: 'workout', outcome: 'extracted', title: 'Scheda', guidance: [], schedule: 'unknown', cycle: { startDate: null, weeks: null },
  sessions, complexRules: [], evidence: [ev('/title', ['p:1', 'Scheda']), ...evidence], issues: [], unassigned: [], ...extra,
})
const range = (min: number, max = min) => ({ min, max })

/** Una seduta con un solo esercizio in una riga di elenco: titolo p:1, seduta p:2, esercizio p:3. */
function single(line: string, values: Json, evidence: Json[]) {
  const document = doc([
    block('p:1', 'heading', 'Scheda'),
    block('p:2', 'heading', 'Seduta A', { headingIds: ['p:1'] }),
    block('p:3', 'list_item', line, { headingIds: ['p:1', 'p:2'] }),
  ])
  const proposal = workout([{ label: 'A', title: 'Seduta A', weekday: null, notes: [], exercises: [exercise({ name: 'Squat', prescriptionText: line, ...values })] }], [
    ev('/sessions/0/label', ['p:2', 'Seduta A']), ev('/sessions/0/title', ['p:2', 'Seduta A']),
    ev('/sessions/0/exercises/0/name', ['p:3', 'Squat']), ev('/sessions/0/exercises/0/prescriptionText', ['p:3', line]),
    ...evidence,
  ])
  const result = validateProposal('workout', document, proposal)
  assert.equal(result.status, 'draft')
  return result as Extract<typeof result, { status: 'draft' }>
}
const at = (result: { issues: ValidationIssue[] }, path: string) => result.issues.filter(issue => issue.sourcePath === path).map(issue => issue.code)
const E = '/sessions/0/exercises/0'

test('06: JSON Pointer RFC 6901 sulla proposta immutabile', () => {
  const value = { a: { 'b/c': 1, 'm~n': 2, '': 3 }, list: [10, 20], nil: null }
  assert.deepEqual(resolvePointer(value, ''), { found: true, value })
  assert.deepEqual(resolvePointer(value, '/a/b~1c'), { found: true, value: 1 })
  assert.deepEqual(resolvePointer(value, '/a/m~0n'), { found: true, value: 2 })
  assert.deepEqual(resolvePointer(value, '/a/'), { found: true, value: 3 })
  assert.deepEqual(resolvePointer(value, '/list/1'), { found: true, value: 20 })
  assert.deepEqual(resolvePointer(value, '/nil'), { found: true, value: null })
  for (const pointer of ['a', '/a/~2', '/list/01', '/list/-', '/list/2', '/nil/x', '/missing']) assert.deepEqual(resolvePointer(value, pointer), { found: false }, pointer)
})

test('06: citazioni cercate con la sola normalizzazione dichiarata', () => {
  const found = single('Squat: 3 x 8, recupero 2 minuti', { sets: 3, repetitions: range(8), restSeconds: range(120) }, [
    ev(`${E}/sets`, ['p:3', 'Squat:  3\tx 8']), // spazi Unicode e tab ridotti
    ev(`${E}/repetitions`, ['p:3', '3 x­ 8']), // trattino morbido rimosso
    ev(`${E}/restSeconds`, ['p:3', 'recupero 2 minuti']),
  ])
  assert.deepEqual(at(found, `${E}/sets`), [])
  assert.deepEqual(at(found, `${E}/repetitions`), [])
  // Maiuscole e segni tipografici non vengono ignorati: citazione diversa, valore critico senza riscontro.
  const strict = single('Squat: 3 x 8, recupero 1\'30"', { sets: 3, restSeconds: range(90) }, [
    ev(`${E}/sets`, ['p:3', 'SQUAT: 3 x 8']),
    ev(`${E}/restSeconds`, ['p:3', 'recupero 1’30”']),
  ])
  assert.deepEqual(at(strict, `${E}/sets`), ['quote_not_found'])
  assert.deepEqual(at(strict, `${E}/restSeconds`), ['quote_not_found'])
  // NFD nella citazione, NFC nel blocco: stessa forma canonica.
  const nfd = single('Lunedì: Squat 3 x 8', { sets: 3 }, [ev(`${E}/sets`, ['p:3', 'Lunedì: Squat 3 x 8'])])
  assert.deepEqual(at(nfd, `${E}/sets`), [])
})

test('06: conversioni deterministiche dei tempi registrate, numeri senza unità mai convertiti', () => {
  const cases: [string, Json, string, string | null][] = [
    ['Squat: 3 x 8, recupero 1,5 minuti', range(90), 'converted', 'minutes'],
    ['Squat: 3 x 8, recupero 2 min', range(120), 'converted', 'minutes'],
    ['Squat: 3 x 8, rec. 90"', range(90), 'source', 'seconds'],
    ['Squat: 3 x 8, recupero 1\'30"', range(90), 'converted', 'minutes_seconds'],
    ['Squat 3x8, pausa 60-90 s', range(60, 90), 'source', 'seconds'],
  ]
  for (const [line, rest, origin, rule] of cases) {
    const result = single(line, { sets: 3, repetitions: range(8), restSeconds: rest }, [ev(`${E}/restSeconds`, ['p:3', line.slice(line.search(/rec|pausa/))])])
    assert.ok(!result.issues.some(issue => issue.sourcePath === `${E}/restSeconds` && issue.code !== 'rest_range'), `${line}: ${at(result, `${E}/restSeconds`)}`)
    assert.deepEqual(result.provenance.find(entry => entry.sourcePath === `${E}/restSeconds`)?.origin, origin, line)
    assert.equal(result.provenance.find(entry => entry.sourcePath === `${E}/restSeconds`)?.rule, rule, line)
  }
  const timed = single('Plank: 3 x 1\'', { measurementMode: 'seconds', sets: 3, durationSeconds: range(60) }, [ev(`${E}/durationSeconds`, ['p:3', '3 x 1\''])])
  assert.equal(timed.provenance.find(entry => entry.sourcePath === `${E}/durationSeconds`)?.origin, 'converted')
  const bare = single('Squat: 3 x 8, recupero 90', { sets: 3, repetitions: range(8), restSeconds: range(90) }, [ev(`${E}/restSeconds`, ['p:3', 'recupero 90'])])
  assert.deepEqual(at(bare, `${E}/restSeconds`), ['value_unverified'])
  // Recupero a intervallo: conservato, serve la scelta del timer.
  const spread = single('Squat 3x8, pausa 60-90 s', { sets: 3, repetitions: range(8), restSeconds: range(60, 90) }, [ev(`${E}/restSeconds`, ['p:3', 'pausa 60-90 s'])])
  assert.deepEqual(at(spread, `${E}/restSeconds`), ['rest_range'])
  // Intervallo su /min: la prova del sotto-campo vale per il campo.
  const sub = single('Squat 3 x 8-10', { sets: 3, repetitions: range(8, 10) }, [ev(`${E}/repetitions/min`, ['p:3', '8-10'])])
  assert.deepEqual(at(sub, `${E}/repetitions`), [])
  // Prova per un campo vuoto: solo informativa.
  const nil = single('Squat 3 x 8', { sets: 3, repetitions: range(8) }, [ev(`${E}/rir`, ['p:3', 'Squat'])])
  assert.ok(nil.issues.some(issue => issue.code === 'evidence_for_null'))
})

/** Tabella con celle vere: intestazione e due righe, colonne 0–3. */
function tableDocument() {
  const H = { headingIds: ['p:1', 'p:2'] }
  const row = (index: number, cells: string[]) => [
    block(`t:1:r:${index}`, 'table_row', cells.join(' | '), { ...H, tableId: 't:1', row: index }),
    ...cells.map((text, column) => block(`t:1:r:${index}:c:${column}`, 'table_cell', text, { ...H, tableId: 't:1', row: index, column, rowSpan: 1, columnSpan: 1, parentId: `t:1:r:${index}` })),
  ]
  return doc([
    block('p:1', 'heading', 'Scheda'), block('p:2', 'heading', 'Seduta A', { headingIds: ['p:1'] }),
    ...row(0, ['Esercizio', 'Serie', 'Ripetizioni', 'Recupero']), ...row(1, ['Squat', '3', '10', '90"']), ...row(2, ['Panca', '4', '8', '2\'']),
  ])
}
function tableProposal(squat: Json, squatEvidence: Json[], withPanca = true) {
  const exercises = [exercise({ name: 'Squat', prescriptionText: 'Squat | 3 | 10 | 90"', ...squat })]
  const evidence = [ev('/sessions/0/label', ['p:2', 'Seduta A']), ev('/sessions/0/title', ['p:2', 'Seduta A']), ev(`${E}/name`, ['t:1:r:1:c:0', 'Squat']), ...squatEvidence]
  if (withPanca) {
    exercises.push(exercise({ name: 'Panca', prescriptionText: 'Panca | 4 | 8 | 2\'', sets: 4, repetitions: range(8), restSeconds: range(120) }))
    const P = '/sessions/0/exercises/1'
    evidence.push(ev(`${P}/name`, ['t:1:r:2:c:0', 'Panca']), ev(`${P}/sets`, ['t:1:r:2:c:1', '4']), ev(`${P}/repetitions`, ['t:1:r:2:c:2', '8']),
      ev(`${P}/restSeconds`, ['t:1:r:2:c:3', '2\'']), ev(`${P}/prescriptionText`, ['t:1:r:2', 'Panca | 4 | 8 | 2\'']))
  }
  return workout([{ label: 'A', title: 'Seduta A', weekday: null, notes: [], exercises }], evidence)
}

test('06: celle e intestazioni: colonna giusta verificata, numero della colonna sbagliata bloccato', () => {
  const good = validateProposal('workout', tableDocument(), tableProposal({ sets: 3, repetitions: range(10), restSeconds: range(90) }, [
    ev(`${E}/sets`, ['t:1:r:1:c:1', '3'], ['t:1:r:0:c:1', 'Serie']), ev(`${E}/repetitions`, ['t:1:r:1:c:2', '10']), ev(`${E}/restSeconds`, ['t:1:r:1:c:3', '90"']),
    ev(`${E}/prescriptionText`, ['t:1:r:1', 'Squat | 3 | 10 | 90"']),
  ]))
  assert.equal(good.status, 'draft')
  if (good.status !== 'draft') return
  assert.ok(!good.issues.some(issue => ['wrong_column', 'wrong_context', 'value_contradicts_source', 'value_unverified'].includes(issue.code)), JSON.stringify(good.issues.map(issue => issue.code)))
  assert.equal(good.provenance.find(entry => entry.sourcePath === '/sessions/0/exercises/1/restSeconds')?.origin, 'converted')
  // Nessun doppio conteggio: righe citate tramite le celle, nessun blocco scoperto.
  assert.ok(!good.issues.some(issue => issue.code.startsWith('uncovered') || issue.code.endsWith('_not_covered')))

  const wrong = validateProposal('workout', tableDocument(), tableProposal({ sets: 10, repetitions: range(10), restSeconds: range(90) }, [
    ev(`${E}/sets`, ['t:1:r:1:c:2', '10']), ev(`${E}/repetitions`, ['t:1:r:1:c:2', '10']), ev(`${E}/restSeconds`, ['t:1:r:1:c:3', '90"']),
  ]))
  assert.equal(wrong.status === 'draft' && at(wrong, `${E}/sets`).join(), 'wrong_column')

  // Riga omessa: un solo problema per la riga, non uno per cella.
  const omitted = validateProposal('workout', tableDocument(), tableProposal({ sets: 3, repetitions: range(10), restSeconds: range(90) }, [
    ev(`${E}/sets`, ['t:1:r:1:c:1', '3']), ev(`${E}/repetitions`, ['t:1:r:1:c:2', '10']), ev(`${E}/restSeconds`, ['t:1:r:1:c:3', '90"']),
  ], false))
  assert.ok(omitted.status === 'draft')
  if (omitted.status !== 'draft') return
  assert.deepEqual(omitted.issues.filter(issue => issue.code === 'uncovered_numeric_content').map(issue => issue.sourceRefs), [['t:1:r:2']])
})

test('06: intestazione condivisa, omonimi in sedute diverse e parentela falsa', () => {
  const document = doc([
    block('p:1', 'heading', 'Scheda'),
    block('p:2', 'heading', 'Seduta A', { headingIds: ['p:1'] }), block('p:3', 'list_item', 'Squat 3 x 5', { headingIds: ['p:1', 'p:2'] }),
    block('p:4', 'heading', 'Seduta B', { headingIds: ['p:1'] }), block('p:5', 'list_item', 'Squat 5 x 5', { headingIds: ['p:1', 'p:4'] }),
  ])
  const session = (label: string, heading: string, line: string, sets: number, index: number) => ({
    session: { label, title: `Seduta ${label}`, weekday: null, notes: [], exercises: [exercise({ name: 'Squat', prescriptionText: line, sets, repetitions: range(5) })] },
    evidence: [
      ev(`/sessions/${index}/label`, [heading, `Seduta ${label}`]), ev(`/sessions/${index}/title`, [heading, `Seduta ${label}`]),
      ev(`/sessions/${index}/exercises/0/name`, [line === 'Squat 3 x 5' ? 'p:3' : 'p:5', 'Squat']),
      ev(`/sessions/${index}/exercises/0/sets`, [line === 'Squat 3 x 5' ? 'p:3' : 'p:5', `${sets} x 5`]),
    ],
  })
  // L'esercizio della seduta A è preso dalla riga omonima della seduta B.
  const a = session('A', 'p:2', 'Squat 5 x 5', 5, 0), b = session('B', 'p:4', 'Squat 5 x 5', 5, 1)
  const result = validateProposal('workout', document, workout([a.session, b.session], [...a.evidence, ...b.evidence]))
  assert.equal(result.status, 'draft')
  if (result.status !== 'draft') return
  assert.deepEqual(at(result, '/sessions/0/exercises/0/name'), ['wrong_section'])
  assert.deepEqual(result.issues.filter(issue => issue.code === 'uncovered_numeric_content').map(issue => issue.sourceRefs), [['p:3']])

  // Parentela falsa: la riga della panca dichiarata figlia della riga dello squat non ne diventa l'intestazione.
  const falseParent = tableDocument()
  for (const entry of falseParent.blocks) if (entry.id === 't:1:r:1') entry.parentId = 't:1:r:2'
  const proposal = tableProposal({ sets: 4, repetitions: range(10), restSeconds: range(90) }, [ev(`${E}/sets`, ['t:1:r:2', '4'])])
  const checked = validateProposal('workout', falseParent, proposal)
  assert.equal(checked.status === 'draft' && at(checked, `${E}/sets`).join(), 'wrong_context')
})

test('06: regole con fonti proprie, regola globale della dieta copiata in un pasto e testo critico riformulato', () => {
  const partialDocument = readJson('documents/workout-partially-interpretable.json')
  const partial = readJson('extractions/workout-partially-interpretable.json')
  // Senza evidence esplicita il testo della regola deve comparire in uno dei suoi sourceRefs.
  partial.evidence = partial.evidence.filter((entry: Json) => !entry.path.startsWith('/complexRules/'))
  const implicit = validateProposal('workout', partialDocument, partial)
  assert.ok(implicit.status === 'draft' && !implicit.issues.some(issue => issue.sourcePath?.startsWith('/complexRules/') && issue.code === 'missing_evidence'))
  partial.complexRules[1].text = 'settimana 4 scarico al 50%'
  const invented = validateProposal('workout', partialDocument, partial)
  assert.ok(invented.status === 'draft' && at(invented, '/complexRules/1/text').includes('missing_evidence'))

  const dietDocument = readJson('documents/diet-alternatives-additions.json')
  const diet = readJson('extractions/diet-alternatives-additions.json')
  diet.days[0].meals[0].additions.push('Nei giorni di allenamento lungo aggiungere 20 g di frutta secca')
  diet.evidence.push(ev('/days/0/meals/0/additions/0', ['p:2', 'Nei giorni di allenamento lungo aggiungere 20 g di frutta secca']))
  const copied = validateProposal('diet', dietDocument, diet)
  assert.ok(copied.status === 'draft' && at(copied, '/days/0/meals/0/additions/0').includes('global_rule_in_meal'))

  const rephrased = readJson('extractions/diet-spec-example.json')
  rephrased.days[0].meals[0].alternatives[0] = 'Latte 200 ml al posto dello yogurt.'
  const checked = validateProposal('diet', readJson('documents/diet-spec-example.json'), rephrased)
  assert.ok(checked.status === 'draft' && at(checked, '/days/0/meals/0/alternatives/0').includes('text_not_in_quote'))
})
