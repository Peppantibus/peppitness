import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'fflate'
import {
  defaultImportLimits, DocumentReaderError, normalizeSourceText, resolveImportLimits, validateDocumentReadResult,
  type DocumentReadResult, type ImportLimits, type SourceBlock,
} from '../src/import/contracts/index.ts'
import { DOCX_READER_VERSION, docxReader, readDocx, type DocxReaderOptions } from '../src/import/readers/docx.ts'
import { checkSelectedFile, detectSignature, sha256Hex } from '../src/import/readers/file-checks.ts'
import { createWorkerDocumentReader, ReaderWorkerError, type ReaderWorkerHandle } from '../src/import/readers/worker-client.ts'
import { READER_WORKER_PROTOCOL, serveDocumentReader, type ReadFunction, type ReaderWorkerScope } from '../src/import/readers/worker-protocol.ts'
// @ts-expect-error modulo JavaScript dei generatori di fixture, senza dichiarazioni di tipo
import { buildDocx, buildZip, docxFixtureBuilders, documentXml, p, para, r, relationshipsXml, tbl, tc, tr } from '../scripts/lib/docx-fixtures.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const folder = join(root, 'tests', 'fixtures', 'import', 'docx')
const fixtureBytes = (name: string) => new Uint8Array(readFileSync(join(folder, name)))
const expectedOf = (name: string) => JSON.parse(readFileSync(join(folder, name), 'utf8')) as DocumentReadResult

interface ManifestCase { id: string; sourceFile: string; sha256: string; expected: string | null; expectedError: string | null; summary: string; tags: string[] }
const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as { formatVersion: number; readerVersion: string; cases: ManifestCase[] }

const read = (bytes: Uint8Array, options: DocxReaderOptions & { signal?: AbortSignal; mediaType?: string | null } = {}) =>
  readDocx({ bytes, metadata: { format: 'docx', mediaType: options.mediaType ?? null }, signal: options.signal ?? new AbortController().signal }, options)
const readFixture = (id: string) => read(fixtureBytes(`${id}.docx`))
const limits = (overrides: Partial<ImportLimits>) => resolveImportLimits(overrides)

async function rejects(promise: Promise<unknown>, code: string, pattern?: RegExp, limit?: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DocumentReaderError, `atteso DocumentReaderError, ricevuto ${String(error)}`)
    assert.equal(error.code, code, error.message)
    if (pattern) assert.match(error.message, pattern)
    if (limit) assert.equal(error.limit?.limit, limit)
    return true
  })
}

const byId = (result: DocumentReadResult) => new Map(result.document.blocks.map(block => [block.id, block]))
const texts = (blocks: SourceBlock[]) => blocks.map(block => block.text)
const cells = (result: DocumentReadResult, tableId: string) => result.document.blocks.filter(block => block.kind === 'table_cell' && block.tableId === tableId)

// ---------------------------------------------------------------------------------------------
// Corpus binario
// ---------------------------------------------------------------------------------------------

test('manifest DOCX: file esistenti, hash corretti, nessun orfano e byte riprodotti dal generatore', () => {
  assert.equal(manifest.formatVersion, 1)
  assert.equal(manifest.readerVersion, DOCX_READER_VERSION)
  const referenced = new Set<string>(['manifest.json'])
  for (const item of manifest.cases) {
    const bytes = fixtureBytes(item.sourceFile)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256, item.id)
    assert.deepEqual(bytes, docxFixtureBuilders[item.id](), `${item.id}: rigenerare con node scripts/generate-docx-fixtures.mjs`)
    assert.ok((item.expected === null) !== (item.expectedError === null), `${item.id}: golden oppure errore atteso`)
    referenced.add(item.sourceFile)
    if (item.expected) referenced.add(item.expected)
  }
  assert.deepEqual(Object.keys(docxFixtureBuilders).sort(), manifest.cases.map(item => item.id).sort())
  assert.deepEqual(readdirSync(folder).sort(), [...referenced].sort())
  for (const required of ['docx-paragraphs', 'docx-tables', 'docx-merged-cells', 'docx-nested-tables', 'docx-invalid-package']) assert.ok(manifest.cases.some(item => item.id === required))
})

