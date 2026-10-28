import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyOp, dayFromSnapshot, emptyDiary, emptyResults, prescription } from '../src/domain/diary.ts'
import type { SnapshotExercise } from '../src/domain/diary.ts'
import { applyExerciseChange, canUndoChange, datedDay, futurePartners, intact, proposedDose, replacementSnapshot } from '../src/domain/exercise-changes.ts'
import type { ExerciseChange } from '../src/domain/exercise-changes.ts'
import type { CatalogExercise } from '../src/domain/exercises.ts'
import { localDate } from '../src/domain/dates.ts'
import type { WorkoutSession } from '../src/domain/types.ts'
import { findPreviousExercise } from '../src/domain/workout.ts'

const source: SnapshotExercise = { id: 'source', exercise_id: 'chest', name: 'Chest press', variant: 'A', equipment: 'machine', load_convention: 'total', load_unit: 'kg', per_side: false, exercise_note: 'Tecnica chest', muscle_group: 'Petto', mode: 'reps', sets: 3, optional_sets: 1, reps_min: 8, reps_max: 12, duration_seconds: null, rest_seconds: 90, rir: 2, rpe: null, note: 'Nota chest' }
const lat: SnapshotExercise = { ...source, id: 'partner', exercise_id: 'lat', name: 'Lat machine', sets: 5, optional_sets: 2, reps_min: 6, reps_max: 8, rest_seconds: 150, rir: null, rpe: 8, muscle_group: 'Schiena', exercise_note: 'Tecnica lat', note: 'Nota lat' }
const catalog: CatalogExercise = { id: 'lat', name: 'Lat machine', variant: 'A', equipment: 'machine', loadConvention: 'total', loadUnit: 'kg', perSide: false, note: 'Tecnica lat', muscleGroup: 'Schiena', measurementMode: 'reps', archivedAt: null, revision: 1 }
const day = (id: string, label: string, raw: SnapshotExercise) => dayFromSnapshot(id, { label, title: label, note: '', plan_title: 'Programma', version_number: 1, exercises: [raw] })
const monday = day('mon', 'Lun', source), wednesday = day('wed', 'Mer', lat), friday = day('fri', 'Ven', { ...lat, id: 'partner2' })
const session: WorkoutSession = { id: 'session', planId: 'plan', versionId: 'version', date: '2026-10-26', day: monday, startedAt: '2026-10-26T08:00:00Z', results: emptyResults(monday), timeZone: 'Europe/Rome' }
const change: ExerciseChange = { id: 'change', sessionId: session.id, planId: 'plan', versionId: 'version', sourceDate: session.date, sourceDayId: monday.id, sourceId: source.id,
  createdAt: session.startedAt, timeZone: 'Europe/Rome', before: source, after: { ...lat, id: source.id }, cancelled: false,
  partner: { date: '2026-10-28', dayId: wednesday.id, prescriptionId: lat.id, before: lat, after: { ...source, id: lat.id } } }
const data = () => ({ ...emptyDiary(), sessions: [structuredClone(session)] })

