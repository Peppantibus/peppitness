/**
 * Contratti V1 dell'importazione: unica sorgente condivisa da browser, worker e Edge Function
 * (ponte in supabase/functions/_shared/import/contracts.ts). Solo import relativi `.ts`,
 * niente DOM, React o SDK. I costruttori di schema restano in schema.ts per i contratti successivi.
 */
export {
  contractLimits, parseJson, toJsonSchema, validate,
  type ContractError, type ContractErrorCode, type Infer, type JsonObject, type JsonValue, type Schema, type ValidationResult,
} from './schema.ts'
export * from './normalized-document.ts'
export * from './extraction.ts'
export * from './reader.ts'
export type * from './provider.ts'
