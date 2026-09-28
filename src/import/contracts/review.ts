/**
 * Contratti della revisione (specifica §§7.5, 9.2–9.3, 10): problemi applicativi, scelte del
 * catalogo e bozza con proposta immutabile, ID locali e decisioni tracciate. Qui solo forma,
 * riferimenti e regole fra campi: assegnazione degli ID, replay e stato sono del task 07,
 * classificazione dei problemi del 06, matching dell'08.
 */
import { domainLimits, trimmedDomainText, domainText } from './domain-limits.ts'
import {
  dietExtractionSchema, extractedComplexRuleSchema, extractedDietDaySchema, extractedDietRuleSchema, extractedExerciseSchema,
  extractedFoodSchema, extractedMealSchema, extractedSessionSchema, proposalPointerSchema, workoutExtractionSchema,
  type DietExtraction, type ExtractionKind, type WorkoutExtraction,
} from './extraction.ts'
import { readerVersionSchema, sourceRefsSchema, TEXT_NORMALIZATION_VERSION } from './normalized-document.ts'
import {
  array, boolean, contractLimits, enumeration, errorList, escapePointerToken, jsonValue, literal, nullable, number, object, objectFields,
  pick, refine, sha256HexSchema, string, taggedUnion, uuidSchema, validate,
  type Infer, type JsonValue, type Schema, type ValidationResult,
} from './schema.ts'

// ---------------------------------------------------------------------------
// Identificatori locali
// ---------------------------------------------------------------------------

/** ID locale opaco assegnato dall'app (es. UUID o `ex-3`): stabile per tutta la revisione, mai un ID del database. */
export const LOCAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/
export const localIdSchema = string({ minLength: 1, maxLength: contractLimits.idChars, pattern: LOCAL_ID_PATTERN })
/** Nome di un campo di primo livello di un elemento della proposta (`sets`, `restSeconds`, `quantityText`…). */
export const fieldNameSchema = string({ minLength: 1, maxLength: contractLimits.codeChars, pattern: /^[a-z][A-Za-z0-9]*$/ })
/** Codice stabile di un problema applicativo, definito dalle regole (06), mai dal modello. */
export const issueCodeSchema = string({ minLength: 1, maxLength: contractLimits.codeChars, pattern: /^[a-z][a-z0-9_]*$/ })

// ---------------------------------------------------------------------------
// Problemi applicativi
// ---------------------------------------------------------------------------

/**
 * blocking: impedisce il salvataggio finché non è risolto; confirmation: richiede una decisione
 * esplicita; info: visibile, non richiede azioni. La severità deriva dalla tabella delle regole
 * applicative (06): ExtractionIssue del modello non ha severità e non la determina.
 */
export const validationIssueSeverities = ['blocking', 'confirmation', 'info'] as const
/** Fase che ha rilevato il problema. */
export const validationStages = ['reading', 'extraction', 'validation', 'catalog', 'mapping'] as const
/** Motivi delle decisioni di revisione (specifica §9.2). */
export const decisionReasons = ['user_edit', 'catalog_choice', 'timer_choice', 'confirmed_missing', 'scope_choice'] as const
/**
 * Come si può chiudere un problema: una decisione con uno dei motivi, la rimozione dell'elemento,
 * una nuova analisi. `none` solo per info. Un problema blocking non si chiude con `confirmed_missing`:
 * una sola conferma non basta per una criticità.
 */
export const issueResolutions = [...decisionReasons, 'remove_item', 'reanalyze', 'none'] as const

