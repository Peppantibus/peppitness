// Reader PDF del task 05: fixture binarie vere (tests/fixtures/import/pdf, generate da
// scripts/generate-pdf-fixtures.mjs), qualità pagina per pagina, rifiuti e limiti, annullamento,
// trasporto del worker e regole geometriche pure di src/import/readers/pdf-layout.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DocumentReaderError, normalizeSourceText, resolveImportLimits, validateDocumentReadResult,
  type DocumentReadResult, type ImportLimits, type SourceBlock,
} from '../src/import/contracts/index.ts'
import { PDF_READER_VERSION, pdfReader, readPdf, type PdfReaderOptions } from '../src/import/readers/pdf.ts'
import { assembleDocument, layoutPage, pdfReadingIssueCodes, type LayoutItem, type PageInput } from '../src/import/readers/pdf-layout.ts'
import { createWorkerDocumentReader, type ReaderWorkerHandle } from '../src/import/readers/worker-client.ts'
import { serveDocumentReader, type ReadFunction, type ReaderWorkerScope } from '../src/import/readers/worker-protocol.ts'
// @ts-expect-error modulo JavaScript dei generatori di fixture, senza dichiarazioni di tipo
import { buildPdf, image, manyPages, noiseImage, pdfFixtureBuilders, text } from '../scripts/lib/pdf-fixtures.mjs'
// @ts-expect-error modulo JavaScript dei generatori di fixture, senza dichiarazioni di tipo
import { buildDocx, para } from '../scripts/lib/docx-fixtures.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const folder = join(root, 'tests', 'fixtures', 'import', 'pdf')
const decoderAssetsUrl = pathToFileURL(join(root, 'node_modules', 'pdfjs-dist', 'wasm')).href + '/'
const fixtureBytes = (name: string) => new Uint8Array(readFileSync(join(folder, name)))
const expectedOf = (name: string) => JSON.parse(readFileSync(join(folder, name), 'utf8')) as DocumentReadResult

interface ManifestCase { id: string; sourceFile: string; sha256: string; expected: string | null; expectedError: string | null; summary: string; tags: string[] }
const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as { formatVersion: number; readerVersion: string; cases: ManifestCase[] }

const read = (bytes: Uint8Array, options: PdfReaderOptions & { signal?: AbortSignal; mediaType?: string | null } = {}) =>
  readPdf({ bytes, metadata: { format: 'pdf', mediaType: options.mediaType ?? null }, signal: options.signal ?? new AbortController().signal }, { decoderAssetsUrl, ...options })
const readFixture = (id: string) => read(fixtureBytes(`${id}.pdf`))
const limits = (overrides: Partial<ImportLimits>) => resolveImportLimits(overrides)
const byId = (result: DocumentReadResult) => new Map(result.document.blocks.map(block => [block.id, block]))
const pageStatus = (result: DocumentReadResult) => result.metadata.inventory.map(entry => [entry.page, entry.status, entry.issueCodes])
const issues = (result: DocumentReadResult, code: string) => result.document.readingIssues.filter(issue => issue.code === code)
const blocksOf = (result: DocumentReadResult, page: number) => result.document.blocks.filter(block => block.page === page)

async function rejects(promise: Promise<unknown>, code: string, pattern?: RegExp, limit?: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DocumentReaderError, `atteso DocumentReaderError, ricevuto ${String(error)}`)
    assert.equal(error.code, code, error.message)
    if (pattern) assert.match(error.message, pattern)
    if (limit) assert.equal(error.limit?.limit, limit)
    return true
  })
}

