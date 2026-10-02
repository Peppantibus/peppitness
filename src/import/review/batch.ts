import { exerciseChoiceValues, sameJsonValue, type ExerciseChoice, type ExtractedExercise, type JsonValue, type NormalizedDocument, type ReviewDraft, type WorkoutReviewDraft } from '../contracts/index.ts'
import { chooseCatalogExercise, matchExercises, type CatalogSnapshot } from '../matching/exercises.ts'
import { validateDraft } from '../validation/validate.ts'
import { chooseCatalog, confirmFinding, DecisionError, setField } from './decisions.ts'

export interface CatalogBatchOffer { localId: string; name: string; choice: ExerciseChoice }
export function catalogBatchOffers(draft: WorkoutReviewDraft, snapshot: CatalogSnapshot): CatalogBatchOffer[] {
  if (!snapshot.complete) return []
  const items = draft.current.filter(item => item.collection === 'exercises' && !item.catalog)
  return matchExercises(items.map(item => ({ ...item.values as ExtractedExercise, localId: item.localId })), snapshot).flatMap(match => {
    const eligible = match.candidates.filter(c => c.selectable && c.nameMatch === 'exact' && !c.conflicts.length && c.adoption !== 'changed_copy')
    const personal = eligible.filter(c => c.choice.source === 'existing')
    const preferred = personal.length ? personal : eligible
    return preferred.length === 1 ? [{ localId: match.localId, name: match.sourceName!, choice: preferred[0]!.choice }] : []
  })
}
/** Check the reviewed identities against the current catalog before returning any changes. */
export function applyCatalogBatch(draft: WorkoutReviewDraft, snapshot: CatalogSnapshot, reviewed: readonly CatalogBatchOffer[]): WorkoutReviewDraft {
  const current = new Map(catalogBatchOffers(draft, snapshot).map(offer => [offer.localId, offer]))
  if (new Set(reviewed.map(o => o.localId)).size !== reviewed.length) throw new DecisionError('invalid_decision', 'Abbinamento ripetuto.')
  let next: ReviewDraft = draft
  for (const offer of reviewed) {
    const live = current.get(offer.localId)
    if (!live || !sameJsonValue(live.choice as unknown as JsonValue, offer.choice as unknown as JsonValue) || offer.choice.source === 'new') throw new DecisionError('stale_decision', 'Gli abbinamenti sono cambiati: rivedili prima di confermare.')
    const choice = chooseCatalogExercise(snapshot, offer.choice.source, offer.choice.source === 'existing' ? offer.choice.personalId : offer.choice.templateId)
    next = chooseCatalog(next, offer.localId, choice)
  }
  return next as WorkoutReviewDraft
}
export const scalarBatchFields = ['restSeconds', 'durationSeconds', 'rir', 'rpe'] as const
export type ScalarBatchField = typeof scalarBatchFields[number]
export interface ScalarBatchGroup { field: ScalarBatchField; min: number; max: number; items: { localId: string; name: string }[] }
export function scalarBatchGroups(draft: WorkoutReviewDraft): ScalarBatchGroup[] {
  const groups = new Map<string, ScalarBatchGroup>()
  for (const item of draft.current) {
    if (item.collection !== 'exercises') continue
    const values = item.values as ExtractedExercise
    for (const field of scalarBatchFields) {
      const range = values[field]
      if (!range || range.min === range.max) continue
      const key = `${field}:${range.min}:${range.max}`
      let group = groups.get(key)
      if (!group) { group = { field, min: range.min, max: range.max, items: [] }; groups.set(key, group) }
      group.items.push({ localId: item.localId, name: item.catalog ? exerciseChoiceValues(item.catalog).name : values.name ?? 'Esercizio senza nome' })
    }
  }
  return [...groups.values()]
}
export function applyScalarBatch(draft: WorkoutReviewDraft, reviewed: ScalarBatchGroup, chosen: number): WorkoutReviewDraft {
  if (!Number.isSafeInteger(chosen) || chosen < reviewed.min || chosen > reviewed.max) throw new DecisionError('invalid_decision', 'Scegli un intero compreso nell’intervallo.')
  if (!scalarBatchFields.includes(reviewed.field) || !reviewed.items.length || new Set(reviewed.items.map(i => i.localId)).size !== reviewed.items.length) throw new DecisionError('invalid_decision', 'Gruppo non valido.')
  let next: ReviewDraft = draft
  for (const entry of reviewed.items) {
    const item = draft.current.find(i => i.localId === entry.localId && i.collection === 'exercises')
    const range = item && (item.values as ExtractedExercise)[reviewed.field]
    if (!range || range.min !== reviewed.min || range.max !== reviewed.max) throw new DecisionError('stale_decision', 'Gli intervalli sono cambiati: rivedili prima di confermare.')
    next = setField(next, entry.localId, reviewed.field, { min: chosen, max: chosen }, reviewed.field === 'restSeconds' || reviewed.field === 'durationSeconds' ? 'timer_choice' : 'user_edit')
  }
  return next as WorkoutReviewDraft
}
/** Original rule text retained; the user must still review each prescription. */
export function applyScopeBatch(draft: WorkoutReviewDraft, document: NormalizedDocument, localIds: readonly string[], scope: string): WorkoutReviewDraft {
  if (!scope.trim() || !localIds.length || new Set(localIds).size !== localIds.length) throw new DecisionError('invalid_decision', 'Scrivi quale fase importi o come gestirai le regole.')
  const findings = validateDraft(document, draft).findings
  let next: ReviewDraft = draft
  for (const localId of localIds) {
    const item = draft.current.find(i => i.localId === localId && i.collection === 'complexRules')
    if (!item) throw new DecisionError('unknown_item', 'Regola non disponibile.')
    const text = (item.values as { text: string }).text
    const finding = findings.find(f => f.issue.localId === localId && ['complex_rule_unresolved', 'complex_rule_review'].includes(f.issue.code))
    if (!finding || !finding.issue.resolutions.includes('scope_choice')) throw new DecisionError('stale_decision', 'La regola è cambiata: rivedila prima di confermare.')
    next = setField(next, localId, 'text', `${text}\nScelta: ${scope.trim()}`, 'scope_choice')
    next = confirmFinding(next, finding, 'scope_choice')
  }
  return next as WorkoutReviewDraft
}
