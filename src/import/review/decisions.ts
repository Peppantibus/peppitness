/**
 * Decisioni di revisione (task 07, specifica §9.2): replay deterministico sulla proposta immutabile,
 * azioni dell'interfaccia, conferme legate al valore visto e prontezza al salvataggio.
 * - Ogni azione aggiunge una decisione (`set`, `add`, `remove`, `move`, `catalog`, `confirm`) e ricalcola
 *   il contenuto corrente dal replay: proposta ed evidence non cambiano mai.
 * - Una decisione registra il valore precedente: se non coincide più con il contenuto corrente il replay
 *   si ferma (`stale_decision`), non applica in silenzio una modifica pensata per un altro valore.
 * - Una conferma chiude un problema solo se il motivo è fra le risoluzioni ammesse dal catalogo (06) e il
 *   valore confermato è ancora quello corrente: un edit successivo la invalida.
 * - «Pronto» richiede problemi bloccanti e conferme chiusi e un mapping valido passato come risultato.
 */
import {
  addableReviewCollections, enumerateProposalItems, sameJsonValue, validateReviewDraft,
  type ContractError, type ExerciseChoice, type JsonValue, type MappingResult, type ReviewCollection, type ReviewDecision, type ReviewDraft,
  type ReviewItem,
} from '../contracts/index.ts'
import type { ValidationFinding } from '../validation/validate.ts'
import { childCollections, fieldsOf, proposalValues } from './draft.ts'

export type DecisionErrorCode = 'invalid_draft' | 'unknown_item' | 'stale_decision' | 'invalid_decision' | 'not_allowed'
export class DecisionError extends Error {
  readonly code: DecisionErrorCode
  /** Posizione della decisione che non si applica; null per la bozza intera. */
  readonly decisionIndex: number | null
  readonly errors: ContractError[]
  constructor(code: DecisionErrorCode, message: string, decisionIndex: number | null = null, errors: ContractError[] = []) {
    super(message)
    this.name = 'DecisionError'
    this.code = code
    this.decisionIndex = decisionIndex
    this.errors = errors
  }
}

interface Node { collection: ReviewCollection; localId: string; parentLocalId: string | null; values: Record<string, unknown>; catalog?: ExerciseChoice | null }
type DraftCore = Pick<ReviewDraft, 'kind' | 'proposal' | 'localIds' | 'decisions'>

/**
 * Contenuto corrente dalla proposta e dalle decisioni, in visita in profondità (radice, sedute con i loro
 * esercizi, regole; oppure giornate, pasti, alimenti, regole globali). Copie profonde: nessun alias verso
 * la proposta o le decisioni.
 */