/** Invarianti di ogni lettura riuscita: una voce per pagina, bbox con pagina reale, testo canonico, niente omissioni silenziose. */
function checkInvariants(result: DocumentReadResult) {
  assert.ok(validateDocumentReadResult(result).ok)
  const pageCount = result.metadata.pageCount!
  assert.deepEqual(result.metadata.inventory.map(entry => entry.page), Array.from({ length: pageCount }, (_, index) => index + 1), 'ogni pagina controllata')
  const codes = new Set(result.document.readingIssues.map(issue => issue.code))
  for (const code of codes) assert.ok(Object.hasOwn(pdfReadingIssueCodes, code), `codice non dichiarato: ${code}`)
  for (const block of result.document.blocks) {
    assert.equal(block.origin, 'native')
    assert.ok(block.page !== null && block.page >= 1 && block.page <= pageCount)
    assert.ok(block.bbox !== null, `${block.id}: bbox obbligatoria`)
    const [x, y, width, height] = block.bbox!
    assert.ok(x >= 0 && y >= 0 && width >= 0 && height >= 0 && x + width <= 1 + 1e-9 && y + height <= 1 + 1e-9, `${block.id}: bbox ${block.bbox}`)
    assert.ok(block.id.startsWith(`pdf:${block.page}:`), block.id)
    assert.equal(block.text, normalizeSourceText(block.text))
  }
  for (const entry of result.metadata.inventory) {
    if (entry.status !== 'read') assert.ok(entry.issueCodes.length, `pagina ${entry.page} non letta per intero senza avviso`)
    for (const id of entry.blockIds) assert.equal(byId(result).get(id)?.page, entry.page)
  }
}

// ---------------------------------------------------------------------------------------------
// Corpus binario
// ---------------------------------------------------------------------------------------------

test('manifest PDF: file esistenti, hash corretti, nessun orfano e byte riprodotti dal generatore', () => {
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.readerVersion, PDF_READER_VERSION)
  const referenced = new Set<string>(['manifest.json'])
  for (const item of manifest.cases) {
    const bytes = fixtureBytes(item.sourceFile)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, item.id)
    assert.deepEqual(bytes, pdfFixtureBuilders[item.id](), `${item.id}: rigenerare con node scripts/generate-pdf-fixtures.mjs`)
    assert.ok((item.expected === null) !== (item.expectedError === null), `${item.id}: golden oppure errore atteso`)
    referenced.add(item.sourceFile)
    if (item.expected) referenced.add(item.expected)
  }
  assert.deepEqual(Object.keys(pdfFixtureBuilders).sort(), manifest.cases.map(item => item.id).sort())
  assert.deepEqual(readdirSync(folder).sort(), [...referenced].sort())
  for (const required of ['pdf-simple', 'pdf-two-columns', 'pdf-table', 'pdf-rotated', 'pdf-scan-only', 'pdf-mixed', 'pdf-last-page-scan']) assert.ok(manifest.cases.some(item => item.id === required), required)
})

test('golden: ogni PDF produce esattamente blocchi, problemi e inventario attesi, in modo ripetibile', async () => {
  for (const item of manifest.cases) {
    if (item.expectedError) { await rejects(readFixture(item.id), item.expectedError); continue }
    const result = await readFixture(item.id)
    assert.deepEqual(result, expectedOf(item.expected!), item.id)
    checkInvariants(result)
    assert.equal(result.document.sourceHash, item.sha256, 'sourceHash = SHA-256 dei byte originali')
    assert.deepEqual(await readFixture(item.id), result, `${item.id}: stessa lettura, stessi ID`)
  }
})

// ---------------------------------------------------------------------------------------------
// Layout sulle fixture reali
// ---------------------------------------------------------------------------------------------

test('PDF semplice: ordine visivo, titoli, elenchi, segni di minuti e secondi, contatti minimizzati', async () => {
  const result = await readFixture('pdf-simple')
  const blocks = result.document.blocks
  assert.deepEqual(blocks.map(block => block.kind), ['heading', 'heading', 'list_item', 'list_item', 'list_item', 'paragraph', 'heading', 'list_item', 'list_item', 'paragraph'])
  assert.equal(blocks[4]!.text, '• Recupero 1′30″ tra le serie', 'frammenti Symbol uniti senza spazi inventati')
  assert.equal(blocks[5]!.text, 'Aumentare il carico di 2,5 kg a settimana\nfino a quando la tecnica resta pulita.', 'righe disegnate in ordine inverso lette in ordine visivo')
  assert.deepEqual(blocks[7]!.headingIds, ['pdf:1:b:1', 'pdf:1:b:7'])
  assert.equal(blocks[9]!.text, 'Coach Luca Verdi – [telefono]')
  // Le bbox seguono l'ordine verticale della pagina.
  const tops = blocks.map(block => block.bbox![1])
  assert.deepEqual([...tops].sort((a, b) => a - b), tops)
  assert.deepEqual(pageStatus(result), [[1, 'read', ['contact_data_removed']]])
})

