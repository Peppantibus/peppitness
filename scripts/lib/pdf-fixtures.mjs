// Costruzione deterministica di PDF sintetici per i test del reader PDF (task 05).
// Nessun dato personale: contenuti inventati. Stesso input → stessi byte (nessuna data, ID fissi,
// zlib di fflate a livello fisso), così hash e golden restano riproducibili.
//
// Pagine descritte da operazioni di disegno ad alto livello: testo con font standard (Helvetica,
// Helvetica-Bold, Symbol per ′ ″), testo invisibile (Tr 3), testo con un font CID senza mappa
// Unicode, immagini in scala di grigi che simulano una scansione, rotazione /Rotate.
import { deflateSync, zlibSync } from 'fflate'

const ascii = new TextEncoder()
/** WinAnsiEncoding: Latin-1 più i caratteri tipografici di cp1252 usati nelle schede. */
const winAnsiExtra = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97 }
function winAnsi(text) {
  const bytes = []
  for (const char of text) {
    const code = winAnsiExtra[char] ?? char.codePointAt(0)
    if (code > 0xff) throw new Error(`Carattere non WinAnsi: ${char}`)
    bytes.push(code)
  }
  return bytes
}
/** Codici del font Symbol per i segni di minuti e secondi. */
const symbolCodes = { '′': 0xa2, '″': 0xb2, '×': 0xb4, '±': 0xb1 }
const escapeBytes = bytes => bytes.map(byte => byte === 0x28 || byte === 0x29 || byte === 0x5c ? `\\${String.fromCharCode(byte)}` : byte < 0x20 || byte > 0x7e ? `\\${byte.toString(8).padStart(3, '0')}` : String.fromCharCode(byte)).join('')
/** Larghezze Helvetica (1/1000 di em) dei caratteri usati dove serve posizionare testo allineato a destra. */
const helvetica = { ' ': 278, A: 667, a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, i: 222, l: 222, m: 833, n: 556, o: 556, r: 333, s: 500, t: 278, u: 556, z: 500 }
export const helveticaWidth = (value, size) => [...value].reduce((total, char) => total + (helvetica[char] ?? 556), 0) * size / 1000
const number = value => Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')

/**
 * Testo su una riga. `runs`: stringa oppure elenco di { text, font } per mescolare Helvetica e
 * Symbol sulla stessa riga (segni ′ ″). Opzioni: font (F1 Helvetica, F2 Helvetica-Bold), size,
 * invisible (Tr 3), matrix (rotazione del testo nello spazio pagina).
 */
export function text(x, y, runs, options = {}) {
  const size = options.size ?? 11
  const parts = typeof runs === 'string' ? [{ text: runs, font: options.font ?? 'F1' }] : runs
  const shows = parts.map(part => {
    const font = part.font ?? options.font ?? 'F1'
    const bytes = font === 'F3' ? [...part.text].map(char => symbolCodes[char] ?? char.codePointAt(0)) : winAnsi(part.text)
    return `/${font} ${number(size)} Tf (${escapeBytes(bytes)}) Tj`
  }).join(' ')
  const matrix = options.matrix ?? [1, 0, 0, 1, x, y]
  return `BT ${options.invisible ? '3 Tr ' : ''}${matrix.map(number).join(' ')} Tm ${shows} ET`
}
/** Testo con il font CID senza ToUnicode: i codici diventano caratteri di controllo o illeggibili. */
export const unmappedText = (x, y, cids, size = 11) => `BT 1 0 0 1 ${number(x)} ${number(y)} Tm /F4 ${number(size)} Tf <${cids.map(cid => cid.toString(16).padStart(4, '0')).join('')}> Tj ET`
/** Immagine della pagina: rettangolo in punti PDF con origine in basso a sinistra. */
export const image = (name, x, y, width, height) => `q ${number(width)} 0 0 ${number(height)} ${number(x)} ${number(y)} cm /${name} Do Q`
/** Rettangolo pieno (bordo di tabella, riga): non è testo né immagine. */
export const rule = (x, y, width, height) => `${number(x)} ${number(y)} ${number(width)} ${number(height)} re f`