export function replayDecisions(draft: DraftCore): ReviewItem[] {
  const kind = draft.kind
  const items = enumerateProposalItems(draft.proposal.extraction)
  const idOf = new Map(draft.localIds.map(entry => [entry.pointer, entry.localId]))
  const nodes = new Map<string, Node>()
  const children = new Map<string, string[]>()
  const list = (parent: string, collection: ReviewCollection) => {
    const key = `${parent}\u0000${collection}`
    let entries = children.get(key)
    if (!entries) { entries = []; children.set(key, entries) }
    return entries
  }
  for (const item of items) {
    const localId = idOf.get(item.pointer)
    if (localId === undefined) throw new DecisionError('invalid_draft', `Elemento della proposta senza ID locale: "${item.pointer}".`)
    const parentLocalId = item.parentPointer === null ? null : idOf.get(item.parentPointer)!
    nodes.set(localId, { collection: item.collection, localId, parentLocalId, values: proposalValues(kind, draft.proposal.extraction, item), ...(item.collection === 'exercises' ? { catalog: null } : {}) })
    if (parentLocalId !== null) list(parentLocalId, item.collection).push(localId)
  }
  const rootId = idOf.get('')!
  const node = (localId: string, index: number) => {
    const found = nodes.get(localId)
    if (!found) throw new DecisionError('unknown_item', `Elemento inesistente o rimosso: ${localId}.`, index)
    return found
  }
  const removeSubtree = (localId: string) => {
    const target = nodes.get(localId)!
    for (const collection of childCollections(kind, target.collection)) for (const child of [...list(localId, collection)]) removeSubtree(child)
    nodes.delete(localId)
  }

  draft.decisions.forEach((decision, index) => {
    switch (decision.op) {
      case 'set': {
        const target = node(decision.localId, index)
        if (!Object.hasOwn(target.values, decision.field)) throw new DecisionError('invalid_decision', `Campo ${decision.field} inesistente per ${target.collection}.`, index)
        if (!sameJsonValue(target.values[decision.field] as JsonValue, decision.before)) throw new DecisionError('stale_decision', `Il valore di ${decision.field} non è più quello visto dalla decisione ${decision.decisionId}.`, index)
        target.values[decision.field] = structuredClone(decision.after)
        return
      }
      case 'add': {
        if (nodes.has(decision.localId)) throw new DecisionError('invalid_decision', `ID locale già usato: ${decision.localId}.`, index)
        node(decision.parentLocalId, index)
        const siblings = list(decision.parentLocalId, decision.collection)
        if (decision.index > siblings.length) throw new DecisionError('invalid_decision', 'Posizione oltre la fine della lista.', index)
        nodes.set(decision.localId, {
          collection: decision.collection, localId: decision.localId, parentLocalId: decision.parentLocalId,
          values: structuredClone(decision.values) as Record<string, unknown>, ...(decision.collection === 'exercises' ? { catalog: null } : {}),
        })
        siblings.splice(decision.index, 0, decision.localId)
        return
      }
      case 'remove': {
        const target = node(decision.localId, index)
        if (target.parentLocalId === null) throw new DecisionError('not_allowed', 'La radice non si rimuove.', index)
        const siblings = list(target.parentLocalId, target.collection)
        siblings.splice(siblings.indexOf(decision.localId), 1)
        removeSubtree(decision.localId)
        return
      }
      case 'move': {
        const target = node(decision.localId, index)
        const from = list(decision.fromParentLocalId, target.collection)
        if (target.parentLocalId !== decision.fromParentLocalId || from[decision.fromIndex] !== decision.localId) throw new DecisionError('stale_decision', `Posizione di ${decision.localId} diversa da quella vista.`, index)
        node(decision.toParentLocalId, index)
        from.splice(decision.fromIndex, 1)
        const to = list(decision.toParentLocalId, target.collection)
        if (decision.toIndex > to.length) throw new DecisionError('invalid_decision', 'Posizione oltre la fine della lista.', index)
        to.splice(decision.toIndex, 0, decision.localId)
        target.parentLocalId = decision.toParentLocalId
        return
      }
      case 'catalog': {
        const target = node(decision.localId, index)
        if (target.collection !== 'exercises') throw new DecisionError('invalid_decision', 'Solo un esercizio ha una scelta del catalogo.', index)
        if (!sameJsonValue((target.catalog ?? null), decision.before)) throw new DecisionError('stale_decision', 'La scelta del catalogo non è più quella vista.', index)
        target.catalog = structuredClone(decision.after)
        return
      }
      case 'confirm':
        node(decision.localId, index)
        return
    }
  })

  const out: ReviewItem[] = []
  const visit = (localId: string) => {
    const current = nodes.get(localId)!
    out.push({ collection: current.collection, localId, parentLocalId: current.parentLocalId, values: structuredClone(current.values), ...(current.collection === 'exercises' ? { catalog: structuredClone(current.catalog ?? null) } : {}) } as ReviewItem)
    for (const collection of childCollections(kind, current.collection)) for (const child of list(localId, collection)) visit(child)
  }
  visit(rootId)
  return out
}

export type DraftCheck = { ok: true; draft: ReviewDraft } | { ok: false; reason: 'invalid_shape' | 'replay_failed' | 'current_mismatch'; message: string; errors: ContractError[] }

