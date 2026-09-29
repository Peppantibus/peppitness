import { isExerciseId, validateExercise, type CatalogExercise } from '../../domain/exercises.ts'
import type { ExtractedExercise } from '../contracts/extraction.ts'
import { exerciseChoiceValues, sameJsonValue, validateExerciseChoice, type CatalogExerciseValues, type ExerciseChoice } from '../contracts/review.ts'

export const identityFields = ['variant', 'equipment', 'measurementMode', 'perSide', 'loadUnit', 'loadConvention'] as const
export type MatchOccurrence = Pick<ExtractedExercise, 'name' | typeof identityFields[number]> & { localId: string }
/** Complete means both paginated reads finished, including archived personal copies. */
export interface CatalogSnapshot { personal: readonly CatalogExercise[]; shared: readonly CatalogExercise[]; complete: boolean }
export interface ExerciseCandidate {
  choice: ExerciseChoice
  nameMatch: 'exact' | 'fuzzy'
  missing: (typeof identityFields[number])[]
  conflicts: (typeof identityFields[number])[]
  adoption: 'none' | 'identical_copy' | 'changed_copy' | 'archived_copy'
  selectable: boolean
}
export interface OccurrenceMatch {
  localId: string
  sourceName: string | null
  candidates: ExerciseCandidate[]
  preselected: ExerciseChoice | null
  requiresChoice: boolean
}

/** Accents are retained for exact matching; accent folding is a suggestion only. */
export const normalizeExerciseName = (name: string) => name.normalize('NFC').toLowerCase().trim().replace(/\s+/gu, ' ')
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
function values(row: CatalogExercise): CatalogExerciseValues {
  return { name: row.name, variant: row.variant, equipment: row.equipment, measurementMode: row.measurementMode,
    perSide: row.perSide, loadUnit: row.loadUnit, loadConvention: row.loadConvention, note: row.note }
}
function choice(row: CatalogExercise, shared: boolean): ExerciseChoice {
  return shared ? { source: 'shared', templateId: row.id, seen: values(row) }
    : { source: 'existing', personalId: row.id, revision: row.revision, seen: values(row) }
}
function checkSnapshot(snapshot: CatalogSnapshot) {
  for (const [shared, rows] of [[false, snapshot.personal], [true, snapshot.shared]] as const) {
    const ids = new Set<string>(), templates = new Set<string>()
    for (const row of rows) {
      if (!isExerciseId(row.id) || ids.has(row.id) || validateExercise(row) || !validateExerciseChoice(choice(row, shared)).ok
        || !Number.isSafeInteger(row.revision) || row.revision < 1
        || (row.sourceTemplateId != null && (!isExerciseId(row.sourceTemplateId) || templates.has(row.sourceTemplateId)))
        || (shared && (row.archivedAt !== null || row.sourceTemplateId != null))) throw new Error('Invalid catalog snapshot')
      ids.add(row.id)
      if (row.sourceTemplateId) templates.add(row.sourceTemplateId)
    }
  }
}
function adoption(row: CatalogExercise, shared: boolean, snapshot: CatalogSnapshot): ExerciseCandidate['adoption'] {
  const copy = shared ? snapshot.personal.find(item => item.sourceTemplateId === row.id) : row.sourceTemplateId ? row : undefined
  const template = shared ? row : snapshot.shared.find(item => item.id === row.sourceTemplateId)
  if (!copy || !template) return 'none'
  if (copy.archivedAt) return 'archived_copy'
  return sameJsonValue(values(copy), values(template)) ? 'identical_copy' : 'changed_copy'
}
function fuzzy(a: string, b: string) {
  const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '')
  a = fold(a); b = fold(b)
  if (a === b || a.includes(b) || b.includes(a)) return true
  // Conservative lexical suggestion: no semantic synonyms or variant equivalence.
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1]! + 1, previous[j]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = next
  }
  return previous[b.length]! <= Math.max(1, Math.floor(Math.max(a.length, b.length) / 5))
}

