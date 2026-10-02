/**
 * Modello puro delle revisioni d'importazione (task 12/13): prenotazione degli ID tecnici, esito
 * (validazione 06 → mapping 09/10 → prontezza 07), origine dei valori e riferimenti alla fonte per
 * elemento e campo. Nessun DOM, nessuna rete: usato dai componenti e dai test Node. I riferimenti usano
 * sempre l'ID locale, quindi restano corretti dopo riordini e spostamenti.
 */
import type {
  DietReviewDraft, JsonValue, MappingResult, NormalizedDocument, ReviewDecision, ReviewDraft, ReviewItem, ValidationIssue, WorkoutReviewDraft,
} from '../../import/contracts/index.ts'
import { mapReviewedDiet, type DietMapping, type DietMappingIds } from '../../import/mapping/diet.ts'
import { exerciseChoiceKey, mapReviewedWorkout, type WorkoutMapping, type WorkoutMappingIds } from '../../import/mapping/workout.ts'
import { evaluateReadiness, isConfirmed, staleConfirmations, type Readiness } from '../../import/review/decisions.ts'
import { resolvePointer, validateDraft, type DraftValidation, type FieldProvenance, type ValidationFinding } from '../../import/validation/validate.ts'

export type NewId = () => string
const randomId: NewId = () => crypto.randomUUID()

// ---------------------------------------------------------------------------
// Prenotazioni: una sola volta per chiave, mai rigenerate dopo edit o riordino
// ---------------------------------------------------------------------------

/** Aggiunge un ID solo per le chiavi mancanti; restituisce lo stesso oggetto se non manca nulla. */
export function reserveIds(current: Readonly<Record<string, string>>, keys: Iterable<string>, newId: NewId = randomId): Readonly<Record<string, string>> {
  let next: Record<string, string> | null = null
  for (const key of keys) if (!Object.hasOwn(current, key) && !(next && Object.hasOwn(next, key))) {
    next ??= { ...current }
    next[key] = newId()
  }
  return next ?? current
}

/**
 * ID di piano, versione, sedute, prescrizioni e identità shared/new della scheda. Le prenotazioni esistenti
 * restano (anche di elementi rimossi); il mapper non genera ID. Stesso oggetto se non cambia nulla.
 */
export function reserveWorkoutIds(draft: WorkoutReviewDraft, ids: WorkoutMappingIds | null, newId: NewId = randomId): WorkoutMappingIds {
  const base = ids ?? { planId: newId(), versionId: newId(), items: {}, exercises: {} }
  const current = draft.current as readonly ReviewItem[]
  const items = reserveIds(base.items, current.filter(item => item.collection === 'sessions' || item.collection === 'exercises').map(item => item.localId), newId)
  const exercises = reserveIds(base.exercises, current.flatMap(item => item.collection === 'exercises' && item.catalog && item.catalog.source !== 'existing' ? [exerciseChoiceKey(item.catalog)] : []), newId)
  return items === base.items && exercises === base.exercises ? base : { ...base, items, exercises }
}

/** ID del piano alimentare, delle giornate e dei pasti (gli alimenti non hanno ID nel dominio). Stesso oggetto se non cambia nulla. */
export function reserveDietIds(draft: DietReviewDraft, ids: DietMappingIds | null, newId: NewId = randomId): DietMappingIds {
  const base = ids ?? { planId: newId(), items: {} }
  const items = reserveIds(base.items, (draft.current as readonly ReviewItem[]).filter(item => item.collection === 'days' || item.collection === 'meals').map(item => item.localId), newId)
  return items === base.items ? base : { ...base, items }
}

// ---------------------------------------------------------------------------
// Esito della revisione
// ---------------------------------------------------------------------------

export interface ReviewOutcome<T> { validation: DraftValidation; mapping: MappingResult<T>; readiness: Readiness }

/** Stessi dati per anteprima e conferma: validazione 06, mapper 09, prontezza 07 sulla stessa bozza. */
export function workoutReviewOutcome(document: NormalizedDocument, draft: WorkoutReviewDraft, ids: WorkoutMappingIds): ReviewOutcome<WorkoutMapping> {
  const validation = validateDraft(document, draft)
  const mapping = mapReviewedWorkout(document, draft, ids)
  return { validation, mapping, readiness: evaluateReadiness(draft, validation.findings, mapping) }
}

