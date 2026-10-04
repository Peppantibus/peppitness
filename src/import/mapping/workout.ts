import { programPayload, validateProgram, type ProgramDocument, type ProgramCycle } from '../../domain/programs.ts'
import { isWeekly, weekdays } from '../../domain/weekly.ts'
import { finishMapping, provisionalExerciseRefs, resolvedPayloadContract, type MappingResult, type ResolvedWorkoutImport } from '../contracts/commit.ts'
import { validateNormalizedDocument, type NormalizedDocument } from '../contracts/normalized-document.ts'
import { exerciseChoiceValues, sameJsonValue, type ExerciseChoice, type ValidationIssue, type WorkoutReviewDraft } from '../contracts/review.ts'
import { identityFields } from '../matching/exercises.ts'
import { openFindings, verifyDraft } from '../review/decisions.ts'
import { textOf } from '../validation/issues.ts'
import { draftRuleItems, validateDraft } from '../validation/validate.ts'
import { instructionCanBeKept } from '../validation/workout-instructions.ts'

/** Reserve once in review state. Keys are local item IDs and exerciseChoiceKey(choice). */
export interface WorkoutMappingIds {
  planId: string
  versionId: string
  items: Readonly<Record<string, string>>
  exercises: Readonly<Record<string, string>>
}
export interface WorkoutMapping {
  resolved: ResolvedWorkoutImport
  program: ProgramDocument
  cycle: ProgramCycle | null
  /** Preview references only: never send to the manual save RPCs or start a diary session. */
  provisionalRefs: string[]
  targets: Record<string, string | null>
}
export const exerciseChoiceKey = (choice: ExerciseChoice) => choice.source === 'existing' ? `existing:${choice.personalId}`
  : choice.source === 'shared' ? `shared:${choice.templateId}` : `new:${choice.localKey}`

const problem = (code: string, message: string, localId: string | null = null): ValidationIssue => ({
  code, message, localId, severity: 'blocking', stage: 'mapping', sourcePath: null, sourceRefs: [], resolutions: ['user_edit'],
})
const scalar = (value: { min: number; max: number } | null) => value !== null && value.min === value.max ? value.min : null
const numberText = (value: number | null) => value === null ? '' : String(value)

/** Projection is derived only from the validated resolved payload, never independently from the DTO. */
function project(resolved: ResolvedWorkoutImport): ProgramDocument {
  const choices = new Map(resolved.catalog.map(binding => [binding.ref, binding.choice]))
  return { planId: resolved.planId, id: resolved.versionId, title: resolved.title, guidance: resolved.guidance,
    days: resolved.days.map(day => ({ id: day.id, label: day.label, title: day.title, note: day.note,
      exercises: day.prescriptions.map(p => ({ id: p.id, exercise: { id: p.exerciseRef, ...exerciseChoiceValues(choices.get(p.exerciseRef)!) },
        sets: String(p.sets), optionalSets: String(p.optionalSets), repsMin: numberText(p.repsMin), repsMax: numberText(p.repsMax),
        durationSeconds: numberText(p.durationSeconds), restSeconds: String(p.restSeconds), rir: numberText(p.rir), rpe: numberText(p.rpe), note: p.note })) })) }
}

