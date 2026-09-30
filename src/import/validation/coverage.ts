/**
 * Copertura della fonte (specifica §7.3). Il reader inventaria blocchi, righe e problemi di lettura;
 * qui si cercano le parti potenzialmente pertinenti che la proposta non collega. Euristiche dichiarate,
 * mai una percentuale di completezza:
 * - unità di copertura: ogni blocco con testo, ma una riga di tabella vale una volta con le sue celle
 *   (una cella citata copre la riga e viceversa); la prima riga di una tabella senza cifre è intestazione;
 * - un blocco è collegato se una citazione verificata di un valore lo indica, o se compare nei
 *   `sourceRefs` di regole, problemi o contenuti non assegnati (relazioni molti-a-molti ammesse);
 * - pagina (documenti con più pagine) o sezione sotto un titolo senza alcun collegamento → un solo
 *   problema per l'intera parte; altrimenti un problema per blocco con numeri, un avviso per il testo;
 * - parole di fasi, progressioni, superserie (scheda) o di alternative e aggiunte (dieta) in un blocco non
 *   collegato alle regole o ai campi corrispondenti → da confermare anche se il blocco è citato altrove;
 * - i problemi di lettura restano visibili anche senza blocchi (pagina scansionata, immagine);
 * - `unassigned` copre il blocco ma chiede una scelta, salvo `other_domain` in un documento misto.
 */
import type { ExtractionKind, ReadingIssue, SourceBlock, UnassignedContent } from '../contracts/index.ts'
import { isSuspiciousText, type SourceIndex } from './evidence.ts'
import { finding, type RuleItem, type ValidationFinding, type ValidationIssueCode } from './issues.ts'

/** Classificazione applicativa dei codici dei reader (docxReadingIssueCodes, pdfReadingIssueCodes e noti del contratto). */
export const readingIssueClasses: Readonly<Record<string, ValidationIssueCode>> = {
  no_text_layer: 'source_not_read', empty_page: 'source_not_read', image_without_text: 'source_not_read', unreadable_text: 'source_not_read',
  component_not_read: 'source_not_read', damaged_page: 'source_not_read', damaged_part: 'source_not_read', unsupported_content: 'source_not_read',
  empty_body: 'source_not_read', tracked_changes: 'source_not_read',
  // Parti escluse per scelta dall'analisi (22): vanno confermate come fuori dal piano, mai ignorate.
  excluded_by_user: 'source_not_read',
  hidden_text: 'source_hidden_content',
  reading_order_uncertain: 'reading_uncertain', misaligned_numbers: 'reading_uncertain', overlapping_text: 'reading_uncertain',
  merged_cell_text: 'reading_note', table_structure: 'reading_note', table_continuation: 'reading_note', contact_data_removed: 'reading_note',
  shared_note: 'reading_note', header_footer_scope: 'reading_note',
}
const readingMessages: Partial<Record<ValidationIssueCode, string>> = {
  source_not_read: 'Una parte della fonte non è stata letta',
  source_hidden_content: 'Testo nascosto escluso dalla lettura',
  reading_uncertain: 'Lettura incerta: la riga o la colonna di alcuni valori potrebbe non essere quella giusta',
  reading_note: 'Avviso di lettura',
}