/** Immagine in scala di grigi che simula una pagina scansionata: righe scure come testo. */
export function scanImage(width, height, seed = 1) {
  const data = new Uint8Array(width * height)
  let state = seed >>> 0
  const random = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32 }
  for (let row = 0; row < height; row++) {
    const inkRow = row % 12 >= 3 && row % 12 <= 7 && row > height * 0.08 && row < height * 0.92
    for (let column = 0; column < width; column++) {
      const ink = inkRow && column > width * 0.1 && column < width * 0.9 && random() < 0.55
      data[row * width + column] = ink ? 40 + Math.floor(random() * 30) : 235 + Math.floor(random() * 20)
    }
  }
  return { width, height, data }
}

/**
 * Immagine CCITT di 8×8 pixel bianchi: ogni riga è il codice «bianco lungo 8» (10011), senza fine
 * riga né allineamento ai byte. Basta a far passare PDF.js dal decodificatore CCITT/JBIG2.
 */
export function ccittWhiteImage() {
  const bits = '10011'.repeat(8)
  const data = new Uint8Array(Math.ceil(bits.length / 8))
  for (let index = 0; index < bits.length; index++) if (bits[index] === '1') data[index >> 3] |= 0x80 >> (index & 7)
  return { width: 8, height: 8, data, ccitt: true }
}

/** Rumore non comprimibile, per avvicinare un file ai limiti di dimensione. */
export function noiseImage(width, height, seed = 7) {
  const data = new Uint8Array(width * height)
  let state = seed >>> 0
  for (let index = 0; index < data.length; index++) { state = (Math.imul(state, 1103515245) + 12345) >>> 0; data[index] = state >>> 24 }
  return { width, height, data }
}

const fontObjects = {
  F1: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  F2: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  F3: '<< /Type /Font /Subtype /Type1 /BaseFont /Symbol >>',
}

/**
 * PDF completo. `pages`: { width = 595, height = 842, rotate = 0, content: string[], images = { Nome: {width,height,data} },
 * damaged = false } — `damaged` comprime il contenuto senza intestazione zlib: flusso illeggibile.
 * `encrypt`: dizionario Standard con password utente sconosciuta (la lettura richiede la password).
 */
export function buildPdf({ pages, encrypt = false, compress = true }) {
  const objects = []
  const add = body => { objects.push(body); return objects.length }
  const stream = (dictionary, bytes, damaged = false) => {
    const data = damaged ? deflateSync(bytes, { level: 9 }) : compress ? zlibSync(bytes, { level: 9 }) : bytes
    return { dictionary: `<< ${dictionary}${compress ? ' /Filter /FlateDecode' : ''} /Length ${data.length} >>`, data }
  }

  const catalog = add(null)
  const pagesId = add(null)
  const fonts = Object.fromEntries(Object.entries(fontObjects).map(([name, body]) => [name, add(body)]))
  // Font CID Identity-H non incorporato e senza ToUnicode: il testo non è riconducibile a Unicode.
  const descendant = add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FontSenzaMappa /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ' + (objects.length + 2) + ' 0 R /DW 500 >>')
  fonts.F4 = add(`<< /Type /Font /Subtype /Type0 /BaseFont /FontSenzaMappa /Encoding /Identity-H /DescendantFonts [${descendant} 0 R] >>`)
  add('<< /Type /FontDescriptor /FontName /FontSenzaMappa /Flags 4 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 >>')
  const fontResources = Object.entries(fonts).map(([name, id]) => `/${name} ${id} 0 R`).join(' ')

  const pageIds = []
  for (const page of pages) {
    const imageIds = Object.entries(page.images ?? {}).map(([name, picture]) => {
      if (picture.ccitt) {
        // Immagine bitonale codificata CCITT Gruppo 3 (1D): decodificata dal modulo JBIG2/CCITT di PDF.js.
        const dictionary = `<< /Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K 0 /Columns ${picture.width} /Rows ${picture.height} >> /Length ${picture.data.length} >>`
        return [name, add({ dictionary, data: picture.data })]
      }
      const body = stream(`/Type /XObject /Subtype /Image /Width ${picture.width} /Height ${picture.height} /ColorSpace /DeviceGray /BitsPerComponent 8`, picture.data)
      return [name, add(body)]
    })
    const content = add(stream('', ascii.encode(page.content.join('\n')), page.damaged))
    const xobjects = imageIds.length ? ` /XObject << ${imageIds.map(([name, id]) => `/${name} ${id} 0 R`).join(' ')} >>` : ''
    const rotate = page.rotate ? ` /Rotate ${page.rotate}` : ''
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${page.width ?? 595} ${page.height ?? 842}]${rotate} /Resources << /Font << ${fontResources} >>${xobjects} >> /Contents ${content} 0 R >>`))
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`
  const encryptId = encrypt
    ? add(`<< /Filter /Standard /V 2 /R 3 /Length 128 /P -3904 /O <${'5a'.repeat(32)}> /U <${'c3'.repeat(32)}> >>`)
    : null

  const chunks = []
  let length = 0
  const push = value => { const bytes = typeof value === 'string' ? ascii.encode(value) : value; chunks.push(bytes); length += bytes.length }
  push('%PDF-1.7\n')
  push(Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])) // commento binario come nei PDF reali
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(length)
    if (typeof body === 'string') push(`${index + 1} 0 obj\n${body}\nendobj\n`)
    else { push(`${index + 1} 0 obj\n${body.dictionary}\nstream\n`); push(body.data); push('\nendstream\nendobj\n') }
  })
  const xref = length
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`)
  const id = '<00112233445566778899aabbccddeeff>'
  push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${encryptId ? ` /Encrypt ${encryptId} 0 R` : ''} /ID [${id} ${id}] >>\nstartxref\n${xref}\n%%EOF\n`)
  const result = new Uint8Array(length)
  let position = 0
  for (const chunk of chunks) { result.set(chunk, position); position += chunk.length }
  return result
}