test('golden: ogni DOCX produce esattamente il documento normalizzato e l’inventario attesi, in modo ripetibile', async () => {
  for (const item of manifest.cases) {
    if (item.expectedError) { await rejects(readFixture(item.id), item.expectedError); continue }
    const result = await readFixture(item.id)
    assert.deepEqual(result, expectedOf(item.expected!), item.id)
    assert.ok(validateDocumentReadResult(result).ok)
    assert.equal(result.document.sourceHash, item.sha256, 'sourceHash = SHA-256 dei byte originali')
    assert.deepEqual(await readFixture(item.id), result, `${item.id}: stessa lettura, stessi ID`)
    for (const block of result.document.blocks) {
      assert.equal(block.page, null, 'nessuna pagina inventata in un DOCX')
      assert.equal(block.bbox, null)
      assert.equal(block.origin, 'native')
      assert.equal(block.text, normalizeSourceText(block.text), 'testo canonico')
    }
    assert.equal(result.metadata.pageCount, null)
  }
})

test('paragrafi: run ricomposti, spazi/tab/a capo, titoli ed elenchi con gerarchia, nessun codice di campo', async () => {
  const result = await readFixture('docx-paragraphs')
  const blocks = byId(result)
  assert.equal(blocks.get('p:2')?.text, 'Obiettivo: forza e tecnica', 'parole spezzate in più run')
  assert.equal(blocks.has('p:3'), false, 'paragrafo vuoto: nessun blocco, numerazione stabile')
  assert.deepEqual(blocks.get('p:5'), { ...blocks.get('p:5')!, kind: 'list_item', text: 'Squat 4 x 8\nRPE 8', parentId: null, headingIds: ['p:1', 'p:4'] })
  assert.equal(blocks.get('p:6')?.parentId, 'p:5', 'secondo livello sotto il primo')
  assert.equal(blocks.get('p:7')?.parentId, 'p:5')
  assert.equal(blocks.get('p:8')?.parentId, null)
  assert.equal(blocks.get('p:9')?.text, 'Guarda il video della tecnica.', 'testo del collegamento, mai seguito')
  assert.equal(blocks.get('p:11')?.text, 'Aggiornata al 28/09/2026', 'risultato del campo senza istruzione')
  assert.equal(blocks.get('p:12')?.text, 'Recupero tra le serie: 90 secondi per tutti gli esercizi.')
  assert.equal(blocks.get('p:13')?.text, 'Rest-pause sull’ultima serie; completa il set.')
  assert.equal(blocks.get('p:14')?.text, 'Durata: 45 minuti', 'controllo contenuto letto')
  assert.equal(blocks.get('p:15')?.text, 'Carico: ½ del massimale, 1′30″ di pausa — «tempo 3-1-1»', 'Unicode e segni prescrittivi intatti')
  assert.deepEqual(blocks.get('p:10')?.headingIds, ['p:1', 'p:4'], 'titolo 2 sotto titolo 1 sotto il titolo')
  assert.deepEqual(blocks.get('p:16')?.headingIds, ['p:1'], 'nuovo titolo 1 chiude il precedente')
  assert.equal(blocks.get('p:17')?.kind, 'list_item', 'numerazione ereditata dallo stile')
  assert.equal(blocks.get('p:18')?.kind, 'paragraph', 'numId 0 disattiva l’elenco dello stile')
  assert.equal(blocks.get('p:19')?.kind, 'heading', 'livello di struttura diretto')
  assert.ok(!result.document.blocks.some(block => /DATE|dd\/MM/.test(block.text)))
  assert.deepEqual(result.document.readingIssues, [])
  assert.deepEqual(result.metadata.inventory.map(entry => [entry.id, entry.status]), [['docx:body', 'read']])
})

