// Copertura DOCX del task 04: parti laterali, note, caselle di testo, immagini e relazioni,
// revisioni, parti danneggiate o sconosciute, minimizzazione dei contatti. I golden completi sono
// verificati da tests/import-docx.test.ts; qui asserzioni scritte a mano, indipendenti dai golden.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DocumentReaderError, normalizeSourceText, validateDocumentReadResult, type DocumentReadResult } from '../src/import/contracts/index.ts'
import { docxReadingIssueCodes, readDocx } from '../src/import/readers/docx.ts'
import { CONTACT_MINIMIZATION_VERSION, contactMinimizationRules, minimizeContactData } from '../src/import/readers/minimize.ts'
// @ts-expect-error modulo JavaScript dei generatori di fixture, senza dichiarazioni di tipo
import { buildDocx, comment, commented, CONTENT_TYPES, endnoteRef, footnoteRef, note, notesPart, p, para, r, sidePart, tbl, tc, tr } from '../scripts/lib/docx-fixtures.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const folder = join(root, 'tests', 'fixtures', 'import', 'docx')
const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')) as { cases: { id: string; sourceFile: string; expected: string | null; expectedError: string | null; tags: string[] }[] }

const read = (bytes: Uint8Array) => readDocx({ bytes, metadata: { format: 'docx', mediaType: null }, signal: new AbortController().signal })
const readFixture = (id: string) => read(new Uint8Array(readFileSync(join(folder, `${id}.docx`))))
const byId = (result: DocumentReadResult) => new Map(result.document.blocks.map(block => [block.id, block]))
const statusOf = (result: DocumentReadResult) => Object.fromEntries(result.metadata.inventory.map(entry => [entry.id, entry.status]))
const issues = (result: DocumentReadResult, code: string) => result.document.readingIssues.filter(issue => issue.code === code)
const allText = (result: DocumentReadResult) => result.document.blocks.map(block => block.text).join('\n')
const occurrences = (result: DocumentReadResult, needle: string) => allText(result).split(needle).length - 1

async function rejects(promise: Promise<unknown>, code: string, pattern?: RegExp) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof DocumentReaderError, `atteso DocumentReaderError, ricevuto ${String(error)}`)
    assert.equal(error.code, code, error.message)
    if (pattern) assert.match(error.message, pattern)
    return true
  })
}

/** Invarianti di ogni lettura riuscita: contratto, nessuna pagina, testo canonico, parti non lette sempre visibili. */
function checkInvariants(result: DocumentReadResult) {
  assert.ok(validateDocumentReadResult(result).ok)
  const codes = new Set(result.document.readingIssues.map(issue => issue.code))
  for (const block of result.document.blocks) {
    assert.equal(block.page, null, `${block.id}: nessuna pagina DOCX`)
    assert.equal(block.bbox, null)
    assert.equal(block.origin, 'native')
    assert.equal(block.text, normalizeSourceText(block.text))
  }
  for (const entry of result.metadata.inventory) {
    if (entry.status !== 'read') assert.ok(entry.issueCodes.length && entry.issueCodes.every(code => codes.has(code)), `${entry.id}: non letto senza avviso`)
  }
  const inventoried = new Set(result.metadata.inventory.flatMap(entry => entry.blockIds))
  for (const block of result.document.blocks) assert.ok(inventoried.has(block.id), `${block.id} fuori dall’inventario`)
  assert.equal(inventoried.size, result.metadata.inventory.reduce((total, entry) => total + entry.blockIds.length, 0), 'un blocco appartiene a una sola voce')
  for (const code of codes) assert.ok(Object.hasOwn(docxReadingIssueCodes, code), `codice non dichiarato: ${code}`)
}

// ---------------------------------------------------------------------------------------------
// Corpus: completo, parziale, rifiuto
// ---------------------------------------------------------------------------------------------

