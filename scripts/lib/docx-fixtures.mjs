// Costruzione deterministica di pacchetti DOCX sintetici per i test del reader (task 03).
// Nessun dato personale: contenuti inventati. Stesso input → stessi byte (data ZIP fissa,
// DEFLATE di fflate a livello fisso), così hash e golden restano riproducibili.
import { deflateSync } from 'fflate'

const encoder = new TextEncoder()
const bytesOf = data => typeof data === 'string' ? encoder.encode(data) : data

let table = null
export function crc32(bytes) {
  if (!table) {
    table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * Archivio ZIP minimale. Ogni entry: { name, data, method = 8, declaredSize?, crc?, flags?,
 * localName? } — i campi facoltativi servono a costruire archivi volutamente scorretti.
 */
export function buildZip(entries) {
  const chunks = []
  const central = []
  let offset = 0
  for (const entry of entries) {
    const raw = bytesOf(entry.data)
    const method = entry.method ?? 8
    const compressed = entry.compressed ?? (method === 8 ? deflateSync(raw, { level: 9 }) : raw)
    const name = encoder.encode(entry.name)
    const localName = encoder.encode(entry.localName ?? entry.name)
    const crc = entry.crc ?? crc32(raw)
    const size = entry.declaredSize ?? raw.length
    const flags = entry.flags ?? 0x0800
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, flags, true)
    local.setUint16(8, method, true)
    local.setUint16(10, 0, true)
    local.setUint16(12, 0x21, true) // 1980-01-01
    local.setUint32(14, crc, true)
    local.setUint32(18, compressed.length, true)
    local.setUint32(22, size, true)
    local.setUint16(26, localName.length, true)
    local.setUint16(28, 0, true)
    chunks.push(new Uint8Array(local.buffer), localName, compressed)
    const header = new DataView(new ArrayBuffer(46))
    header.setUint32(0, 0x02014b50, true)
    header.setUint16(4, 20, true)
    header.setUint16(6, 20, true)
    header.setUint16(8, flags, true)
    header.setUint16(10, method, true)
    header.setUint16(12, 0, true)
    header.setUint16(14, 0x21, true)
    header.setUint32(16, crc, true)
    header.setUint32(20, compressed.length, true)
    header.setUint32(24, size, true)
    header.setUint16(28, name.length, true)
    header.setUint32(42, entry.offset ?? offset, true)
    central.push(new Uint8Array(header.buffer), name)
    offset += 30 + localName.length + compressed.length
  }
  const centralSize = central.reduce((total, chunk) => total + chunk.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, centralSize, true)
  end.setUint32(16, offset, true)
  const all = [...chunks, ...central, new Uint8Array(end.buffer)]
  const result = new Uint8Array(all.reduce((total, chunk) => total + chunk.length, 0))
  let position = 0
  for (const chunk of all) { result.set(chunk, position); position += chunk.length }
  return result
}

// --- WordprocessingML ------------------------------------------------------------------------

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
export const DOCUMENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'
const namespaces = [
  `xmlns:w="${W}"`, `xmlns:r="${R}"`,
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:v="urn:schemas-microsoft-com:vml"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
].join(' ')

export const escapeXml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Run: stringa di testo o frammento già XML ({ xml }). Opzioni: bold, hidden, style. */
export function r(content, options = {}) {
  const props = [options.style ? `<w:rStyle w:val="${options.style}"/>` : '', options.bold ? '<w:b/>' : '', options.hidden ? '<w:vanish/>' : ''].join('')
  const body = typeof content === 'string' ? `<w:t xml:space="preserve">${escapeXml(content)}</w:t>` : content.xml
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}${body}</w:r>`
}
export const tab = { xml: '<w:tab/>' }
export const br = { xml: '<w:br/>' }

/** Paragrafo: contenuto XML già composto. Opzioni: style, numId, ilvl, outline. */
export function p(content = '', options = {}) {
  const numbering = options.numId !== undefined ? `<w:numPr>${options.ilvl !== undefined ? `<w:ilvl w:val="${options.ilvl}"/>` : ''}<w:numId w:val="${options.numId}"/></w:numPr>` : ''
  const props = [options.style ? `<w:pStyle w:val="${options.style}"/>` : '', numbering, options.outline !== undefined ? `<w:outlineLvl w:val="${options.outline}"/>` : '', options.markXml ?? ''].join('')
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${Array.isArray(content) ? content.join('') : content}</w:p>`
}
/** Paragrafo semplice con un solo run. */
export const para = (text, options) => p(r(text), options)