test('due colonne con numeri simili: associazioni per colonna conservate, mai righe fuse fra colonne', async () => {
  const result = await readFixture('pdf-two-columns')
  const blocks = byId(result)
  // Elenchi affiancati riga per riga: tabella, ogni valore nella propria colonna.
  assert.deepEqual(['pdf:1:t:1:r:1:c:0', 'pdf:1:t:1:r:1:c:1', 'pdf:1:t:1:r:3:c:0', 'pdf:1:t:1:r:3:c:1'].map(id => blocks.get(id)?.text), ['Squat 4 x 8', 'Squat 3 x 8', 'Stacco 5 x 5', 'Stacco 5 x 5'])
  assert.deepEqual(['pdf:1:t:1:r:0:c:0', 'pdf:1:t:1:r:0:c:1'].map(id => blocks.get(id)?.text), ['Scheda A', 'Scheda B'], 'intestazioni delle colonne')
  const cells = blocksOf(result, 1).filter(block => block.kind === 'table_cell')
  assert.ok(cells.every(cell => !/Scheda A|4 x 8/.test(cell.text) || cell.column === 0), 'valori della scheda A solo nella prima colonna')
  // Testo in colonne non allineate: prima tutta la colonna sinistra, poi la destra; nessun blocco mescola le due.
  const page2 = blocksOf(result, 2)
  assert.deepEqual(page2.map(block => block.kind), ['heading', 'paragraph', 'paragraph', 'paragraph'])
  assert.match(page2[1]!.text, /^Colazione.*\nSpuntino.*\nPranzo.*volontà\.$/s)
  assert.match(page2[2]!.text, /^Merenda.*\nCena.*olio\.$/s)
  assert.ok(!page2.some(block => /Colazione|Pranzo/.test(block.text) && /Merenda|Cena/.test(block.text)))
  assert.equal(page2[3]!.text, 'Bere almeno 2 litri di acqua al giorno, distribuiti fra i pasti principali.', 'riga a tutta pagina dopo le colonne')
  assert.ok(page2[1]!.bbox![0] < 0.5 && page2[2]!.bbox![0] > 0.5)
  assert.deepEqual(result.document.readingIssues, [])
})

test('tabella: righe e colonne logiche, numero fuori riga e colonne senza spazio segnalati', async () => {
  const result = await readFixture('pdf-table')
  const blocks = byId(result)
  const row = (index: number) => blocks.get(`pdf:1:t:1:r:${index}`)!.text
  assert.equal(row(0), 'Esercizio | Serie | Rip. | Recupero')
  assert.equal(row(2), 'Panca inclinata | 3 | 10 | 90"')
  assert.deepEqual([blocks.get('pdf:1:t:1:r:3:c:2')?.text, blocks.get('pdf:1:t:1:r:3:c:2')?.row, blocks.get('pdf:1:t:1:r:3:c:2')?.column], ['12', 3, 2])
  // Il numero sollevato resta in una riga propria, con avviso: non viene attribuito a una riga vicina.
  assert.equal(row(4), '| | 12 |')
  assert.deepEqual(issues(result, 'misaligned_numbers').map(issue => issue.sourceRefs), [['pdf:1:t:1:r:4:c:2']])
  // PDF.js unisce la cella allineata a destra al numero adiacente: cella su due colonne con avviso, mai lettura sicura.
  const fused = blocks.get('pdf:1:t:1:r:6:c:0')!
  assert.deepEqual([fused.text, fused.columnSpan], ['Affondi con manubri3', 2])
  assert.deepEqual(issues(result, 'reading_order_uncertain').map(issue => issue.sourceRefs), [['pdf:1:t:1:r:6:c:0']])
  assert.equal(blocks.get('pdf:1:b:2')?.text, 'Nota: ripetere la seduta due volte a settimana.', 'nota dopo la tabella fuori dalla tabella')
  for (const cell of result.document.blocks.filter(block => block.kind === 'table_cell')) {
    const parent = blocks.get(cell.parentId!)!
    assert.equal(parent.kind, 'table_row')
    assert.ok(Math.abs(parent.bbox![1] - cell.bbox![1]) < 0.01, `${cell.id} allineata alla riga`)
  }
})