// --- Fixture del corpus ----------------------------------------------------------------------

const A4 = { width: 595, height: 842 }

/** Testo semplice: titolo, titoli di sezione, elenco, paragrafo a due righe scritto in ordine non visivo, ′ ″, contatti. */
function simpleFixture() {
  return buildPdf({
    pages: [{
      ...A4,
      content: [
        text(56, 780, 'Scheda forza – blocco 1', { font: 'F2', size: 20 }),
        text(56, 740, 'Seduta A', { font: 'F2', size: 14 }),
        text(56, 715, '• Squat 4 x 8'),
        text(56, 700, '• Panca piana 3 x 10–12'),
        text(56, 685, [{ text: '• Recupero 1' }, { text: '′', font: 'F3' }, { text: '30' }, { text: '″', font: 'F3' }, { text: ' tra le serie' }]),
        // Paragrafo su due righe, disegnate prima la seconda e poi la prima: ordine PDF non visivo.
        text(56, 645, 'fino a quando la tecnica resta pulita.'),
        text(56, 660, 'Aumentare il carico di 2,5 kg a settimana'),
        text(56, 610, 'Seduta B', { font: 'F2', size: 14 }),
        text(56, 585, '• Stacco rumeno 3 x 6'),
        text(56, 570, [{ text: '• Plank 3 x 30' }, { text: '″', font: 'F3' }]),
        text(56, 60, 'Coach Luca Verdi – tel. 333 1234567', { size: 8 }),
      ],
    }],
  })
}

/** Due colonne con numeri simili: pagina 1 elenchi allineati riga per riga, pagina 2 testo in colonne non allineate. */
function twoColumnsFixture() {
  const left = ['Scheda A', 'Squat 4 x 8', 'Panca 3 x 10', 'Stacco 5 x 5', 'Recupero 90 s']
  const right = ['Scheda B', 'Squat 3 x 8', 'Panca 4 x 10', 'Stacco 5 x 5', 'Recupero 120 s']
  const aligned = left.flatMap((line, index) => [text(56, 760 - index * 18, line, { font: index ? 'F1' : 'F2' }), text(320, 760 - index * 18, right[index], { font: index ? 'F1' : 'F2' })])
  const proseLeft = ['Colazione: yogurt greco 170 g con', 'avena 40 g e frutti di bosco 100 g.', 'Spuntino: una mela e 15 g di noci.', 'Pranzo: riso basmati 80 g, pollo', '150 g e verdure a volontà.']
  const proseRight = ['Merenda: 2 fette di pane integrale', 'con 30 g di bresaola.', 'Cena: salmone 150 g, patate', '200 g e insalata con 10 g di olio.']
  return buildPdf({
    pages: [
      { ...A4, content: [text(56, 800, 'Confronto schede', { font: 'F2', size: 16 }), ...aligned] },
      {
        ...A4,
        content: [
          text(56, 800, 'Piano alimentare – giorno tipo', { font: 'F2', size: 16 }),
          ...proseLeft.map((line, index) => text(56, 760 - index * 14, line)),
          // Colonna destra con interlinea diversa: le righe non sono allineate con quelle di sinistra.
          ...proseRight.map((line, index) => text(310, 753 - index * 17, line)),
          text(56, 640, 'Bere almeno 2 litri di acqua al giorno, distribuiti fra i pasti principali.'),
        ],
      },
    ],
  })
}