test('le fixture distinguono copertura completa, parziale e rifiuto', async () => {
  const outcome = new Map<string, string>()
  for (const item of manifest.cases) {
    try {
      const result = await readFixture(item.id)
      checkInvariants(result)
      outcome.set(item.id, result.metadata.inventory.every(entry => entry.status === 'read') ? 'complete' : 'partial')
    } catch (error) {
      assert.ok(error instanceof DocumentReaderError)
      outcome.set(item.id, `rejected:${error.code}`)
    }
  }
  assert.equal(outcome.get('docx-side-content'), 'complete')
  for (const id of ['docx-paragraphs', 'docx-tables', 'docx-merged-cells', 'docx-nested-tables']) assert.equal(outcome.get(id), 'complete', id)
  for (const id of ['docx-partial-coverage', 'docx-remote-links']) assert.equal(outcome.get(id), 'partial', id)
  for (const id of ['docx-tracked-changes', 'docx-unread-components']) assert.equal(outcome.get(id), 'rejected:unsupported', id)
  assert.equal(outcome.get('docx-invalid-package'), 'rejected:corrupt')
  for (const item of manifest.cases) {
    const tag = item.tags.find(value => value === 'coverage-complete' || value === 'coverage-partial' || value === 'rejection')
    if (tag === 'coverage-complete') assert.equal(outcome.get(item.id), 'complete', item.id)
    if (tag === 'coverage-partial') assert.equal(outcome.get(item.id), 'partial', item.id)
    if (tag === 'rejection') assert.match(outcome.get(item.id)!, /^rejected/, item.id)
  }
})

test('regressione 03: i DOCX semplici restano letti per intero, senza avvisi nuovi oltre alla struttura delle tabelle', async () => {
  for (const id of ['docx-paragraphs', 'docx-tables', 'docx-nested-tables']) {
    const result = await readFixture(id)
    assert.deepEqual(result.document.readingIssues, [], id)
    assert.deepEqual(result.metadata.inventory.map(entry => [entry.id, entry.status]), [['docx:body', 'read']], id)
  }
  const merged = await readFixture('docx-merged-cells')
  assert.deepEqual(merged.document.readingIssues.map(issue => issue.code), ['merged_cell_text', 'table_structure'])
})

// ---------------------------------------------------------------------------------------------
// Parti laterali lette una volta con provenienza
// ---------------------------------------------------------------------------------------------

