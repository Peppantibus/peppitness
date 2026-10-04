/**
 * Limiti configurabili della lettura locale del documento: valori iniziali, nessun troncamento (un
 * superamento produce un errore `limit_exceeded` con {limit, max, actual}).
 */
import type { NormalizedDocument } from './normalized-document.ts'
import type { ReaderLimitDetail } from './reader.ts'

const MiB = 1024 * 1024
export const defaultImportLimits = {
  /** Byte del file scelto, prima di leggerlo. */
  fileBytes: 10 * MiB,
  docxEntries: 2000,
  /** Somma dei byte decompressi dichiarati e letti delle entry DOCX. */
  docxUncompressedBytes: 50 * MiB,
  /** Caratteri Unicode del testo dei blocchi del NormalizedDocument. */
  normalizedTextChars: 200_000,
  /** Blocchi del NormalizedDocument. */
  blocks: 10_000,
} as const
export type ImportLimitName = keyof typeof defaultImportLimits
export type ImportLimits = { readonly [K in ImportLimitName]: number }

/** Valori non interi positivi o limiti sconosciuti sono rifiutati; un limite non si annulla mai. */
export function resolveImportLimits(configured: Partial<Record<ImportLimitName, unknown>> = {}): ImportLimits {
  const limits: Record<string, number> = { ...defaultImportLimits }
  for (const [name, value] of Object.entries(configured)) {
    if (!Object.hasOwn(defaultImportLimits, name)) throw new RangeError(`Limite import sconosciuto: ${name}.`)
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new RangeError(`Limite import non valido: ${name}.`)
    limits[name] = value
  }
  return Object.freeze(limits) as ImportLimits
}

/** Limiti del documento normalizzato letto sul dispositivo. */
export function normalizedDocumentLimitViolations(document: NormalizedDocument, limits: ImportLimits = defaultImportLimits): ReaderLimitDetail[] {
  const violations: ReaderLimitDetail[] = []
  if (document.blocks.length > limits.blocks) violations.push({ limit: 'blocks', max: limits.blocks, actual: document.blocks.length })
  const chars = document.blocks.reduce((total, block) => total + [...block.text].length, 0)
  if (chars > limits.normalizedTextChars) violations.push({ limit: 'normalizedTextChars', max: limits.normalizedTextChars, actual: chars })
  return violations
}