/** Stessi dati per anteprima e conferma: validazione 06, mapper 10, prontezza 07 sulla stessa bozza. */
export function dietReviewOutcome(document: NormalizedDocument, draft: DietReviewDraft, ids: DietMappingIds): ReviewOutcome<DietMapping> {
  const validation = validateDraft(document, draft)
  const mapping = mapReviewedDiet(document, draft, ids)
  return { validation, mapping, readiness: evaluateReadiness(draft, validation.findings, mapping) }
}

/** Problemi del solo mapping: quelli che ripetono un problema aperto della validazione sono già elencati. */
export const mappingOnlyIssues = (mapping: MappingResult<unknown>): ValidationIssue[] =>
  mapping.issues.filter(issue => !issue.code.endsWith('_review_required'))

// ---------------------------------------------------------------------------
// Problemi, origine, fonte
// ---------------------------------------------------------------------------

export type FindingState = 'open' | 'stale' | 'confirmed' | 'info'
const severityRank = { blocking: 0, confirmation: 1, info: 2 } as const
export const byPriority = (a: ValidationFinding, b: ValidationFinding) => severityRank[a.issue.severity] - severityRank[b.issue.severity]

/** Stato di un problema: aperto, da confermare di nuovo (una conferma è stata superata da un edit), confermato. */
export function findingState(draft: ReviewDraft, finding: ValidationFinding, stale = staleConfirmations(draft)): FindingState {
  if (finding.issue.severity === 'info') return 'info'
  if (isConfirmed(draft, finding)) return 'confirmed'
  return stale.some(decision => decision.issueCode === finding.issue.code && decision.localId === finding.issue.localId && decision.field === finding.field) ? 'stale' : 'open'
}

/** Etichetta dell'origine di un valore (specifica §9.2). */
export function originLabel(entry: FieldProvenance | undefined): string | null {
  if (!entry) return null
  if (entry.origin === 'user') return 'Modificato da te'
  if (entry.origin === 'app') return 'Dose base predisposta'
  if (entry.origin === 'inherited') return 'Regola generale'
  if (entry.origin === 'converted') return entry.rule === 'minutes_seconds' ? 'Convertito da minuti e secondi' : 'Convertito da minuti'
  return 'Dal documento'
}

const key = (localId: string | null, field: string | null) => `${localId ?? ''}\u0000${field ?? ''}`

/** Indice per elemento e campo di problemi, origine e blocchi citati. */
export class ReviewIndex {
  readonly findings: readonly ValidationFinding[]
  private readonly provenanceBy = new Map<string, FieldProvenance>()
  private readonly findingsBy = new Map<string, ValidationFinding[]>()
  private readonly itemRefs = new Map<string, Set<string>>()
  private readonly blockUsers = new Map<string, { localId: string; field: string | null }[]>()

  constructor(draft: ReviewDraft, validation: DraftValidation) {
    this.findings = [...validation.findings].sort(byPriority)
    const cite = (localId: string, field: string | null, refs: readonly string[]) => {
      const set = this.itemRefs.get(localId) ?? new Set<string>()
      for (const ref of refs) {
        set.add(ref)
        const users = this.blockUsers.get(ref) ?? []
        if (!users.some(user => user.localId === localId && user.field === field)) users.push({ localId, field })
        this.blockUsers.set(ref, users)
      }
      this.itemRefs.set(localId, set)
    }
    for (const entry of validation.provenance) if (entry.localId !== null) {
      this.provenanceBy.set(key(entry.localId, entry.field), entry)
      cite(entry.localId, entry.field, entry.sourceRefs)
    }
    for (const entry of this.findings) {
      const list = this.findingsBy.get(key(entry.issue.localId, entry.field)) ?? []
      list.push(entry)
      this.findingsBy.set(key(entry.issue.localId, entry.field), list)
      if (entry.issue.localId !== null) cite(entry.issue.localId, entry.field, entry.issue.sourceRefs)
    }
    // Le regole portano le proprie fonti.
    for (const item of draft.current as readonly ReviewItem[]) {
      if (item.collection === 'complexRules' || item.collection === 'globalRules') cite(item.localId, null, (item.values as { sourceRefs: string[] }).sourceRefs)
    }
  }