/** Tabella con intestazione, numeri simili, cella a capo, colonne senza spazio e un numero sollevato fuori riga. */
function tableFixture() {
  const columns = [56, 220, 290, 360]
  const rows = [
    ['Esercizio', 'Serie', 'Rip.', 'Recupero'],
    ['Squat', '4', '6–8', '2\''],
    ['Panca inclinata', '3', '10', '90"'],
    ['Rematore', '3', '12', '90"'],
    ['Trazioni', '3', '8', '2\''],
  ]
  const content = [text(56, 790, 'Seduta A – tabella', { font: 'F2', size: 14 })]
  rows.forEach((cells, row) => {
    const y = 750 - row * 20
    cells.forEach((cell, column) => content.push(text(columns[column], y, cell, { font: row ? 'F1' : 'F2' })))
    content.push(rule(56, y - 5, 380, 0.5))
  })
  // Colonne senza spazio: la prima cella, allineata a destra, tocca la colonna delle serie; le altre
  // righe confermano dove inizia la colonna.
  const touching = 'Affondi con manubri'
  content.push(text(220 - helveticaWidth(touching, 11), 650, touching), text(220, 650, '3'), text(290, 650, '10'), text(360, 650, '60"'))
  // Numero sollevato di mezza riga: non si sa a quale riga appartenga.
  content.push(text(290, 675.5, '12'))
  content.push(text(56, 610, 'Nota: ripetere la seduta due volte a settimana.'))
  return buildPdf({ pages: [{ ...A4, content }] })
}

/** Pagine ruotate: /Rotate 90 con testo scritto per apparire dritto, /Rotate 90 con testo che appare verticale, pagina orizzontale. */
function rotatedFixture() {
  // Testo ruotato di 90° nello spazio pagina: con /Rotate 90 la pagina lo mostra orizzontale.
  const upright = (x, y, line, size = 11) => text(0, 0, line, { size, matrix: [0, 1, -1, 0, x, y] })
  return buildPdf({
    pages: [
      // Con /Rotate 90 l'alto della pagina visualizzata corrisponde a x piccole nello spazio pagina.
      { ...A4, rotate: 90, content: [upright(76, 56, 'Settimana 1 – orizzontale', 16), upright(106, 56, 'Squat 5 x 5'), upright(126, 56, 'Panca 5 x 5'), upright(146, 56, 'Recupero 2 minuti tra le serie')] },
      { ...A4, rotate: 90, content: [text(56, 780, 'Pagina ruotata senza compensazione', { size: 14 }), text(56, 750, 'Stacco 3 x 5'), text(56, 735, 'Rematore 3 x 10')] },
      { width: 842, height: 595, content: [text(56, 540, 'Pagina orizzontale', { font: 'F2', size: 16 }), text(56, 510, 'Trazioni 4 x 6'), text(430, 510, 'Dip 4 x 8')] },
    ],
  })
}

const fullPageScan = (name = 'Scan') => image(name, 0, 0, 595, 842)

/** Solo scansione: due pagine con un'immagine a pagina intera e nessun testo. */
function scanOnlyFixture() {
  return buildPdf({ pages: [1, 2].map(seed => ({ ...A4, content: [fullPageScan()], images: { Scan: scanImage(170, 240, seed) } })) })
}

/** Testo e scansione: metà pagina immagine senza testo, pagina di solo testo, sfondo decorativo sotto il testo, logo piccolo. */
function mixedFixture() {
  return buildPdf({
    pages: [
      { ...A4, content: [text(56, 790, 'Dieta – settimana 1', { font: 'F2', size: 16 }), text(56, 760, 'Colazione: yogurt 150 g'), image('Tab', 56, 120, 480, 560)], images: { Tab: scanImage(160, 190, 3) } },
      { ...A4, content: [text(56, 790, 'Pranzo: riso 80 g e pollo 150 g'), text(56, 770, 'Cena: pesce 200 g e verdure'), image('Logo', 500, 780, 40, 40)], images: { Logo: scanImage(20, 20, 4) } },
      { ...A4, content: [image('Sfondo', 0, 0, 595, 842), text(56, 790, 'Spuntino: frutta 200 g'), text(56, 770, 'Acqua: almeno 2 litri')], images: { Sfondo: scanImage(60, 85, 5) } },
    ],
  })
}

