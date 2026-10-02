import { emptyExercise } from '../../domain/exercises.ts'
import { exerciseChoiceValues, sameJsonValue, validateExerciseChoice, type CatalogExerciseValues, type ExtractedExercise, type JsonValue, type NormalizedDocument, type WorkoutReviewDraft } from '../contracts/index.ts'
import { identityFields, matchExercises, normalizeExerciseName, type CatalogSnapshot } from '../matching/exercises.ts'
import { draftRuleItems, validateDraft } from '../validation/validate.ts'
import { hasDelayedOptionalSets, instructionTargets } from '../validation/workout-instructions.ts'
import { chooseCatalog, setField } from './decisions.ts'

export const preparedCatalogDecision = (id: string) => id.startsWith('prep-catalog-')
const signature = (v: CatalogExerciseValues) => JSON.stringify([normalizeExerciseName(v.name), ...identityFields.map(f => v[f])])

export function preparedExerciseValues(v: ExtractedExercise): CatalogExerciseValues | null {
  if (!v.name?.trim() || (v.repetitions !== null && v.durationSeconds !== null)) return null
  const mode = v.measurementMode ?? (v.repetitions !== null ? 'reps' : v.durationSeconds !== null ? 'seconds' : null)
  if (!mode || (mode === 'reps' && v.durationSeconds !== null) || (mode === 'seconds' && v.repetitions !== null)) return null
  const defaults = emptyExercise()
  const values = { name: v.name.trim(), variant: v.variant ?? '', equipment: v.equipment ?? '', measurementMode: mode,
    perSide: v.perSide ?? defaults.perSide, loadUnit: v.loadUnit ?? defaults.loadUnit,
    loadConvention: v.loadConvention ?? defaults.loadConvention, note: '' }
  return validateExerciseChoice({ source: 'new', localKey: 'prepared', values }).ok ? values : null
}

/** Pure, idempotent preparation. Writes only review decisions; final commit creates the catalog rows. */
export function prepareWorkoutReview(document: NormalizedDocument, draft: WorkoutReviewDraft, snapshot: CatalogSnapshot): WorkoutReviewDraft {
  let next = draft
  const usedIds = new Set(draft.decisions.map(d => d.decisionId))
  let ordinal = draft.decisions.length
  const options = (stage: string) => {
    let id: string
    do { id = `prep-${stage}-${++ordinal}` } while (usedIds.has(id))
    usedIds.add(id); return { decisionId: id }
  }
  // Never select an ambiguous phase. Only deactivate a delayed addition when the base is already verified.
  const findings = validateDraft(document, next).findings
  const ruleItems = draftRuleItems(next)
  for (const rule of ruleItems.filter(i => i.collection === 'complexRules' && hasDelayedOptionalSets(String(i.values.text)))) {
    if (findings.some(f => f.issue.localId === rule.localId && f.issue.severity !== 'info'
      && !['complex_rule_unresolved', 'complex_rule_review'].includes(f.issue.code))) continue
    for (const item of instructionTargets(rule, ruleItems) ?? []) {
      if (!item.localId || !Number.isSafeInteger(item.values.sets) || Number(item.values.sets) < 1) continue
      if (findings.some(f => f.issue.localId === item.localId && f.field === 'sets' && f.issue.severity !== 'info')) continue
      if (next.decisions.some(d => d.op === 'set' && d.localId === item.localId && d.field === 'optionalSets')) continue
      if (item.values.optionalSets !== 0) next = setField(next, item.localId, 'optionalSets', 0,
        item.values.optionalSets === null ? 'confirmed_missing' : 'scope_choice', options('optional')) as WorkoutReviewDraft
    }
  }
  if (!snapshot.complete) return next
  const usedKeys = new Set(next.decisions.flatMap(d => d.op === 'catalog' && d.after?.source === 'new' ? [d.after.localKey] : []))
  const reusable = new Map(next.current.flatMap(i => i.collection === 'exercises' && i.catalog?.source === 'new'
    ? [[signature(i.catalog.values), i.catalog] as const] : []))
  let keyOrdinal = 0
  for (const item of next.current.filter(i => i.collection === 'exercises')) {
    const lastChoice = Math.max(-1, ...next.decisions.map((d,index) => d.op === 'catalog' && d.localId === item.localId ? index : -1))
    const last = next.decisions[lastChoice]
    const changedIdentity = last && preparedCatalogDecision(last.decisionId) && next.decisions.some((d,index) => index > lastChoice
      && d.op === 'set' && d.localId === item.localId && (d.field === 'name' || (identityFields as readonly string[]).includes(d.field)))
    if (last && !changedIdentity) continue // Includes an explicit manual removal of the binding.
    if (item.catalog && !changedIdentity) continue
    const values = preparedExerciseValues(item.values as ExtractedExercise)
    if (!values) {
      if (changedIdentity && item.catalog) next = chooseCatalog(next, item.localId, null, options('catalog')) as WorkoutReviewDraft
      continue
    }
    const match = matchExercises([{ ...item.values as ExtractedExercise, localId: item.localId }], snapshot)[0]!
    const eligible = match.candidates.filter(c => c.nameMatch === 'exact' && c.selectable && !c.conflicts.length && c.adoption !== 'changed_copy')
    const personal = eligible.filter(c => c.choice.source === 'existing')
    const preferred = personal.length ? personal : eligible
    let choice = preferred.length === 1 ? preferred[0]!.choice : null
    const archived = snapshot.personal.some(row => row.archivedAt !== null && normalizeExerciseName(row.name) === normalizeExerciseName(values.name))
    const adoptionConflict = match.candidates.some(c => c.nameMatch === 'exact' && ['changed_copy', 'archived_copy'].includes(c.adoption))
    if (!choice && (preferred.length > 1 || archived || adoptionConflict)) {
      if (changedIdentity && item.catalog) next = chooseCatalog(next, item.localId, null, options('catalog')) as WorkoutReviewDraft
      continue
    }
    if (!choice) {
      choice = reusable.get(signature(values)) ?? null
      if (!choice) {
        let localKey: string
        do { localKey = `prepared-exercise-${++keyOrdinal}` } while (usedKeys.has(localKey))
        usedKeys.add(localKey)
        choice = { source: 'new', localKey, values }
        reusable.set(signature(values), choice)
      }
    }
    if (!sameJsonValue((item.catalog ?? null) as unknown as JsonValue, choice as unknown as JsonValue)) {
      next = chooseCatalog(next, item.localId, choice, options('catalog')) as WorkoutReviewDraft
    }
  }
  return next
}

export function catalogPreparationSummary(draft: WorkoutReviewDraft) {
  const bindings = new Map(draft.current.flatMap(i => i.collection === 'exercises' && i.catalog
    ? [[i.catalog.source === 'new' ? `new:${i.catalog.localKey}` : i.catalog.source === 'shared' ? `shared:${i.catalog.templateId}` : `existing:${i.catalog.personalId}`, i.catalog] as const] : []))
  return [...bindings.values()].map(choice => ({ source: choice.source, ...exerciseChoiceValues(choice) }))
}
