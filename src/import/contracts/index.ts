/**
 * Contratti V1 dell'importazione, condivisi da browser, worker e comandi di salvataggio.
 * Solo import relativi `.ts`,
 * niente DOM, React o SDK. I costruttori di schema restano in schema.ts per i contratti successivi.
 */
export {
  contractLimits, parseJson, SHA256_HEX_PATTERN, sha256HexSchema, toJsonSchema, UUID_PATTERN, uuidSchema, validate,
  type ContractError, type ContractErrorCode, type Infer, type JsonObject, type JsonValue, type Schema, type ValidationResult,
} from './schema.ts'
export * from './normalized-document.ts'
export * from './extraction.ts'
export * from './reader.ts'
// Task 02: revisione, conferma e protocollo dell'analisi.
export * from './domain-limits.ts'
export * from './review.ts'
export * from './commit.ts'
export * from './limits.ts'