export const validationIssueSchema = refine(object({
  code: issueCodeSchema,
  severity: enumeration(validationIssueSeverities),
  stage: enumeration(validationStages),
  /** Elemento corrente della revisione, se esiste. */
  localId: nullable(localIdSchema),
  /** JSON Pointer sulla proposta immutabile; '' per problemi dell'intero documento. */
  sourcePath: nullable(proposalPointerSchema),
  sourceRefs: sourceRefsSchema,
  message: string({ minLength: 1, maxLength: contractLimits.textChars }),
  resolutions: array(enumeration(issueResolutions), { minItems: 1, maxItems: issueResolutions.length }),
}), [{
  code: 'missing_local_id', description: 'localId oppure sourcePath presente.',
  check(issue, report) { if (issue.localId === null && issue.sourcePath === null) report('', 'Serve un elemento locale oppure un percorso nella proposta.') },
}, {
  code: 'decision_reason', description: 'Risoluzioni coerenti con la severità.',
  check(issue, report) {
    if (new Set(issue.resolutions).size !== issue.resolutions.length) report('/resolutions', 'Risoluzioni ripetute.')
    if (issue.resolutions.includes('none') && (issue.resolutions.length > 1 || issue.severity !== 'info')) report('/resolutions', '`none` vale solo, e solo per i problemi informativi.')
    if (issue.severity === 'blocking' && issue.resolutions.includes('confirmed_missing')) report('/resolutions', 'Un problema bloccante non si chiude con la sola conferma del vuoto.')
  },
}])

export type ValidationIssueSeverity = typeof validationIssueSeverities[number]
export type ValidationStage = typeof validationStages[number]
export type DecisionReason = typeof decisionReasons[number]
export type IssueResolution = typeof issueResolutions[number]
export type ValidationIssue = Infer<typeof validationIssueSchema>

export function validateValidationIssue(value: unknown): ValidationResult<ValidationIssue> {
  return validate(validationIssueSchema, value)
}
/** Il salvataggio resta impossibile finché esiste almeno un problema bloccante. */
export const hasBlockingIssue = (issues: readonly ValidationIssue[]) => issues.some(issue => issue.severity === 'blocking')

// ---------------------------------------------------------------------------
// Scelte del catalogo esercizi
// ---------------------------------------------------------------------------

/**
 * Valori di un esercizio come li vede o li conferma l'utente (ExerciseValues senza archivedAt).
 * Per existing/shared è l'identità vista nella preview; per new sono i metadati confermati:
 * kg, false o total proposti dall'app restano scelte dell'utente, non contenuto estratto.
 */
export const catalogExerciseValuesSchema = object({
  name: trimmedDomainText(domainLimits.exercise.name),
  variant: domainText(domainLimits.exercise.variant),
  equipment: domainText(domainLimits.exercise.equipment),
  loadConvention: enumeration(['total', 'single-dumbbell', 'bodyweight']),
  loadUnit: enumeration(['kg', 'lb']),
  measurementMode: enumeration(['reps', 'seconds']),
  perSide: boolean(),
  note: domainText(domainLimits.exercise.note),
})

/**
 * Scelta esplicita per un'occorrenza del documento. Nessun ID inventato: `personalId` e
 * `templateId` vengono da uno snapshot del catalogo letto dall'app e sono riverificati dal
 * server; `localKey` è una chiave locale che più occorrenze possono condividere per indicare
 * lo stesso nuovo esercizio (valori identici), ciascuna con la propria prescrizione.
 * - existing: esercizio personale attivo con la revisione vista (conflitto se cambiata).
 * - shared: template comune da adottare nella transazione di conferma, mai in preview.
 * - new: esercizio personale da creare nella transazione di conferma, mai in preview.
 */
export const exerciseChoiceSchema = taggedUnion('source', [
  object({ source: literal('existing'), personalId: uuidSchema, revision: number({ integer: true, minimum: 1 }), seen: catalogExerciseValuesSchema }),
  object({ source: literal('shared'), templateId: uuidSchema, seen: catalogExerciseValuesSchema }),
  object({ source: literal('new'), localKey: localIdSchema, values: catalogExerciseValuesSchema }),
])

export type CatalogExerciseValues = Infer<typeof catalogExerciseValuesSchema>
export type ExerciseChoice = Infer<typeof exerciseChoiceSchema>
export type ExerciseChoiceSource = ExerciseChoice['source']