/** Ultima pagina non leggibile: due pagine di testo e l'ultima scansionata. */
function lastPageScanFixture() {
  return buildPdf({
    pages: [
      { ...A4, content: [text(56, 790, 'Settimana 1', { font: 'F2', size: 16 }), text(56, 760, 'Squat 4 x 8'), text(56, 745, 'Panca 3 x 10')] },
      { ...A4, content: [text(56, 790, 'Settimana 2', { font: 'F2', size: 16 }), text(56, 760, 'Squat 4 x 6'), text(56, 745, 'Panca 4 x 8')] },
      { ...A4, content: [fullPageScan()], images: { Scan: scanImage(170, 240, 9) } },
    ],
  })
}

/** Font senza mappa Unicode accanto a testo normale, e testo invisibile sopra una scansione (OCR di terzi). */
function unreadableTextFixture() {
  return buildPdf({
    pages: [
      { ...A4, content: [text(56, 790, 'Integrazione', { font: 'F2', size: 14 }), unmappedText(56, 760, [3, 17, 25, 4, 9, 30, 11, 5, 3, 19, 7]), unmappedText(56, 745, [12, 6, 21, 3, 28, 14, 2, 22])] },
      { ...A4, content: [fullPageScan(), text(60, 700, 'Cena: pesce 200 g', { invisible: true }), text(60, 680, 'Verdure a volontà', { invisible: true })], images: { Scan: scanImage(170, 240, 11) } },
    ],
  })
}

function passwordFixture() {
  return buildPdf({ encrypt: true, pages: [{ ...A4, content: [text(56, 780, 'Contenuto riservato')] }] })
}

/** Intestazione PDF seguita da dati non validi: nessun oggetto leggibile. */
/** Scansione bitonale CCITT a pagina intera, come molti scanner da ufficio: nessun testo. */
function ccittScanFixture() {
  return buildPdf({ pages: [{ ...A4, content: [fullPageScan('Fax')], images: { Fax: ccittWhiteImage() } }] })
}

function corruptFixture() {
  const bytes = new Uint8Array(600)
  bytes.set(ascii.encode('%PDF-1.7\n'))
  let state = 3
  for (let index = 9; index < bytes.length; index++) { state = (state * 1103515245 + 12345) >>> 0; bytes[index] = 0x80 | (state >>> 25) }
  return bytes
}

/** Pagina centrale con il flusso del contenuto danneggiato, fra due pagine leggibili. */
function damagedPageFixture() {
  return buildPdf({
    pages: [
      { ...A4, content: [text(56, 790, 'Settimana 1: Squat 4 x 8')] },
      { ...A4, damaged: true, content: [text(56, 790, 'Settimana 2: Squat 4 x 6')] },
      { ...A4, content: [text(56, 790, 'Settimana 3: Squat 5 x 5')] },
    ],
  })
}

/** Molte pagine di testo: numero di pagine oltre il limite, costruito dai test. */
export const manyPages = (count, extra = []) => buildPdf({ pages: Array.from({ length: count }, (_, index) => ({ ...A4, content: [text(56, 790, `Pagina ${index + 1}: Squat 3 x 10`), ...extra] })) })

export const pdfFixtureBuilders = {
  'pdf-simple': simpleFixture,
  'pdf-two-columns': twoColumnsFixture,
  'pdf-table': tableFixture,
  'pdf-rotated': rotatedFixture,
  'pdf-scan-only': scanOnlyFixture,
  'pdf-mixed': mixedFixture,
  'pdf-last-page-scan': lastPageScanFixture,
  'pdf-unreadable-text': unreadableTextFixture,
  'pdf-damaged-page': damagedPageFixture,
  'pdf-ccitt-scan': ccittScanFixture,
  'pdf-password': passwordFixture,
  'pdf-corrupt': corruptFixture,
}
