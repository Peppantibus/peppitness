import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DocumentReaderError, type DocumentReader, type DocumentReaderInput, type DocumentReadResult, type NormalizedDocument, type SourceBlock } from '../src/import/contracts/index.ts'
import { sha256Hex } from '../src/import/readers/file-checks.ts'
import { ReaderWorkerError } from '../src/import/readers/worker-client.ts'
import { memoryBackend, ReviewStore, type ReviewStorageBackend } from '../src/import/review/local-storage.ts'
import { blockAtPoint, buildSourceItems, pageNumbers, sectionOf, type SourceItem, type TableLayout } from '../src/features/import/source-model.ts'
import { ImportReviewStore, problemOf } from '../src/persistence/import-review-store.ts'

const fixtures = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'tests', 'fixtures', 'import')
const expected = (path: string) => JSON.parse(readFileSync(join(fixtures, path), 'utf8')) as DocumentReadResult

// ---------------------------------------------------------------------------
// Modello della fonte
// ---------------------------------------------------------------------------

const cellsOf = (table: TableLayout): string[] => table.rows.flatMap(row => row.cells.flatMap(cell => [
  ...(cell.block && cell.block.kind === 'table_cell' ? [cell.block.id] : []), ...cell.nested.flatMap(cellsOf),
]))
const tablesOf = (items: SourceItem[]) => items.flatMap(item => item.type === 'table' ? [item.table] : [])
const shape = (table: TableLayout) => table.rows.map(row => row.cells.map(cell => cell.block ? `${cell.block.id.split(':').slice(-4).join(':')}${cell.rowSpan > 1 ? `↓${cell.rowSpan}` : ''}${cell.columnSpan > 1 ? `→${cell.columnSpan}` : ''}` : '·'))

test('11: celle unite nella loro colonna, una volta sola, senza spostare i valori', () => {
  const { document } = expected('docx/docx-merged-cells.expected.json')
  const items = buildSourceItems(document.blocks)
  const tables = tablesOf(items)
  assert.deepEqual(tables.map(table => table.columns), [3, 3])
  assert.deepEqual(shape(tables[0]!), [
    ['r:0:c:0', 'r:0:c:1', 'r:0:c:2'],
    ['r:1:c:0↓2', 'r:1:c:1', 'r:1:c:2'],
    ['r:2:c:1', 'r:2:c:2'],
    ['r:3:c:0↓3', 'r:3:c:1→2'],
    ['r:4:c:1', 'r:4:c:2'],
    ['r:5:c:1', 'r:5:c:2'],
  ])
  assert.deepEqual(shape(tables[1]!), [['r:0:c:0↓2→2', 'r:0:c:2'], ['r:1:c:2'], ['r:2:c:0→2', 'r:2:c:2'], ['r:3:c:0→2', 'r:3:c:2']])
  const cells = document.blocks.filter(block => block.kind === 'table_cell').map(block => block.id)
  assert.deepEqual(tables.flatMap(cellsOf).sort(), [...cells].sort(), 'ogni cella compare una volta')
})

test('11: tabelle annidate dentro la cella che le contiene; testo prima e dopo in ordine', () => {
  const { document } = expected('docx/docx-nested-tables.expected.json')
  const items = buildSourceItems(document.blocks)
  assert.deepEqual(items.map(item => item.type === 'table' ? item.table.id : item.block.id), ['p:1', 'p:2', 't:1', 'p:3'])
  const outer = tablesOf(items)[0]!
  const nestedIn = (table: TableLayout): Record<string, string[]> => Object.fromEntries(table.rows.flatMap(row => row.cells.filter(cell => cell.nested.length).flatMap(cell => [[cell.block!.id, cell.nested.map(inner => inner.id)], ...Object.entries(cell.nested.reduce((all, inner) => ({ ...all, ...nestedIn(inner) }), {}))])))
  assert.deepEqual(nestedIn(outer), { 't:1:r:1:c:1': ['t:2'], 't:1:r:2:c:1': ['t:3'], 't:3:r:1:c:1': ['t:4'] })
  const cells = document.blocks.filter(block => block.kind === 'table_cell').map(block => block.id)
  assert.deepEqual(cellsOf(outer).sort(), [...cells].sort())
  // Riga coperta da un'unione verticale: nessuna cella di riempimento al posto della colonna 0.
  assert.deepEqual(shape(outer.rows[2]!.cells[1]!.nested[0]!), [['r:0:c:0↓2', 'r:0:c:1'], ['r:1:c:1']])
})

