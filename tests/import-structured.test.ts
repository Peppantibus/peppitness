import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { readDocx } from '../src/import/readers/docx.ts'
import { parseStructured, buildStructured, identityKey, isStructuredDraft, TemplateError } from '../src/import/structured/parser.ts'
import { structuredDocx } from '../scripts/generate-structured-templates.mjs'
import { buildDocx, para } from '../scripts/lib/docx-fixtures.mjs'
import { validateCommitCommand } from '../src/import/contracts/commit.ts'
import { daysForType } from '../src/domain/meal-plans.ts'
import { StructuredImportsStore } from '../src/persistence/structured-imports-store.ts'
import { commandHash, contentHash } from '../src/import/mapping/canonical.ts'
import type { StructuredJournal, StructuredRecord } from '../src/import/structured/journal.ts'
import type { ImportsRepository } from '../src/persistence/imports-repository.ts'
import type { CommitCommand, ImportReceipt } from '../src/import/contracts/commit.ts'
const catalog = { personal: [], shared: [], complete: true }
const read = (bytes: Uint8Array) => readDocx({ bytes, metadata: { format: 'docx', mediaType: null }, signal: new AbortController().signal })
const draft = async (kind: 'workout' | 'diet') => parseStructured((await read(structuredDocx(kind))).document, kind)

