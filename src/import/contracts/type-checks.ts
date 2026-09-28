/**
 * Verifiche a compile time (npm run typecheck): i tipi inferiti dagli schemi runtime
 * coincidono con la notazione normativa V1. Nessun codice eseguibile.
 */
import type {
  DietExtraction, ExtractedComplexRule, ExtractedDietDay, ExtractedExercise, ExtractedFood, ExtractedMeal, ExtractedSession,
  Evidence, ExtractionCommon, ExtractionIssue, Range, UnassignedContent, WorkoutExtraction,
} from './extraction.ts'
import type { NormalizedDocument, SourceBlock } from './normalized-document.ts'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T
type Same<A, B> = Equal<{ [K in keyof A]: A[K] }, { [K in keyof B]: B[K] }>

type NormativeRange = { min: number; max: number }
type NormativeExercise = {
  name: string | null; variant: string | null; equipment: string | null
  measurementMode: 'reps' | 'seconds' | null; sets: number | null
  optionalSets: number | null; repetitions: Range | null
  durationSeconds: Range | null; restSeconds: Range | null
  rir: Range | null; rpe: Range | null; perSide: boolean | null
  loadUnit: 'kg' | 'lb' | null
  loadConvention: 'total' | 'single-dumbbell' | 'bodyweight' | null
  loadInstruction: string | null; tempoInstruction: string | null
  prescriptionText: string; notes: string[]
}
type NormativeCommon = {
  schemaVersion: '1.0'
  outcome: 'extracted' | 'wrong_document_type' | 'no_relevant_content' | 'unreadable'
  title: string | null; guidance: string[]; evidence: Evidence[]
  issues: ExtractionIssue[]; unassigned: UnassignedContent[]
}

export type ContractShapeChecks = [
  Expect<Same<Range, NormativeRange>>,
  Expect<Same<Evidence, { path: string; spans: { blockId: string; quote: string }[] }>>,
  Expect<Same<ExtractionIssue, { code: 'missing' | 'ambiguous' | 'conflicting' | 'unreadable' | 'unsupported'; path: string; sourceRefs: string[]; message: string }>>,
  Expect<Same<UnassignedContent, { sourceRefs: string[]; text: string; reason: 'other_domain' | 'unclear_scope' | 'unsupported_structure' }>>,
  Expect<Same<ExtractionCommon, NormativeCommon>>,
  Expect<Same<ExtractedExercise, NormativeExercise>>,
  Expect<Same<ExtractedSession, { label: string | null; title: string | null; weekday: number | null; notes: string[]; exercises: ExtractedExercise[] }>>,
  Expect<Same<ExtractedComplexRule, { kind: 'phase' | 'progression' | 'deload' | 'superset' | 'circuit' | 'cardio' | 'other'; text: string; sourceRefs: string[]; targetPaths: string[] }>>,
  Expect<Same<WorkoutExtraction, NormativeCommon & {
    kind: 'workout'; schedule: 'weekly' | 'rotation' | 'unknown'
    cycle: { startDate: string | null; weeks: number | null }
    sessions: ExtractedSession[]; complexRules: ExtractedComplexRule[]
  }>>,
  Expect<Same<ExtractedFood, { name: string | null; quantityText: string | null; notes: string[] }>>,
  Expect<Same<ExtractedMeal, { name: string | null; timeText: string | null; foods: ExtractedFood[]; alternatives: string[]; additions: string[]; notes: string[] }>>,
  Expect<Same<ExtractedDietDay, { name: string | null; dayType: 'training' | 'rest' | 'any' | null; notes: string[]; meals: ExtractedMeal[] }>>,
  Expect<Same<DietExtraction, NormativeCommon & {
    kind: 'diet'; days: ExtractedDietDay[]
    globalRules: { kind: 'addition' | 'substitution' | 'nutrition' | 'other'; text: string; sourceRefs: string[] }[]
  }>>,
  Expect<Same<SourceBlock, {
    id: string
    kind: 'heading' | 'paragraph' | 'table_row' | 'table_cell' | 'list_item' | 'image_text'
    text: string; page: number | null; tableId: string | null
    row: number | null; column: number | null
    rowSpan: number | null; columnSpan: number | null
    parentId: string | null; headingIds: string[]
    origin: 'native' | 'ocr'; bbox: [number, number, number, number] | null
  }>>,
  Expect<Same<NormalizedDocument, {
    readerVersion: string; sourceHash: string; blocks: SourceBlock[]
    readingIssues: { code: string; sourceRefs: string[]; message: string }[]
  }>>,
]