/** Cella: contenuto XML (paragrafi/tabelle) o testo. Opzioni: span, vMerge ('restart'|'continue'), hMerge. */
export function tc(content, options = {}) {
  const props = [
    options.span ? `<w:gridSpan w:val="${options.span}"/>` : '',
    options.hMerge ? (options.hMerge === 'restart' ? '<w:hMerge w:val="restart"/>' : '<w:hMerge/>') : '',
    options.vMerge ? (options.vMerge === 'restart' ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>') : '',
  ].join('')
  const body = typeof content === 'string' ? para(content) : Array.isArray(content) ? content.join('') : content
  // Una cella Word termina sempre con un paragrafo.
  return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${props}</w:tcPr>${body.endsWith('</w:p>') ? body : body + '<w:p/>'}</w:tc>`
}
/** Riga: celle già composte. Opzioni: header, gridBefore. */
export function tr(cells, options = {}) {
  const props = [options.gridBefore ? `<w:gridBefore w:val="${options.gridBefore}"/>` : '', options.header ? '<w:tblHeader/>' : ''].join('')
  return `<w:tr>${props ? `<w:trPr>${props}</w:trPr>` : ''}${cells.join('')}</w:tr>`
}
export function tbl(columns, rows) {
  const grid = Array.from({ length: columns }, () => '<w:gridCol w:w="2000"/>').join('')
  return `<w:tbl><w:tblPr><w:tblStyle w:val="Grigliatabella"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${rows.join('')}</w:tbl>`
}

export const documentXml = (body, sectionXml = '') => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${namespaces} mc:Ignorable=""><w:body>${body}<w:sectPr>${sectionXml}<w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`

/** Stili con ID localizzati (come Word in italiano): i nomi inglesi restano quelli predefiniti. */
export const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:lang w:val="it-IT"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normale"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Titolo"><w:name w:val="Title"/><w:basedOn w:val="Normale"/></w:style>
<w:style w:type="paragraph" w:styleId="Titolo1"><w:name w:val="heading 1"/><w:basedOn w:val="Normale"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Titolo2"><w:name w:val="heading 2"/><w:basedOn w:val="Normale"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Paragrafoelenco"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normale"/></w:style>
<w:style w:type="paragraph" w:styleId="Puntato"><w:name w:val="List Bullet"/><w:basedOn w:val="Normale"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>
<w:style w:type="character" w:styleId="Nascosto"><w:name w:val="Hidden note"/><w:rPr><w:vanish/></w:rPr></w:style>
<w:style w:type="table" w:styleId="Grigliatabella"><w:name w:val="Table Grid"/></w:style>
</w:styles>`

export const numberingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${W}">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="%2)"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`

const relationship = (id, type, target, external = false) =>
  `<Relationship Id="${id}" Type="${REL}/${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ''}/>`
export const relationshipsXml = items => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.map(item => relationship(...item)).join('')}</Relationships>`

/**
 * DOCX completo. `parts` aggiunge parti { name, data, contentType? }; `documentRels` aggiunge
 * relazioni [id, type, target, external?] a quelle di stili e numerazione.
 */
export function buildDocx({ body, sectionXml, mainPart = 'word/document.xml', mainContentType = DOCUMENT_TYPE, documentRels = [], parts = [], packageRels, contentTypes, document } = {}) {
  const extra = parts.map(part => ({ name: part.name, data: part.data, method: part.method }))
  const overrides = [[mainPart, mainContentType], ['word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'], ['word/numbering.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'], ...parts.filter(part => part.contentType).map(part => [part.name, part.contentType])]
  const types = contentTypes ?? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>${overrides.map(([name, type]) => `<Override PartName="/${name}" ContentType="${type}"/>`).join('')}</Types>`
  const mainDirectory = mainPart.slice(0, mainPart.lastIndexOf('/') + 1)
  const mainName = mainPart.slice(mainPart.lastIndexOf('/') + 1)
  return buildZip([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: packageRels ?? relationshipsXml([['rId1', 'officeDocument', mainPart]]) },
    { name: mainPart, data: document ?? documentXml(body, sectionXml) },
    { name: `${mainDirectory}_rels/${mainName}.rels`, data: relationshipsXml([['rIdStyles', 'styles', 'styles.xml'], ['rIdNumbering', 'numbering', 'numbering.xml'], ...documentRels]) },
    { name: 'word/styles.xml', data: stylesXml },
    { name: 'word/numbering.xml', data: numberingXml },
    ...extra,
  ])
}