test('tabelle: note prima e dopo in ordine, intestazione, celle vuote e coordinate logiche', async () => {
  const result = await readFixture('docx-tables')
  const order = result.document.blocks.map(block => block.id)
  assert.ok(order.indexOf('p:3') < order.indexOf('t:1:r:0') && order.indexOf('t:1:r:3:c:3') < order.indexOf('p:4'), 'nota prima, tabella, nota dopo')
  assert.equal(byId(result).get('p:4')?.text, 'Recupero globale: se non indicato, 90 secondi tra le serie.')
  assert.deepEqual(texts(cells(result, 't:1').filter(cell => cell.row === 0)), ['Esercizio', 'Serie', 'Ripetizioni', 'Recupero'], 'riga di intestazione una volta')
  assert.equal(byId(result).get('t:1:r:1:c:0')?.text, 'Squat')
  assert.equal(byId(result).get('t:1:r:2:c:3')?.text, '', 'cella vuota conservata')
  assert.equal(byId(result).get('t:1:r:3:c:0')?.text, 'Rematore\ncon manubrio')
  const gridBefore = byId(result).get('t:2:r:1:c:1')!
  assert.deepEqual([gridBefore.row, gridBefore.column, gridBefore.parentId], [1, 1, 't:2:r:1'])
  for (const cell of cells(result, 't:1')) assert.equal(byId(result).get(cell.parentId!)?.kind, 'table_row')
})

test('celle unite: una sola cella d’origine, span corretti fino all’ultima riga, nessun contenuto duplicato', async () => {
  const result = await readFixture('docx-merged-cells')
  const blocks = byId(result)
  assert.deepEqual([blocks.get('t:1:r:1:c:0')?.rowSpan, blocks.get('t:1:r:1:c:0')?.columnSpan], [2, 1])
  assert.deepEqual([blocks.get('t:1:r:3:c:0')?.rowSpan, blocks.get('t:1:r:3:c:0')?.text], [3, 'Martedì'], 'unione fino all’ultima riga')
  assert.equal(blocks.get('t:1:r:3:c:1')?.columnSpan, 2)
  assert.equal(blocks.has('t:1:r:2:c:0'), false, 'nessun blocco per la continuazione')
  assert.equal(blocks.has('t:1:r:5:c:0'), false)
  const block2x2 = blocks.get('t:2:r:0:c:0')!
  assert.deepEqual([block2x2.rowSpan, block2x2.columnSpan, block2x2.text], [2, 2, 'Circuito A: ripetere 3 volte\nsenza pausa fra gli esercizi'])
  assert.deepEqual([blocks.get('t:2:r:2:c:0')?.columnSpan, blocks.has('t:2:r:2:c:1')], [2, false], 'hMerge legacy')
  assert.equal(blocks.get('t:2:r:3:c:2')?.rowSpan, 1, 'vMerge senza origine sopra: cella propria')
  for (const tableId of ['t:1', 't:2']) {
    const covered = new Map<string, string>()
    for (const cell of cells(result, tableId)) {
      for (let row = cell.row!; row < cell.row! + cell.rowSpan!; row++) {
        for (let column = cell.column!; column < cell.column! + cell.columnSpan!; column++) {
          const key = `${row}:${column}`
          assert.ok(!covered.has(key), `${tableId} posizione ${key} coperta due volte`)
          covered.set(key, cell.id)
        }
      }
    }
  }
  for (const needle of ['Lunedì', 'Martedì', 'Riposo attivo', 'senza pausa']) {
    assert.equal(cells(result, needle === 'senza pausa' ? 't:2' : 't:1').filter(cell => cell.text.includes(needle)).length, 1, `${needle} in una sola cella`)
  }
  // Dal task 04 anche la continuazione verticale senza cella d'origine è segnalata.
  assert.deepEqual(result.document.readingIssues.map(issue => [issue.code, issue.sourceRefs]), [['merged_cell_text', ['t:2:r:0:c:0']], ['table_structure', ['t:2:r:3:c:2']]])
})