test('intestazioni, piè di pagina, note e caselle: presenti una sola volta, con ID e ambito propri', async () => {
  const result = await readFixture('docx-side-content')
  const blocks = byId(result)
  // Nessun ID del corpo cambia: il paragrafo vuoto che ancora la casella conta ma non ha blocco.
  assert.deepEqual(result.document.blocks.filter(block => /^p:/.test(block.id)).map(block => block.id), ['p:1', 'p:2', 'p:3', 'p:4', 'p:5', 'p:6', 'p:8', 'p:9', 'p:10', 'p:11'])
  for (const needle of ['Settimane 1–4: recupero 2′', 'Scheda consegnata', 'Settimane 5–8: recupero 90″', 'Coach Luca Verdi', 'cedimento tecnico', 'ridurre il carico del 10%', 'Ripetere il ciclo', 'Riscaldamento: 10 minuti', 'Tempo 3-1-1', 'Solo nelle settimane pari']) {
    assert.equal(occurrences(result, needle), 1, needle)
  }
  // Caselle di testo subito dopo il blocco che le ancora, con parentId su quel blocco.
  const order = result.document.blocks.map(block => block.id)
  assert.equal(order.indexOf('box:1:p:1'), order.indexOf('p:6') + 1)
  assert.deepEqual(['box:1:p:1', 'box:1:p:2', 'box:2:p:1', 'box:3:p:1'].map(id => blocks.get(id)?.parentId), ['p:6', 'p:6', null, 't:1:r:1:c:1'])
  assert.deepEqual(blocks.get('box:1:p:1')?.headingIds, ['p:1', 'p:2'], 'la casella eredita i titoli del punto in cui è ancorata')
  assert.equal(blocks.get('t:1:r:1:c:1')?.text, '2′', 'il testo della casella non entra nella cella')
  // Note: collegate al richiamo; una nota richiamata due volte non sceglie un genitore.
  assert.equal(blocks.get('fn:1:p:1')?.parentId, 'p:3')
  assert.equal(blocks.get('en:1:p:1')?.parentId, 'p:8')
  assert.equal(blocks.get('fn:2:p:1')?.parentId, null)
  assert.deepEqual(issues(result, 'shared_note').map(issue => issue.sourceRefs), [['fn:2:p:1', 'p:4', 'p:5']])
  assert.ok(!allText(result).includes('Squat 4 x 61'), 'il richiamo di nota non diventa testo')
  // Il secondo richiamo è un campo NOTEREF (riferimento incrociato di Word): il numero calcolato non entra nel testo.
  assert.equal(blocks.get('p:5')?.text, 'Trazioni 3 x max')
  // Parti laterali dopo il corpo, nell'ordine dell'inventario: nessun ordine di pagina inventato.
  assert.deepEqual(order.filter(id => !/^(p|t|box):/.test(id)), ['hdr:1:p:1', 'hdr:2:p:1', 'hdr:3:p:1', 'ftr:1:p:1', 'ftr:1:p:2', 'fn:1:p:1', 'fn:2:p:1', 'en:1:p:1'])
  // Campo PAGE non letto: niente numeri di pagina fittizi.
  assert.equal(blocks.get('ftr:1:p:2')?.text, 'Pagina')
  // Ambito: intestazioni diverse per sezione/prima pagina. Il piè di pagina è condiviso dalle due
  // sezioni (la seconda lo eredita): letto una volta, collegato a entrambe; non vale per la prima
  // pagina della sezione 1, che ha titlePg senza piè di pagina proprio.
  const scope = issues(result, 'header_footer_scope')
  assert.deepEqual(scope.map(issue => issue.sourceRefs), [['hdr:1:p:1', 'p:1'], ['hdr:2:p:1', 'p:1'], ['hdr:3:p:1', 'p:9'], ['ftr:1:p:1', 'ftr:1:p:2', 'p:1', 'p:9']])
  assert.match(scope[1]!.message, /sezione 1 \(dal blocco p:1\) – prima pagina della sezione/)
  assert.match(scope[2]!.message, /sezione 2 \(dal blocco p:9\) – pagine ordinarie/)
  assert.match(scope[3]!.message, /sezione 1 \(dal blocco p:1\) – pagine ordinarie; sezione 2 \(dal blocco p:9\) – pagine ordinarie/)
  const uniform = await read(buildDocx({
    sectionXml: '<w:footerReference w:type="default" r:id="rIdFooter"/>',
    documentRels: [['rIdFooter', 'footer', 'footer1.xml']],
    parts: [{ name: 'word/footer1.xml', contentType: CONTENT_TYPES.footer, data: sidePart('ftr', para('Valido per tutto il documento')) }],
    body: p(r('Prima sezione'), { markXml: '<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter"/><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>' }) + para('Seconda sezione'),
  }))
  assert.deepEqual(issues(uniform, 'header_footer_scope'), [], 'parte valida per tutte le pagine di tutte le sezioni: nessun avviso')
  assert.equal(occurrences(uniform, 'Valido per tutto il documento'), 1)
  assert.ok(result.metadata.inventory.every(entry => entry.status === 'read'))
  assert.deepEqual(result.metadata.inventory.find(entry => entry.id === 'docx:text-boxes')?.blockIds, ['box:1:p:1', 'box:1:p:2', 'box:2:p:1', 'box:3:p:1'])
})

