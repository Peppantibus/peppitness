// Comandi di conferma per i test SQL/HTTP dei task 19/20, prodotti dai mapper reali 09/10 sui
// casi del corpus (stesse decisioni e prenotazioni dei golden, UUID tecnici distinti per caso).
// La provenienza è derivata dalla bozza solo come fixture: non è il costruttore dell'app (21/22).
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createReviewDraft, sequentialLocalIds, pointerOf } from '../../src/import/review/draft.ts'
import { applyDecision, chooseCatalog } from '../../src/import/review/decisions.ts'
import { mapReviewedWorkout } from '../../src/import/mapping/workout.ts'
import { mapReviewedDiet } from '../../src/import/mapping/diet.ts'
import { contentHash } from '../../src/import/mapping/canonical.ts'
import {
  IMPORT_COMMIT_PROTOCOL_VERSION, IMPORT_PROVENANCE_FORMAT, defaultSelectionOptions, exerciseChoiceValues, extractionSchemaIds,
  TEXT_NORMALIZATION_VERSION, validateCommitCommand,
} from '../../src/import/contracts/index.ts'

const read = path => JSON.parse(readFileSync(new URL(`../../tests/fixtures/import/${path}`, import.meta.url), 'utf8'))
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
/** Stesso UUID con prefisso del caso: prenotazioni dei golden, ma nessuna collisione fra casi. */
const prefixed = (prefix, value) => JSON.parse(JSON.stringify(value).replace(UUID, id => `${prefix}${id.slice(8)}`))
const caseUuid = (prefix, n) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`

/** Catalogo seminato dai test prima del caso con scelte existing/shared. */
export const catalogSeed = Object.freeze({
  existing: [{ id: 'a1900000-0000-4000-8000-000000000001', revision: 2, values: {
    name: 'Panca piana', variant: '', equipment: 'bilanciere', loadConvention: 'total', loadUnit: 'kg', measurementMode: 'reps', perSide: false, note: 'Nota personale.' } }],
  shared: [{ id: 'c1900000-0000-4000-8000-000000000001', values: {
    name: 'Rematore con manubrio', variant: '', equipment: 'manubrio', loadConvention: 'single-dumbbell', loadUnit: 'kg', measurementMode: 'reps', perSide: true, note: 'Template comune.' } }],
})

function provenanceOf(kind, draft, targets, jobId) {
  const pointers = pointerOf(draft)
  return {
    formatVersion: IMPORT_PROVENANCE_FORMAT, kind,
    analysis: { jobId, proposalId: draft.proposal.proposalId, proposalVersion: draft.proposal.proposalVersion,
      schemaId: extractionSchemaIds[kind], source: draft.proposal.source },
    items: draft.current.map(item => ({
      localId: item.localId, targetId: targets[item.localId] ?? null, sourcePointer: pointers.get(item.localId) ?? null,
      decisions: draft.decisions.filter(d => d.localId === item.localId)
        .map(d => ({ field: d.op === 'set' || d.op === 'confirm' ? d.field ?? null : null, reason: d.reason })),
    })),
  }
}

/** Righe attese nel diario (forma di workout_sessions.day_snapshot senza ID e metadati del piano). */
function sessionDays(resolved) {
  const choices = new Map(resolved.catalog.map(binding => [binding.ref, exerciseChoiceValues(binding.choice)]))
  return resolved.days.map(day => ({ label: day.label, title: day.title, note: day.note, exercises: day.prescriptions.map(p => {
    const v = choices.get(p.exerciseRef)
    return { name: v.name, variant: v.variant, equipment: v.equipment, load_convention: v.loadConvention, load_unit: v.loadUnit,
      per_side: v.perSide, exercise_note: v.note, mode: v.measurementMode, sets: p.sets, optional_sets: p.optionalSets,
      reps_min: p.repsMin, reps_max: p.repsMax, duration_seconds: p.durationSeconds, rest_seconds: p.restSeconds, rir: p.rir, rpe: p.rpe, note: p.note }
  }) }))
}

function draftFor(kind, entry, document, n, extra = []) {
  let draft = createReviewDraft({ kind, extraction: read(entry.expectedProposal), proposalId: caseUuid('b1900000', n), jobId: caseUuid('f1900000', n),
    source: { sourceHash: document.sourceHash, readerVersion: document.readerVersion, textNormalizationVersion: TEXT_NORMALIZATION_VERSION },
    localIds: sequentialLocalIds('i') })
  for (const decision of [...entry.userDecisions ?? [], ...extra]) draft = applyDecision(draft, decision)
  return draft
}

function finish(kind, n, draft, mapping, document, ids) {
  if (!mapping.ok) throw new Error(`Mapping fixture non valido: ${JSON.stringify(mapping.issues)}`)
  const command = {
    requestId: caseUuid('e1900000', n),
    payload: { protocolVersion: IMPORT_COMMIT_PROTOCOL_VERSION, kind, mode: 'create_new', resolved: mapping.value.resolved },
    provenance: provenanceOf(kind, draft, mapping.value.targets, draft.proposal.jobId),
    selectionOptions: { ...defaultSelectionOptions },
  }
  const checked = validateCommitCommand(kind, command)
  if (!checked.ok) throw new Error(`Comando fixture non valido: ${JSON.stringify(checked.errors)}`)
  // `draft`/`ids`: bozza e prenotazioni da cui il comando deriva (test del costruttore dell'app, 21).
  return { command, document, extraction: draft.proposal.extraction, draft, ids }
}

const workoutCases = ['workout-spec-example', 'workout-incomplete', 'workout-ranges-unicode', 'workout-abc-no-days', 'workout-out-of-bounds', 'workout-partially-interpretable']
const dietCases = [['diet-spec-example', null], ['diet-alternatives-additions', null], ['diet-reviewed-conditions', 'reviewed-conditions']]

/** Casi sintetici in ordine stabile. `workout-catalog`: incompleto con un esercizio personale e un template comune. */
export function commitFixtureCases() {
  const manifest = read('manifest.json')
  const entryOf = id => manifest.cases.find(c => c.id === id)
  const cases = []
  workoutCases.forEach((name, index) => {
    const n = index + 1, prefix = `1900${String(n).padStart(4, '0')}`
    const entry = entryOf(name), golden = read(`mapping/workout/${name}.json`), document = read(entry.expectedBlocks)
    const draft = draftFor('workout', entry, document, n, golden.additionalDecisions)
    const ids = prefixed(prefix, golden.ids)
    cases.push({ id: name, kind: 'workout', ...finish('workout', n, draft, mapReviewedWorkout(document, draft, ids), document, ids) })
  })
  {
    const n = 7, entry = entryOf('workout-incomplete'), golden = read('mapping/workout/workout-incomplete.json'), document = read(entry.expectedBlocks)
    const [existing] = catalogSeed.existing, [shared] = catalogSeed.shared
    let draft = draftFor('workout', entry, document, n, golden.additionalDecisions)
    draft = chooseCatalog(draft, 'i2', { source: 'existing', personalId: existing.id, revision: existing.revision, seen: existing.values }, { decisionId: 'fixture-c1' })
    draft = chooseCatalog(draft, 'i3', { source: 'shared', templateId: shared.id, seen: shared.values }, { decisionId: 'fixture-c2' })
    const ids = prefixed('19000007', golden.ids)
    ids.exercises = { [`shared:${shared.id}`]: caseUuid('19000007', 900) }
    cases.push({ id: 'workout-catalog', kind: 'workout', ...finish('workout', n, draft, mapReviewedWorkout(document, draft, ids), document, ids) })
  }
  dietCases.forEach(([name, golden], index) => {
    const n = 11 + index, prefix = `2000${String(n).padStart(4, '0')}`
    const base = golden ? 'diet-spec-example' : name
    const entry = entryOf(base), document = read(entry.expectedBlocks)
    const draft = draftFor('diet', entry, document, n, golden ? read(`mapping/diet/${golden}.json`).additionalDecisions : [])
    const ids = { planId: caseUuid(prefix, 2), items: Object.fromEntries(draft.current.map((item, i) => [item.localId, caseUuid(prefix, 10 + i)])) }
    cases.push({ id: name, kind: 'diet', ...finish('diet', n, draft, mapReviewedDiet(document, draft, ids), document, ids) })
  })
  return cases
}

/** Valori attesi dopo il commit: scheda = giornate del diario; dieta = nome e documento identici. */
export async function commitFixtureRows() {
  return Promise.all(commitFixtureCases().map(async c => ({
    ...c,
    contentHash: await contentHash(c.command.payload),
    expected: c.kind === 'workout' ? sessionDays(c.command.payload.resolved)
      : { name: c.command.payload.resolved.plan.name, document: c.command.payload.resolved.plan.document },
  })))
}

/**
 * Copia per un account reale: ogni UUID del comando diventa nuovo e casuale (nessuna collisione fra
 * esecuzioni), salvo quelli indicati in `keep` (es. job, esercizio personale, template seminati).
 */
export function instantiateCommand(command, keep = {}) {
  const map = new Map(Object.entries(keep))
  return JSON.parse(JSON.stringify(command).replace(UUID, id => {
    if (!map.has(id)) map.set(id, randomUUID())
    return map.get(id)
  }))
}