test('pagine ruotate: lettura nella direzione del testo, bbox nella pagina visualizzata', async () => {
  const result = await readFixture('pdf-rotated')
  assert.deepEqual(blocksOf(result, 1).map(block => block.text), ['Settimana 1 – orizzontale', 'Squat 5 x 5', 'Panca 5 x 5', 'Recupero 2 minuti tra le serie'])
  assert.ok(blocksOf(result, 1).every(block => block.bbox![2] > block.bbox![3]), 'testo dritto: riquadri orizzontali')
  const vertical = blocksOf(result, 2)
  assert.deepEqual(vertical.map(block => block.text), ['Pagina ruotata senza compensazione', 'Stacco 3 x 5\nRematore 3 x 10'])
  assert.ok(vertical.every(block => block.bbox![3] > block.bbox![2] && block.bbox![0] > 0.8), 'testo verticale sul lato destro della pagina visualizzata')
  assert.deepEqual(blocksOf(result, 3).map(block => block.kind), ['heading', 'table_row', 'table_cell', 'table_cell'])
  assert.ok(result.metadata.inventory.every(entry => entry.status === 'read'))
})

// ---------------------------------------------------------------------------------------------
// Scansioni, pagine miste e qualità per pagina
// ---------------------------------------------------------------------------------------------

test('solo scansione: ogni pagina segnalata, nessun blocco, nessuna lettura simulata', async () => {
  const result = await readFixture('pdf-scan-only')
  assert.deepEqual(result.document.blocks, [])
  assert.deepEqual(pageStatus(result), [[1, 'no_text', ['no_text_layer']], [2, 'no_text', ['no_text_layer']]])
  assert.ok(issues(result, 'no_text_layer').every(issue => /probabile scansione.*non disponibile/.test(issue.message)))
})

test('pagine miste e ultima pagina scansionata: la prima pagina testuale non rende testuale il file', async () => {
  const last = await readFixture('pdf-last-page-scan')
  assert.deepEqual(pageStatus(last), [[1, 'read', []], [2, 'read', []], [3, 'no_text', ['no_text_layer']]])
  assert.match(issues(last, 'no_text_layer')[0]!.message, /^Pagina 3:/)

  const mixed = await readFixture('pdf-mixed')
  assert.deepEqual(pageStatus(mixed), [[1, 'partial', ['image_without_text']], [2, 'read', []], [3, 'read', []]])
  assert.match(issues(mixed, 'image_without_text')[0]!.message, /Pagina 1: immagine senza testo leggibile \(circa 54% della pagina\)/)
  assert.deepEqual(blocksOf(mixed, 3).map(block => block.text), ['Spuntino: frutta 200 g', 'Acqua: almeno 2 litri'], 'sfondo decorativo sotto il testo: nessun avviso')
})

test('font senza mappa Unicode, testo invisibile e pagina danneggiata: segnalati pagina per pagina', async () => {
  const unreadable = await readFixture('pdf-unreadable-text')
  assert.deepEqual(pageStatus(unreadable), [[1, 'partial', ['unreadable_text']], [2, 'partial', ['hidden_text']]])
  assert.ok(!unreadable.document.blocks.some(block => /[\u0000-\u001f]/.test(block.text)), 'nessun carattere di controllo nei blocchi')
  assert.deepEqual(blocksOf(unreadable, 1).map(block => block.text), ['Integrazione'])
  assert.match(issues(unreadable, 'hidden_text')[0]!.message, /Pagina 2: testo invisibile sovrapposto \(2\)/)

  const damaged = await readFixture('pdf-damaged-page')
  assert.deepEqual(pageStatus(damaged), [[1, 'read', []], [2, 'no_text', ['empty_page']], [3, 'read', []]])
  assert.match(issues(damaged, 'empty_page')[0]!.message, /vuota oppure il suo contenuto è danneggiato/)
})

// ---------------------------------------------------------------------------------------------
// Rifiuti, limiti e formato
// ---------------------------------------------------------------------------------------------