test('tabelle annidate: identità e parentela proprie, nessun testo contato due volte', async () => {
  const result = await readFixture('docx-nested-tables')
  const blocks = byId(result)
  assert.deepEqual(['t:2:r:0', 't:2:r:1'].map(id => blocks.get(id)?.parentId), ['t:1:r:1:c:1', 't:1:r:1:c:1'])
  assert.equal(blocks.get('t:3:r:0')?.parentId, 't:1:r:2:c:1')
  assert.equal(blocks.get('t:4:r:0')?.parentId, 't:3:r:1:c:1', 'secondo livello di annidamento')
  assert.equal(blocks.get('t:3:r:0:c:0')?.rowSpan, 2)
  assert.equal(blocks.get('t:1:r:1:c:1')?.text, 'Ripetere 2 volte:\nPausa 1′ alla fine.', 'la cella esterna non ripete il testo della tabella interna')
  const allText = result.document.blocks.filter(block => block.kind === 'table_cell').map(block => block.text).join('\n')
  for (const needle of ['Burpee', 'Goblet squat 10', 'Kettlebell swing']) assert.equal(allText.split(needle).length - 1, 1, needle)
  const order = result.document.blocks.map(block => block.id)
  assert.ok(order.indexOf('p:2') < order.indexOf('t:1:r:0') && order.indexOf('t:4:r:0:c:1') < order.indexOf('p:3'))
})

test('componenti non letti e revisioni: dal task 04 la revisione aperta rifiuta il documento, mai «4 x 68»', async () => {
  // I componenti di questa fixture sono ora letti o segnalati: vedi tests/import-docx-coverage.test.ts.
  await rejects(readFixture('docx-unread-components'), 'unsupported', /revisioni non accettate \(2 — corpo del documento: 2\).*Accetta tutte/)
})

test('il pacchetto senza content types è rifiutato come corrotto', async () => {
  await rejects(readFixture('docx-invalid-package'), 'corrupt', /pacchetto/)
})

// ---------------------------------------------------------------------------------------------
// Controlli del file e del pacchetto
// ---------------------------------------------------------------------------------------------

