import { test } from 'node:test'
import assert from 'node:assert/strict'
import { emptyExercise, sameExercise, sameExerciseIdentity, searchExercises, validateExercise } from '../src/domain/exercises.ts'
import { exerciseMuscleGroup, groupExercises, inferMuscleGroup } from '../src/domain/muscle-groups.ts'
import { newPrescription, withCatalogMuscleGroups } from '../src/domain/programs.ts'
import { workoutDaysFromProgram } from '../src/domain/diary.ts'
import { findPreviousExercise } from '../src/domain/workout.ts'
import type { CatalogExercise } from '../src/domain/exercises.ts'
import { ExercisesStore } from '../src/persistence/exercises-store.ts'
import type { ExercisesRepository } from '../src/persistence/exercises-repository.ts'

const exercise: CatalogExercise = { ...emptyExercise(), id: '11111111-1111-4111-8111-111111111111', name: 'Chest press', muscleGroup: 'Petto', revision: 1 }
test('classificazione riconoscibile, precedenza e ambiguità', () => {
  for (const [name, group] of [['Chest press', 'Petto'], ['Panca piana', 'Petto'], ['Panca inclinata (manubri)', 'Petto'], ['Rematore con petto supportato', 'Schiena'], ['Reverse pec deck', 'Spalle'], ['Leg curl', 'Gambe'], ['Curl a martello', 'Bicipiti'], ['French press', 'Tricipiti'], ['Hip thrust', 'Glutei'], ['Calf raise', 'Polpacci'], ['Plank', 'Addome'], ['Farmer’s carry', 'Full body'], ['Cyclette', 'Cardio']] as const) assert.equal(inferMuscleGroup(name), group, name)
  assert.equal(inferMuscleGroup('Dip alle parallele', 'Tricipiti'), 'Tricipiti')
  assert.equal(inferMuscleGroup('Dip alle parallele', 'Petto'), 'Petto')
  for (const name of ['Press', 'Panca', 'Dip alle parallele', 'Distensioni', 'Esercizio personale']) assert.equal(inferMuscleGroup(name), null)
  assert.equal(exerciseMuscleGroup({ name: 'Chest press' }), 'Petto')
  assert.equal(exerciseMuscleGroup({ name: 'Chest press', muscleGroup: null }), null)
})
test('ricerca e gruppi applicano categoria esplicita, archiviazione e nomi', () => {
  const rows = [exercise, { ...exercise, id: '2', name: 'Pulley', muscleGroup: 'Schiena' as const }, { ...exercise, id: '3', name: 'Plank', muscleGroup: null }, { ...exercise, id: '4', archivedAt: '2026-10-01T00:00:00Z' }]
  assert.deepEqual(searchExercises(rows, 'petto', 'active'), [exercise])
  assert.deepEqual(searchExercises(rows, '', 'active', 'Petto'), [exercise])
  assert.deepEqual(searchExercises(rows, '', 'active', 'unclassified').map(row => row.id), ['3'])
  assert.equal(searchExercises(rows, 'Pulley', 'active', 'Petto').length, 0)
  const before = structuredClone(rows)
  assert.deepEqual(groupExercises(searchExercises(rows, '', 'active')).map(section => [section.label, section.rows.length]), [['Petto', 1], ['Schiena', 1], ['Da classificare', 1]])
  assert.deepEqual(rows, before)
})
test('categoria modificabile: dirty/ripresa risposta persa, UUID e identità invariati', async () => {
  let row = exercise, calls = 0
  const repo: ExercisesRepository = { list: async () => [row], listShared: async () => [], get: async () => row,
    save: async (id, value, revision) => { calls++; row = { ...value, id, revision: revision! + 1 }; throw new Error('lost') }, adopt: async () => row }
  const store = new ExercisesStore(repo); await store.load(); store.open(row)
  store.edit({ ...exercise, muscleGroup: 'Spalle' }); assert.equal(store.dirty, true)
  await store.save(); assert.equal(calls, 1); assert.equal(store.dirty, false); assert.equal(store.getSnapshot().phase, 'ready')
  assert.equal(row.id, exercise.id); assert.equal(row.muscleGroup, 'Spalle'); assert.equal(row.revision, 2)
  assert.equal(sameExercise(exercise, row), false); assert.equal(sameExerciseIdentity(exercise, row), true)
  assert.ok(validateExercise({ ...exercise, muscleGroup: 'invalid' } as unknown as CatalogExercise))
  store.stop()
})
test('scheda usa categoria corrente, storico e comparabilità restano invariati', () => {
  const item = { ...newPrescription(exercise), sets: '2', repsMin: '8', repsMax: '10' }
  const document = { planId: 'p', id: 'v', title: 'Test', guidance: '', days: [{ id: 'd', label: 'Lun', title: 'Petto', note: '', exercises: [item] }] }
  const oldDay = workoutDaysFromProgram(document)[0]!
  const session = { id: 's', date: '2026-10-01', day: oldDay, startedAt: '2026-10-01T10:00:00Z', completedAt: '2026-10-01T10:10:00Z', results: { [item.id]: [{ load: '20', amount: '8', completed: true }] } }
  const before = structuredClone(session)
  const updated = withCatalogMuscleGroups(document, [{ ...exercise, muscleGroup: 'Spalle' }])
  const nextDay = workoutDaysFromProgram(updated)[0]!
  assert.equal(nextDay.exercises[0]!.muscleGroup, 'Spalle')
  assert.equal(oldDay.exercises[0]!.muscleGroup, 'Petto')
  assert.deepEqual(session, before)
  assert.equal(findPreviousExercise([session], nextDay.exercises[0]!, { id: 'next', date: '2026-10-02', startedAt: '2026-10-02T10:00:00Z' })?.session.id, 's')
  assert.equal(document.days[0]!.exercises[0]!.exercise.muscleGroup, 'Petto')
})