/** Valori mostrati nella preview per una scelta, qualunque sia la fonte. */
export const exerciseChoiceValues = (choice: ExerciseChoice): CatalogExerciseValues => choice.source === 'new' ? choice.values : choice.seen

export function validateExerciseChoice(value: unknown): ValidationResult<ExerciseChoice> {
  return validate(exerciseChoiceSchema, value)
}

// ---------------------------------------------------------------------------
// Bozza di revisione: proposta immutabile, ID locali, decisioni, contenuto corrente
// ---------------------------------------------------------------------------

export const REVIEW_DRAFT_FORMAT = 'peppitness.review-draft.v1'

export const reviewCollections = {
  workout: ['root', 'sessions', 'exercises', 'complexRules'],
  diet: ['root', 'days', 'meals', 'foods', 'globalRules'],
} as const
export type WorkoutReviewCollection = typeof reviewCollections.workout[number]
export type DietReviewCollection = typeof reviewCollections.diet[number]
export type ReviewCollection = WorkoutReviewCollection | DietReviewCollection

/** Collezione del genitore; la radice non ne ha. */
export const reviewCollectionParents: Record<ReviewCollection, ReviewCollection | null> = {
  root: null, sessions: 'root', exercises: 'sessions', complexRules: 'root',
  days: 'root', meals: 'days', foods: 'meals', globalRules: 'root',
}
/** Elementi che l'utente può aggiungere; le regole esistono solo con le proprie fonti. */
export const addableReviewCollections = ['sessions', 'exercises', 'days', 'meals', 'foods'] as const

/** Valori modificabili di ciascun elemento: campi del DTO senza le collezioni figlie né le prove. */
export const reviewValueSchemas = {
  workout: {
    root: pick(workoutExtractionSchema, ['title', 'guidance', 'schedule', 'cycle']),
    sessions: pick(extractedSessionSchema, ['label', 'title', 'weekday', 'notes']),
    exercises: extractedExerciseSchema,
    complexRules: extractedComplexRuleSchema,
  },
  diet: {
    root: pick(dietExtractionSchema, ['title', 'guidance']),
    days: pick(extractedDietDaySchema, ['name', 'dayType', 'notes']),
    meals: pick(extractedMealSchema, ['name', 'timeText', 'alternatives', 'additions', 'notes']),
    foods: extractedFoodSchema,
    globalRules: extractedDietRuleSchema,
  },
} as const

/** Profondità dei valori prima/dopo: bastano range e cicli, non strutture arbitrarie. */
const DECISION_VALUE_DEPTH = 4
const decisionValue = jsonValue({ maxDepth: DECISION_VALUE_DEPTH })

/**
 * Decisioni in ordine di applicazione. `set` registra valore precedente e confermato di un
 * campo; `add`, `remove` e `move` tracciano struttura e ordine; `catalog` la scelta
 * dell'esercizio; `confirm` una conferma legata al valore visto (un edit successivo la invalida).
 * Un valore dell'utente non riceve citazioni: la provenienza resta la decisione stessa.
 */
export const reviewDecisionSchema = taggedUnion('op', [
  object({
    op: literal('set'), decisionId: localIdSchema, localId: localIdSchema, field: fieldNameSchema,
    before: decisionValue, after: decisionValue,
    reason: enumeration(['user_edit', 'timer_choice', 'confirmed_missing', 'scope_choice']),
  }),
  object({
    op: literal('add'), decisionId: localIdSchema, localId: localIdSchema,
    collection: enumeration(addableReviewCollections), parentLocalId: localIdSchema,
    index: number({ integer: true, minimum: 0 }), values: decisionValue, reason: literal('user_edit'),
  }),
  object({ op: literal('remove'), decisionId: localIdSchema, localId: localIdSchema, reason: enumeration(['user_edit', 'scope_choice']) }),
  object({
    op: literal('move'), decisionId: localIdSchema, localId: localIdSchema,
    fromParentLocalId: localIdSchema, fromIndex: number({ integer: true, minimum: 0 }),
    toParentLocalId: localIdSchema, toIndex: number({ integer: true, minimum: 0 }), reason: literal('user_edit'),
  }),
  object({
    op: literal('catalog'), decisionId: localIdSchema, localId: localIdSchema,
    before: nullable(exerciseChoiceSchema), after: nullable(exerciseChoiceSchema), reason: literal('catalog_choice'),
  }),
  object({
    op: literal('confirm'), decisionId: localIdSchema, localId: localIdSchema, field: nullable(fieldNameSchema),
    issueCode: issueCodeSchema, value: decisionValue, reason: enumeration(['confirmed_missing', 'scope_choice']),
  }),
])

