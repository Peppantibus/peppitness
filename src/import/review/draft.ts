/**
 * Bozza di revisione (task 07, specifica §§9.2–9.3): proposta immutabile dell'interprete, ID locali
 * assegnati una sola volta dall'app e contenuto corrente ricostruito dalle decisioni. La proposta non
 * viene mai modificata: il contenuto corrente è sempre una copia, e una nuova analisi produce una
 * proposta distinta con una propria bozza (mai una sovrascrittura degli edit).
 * Nucleo puro: nessun provider, nessuna rete, nessun DOM.
 */
import {
  enumerateProposalItems, REVIEW_DRAFT_FORMAT, reviewValueSchemas,
  type ExtractionFor, type ExtractionKind, type ProposalItem, type ProposalSource, type ReviewCollection, type ReviewDraft, type ReviewItem,
} from '../contracts/index.ts'
import { objectFields } from '../contracts/schema.ts'

/** ID locale di ogni elemento della proposta; opaco e stabile per tutta la revisione. */
export type LocalIdFactory = (item: ProposalItem, index: number) => string
/** Predefinito: UUID casuali, mai derivati dal contenuto o da ID del database. */
export const randomLocalIds: LocalIdFactory = () => crypto.randomUUID()
/** Deterministico (`p0`, `p1`… nell'ordine della fonte): per test e fixture. */
export const sequentialLocalIds = (prefix = 'p'): LocalIdFactory => (_, index) => `${prefix}${index}`

export const fieldsOf = (kind: ExtractionKind, collection: ReviewCollection): string[] =>
  [...objectFields((reviewValueSchemas[kind] as Record<string, Parameters<typeof objectFields>[0]>)[collection]!).keys()]

/** Figli di ogni collezione, nell'ordine in cui la bozza li elenca (visita in profondità). */
export function childCollections(kind: ExtractionKind, collection: ReviewCollection): readonly ReviewCollection[] {
  switch (collection) {
    case 'root': return kind === 'workout' ? ['sessions', 'complexRules'] : ['days', 'globalRules']
    case 'sessions': return ['exercises']
    case 'days': return ['meals']
    case 'meals': return ['foods']
    default: return []
  }
}

function valueAt(extraction: unknown, pointer: string): Record<string, unknown> {
  let current = extraction
  if (pointer !== '') for (const token of pointer.slice(1).split('/')) current = (current as Record<string, unknown>)[token]
  return current as Record<string, unknown>
}

/** Elemento corrente iniziale di un elemento della proposta: copia profonda dei soli campi modificabili. */
export function proposalValues(kind: ExtractionKind, extraction: unknown, item: ProposalItem): Record<string, unknown> {
  const source = valueAt(extraction, item.pointer)
  return Object.fromEntries(fieldsOf(kind, item.collection).map(field => [field, structuredClone(source[field])]))
}

export interface NewProposal<K extends ExtractionKind> {
  kind: K
  extraction: ExtractionFor<K>
  proposalId: string
  jobId: string | null
  source: ProposalSource
  /** 1 per la prima analisi; una rianalisi indica la proposta precedente. */
  previous?: { proposalId: string; proposalVersion: number } | null
  localIds?: LocalIdFactory
}

/** Nuova bozza senza decisioni: ogni elemento della proposta riceve un ID locale, il contenuto corrente è una copia. */
export function createReviewDraft<K extends ExtractionKind>(input: NewProposal<K>): Extract<ReviewDraft, { kind: K }> {
  const items = enumerateProposalItems(input.extraction)
  const factory = input.localIds ?? randomLocalIds
  const ids = new Map<string, string>()
  const used = new Set<string>()
  items.forEach((item, index) => {
    const id = factory(item, index)
    if (used.has(id)) throw new Error(`ID locale ripetuto: ${id}`)
    used.add(id)
    ids.set(item.pointer, id)
  })
  const current: ReviewItem[] = []
  const byParent = new Map<string, ProposalItem[]>()
  for (const item of items) if (item.parentPointer !== null) {
    const key = `${item.parentPointer}\u0000${item.collection}`
    byParent.set(key, [...byParent.get(key) ?? [], item])
  }
  const visit = (item: ProposalItem) => {
    const values = proposalValues(input.kind, input.extraction, item)
    current.push({
      collection: item.collection, localId: ids.get(item.pointer)!, parentLocalId: item.parentPointer === null ? null : ids.get(item.parentPointer)!,
      values, ...(item.collection === 'exercises' ? { catalog: null } : {}),
    } as ReviewItem)
    for (const collection of childCollections(input.kind, item.collection)) for (const child of byParent.get(`${item.pointer}\u0000${collection}`) ?? []) visit(child)
  }
  visit(items[0]!)
  return {
    formatVersion: REVIEW_DRAFT_FORMAT,
    kind: input.kind,
    proposal: {
      proposalId: input.proposalId,
      proposalVersion: input.previous ? input.previous.proposalVersion + 1 : 1,
      previousProposalId: input.previous?.proposalId ?? null,
      jobId: input.jobId,
      source: structuredClone(input.source),
      extraction: structuredClone(input.extraction),
    },
    localIds: items.map(item => ({ localId: ids.get(item.pointer)!, pointer: item.pointer })),
    decisions: [],
    current,
  } as unknown as Extract<ReviewDraft, { kind: K }>
}

/** Mappa ID locale → puntatore sulla proposta (solo elementi della proposta, non quelli aggiunti). */
export const pointerOf = (draft: ReviewDraft) => new Map(draft.localIds.map(entry => [entry.localId, entry.pointer]))