const COMPLEX_WORDS = /\b(fase|fasi|settiman[ae]\s*\d|scarico|deload|progression\w*|progressiv\w*|superseri\w*|superset|circuit\w*|giant set|triseri\w*|drop[- ]?set|piramid\w*|mesocicl\w*|microcicl\w*)\b/i
const ALTERNATIVE_WORDS = /\b(oppure|in alternativa|alternativ\w*|sostitu\w*|opzione|in cambio)\b|→|⇄/i
const ADDITION_WORDS = /\b(aggiung\w*|in più|extra|solo se|nei giorni di|se ti alleni|se ci si allena)\b|dopo l[’']allenamento/i

export interface CoverageInput {
  kind: ExtractionKind
  index: SourceIndex
  root: RuleItem
  /** Blocco → campi che lo citano con una prova verificata (`exercises.sets`, `meals.alternatives`…). */
  citedBy: ReadonlyMap<string, ReadonlySet<string>>
  /** Blocchi indicati dalle regole (complexRules / globalRules). */
  ruleRefs: ReadonlySet<string>
  /** Blocchi indicati da problemi e contenuti non assegnati dell'interprete. */
  modelRefs: ReadonlySet<string>
  unassigned: readonly UnassignedContent[]
}

const MAX_REFS = 20

export function coverageFindings(input: CoverageInput): ValidationFinding[] {
  const { kind, index, root, citedBy, ruleRefs, modelRefs } = input
  const out: ValidationFinding[] = []
  const document = index.document

  // Problemi di lettura: sempre visibili, anche senza blocchi collegati.
  for (const issue of document.readingIssues as ReadingIssue[]) {
    const code = readingIssueClasses[issue.code] ?? 'reading_uncertain'
    const refs = issue.sourceRefs.filter(id => index.blocks.has(id))
    const pages = [...new Set(refs.map(id => index.blocks.get(id)!.page).filter((page): page is number => page !== null))]
    out.push(finding(code, root, null, `${readingMessages[code] ?? 'Avviso di lettura'} (${issue.code}${pages.length ? `, pagina ${pages.join(', ')}` : ''}).`, { refs }))
  }
  for (const block of document.blocks) {
    if (isSuspiciousText(block.text)) out.push(finding('suspicious_source_text', root, null, 'Il documento contiene testo che sembra un’istruzione per l’interprete: trattato solo come dato.', { refs: [block.id] }))
  }
  for (const entry of input.unassigned) {
    const refs = entry.sourceRefs.filter(id => index.blocks.has(id))
    out.push(entry.reason === 'other_domain'
      ? finding('other_domain_content', root, null, `Contenuto dell’altro dominio lasciato fuori (${kind === 'workout' ? 'dieta' : 'scheda'}).`, { refs })
      : finding('unassigned_content', root, null, entry.reason === 'unclear_scope' ? 'Contenuto con ambito non chiaro: decidere se appartiene al piano.' : 'Contenuto con una struttura non rappresentabile: decidere come gestirlo.', { refs }))
  }

  // Unità di copertura.
  const firstRows = new Map<string, string>()
  for (const block of document.blocks) if (block.kind === 'table_row' && block.tableId !== null && !firstRows.has(block.tableId)) firstRows.set(block.tableId, block.id)
  const headerLike = (block: SourceBlock) => {
    const row = index.rowOf(block)
    return row !== null && row.tableId !== null && !/\d/.test(row.text) && firstRows.get(row.tableId) === row.id
  }
  const units = document.blocks.filter(block => block.text !== '' && !(block.kind === 'table_cell' && index.rowOf(block)) && !headerLike(block))
  const covered = (block: SourceBlock) => index.family(block).some(id => citedBy.has(id) || ruleRefs.has(id) || modelRefs.has(id))
  const handled = new Set<string>()

  const pages = new Map<number, SourceBlock[]>()
  for (const unit of units) if (unit.page !== null) pages.set(unit.page, [...pages.get(unit.page) ?? [], unit])
  if (pages.size > 1) {
    for (const [page, list] of [...pages.entries()].sort((a, b) => a[0] - b[0])) {
      if (list.some(covered)) continue
      out.push(finding('page_not_covered', root, null, `Pagina ${page}: nessun contenuto collegato alla proposta.`, { refs: list.slice(0, MAX_REFS).map(block => block.id) }))
      list.forEach(block => handled.add(block.id))
    }
  }
  for (const heading of units.filter(block => block.kind === 'heading')) {
    if (handled.has(heading.id) || covered(heading)) continue
    const below = units.filter(unit => unit.id !== heading.id && unit.headingIds.includes(heading.id))
    if (!below.length || below.some(covered)) continue
    out.push(finding('section_not_covered', root, null, `Sezione «${heading.text.slice(0, 80)}»: nessun contenuto collegato alla proposta.`, { refs: [heading.id, ...below.slice(0, MAX_REFS - 1).map(block => block.id)] }))
    handled.add(heading.id)
    below.forEach(block => handled.add(block.id))
  }
  for (const unit of units) {
    if (handled.has(unit.id) || unit.kind === 'heading' || covered(unit)) continue
    out.push(/\d/.test(unit.text)
      ? finding('uncovered_numeric_content', root, null, `Blocco con numeri non collegato alla proposta: «${unit.text.slice(0, 80)}».`, { refs: [unit.id] })
      : finding('uncovered_text', root, null, `Testo non collegato alla proposta: «${unit.text.slice(0, 80)}».`, { refs: [unit.id] }))
  }

  // Punti comuni di omissione: regole complesse, alternative, aggiunte.
  const fieldsOf = (block: SourceBlock) => new Set(index.family(block).flatMap(id => [...citedBy.get(id) ?? []]))
  const inRules = (block: SourceBlock) => index.family(block).some(id => ruleRefs.has(id))
  for (const unit of units) {
    if (unit.kind === 'heading') continue
    const fields = fieldsOf(unit)
    if (kind === 'workout') {
      if (COMPLEX_WORDS.test(unit.text) && !inRules(unit) && !fields.has('complexRules.text')) {
        out.push(finding('complex_rule_not_extracted', root, null, `Fase, progressione o gruppo di esercizi non riportato fra le regole: «${unit.text.slice(0, 80)}».`, { refs: [unit.id] }))
      }
    } else {
      if (ALTERNATIVE_WORDS.test(unit.text) && !inRules(unit) && !fields.has('meals.alternatives')) {
        out.push(finding('alternative_not_extracted', root, null, `Alternativa o sostituzione non riportata: «${unit.text.slice(0, 80)}».`, { refs: [unit.id] }))
      }
      if (ADDITION_WORDS.test(unit.text) && !inRules(unit) && !fields.has('meals.additions')) {
        out.push(finding('addition_not_extracted', root, null, `Aggiunta o condizione non riportata: «${unit.text.slice(0, 80)}».`, { refs: [unit.id] }))
      }
    }
  }
  return out
}