// --- Fixture del corpus ----------------------------------------------------------------------

const field = (instruction, result) => [
  '<w:r><w:fldChar w:fldCharType="begin"/></w:r>',
  `<w:r><w:instrText xml:space="preserve"> ${escapeXml(instruction)} </w:instrText></w:r>`,
  '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
  r(result),
  '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
].join('')

function paragraphsFixture() {
  return buildDocx({
    documentRels: [['rIdLink', 'hyperlink', 'https://example.invalid/tecnica', true]],
    body: [
      para('Scheda forza – blocco 1', { style: 'Titolo' }),
      // Parole spezzate in più run con formattazioni diverse, segnalibri e correzioni.
      p(['<w:bookmarkStart w:id="0" w:name="inizio"/>', r('Obiettivo: ', { bold: true }), r('for'), '<w:proofErr w:type="spellStart"/>', r('za'), '<w:proofErr w:type="spellEnd"/>', r(' e '), r('tec'), r('nica'), '<w:bookmarkEnd w:id="0"/>']),
      p(''),
      para('Seduta A', { style: 'Titolo1' }),
      p([r('Squ'), r('at'), r(tab), r('4 x 8'), r(br), r('RPE 8')], { style: 'Paragrafoelenco', numId: 1, ilvl: 0 }),
      p(r('Pausa di 2″ in buca'), { style: 'Paragrafoelenco', numId: 1, ilvl: 1 }),
      p(r('Bilanciere all’altezza delle spalle'), { style: 'Paragrafoelenco', numId: 1, ilvl: 1 }),
      p(r('Panca piana: 3 x 10–12'), { style: 'Paragrafoelenco', numId: 1, ilvl: 0 }),
      p([r('Guarda il '), '<w:hyperlink r:id="rIdLink" w:history="1">', r('video della tecnica'), '</w:hyperlink>', r('.')]),
      para('Note', { style: 'Titolo2' }),
      p([r('Aggiornata al '), field('DATE \\@ "dd/MM/yyyy"', '28/09/2026')]),
      p([r('Recupero tra le serie:'), r(' '), r('90 secondi'), r('  per tutti gli esercizi. ')]),
      p([r('Rest'), r({ xml: '<w:noBreakHyphen/>' }), r('pause sull’ultima serie; com'), r({ xml: '<w:softHyphen/>' }), r('pleta il set.')]),
      p('<w:sdt><w:sdtPr><w:alias w:val="Durata"/></w:sdtPr><w:sdtContent>' + r('Durata: 45 minuti') + '</w:sdtContent></w:sdt>'),
      p(r('Carico: ½ del massimale, 1′30″ di pausa​ — «tempo 3-1-1»')),
      para('Seduta B', { style: 'Titolo1' }),
      para('Stacco rumeno 3 x 6', { style: 'Puntato' }),
      p(r('Nota libera fuori elenco'), { style: 'Puntato', numId: 0 }),
      para('Dettagli', { outline: 2 }),
      para('Chiudere con 5 minuti di mobilità.'),
    ].join(''),
  })
}

