/**
 * Validazione semantica dell'estrazione (task 06, specifica §4.6): trasforma una proposta
 * strutturalmente valida in una bozza con problemi osservabili, oppure la rifiuta prima della bozza.
 * Ordine: documento e schema (rifiuto) → esito dell'interprete (rifiuto) → relazioni fra campi →
 * prove e contesto → copertura → limiti del dominio; i problemi dell'interprete vengono per ultimi e
 * solo dove nessuna regola applicativa li copre già. Nucleo puro, stesso modulo per Node, browser e
 * Deno (ponte `supabase/functions/_shared/import/validation.ts`): il server valida il documento
 * normalizzato ricevuto, non può certificare i byte originali rimasti sul dispositivo.
 *
 * Due ingressi distinti:
 * - `validateProposal`: l'estrazione originale del modello (server e browser, prima della bozza);
 * - `validateDraft`: la bozza corrente (07). Le relazioni e i limiti girano sui valori correnti; i problemi
 *   di prova valgono solo per i campi ancora uguali alla proposta: un valore scelto dall'utente non
 *   riceve citazioni finte, e resta tracciato come decisione.
 */
import {
  domainLimits, enumerateProposalItems, normalizeSourceText, parseJson, reviewValueSchemas, sameJsonValue, validateExtraction,
  validateNormalizedDocument,
  type ContractError, type ExtractionFor, type ExtractionIssue, type ExtractionKind, type NormalizedDocument, type ReviewCollection,
  type ReviewDraft, type ValidationIssue,
} from '../contracts/index.ts'
import { objectFields } from '../contracts/schema.ts'
import { coverageFindings } from './coverage.ts'
import { dietRuleFindings, dietSourceFindings } from './diet.ts'
import {
  collectEvidence, fieldUnits, indexSource, isSuspiciousText, parentPointer, pointerTokens, quoteOffsets, resolvePointer, textInQuotes,
  type SourceIndex, type UnitEvidence,
} from './evidence.ts'
import { finding, FindingList, type RuleItem, type ValidationFinding, type ValidationIssueCode } from './issues.ts'
import { dietDocumentBytesFinding, dietLimitFindings, workoutLimitFindings } from './limits.ts'
import { workoutRuleFindings, workoutSourceFindings, type FieldOrigin } from './workout.ts'

export { issueCatalog, validationIssueCodes, type RuleItem, type ValidationFinding, type ValidationIssueCode } from './issues.ts'
export { readingIssueClasses } from './coverage.ts'
export { pointerTokens, resolvePointer } from './evidence.ts'

export const VALIDATION_RULES_VERSION = 'peppitness.import-validation.v1'

// ---------------------------------------------------------------------------
// Risultati
// ---------------------------------------------------------------------------

/**
 * Motivi di rifiuto prima della bozza: forma o versione sconosciuta, dominio sbagliato, esito dichiarato
 * senza contenuto (o con contenuto inventato), documento vuoto o non valido. Un JSON troncato è
 * `invalid_json`, distinto da una forma violata.
 */
export const rejectionReasons = [
  'invalid_document', 'empty_document', 'invalid_json', 'invalid_shape', 'kind_mismatch', 'unsupported_version',
  'wrong_document_type', 'no_relevant_content', 'unreadable', 'outcome_mismatch',
] as const
export type RejectionReason = typeof rejectionReasons[number]

/** Origine di un valore per la revisione: «Dal documento», «Convertito da minuti», «Regola generale», «Modificato da te». */
export interface FieldProvenance {
  localId: string | null
  sourcePath: string | null
  field: string
  origin: FieldOrigin | 'user'
  rule: string | null
  sourceRefs: string[]
}

export type ProposalValidation<K extends ExtractionKind> =
  | { status: 'draft'; kind: K; extraction: ExtractionFor<K>; issues: ValidationIssue[]; findings: ValidationFinding[]; provenance: FieldProvenance[] }
  | { status: 'rejected'; kind: K; reason: RejectionReason; errors: ContractError[] }

export interface DraftValidation { issues: ValidationIssue[]; findings: ValidationFinding[]; provenance: FieldProvenance[] }

// ---------------------------------------------------------------------------
// Elementi
// ---------------------------------------------------------------------------

