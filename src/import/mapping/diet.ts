import { mealPlanTooLarge, validateMealPlanDraft, type MealPlanDraft } from '../../domain/meal-plans.ts'
import { finishMapping, resolvedPayloadContract, type MappingResult, type ResolvedDietImport } from '../contracts/commit.ts'
import { validateNormalizedDocument, type NormalizedDocument } from '../contracts/normalized-document.ts'
import type { DietReviewDraft, ValidationIssue } from '../contracts/review.ts'
import { openFindings, verifyDraft } from '../review/decisions.ts'
import { validateDraft } from '../validation/validate.ts'

/** Reserve once in the review, keyed by local day/meal ID. Foods deliberately have no domain ID. */
export interface DietMappingIds { planId: string; items: Readonly<Record<string, string>> }
export interface DietMapping {
  plan: MealPlanDraft
  resolved: ResolvedDietImport
  /** Outside MealPlanDocument; a food points to its meal, root/global rules to null. */
  targets: Record<string, string | null>
}
const problem = (code: string, message: string, localId: string | null = null): ValidationIssue => ({
  code, message, localId, severity: 'blocking', stage: 'mapping', sourcePath: null, sourceRefs: [], resolutions: ['user_edit'],
})
const labels = { addition: 'Aggiunta', substitution: 'Sostituzione', nutrition: 'Nutrienti', other: 'Regola' } as const

/** Text is copied verbatim, with only explicit scope labels and line separators added. No clean/filter/trim. */
export function mapReviewedDiet(document: NormalizedDocument, draft: DietReviewDraft, ids: DietMappingIds): MappingResult<DietMapping> {
  const checked = verifyDraft(draft)
  if (!checked.ok || checked.draft.kind !== 'diet' || !validateNormalizedDocument(document).ok) {
    return finishMapping<DietMapping>(null, [problem('diet_invalid_review', 'Fonte o revisione non valida.')])
  }
  if (draft.proposal.extraction.outcome !== 'extracted') return finishMapping<DietMapping>(null, [problem('diet_no_content', 'La proposta non contiene un piano alimentare importabile.')])
  const issues: ValidationIssue[] = openFindings(draft, validateDraft(document, draft).findings).map(finding => ({
    ...finding.issue, code: 'diet_review_required', stage: 'mapping', severity: 'blocking', message: `${finding.issue.code}: ${finding.issue.message}`,
  }))
  const root = draft.current.find(item => item.collection === 'root')!
  const globalRules = draft.current.filter(item => item.collection === 'globalRules')
  const targets: Record<string, string | null> = { [root.localId]: null }
  const globalTexts = globalRules.map(rule => rule.values.text)
  for (const rule of globalRules) {
    targets[rule.localId] = null
    if (!rule.values.text.trim()) issues.push(problem('diet_empty_rule', 'Una regola globale vuota va risolta o rimossa esplicitamente.', rule.localId))
    if (root.values.guidance.some(line => line.includes(rule.values.text)) || globalTexts.filter(text => text === rule.values.text).length > 1) {
      issues.push(problem('diet_global_rule_duplicate', 'La regola globale compare più volte: risolvere la duplicazione nella revisione.', rule.localId))
    }
  }
  const plan: MealPlanDraft = {
    id: ids.planId, name: root.values.title ?? '',
    document: {
      guidance: [...root.values.guidance, ...globalRules.map(rule => `[${labels[rule.values.kind]} — intero piano] ${rule.values.text}`)].join('\n'),
      days: draft.current.filter(item => item.collection === 'days').map(day => {
        targets[day.localId] = ids.items[day.localId] ?? ''
        return { id: ids.items[day.localId] ?? '', name: day.values.name ?? '', dayType: day.values.dayType!, note: day.values.notes.join('\n'),
          meals: draft.current.filter(item => item.collection === 'meals').filter(item => item.parentLocalId === day.localId).map(meal => {
            const id = ids.items[meal.localId] ?? ''
            targets[meal.localId] = id
            const notes = [...meal.values.notes]
            const foods = draft.current.filter(item => item.collection === 'foods').filter(item => item.parentLocalId === meal.localId).map((food, index) => {
              targets[food.localId] = id
              const lastEdit = draft.decisions.filter(d => d.op === 'set' && d.localId === food.localId && d.field === 'quantityText').at(-1)
              const explicitlyEmpty = (lastEdit?.op === 'set' && lastEdit.after === '' && (lastEdit.before !== null || lastEdit.reason === 'confirmed_missing'))
                || draft.decisions.some(d => (d.op === 'add' && d.localId === food.localId)
                  || (d.op === 'confirm' && d.localId === food.localId && d.field === 'quantityText' && d.issueCode === 'food_quantity_missing' && d.reason === 'confirmed_missing' && d.value === food.values.quantityText))
              if ((food.values.quantityText === null || food.values.quantityText.trim() === '') && !explicitlyEmpty) {
                issues.push(problem('diet_quantity_confirmation', 'Confermare esplicitamente la quantità non indicata.', food.localId))
              }
              if (lastEdit?.op === 'set' && lastEdit.before === null && lastEdit.after === '' && lastEdit.reason !== 'confirmed_missing') {
                issues.push(problem('diet_quantity_confirmation', 'Confermare esplicitamente la quantità non indicata.', food.localId))
              }
              for (const note of food.values.notes) notes.push(`${food.values.name ?? ''} (alimento ${index + 1}): ${note}`)
              // A remaining null is blocked by validation; no inferred gram or portion value.
              return { name: food.values.name ?? '', quantity: food.values.quantityText ?? '' }
            })
            if (!foods.length && !meal.values.alternatives.some(line => line.trim())) {
              issues.push(problem('diet_empty_meal', 'Il pasto non contiene alimenti né opzioni complete: risolverlo o rimuoverlo.', meal.localId))
            }
            return { id, name: meal.values.name ?? '', time: meal.values.timeText ?? '', foods,
              alternatives: [...meal.values.alternatives], additions: [...meal.values.additions], note: notes.join('\n') }
          }) }
      }),
    },
  }
  // The validator 06 checks alternative/addition copies; check the other projected text scopes too.
  for (const day of plan.document.days) {
    const localTexts = [day.note, ...day.meals.flatMap(meal => [meal.note, ...meal.foods.map(food => food.quantity)])]
    if (globalTexts.some(global => global.trim() && localTexts.some(text => text.includes(global)))) {
      issues.push(problem('diet_global_rule_local_note', 'Una regola dell’intero piano è copiata in una nota o quantità locale: chiarire l’ambito.'))
    }
  }
  const result = finishMapping({ plan }, issues, resolvedPayloadContract.diet)
  if (!result.ok) return result
  const error = validateMealPlanDraft(plan) ?? mealPlanTooLarge(plan.document)
  if (error) return finishMapping<DietMapping>(null, [problem('diet_domain_invalid', error)])
  return finishMapping({ plan, resolved: result.value, targets }, issues)
}
