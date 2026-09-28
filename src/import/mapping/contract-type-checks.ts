/**
 * Verifiche a compile time (npm run typecheck) fra i contratti di conferma e i tipi di dominio
 * esistenti, che il task 02 non modifica: i contratti non importano il dominio (confine Deno),
 * quindi l'allineamento si controlla qui. Nessun codice eseguibile.
 */
import type { CatalogExerciseValues, ResolvedMealPlan, ResolvedWorkoutImport } from '../contracts/index.ts'
import type { ExerciseValues } from '../../domain/exercises.ts'
import type { MealPlanDraft } from '../../domain/meal-plans.ts'
import type { ProgramCycle, ProgramExercise } from '../../domain/programs.ts'

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T
type Same<A, B> = Equal<{ [K in keyof A]: A[K] }, { [K in keyof B]: B[K] }>
type Deep<T> = T extends readonly (infer U)[] ? Deep<U>[] : T extends object ? { [K in keyof T]: Deep<T[K]> } : T

export type ContractDomainChecks = [
  // I valori visti o confermati di un esercizio sono ExerciseValues senza archivedAt, cioè ProgramExercise senza id.
  Expect<Same<CatalogExerciseValues, Omit<ExerciseValues, 'archivedAt'>>>,
  Expect<Same<CatalogExerciseValues & { id: string }, ProgramExercise>>,
  // Il piano risolto della dieta è un MealPlanDraft del dominio, con le stesse proprietà chiuse.
  Expect<Equal<Deep<ResolvedMealPlan>, Deep<MealPlanDraft>>>,
  // Il ciclo risolto è il ProgramCycle salvato dal dominio.
  Expect<Same<NonNullable<ResolvedWorkoutImport['cycle']>, ProgramCycle>>,
]