test('rifiuti: password, corrotto, vuoto, troppo grande, DOCX rinominato, formato sbagliato', async () => {
  await rejects(readFixture('pdf-password'), 'unsupported', /password/)
  await rejects(readFixture('pdf-corrupt'), 'corrupt', /non è un PDF valido/)
  await rejects(read(new Uint8Array()), 'corrupt', /vuoto/)
  await rejects(read(fixtureBytes('pdf-simple.pdf'), { limits: limits({ fileBytes: 1000 }) }), 'limit_exceeded', undefined, 'fileBytes')
  await rejects(read(buildDocx({ body: para('Squat 5 x 5') })), 'unsupported', /DOCX/)
  await rejects(read(new TextEncoder().encode('non è un pdf')), 'corrupt')
  await rejects(pdfReader.read({ bytes: fixtureBytes('pdf-simple.pdf'), metadata: { format: 'docx', mediaType: null }, signal: new AbortController().signal }), 'unsupported')
  // MIME vuoto o falso non cambia la lettura.
  assert.deepEqual(await read(fixtureBytes('pdf-simple.pdf'), { mediaType: 'application/octet-stream' }), await readFixture('pdf-simple'))
})

test('limite di pagine: 30 lette per intero, 31 rifiutate senza troncare', async () => {
  const thirty = await read(manyPages(30))
  assert.equal(thirty.metadata.pageCount, 30)
  assert.equal(thirty.metadata.inventory.length, 30)
  assert.equal(thirty.document.blocks.at(-1)!.text, 'Pagina 30: Squat 3 x 10')
  await rejects(read(manyPages(31)), 'limit_exceeded', /31 pagine/, 'pdfPages')
  await rejects(read(manyPages(5), { limits: limits({ pdfPages: 4 }) }), 'limit_exceeded', undefined, 'pdfPages')
})

test('fixture limite (30 pagine, quasi 10 MiB con immagini): tempo e memoria misurati', async t => {
  // Immagini di rumore non comprimibile: il file resta sotto il limite di 10 MiB.
  const pages = Array.from({ length: 30 }, (_, index) => ({ width: 595, height: 842, content: [text(56, 790, `Pagina ${index + 1}: Squat 3 x 10`), image('Foto', 56, 420, 480, 300)], images: { Foto: noiseImage(577, 577, index + 1) } }))
  const bytes = buildPdf({ pages })
  assert.ok(bytes.length > 9 * 1024 * 1024 && bytes.length < 10 * 1024 * 1024, `dimensione ${bytes.length}`)
  global.gc?.()
  const before = process.memoryUsage()
  const started = performance.now()
  let peak = before.rss
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 5)
  const result = await read(bytes, { maxMilliseconds: 60_000 })
  clearInterval(sampler)
  const elapsed = performance.now() - started
  peak = Math.max(peak, process.memoryUsage().rss)
  assert.equal(result.metadata.pageCount, 30)
  assert.ok(result.metadata.inventory.every(entry => entry.status === 'partial' && entry.issueCodes.includes('image_without_text')))
  t.diagnostic(`fixture limite: ${(bytes.length / 1048576).toFixed(2)} MiB, 30 pagine, ${Math.round(elapsed)} ms, RSS di picco +${Math.round((peak - before.rss) / 1048576)} MiB (Node ${process.version})`)
  assert.ok(elapsed < 30_000, `lettura troppo lenta: ${elapsed} ms`)
})

// ---------------------------------------------------------------------------------------------
// Annullamento, tempo e rete
// ---------------------------------------------------------------------------------------------

test('annullamento prima e durante la lettura, tempo massimo: mai un documento parziale', async () => {
  await rejects(read(fixtureBytes('pdf-simple.pdf'), { signal: AbortSignal.abort() }), 'cancelled')
  const bytes = manyPages(30)
  for (const delay of [0, 5, 20]) {
    const controller = new AbortController()
    const pending = read(bytes, { signal: controller.signal })
    setTimeout(() => controller.abort(), delay)
    await rejects(pending, 'cancelled')
  }
  let clock = 0
  await rejects(read(bytes, { now: () => (clock += 1000), maxMilliseconds: 5000 }), 'limit_exceeded', /tempo/, 'readMilliseconds')
  await rejects(read(bytes, { maxMilliseconds: 1 }), 'limit_exceeded', /tempo/, 'readMilliseconds')
  // Dopo gli annullamenti il motore legge normalmente.
  assert.deepEqual(await readFixture('pdf-simple'), expectedOf('pdf-simple.expected.json'))
})