  provenance(localId: string, field: string) { return this.provenanceBy.get(key(localId, field)) }
  /** Problemi del campo (o dell'intero elemento con `field` null), dal più grave. */
  findingsOf(localId: string, field: string | null): readonly ValidationFinding[] { return this.findingsBy.get(key(localId, field)) ?? [] }
  /** Tutti i problemi di un elemento, campi compresi. */
  itemFindings(localId: string) { return this.findings.filter(entry => entry.issue.localId === localId) }
  /** Blocchi della fonte di un campo (citazioni verificate e blocchi dei suoi problemi), o dell'intero elemento. */
  refs(localId: string, field: string | null): string[] {
    if (field === null) return [...this.itemRefs.get(localId) ?? []]
    const out = new Set(this.provenance(localId, field)?.sourceRefs ?? [])
    for (const entry of this.findingsOf(localId, field)) for (const ref of entry.issue.sourceRefs) out.add(ref)
    return [...out]
  }
  /** Campi e elementi che citano un blocco della fonte. */
  usersOf(blockId: string) { return this.blockUsers.get(blockId) ?? [] }
}

// ---------------------------------------------------------------------------
// Bozza: elementi, valori originali e intervalli
// ---------------------------------------------------------------------------

export const childrenOf = (draft: ReviewDraft, parentLocalId: string, collection: ReviewItem['collection']) =>
  (draft.current as readonly ReviewItem[]).filter(item => item.parentLocalId === parentLocalId && item.collection === collection)
export const rootOf = (draft: ReviewDraft) => (draft.current as readonly ReviewItem[]).find(item => item.collection === 'root')!

/** Valore del campo nella proposta immutabile (undefined per un elemento aggiunto dall'utente). */
export function proposalValue(draft: ReviewDraft, localId: string, field: string): JsonValue | undefined {
  const pointer = draft.localIds.find(entry => entry.localId === localId)?.pointer
  if (pointer === undefined) return undefined
  const found = resolvePointer(draft.proposal.extraction, pointer)
  return found.found ? (found.value as Record<string, JsonValue>)[field] : undefined
}

export interface Range { min: number; max: number }
export const isRange = (value: unknown): value is Range =>
  typeof value === 'object' && value !== null && typeof (value as Range).min === 'number' && typeof (value as Range).max === 'number'

/** Intervallo del documento prima di una scelta scalare (prima modifica registrata, altrimenti la proposta). */
export function originalRange(draft: ReviewDraft, localId: string, field: string): Range | null {
  const first = draft.decisions.find((decision): decision is Extract<ReviewDecision, { op: 'set' }> => decision.op === 'set' && decision.localId === localId && decision.field === field)
  const value = first ? first.before : proposalValue(draft, localId, field)
  return isRange(value) && value.min !== value.max ? { min: value.min, max: value.max } : null
}

/** Decisioni registrate su un elemento (per mostrare «Modificato da te» e il valore della fonte). */
export const decisionsOf = (draft: ReviewDraft, localId: string) => draft.decisions.filter(decision => decision.localId === localId)

// ---------------------------------------------------------------------------
// Testo e numeri
// ---------------------------------------------------------------------------

/** Lunghezza in caratteri Unicode (code point), come i limiti del dominio. */
export const codePoints = (text: string) => [...text].length
const numberFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 3 })
export const formatNumber = (value: number) => numberFormat.format(value)
export const formatRange = (value: Range | null, unit = '') => value === null ? '' : `${value.min === value.max ? formatNumber(value.min) : `${formatNumber(value.min)}–${formatNumber(value.max)}`}${unit}`
/** Numero scritto dall'utente (virgola o punto); '' → null, testo non numerico → NaN. Nessun arrotondamento. */
export function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(',', '.')
  if (trimmed === '') return null
  return /^-?\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN
}