function tablesFixture() {
  return buildDocx({
    body: [
      para('Tabella allenamento', { style: 'Titolo' }),
      para('Seduta A', { style: 'Titolo1' }),
      para('Riscaldamento: 10 minuti di cyclette prima della tabella.'),
      tbl(4, [
        tr([tc('Esercizio'), tc('Serie'), tc('Ripetizioni'), tc('Recupero')], { header: true }),
        tr([tc([p([r('Squ'), r('at')])]), tc('4'), tc('6–8'), tc('2′')]),
        tr([tc('Panca inclinata'), tc('3'), tc('10'), tc('')]),
        tr([tc([para('Rematore'), para('con manubrio')]), tc('3'), tc('12'), tc('90″')]),
      ]),
      para('Recupero globale: se non indicato, 90 secondi tra le serie.'),
      para('Seduta B', { style: 'Titolo1' }),
      tbl(2, [
        tr([tc('Trazioni'), tc('3 x max')]),
        tr([tc('presa prona')], { gridBefore: 1 }),
      ]),
      para('Fine seduta: stretching 5 minuti.'),
    ].join(''),
  })
}

function mergedCellsFixture() {
  return buildDocx({
    body: [
      para('Piano settimanale', { style: 'Titolo1' }),
      tbl(3, [
        tr([tc('Giorno'), tc('Esercizio'), tc('Schema')], { header: true }),
        tr([tc('Lunedì', { vMerge: 'restart' }), tc('Squat'), tc('5 x 5')]),
        tr([tc('', { vMerge: 'continue' }), tc('Affondi'), tc('3 x 10')]),
        tr([tc('Martedì', { vMerge: 'restart' }), tc('Riposo attivo: camminata 30 minuti', { span: 2 })]),
        tr([tc('', { vMerge: 'continue' }), tc('Plank'), tc('3 x 30″')]),
        tr([tc('', { vMerge: 'continue' }), tc('Crunch'), tc('3 x 15')]),
      ]),
      para('Circuito', { style: 'Titolo1' }),
      tbl(3, [
        tr([tc('Circuito A: ripetere 3 volte', { span: 2, vMerge: 'restart' }), tc('Note')]),
        tr([tc('senza pausa fra gli esercizi', { span: 2, vMerge: 'continue' }), tc('Recupero 60″')]),
        tr([tc('Defaticamento', { hMerge: 'restart' }), tc('', { hMerge: 'continue' }), tc('5′')]),
        tr([tc('Totale: 40 minuti', { span: 2 }), tc('', { vMerge: 'continue' })]),
      ]),
    ].join(''),
  })
}

function nestedTablesFixture() {
  return buildDocx({
    body: [
      para('Circuiti', { style: 'Titolo1' }),
      para('Nota prima: eseguire i circuiti in ordine.'),
      tbl(2, [
        tr([tc('Blocco'), tc('Dettaglio')], { header: true }),
        tr([tc('Circuito 1'), tc([
          para('Ripetere 2 volte:'),
          tbl(2, [tr([tc('Burpee'), tc('10')]), tr([tc('Jumping jack'), tc('30″')])]),
          para('Pausa 1′ alla fine.'),
        ])]),
        tr([tc('Circuito 2'), tc([
          tbl(2, [
            tr([tc('Kettlebell swing', { vMerge: 'restart' }), tc('15')]),
            tr([tc('', { vMerge: 'continue' }), tc([tbl(2, [tr([tc('Variante'), tc('Goblet squat 10')])])])]),
          ]),
        ])]),
      ]),
      para('Nota dopo: recupero globale 2 minuti tra i circuiti.'),
    ].join(''),
  })
}