test('template pubblici riproducibili, import completo senza problemi o decisioni artificiali', async () => {
  for (const kind of ['workout', 'diet'] as const) {
    assert.deepEqual(new Uint8Array(await readFile(`public/templates/peppitness-${kind}-v1.docx`)), structuredDocx(kind))
    const d = await draft(kind), out = buildStructured(d, catalog)
    assert.deepEqual(out.problems, []); assert.ok(out.command); assert.ok(validateCommitCommand(kind, out.command).ok)
    assert.equal(out.command.provenance.analysis.jobId, null)
    assert.ok(out.command.provenance.items.every(i => !i.decisions.length && d.document.blocks.some(b => b.id === i.localId)))
    if (out.preview.kind === 'workout') {
      assert.equal(out.preview.resolved.days.length, 2); assert.equal(out.preview.resolved.catalog.length, 2)
      assert.equal(out.preview.resolved.days[0]!.prescriptions[0]!.sets, 2)
      assert.equal(out.preview.resolved.days[0]!.prescriptions[0]!.optionalSets, 0)
      assert.equal(out.preview.resolved.days[0]!.prescriptions[0]!.note, 'Terza facoltativa da S5.')
    } else {
      const document = out.preview.resolved.plan.document
      assert.equal(document.days.flatMap(d => d.meals.flatMap(m => m.foods)).length, 5)
      assert.equal(document.days[1]!.meals[1]!.foods[0]!.quantity, '')
      assert.equal(document.days[0]!.meals[0]!.alternatives.length, 1)
      assert.equal(document.days[1]!.meals[1]!.additions.length, 1)
      assert.match(document.days[0]!.meals[0]!.note, /Yogurt esempio: Bianco/)
      assert.equal(daysForType(document, 'training')[0]!.name, 'Allenamento')
    }
  }
})
test('variante indipendente: gruppi non contigui, dose iniziale e quantità conservate', async () => {
  const example = { title: 'Circuito indipendente', sections: { Allenamento: [['X', 'Salto sintetico', '4', '', '20', '0', 'Solo da W9 aumentare a 5 serie.'], ['Y', 'Remata sintetica', '1', '12', '', '75', ''], ['X', 'Salto sintetico', '2', '', '40', '10', 'Seconda occorrenza.']] } }
  const out = buildStructured(parseStructured((await read(structuredDocx('workout', example))).document, 'workout'), catalog)
  assert.deepEqual(out.problems, []); assert.equal(out.preview.kind, 'workout')
  if (out.preview.kind === 'workout') { assert.equal(out.preview.resolved.catalog.length, 2); assert.equal(out.preview.resolved.days[0]!.prescriptions.length, 2) }
  const d = await draft('diet'); d.tables.find(t => t.section === 'Alimenti')!.rows[0]!.cells[3]!.text = '100 g oppure 200 ml'
  const result = buildStructured(d, catalog); assert.deepEqual(result.problems, [])
  if (result.preview.kind === 'diet') assert.equal(result.preview.resolved.plan.document.days[0]!.meals[0]!.foods[0]!.quantity, '100 g oppure 200 ml')
})
test('errori puntuali: obbligatori, intervalli, recupero, dosi contraddittorie, correzione', async () => {
  for (const [column, value] of [[0, ''], [1, ''], [2, '0'], [2, '2-3'], [3, '12/10/8'], [3, '10-8'], [5, ''], [5, '60-90']] as const) {
    const d = await draft('workout'), cell = d.tables[0]!.rows[0]!.cells[column]!
    cell.text = value; const out = buildStructured(d, catalog)
    assert.equal(out.command, null); assert.ok(out.problems.some(p => p.cellId === cell.id))
  }
  const d = await draft('workout'), row = d.tables[0]!.rows[0]!
  row.cells[4]!.text = '30'; assert.match(buildStructured(d, catalog).problems.map(p => p.message).join(' '), /compila solo/)
  row.cells[4]!.text = ''; assert.ok(buildStructured(d, catalog).command)
  row.cells[5]!.text = '60'; assert.ok(buildStructured(d, catalog).command!.provenance.items.find(i => i.localId === row.cells[5]!.id)!.decisions.some(d => d.reason === 'user_edit'))
})
test('formato/versione/dominio errati, testo libero, colonne extra e contenuti non supportati rifiutati', async () => {
  const d = (await read(structuredDocx('workout'))).document
  assert.throws(() => parseStructured(d, 'diet'), /Template non riconosciuto/)
  const invalid = structuredClone(d); invalid.blocks[0]!.text = 'PEPPITNESS WORKOUT 2'; assert.throws(() => parseStructured(invalid, 'workout'), /versione 1/)
  invalid.blocks[0]!.text = d.blocks[0]!.text
  invalid.blocks.find(b => b.kind === 'table_cell')!.text = 'Set'; assert.throws(() => parseStructured(invalid, 'workout'), /intestazioni/)
  const extra = structuredClone(d), header = extra.blocks.find(b=>b.kind==='table_cell')!
  extra.blocks.push({ ...header, id:'extra-column', column:7, text:'RIR' })
  assert.throws(()=>parseStructured(extra,'workout'),/Non aggiungere colonne/)
  const merged = structuredClone(d); merged.blocks.find(b=>b.kind==='table_cell')!.columnSpan = 2
  assert.throws(()=>parseStructured(merged,'workout'),/celle unite/)
  const free = (await read(buildDocx({ body: para('Word libero') }))).document; assert.throws(() => parseStructured(free, 'workout'), TemplateError)
  for (const code of ['image_without_text', 'contact_data_removed', 'unsupported_content']) {
    const bad = structuredClone(d); bad.readingIssues.push({ code, sourceRefs: [], message: 'Contenuto non letto.' }); assert.throws(() => parseStructured(bad, 'workout'), /non supportato/)
  }
  const trailing = structuredClone(d); trailing.blocks.push({ ...d.blocks[0]!, id: 'extra', text: 'Una prescrizione libera.' }); assert.throws(() => parseStructured(trailing, 'workout'), /fuori struttura/)
})
test('dieta: ambiti espliciti, tipo assente o contraddittorio, niente prescrizioni dedotte', async () => {
  const d = await draft('diet'); d.tables[0]!.rows[0]!.cells[1]!.text = ''
  assert.match(buildStructured(d, catalog).problems[0]!.message, /Tipo/)
  d.tables[0]!.rows[0]!.cells[1]!.text = 'Qualsiasi'; d.tables.find(t => t.section === 'Alternative')!.rows[0]!.cells[1]!.text = 'Pasto inesistente'
  assert.match(buildStructured(d, catalog).problems[0]!.message, /Giorno\/Pasto/)
})
test('riuso compatibile univoco, ambiguo solo quando reale, metadata e deduplica per misura', async () => {
  const d = await draft('workout')
  const row = { id: crypto.randomUUID(), name: 'Squat esempio', variant: 'bilanciere', equipment: 'rack', measurementMode: 'reps' as const, perSide: false, loadUnit: 'kg' as const, loadConvention: 'total' as const, note: '', archivedAt: null, revision: 1, sourceTemplateId: null }
  const one = buildStructured(d, { ...catalog, personal: [row] })
  assert.deepEqual(one.problems, []); if (one.preview.kind === 'workout') assert.equal(one.preview.resolved.catalog.filter(b => b.choice.source === 'new').length, 1)
  const two = buildStructured(d, { ...catalog, personal: [row, { ...row, id: crypto.randomUUID(), variant: 'manubri' }] })
  assert.match(two.problems.map(p => p.message).join(' '), /più identità/)
  const incompatible = buildStructured(d, { ...catalog, personal: [{ ...row, measurementMode: 'seconds' }] })
  assert.deepEqual(incompatible.problems, [])
})
test('impostazioni opzionali accettate solo con la conferma finale e provenienza degli edit reale', async () => {
  const d = await draft('workout'), out = buildStructured(d, catalog)
  assert.equal(out.preview.kind, 'workout')
  if (out.preview.kind !== 'workout') return
  const binding = out.preview.resolved.catalog[0]!
  assert.equal(binding.choice.source, 'new'); if (binding.choice.source !== 'new') return
  d.choices[identityKey(binding.choice.values.name, 'reps')] = { ...binding.choice, values: { ...binding.choice.values, loadConvention: 'single-dumbbell', perSide: true } }
  const result = buildStructured(d, catalog)
  assert.deepEqual(result.problems, [])
  assert.ok(result.command!.provenance.items.some(i=>i.decisions.some(d=>d.field==='exerciseChoice' && d.reason==='user_edit')))
  assert.ok(isStructuredDraft(d))
  const corrupted = structuredClone(d); corrupted.tables[0]!.rows[0]!.cells[0]!.id = 'fake-cell'
  assert.equal(isStructuredDraft(corrupted),false)
})
function memoryJournal(): StructuredJournal {
  const records = new Map<string, StructuredRecord>()
  return {
    async load(owner) { return [...records.values()].filter(r => r.owner === owner).map(r => structuredClone(r)) },
    async write(record, expected) { const key = `${record.owner}:${record.kind}`; assert.equal(records.get(key)?.revision ?? null, expected, 'CAS'); records.set(key, structuredClone(record)) },
    async remove(owner, kind) { for (const [key, r] of records) if (r.owner === owner && (!kind || r.kind === kind)) records.delete(key) },
  }
}
test('store locale: zero job/provider, bozze, edit rapidi, doppio clic, risposta persa e reload con ricevuta', async () => {
  for (const kind of ['workout', 'diet'] as const) {
    const journal = memoryJournal(), receipts = new Map<string, ImportReceipt>()
    let commits = 0
    const commit = async (command: CommitCommand) => {
      commits++
      const receipt: ImportReceipt = { requestId: command.requestId, kind, commandHash: await commandHash(command), contentHash: await contentHash(command.payload), resultState: 'committed', planId: command.payload.kind === 'workout' ? command.payload.resolved.planId : command.payload.resolved.plan.id, versionId: command.payload.kind === 'workout' ? command.payload.resolved.versionId : null, exerciseBindings: command.payload.kind === 'workout' ? command.payload.resolved.catalog.map(b => ({ ref: b.ref, exerciseId: crypto.randomUUID(), resolution: 'created' })) : [], selection: null }
      receipts.set(command.requestId, receipt); throw new Error('Risposta persa')
    }
    const repository = { getReceipt: async (id: string) => receipts.get(id) ?? null, commitWorkout: commit, commitDiet: commit, analyze: () => assert.fail('Nessun provider') } as unknown as ImportsRepository
    const reader = () => ({ format: 'docx' as const, readerVersion: 'test', read: readDocx })
    let store = new StructuredImportsStore('owner-a', repository, undefined, journal, reader)
    await store.start(); await store.select(kind, new File([structuredDocx(kind)], 'example.docx'))
    const record = store.getSnapshot().slots[kind].record!; assert.ok(record); assert.equal(commits, 0)
    assert.ok(Object.keys(record.draft.ids).length > 0)
    const initialIds = structuredClone(record.draft.ids)
    const first = structuredClone(record.draft); first.title.text = 'Edit 1'
    const second = structuredClone(first); second.title.text = 'Edit 2'
    await Promise.all([store.edit(kind, first), store.edit(kind, second)])
    assert.equal(store.getSnapshot().slots[kind].record!.draft.title.text, 'Edit 2')
    await store.reload(); assert.equal(store.getSnapshot().slots[kind].record!.draft.title.text, 'Edit 2')
    assert.deepEqual(store.getSnapshot().slots[kind].record!.draft.ids,initialIds)
    const command = buildStructured(store.getSnapshot().slots[kind].record!.draft, catalog).command!
    await Promise.all([store.save(kind, command), store.save(kind, command)])
    assert.equal(commits, 1); assert.ok(store.getSnapshot().slots[kind].record!.command); store.stop()
    store = new StructuredImportsStore('owner-a', repository, undefined, journal, reader); await store.start()
    assert.equal(commits, 1); assert.ok(store.getSnapshot().slots[kind].record!.receipt)
    assert.equal((await journal.load('owner-b')).length, 0)
    await store.clear(); assert.equal((await journal.load('owner-a')).length, 0)
  }
})
test('file fuori percorso e archivio non disponibile non causano scritture al server', async () => {
  const unavailable = { async load() { return [] }, async write() { throw new Error('Quota locale esaurita') }, async remove() {} }
  let calls = 0
  const repository = { getReceipt: async()=>{ calls++; return null }, commitWorkout: async()=>{ calls++; throw new Error('Non atteso') } } as unknown as ImportsRepository
  const store = new StructuredImportsStore('owner-a',repository,undefined,unavailable,()=>({format:'docx',readerVersion:'test',read:readDocx}))
  await store.start()
  for (const extension of ['pdf','doc']) { await store.select('workout',new File([structuredDocx('workout')],`example.${extension}`)); assert.match(store.getSnapshot().slots.workout.problem!,/non sono supportati/); assert.equal(store.getSnapshot().slots.workout.record,null) }
  await store.select('workout',new File(['%PDF-1.7\n'],'disguised.docx')); assert.match(store.getSnapshot().slots.workout.problem!,/contiene un PDF/)
  await store.select('workout',new File([structuredDocx('workout')],'example.docx'))
  assert.equal(store.getSnapshot().slots.workout.durable,false)
  const command = buildStructured(store.getSnapshot().slots.workout.record!.draft,catalog).command!
  await store.save('workout',command); assert.equal(calls,0)
})