const fieldNames = (kind: ExtractionKind, collection: ReviewCollection) =>
  [...objectFields((reviewValueSchemas[kind] as Record<string, Parameters<typeof objectFields>[0]>)[collection]!).keys()]

/** Elementi della proposta immutabile, in ordine di fonte, con chiave = puntatore. */
export function proposalRuleItems(extraction: ExtractionFor<ExtractionKind>): RuleItem[] {
  return enumerateProposalItems(extraction).map(entry => {
    const source = (resolvePointer(extraction, entry.pointer) as { value: Record<string, unknown> }).value
    const values = Object.fromEntries(fieldNames(extraction.kind, entry.collection).map(field => [field, source[field]]))
    return { key: entry.pointer, localId: null, pointer: entry.pointer, collection: entry.collection, parentKey: entry.parentPointer, values, catalog: null, userFields: new Set<string>() }
  })
}

/** Elementi della bozza corrente: i campi diversi dalla proposta (o di un elemento aggiunto) sono dell'utente. */
export function draftRuleItems(draft: ReviewDraft, proposal: readonly RuleItem[] = proposalRuleItems(draft.proposal.extraction)): RuleItem[] {
  const pointerOf = new Map(draft.localIds.map(entry => [entry.localId, entry.pointer]))
  const original = new Map(proposal.map(item => [item.pointer, item]))
  return (draft.current as readonly ReviewDraft['current'][number][]).map(item => {
    const pointer = pointerOf.get(item.localId) ?? null
    const base = pointer === null ? undefined : original.get(pointer)
    const values = item.values as Record<string, unknown>
    const userFields = new Set(Object.keys(values).filter(field => !base || !sameJsonValue(values[field] as never, base.values[field] as never)))
    return {
      key: item.localId, localId: item.localId, pointer, collection: item.collection, parentKey: item.parentLocalId, values,
      catalog: 'catalog' in item ? item.catalog : null, userFields,
    }
  })
}

function childrenOf(items: readonly RuleItem[]) {
  const map = new Map<string, RuleItem[]>()
  for (const item of items) if (item.parentKey !== null) {
    const key = `${item.parentKey}\u0000${item.collection}`
    map.set(key, [...map.get(key) ?? [], item])
  }
  return (key: string, collection: string) => map.get(`${key}\u0000${collection}`) ?? []
}

// ---------------------------------------------------------------------------
// Criticità dei campi
// ---------------------------------------------------------------------------

/** Valori prescrittivi e istruzioni: senza riscontro bloccano; gli altri chiedono conferma. */
const criticalFields: Record<ExtractionKind, Partial<Record<ReviewCollection, readonly string[]>>> = {
  workout: {
    root: ['guidance', 'cycle'], sessions: ['notes'], complexRules: ['text'],
    exercises: ['name', 'sets', 'optionalSets', 'repetitions', 'durationSeconds', 'restSeconds', 'rir', 'rpe', 'perSide', 'loadInstruction', 'tempoInstruction', 'notes'],
  },
  diet: { root: ['guidance'], days: ['notes'], meals: ['alternatives', 'additions', 'notes'], foods: ['name', 'quantityText', 'notes'], globalRules: ['text'] },
}
/** Testi liberi confrontati con le citazioni (le enumerazioni hanno verifiche proprie). */
const freeTextFields: Record<ExtractionKind, Partial<Record<ReviewCollection, readonly string[]>>> = {
  workout: {
    root: ['title', 'guidance'], sessions: ['label', 'title', 'notes'], complexRules: ['text'],
    exercises: ['name', 'variant', 'equipment', 'loadInstruction', 'tempoInstruction', 'prescriptionText', 'notes'],
  },
  diet: {
    root: ['title', 'guidance'], days: ['name', 'notes'], meals: ['name', 'timeText', 'alternatives', 'additions', 'notes'],
    foods: ['name', 'quantityText', 'notes'], globalRules: ['text'],
  },
}
const has = (table: Partial<Record<ReviewCollection, readonly string[]>>, collection: ReviewCollection, field: string) => table[collection]?.includes(field) ?? false
const clip = (text: string, max = 80) => text.length > max ? `${text.slice(0, max)}…` : text
/** Valore leggibile nei messaggi: testo fra virgolette, numeri e intervalli, sì/no. */
function describe(value: unknown): string {
  if (typeof value === 'string') return `«${clip(value)}»`
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '«sì»' : '«no»'
  if (value !== null && typeof value === 'object' && 'min' in value && 'max' in value) {
    const { min, max } = value as { min: number; max: number }
    return min === max ? String(min) : `${min}–${max}`
  }
  return ''
}