test('11: sezioni DOCX, caselle di testo e pagine PDF', () => {
  const { document } = expected('docx/docx-side-content.expected.json')
  const sections = buildSourceItems(document.blocks).map(item => item.section)
  assert.deepEqual([...new Set(sections)], ['body', 'header', 'footer', 'footnote', 'endnote'])
  assert.equal(sectionOf('box:1:p:1'), 'body')
  const scan = expected('pdf/pdf-last-page-scan.expected.json')
  assert.deepEqual(pageNumbers(scan.document, scan.metadata.pageCount), [1, 2, 3])
  // Dopo una ripresa (senza metadati) restano almeno le pagine con testo; la pagina 3 è descritta nei problemi.
  assert.deepEqual(pageNumbers(scan.document, null), [1, 2])
  const table = expected('pdf/pdf-table.expected.json').document.blocks
  const cell = table.find(block => block.id === 'pdf:1:t:1:r:1:c:0')! as SourceBlock
  const [x, y, w, h] = cell.bbox!
  assert.equal(blockAtPoint(table, x + w / 2, y + h / 2)?.id, cell.id, 'la cella prima della riga che la contiene')
  assert.equal(blockAtPoint(table, 0.99, 0.99), null)
})

// ---------------------------------------------------------------------------
// Motore: scelta, lettura, journal
// ---------------------------------------------------------------------------

const OWNER = '11111111-1111-4111-8111-111111111111'
const docxBytes = new Uint8Array(readFileSync(join(fixtures, 'docx', 'docx-paragraphs.docx')))
const docxResult = expected('docx/docx-paragraphs.expected.json')
const pdfBytes = new Uint8Array(readFileSync(join(fixtures, 'pdf', 'pdf-simple.pdf')))
const pdfResult = expected('pdf/pdf-simple.expected.json')
const file = (name: string, bytes: Uint8Array) => ({ name, size: bytes.byteLength, type: '', arrayBuffer: async () => bytes.slice().buffer })