const itemBase = { localId: localIdSchema, parentLocalId: nullable(localIdSchema) }
const workoutItemSchema = taggedUnion('collection', [
  object({ collection: literal('root'), ...itemBase, values: reviewValueSchemas.workout.root }),
  object({ collection: literal('sessions'), ...itemBase, values: reviewValueSchemas.workout.sessions }),
  object({ collection: literal('exercises'), ...itemBase, values: reviewValueSchemas.workout.exercises, catalog: nullable(exerciseChoiceSchema) }),
  object({ collection: literal('complexRules'), ...itemBase, values: reviewValueSchemas.workout.complexRules }),
])
const dietItemSchema = taggedUnion('collection', [
  object({ collection: literal('root'), ...itemBase, values: reviewValueSchemas.diet.root }),
  object({ collection: literal('days'), ...itemBase, values: reviewValueSchemas.diet.days }),
  object({ collection: literal('meals'), ...itemBase, values: reviewValueSchemas.diet.meals }),
  object({ collection: literal('foods'), ...itemBase, values: reviewValueSchemas.diet.foods }),
  object({ collection: literal('globalRules'), ...itemBase, values: reviewValueSchemas.diet.globalRules }),
])

/** Origine della proposta: la fonte locale e l'analisi che l'ha prodotta. */
export const proposalSourceSchema = object({
  sourceHash: sha256HexSchema,
  readerVersion: readerVersionSchema,
  textNormalizationVersion: literal(TEXT_NORMALIZATION_VERSION),
})
const proposalBase = {
  /** Assegnato dall'app a ogni analisi: una nuova analisi è una proposta distinta, mai una sovrascrittura. */
  proposalId: uuidSchema,
  proposalVersion: number({ integer: true, minimum: 1 }),
  previousProposalId: nullable(uuidSchema),
  /** Job server che ha prodotto l'estrazione, se noto. */
  jobId: nullable(uuidSchema),
  source: proposalSourceSchema,
}
const localIdEntrySchema = object({ localId: localIdSchema, pointer: proposalPointerSchema })
const draftLists = { maxItems: contractLimits.largeItems }

export const reviewDraftSchema = taggedUnion('kind', [
  object({
    formatVersion: literal(REVIEW_DRAFT_FORMAT), kind: literal('workout'),
    proposal: object({ ...proposalBase, extraction: workoutExtractionSchema }),
    localIds: array(localIdEntrySchema, draftLists),
    decisions: array(reviewDecisionSchema, draftLists),
    current: array(workoutItemSchema, draftLists),
  }),
  object({
    formatVersion: literal(REVIEW_DRAFT_FORMAT), kind: literal('diet'),
    proposal: object({ ...proposalBase, extraction: dietExtractionSchema }),
    localIds: array(localIdEntrySchema, draftLists),
    decisions: array(reviewDecisionSchema, draftLists),
    current: array(dietItemSchema, draftLists),
  }),
])

export type ReviewDecision = Infer<typeof reviewDecisionSchema>
export type ReviewDecisionOp = ReviewDecision['op']
export type ReviewDraft = Infer<typeof reviewDraftSchema>
export type WorkoutReviewDraft = Extract<ReviewDraft, { kind: 'workout' }>
export type DietReviewDraft = Extract<ReviewDraft, { kind: 'diet' }>
export type ReviewItem = ReviewDraft['current'][number]
export type ProposalSource = Infer<typeof proposalSourceSchema>

