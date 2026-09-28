/**
 * DTO V1 delle due estrazioni (specifica §5.2): proposta dell'interprete, separata dal
 * documento normalizzato e dal futuro comando di conferma. Due radici distinte, mai una
 * union inviata al provider. Qui solo forma chiusa e vincoli strutturali: prove,
 * copertura e limiti Peppitness sono verificati dopo (task 06), senza clamp.
 */
import { sourceBlockIdSchema, sourceRefsSchema } from './normalized-document.ts'
import {
  array, boolean, contractLimits, enumeration, literal, nullable, number, object, parseJson, refine, string, toJsonSchema, validate,
  type Infer, type InferProperties, type JsonObject, type ValidationResult,
} from './schema.ts'

export const EXTRACTION_SCHEMA_VERSION = '1.0'
export const WORKOUT_EXTRACTION_SCHEMA_ID = 'peppitness.workout-extraction.v1'
export const DIET_EXTRACTION_SCHEMA_ID = 'peppitness.diet-extraction.v1'
export const extractionKinds = ['workout', 'diet'] as const
export type ExtractionKind = typeof extractionKinds[number]
export const extractionSchemaIds = { workout: WORKOUT_EXTRACTION_SCHEMA_ID, diet: DIET_EXTRACTION_SCHEMA_ID } as const
export type ExtractionSchemaId = typeof extractionSchemaIds[ExtractionKind]

export const extractionOutcomes = ['extracted', 'wrong_document_type', 'no_relevant_content', 'unreadable'] as const
export const extractionIssueCodes = ['missing', 'ambiguous', 'conflicting', 'unreadable', 'unsupported'] as const
export const unassignedReasons = ['other_domain', 'unclear_scope', 'unsupported_structure'] as const

const JSON_POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/
const FIELD_POINTER = /^(?:\/(?:[^~/]|~[01])*)+$/
/** JSON Pointer RFC 6901 sulla proposta immutabile; `allowRoot` solo per i problemi dell'intero documento. */
function jsonPointer(allowRoot: boolean) {
  return refine(string({ maxLength: contractLimits.pointerChars }), [
    { code: 'json_pointer', description: 'JSON Pointer RFC 6901.', check(value, report) { if (!JSON_POINTER.test(value)) report('', 'JSON Pointer RFC 6901 non valido.') } },
    ...(allowRoot ? [] : [{
      code: 'root_pointer' as const, description: 'Mai la radice della proposta.',
      check(value: string, report: (relativePath: string, message: string) => void) { if (value === '') report('', 'La prova deve indicare un campo, non l’intera proposta.') },
    }]),
  ], { pattern: (allowRoot ? JSON_POINTER : FIELD_POINTER).source })
}

const text = string({ maxLength: contractLimits.textChars })
const texts = array(text, { maxItems: contractLimits.items })
const optionalText = nullable(text)
/** Numero finito senza limiti Peppitness: un valore fuori dominio deve restare diagnosticabile nella bozza. */
const quantity = nullable(number())

export const rangeSchema = refine(object({ min: number(), max: number() }), [{
  code: 'range_order',
  description: 'Numeri finiti con min <= max; un valore esatto usa min = max.',
  check(range, report) { if (range.min > range.max) report('', 'Intervallo invertito: min supera max.') },
}])
const optionalRange = nullable(rangeSchema)

export const evidenceSchema = object({
  path: jsonPointer(false),
  spans: array(object({ blockId: sourceBlockIdSchema, quote: string({ minLength: 1, maxLength: contractLimits.textChars }) }), { minItems: 1, maxItems: contractLimits.refsPerItem }),
})
export const extractionIssueSchema = object({
  code: enumeration(extractionIssueCodes),
  path: jsonPointer(true),
  sourceRefs: sourceRefsSchema,
  message: text,
})
export const unassignedContentSchema = object({
  sourceRefs: sourceRefsSchema,
  text,
  reason: enumeration(unassignedReasons),
})

// Ordine delle chiavi come negli esempi della specifica: contenuto prima delle prove.
const version = { schemaVersion: literal(EXTRACTION_SCHEMA_VERSION) }
const commonHead = {
  outcome: enumeration(extractionOutcomes),
  title: optionalText,
  guidance: texts,
}
const commonTail = {
  evidence: array(evidenceSchema, { maxItems: contractLimits.largeItems }),
  issues: array(extractionIssueSchema, { maxItems: contractLimits.items }),
  unassigned: array(unassignedContentSchema, { maxItems: contractLimits.items }),
}