/** Pacchetto ZIP con parti Word ma senza [Content_Types].xml: non è un OOXML valido. */
function invalidPackageFixture() {
  return buildZip([
    { name: '_rels/.rels', data: relationshipsXml([['rId1', 'officeDocument', 'word/document.xml']]) },
    { name: 'word/document.xml', data: documentXml(para('Squat 5 x 5')) },
  ])
}

// PNG 1×1 trasparente.
export const tinyPng = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), char => char.charCodeAt(0))

const textBox = text => `<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:posOffset>0</wp:posOffset></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="1800000" cy="600000"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="1" name="Casella di testo 1"/><wp:cNvGraphicFramePr/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1800000" cy="600000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></wps:spPr><wps:txbx><w:txbxContent>${para(text)}</w:txbxContent></wps:txbx><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape style="width:140pt;height:47pt"><v:textbox><w:txbxContent>${para(text)}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent>`
const inlineImage = relationshipId => `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="95250" cy="95250"/><wp:docPr id="2" name="Immagine 2"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="immagine.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr/></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`

/** Componenti che questa versione non legge: devono produrre avvisi, mai sparire. */
function unreadComponentsFixture() {
  const part = (root, content) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:${root} ${namespaces}>${content}</w:${root}>`
  return buildDocx({
    sectionXml: '<w:headerReference w:type="default" r:id="rIdHeader1"/><w:footerReference w:type="default" r:id="rIdFooter1"/>',
    documentRels: [
      ['rIdHeader1', 'header', 'header1.xml'],
      ['rIdFooter1', 'footer', 'footer1.xml'],
      ['rIdFootnotes', 'footnotes', 'footnotes.xml'],
      ['rIdImage1', 'image', 'media/image1.png'],
    ],
    parts: [
      { name: 'word/header1.xml', data: part('hdr', para('Tutti i giorni: 2 litri d’acqua')), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml' },
      { name: 'word/footer1.xml', data: part('ftr', p('')), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml' },
      {
        name: 'word/footnotes.xml',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
        data: part('footnotes', [
          `<w:footnote w:type="separator" w:id="-1">${p(r({ xml: '<w:separator/>' }))}</w:footnote>`,
          `<w:footnote w:type="continuationSeparator" w:id="0">${p(r({ xml: '<w:continuationSeparator/>' }))}</w:footnote>`,
          `<w:footnote w:id="1">${para('Ridurre il carico in caso di dolore.')}</w:footnote>`,
        ].join('')),
      },
      { name: 'word/media/image1.png', data: tinyPng, method: 0 },
    ],
    body: [
      para('Scheda con parti da controllare', { style: 'Titolo1' }),
      // Revisione aperta: 6 eliminato, 8 inserito. Non devono diventare «68».
      p([r('Squat 4 x '), '<w:del w:id="1" w:author="Autore" w:date="2026-09-01T00:00:00Z"><w:r><w:delText>6</w:delText></w:r></w:del>', '<w:ins w:id="2" w:author="Autore" w:date="2026-09-01T00:00:00Z">', r('8'), '</w:ins>']),
      p([r('Panca 3 x 10'), r(' nota interna per il coach', { hidden: true })]),
      p([r('Affondi 3 x 12'), r(' da togliere', { style: 'Nascosto' })]),
      p([r('Vedi riquadro'), `<w:r>${textBox('Riscaldamento extra: 5 minuti')}</w:r>`]),
      p(`<w:r>${inlineImage('rIdImage1')}</w:r>`),
      p([r('Plank 3 x 30″'), '<w:r><w:footnoteReference w:id="1"/></w:r>']),
      p([r('Formula: '), '<m:oMath><m:r><m:t>x+1</m:t></m:r></m:oMath>']),
    ].join(''),
  })
}

export const docxFixtureBuilders = {
  'docx-paragraphs': paragraphsFixture,
  'docx-tables': tablesFixture,
  'docx-merged-cells': mergedCellsFixture,
  'docx-nested-tables': nestedTablesFixture,
  'docx-unread-components': unreadComponentsFixture,
  'docx-invalid-package': invalidPackageFixture,
}