test('pagine pari/dispari e prima pagina solo se attive; parte non usata esclusa con avviso', async () => {
  const header = (text: string) => sidePart('hdr', para(text))
  const settings = sidePart('settings', '<w:evenAndOddHeaders/>')
  const bytes = buildDocx({
    sectionXml: '<w:headerReference w:type="default" r:id="rIdOdd"/><w:headerReference w:type="even" r:id="rIdEven"/><w:headerReference w:type="first" r:id="rIdFirst"/>',
    documentRels: [['rIdOdd', 'header', 'header1.xml'], ['rIdEven', 'header', 'header2.xml'], ['rIdFirst', 'header', 'header3.xml'], ['rIdSettings', 'settings', 'settings.xml']],
    parts: [
      { name: 'word/header1.xml', contentType: CONTENT_TYPES.header, data: header('Dispari: carico pieno') },
      { name: 'word/header2.xml', contentType: CONTENT_TYPES.header, data: header('Pari: carico ridotto') },
      { name: 'word/header3.xml', contentType: CONTENT_TYPES.header, data: header('Prima pagina non attiva') },
      { name: 'word/settings.xml', contentType: CONTENT_TYPES.settings, data: settings },
    ],
    body: para('Squat 5 x 5'),
  })
  const result = await read(bytes)
  checkInvariants(result)
  assert.deepEqual(issues(result, 'header_footer_scope').map(issue => issue.message.replace(/ \(il documento.*/, '')), [
    'Intestazione 1: vale soltanto per: sezione 1 (dal blocco p:1) – pagine dispari',
    'Intestazione 2: vale soltanto per: sezione 1 (dal blocco p:1) – pagine pari',
  ])
  assert.ok(!allText(result).includes('Prima pagina non attiva'), 'titlePg assente: la prima pagina usa l’intestazione ordinaria')
  assert.equal(statusOf(result)['docx:header:3'], 'not_read')
  assert.match(issues(result, 'hidden_text')[0]!.message, /Intestazione 3: non usata/)
})

test('nota richiamata due volte dallo stesso paragrafo, nota senza richiamo, nota in cella', async () => {
  const bytes = buildDocx({
    documentRels: [['rIdFootnotes', 'footnotes', 'footnotes.xml'], ['rIdEndnotes', 'endnotes', 'endnotes.xml']],
    parts: [
      { name: 'word/footnotes.xml', contentType: CONTENT_TYPES.footnotes, data: notesPart('footnote', [note('footnote', 1, 'Tempo sotto tensione 40″.'), note('footnote', 5, 'Mai richiamata.')]) },
      { name: 'word/endnotes.xml', contentType: CONTENT_TYPES.endnotes, data: notesPart('endnote', [note('endnote', 1, 'Nota di chiusura in cella.')]) },
    ],
    body: [p([r('Panca 3 x 8'), footnoteRef(1), r(' poi fermo'), footnoteRef(1)]), tbl(2, [tr([tc('Stacco'), tc([p([r('5 x 3'), endnoteRef(1)])])])])].join(''),
  })
  const result = await read(bytes)
  checkInvariants(result)
  const blocks = byId(result)
  assert.equal(blocks.get('fn:1:p:1')?.parentId, 'p:1', 'stesso blocco richiamante: un solo genitore')
  assert.equal(blocks.get('en:1:p:1')?.parentId, 't:1:r:0:c:1')
  assert.deepEqual(issues(result, 'shared_note'), [])
  assert.ok(!allText(result).includes('Mai richiamata'))
  assert.equal(statusOf(result)['docx:footnotes'], 'partial')
  assert.match(issues(result, 'hidden_text')[0]!.message, /non richiamate nel testo \(1\)/)
})

// ---------------------------------------------------------------------------------------------
// Parti non lette: sempre segnalate
// ---------------------------------------------------------------------------------------------

test('copertura parziale: immagini, grafico, formule, simboli, nascosto, commenti, parti sconosciute mai silenziosi', async () => {
  const result = await readFixture('docx-partial-coverage')
  checkInvariants(result)
  assert.deepEqual(statusOf(result), {
    'docx:body': 'partial', 'docx:images': 'not_read', 'docx:embedded-objects': 'not_read', 'docx:header:1': 'read', 'docx:header:2': 'not_read',
    'docx:footnotes': 'partial', 'docx:comments': 'not_read', 'docx:other-parts': 'not_read',
  })
  // Nulla di escluso entra nei blocchi: né il testo nascosto, né note/intestazioni invisibili, né commenti, né testo alternativo o del grafico.
  for (const needle of ['solo nei giorni', 'oppure tacchino', 'Bozza precedente', 'Vecchia nota', 'yogurt greco', 'Aggiungere 20 g', 'Tabella delle porzioni', 'Peso settimanale', '1800±100']) {
    assert.ok(!allText(result).includes(needle), needle)
  }
  assert.deepEqual(issues(result, 'hidden_text')[0]!.sourceRefs, ['p:5', 't:1:r:1:c:1'], 'testo nascosto anche in una cella')
  assert.deepEqual(issues(result, 'component_not_read').map(issue => issue.sourceRefs), [['p:2']], 'commento con il blocco a cui è ancorato')
  assert.match(issues(result, 'image_without_text')[0]!.message, /Immagini \(1\)/)
  assert.ok(issues(result, 'unsupported_content').some(issue => /Oggetti incorporati o grafici \(1\)/.test(issue.message) && issue.sourceRefs.includes('p:4')))
  assert.ok(issues(result, 'unsupported_content').some(issue => /tipo non riconosciuto con testo \(1\)/.test(issue.message)))
  assert.deepEqual(issues(result, 'table_structure')[0]!.sourceRefs, ['t:1:r:2:c:1'])
  assert.deepEqual(issues(result, 'table_continuation')[0]!.sourceRefs, ['t:2:r:0'])
  assert.equal(byId(result).get('fn:1:p:1')?.parentId, 'p:9')
})

test('file valido ma vuoto e documento con sola immagine: nessun blocco, mai una lettura presentata come riuscita', async () => {
  const empty = await read(buildDocx({ body: p('') }))
  checkInvariants(empty)
  assert.deepEqual(empty.document.blocks, [])
  assert.deepEqual(empty.metadata.inventory.map(entry => [entry.id, entry.status, entry.issueCodes]), [['docx:body', 'no_text', ['empty_body']]])
  assert.match(issues(empty, 'empty_body')[0]!.message, /non contiene testo leggibile/)

  const image = await read(buildDocx({
    documentRels: [['rIdImage1', 'image', 'media/image1.png']],
    parts: [{ name: 'word/media/image1.png', data: new Uint8Array([137, 80, 78, 71]), method: 0 }],
    body: p('<w:r><w:drawing><wp:inline><wp:extent cx="1" cy="1"/><wp:docPr id="1" name="Immagine" descr="Scheda: squat 5 x 5"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="rIdImage1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'),
  }))
  checkInvariants(image)
  assert.deepEqual(image.document.blocks, [], 'il testo alternativo non diventa contenuto')
  assert.deepEqual(statusOf(image), { 'docx:body': 'no_text', 'docx:images': 'not_read' })
})

test('immagini: relazione interna, mancante, esterna e VML; testo nascosto da stile in cella e in casella', async () => {
  const blip = (attributes: string) => `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="i"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip ${attributes}/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  const box = `<w:r><w:pict><v:shape><v:textbox><w:txbxContent>${p([r('Casella: '), r('nota segreta', { hidden: true })])}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`
  const result = await read(buildDocx({
    documentRels: [['rIdOk', 'image', 'media/ok.png'], ['rIdMissing', 'image', 'media/assente.png'], ['rIdFar', 'image', 'https://example.invalid/x.png', true]],
    parts: [{ name: 'word/media/ok.png', data: new Uint8Array([1]), method: 0 }],
    body: [
      p([r('Interna'), blip('r:embed="rIdOk"')]),
      p([r('Mancante'), blip('r:embed="rIdMissing"')]),
      p([r('Inesistente'), blip('r:embed="rIdNessuno"')]),
      p([r('Esterna'), blip('r:embed="rIdFar"')]),
      p([r('VML'), '<w:r><w:pict><v:shape><v:imagedata r:id="rIdOk"/></v:shape></w:pict></w:r>']),
      p([r('Vedi'), box]),
      tbl(1, [tr([tc([p([r('Cella '), r('da togliere', { style: 'Nascosto' })])])])]),
    ].join(''),
  }))
  checkInvariants(result)
  const images = result.document.readingIssues.filter(issue => issue.code === 'image_without_text').map(issue => [issue.message.replace(/ \(.*/, ''), issue.sourceRefs])
  assert.deepEqual(images, [
    ['Immagini', ['p:1', 'p:5']],
    ['Immagini collegate all’esterno', ['p:4']],
    ['Immagini con collegamento interno mancante o danneggiato', ['p:2', 'p:3']],
  ])
  assert.equal(byId(result).get('box:1:p:1')?.text, 'Casella:', 'casella VML letta, testo nascosto escluso')
  assert.equal(statusOf(result)['docx:text-boxes'], 'partial')
  assert.deepEqual(issues(result, 'hidden_text').map(issue => issue.sourceRefs), [['t:1:r:0:c:0'], ['box:1:p:1']])
  assert.ok(!allText(result).includes('segreta') && !allText(result).includes('togliere'))
})

test('parte laterale danneggiata: lettura parziale rivedibile; DTD o limite restano fatali', async () => {
  const withFooter = (footer: string, extra: Record<string, unknown> = {}) => buildDocx({
    sectionXml: '<w:footerReference w:type="default" r:id="rIdFooter"/>',
    documentRels: [['rIdFooter', 'footer', 'footer1.xml']],
    parts: [{ name: 'word/footer1.xml', contentType: CONTENT_TYPES.footer, data: footer }],
    body: para('Squat 5 x 5'),
    ...extra,
  })
  const broken = await read(withFooter(sidePart('ftr', '<w:p><w:r><w:t>Rotto</w:r></w:p>')))
  checkInvariants(broken)
  assert.deepEqual(statusOf(broken), { 'docx:body': 'read', 'docx:footer:1': 'not_read' })
  assert.match(issues(broken, 'damaged_part')[0]!.message, /Piè di pagina 1: parte danneggiata/)
  assert.equal(byId(broken).get('p:1')?.text, 'Squat 5 x 5')

  const wrongRoot = await read(withFooter(sidePart('hdr', para('Radice sbagliata'))))
  assert.equal(statusOf(wrongRoot)['docx:footer:1'], 'not_read')

  const doctype = `<?xml version="1.0"?>\n<!DOCTYPE w:ftr [<!ENTITY x SYSTEM "https://example.invalid/">]>` + sidePart('ftr', para('x')).replace(/^<\?xml[^>]*\?>\n/, '')
  await rejects(read(withFooter(doctype)), 'unsupported', /DTD/)

  const missing = await read(buildDocx({
    sectionXml: '<w:headerReference w:type="default" r:id="rIdHeader"/><w:footerReference w:type="default" r:id="rIdNessuno"/>',
    documentRels: [['rIdHeader', 'header', 'header9.xml']],
    body: para('Squat 5 x 5'),
  }))
  checkInvariants(missing)
  assert.equal(statusOf(missing)['docx:header:1'], 'not_read')
  assert.deepEqual(issues(missing, 'damaged_part').map(issue => issue.message.replace(/:.*/, '')), ['Riferimenti a intestazioni o piè di pagina inesistenti (1)', 'Intestazione 1'])
})

test('note con ID duplicati o commenti senza testo: parte danneggiata oppure letta senza avvisi superflui', async () => {
  const duplicated = await read(buildDocx({
    documentRels: [['rIdFootnotes', 'footnotes', 'footnotes.xml'], ['rIdComments', 'comments', 'comments.xml']],
    parts: [
      { name: 'word/footnotes.xml', contentType: CONTENT_TYPES.footnotes, data: notesPart('footnote', [note('footnote', 1, 'Uno'), note('footnote', 1, 'Due')]) },
      { name: 'word/comments.xml', contentType: CONTENT_TYPES.comments, data: sidePart('comments', comment(0, ' ')) },
    ],
    body: p([...commented(0, [r('Squat')]), footnoteRef(1)]),
  }))
  checkInvariants(duplicated)
  assert.deepEqual(statusOf(duplicated), { 'docx:body': 'read', 'docx:footnotes': 'not_read', 'docx:comments': 'read' })
  assert.ok(!allText(duplicated).includes('Uno'))
})

test('componente sconosciuto: segnalato solo se contiene testo', async () => {
  const withPart = (data: string) => buildDocx({
    documentRels: [['rIdX', 'http://example.invalid/relationships/extra', 'extra/parte.xml']],
    parts: [{ name: 'word/extra/parte.xml', data }],
    body: para('Squat 5 x 5'),
  })
  const silent = await read(withPart('<dati xmlns="urn:x"><nome>Mario</nome></dati>'))
  assert.deepEqual(statusOf(silent), { 'docx:body': 'read' }, 'dati personalizzati senza testo Word: non sono contenuto del documento')
  const loud = await read(withPart(`<x xmlns="urn:x" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>Fase 2: +10% di carico</a:t></x>`))
  assert.equal(statusOf(loud)['docx:other-parts'], 'not_read')
  const broken = await read(withPart('<x xmlns="urn:x"><a></x>'))
  assert.match(issues(broken, 'damaged_part')[0]!.message, /non riconosciuto e non leggibili \(1\)/)
})

// ---------------------------------------------------------------------------------------------
// Revisioni: rifiuto con diagnostica per parte
// ---------------------------------------------------------------------------------------------

test('revisioni aperte in corpo, tabella, nota e intestazione: rifiuto preciso, nessun documento parziale', async () => {
  await rejects(readFixture('docx-tracked-changes'), 'unsupported',
    /revisioni non accettate \(7 — corpo del documento: 3; intestazione 1: 2; note a piè di pagina: 2\)\. Il lettore non sceglie fra testo inserito ed eliminato/)
  const inBox = buildDocx({ body: p([r('Vedi'), `<w:r><w:pict><v:shape><v:textbox><w:txbxContent>${p([r('Serie '), '<w:ins w:id="1" w:author="A">', r('4'), '</w:ins>'])}</w:txbxContent></v:textbox></v:shape></w:pict></w:r>`]) })
  await rejects(read(inBox), 'unsupported', /caselle di testo: 1/)
  // Paragrafo segnato come inserito: cambierebbe i confini dei paragrafi accettando la revisione.
  await rejects(read(buildDocx({ body: p(r('Squat'), { markXml: '<w:rPr><w:ins w:id="1" w:author="A"/></w:rPr>' }) })), 'unsupported')
})

// ---------------------------------------------------------------------------------------------
// Relazioni esterne mai seguite
// ---------------------------------------------------------------------------------------------

test('collegamenti remoti ostili: nessuna richiesta di rete, parti esterne segnalate', async () => {
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = (() => { requests++; throw new Error('rete vietata') }) as typeof fetch
  try {
    const result = await readFixture('docx-remote-links')
    checkInvariants(result)
    assert.equal(requests, 0)
    assert.deepEqual(statusOf(result), { 'docx:body': 'partial', 'docx:images': 'not_read', 'docx:header:1': 'not_read' })
    assert.match(issues(result, 'component_not_read')[0]!.message, /Intestazione 1: collegata a un file esterno, mai scaricata/)
    assert.ok(!JSON.stringify(result).includes('tracker.example.invalid'), 'nessun URL nel documento')
    assert.equal(byId(result).get('p:2')?.text, 'Tecnica: guarda il video')
  } finally {
    globalThis.fetch = original
  }
  // Nessun modulo del reader può fare richieste di rete.
  const readers = join(root, 'src', 'import', 'readers')
  for (const file of readdirSync(readers).filter(name => /^(docx|ooxml|zip|xml|minimize)/.test(name))) {
    assert.doesNotMatch(readFileSync(join(readers, file), 'utf8'), /\bfetch\(|XMLHttpRequest|importScripts|WebSocket|EventSource/, file)
  }
})

// ---------------------------------------------------------------------------------------------
// Minimizzazione: metadati mai letti, contatti sostituiti, prescrizioni intatte
// ---------------------------------------------------------------------------------------------

test('metadati OOXML mai letti: autori, azienda, proprietà e date non entrano nel documento', async () => {
  const bytes = buildDocx({
    documentRels: [['rIdComments', 'comments', 'comments.xml']],
    parts: [
      { name: 'docProps/core.xml', data: '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Mario Rossi Autore</dc:creator><dc:title>Titolo Privato</dc:title></cp:coreProperties>' },
      { name: 'docProps/app.xml', data: '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Company>Palestra Riservata Srl</Company></Properties>' },
      { name: 'word/comments.xml', contentType: CONTENT_TYPES.comments, data: sidePart('comments', comment(0, 'Commento qualsiasi')) },
    ],
    body: p([...commented(0, [r('Squat 5 x 5')])]),
  })
  const result = await read(bytes)
  const serialized = JSON.stringify(result)
  for (const secret of ['Mario Rossi', 'Titolo Privato', 'Palestra Riservata', 'Revisore Esempio', '2026-09-01', 'Commento qualsiasi']) assert.ok(!serialized.includes(secret), secret)
})

test('contatti chiaramente separati sostituiti; numeri prescrittivi, citazioni e Unicode intatti', async () => {
  const untouched = ['Squat 4 x 8', '1′30″ di pausa', 'Aggiornata al 28/09/2026', '2.000 kcal', '1 800 kcal', '300 400 500', 'Pranzo 12:30', '120-150 g', 'RPE 8 @ 70%', 'Settimane 1–4', 'tel 3 x 10', '+2 kg', '½ porzione — «tempo 3-1-1»', 'numero 3331234567890']
  for (const text of untouched) assert.deepEqual(minimizeContactData(text), { text, replaced: 0 }, text)
  const cases: [string, string][] = [
    ['Coach Luca Verdi · tel. 333 1234567 · luca.verdi@example.invalid', 'Coach Luca Verdi · [telefono] · [email]'],
    ['Cell: +39 333 123 4567', '[telefono]'],
    ['Fax 02-1234567', '[telefono]'],
    ['0039 333 1234567', '[telefono]'],
    ['P.IVA 01234567890', '[partita IVA]'],
    ['CF RSSMRA80A01H501U', 'CF [codice fiscale]'],
    ['mailto:a.b@example.it', '[email]'],
  ]
  for (const [input, output] of cases) assert.equal(minimizeContactData(input).text, output, input)
  assert.ok(contactMinimizationRules.every(rule => rule.placeholder.startsWith('[')))

  const prescription = 'Recupero 1′30″ tra le serie; se il carico è eccessivo chiama il 333 1234567 e riduci del 10%'
  const result = await read(buildDocx({ body: [para(prescription), tbl(2, [tr([tc('Coach'), tc('luca@example.invalid')]), tr([tc('Panca'), tc('3 × 8–10 @ 75%')])])].join('') }))
  checkInvariants(result)
  const text = byId(result).get('p:1')!.text
  assert.equal(text, 'Recupero 1′30″ tra le serie; se il carico è eccessivo chiama il [telefono] e riduci del 10%')
  for (const quote of ['Recupero 1′30″ tra le serie', 'riduci del 10%']) assert.ok(text.includes(quote), 'citazione ancora verificabile')
  assert.equal(byId(result).get('t:1:r:0')?.text, 'Coach | [email]', 'riga dalle celle già minimizzate')
  assert.equal(byId(result).get('t:1:r:1:c:1')?.text, '3 × 8–10 @ 75%')
  assert.deepEqual(issues(result, 'contact_data_removed').map(issue => [issue.sourceRefs, issue.message.includes(CONTACT_MINIMIZATION_VERSION)]), [[['p:1', 't:1:r:0:c:1'], true]])
})

test('tabella interrotta e riga di larghezza diversa dalla griglia', async () => {
  const result = await read(buildDocx({
    body: [
      tbl(3, [tr([tc('Esercizio'), tc('Serie'), tc('Rip.')]), tr([tc('Squat'), tc('4')])]),
      p(''), '<w:bookmarkStart w:id="0" w:name="x"/><w:bookmarkEnd w:id="0"/>',
      tbl(3, [tr([tc('Panca'), tc('3'), tc('10')])]),
      para('Nota fra le tabelle'),
      tbl(3, [tr([tc('Stacco'), tc('5'), tc('5')])]),
    ].join(''),
  }))
  checkInvariants(result)
  assert.deepEqual(issues(result, 'table_structure')[0]!.sourceRefs, ['t:1:r:1'])
  assert.deepEqual(issues(result, 'table_continuation')[0]!.sourceRefs, ['t:2:r:0'], 'una nota fra le tabelle interrompe la continuità')
})