/** Elemento della proposta immutabile a cui l'app assegna un ID locale. */
export interface ProposalItem { pointer: string; collection: ReviewCollection; parentPointer: string | null }

/**
 * Tutti gli elementi della proposta, nell'ordine della fonte: la mappa localId→pointer della
 * bozza ne contiene esattamente uno per elemento. La radice ha pointer ''.
 */
export function enumerateProposalItems(extraction: WorkoutExtraction | DietExtraction): ProposalItem[] {
  const items: ProposalItem[] = [{ pointer: '', collection: 'root', parentPointer: null }]
  const add = (pointer: string, collection: ReviewCollection, parentPointer: string) => { items.push({ pointer, collection, parentPointer }); return pointer }
  if (extraction.kind === 'workout') {
    extraction.sessions.forEach((session, index) => {
      const at = add(`/sessions/${index}`, 'sessions', '')
      session.exercises.forEach((_, position) => add(`${at}/exercises/${position}`, 'exercises', at))
    })
    extraction.complexRules.forEach((_, index) => add(`/complexRules/${index}`, 'complexRules', ''))
  } else {
    extraction.days.forEach((day, index) => {
      const at = add(`/days/${index}`, 'days', '')
      day.meals.forEach((meal, position) => {
        const mealAt = add(`${at}/meals/${position}`, 'meals', at)
        meal.foods.forEach((_, food) => add(`${mealAt}/foods/${food}`, 'foods', mealAt))
      })
    })
    extraction.globalRules.forEach((_, index) => add(`/globalRules/${index}`, 'globalRules', ''))
  }
  return items
}

/** Uguaglianza strutturale di valori JSON (chiavi in qualsiasi ordine). */
export function sameJsonValue(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) return a.length === (b as JsonValue[]).length && a.every((item, index) => sameJsonValue(item, (b as JsonValue[])[index]!))
  const left = Object.keys(a), right = b as Record<string, JsonValue>
  return left.length === Object.keys(right).length && left.every(key => Object.hasOwn(right, key) && sameJsonValue(a[key]!, right[key]!))
}

const isRange = (value: JsonValue): value is { min: number; max: number } =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.min === 'number' && typeof value.max === 'number'