test('nessuna richiesta di rete e nessuna dipendenza da endpoint o interfaccia', async () => {
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = (() => { requests++; throw new Error('rete vietata') }) as typeof fetch
  try {
    for (const item of manifest.cases.filter(entry => entry.expected)) await readFixture(item.id)
  } finally {
    globalThis.fetch = original
  }
  assert.equal(requests, 0)
  const readers = join(root, 'src', 'import', 'readers')
  for (const file of readdirSync(readers).filter(name => name.startsWith('pdf'))) {
    const source = readFileSync(join(readers, file), 'utf8')
    for (const [, specifier] of source.matchAll(/^\s*import[^'"]*['"]([^'"]+)['"]/gm)) {
      assert.ok(/^(\.\/|\.\.\/contracts\/|pdfjs-dist\/legacy\/build\/)/.test(specifier!), `${file}: import non ammesso ${specifier}`)
    }
    assert.doesNotMatch(source, /\bfetch\(|XMLHttpRequest|supabase|react/i, file)
  }
})

// ---------------------------------------------------------------------------------------------
// Trasporto worker (in-process: stesso protocollo, stesso motore del worker reale)
// ---------------------------------------------------------------------------------------------

function fakeWorker(readFunction: ReadFunction): ReaderWorkerHandle {
  let alive = true
  const handle: ReaderWorkerHandle = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage(message, transfer) {
      const copy = structuredClone(message, { transfer: transfer as ArrayBuffer[] })
      setTimeout(() => { if (alive) scope.onmessage?.({ data: copy }) }, 0)
    },
    terminate() { alive = false },
  }
  const scope: ReaderWorkerScope = {
    onmessage: null,
    postMessage(message) { const copy = structuredClone(message); setTimeout(() => { if (alive) handle.onmessage?.({ data: copy }) }, 0) },
  }
  serveDocumentReader(scope, readFunction)
  // Messaggio estraneo al protocollo, come quello di avvio del worker di PDF.js: ignorato.
  setTimeout(() => handle.onmessage?.({ data: { sourceName: 'worker', targetName: 'main', action: 'ready' } }), 0)
  return handle
}

test('worker: risultato validato identico al motore, messaggi estranei ignorati, annullamento', async () => {
  const reader = createWorkerDocumentReader({ format: 'pdf', readerVersion: PDF_READER_VERSION, createWorker: () => fakeWorker(input => readPdf(input, { decoderAssetsUrl })) })
  const bytes = fixtureBytes('pdf-table.pdf')
  const result = await reader.read({ bytes, metadata: { format: 'pdf', mediaType: null }, signal: new AbortController().signal })
  assert.deepEqual(result, expectedOf('pdf-table.expected.json'))
  assert.equal(bytes.byteLength, readFileSync(join(folder, 'pdf-table.pdf')).byteLength, 'byte del chiamante intatti')
  const controller = new AbortController()
  const pending = reader.read({ bytes: manyPages(30), metadata: { format: 'pdf', mediaType: null }, signal: controller.signal })
  controller.abort()
  await rejects(pending, 'cancelled')
  await rejects(reader.read({ bytes, metadata: { format: 'docx', mediaType: null }, signal: new AbortController().signal }), 'unsupported')
  reader.close()
})

// ---------------------------------------------------------------------------------------------
// Regole geometriche pure
// ---------------------------------------------------------------------------------------------

const item = (textValue: string, x: number, y: number, size = 10, width = textValue.length * size * 0.5, angle = 0): LayoutItem => ({ text: textValue, x, y, width, size, angle })
const page = (items: LayoutItem[], extra: Partial<PageInput> = {}): PageInput => ({ page: 1, width: 600, height: 800, items, images: [], invisibleText: 0, annotations: 0, drawn: true, ...extra })
const assembled = (input: PageInput) => assembleDocument([layoutPage(input)])
const textsOf = (blocks: SourceBlock[]) => blocks.filter(block => block.kind !== 'table_cell').map(block => block.text)

test('geometria: parole unite o separate in base alla distanza, frammenti ripetuti letti una volta', () => {
  const result = assembled(page([item('Squat', 50, 100, 10, 25), item('4 x 8', 77, 100, 10, 25), item('Recupero', 50, 115, 10, 40), item('90', 90.5, 115, 10, 10), item('Squat', 50, 100, 10, 25)]))
  assert.deepEqual(textsOf(result.blocks), ['Squat 4 x 8\nRecupero90'])
})

test('geometria: colonne di testo non allineate lette una dopo l’altra; allineamento parziale segnalato', () => {
  const left = ['Colazione con yogurt greco e avena', 'e frutti di bosco freschi 100 g', 'Spuntino con mela e noci 15 g', 'Pranzo con riso basmati 80 g']
  const right = ['Merenda con pane integrale 60 g', 'e bresaola magra 30 g circa', 'Cena con salmone 150 g e patate', 'insalata con olio 10 g a crudo']
  const columns = assembled(page([...left.map((line, index) => item(line, 40, 100 + index * 14, 10, 220)), ...right.map((line, index) => item(line, 320, 105 + index * 14, 10, 220))]))
  assert.deepEqual(textsOf(columns.blocks), [left.join('\n'), right.join('\n')])

  const lists = ['A1', 'A2', 'A3', 'A4'].map((value, index) => item(`Serie ${value}`, 40, 100 + index * 14, 10, 40))
  const partial = assembled(page([...lists, ...['B1', 'B2', 'B3', 'B4'].map((value, index) => item(`Serie ${value}`, 320, index < 2 ? 100 + index * 14 : 107 + index * 14, 10, 40))]))
  assert.equal(partial.readingIssues.filter(issue => issue.code === 'reading_order_uncertain').length, 1, 'colonne solo in parte allineate')
})

test('geometria: sovrapposizioni, testo in altra direzione, immagine estesa, pagina vuota', () => {
  const overlap = assembled(page([item('Squat 4 x 8', 50, 100, 10, 55), item('Panca', 60, 100, 10, 25)]))
  assert.equal(overlap.readingIssues[0]!.code, 'overlapping_text')

  const rotated = assembled(page([item('Squat 4 x 8', 50, 100), item('Panca 3 x 10', 50, 115), item('Nota a margine', 580, 300, 10, 70, Math.PI / 2)]))
  assert.deepEqual(textsOf(rotated.blocks), ['Squat 4 x 8\nPanca 3 x 10', 'Nota a margine'])
  assert.deepEqual(rotated.readingIssues.map(issue => [issue.code, issue.sourceRefs]), [['reading_order_uncertain', ['pdf:1:b:2']]])

  const picture = assembled(page([item('Colazione', 50, 100)], { images: [{ x0: 50, y0: 200, x1: 550, y1: 700 }] }))
  assert.deepEqual(picture.inventory[0]!.status, 'partial')
  const logo = assembled(page([item('Colazione', 50, 100)], { images: [{ x0: 500, y0: 20, x1: 540, y1: 60 }] }))
  assert.deepEqual(logo.inventory[0]!.status, 'read', 'immagine piccola: decorativa')
  const blank = assembled(page([], { drawn: false }))
  assert.deepEqual(blank.inventory.map(entry => [entry.status, entry.issueCodes]), [['no_text', ['empty_page']]])
  const outlines = assembled(page([], { drawn: true }))
  assert.match(outlines.readingIssues[0]!.message, /solo grafica/)
  const annotated = assembled(page([item('Squat', 50, 100)], { annotations: 2 }))
  assert.deepEqual(annotated.inventory[0]!.issueCodes, ['component_not_read'])
})

test('geometria: bbox sempre dentro la pagina, anche per testo che ne esce', () => {
  const result = assembled(page([item('Testo tagliato al bordo destro', 560, 100, 10, 200), item('In alto', 10, 2, 12)]))
  for (const block of result.blocks) {
    const [x, y, width, height] = block.bbox!
    assert.ok(x >= 0 && y >= 0 && x + width <= 1 && y + height <= 1, String(block.bbox))
  }
})