export const extractedExerciseSchema = object({
  name: optionalText,
  variant: optionalText,
  equipment: optionalText,
  measurementMode: nullable(enumeration(['reps', 'seconds'])),
  sets: quantity,
  optionalSets: quantity,
  repetitions: optionalRange,
  durationSeconds: optionalRange,
  restSeconds: optionalRange,
  rir: optionalRange,
  rpe: optionalRange,
  perSide: nullable(boolean()),
  loadUnit: nullable(enumeration(['kg', 'lb'])),
  loadConvention: nullable(enumeration(['total', 'single-dumbbell', 'bodyweight'])),
  loadInstruction: optionalText,
  tempoInstruction: optionalText,
  prescriptionText: text,
  notes: texts,
})
export const extractedSessionSchema = object({
  label: optionalText,
  title: optionalText,
  /** 1 = lunedì … 7 = domenica, solo se esplicito: mai dedotto da A/B/C. */
  weekday: nullable(number({ integer: true, minimum: 1, maximum: 7 })),
  notes: texts,
  exercises: array(extractedExerciseSchema, { maxItems: contractLimits.items }),
})
export const extractedComplexRuleSchema = object({
  kind: enumeration(['phase', 'progression', 'deload', 'superset', 'circuit', 'cardio', 'other']),
  text,
  sourceRefs: sourceRefsSchema,
  targetPaths: array(jsonPointer(false), { maxItems: contractLimits.refsPerItem }),
})
export const workoutExtractionSchema = object({
  ...version,
  kind: literal('workout'),
  ...commonHead,
  schedule: enumeration(['weekly', 'rotation', 'unknown']),
  cycle: object({ startDate: optionalText, weeks: quantity }),
  sessions: array(extractedSessionSchema, { maxItems: contractLimits.items }),
  complexRules: array(extractedComplexRuleSchema, { maxItems: contractLimits.items }),
  ...commonTail,
})

export const extractedFoodSchema = object({ name: optionalText, quantityText: optionalText, notes: texts })
export const extractedMealSchema = object({
  name: optionalText,
  timeText: optionalText,
  foods: array(extractedFoodSchema, { maxItems: contractLimits.items }),
  /** Frasi complete, con ambito esplicito. */
  alternatives: texts,
  /** Frasi complete, comprensive della condizione. */
  additions: texts,
  notes: texts,
})
export const extractedDietDaySchema = object({
  name: optionalText,
  /** null = ignoto; `any` è una scelta semantica, non un sinonimo di sconosciuto. */
  dayType: nullable(enumeration(['training', 'rest', 'any'])),
  notes: texts,
  meals: array(extractedMealSchema, { maxItems: contractLimits.items }),
})
export const extractedDietRuleSchema = object({
  kind: enumeration(['addition', 'substitution', 'nutrition', 'other']),
  text,
  sourceRefs: sourceRefsSchema,
})
export const dietExtractionSchema = object({
  ...version,
  kind: literal('diet'),
  ...commonHead,
  days: array(extractedDietDaySchema, { maxItems: contractLimits.items }),
  globalRules: array(extractedDietRuleSchema, { maxItems: contractLimits.items }),
  ...commonTail,
})

export type Range = Infer<typeof rangeSchema>
export type Evidence = Infer<typeof evidenceSchema>
export type EvidenceSpan = Evidence['spans'][number]
export type ExtractionIssue = Infer<typeof extractionIssueSchema>
export type UnassignedContent = Infer<typeof unassignedContentSchema>
export type ExtractionOutcome = typeof extractionOutcomes[number]
export type ExtractionCommon = InferProperties<typeof version & typeof commonHead & typeof commonTail>
export type ExtractedExercise = Infer<typeof extractedExerciseSchema>
export type ExtractedSession = Infer<typeof extractedSessionSchema>
export type ExtractedComplexRule = Infer<typeof extractedComplexRuleSchema>
export type WorkoutExtraction = Infer<typeof workoutExtractionSchema>
export type ExtractedFood = Infer<typeof extractedFoodSchema>
export type ExtractedMeal = Infer<typeof extractedMealSchema>
export type ExtractedDietDay = Infer<typeof extractedDietDaySchema>
export type ExtractedDietRule = Infer<typeof extractedDietRuleSchema>
export type DietExtraction = Infer<typeof dietExtractionSchema>
export type ExtractionFor<K extends ExtractionKind> = K extends 'workout' ? WorkoutExtraction : DietExtraction

export const extractionSchemas = { workout: workoutExtractionSchema, diet: dietExtractionSchema } as const

export function validateWorkoutExtraction(value: unknown): ValidationResult<WorkoutExtraction> {
  return validate(workoutExtractionSchema, value)
}
export function validateDietExtraction(value: unknown): ValidationResult<DietExtraction> {
  return validate(dietExtractionSchema, value)
}
/** Il dominio scelto dall'utente determina lo schema: un DTO dieta non passa mai come scheda. */
export function validateExtraction<K extends ExtractionKind>(kind: K, value: unknown): ValidationResult<ExtractionFor<K>> {
  return validate<unknown>(extractionSchemas[kind], value) as ValidationResult<ExtractionFor<K>>
}
/** Distingue JSON illeggibile (`invalid_json`) da forma non conforme. */
export function parseExtractionJson<K extends ExtractionKind>(kind: K, json: string): ValidationResult<ExtractionFor<K>> {
  const parsed = parseJson(json)
  return parsed.ok ? validateExtraction(kind, parsed.value) : parsed
}

const titles = { workout: 'Peppitness workout extraction V1', diet: 'Peppitness diet extraction V1' } as const
/** JSON Schema della radice richiesta: base per la traduzione dell'adapter, che non sostituisce la validazione. */
export function extractionJsonSchema(kind: ExtractionKind): JsonObject {
  return toJsonSchema(extractionSchemas[kind], { id: extractionSchemaIds[kind], title: titles[kind] })
}