// ---------------------------------------------------------------------------
// Analisi della proposta sulla fonte
// ---------------------------------------------------------------------------

interface SourceAnalysis {
  findings: ValidationFinding[]
  coverage: ValidationFinding[]
  model: ValidationFinding[]
  provenance: FieldProvenance[]
  itemPointers: ReadonlySet<string>
}

function evidenceFindings(kind: ExtractionKind, units: ReadonlyMap<string, UnitEvidence>, index: SourceIndex): ValidationFinding[] {
  const out: ValidationFinding[] = []
  for (const entry of units.values()) {
    const { item, field, path, value } = entry.unit
    const critical = has(criticalFields[kind], item.collection, field)
    const invalidRefs = entry.invalid.map(span => span.blockId).filter(id => index.blocks.has(id))
    // Le regole portano le proprie fonti: senza citazione, il testo deve comparire in uno dei blocchi indicati.
    if (!entry.cited && field === 'text' && (item.collection === 'complexRules' || item.collection === 'globalRules') && typeof value === 'string') {
      for (const id of item.values.sourceRefs as string[]) {
        const block = index.blocks.get(id)
        const found = block ? quoteOffsets(block.text, value) : null
        if (block && found && found.offsets.length) entry.spans.push({ blockId: id, quote: found.quote, block, offsets: found.offsets })
      }
    }
    const shown = describe(value)
    if (!entry.spans.length) {
      const reason = entry.cited ? 'le citazioni non compaiono nei blocchi indicati' : 'nessuna citazione della fonte'
      out.push(critical
        ? finding(entry.cited ? 'quote_not_found' : 'missing_evidence', item, field, `Valore ${shown} senza riscontro: ${reason}.`, { refs: invalidRefs, path })
        : finding('unverified_detail', item, field, `Dettaglio ${shown} senza riscontro: ${reason}.`, { refs: invalidRefs, path }))
      continue
    }
    const refs = entry.spans.map(span => span.blockId)
    if (entry.invalid.length) out.push(finding('extra_quote_not_found', item, field, `Citazione non trovata: «${clip(entry.invalid[0]!.quote)}».`, { refs: [...refs, ...invalidRefs], path }))
    const suspicious = entry.spans.filter(span => isSuspiciousText(span.block.text))
    if (suspicious.length) out.push(finding('evidence_from_suspicious_text', item, field, 'Valore ricavato da un testo che si rivolge all’interprete.', { refs: suspicious.map(span => span.blockId), path }))
    if (typeof value === 'string' && has(freeTextFields[kind], item.collection, field) && !textInQuotes(value, entry.spans)) {
      out.push(critical
        ? finding('text_not_in_quote', item, field, `Il testo ${shown} non coincide con quanto citato: niente completamenti o riformulazioni.`, { refs, path })
        : finding('unverified_detail', item, field, `Il testo ${shown} non coincide con quanto citato.`, { refs, path }))
    }
  }
  return out
}

const modelCodes: Record<ExtractionIssue['code'], ValidationIssueCode> = {
  missing: 'model_reported_missing', ambiguous: 'model_reported_ambiguous', conflicting: 'model_reported_conflict',
  unreadable: 'model_reported_unreadable', unsupported: 'model_reported_unsupported',
}

function locate(pointer: string, pointers: ReadonlySet<string>): string {
  for (let path: string | null = pointer; path !== null; path = parentPointer(path)) if (pointers.has(path)) return path
  return ''
}