/** Forma del contratto 02 più coincidenza fra replay delle decisioni e contenuto corrente (bozza letta da disco o ricevuta). */
export function verifyDraft(value: unknown): DraftCheck {
  const shape = validateReviewDraft(value)
  if (!shape.ok) return { ok: false, reason: 'invalid_shape', message: 'Bozza non conforme al contratto.', errors: shape.errors }
  let replayed: ReviewItem[]
  try { replayed = replayDecisions(shape.value) } catch (error) {
    if (error instanceof DecisionError) return { ok: false, reason: 'replay_failed', message: error.message, errors: error.errors }
    throw error
  }
  if (!sameJsonValue(replayed, shape.value.current)) {
    return { ok: false, reason: 'current_mismatch', message: 'Il contenuto corrente non deriva dalle decisioni registrate.', errors: [] }
  }
  return { ok: true, draft: shape.value }
}

// ---------------------------------------------------------------------------
// Azioni
// ---------------------------------------------------------------------------

export interface DecisionOptions { decisionId?: string }
const newDecisionId = (options?: DecisionOptions) => options?.decisionId ?? crypto.randomUUID()

/** Aggiunge una decisione e ricalcola il contenuto; la bozza d'ingresso resta intatta. */
export function applyDecision(draft: ReviewDraft, decision: ReviewDecision): ReviewDraft {
  const next = { ...draft, decisions: [...draft.decisions, decision] } as ReviewDraft
  let current: ReviewItem[]
  try { current = replayDecisions(next) } catch (error) {
    if (error instanceof DecisionError) throw new DecisionError(error.code, error.message, draft.decisions.length, error.errors)
    throw error
  }
  const candidate = { ...next, current } as ReviewDraft
  const checked = validateReviewDraft(candidate)
  if (!checked.ok) throw new DecisionError('invalid_decision', `Decisione non valida: ${checked.errors[0]!.code} in "${checked.errors[0]!.path}".`, draft.decisions.length, checked.errors)
  return checked.value
}

export const findItem = (draft: ReviewDraft, localId: string): ReviewItem | undefined => (draft.current as readonly ReviewItem[]).find(item => item.localId === localId)
function requireItem(draft: ReviewDraft, localId: string) {
  const item = findItem(draft, localId)
  if (!item) throw new DecisionError('unknown_item', `Elemento inesistente o rimosso: ${localId}.`)
  return item
}

/** Modifica di un campo; `timer_choice` fissa un solo valore di recupero o durata, `confirmed_missing` conferma un vuoto. */
export function setField(draft: ReviewDraft, localId: string, field: string, value: JsonValue, reason: 'user_edit' | 'timer_choice' | 'confirmed_missing' | 'scope_choice' = 'user_edit', options?: DecisionOptions): ReviewDraft {
  const item = requireItem(draft, localId)
  const before = (item.values as Record<string, JsonValue>)[field]
  if (before === undefined) throw new DecisionError('invalid_decision', `Campo ${field} inesistente per ${item.collection}.`)
  if (sameJsonValue(before, value)) return draft
  return applyDecision(draft, { op: 'set', decisionId: newDecisionId(options), localId, field, before: structuredClone(before), after: structuredClone(value), reason })
}

/** Aggiunge un elemento scritto dall'utente: nessuna citazione, provenienza = decisione. */
export function addItem(draft: ReviewDraft, input: { collection: typeof addableReviewCollections[number]; parentLocalId: string; values: JsonValue; index?: number; localId?: string }, options?: DecisionOptions): ReviewDraft {
  const siblings = (draft.current as readonly ReviewItem[]).filter(item => item.parentLocalId === input.parentLocalId && item.collection === input.collection)
  return applyDecision(draft, {
    op: 'add', decisionId: newDecisionId(options), localId: input.localId ?? crypto.randomUUID(), collection: input.collection,
    parentLocalId: input.parentLocalId, index: input.index ?? siblings.length, values: structuredClone(input.values), reason: 'user_edit',
  })
}