function draftStructureErrors(draft: ReviewDraft) {
  const errors = errorList()
  const kind: ExtractionKind = draft.kind
  const valueSchemas: Record<string, Schema<unknown>> = reviewValueSchemas[kind]
  const fieldsOf = (collection: ReviewCollection) => objectFields(valueSchemas[collection]!)
  const nested = (prefix: string, schema: Schema<unknown>, value: unknown) => {
    const result = validate(schema, value)
    if (!result.ok) result.errors.forEach(error => errors.add(prefix + error.path, error.code, error.message))
    return result.ok
  }

  if ((draft.proposal.proposalVersion === 1) !== (draft.proposal.previousProposalId === null)) {
    errors.add('/proposal/previousProposalId', 'kind_mismatch', 'Solo la prima proposta non ha una proposta precedente.')
  }
  if (draft.proposal.previousProposalId === draft.proposal.proposalId) errors.add('/proposal/previousProposalId', 'self_ref', 'Una proposta non precede sé stessa.')

  // Mappa localId → pointer: completa, univoca e risolta sulla proposta immutabile.
  const expected = new Map(enumerateProposalItems(draft.proposal.extraction).map(item => [item.pointer, item]))
  const collectionOf = new Map<string, ReviewCollection>()
  const pointers = new Set<string>()
  let rootLocalId: string | null = null
  draft.localIds.forEach((entry, index) => {
    const at = `/localIds/${index}`
    const item = expected.get(entry.pointer)
    if (collectionOf.has(entry.localId)) errors.add(`${at}/localId`, 'duplicate_id', `ID locale ripetuto: ${entry.localId}.`)
    else if (item) collectionOf.set(entry.localId, item.collection)
    if (pointers.has(entry.pointer)) errors.add(`${at}/pointer`, 'duplicate_ref', 'Elemento della proposta con due ID locali.')
    pointers.add(entry.pointer)
    if (!item) errors.add(`${at}/pointer`, 'dangling_ref', 'Il puntatore non indica un elemento della proposta.')
    else if (item.collection === 'root') rootLocalId = entry.localId
  })
  for (const pointer of expected.keys()) {
    if (!pointers.has(pointer)) errors.add('/localIds', 'missing_local_id', `Elemento della proposta senza ID locale: "${pointer}".`)
  }

  // Decisioni in ordine: ogni riferimento esiste già quando la decisione viene applicata.
  const decisionIds = new Set<string>()
  const removed = new Set<string>()
  const known = (at: string, localId: string) => {
    if (!collectionOf.has(localId)) { errors.add(at, 'dangling_ref', `ID locale sconosciuto: ${localId}.`); return null }
    return collectionOf.get(localId)!
  }
  const parentFits = (at: string, parentLocalId: string, collection: ReviewCollection) => {
    const parent = known(at, parentLocalId)
    if (parent && parent !== reviewCollectionParents[collection]) errors.add(at, 'parent_mismatch', `Un elemento ${collection} non può stare sotto ${parent}.`)
  }
  draft.decisions.forEach((decision, index) => {
    const at = `/decisions/${index}`
    if (decisionIds.has(decision.decisionId)) errors.add(`${at}/decisionId`, 'duplicate_id', `Decisione ripetuta: ${decision.decisionId}.`)
    decisionIds.add(decision.decisionId)
    if (decision.op === 'add') {
      if (collectionOf.has(decision.localId)) { errors.add(`${at}/localId`, 'duplicate_id', 'Un elemento aggiunto richiede un ID locale nuovo.'); return }
      if (!(reviewCollections[kind] as readonly string[]).includes(decision.collection)) { errors.add(`${at}/collection`, 'kind_mismatch', `Collezione non valida per ${kind}.`); return }
      parentFits(`${at}/parentLocalId`, decision.parentLocalId, decision.collection)
      nested(`${at}/values`, valueSchemas[decision.collection]!, decision.values)
      collectionOf.set(decision.localId, decision.collection)
      return
    }
    const collection = known(`${at}/localId`, decision.localId)
    if (!collection) return
    if (removed.has(decision.localId)) errors.add(`${at}/localId`, 'dangling_ref', 'Elemento già rimosso.')
    switch (decision.op) {
      case 'set': {
        const field = fieldsOf(collection).get(decision.field)
        if (!field) { errors.add(`${at}/field`, 'unknown_field', `Campo non modificabile per ${collection}.`); return }
        const valid = nested(`${at}/before`, field, decision.before) && nested(`${at}/after`, field, decision.after)
        if (valid && sameJsonValue(decision.before, decision.after)) errors.add(at, 'no_op_decision', 'Il valore confermato coincide con il precedente.')
        if (decision.reason === 'timer_choice' && (collection !== 'exercises' || !['restSeconds', 'durationSeconds'].includes(decision.field)
          || !isRange(decision.after) || decision.after.min !== decision.after.max)) {
          errors.add(`${at}/reason`, 'decision_reason', 'La scelta del timer fissa un solo valore di recupero o durata.')
        }
        if (decision.reason === 'confirmed_missing' && decision.before !== null) errors.add(`${at}/reason`, 'decision_reason', 'Si conferma il vuoto solo di un valore mancante.')
        return
      }
      case 'remove':
      case 'move':
        if (collection === 'root') { errors.add(`${at}/localId`, 'parent_mismatch', 'La radice non si rimuove né si sposta.'); return }
        if (decision.op === 'remove') removed.add(decision.localId)
        else {
          parentFits(`${at}/fromParentLocalId`, decision.fromParentLocalId, collection)
          parentFits(`${at}/toParentLocalId`, decision.toParentLocalId, collection)
          if (decision.fromParentLocalId === decision.toParentLocalId && decision.fromIndex === decision.toIndex) errors.add(at, 'no_op_decision', 'Spostamento senza effetto.')
        }
        return
      case 'catalog':
        if (collection !== 'exercises') errors.add(`${at}/localId`, 'kind_mismatch', 'Le scelte del catalogo valgono solo per gli esercizi.')
        else if (sameJsonValue(decision.before, decision.after)) errors.add(at, 'no_op_decision', 'La scelta coincide con la precedente.')
        return
      case 'confirm':
        if (decision.field !== null && !fieldsOf(collection).has(decision.field)) errors.add(`${at}/field`, 'unknown_field', `Campo inesistente per ${collection}.`)
        return
    }
  })

  // Contenuto corrente: una radice, genitori presenti e coerenti, nessun elemento rimosso.
  const current = draft.current as readonly ReviewItem[]
  const present = new Map<string, ReviewCollection>()
  current.forEach((item, index) => {
    if (present.has(item.localId)) errors.add(`/current/${index}/localId`, 'duplicate_id', `Elemento ripetuto: ${item.localId}.`)
    present.set(item.localId, item.collection)
  })
  const roots = current.filter(item => item.collection === 'root')
  if (roots.length !== 1) errors.add('/current', 'missing_local_id', 'Il contenuto corrente ha esattamente una radice.')
  const newValues = new Map<string, JsonValue>()
  current.forEach((item, index) => {
    const at = `/current/${index}`
    const collection = known(`${at}/localId`, item.localId)
    if (collection && collection !== item.collection) errors.add(`${at}/collection`, 'kind_mismatch', `L'elemento ${item.localId} appartiene a ${collection}.`)
    if (removed.has(item.localId)) errors.add(`${at}/localId`, 'dangling_ref', 'Elemento rimosso ancora presente.')
    if (item.collection === 'root') {
      if (item.parentLocalId !== null) errors.add(`${at}/parentLocalId`, 'parent_mismatch', 'La radice non ha genitore.')
      if (item.localId !== rootLocalId) errors.add(`${at}/localId`, 'kind_mismatch', 'La radice usa l’ID locale assegnato al puntatore "".')
    } else if (item.parentLocalId === null || present.get(item.parentLocalId) !== reviewCollectionParents[item.collection]) {
      errors.add(`${at}/parentLocalId`, 'parent_mismatch', `Genitore assente o non di tipo ${reviewCollectionParents[item.collection]}.`)
    }
    if (item.collection === 'exercises' && item.catalog?.source === 'new') {
      const seen = newValues.get(item.catalog.localKey)
      if (seen === undefined) newValues.set(item.catalog.localKey, item.catalog.values)
      else if (!sameJsonValue(seen, item.catalog.values)) errors.add(`${at}/catalog/values`, 'binding_mismatch', 'Occorrenze dello stesso nuovo esercizio con valori diversi.')
    }
  })
  return errors.errors
}

/**
 * Forma chiusa, mappa degli ID completa, decisioni con riferimenti, campi e motivi coerenti,
 * contenuto corrente ben formato. La coincidenza fra replay delle decisioni e `current` è
 * verificata dal motore di revisione (07), che usa questo validatore come ingresso.
 */
export function validateReviewDraft(value: unknown): ValidationResult<ReviewDraft> {
  const shape = validate(reviewDraftSchema, value)
  if (!shape.ok) return shape
  const errors = draftStructureErrors(shape.value)
  return errors.length ? { ok: false, errors } : shape
}

/** Percorso JSON Pointer di un campo di un elemento della proposta. */
export const proposalFieldPointer = (itemPointer: string, field: string) => `${itemPointer}/${escapePointerToken(field)}`