function analyzeSource(kind: ExtractionKind, index: SourceIndex, extraction: ExtractionFor<ExtractionKind>, items: readonly RuleItem[]): SourceAnalysis {
  const itemPointers = new Set(items.map(item => item.pointer!))
  const byPointer = new Map(items.map(item => [item.pointer!, item]))
  const root = byPointer.get('')!
  const children = childrenOf(items)
  const units = fieldUnits(items)
  const { byPath, problems } = collectEvidence(extraction, units, itemPointers, index)

  const findings: ValidationFinding[] = []
  for (const problem of problems) {
    const code = problem.kind === 'dangling_path' ? 'evidence_dangling_path' : problem.kind === 'for_null' ? 'evidence_for_null' : 'evidence_too_coarse'
    findings.push(finding(code, root, null, `Citazione per «${clip(problem.path)}»: ${problem.kind === 'dangling_path' ? 'il campo non esiste' : problem.kind === 'for_null' ? 'il campo è vuoto' : 'indica un elemento intero, non un campo'}.`, { refs: problem.refs }))
  }
  findings.push(...evidenceFindings(kind, byPath, index))
  const source = kind === 'workout'
    ? workoutSourceFindings({ index, items, children, evidence: byPath })
    : dietSourceFindings({ index, items, children, evidence: byPath })
  findings.push(...source.findings)

  // Riferimenti delle regole, dei problemi e dei contenuti non assegnati.
  const refLists: { refs: readonly string[]; item: RuleItem; label: string }[] = [
    ...extraction.issues.map((issue, position) => ({ refs: issue.sourceRefs, item: root, label: `problema ${position + 1} dell’interprete` })),
    ...extraction.unassigned.map((entry, position) => ({ refs: entry.sourceRefs, item: root, label: `contenuto non assegnato ${position + 1}` })),
    ...items.filter(item => item.collection === 'complexRules' || item.collection === 'globalRules').map(item => ({ refs: item.values.sourceRefs as string[], item, label: 'regola' })),
  ]
  for (const { refs, item, label } of refLists) {
    const unknown = refs.filter(id => !index.blocks.has(id))
    if (unknown.length) findings.push(finding('dangling_source_ref', item, null, `Riferimento a blocchi inesistenti (${label}): ${unknown.slice(0, 5).join(', ')}.`))
    if (new Set(refs).size !== refs.length) findings.push(finding('duplicate_source_ref', item, null, `Riferimenti ripetuti (${label}).`, { refs: refs.filter(id => index.blocks.has(id)) }))
  }
  if (kind === 'workout') {
    for (const rule of items.filter(item => item.collection === 'complexRules')) {
      const targets = rule.values.targetPaths as string[]
      const missing = targets.filter(path => { const item = byPointer.get(path); return !item || (item.collection !== 'sessions' && item.collection !== 'exercises') })
      if (missing.length) findings.push(finding('rule_target_unresolved', rule, null, `La regola indica elementi inesistenti: ${missing.slice(0, 5).join(', ')}.`, { refs: (rule.values.sourceRefs as string[]).filter(id => index.blocks.has(id)) }))
    }
  }

  // Copertura.
  const citedBy = new Map<string, Set<string>>()
  for (const entry of byPath.values()) for (const span of entry.spans) {
    const set = citedBy.get(span.blockId) ?? new Set<string>()
    set.add(`${entry.unit.item.collection}.${entry.unit.field}`)
    citedBy.set(span.blockId, set)
  }
  const ruleRefs = new Set(items.filter(item => item.collection === 'complexRules' || item.collection === 'globalRules').flatMap(item => item.values.sourceRefs as string[]))
  const modelRefs = new Set([...extraction.issues.flatMap(issue => issue.sourceRefs), ...extraction.unassigned.flatMap(entry => entry.sourceRefs)])
  const coverage = coverageFindings({ kind, index, root, citedBy, ruleRefs, modelRefs, unassigned: extraction.unassigned })

  // Segnalazioni dell'interprete: la classificazione resta applicativa.
  const model = extraction.issues.map(issue => {
    const path = resolvePointer(extraction, issue.path).found ? issue.path : ''
    const item = byPointer.get(locate(path, itemPointers))!
    const token = pointerTokens(path)?.[pointerTokens(item.pointer!)!.length] ?? null
    const field = token !== null && Object.hasOwn(item.values, token) ? token : null
    const text = normalizeSourceText(issue.message)
    return finding(modelCodes[issue.code], item, field, `Segnalazione dell’interprete: ${text === '' ? issue.code : clip(text, 300)}`, { refs: issue.sourceRefs.filter(id => index.blocks.has(id)), path: field === null ? undefined : path })
  })

  // Origine dei valori verificati senza problemi di prova.
  const blocked = new Set(findings.filter(entry => entry.issue.severity !== 'info').map(entry => `${entry.issue.sourcePath}`))
  const provenance: FieldProvenance[] = []
  for (const entry of byPath.values()) {
    if (!entry.spans.length || blocked.has(entry.unit.path) || blocked.has(`${entry.unit.item.pointer}/${entry.unit.field}`)) continue
    const origin = source.origins.get(entry.unit.path)
    provenance.push({
      localId: null, sourcePath: entry.unit.path, field: entry.unit.field, origin: origin?.origin ?? 'source', rule: origin?.rule ?? null,
      sourceRefs: [...new Set(entry.spans.map(span => span.blockId))],
    })
  }
  return { findings, coverage, model, provenance, itemPointers }
}