export function removeItem(draft: ReviewDraft, localId: string, reason: 'user_edit' | 'scope_choice' = 'user_edit', options?: DecisionOptions): ReviewDraft {
  requireItem(draft, localId)
  return applyDecision(draft, { op: 'remove', decisionId: newDecisionId(options), localId, reason })
}

/** Sposta un elemento fra i fratelli o sotto un altro genitore dello stesso tipo; `toIndex` nella lista di destinazione dopo la rimozione. */
export function moveItem(draft: ReviewDraft, localId: string, toParentLocalId: string, toIndex: number, options?: DecisionOptions): ReviewDraft {
  const item = requireItem(draft, localId)
  if (item.parentLocalId === null) throw new DecisionError('not_allowed', 'La radice non si sposta.')
  const siblings = (draft.current as readonly ReviewItem[]).filter(entry => entry.parentLocalId === item.parentLocalId && entry.collection === item.collection)
  const fromIndex = siblings.findIndex(entry => entry.localId === localId)
  if (item.parentLocalId === toParentLocalId && fromIndex === toIndex) return draft
  return applyDecision(draft, { op: 'move', decisionId: newDecisionId(options), localId, fromParentLocalId: item.parentLocalId, fromIndex, toParentLocalId, toIndex, reason: 'user_edit' })
}

/** Scelta del catalogo (08 fornisce i candidati): nessuna scrittura, solo una decisione. */
export function chooseCatalog(draft: ReviewDraft, localId: string, choice: ExerciseChoice | null, options?: DecisionOptions): ReviewDraft {
  const item = requireItem(draft, localId)
  const before = 'catalog' in item ? item.catalog : null
  if (sameJsonValue((before ?? null), choice)) return draft
  return applyDecision(draft, { op: 'catalog', decisionId: newDecisionId(options), localId, before: structuredClone(before ?? null), after: structuredClone(choice), reason: 'catalog_choice' })
}

// ---------------------------------------------------------------------------
// Conferme e prontezza
// ---------------------------------------------------------------------------

/**
 * Valore a cui si lega una conferma: il valore corrente del campo, oppure — per un problema dell'intero
 * elemento o del documento — i blocchi della fonte indicati dal problema.
 */
export function confirmationValue(draft: ReviewDraft, finding: ValidationFinding): JsonValue {
  if (finding.field === null) return [...finding.issue.sourceRefs]
  const item = finding.issue.localId === null ? undefined : findItem(draft, finding.issue.localId)
  return item ? structuredClone((item.values as Record<string, JsonValue>)[finding.field] ?? null) : null
}

/**
 * Conferma esplicita di un problema. Il motivo deve essere fra le risoluzioni del problema: un bloccante
 * senza `scope_choice` non si chiude con una conferma, un vuoto si conferma solo dove è ammesso.
 */
export function confirmFinding(draft: ReviewDraft, finding: ValidationFinding, reason: 'confirmed_missing' | 'scope_choice', options?: DecisionOptions): ReviewDraft {
  const { issue } = finding
  if (issue.localId === null) throw new DecisionError('invalid_decision', 'Il problema non appartiene a un elemento della bozza.')
  if (!(issue.resolutions as readonly string[]).includes(reason)) throw new DecisionError('not_allowed', `Il problema ${issue.code} non si chiude con ${reason}.`)
  requireItem(draft, issue.localId)
  return applyDecision(draft, { op: 'confirm', decisionId: newDecisionId(options), localId: issue.localId, field: finding.field, issueCode: issue.code, value: confirmationValue(draft, finding), reason })
}

/** Una conferma vale se riguarda lo stesso problema, con un motivo ammesso e il valore ancora corrente. */
export function isConfirmed(draft: ReviewDraft, finding: ValidationFinding): boolean {
  const { issue } = finding
  if (issue.severity === 'info') return true
  const subject = confirmationValue(draft, finding)
  return draft.decisions.some(decision => decision.op === 'confirm' && decision.issueCode === issue.code && decision.localId === issue.localId
    && decision.field === finding.field && (issue.resolutions as readonly string[]).includes(decision.reason) && sameJsonValue(decision.value, subject))
}