test('scambio: dosi differenti intere, posizione e volume settimanale conservati; nessun risultato copiato', () => {
  const result = applyExerciseChange(data(), change)
  assert.equal(result.sessions[0]!.day.exercises[0]!.sets, 5)
  assert.equal(result.sessions[0]!.results.source!.length, 7)
  assert.ok(result.sessions[0]!.results.source!.every(set => !set.completed && set.load === '' && set.amount === ''))
  const future = datedDay(wednesday, '2026-10-28', 'version', result.changes!)
  assert.deepEqual(future.exercises[0]!.snapshot, { ...source, id: lat.id })
  assert.equal(result.sessions[0]!.day.exercises[0]!.id, source.id)
  assert.equal(datedDay(monday, '2026-11-02', 'version', result.changes!).exercises[0]!.exerciseId, 'chest')
  assert.equal(datedDay(wednesday, '2026-10-28', 'version2', result.changes!).exercises[0]!.exerciseId, 'lat')
})
test('catalogo completo e solo oggi: nuova identità e note pertinenti; futuro invariato', () => {
  const selected = { ...catalog, id: 'dumbbells', name: 'Spinta manubri', loadConvention: 'single-dumbbell' as const, loadUnit: 'lb' as const, perSide: true, note: 'Tecnica manubri' }
  const raw = replacementSnapshot(source, selected, proposedDose(source, selected))
  const result = applyExerciseChange(data(), { ...change, after: raw, partner: null })
  assert.equal(result.sessions[0]!.day.exercises[0]!.exerciseId, 'dumbbells')
  assert.equal(raw.load_convention, 'single-dumbbell'); assert.equal(raw.load_unit, 'lb'); assert.equal(raw.note, ''); assert.equal(raw.exercise_note, selected.note)
  assert.deepEqual(datedDay(wednesday, '2026-10-28', 'version', result.changes!), wednesday)
  assert.equal(replacementSnapshot(source, catalog, proposedDose(source, catalog)).sets, 3)
})
test('partner: identità esatte, più occorrenze, date future e registrazioni anche parziali', () => {
  const args = { source: prescription(source), selected: catalog, session, days: [monday, wednesday, friday], changes: [], sessions: [session] }
  assert.equal(futurePartners(args).length, 2)
  assert.equal(futurePartners({ ...args, selected: { ...catalog, id: 'similar-name' } }).length, 0)
  const logged = { ...session, id: 'future', date: '2026-10-28', day: wednesday, results: { partner: [{ load: '0', amount: '', completed: false }] } }
  assert.equal(futurePartners({ ...args, sessions: [session, logged] }).length, 1)
  assert.equal(futurePartners({ ...args, session: { ...session, date: '2026-10-29' } }).length, 1)
  assert.equal(futurePartners({ ...args, changes: [change] }).length, 1)
})
test('cardio prioritario: nessuna ricerca partner, 10 minuti attuali e non 15 futuri; plank e carry esclusi', () => {
  const stairs = { ...source, name: 'Stairs Master', muscle_group: 'Cardio' as const, mode: 'seconds' as const, reps_min: null, reps_max: null, duration_seconds: 600, sets: 1, optional_sets: 0 }
  const tapis = { ...catalog, name: 'Tapis roulant', muscleGroup: 'Cardio' as const, measurementMode: 'seconds' as const }
  const future = day('wed', 'Mer', { ...lat, name: tapis.name, muscle_group: 'Cardio', mode: 'seconds', duration_seconds: 900 })
  const args = { source: prescription(stairs), selected: tapis, session, days: [monday, future], changes: [], sessions: [session] }
  assert.deepEqual(futurePartners(args), [])
  assert.deepEqual(futurePartners({ ...args, days: [monday] }), [], 'cardio assente dalla scheda: resta una sostituzione attuale')
  assert.equal(replacementSnapshot(stairs, tapis, proposedDose(stairs, tapis)).duration_seconds, 600)
  assert.equal(proposedDose(stairs, tapis).sets, 1)
  assert.equal(proposedDose(stairs, tapis).rest_seconds, 0)
  const plank = { ...tapis, name: 'Plank', muscleGroup: 'Addome' as const }
  assert.equal(futurePartners({ ...args, selected: plank }).length, 1)
  const carry = { ...tapis, name: 'Carry', muscleGroup: 'Full body' as const }
  assert.equal(futurePartners({ ...args, selected: carry }).length, 1)
})
test('modalità incompatibili: nessuna dose temporale o ripetizione inventata', () => {
  assert.equal(proposedDose(source, { ...catalog, measurementMode: 'seconds' }).duration_seconds, null)
  const seconds = { ...source, mode: 'seconds' as const, duration_seconds: 30, reps_min: null, reps_max: null }
  assert.equal(proposedDose(seconds, catalog).reps_min, null)
  assert.equal(proposedDose(seconds, catalog).reps_max, null)
})
test('annullamento: zero e bozze parziali sono valori, gli altri esercizi non bloccano', () => {
  assert.ok(canUndoChange(change, [session]))
  assert.ok(intact(session, source.id))
  assert.equal(canUndoChange(change, [{ ...session, results: { source: [{ load: '0', amount: '', completed: false }] } }]), false)
  assert.equal(canUndoChange(change, [{ ...session, completedAt: session.startedAt }]), false)
  const result = applyExerciseChange(applyExerciseChange(data(), change), { ...change, cancelled: true })
  assert.deepEqual(result.sessions[0]!.day.exercises[0]!.snapshot, source)
  assert.deepEqual(datedDay(wednesday, '2026-10-28', 'version', result.changes!), wednesday)
})
test('replay e storico: risposta persa non cancella serie e completati non riscritti', () => {
  let result = applyExerciseChange(data(), change)
  result.sessions[0]!.results.source![0] = { load: '25', amount: '8', completed: true }
  const reordered = Object.fromEntries(Object.entries(change.after).reverse()) as unknown as SnapshotExercise
  result = applyExerciseChange(result, { ...change, after: reordered })
  assert.equal(result.sessions[0]!.results.source![0]!.load, '25')
  result.sessions[0]!.completedAt = session.startedAt
  result = applyExerciseChange(result, { ...change, cancelled: true })
  assert.equal(result.sessions[0]!.day.exercises[0]!.exerciseId, 'lat')
})
test('precedenti seguono identità e set in attesa non si associano alla vecchia identità', () => {
  const oldChest = { ...structuredClone(session), id: 'old', date: '2026-10-19', completedAt: session.startedAt }
  oldChest.results.source![0] = { load: '80', amount: '8', completed: true }
  const result = applyExerciseChange(data(), change)
  assert.equal(findPreviousExercise([oldChest], result.sessions[0]!.day.exercises[0]!, session), undefined)
  const mismatched = applyOp(data(), { type: 'set', opId: 'set', sessionId: session.id, prescriptionId: source.id, exerciseId: 'lat', index: 0, result: { load: '20', amount: '8', completed: true } })
  assert.equal(mismatched.sessions[0]!.results.source![0]!.load, '')
  const active = applyExerciseChange(data(), change)
  const stale = applyOp(active, { type: 'set', opId: 'stale', sessionId: session.id, prescriptionId: source.id, exerciseId: 'lat', changeId: 'older-change', index: 0, result: { load: '20', amount: '8', completed: true } })
  assert.equal(stale.sessions[0]!.results.source![0]!.load, '', 'ricevuta precedente: neppure la vista locale associa la serie alla nuova sostituzione')
})
test('settimana account: domenica/lunedì, fusi e cambio ora senza durate UTC', () => {
  assert.equal(localDate(new Date('2026-10-25T23:30:00Z'), 'Europe/Rome'), '2026-10-26')
  assert.equal(localDate(new Date('2026-10-25T23:30:00Z'), 'America/New_York'), '2026-10-25')
  const sunday = { ...session, date: '2026-10-25' }
  assert.deepEqual(futurePartners({ source: prescription(source), selected: catalog, session: sunday, days: [monday, wednesday], changes: [], sessions: [] }), [])
  const beforeDST = { ...session, date: '2026-10-19' }
  const sundayDay = day('sun', 'Dom', lat)
  assert.equal(futurePartners({ source: prescription(source), selected: catalog, session: beforeDST, days: [monday, sundayDay], changes: [], sessions: [] })[0]!.date, '2026-10-25')
})