/** Le segnalazioni dell'interprete compaiono solo dove nessuna regola applicativa ha già un problema sullo stesso campo o blocco. */
function mergeModel(target: FindingList, model: readonly ValidationFinding[], itemPointers: ReadonlySet<string>) {
  const itemOf = (entry: ValidationFinding) => entry.issue.localId ?? locate(entry.issue.sourcePath ?? '', itemPointers)
  const fields = new Set(target.items.filter(entry => entry.field !== null).map(entry => `${itemOf(entry)}\u0000${entry.field}`))
  for (const entry of model) {
    const item = itemOf(entry)
    if (entry.field !== null) {
      if (fields.has(`${item}\u0000${entry.field}`)) continue
    } else {
      const refs = new Set(entry.issue.sourceRefs)
      const covered = target.items.some(other => other.field === null && other.issue.severity !== 'info' && itemOf(other) === item
        && (other.issue.sourceRefs.some(id => refs.has(id)) || (refs.size === 0 && other.issue.code === 'source_not_read')))
      if (covered) continue
    }
    target.add(entry)
  }
}

// ---------------------------------------------------------------------------
// Relazioni e limiti sui valori correnti
// ---------------------------------------------------------------------------

function valueFindings(kind: ExtractionKind, items: readonly RuleItem[]): { relations: ValidationFinding[]; limits: ValidationFinding[] } {
  const children = childrenOf(items)
  const root = items.find(item => item.collection === 'root')!
  if (kind === 'workout') {
    const relations = workoutRuleFindings(items, children, domainLimits.workout.cycleStart)
    const rules = children(root.key, 'complexRules').map(rule => String(rule.values.text ?? ''))
    const limits = items.flatMap(item => workoutLimitFindings(item, {
      sessions: children(item.key, 'sessions').length, exercises: children(item.key, 'exercises').length, rules,
    }))
    return { relations, limits }
  }
  const relations = dietRuleFindings(items, children)
  const rules = children(root.key, 'globalRules').map(rule => String(rule.values.text ?? ''))
  const limits = items.flatMap(item => dietLimitFindings(item, {
    days: children(item.key, 'days').length, meals: children(item.key, 'meals').length, foods: children(item.key, 'foods').length, rules,
    foodNotes: children(item.key, 'foods').flatMap(food => food.values.notes as string[]),
  }))
  const bytes = dietDocumentBytesFinding(root, items)
  if (bytes) limits.push(bytes)
  return { relations, limits }
}

// ---------------------------------------------------------------------------
// Ingressi pubblici
// ---------------------------------------------------------------------------

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const rejected = <K extends ExtractionKind>(kind: K, reason: RejectionReason, errors: ContractError[] = []): ProposalValidation<K> => ({ status: 'rejected', kind, reason, errors })

/**
 * Valida la risposta dell'interprete (oggetto o testo JSON) contro il documento normalizzato ricevuto.
 * `kind` è il dominio scelto dall'utente: un DTO dell'altro dominio è rifiutato, mai reinterpretato.
 */
