import { TEXT_NORMALIZATION_VERSION, type NormalizedDocument } from '../contracts/normalized-document.ts'
import { extractionSchemaIds } from '../contracts/extraction.ts'
import { IMPORT_COMMIT_PROTOCOL_VERSION, IMPORT_PROVENANCE_FORMAT, validateCommitCommand, type CommitCommand, type ResolvedWorkoutImport, type ResolvedDietImport } from '../contracts/commit.ts'
import { type ExerciseChoice, exerciseChoiceValues, validateExerciseChoice } from '../contracts/review.ts'
import { UUID_PATTERN } from '../contracts/schema.ts'
import { matchExercises, normalizeExerciseName, type CatalogSnapshot } from '../matching/exercises.ts'

export const STRUCTURED_VERSION = 'peppitness.structured.v1'
export type StructuredKind = 'workout' | 'diet'
export const markers = { workout: 'PEPPITNESS WORKOUT 1', diet: 'PEPPITNESS DIET 1' }
export const compilation = {
  workout: 'Compilazione: sostituisci gli esempi. Una riga per esercizio, Seduta ripetuta. Serie positive; Ripetizioni intere o intervallo (8-10), oppure Durata in secondi. Recupero obbligatorio in secondi (0 esplicito). Note facoltative; progressioni e condizioni restano istruzioni, non dosi iniziali. Non cambiare versione, sezioni o intestazioni; niente celle unite. Salva come DOCX.',
  diet: 'Compilazione: sostituisci gli esempi. Dichiara ogni Giorno in Giornate: Tipo Palestra, Riposo o Qualsiasi. Una riga per alimento; Giorno e Pasto ripetuti. Quantità testuale facoltativa, senza calcoli. Note facoltative. Alternative e Aggiunte: Giorno e Pasto del pasto base, Testo completo con condizioni. Istruzioni globali nella tabella Istruzioni. Non cambiare versione, sezioni o intestazioni; niente celle unite. Salva come DOCX.',
}
export const columns = {
  Allenamento: ['Seduta', 'Esercizio', 'Serie', 'Ripetizioni', 'Durata (s)', 'Recupero (s)', 'Note'],
  Alimenti: ['Giorno', 'Pasto', 'Alimento', 'Quantità', 'Note'],
  Giornate: ['Giorno', 'Tipo'],
  Istruzioni: ['Testo'],
  Alternative: ['Giorno', 'Pasto', 'Testo'],
  Aggiunte: ['Giorno', 'Pasto', 'Testo'],
} as const
export type Section = keyof typeof columns
export interface Cell { id: string; text: string }
export interface StructuredRow { id: string; number: number; cells: Cell[] }
export interface StructuredTable { id: string; section: Section; rows: StructuredRow[] }
export interface StructuredDraft {
  version: typeof STRUCTURED_VERSION; kind: StructuredKind; title: Cell; tables: StructuredTable[]
  document: NormalizedDocument; proposalId: string; ids: Record<string, string>; choices: Record<string, ExerciseChoice>
}
export interface Problem { cellId: string | null; message: string }
export class TemplateError extends Error {}
/** Recupero: la topologia e gli ID restano quelli del reader; solo i testi sono editabili. */
export function isStructuredDraft(value: unknown): value is StructuredDraft {
  try {
    const draft = value as StructuredDraft
    if (!draft || draft.version !== STRUCTURED_VERSION || !['workout', 'diet'].includes(draft.kind) || !UUID_PATTERN.test(draft.proposalId)) return false
    const source = parseStructured(draft.document, draft.kind)
    if (draft.title.id !== source.title.id || typeof draft.title.text !== 'string' || draft.tables.length !== source.tables.length) return false
    if (draft.tables.some((table, i) => table.id !== source.tables[i]!.id || table.section !== source.tables[i]!.section || table.rows.length !== source.tables[i]!.rows.length || table.rows.some((row, j) => row.id !== source.tables[i]!.rows[j]!.id || row.number !== source.tables[i]!.rows[j]!.number || row.cells.length !== source.tables[i]!.rows[j]!.cells.length || row.cells.some((cell, k) => cell.id !== source.tables[i]!.rows[j]!.cells[k]!.id || typeof cell.text !== 'string')))) return false
    return Object.values(draft.ids).every(id => typeof id === 'string' && UUID_PATTERN.test(id)) && Object.values(draft.choices).every(choice => validateExerciseChoice(choice).ok)
  } catch { return false }
}
export function parseStructured(document: NormalizedDocument, kind: StructuredKind, newId = () => crypto.randomUUID()): StructuredDraft {
  if (document.readingIssues.length) throw new TemplateError(`Contenuto non supportato: ${document.readingIssues.map(i => i.message).join(' ')} Correggi il Word prima di importarlo.`)
  const paragraphs = document.blocks.filter(b => b.kind !== 'table_row' && b.kind !== 'table_cell' && b.text)
  if (paragraphs[0]?.text !== markers[kind]) throw new TemplateError(`Template non riconosciuto. Usa il modello ${kind === 'workout' ? 'scheda' : 'dieta'} versione 1; prima riga richiesta: ${markers[kind]}.`)
  const title = paragraphs[1]
  if (!title?.text.startsWith('Titolo:')) throw new TemplateError('Manca il paragrafo «Titolo: nome del piano» dopo la versione del modello.')
  const tables: StructuredTable[] = []
  let section: Section | null = null
  const seen = new Set<string>()
  for (const block of document.blocks) {
    if (block.kind === 'table_row') continue
    if (block.kind === 'table_cell') {
      if (seen.has(block.tableId!)) continue
      seen.add(block.tableId!)
      if (!section) throw new TemplateError('Ogni tabella deve essere preceduta dal nome della sezione previsto dal modello.')
      if (tables.some(t => t.section === section)) throw new TemplateError(`Sezione ${section} ripetuta: usa una sola tabella.`)
      const cells = document.blocks.filter(b => b.kind === 'table_cell' && b.tableId === block.tableId)
      if (cells.some(c => (c.rowSpan ?? 1) !== 1 || (c.columnSpan ?? 1) !== 1)) throw new TemplateError(`Sezione ${section}: celle unite non supportate. Ripeti il valore in ogni riga.`)
      const rows = [...new Set(cells.map(c => c.row!))].sort((a, b) => a - b).map(row => cells.filter(c => c.row === row).sort((a, b) => a.column! - b.column!))
      const header = rows.shift()!
      const expected = columns[section]
      if (header.length !== expected.length || header.some((c, i) => c.text !== expected[i] || c.column !== i)) throw new TemplateError(`Sezione ${section}: intestazioni richieste, in ordine: ${expected.join(' | ')}. Non aggiungere colonne.`)
      const parsedRows = rows.map(row => {
        if (row.length !== expected.length || row.some((c, i) => c.column !== i)) throw new TemplateError(`Sezione ${section}, riga ${row[0]!.row! + 1}: numero di celle non valido.`)
        return { id: row[0]!.parentId ?? row[0]!.id, number: row[0]!.row! + 1, cells: row.map(c => ({ id: c.id, text: c.text })) }
      }).filter(row => row.cells.some(c => c.text))
      tables.push({ id: block.tableId!, section, rows: parsedRows }); section = null
      continue
    }
    if (!block.text || block.id === paragraphs[0]?.id || block.id === title.id) continue
    if (block.text.startsWith('Compilazione:')) {
      // Le istruzioni del modello sono metadata espliciti, mai prescrizioni.
      if (tables.length || paragraphs.indexOf(block) !== 2 || block.text !== compilation[kind]) throw new TemplateError('Il paragrafo Compilazione deve essere quello del modello. Metti le prescrizioni nella tabella Istruzioni o nelle Note.')
      continue
    }
    if (!Object.hasOwn(columns, block.text)) throw new TemplateError(`Testo fuori struttura (${block.id}): «${block.text.slice(0, 90)}». Spostalo nella tabella Istruzioni o nelle Note.`)
    if (section) throw new TemplateError(`Sezione ${section} senza tabella.`)
    section = block.text as Section
    if (kind === 'workout' && !['Allenamento', 'Istruzioni'].includes(section) || kind === 'diet' && section === 'Allenamento') throw new TemplateError(`Sezione ${section} non prevista in questo modello.`)
  }
  if (section) throw new TemplateError(`Sezione ${section} senza tabella.`)
  for (const name of kind === 'workout' ? ['Allenamento'] : ['Giornate', 'Alimenti']) if (!tables.some(t => t.section === name && t.rows.length)) throw new TemplateError(`Manca la tabella ${name} compilata.`)
  return { version: STRUCTURED_VERSION, kind, title: { id: title.id, text: title.text.slice(7).trim() }, tables, document, proposalId: newId(), ids: {}, choices: {} }
}