interface Pending { input: DocumentReaderInput; resolve: (result: DocumentReadResult) => void; reject: (error: unknown) => void }
/** `honorAbort: false`: reader che risponde comunque dopo l'annullamento (risposta tardiva vera). */
function fakeReaders({ honorAbort = true } = {}) {
  const calls: Pending[] = []
  const closed: string[] = []
  const createReader = (format: 'docx' | 'pdf'): DocumentReader & { close: () => void } => ({
    format, readerVersion: 'fake',
    read: input => new Promise((resolve, reject) => {
      calls.push({ input, resolve, reject })
      if (honorAbort) input.signal.addEventListener('abort', () => reject(new DocumentReaderError('cancelled', 'Lettura annullata.')), { once: true })
    }),
    close: () => { closed.push(format) },
  })
  return { calls, closed, createReader }
}
/** Risultato coerente con i byte letti: stesso sourceHash del file, come un reader reale. */
async function resultFor(result: DocumentReadResult, bytes: Uint8Array): Promise<DocumentReadResult> {
  return { document: { ...result.document, sourceHash: await sha256Hex(bytes) } as NormalizedDocument, metadata: result.metadata }
}
const settle = () => new Promise(done => setTimeout(done, 0))
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await settle() }
  throw new Error('condizione non raggiunta')
}
let ids = 0
const store = (backend: ReviewStorageBackend, readers = fakeReaders(), owner = OWNER) =>
  ({ readers, engine: new ImportReviewStore(owner, { journal: new ReviewStore(backend), createReader: readers.createReader, newId: () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}` }) })

test('11: lettura locale, journal senza byte, ripresa dopo reload e originale solo con la stessa impronta', async () => {
  const backend = memoryBackend()
  const { engine, readers } = store(backend)
  engine.start()
  await waitFor(() => engine.getSnapshot().phase === 'ready')
  const selecting = engine.select('workout', file('scheda.docx', docxBytes))
  await waitFor(() => readers.calls.length === 1)
  let slot = engine.getSnapshot().slots.workout
  assert.equal(slot.session?.status, 'reading')
  assert.equal(engine.getSnapshot().guards.busy, true, 'lettura in corso: guardie attive')
  assert.equal(readers.calls[0]!.input.metadata.format, 'docx')
  readers.calls[0]!.resolve(await resultFor(docxResult, docxBytes))
  await selecting
  slot = engine.getSnapshot().slots.workout
  assert.deepEqual([slot.session?.status, slot.storage, slot.session?.persistence, slot.original], ['reading', 'durable', 'durable', null])
  assert.deepEqual(engine.getSnapshot().guards, { busy: false, unsaved: false, logoutRisk: false })
  assert.ok(slot.metadata?.inventory.length)
  const stored = [...backend.records.values()]
  assert.equal(stored.length, 1)
  assert.ok(!JSON.stringify(stored).includes('"bytes"') && !Object.values(stored[0]!.session as object).some(value => ArrayBuffer.isView(value)), 'nessun byte nel journal')

  // Reload: nuova istanza, stesso archivio. Fonte consultabile, originale assente.
  const { engine: again } = store(backend)
  again.start()
  await waitFor(() => again.getSnapshot().phase === 'ready')
  const restored = again.getSnapshot().slots.workout
  assert.deepEqual([restored.restored, restored.original, restored.metadata, restored.session?.document?.blocks.length], [true, null, null, docxResult.document.blocks.length])
  // File omonimo ma diverso: rifiutato; stesso contenuto: originale riaperto.
  await again.attachOriginal('workout', file('scheda.docx', pdfBytes))
  assert.equal(again.getSnapshot().slots.workout.notice?.tone, 'warning')
  const other = new Uint8Array(docxBytes); other[other.length - 1] ^= 1
  await again.attachOriginal('workout', file('scheda.docx', other))
  assert.match(again.getSnapshot().slots.workout.notice!.text, /diverso da quello letto/)
  assert.equal(again.getSnapshot().slots.workout.original, null)
  await again.attachOriginal('workout', file('altro-nome.docx', docxBytes))
  assert.ok(again.getSnapshot().slots.workout.original)
  // L'altro dominio resta separato.
  assert.equal(again.getSnapshot().slots.diet.session, null)
})

test('11: annullamento, cambio file durante la lettura e risposte tardive ignorate', async () => {
  const backend = memoryBackend()
  const { engine, readers } = store(backend, fakeReaders({ honorAbort: false }))
  engine.start()
  void engine.select('diet', file('piano.pdf', pdfBytes))
  await waitFor(() => readers.calls.length === 1)
  engine.cancel('diet')
  assert.equal(readers.calls[0]!.input.signal.aborted, true, 'il worker riceve l’annullamento')
  assert.equal(engine.getSnapshot().slots.diet.session, null)
  assert.match(engine.getSnapshot().slots.diet.notice!.text, /annullata/)
  readers.calls[0]!.resolve(await resultFor(pdfResult, pdfBytes))
  await settle()
  assert.equal(engine.getSnapshot().slots.diet.session, null, 'risultato tardivo ignorato')

  // Cambio file mentre il primo è in lettura: il primo si ferma, vale solo il secondo.
  void engine.select('diet', file('primo.pdf', pdfBytes))
  await waitFor(() => readers.calls.length === 2)
  const second = engine.select('diet', file('secondo.docx', docxBytes))
  await waitFor(() => readers.calls.length === 3)
  assert.equal(readers.calls[1]!.input.signal.aborted, true)
  readers.calls[1]!.resolve(await resultFor(pdfResult, pdfBytes))
  await settle()
  assert.deepEqual([engine.getSnapshot().slots.diet.session?.file.name, engine.getSnapshot().slots.diet.session?.document], ['secondo.docx', null], 'la risposta del file sostituito non tocca il nuovo')
  readers.calls[2]!.resolve(await resultFor(docxResult, docxBytes))
  await second
  assert.equal(engine.getSnapshot().slots.diet.session?.file.name, 'secondo.docx')
  assert.equal(backend.records.size, 1)

  // Stop (smontaggio per cambio account) durante una lettura: nulla viene scritto dopo.
  void engine.select('workout', file('scheda.pdf', pdfBytes))
  await waitFor(() => readers.calls.length === 4)
  engine.stop()
  assert.equal(readers.calls[3]!.input.signal.aborted, true)
  assert.deepEqual(readers.closed.sort(), ['docx', 'pdf'], 'worker chiusi')
  readers.calls[3]!.resolve(await resultFor(pdfResult, pdfBytes))
  await settle()
  assert.equal(engine.getSnapshot().slots.workout.session, null)
  assert.equal(backend.records.size, 1)
})

test('11: file rifiutati, errori del reader e guasti del worker con messaggi veritieri', async () => {
  const backend = memoryBackend()
  const { engine, readers } = store(backend)
  engine.start()
  await engine.select('workout', file('vecchio.doc', docxBytes))
  let slot = engine.getSnapshot().slots.workout
  assert.deepEqual([slot.session, slot.problem?.code], [null, 'unsupported'])
  assert.match(slot.problem!.message, /Word 97-2003/)
  await engine.select('workout', { ...file('grande.pdf', pdfBytes), size: 11 * 1024 * 1024 })
  assert.match(engine.getSnapshot().slots.workout.problem!.message, /Massimo 10 MB, questo file ne occupa 11/)
  assert.equal(readers.calls.length, 0, 'nessuna lettura per file rifiutati')

  // Rifiuto del reader (revisioni aperte): messaggio mostrato così com'è, nessun nuovo tentativo.
  const tracked = engine.select('workout', file('revisioni.docx', docxBytes))
  await waitFor(() => readers.calls.length === 1)
  readers.calls[0]!.reject(new DocumentReaderError('unsupported', 'Il documento contiene revisioni non accettate (corpo: 3).'))
  await tracked
  slot = engine.getSnapshot().slots.workout
  assert.deepEqual([slot.session?.status, slot.problem?.message, slot.problem?.retry, slot.original], ['failed', 'Il documento contiene revisioni non accettate (corpo: 3).', false, null])
  assert.equal(backend.records.size, 0, 'una lettura fallita non va nel journal')

  // Guasto del worker: stessi byte, nuova lettura possibile.
  const broken = engine.select('workout', file('scheda.docx', docxBytes))
  await waitFor(() => readers.calls.length === 2)
  readers.calls[1]!.reject(new ReaderWorkerError('worker_failed', 'Il lettore dei documenti si è interrotto.'))
  await broken
  slot = engine.getSnapshot().slots.workout
  assert.deepEqual([slot.problem?.retry, Boolean(slot.original)], [true, true])
  const retry = engine.retry('workout')
  await waitFor(() => readers.calls.length === 3)
  readers.calls[2]!.resolve(await resultFor(docxResult, docxBytes))
  await retry
  assert.deepEqual([engine.getSnapshot().slots.workout.problem, engine.getSnapshot().slots.workout.storage], [null, 'durable'])
  assert.equal(problemOf(new Error('x')).retry, true)
})

test('11: archivio pieno volatile e dichiarato; rimozione, logout e isolamento per account', async () => {
  const full = memoryBackend()
  const quota: ReviewStorageBackend = { ...full, put: async () => { throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }) } }
  const { engine, readers } = store(quota)
  engine.start()
  const reading = engine.select('workout', file('scheda.docx', docxBytes))
  await waitFor(() => readers.calls.length === 1)
  readers.calls[0]!.resolve(await resultFor(docxResult, docxBytes))
  await reading
  const slot = engine.getSnapshot().slots.workout
  assert.deepEqual([slot.storage, slot.session?.persistence], ['volatile', 'volatile'])
  assert.match(slot.storageMessage!, /Spazio del dispositivo esaurito/)
  assert.deepEqual(engine.getSnapshot().guards, { busy: false, unsaved: true, logoutRisk: true }, 'chiusura e aggiornamento avvisano')

  const backend = memoryBackend()
  const a = store(backend)
  a.engine.start()
  const first = a.engine.select('workout', file('a.docx', docxBytes))
  await waitFor(() => a.readers.calls.length === 1)
  a.readers.calls[0]!.resolve(await resultFor(docxResult, docxBytes))
  await first
  await a.engine.remove('workout')
  assert.equal(backend.records.size, 0, 'rimozione anche dal journal')
  const second = a.engine.select('diet', file('a.docx', docxBytes))
  await waitFor(() => a.readers.calls.length === 2)
  a.readers.calls[1]!.resolve(await resultFor(docxResult, docxBytes))
  await second
  assert.equal(backend.records.size, 1)
  a.engine.stop()

  // Altro account sullo stesso dispositivo: i residui del primo vengono eliminati, nulla è visibile.
  const b = store(backend, fakeReaders(), '22222222-2222-4222-8222-222222222222')
  b.engine.start()
  await waitFor(() => b.engine.getSnapshot().phase === 'ready')
  assert.equal(b.engine.getSnapshot().slots.diet.session, null)
  assert.equal(backend.records.size, 0)

  // Logout: il journal dell'account si svuota.
  const c = store(backend)
  c.engine.start()
  const third = c.engine.select('diet', file('c.docx', docxBytes))
  await waitFor(() => c.readers.calls.length === 1)
  c.readers.calls[0]!.resolve(await resultFor(docxResult, docxBytes))
  await third
  assert.equal(backend.records.size, 1)
  await c.engine.clearDevice()
  assert.equal(backend.records.size, 0)
  assert.equal(c.engine.getSnapshot().slots.diet.session, null)
})