export function validateProposal<K extends ExtractionKind>(kind: K, document: unknown, proposal: unknown): ProposalValidation<K> {
  const checkedDocument = validateNormalizedDocument(document)
  if (!checkedDocument.ok) return rejected(kind, 'invalid_document', checkedDocument.errors)
  let value = proposal
  if (typeof proposal === 'string') {
    const parsed = parseJson(proposal)
    if (!parsed.ok) return rejected(kind, 'invalid_json', parsed.errors)
    value = parsed.value
  }
  if (isObject(value) && (value.kind === 'workout' || value.kind === 'diet') && value.kind !== kind) return rejected(kind, 'kind_mismatch', [{ path: '/kind', code: 'const', message: `Atteso "${kind}".` }])
  if (isObject(value) && Object.hasOwn(value, 'schemaVersion') && value.schemaVersion !== '1.0') return rejected(kind, 'unsupported_version', [{ path: '/schemaVersion', code: 'const', message: 'Versione dello schema sconosciuta.' }])
  const shape = validateExtraction(kind, value)
  if (!shape.ok) return rejected(kind, 'invalid_shape', shape.errors)
  const extraction = shape.value

  const content = extraction.kind === 'workout'
    ? extraction.sessions.length + extraction.complexRules.length
    : extraction.days.length + extraction.globalRules.length
  const claimed = content > 0 || extraction.title !== null || extraction.guidance.length > 0 || extraction.evidence.length > 0
  if (extraction.outcome !== 'extracted') {
    return claimed
      ? rejected(kind, 'outcome_mismatch', [{ path: '/outcome', code: 'const', message: `Esito «${extraction.outcome}» con contenuto: nessun elemento va inventato per riempire lo schema.` }])
      : rejected(kind, extraction.outcome)
  }
  if (!checkedDocument.value.blocks.some(block => block.text !== '')) return rejected(kind, 'empty_document', [{ path: '/blocks', code: 'too_few_items', message: 'Il documento non contiene testo.' }])

  const index = indexSource(checkedDocument.value)
  const items = proposalRuleItems(extraction)
  const analysis = analyzeSource(kind, index, extraction, items)
  const { relations, limits } = valueFindings(kind, items)
  const list = new FindingList()
  list.addAll(relations)
  list.addAll(analysis.findings)
  list.addAll(analysis.coverage)
  list.addAll(limits)
  mergeModel(list, analysis.model, analysis.itemPointers)
  return { status: 'draft', kind, extraction, issues: list.items.map(entry => entry.issue), findings: list.items, provenance: analysis.provenance }
}

/**
 * Rivaluta la bozza corrente sul documento normalizzato conservato con la bozza. I problemi di prova e
 * di copertura vengono dalla proposta immutabile e restano sugli elementi ancora presenti e sui campi
 * non modificati; relazioni e limiti girano sui valori correnti, scelte del catalogo comprese.
 */
export function validateDraft(document: NormalizedDocument, draft: ReviewDraft): DraftValidation {
  const kind = draft.kind
  const index = indexSource(document)
  const proposal = proposalRuleItems(draft.proposal.extraction)
  const analysis = analyzeSource(kind, index, draft.proposal.extraction, proposal)
  const current = draftRuleItems(draft, proposal)
  const byPointer = new Map(current.filter(item => item.pointer !== null).map(item => [item.pointer!, item]))
  const remap = (entry: ValidationFinding): ValidationFinding | null => {
    const item = byPointer.get(locate(entry.issue.sourcePath ?? '', analysis.itemPointers))
    if (!item || (entry.field !== null && item.userFields.has(entry.field))) return null
    return { field: entry.field, issue: { ...entry.issue, localId: item.localId } }
  }
  const keep = (entries: readonly ValidationFinding[]) => entries.map(remap).filter((entry): entry is ValidationFinding => entry !== null)
  const { relations, limits } = valueFindings(kind, current)
  const list = new FindingList()
  list.addAll(relations)
  list.addAll(keep(analysis.findings))
  list.addAll(keep(analysis.coverage))
  list.addAll(limits)
  mergeModel(list, keep(analysis.model), analysis.itemPointers)

  const provenance: FieldProvenance[] = []
  for (const entry of analysis.provenance) {
    const item = byPointer.get(locate(entry.sourcePath ?? '', analysis.itemPointers))
    if (item && !item.userFields.has(entry.field)) provenance.push({ ...entry, localId: item.localId })
  }
  for (const item of current) for (const field of item.userFields) {
    provenance.push({ localId: item.localId, sourcePath: item.pointer === null ? null : `${item.pointer}/${field}`, field, origin: 'user', rule: null, sourceRefs: [] })
  }
  return { issues: list.items.map(entry => entry.issue), findings: list.items, provenance }
}