test('scelta del file: estensioni, dimensione e MIME non affidabile', () => {
  assert.deepEqual(checkSelectedFile({ name: 'Scheda.DOCX', size: 10, type: '' }), { format: 'docx', mediaType: null })
  assert.deepEqual(checkSelectedFile({ name: 'piano.pdf', size: 10, type: 'application/octet-stream' }), { format: 'pdf', mediaType: 'application/octet-stream' })
  for (const name of ['vecchio.doc', 'macro.docm', 'modello.dotx', 'nota.txt', 'senza-estensione']) {
    assert.throws(() => checkSelectedFile({ name, size: 10, type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), (error: unknown) => error instanceof DocumentReaderError && error.code === 'unsupported')
  }
  assert.throws(() => checkSelectedFile({ name: 'vuoto.docx', size: 0, type: '' }), (error: unknown) => error instanceof DocumentReaderError && error.code === 'corrupt')
  assert.throws(() => checkSelectedFile({ name: 'grande.docx', size: defaultImportLimits.fileBytes + 1, type: '' }), (error: unknown) => error instanceof DocumentReaderError && error.code === 'limit_exceeded' && error.limit?.limit === 'fileBytes')
  assert.equal(detectSignature(Uint8Array.from([0x50, 0x4b, 0x03, 0x04])), 'zip')
  assert.equal(detectSignature(new TextEncoder().encode('\n%PDF-1.7')), 'pdf')
  assert.equal(detectSignature(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), 'cfb')
})

test('MIME vuoto o falso non cambia la lettura; SHA-256 calcolato sui byte', async () => {
  const bytes = fixtureBytes('docx-tables.docx')
  const plain = await read(bytes)
  assert.deepEqual(await read(bytes, { mediaType: '' }), plain)
  assert.deepEqual(await read(bytes, { mediaType: 'application/pdf' }), plain)
  assert.equal(plain.document.sourceHash, await sha256Hex(bytes))
  assert.equal(docxReader.readerVersion, DOCX_READER_VERSION)
  await rejects(docxReader.read({ bytes, metadata: { format: 'pdf', mediaType: null }, signal: new AbortController().signal }), 'unsupported')
})

const simpleBody = para('Squat 5 x 5')

test('rifiuti: vuoto, troppo grande, CFB/password, PDF rinominato, ZIP generico, troncato, docm, modello', async () => {
  await rejects(read(new Uint8Array()), 'corrupt', /vuoto/)
  await rejects(read(buildDocx({ body: simpleBody }), { limits: limits({ fileBytes: 100 }) }), 'limit_exceeded', undefined, 'fileBytes')
  await rejects(read(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0])), 'unsupported', /password|97-2003/)
  await rejects(read(new TextEncoder().encode('%PDF-1.7\n')), 'unsupported', /PDF/)
  await rejects(read(new TextEncoder().encode('testo qualsiasi')), 'corrupt')
  await rejects(read(buildZip([{ name: 'nota.txt', data: 'ciao' }])), 'corrupt', /pacchetto/)
  const valid = buildDocx({ body: simpleBody })
  await rejects(read(valid.subarray(0, valid.length - 30)), 'corrupt')
  await rejects(read(buildDocx({ body: simpleBody, mainContentType: 'application/vnd.ms-word.document.macroEnabled.main+xml' })), 'unsupported', /macro/)
  await rejects(read(buildDocx({ body: simpleBody, mainContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml' })), 'unsupported', /modelli/)
  await rejects(read(buildDocx({ body: simpleBody, mainContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' })), 'unsupported', /non è un documento Word/)
  // Entry cifrata (bit 0 dei flag): documento protetto.
  await rejects(read(buildZip([{ name: '[Content_Types].xml', data: '<Types/>', flags: 0x0801 }])), 'unsupported', /password/)
})

test('documento principale individuato dalla relazione, anche rinominato; relazioni esterne o fuori pacchetto rifiutate', async () => {
  const renamed = await read(buildDocx({ body: simpleBody, mainPart: 'contenuto/principale.xml' }))
  assert.deepEqual(texts(renamed.document.blocks), ['Squat 5 x 5'])
  const external = relationshipsXml([['rId1', 'officeDocument', 'https://example.invalid/document.xml', true]])
  await rejects(read(buildDocx({ body: simpleBody, packageRels: external })), 'corrupt')
  const outside = relationshipsXml([['rId1', 'officeDocument', '../../word/document.xml']])
  await rejects(read(buildDocx({ body: simpleBody, packageRels: outside })), 'corrupt')
  const missing = relationshipsXml([['rId1', 'officeDocument', 'word/assente.xml']])
  await rejects(read(buildDocx({ body: simpleBody, packageRels: missing })), 'corrupt')
})

test('ZIP ostili: percorsi esterni, duplicati, CRC, entry sovrapposte, nomi incoerenti', async () => {
  const base = [{ name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' }]
  await rejects(read(buildZip([...base, { name: '../fuori.xml', data: 'x' }])), 'corrupt', /percorso/)
  await rejects(read(buildZip([...base, { name: '/assoluto.xml', data: 'x' }])), 'corrupt', /percorso/)
  await rejects(read(buildZip([...base, { name: 'word\\document.xml', data: 'x' }])), 'corrupt', /percorso/)
  await rejects(read(buildZip([...base, { name: 'C:/x.xml', data: 'x' }])), 'corrupt', /percorso/)
  await rejects(read(buildZip([...base, { name: 'Word/Doc.xml', data: 'x' }, { name: 'word/doc.xml', data: 'y' }])), 'corrupt', /duplicati/)
  // Directory centrale che punta all'intestazione locale di un'altra entry.
  await rejects(read(buildZip([...base, { name: 'b.xml', data: 'x' }, { name: 'c.xml', data: 'y', offset: 0 }])), 'corrupt')
  await rejects(read(buildZip([...base, { name: 'a.xml', localName: 'b.xml', data: 'x' }])), 'corrupt', /incoerenti/)
  // Stessa dimensione dichiarata, contenuto alterato: la verifica CRC lo rileva.
  const crcBroken = buildZip([
    { name: '[Content_Types].xml', data: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', crc: 1 },
  ])
  await rejects(read(crcBroken), 'corrupt', /integrità/)
})

test('limiti effettivi: entry, decompressi dichiarati e prodotti, zip bomb con dimensione falsa', async () => {
  const docx = buildDocx({ body: simpleBody })
  await rejects(read(docx, { limits: limits({ docxEntries: 3 }) }), 'limit_exceeded', undefined, 'docxEntries')
  await rejects(read(docx, { limits: limits({ docxUncompressedBytes: 500 }) }), 'limit_exceeded', undefined, 'docxUncompressedBytes')

  // 200 MiB di zeri compressi in poche centinaia di KiB; dichiarati 1 KiB.
  const zeros = new Uint8Array(200 * 1024 * 1024)
  const bomb = deflateSync(zeros, { level: 9 })
  const lying = buildZip([
    { name: '[Content_Types].xml', data: zeros.subarray(0, 1024), compressed: bomb, declaredSize: 1024 },
  ])
  const started = performance.now()
  await rejects(read(lying), 'corrupt', /dichiarat/)
  assert.ok(performance.now() - started < 2000, 'decompressione interrotta subito')

  // Dimensione dichiarata onesta oltre il limite: rifiutata prima di decompressione.
  const honest = buildZip([{ name: '[Content_Types].xml', data: zeros.subarray(0, 60 * 1024 * 1024), compressed: deflateSync(zeros.subarray(0, 60 * 1024 * 1024), { level: 1 }) }])
  await rejects(read(honest), 'limit_exceeded', undefined, 'docxUncompressedBytes')

  // Parte letta due volte? Il totale conta i byte prodotti: qui stili e documento restano sotto il limite reale.
  const exact = await read(docx, { limits: limits({ docxUncompressedBytes: 100_000 }) })
  assert.equal(exact.document.blocks.length, 1)
})

test('XML ostile: DTD, entità definite, profondità eccessiva, XML malformato', async () => {
  const withDoctype = `<?xml version="1.0"?>\n<!DOCTYPE w:document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>` + documentXml(simpleBody).replace(/^<\?xml[^>]*\?>\n/, '')
  await rejects(read(buildDocx({ document: withDoctype })), 'unsupported', /DTD/)
  await rejects(read(buildDocx({ body: p(r({ xml: '<w:t>&xxe;</w:t>' })) })), 'unsupported', /entità/)
  const deep = '<w:customXml w:element="x">'.repeat(300) + simpleBody + '</w:customXml>'.repeat(300)
  await rejects(read(buildDocx({ body: deep })), 'limit_exceeded', undefined, 'xmlDepth')
  const shallow = '<w:customXml w:element="x">'.repeat(20) + simpleBody + '</w:customXml>'.repeat(20)
  assert.deepEqual(texts((await read(buildDocx({ body: shallow }))).document.blocks), ['Squat 5 x 5'])
  await rejects(read(buildDocx({ document: documentXml(simpleBody).replace('</w:body>', '') })), 'corrupt', /XML/)
  await rejects(read(buildDocx({ body: p(r({ xml: '<w:t>a &amp b</w:t>' })) })), 'corrupt', /XML/)
  const references = await read(buildDocx({ body: p(r({ xml: '<w:t>2&#8242; &lt;&#x2033;&gt; &amp; &quot;ok&apos;</w:t>' })) }))
  assert.equal(references.document.blocks[0]!.text, '2′ <″> & "ok\'')
})

test('prefissi XML diversi e namespace Strict: stessa struttura', async () => {
  const strict = documentXml(para('Seduta A', { style: 'Titolo1' }) + para('Squat 5 x 5'))
    .replaceAll('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"', 'xmlns:x="http://purl.oclc.org/ooxml/wordprocessingml/main"')
    .replace(/<(\/?)w:/g, '<$1x:').replace(/ w:/g, ' x:')
  const result = await read(buildDocx({ document: strict }))
  assert.deepEqual(result.document.blocks.map(block => [block.kind, block.text]), [['heading', 'Seduta A'], ['paragraph', 'Squat 5 x 5']])
})

test('tabella con ultima riga unita e celle vuote: coordinate valide', async () => {
  const result = await read(buildDocx({ body: tbl(2, [tr([tc('A', { vMerge: 'restart' }), tc('')]), tr([tc('', { vMerge: 'continue' }), tc('')])]) }))
  const blocks = byId(result)
  assert.equal(blocks.get('t:1:r:0:c:0')?.rowSpan, 2)
  assert.equal(blocks.get('t:1:r:1')?.text, '', 'riga senza testo proprio')
  assert.equal(blocks.get('t:1:r:0')?.text, 'A |')
})

test('testo eliminato fuori da w:del e spostamenti: rifiuto, mai testo concatenato né documento parziale', async () => {
  const body = p([r('Panca 3 x '), r({ xml: '<w:delText>12</w:delText>' }), '<w:moveFrom w:id="3" w:author="A">', r('Trazioni '), '</w:moveFrom>', r('10')])
  await rejects(read(buildDocx({ body })), 'unsupported', /revisioni non accettate \(2 — corpo del documento: 2\)/)
})

// ---------------------------------------------------------------------------------------------
// Annullamento e tempo
// ---------------------------------------------------------------------------------------------

test('annullamento: prima dell’inizio e durante la lettura, mai un documento parziale', async () => {
  const bytes = fixtureBytes('docx-nested-tables.docx')
  const aborted = new AbortController()
  aborted.abort()
  await rejects(read(bytes, { signal: aborted.signal }), 'cancelled')

  for (const stopAt of [1, 3, 10, 40]) {
    const controller = new AbortController()
    let calls = 0
    // L'orologio avanza di 30 ms a ogni lettura: forza le pause cooperative e annulla a metà.
    const now = () => { if (++calls === stopAt) controller.abort(); return calls * 30 }
    await rejects(read(bytes, { signal: controller.signal, now, maxMilliseconds: 1e9 }), 'cancelled')
  }
})

test('tempo massimo della lettura effettivo', async () => {
  let clock = 0
  await rejects(read(fixtureBytes('docx-tables.docx'), { now: () => (clock += 1000), maxMilliseconds: 5000 }), 'limit_exceeded', /tempo/, 'readMilliseconds')
})

// ---------------------------------------------------------------------------------------------
// Trasporto worker (in-process: stesso protocollo, stessa funzione del worker reale)
// ---------------------------------------------------------------------------------------------

const delay = (ms: number) => new Promise(done => setTimeout(done, ms))

function fakeWorker(readFunction: ReadFunction, stats: { created: number; terminated: number }): ReaderWorkerHandle {
  stats.created++
  let alive = true
  const handle: ReaderWorkerHandle = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage(message, transfer) {
      const copy = structuredClone(message, { transfer: transfer as ArrayBuffer[] })
      setTimeout(() => { if (alive) scope.onmessage?.({ data: copy }) }, 0)
    },
    terminate() { alive = false; stats.terminated++ },
  }
  const scope: ReaderWorkerScope = {
    onmessage: null,
    postMessage(message) { const copy = structuredClone(message); setTimeout(() => { if (alive) handle.onmessage?.({ data: copy }) }, 0) },
  }
  serveDocumentReader(scope, readFunction)
  return handle
}

const input = (bytes: Uint8Array, signal = new AbortController().signal) => ({ bytes, metadata: { format: 'docx' as const, mediaType: null }, signal })

test('worker: lettura lazy, risultato validato identico al motore, byte del chiamante intatti', async () => {
  const stats = { created: 0, terminated: 0 }
  const reader = createWorkerDocumentReader({ format: 'docx', readerVersion: DOCX_READER_VERSION, createWorker: () => fakeWorker(value => readDocx(value), stats) })
  assert.equal(stats.created, 0, 'nessun worker prima della prima lettura')
  const bytes = fixtureBytes('docx-merged-cells.docx')
  const result = await reader.read(input(bytes))
  assert.deepEqual(result, await readFixture('docx-merged-cells'))
  assert.equal(bytes.byteLength, 2809, 'i byte non sono stati trasferiti via al chiamante')
  await rejects(reader.read(input(fixtureBytes('docx-invalid-package.docx'))), 'corrupt')
  assert.equal(stats.created, 1)
  reader.close()
  assert.equal(stats.terminated, 1)
})

test('worker: annullamento seguito da nuovo file, risposta tardiva ignorata, riavvio dopo il tempo di grazia', async () => {
  const stats = { created: 0, terminated: 0 }
  const slow: ReadFunction = async value => { await delay(60); return readDocx({ ...value, signal: new AbortController().signal }) } // ignora il cancel
  const reader = createWorkerDocumentReader({ format: 'docx', readerVersion: DOCX_READER_VERSION, cancelGraceMilliseconds: 500, createWorker: () => fakeWorker(slow, stats) })
  const first = new AbortController()
  const pending = reader.read(input(fixtureBytes('docx-tables.docx'), first.signal))
  await delay(5)
  first.abort()
  await rejects(pending, 'cancelled')
  const second = await reader.read(input(fixtureBytes('docx-paragraphs.docx')))
  assert.equal(second.document.blocks[0]!.text, 'Scheda forza – blocco 1', 'il nuovo file non riceve la risposta tardiva del precedente')
  assert.equal(stats.terminated, 0, 'risposta arrivata entro il tempo di grazia')

  const graceful = createWorkerDocumentReader({ format: 'docx', readerVersion: DOCX_READER_VERSION, cancelGraceMilliseconds: 10, createWorker: () => fakeWorker(slow, stats) })
  const third = new AbortController()
  const cancelled = graceful.read(input(fixtureBytes('docx-tables.docx'), third.signal))
  await delay(5)
  third.abort()
  await rejects(cancelled, 'cancelled')
  await delay(30)
  assert.equal(stats.terminated, 1, 'worker che non conferma terminato')
  const again = await graceful.read(input(fixtureBytes('docx-tables.docx')))
  assert.equal(again.document.blocks.length, 31)
  assert.equal(stats.created, 3, 'nuovo worker creato alla lettura successiva')
  graceful.close()
  reader.close()
})

test('worker: annullamento cooperativo del motore reale, risposta errata e guasti del trasporto', async () => {
  const stats = { created: 0, terminated: 0 }
  const reader = createWorkerDocumentReader({ format: 'docx', readerVersion: DOCX_READER_VERSION, cancelGraceMilliseconds: 50, createWorker: () => fakeWorker(value => readDocx(value), stats) })
  const controller = new AbortController()
  const pending = reader.read(input(fixtureBytes('docx-nested-tables.docx'), controller.signal))
  controller.abort()
  await rejects(pending, 'cancelled')
  await delay(150)
  assert.equal(stats.terminated, 0, 'il motore ha confermato l’annullamento entro il tempo di grazia')
  await rejects(reader.read(input(new Uint8Array(), AbortSignal.abort())), 'cancelled')
  reader.close()

  const liar = createWorkerDocumentReader({ format: 'docx', readerVersion: DOCX_READER_VERSION, createWorker: () => fakeWorker(async () => ({ document: {}, metadata: {} }) as unknown as DocumentReadResult, stats) })
  await assert.rejects(liar.read(input(fixtureBytes('docx-tables.docx'))), (error: unknown) => error instanceof ReaderWorkerError && error.reason === 'invalid_response')
  liar.close()

  let handle: ReaderWorkerHandle | null = null
  const broken = createWorkerDocumentReader({ format: 'docx', readerVersion: DOCX_READER_VERSION, createWorker: () => (handle = fakeWorker(() => new Promise(() => {}), stats)) })
  const hanging = broken.read(input(fixtureBytes('docx-tables.docx')))
  await delay(5)
  handle!.onerror?.({})
  await assert.rejects(hanging, (error: unknown) => error instanceof ReaderWorkerError && error.reason === 'worker_failed')
  const closing = broken.read(input(fixtureBytes('docx-tables.docx')))
  broken.close()
  await rejects(closing, 'cancelled')
  await rejects(broken.read({ ...input(fixtureBytes('docx-tables.docx')), metadata: { format: 'pdf', mediaType: null } }), 'unsupported')
  assert.equal(READER_WORKER_PROTOCOL, 'peppitness.reader-worker.v1')
})