export const identityKey = (name: string, mode: string) => `${normalizeExerciseName(name)}:${mode}`
export function structuredCandidates(name: string, mode: 'reps' | 'seconds', catalog: CatalogSnapshot) {
  const result = matchExercises([{ localId: 'structured', name, measurementMode: mode, variant: null, equipment: null, perSide: null, loadUnit: null, loadConvention: null }], catalog)[0]!
  const candidates = result.candidates.filter(c => c.nameMatch === 'exact' && !c.conflicts.length && c.selectable)
  const personal = candidates.filter(c => c.choice.source === 'existing')
  return personal.length ? personal : candidates
}
export function buildStructured(draft: StructuredDraft, catalog: CatalogSnapshot, follow = false, revision: number | null = null, newId = () => crypto.randomUUID()) {
  const problems: Problem[] = []
  const error = (cellId: string | null, message: string) => problems.push({ cellId, message })
  const id = (key: string) => draft.ids[key] ??= newId()
  const rows = (section: Section) => draft.tables.find(t => t.section === section)?.rows ?? []
  const checkText = (cell: Cell, max: number, required: boolean, label: string) => {
    if (required && !cell.text.trim()) error(cell.id, `${label}: valore obbligatorio.`)
    if ([...cell.text].length > max) error(cell.id, `${label}: massimo ${max} caratteri.`)
    if (required && cell.text !== cell.text.trim()) error(cell.id, `${label}: rimuovi gli spazi iniziali e finali.`)
  }
  checkText(draft.title, 160, true, 'Titolo')
  const scalar = (cell: Cell, min: number, max: number, label: string) => {
    const n = /^\d+$/.test(cell.text) ? Number(cell.text) : NaN
    if (!Number.isSafeInteger(n) || n < min || n > max) { error(cell.id, `${label}: inserisci un intero da ${min} a ${max}.`); return Number.NaN }
    return n
  }
  const guidance = rows('Istruzioni').map(row => { checkText(row.cells[0]!, 16000, true, `Istruzioni riga ${row.number}`); return row.cells[0]!.text }).join('\n')
  if ([...guidance].length > 16000) error(null, `Istruzioni: ${[...guidance].length} caratteri complessivi, massimo 16000. Riduci la sezione nel Word o nell’anteprima.`)
  let command: CommitCommand
  if (draft.kind === 'workout') {
    if (!catalog.complete) error(null, 'Attendi il caricamento completo del catalogo prima di salvare.')
    const resolved: ResolvedWorkoutImport = { planId: id('plan'), versionId: id('version'), title: draft.title.text, guidance, cycle: null, days: [], catalog: [] }
    for (const row of rows('Allenamento')) {
      const [session, name, setsCell, reps, duration, rest, note] = row.cells as [Cell, Cell, Cell, Cell, Cell, Cell, Cell]
      const label = `Allenamento riga ${row.number}`
      checkText(session, 40, true, `${label}, Seduta`); checkText(name, 120, true, `${label}, Esercizio`); checkText(note, 4000, false, `${label}, Note`)
      const sets = scalar(setsCell, 1, 1000, `${label}, Serie`)
      const restSeconds = scalar(rest, 0, 86400, `${label}, Recupero (s)`)
      if (Boolean(reps.text) === Boolean(duration.text)) error(reps.id, `${label}: compila solo Ripetizioni oppure Durata (s), una delle due è obbligatoria.`)
      let repsMin: number | null = null, repsMax: number | null = null, durationSeconds: number | null = null
      if (reps.text) {
        const match = /^(\d+)(?:[-–](\d+))?$/.exec(reps.text)
        repsMin = match ? Number(match[1]) : Number.NaN; repsMax = match ? Number(match[2] ?? match[1]) : Number.NaN
        if (!Number.isSafeInteger(repsMin) || !Number.isSafeInteger(repsMax) || repsMin < 1 || repsMax > 10000 || repsMin > repsMax) error(reps.id, `${label}, Ripetizioni: intero positivo o intervallo crescente (es. 8-10), massimo 10000.`)
      } else durationSeconds = scalar(duration, 1, 86400, `${label}, Durata (s)`)
      const mode = reps.text ? 'reps' : 'seconds'
      const key = identityKey(name.text, mode)
      let choice = draft.choices[key]
      if (!choice || exerciseChoiceValues(choice).measurementMode !== mode || normalizeExerciseName(exerciseChoiceValues(choice).name) !== normalizeExerciseName(name.text)) {
        const candidates = structuredCandidates(name.text, mode, catalog)
        if (candidates.length === 1) choice = candidates[0]!.choice
        else if (candidates.length > 1) { error(name.id, `${label}, Esercizio: più identità compatibili; scegli dal catalogo.`); choice = undefined }
        else choice = { source: 'new', localKey: `new:${id(`exercise:${key}`)}`, values: { name: name.text, variant: '', equipment: '', measurementMode: mode, perSide: false, loadUnit: 'kg', loadConvention: 'total', note: '' } }
      }
      const ref = choice?.source === 'existing' ? choice.personalId : id(`exercise:${key}`)
      if (choice && !resolved.catalog.some(b => b.ref === ref)) resolved.catalog.push({ ref, choice })
      let day = resolved.days.find(d => d.label === session.text)
      if (!day) { day = { id: id(`day:${session.text}`), label: session.text, title: session.text, note: '', prescriptions: [] }; resolved.days.push(day) }
      day.prescriptions.push({ id: id(row.id), exerciseRef: ref, sets, optionalSets: 0, repsMin, repsMax, durationSeconds, restSeconds, rir: null, rpe: null, note: note.text })
    }
    command = { requestId: id('request'), payload: { protocolVersion: IMPORT_COMMIT_PROTOCOL_VERSION, mode: 'create_new', kind: 'workout', resolved }, provenance: provenance(draft), selectionOptions: { follow, expectedActiveRevision: follow ? revision : null } }
  } else {
    const resolved: ResolvedDietImport = { plan: { id: id('plan'), name: draft.title.text, document: { guidance, days: [] } } }
    for (const row of rows('Giornate')) {
      const [name, type] = row.cells as [Cell, Cell]
      checkText(name, 120, true, `Giornate riga ${row.number}, Giorno`)
      const types = { Palestra: 'training', Riposo: 'rest', Qualsiasi: 'any' } as const
      if (!Object.hasOwn(types, type.text)) error(type.id, `Giornate riga ${row.number}, Tipo: usa Palestra, Riposo o Qualsiasi.`)
      if (resolved.plan.document.days.some(d => d.name === name.text)) error(name.id, `Giornate riga ${row.number}: giorno ripetuto.`)
      resolved.plan.document.days.push({ id: id(row.id), name: name.text, dayType: types[type.text as keyof typeof types] ?? 'any', note: '', meals: [] })
    }
    for (const row of rows('Alimenti')) {
      const [dayName, mealName, food, quantity, note] = row.cells as [Cell, Cell, Cell, Cell, Cell]
      checkText(mealName, 120, true, `Alimenti riga ${row.number}, Pasto`); checkText(food, 200, true, `Alimenti riga ${row.number}, Alimento`)
      checkText(quantity, 60, false, `Alimenti riga ${row.number}, Quantità`); checkText(note, 4000, false, `Alimenti riga ${row.number}, Note`)
      const day = resolved.plan.document.days.find(d => d.name === dayName.text)
      if (!day) { error(dayName.id, `Alimenti riga ${row.number}, Giorno: non presente nella tabella Giornate.`); continue }
      let meal = day.meals.find(m => m.name === mealName.text)
      if (!meal) { meal = { id: id(`meal:${day.id}:${mealName.text}`), name: mealName.text, time: '', foods: [], alternatives: [], additions: [], note: '' }; day.meals.push(meal) }
      meal.foods.push({ name: food.text, quantity: quantity.text })
      if (note.text) meal.note += `${meal.note ? '\n' : ''}${food.text}: ${note.text}`
      if ([...meal.note].length > 4000) error(note.id, `Alimenti riga ${row.number}, Note: il totale delle note del pasto supera 4000 caratteri.`)
    }
    for (const section of ['Alternative', 'Aggiunte'] as const) for (const row of rows(section)) {
      const [dayName, mealName, text] = row.cells as [Cell, Cell, Cell]
      checkText(text, 500, true, `${section} riga ${row.number}, Testo`)
      const meal = resolved.plan.document.days.find(d => d.name === dayName.text)?.meals.find(m => m.name === mealName.text)
      if (!meal) error(dayName.id, `${section} riga ${row.number}: Giorno/Pasto non presenti nella tabella Alimenti.`)
      else meal[section === 'Alternative' ? 'alternatives' : 'additions'].push(text.text)
    }
    command = { requestId: id('request'), payload: { protocolVersion: IMPORT_COMMIT_PROTOCOL_VERSION, mode: 'create_new', kind: 'diet', resolved }, provenance: provenance(draft), selectionOptions: { follow, expectedActiveRevision: follow ? revision : null } }
  }
  if (!problems.length) {
    const checked = validateCommitCommand(draft.kind, command)
    if (!checked.ok) checked.errors.forEach(e => error(null, `Limite del piano (${e.path}): ${e.message}`))
  }
  return { command: problems.length ? null : command, preview: command.payload, problems }
}
function provenance(draft: StructuredDraft): CommitCommand['provenance'] {
  // Questi non sono puntatori a un DTO LLM: localId è il vero ID del blocco/cella.
  // La fonte completa e gli edit restano nel journal locale; la ricevuta conserva hash e ID.
  const items: CommitCommand['provenance']['items'] = [draft.title, ...draft.tables.flatMap(t => t.rows.flatMap(r => r.cells))].map(cell => ({ localId: cell.id, targetId: null, sourcePointer: null, decisions: cell.text !== (draft.document.blocks.find(b => b.id === cell.id)?.text ?? '').replace(cell.id === draft.title.id ? /^Titolo:\s*/ : /$^/, '') ? [{ field: 'text', reason: 'user_edit' }] : [] }))
  for (const row of draft.tables.find(t => t.section === 'Allenamento')?.rows ?? []) {
    const choice = draft.choices[identityKey(row.cells[1]!.text, row.cells[3]!.text ? 'reps' : 'seconds')]
    if (choice) items.find(item => item.localId === row.cells[1]!.id)!.decisions.push({ field: 'exerciseChoice', reason: choice.source === 'new' ? 'user_edit' : 'catalog_choice' })
  }
  return { formatVersion: IMPORT_PROVENANCE_FORMAT, kind: draft.kind,
    analysis: { jobId: null, proposalId: draft.proposalId, proposalVersion: 1, schemaId: extractionSchemaIds[draft.kind], source: { sourceHash: draft.document.sourceHash, readerVersion: `${draft.document.readerVersion}+${STRUCTURED_VERSION}`, textNormalizationVersion: TEXT_NORMALIZATION_VERSION } },
    items }
}