/** Conferme superate da un edit successivo o riferite a un elemento rimosso (da mostrare come «da confermare di nuovo»). */
export function staleConfirmations(draft: ReviewDraft): Extract<ReviewDecision, { op: 'confirm' }>[] {
  return draft.decisions.filter((decision): decision is Extract<ReviewDecision, { op: 'confirm' }> => {
    if (decision.op !== 'confirm') return false
    const item = findItem(draft, decision.localId)
    if (!item) return true
    return decision.field !== null && !sameJsonValue(decision.value, (item.values as Record<string, JsonValue>)[decision.field] ?? null)
  })
}

export const openFindings = (draft: ReviewDraft, findings: readonly ValidationFinding[]) => findings.filter(finding => !isConfirmed(draft, finding))

export interface Readiness {
  ready: boolean
  blocking: ValidationFinding[]
  confirmations: ValidationFinding[]
  info: ValidationFinding[]
  /** missing: mapping non ancora eseguito; failed: mapping con problemi bloccanti; ok: piano salvabile. */
  mapping: 'missing' | 'failed' | 'ok'
}

/**
 * Prontezza al salvataggio. `findings` viene da `validateDraft` (06) sulla stessa bozza; `mapping` è il
 * risultato del mapper (09/10) sulla stessa bozza, mai un interruttore arbitrario.
 */
export function evaluateReadiness(draft: ReviewDraft, findings: readonly ValidationFinding[], mapping: MappingResult<unknown> | null): Readiness {
  const open = openFindings(draft, findings)
  const blocking = open.filter(finding => finding.issue.severity === 'blocking')
  const confirmations = open.filter(finding => finding.issue.severity === 'confirmation')
  const info = findings.filter(finding => finding.issue.severity === 'info')
  const mappingState = mapping === null ? 'missing' : mapping.ok && !mapping.issues.some(issue => issue.severity === 'blocking') ? 'ok' : 'failed'
  return { ready: !blocking.length && !confirmations.length && mappingState === 'ok', blocking, confirmations, info, mapping: mappingState }
}

// ---------------------------------------------------------------------------
// Rianalisi: confronto, mai fusione automatica
// ---------------------------------------------------------------------------

export interface ProposalDifference { pointer: string; collection: ReviewCollection; change: 'added' | 'removed' | 'changed'; fields: string[] }

/**
 * Differenze fra il contenuto corrente della bozza in uso e una nuova proposta, per elementi della
 * proposta con lo stesso puntatore. Serve al confronto: l'adozione resta una scelta esplicita e la bozza
 * precedente, con le sue decisioni, non viene toccata.
 */
export function compareWithProposal(current: ReviewDraft, next: ReviewDraft): ProposalDifference[] {
  const byPointer = (draft: ReviewDraft) => {
    const pointers = new Map(draft.localIds.map(entry => [entry.localId, entry.pointer]))
    return new Map((draft.current as readonly ReviewItem[]).flatMap(item => pointers.has(item.localId) ? [[pointers.get(item.localId)!, item] as const] : []))
  }
  const before = byPointer(current)
  const after = new Map(enumerateProposalItems(next.proposal.extraction).map(item => [item.pointer, item]))
  const out: ProposalDifference[] = []
  for (const [pointer, item] of after) {
    const old = before.get(pointer)
    if (!old || old.collection !== item.collection) { out.push({ pointer, collection: item.collection, change: 'added', fields: [] }); continue }
    const values = proposalValues(next.kind, next.proposal.extraction, item)
    const fields = fieldsOf(next.kind, item.collection).filter(field => !sameJsonValue((old.values as Record<string, JsonValue>)[field]!, values[field] as JsonValue))
    if (fields.length) out.push({ pointer, collection: item.collection, change: 'changed', fields })
  }
  for (const [pointer, item] of before) if (!after.has(pointer)) out.push({ pointer, collection: item.collection, change: 'removed', fields: [] })
  return out
}