/** Pure suggestions. No repository/store dependency, no ID generation, no writes. */
export function matchExercises(occurrences: readonly MatchOccurrence[], snapshot: CatalogSnapshot): OccurrenceMatch[] {
  checkSnapshot(snapshot)
  return occurrences.map(occurrence => {
    const name = normalizeExerciseName(occurrence.name ?? '')
    const candidates: ExerciseCandidate[] = []
    for (const [shared, rows] of [[false, snapshot.personal], [true, snapshot.shared]] as const) {
      for (const row of rows) {
        if (row.archivedAt !== null || !name) continue
        const exact = normalizeExerciseName(row.name) === name
        if (!exact && !fuzzy(name, normalizeExerciseName(row.name))) continue
        const status = adoption(row, shared, snapshot)
        // Identical adopted templates are represented only by their personal identity.
        if (shared && status === 'identical_copy') continue
        candidates.push({ choice: choice(row, shared), nameMatch: exact ? 'exact' : 'fuzzy',
          missing: identityFields.filter(field => occurrence[field] === null),
          conflicts: identityFields.filter(field => occurrence[field] !== null && occurrence[field] !== row[field]),
          adoption: status, selectable: !shared || status === 'none' })
      }
    }
    const rank = (candidate: ExerciseCandidate) => [candidate.nameMatch === 'exact' ? 0 : 1,
      candidate.conflicts.length ? 1 : 0, candidate.choice.source === 'existing' ? 0 : 1]
    candidates.sort((a, b) => {
      const ar = rank(a), br = rank(b)
      for (let i = 0; i < ar.length; i++) if (ar[i] !== br[i]) return ar[i]! - br[i]!
      const key = (c: ExerciseCandidate) => c.choice.source === 'existing' ? c.choice.personalId : c.choice.source === 'shared' ? c.choice.templateId : c.choice.localKey
      return compare(key(a), key(b))
    })
    const eligible = candidates.filter(c => c.selectable && c.nameMatch === 'exact' && !c.missing.length && !c.conflicts.length
      && c.adoption !== 'changed_copy')
    const personal = eligible.filter(c => c.choice.source === 'existing')
    const preferred = personal.length ? personal : eligible
    const preselected = snapshot.complete && preferred.length === 1 ? preferred[0]!.choice : null
    return { localId: occurrence.localId, sourceName: occurrence.name, candidates, preselected, requiresChoice: preselected === null }
  })
}

/** Explicit picker confirmation; reads the current snapshot instead of accepting arbitrary IDs/seen values. */
export function chooseCatalogExercise(snapshot: CatalogSnapshot, source: 'existing' | 'shared', id: string): ExerciseChoice {
  checkSnapshot(snapshot)
  if (!snapshot.complete) throw new Error('Catalog reads incomplete')
  const row = (source === 'existing' ? snapshot.personal : snapshot.shared).find(item => item.id === id)
  if (!row || row.archivedAt !== null) throw new Error('Exercise unavailable')
  if (source === 'shared') {
    const status = adoption(row, true, snapshot)
    if (status === 'identical_copy') return choice(snapshot.personal.find(item => item.sourceTemplateId === id)!, false)
    if (status !== 'none') throw new Error('Catalog changed: choose the personal copy or a new identity')
  }
  return choice(row, source === 'shared')
}

/** The caller must collect confirmation of every metadata field; no extraction defaults. */
export function chooseNewExercise(localKey: string, confirmedValues: unknown, confirmed: boolean): ExerciseChoice {
  const result = validateExerciseChoice({ source: 'new', localKey, values: confirmedValues })
  if (!confirmed || !result.ok) throw new Error('Complete and confirm new exercise metadata')
  // Detach the result from mutable form data.
  return { source: 'new', localKey, values: { ...exerciseChoiceValues(result.value) } }
}