test('categorie nella copia offline della scheda restano separate per account', async () => {
  const { PlansStore } = await import('../src/persistence/plans-store.ts')
  const item = { ...newPrescription(exercise), sets: '2', repsMin: '8', repsMax: '10' }
  const document = { planId: 'p', id: 'v', title: 'Test', guidance: '', days: [{ id: 'd', label: 'Lun', title: 'Petto', note: '', exercises: [item] }] }
  const saved = { plan: { id: 'p', name: 'Test', revision: 1, activeVersionId: 'v', archivedAt: null }, version: { id: 'v', planId: 'p', title: 'Test', guidance: '', number: 1, revision: 1, status: 'published' as const }, document }
  const plans = { selection: async () => ({ workoutPlanId: 'p', mealPlanId: null, revision: 1 }), mealPlans: async () => [] } as unknown as import('../src/persistence/plans-repository.ts').PlansRepository
  const programs = { list: async () => [{ plan: saved.plan, versions: [saved.version] }], get: async () => structuredClone(saved) } as unknown as import('../src/persistence/programs-repository.ts').ProgramsRepository
  const memory = new Map<string, string>()
  const storage = { get: (key: string) => memory.get(key) ?? null, set: (key: string, value: string) => { memory.set(key, value) }, remove: (key: string) => { memory.delete(key) } }
  const store = new PlansStore(plans, programs, storage, 'a'); await store.load()
  store.applyCatalogMuscleGroups([{ ...exercise, muscleGroup: 'Spalle' }])
  const restored = new PlansStore(plans, programs, storage, 'a')
  assert.equal(restored.getSnapshot().cached, true)
  assert.equal(restored.getSnapshot().workout!.document.days[0]!.exercises[0]!.exercise.muscleGroup, 'Spalle')
  const other = new PlansStore(plans, programs, storage, 'b')
  assert.equal(other.getSnapshot().workout, null)
  assert.equal(saved.document.days[0]!.exercises[0]!.exercise.muscleGroup, 'Petto')
  store.stop(); restored.stop(); other.stop()
})