/** Pure mapper; source validation and replay are checked again so a stale/tampered review cannot succeed. */
export function mapReviewedWorkout(document: NormalizedDocument, draft: WorkoutReviewDraft, ids: WorkoutMappingIds): MappingResult<WorkoutMapping> {
  const issues: ValidationIssue[] = []
  const checked = verifyDraft(draft)
  if (!checked.ok || checked.draft.kind !== 'workout' || !validateNormalizedDocument(document).ok) {
    return finishMapping<WorkoutMapping>(null, [problem('workout_invalid_review', 'Fonte o revisione non valida.')])
  }
  if (draft.proposal.extraction.outcome !== 'extracted') return finishMapping<WorkoutMapping>(null, [problem('workout_no_content', 'La proposta non contiene una scheda importabile.')])
  for (const finding of openFindings(draft, validateDraft(document, draft).findings)) {
    issues.push({ ...finding.issue, code: 'workout_review_required', stage: 'mapping', severity: 'blocking',
      message: `${finding.issue.code}: ${finding.issue.message}` })
  }
  const root = draft.current.find(item => item.collection === 'root')!
  const sessions = draft.current.filter(item => item.collection === 'sessions')
  const rules = draft.current.filter(item => item.collection === 'complexRules')
  const ruleItems = draftRuleItems(draft)
  const targets: Record<string, string | null> = { [root.localId]: null }
  const guidance = [...root.values.guidance]
  const catalog = new Map<string, ResolvedWorkoutImport['catalog'][number]>()
  const edited = (localId: string, field: string) => draft.decisions.filter(d => d.op === 'set' && d.localId === localId && d.field === field)
  if (root.values.schedule === 'unknown') issues.push(problem('workout_schedule_required', 'Scegliere calendario settimanale o rotazione.', root.localId))
  for (const rule of rules) {
    targets[rule.localId] = null
    const complex = ['phase', 'progression', 'deload', 'superset', 'circuit'].includes(rule.values.kind)
    const preserved = instructionCanBeKept(ruleItems.find(i => i.localId === rule.localId)!, ruleItems)
    const resolution = edited(rule.localId, 'text').at(-1)
    // A checkbox acknowledging a limitation does not identify the selected phase/week or manual solution.
    if (complex && !preserved && (!resolution || resolution.reason !== 'scope_choice' || !rule.values.text.trim())) {
      issues.push(problem('workout_scope_instruction_required', 'Descrivere nella regola la fase/settimana scelta o la soluzione manuale (scope_choice), poi confermarla.', rule.localId))
    }
    if (complex && !preserved && resolution) {
      const lastAcknowledgement = Math.max(draft.decisions.indexOf(resolution), ...draft.decisions.map((d, index) =>
        d.op === 'confirm' && d.localId === rule.localId && d.issueCode === 'complex_rule_unresolved' && d.reason === 'scope_choice' ? index : -1))
      const changedExecution = draft.decisions.some((d, index) => index > lastAcknowledgement
        && (d.op === 'move' || d.op === 'remove' || d.op === 'add' || (d.op === 'set'
          && ['sets', 'optionalSets', 'repetitions', 'durationSeconds', 'measurementMode'].includes(d.field)))
        && !rules.some(r => r.localId === d.localId))
      if (changedExecution) issues.push(problem('workout_scope_stale', 'La scheda è cambiata dopo la scelta della fase: verificarla e confermare di nuovo la regola.', rule.localId))
    }
    const scopes: string[] = []
    for (const path of rule.values.targetPaths) {
      const target = draft.current.find(item => draft.localIds.some(entry => entry.localId === item.localId && entry.pointer === path))
      if (!target || !['sessions', 'exercises'].includes(target.collection)) {
        issues.push(problem('workout_rule_target_missing', 'Risolvere esplicitamente l’ambito della regola dopo la selezione delle sedute.', rule.localId))
      } else if (target.collection === 'sessions') scopes.push(`seduta ${target.values.label}: ${target.values.title}`)
      else if (target.collection === 'exercises') {
        const parent = sessions.find(s => s.localId === target.parentLocalId)!
        const position = draft.current.filter(i => i.collection === 'exercises' && i.parentLocalId === parent.localId).findIndex(i => i.localId === target.localId) + 1
        scopes.push(`seduta ${parent.values.label}, esercizio ${position}: ${target.catalog ? exerciseChoiceValues(target.catalog).name : target.values.name}`)
      }
    }
    const scope = scopes.length ? scopes.join('; ') : 'intera scheda'
    const originalRule = edited(rule.localId, 'text')[0]
    if (complex && originalRule?.op === 'set') guidance.push(`[${rule.values.kind} — ${scope}; regola prima della scelta] ${textOf(originalRule.before)}`)
    guidance.push(`[${rule.values.kind} — ${scope}] ${rule.values.text}`)
  }
  if (rules.some(rule => ['phase', 'progression', 'deload', 'superset', 'circuit'].includes(rule.values.kind))) {
    guidance.push('Limite di esecuzione: il programma ripete le prescrizioni selezionate; fasi, progressioni, scarichi, superserie e circuiti richiedono la gestione manuale descritta nelle regole.')
  }
  const days: ResolvedWorkoutImport['days'] = sessions.map(session => {
    const s = session.values
    const note = [...s.notes]
    let label = s.label ?? ''
    if (root.values.schedule === 'weekly') {
      if (s.weekday === null) issues.push(problem('workout_weekday_required', 'Assegnare esplicitamente il giorno della seduta.', session.localId))
      else {
        label = weekdays[s.weekday - 1]!.code
        if (s.label !== null && s.label !== label) note.push(`Etichetta della fonte: ${s.label}`)
      }
    } else if (s.weekday !== null) issues.push(problem('workout_rotation_weekday', 'Una rotazione non può perdere un giorno esplicito: risolvere calendario o giorno.', session.localId))
    targets[session.localId] = ids.items[session.localId] ?? ''
    return { id: ids.items[session.localId] ?? '', label, title: s.title ?? '', note: note.join('\n'),
      prescriptions: draft.current.filter(item => item.collection === 'exercises').filter(item => item.parentLocalId === session.localId).map(item => {
        const v = item.values, notes = [...v.notes]
        targets[item.localId] = ids.items[item.localId] ?? ''
        let exerciseRef = ''
        if (item.catalog) {
          const key = exerciseChoiceKey(item.catalog)
          exerciseRef = item.catalog.source === 'existing' ? item.catalog.personalId : ids.exercises[key] ?? ''
          const previous = catalog.get(key)
          if (previous && !sameJsonValue(previous.choice, item.catalog)) issues.push(problem('workout_catalog_changed', 'La stessa identità ha snapshot diversi: scegliere di nuovo dal catalogo.', item.localId))
          else catalog.set(key, { ref: exerciseRef, choice: structuredClone(item.catalog) })
          const selected = exerciseChoiceValues(item.catalog)
          for (const field of identityFields) if (v[field] !== null && v[field] !== selected[field]) {
            const changed = edited(item.localId, field).at(-1)
            const lastChoice = Math.max(-1, ...draft.decisions.map((d, index) => d.op === 'catalog' && d.localId === item.localId ? index : -1))
            if (changed && draft.decisions.indexOf(changed) > lastChoice) issues.push(problem('workout_identity_choice_required', `Il campo ${field} è cambiato dopo la scelta del catalogo: risolvere l’identità.`, item.localId))
            notes.push(`Identità dalla fonte — ${field}: ${String(v[field])}; scelta catalogo: ${String(selected[field])}`)
          }
        }
        if (v.prescriptionText !== '') notes.push(`Prescrizione dalla fonte: ${v.prescriptionText}`)
        if (v.loadInstruction !== null) notes.push(`Carico prescritto: ${v.loadInstruction}`)
        if (v.tempoInstruction !== null) notes.push(`Tempo di esecuzione: ${v.tempoInstruction}`)
        const optional = edited(item.localId, 'optionalSets').at(-1)
        if (optional?.op === 'set' && optional.before === null && optional.after === 0 && optional.reason !== 'confirmed_missing') {
          issues.push(problem('workout_optional_confirmation', 'Confermare esplicitamente l’assenza di serie facoltative.', item.localId))
        }
        for (const field of ['restSeconds', 'durationSeconds', 'rir', 'rpe'] as const) {
          const decisions = edited(item.localId, field)
          for (const decision of decisions) if (decision.op === 'set' && decision.before && typeof decision.before === 'object' && 'min' in decision.before && 'max' in decision.before) {
            const before = decision.before as { min: number; max: number }
            if (before.min !== before.max) notes.push(`${field}: intervallo prima della scelta ${before.min}–${before.max}; valore scelto ${JSON.stringify(decision.after)} (${decision.reason}).`)
          }
          const last = decisions.at(-1)
          if (last?.op === 'set' && last.reason === 'timer_choice' && last.before && typeof last.before === 'object' && 'min' in last.before && 'max' in last.before) {
            const before = last.before as { min: number; max: number }, selected = scalar(v[field])
            if (selected === null || selected < before.min || selected > before.max) issues.push(problem('workout_timer_outside_range', 'Il timer scelto è fuori intervallo: serve una modifica esplicita.', item.localId))
          }
          if (v[field] !== null && scalar(v[field]) === null) issues.push(problem('workout_scalar_required', `Risolvere ${field} con un valore esatto.`, item.localId))
        }
        // Nulls in required fields are rejected by validation/contract, never replaced by constructor defaults.
        return { id: ids.items[item.localId] ?? '', exerciseRef, sets: v.sets!, optionalSets: v.optionalSets!, repsMin: v.repetitions?.min ?? null,
          repsMax: v.repetitions?.max ?? null, durationSeconds: scalar(v.durationSeconds), restSeconds: scalar(v.restSeconds)!,
          rir: scalar(v.rir), rpe: scalar(v.rpe), note: notes.join('\n') }
      }) }
  })
  if (root.values.schedule === 'rotation' && isWeekly(days)) issues.push(problem('workout_rotation_labels', 'Le etichette Lun…Dom attivano il calendario: scegliere etichette di rotazione non ambigue.', root.localId))
  const cycle = root.values.cycle
  const resolved: ResolvedWorkoutImport = { planId: ids.planId, versionId: ids.versionId, title: root.values.title ?? '', guidance: guidance.join('\n'),
    cycle: cycle.startDate === null && cycle.weeks === null ? null : { start: cycle.startDate!, weeks: cycle.weeks! }, days, catalog: [...catalog.values()] }
  const result = finishMapping(resolved, issues, resolvedPayloadContract.workout)
  if (!result.ok) return result
  const program = project(result.value)
  const error = validateProgram(program, true)
  if (error) return finishMapping<WorkoutMapping>(null, [problem('workout_domain_invalid', error)])
  programPayload(program)
  return finishMapping({ resolved: result.value, program, cycle: result.value.cycle, provisionalRefs: [...provisionalExerciseRefs(result.value)], targets }, issues)
}
