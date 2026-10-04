// SDK, Auth, RLS, RPC e snapshot reali, esclusivamente nello stack Supabase locale.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { readLocalStatus } from './lib/local-supabase.mjs'
import { createExercisesRepository, ExercisesFailure } from '../src/persistence/exercises-repository.ts'
import { emptyExercise } from '../src/domain/exercises.ts'
import { newProgram, newDay, newPrescription, programPayload } from '../src/domain/programs.ts'
import { sessionFromRow } from '../src/persistence/diary-repository.ts'
const config = readLocalStatus(), users = [], options = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
const admin = createClient(config.apiUrl, config.adminKey, options)
const signal = () => AbortSignal.timeout(15000)
const checks = [], pass = text => { checks.push(text); console.log(`PASS ${text}`) }
async function actor() {
  const email = `muscle-groups-${randomUUID()}@example.invalid`, password = `Aa1!${randomUUID()}`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  assert.equal(error, null); users.push(data.user.id)
  const client = createClient(config.apiUrl, config.publicKey, options)
  const login = await client.auth.signInWithPassword({ email, password }); assert.equal(login.error, null)
  return { client, id: data.user.id, repo: createExercisesRepository(client, data.user.id) }
}
try {
  const a = await actor(), b = await actor()
  const id = randomUUID(), known = { ...emptyExercise(), name: 'Chest press', muscleGroup: 'Petto' }
  const first = await a.repo.save(id, known, null, signal()); assert.equal(first.muscleGroup, 'Petto')
  assert.equal((await a.repo.get(id, signal())).muscleGroup, 'Petto')
  pass('creazione e rilettura del gruppo dal repository reale')
  const second = await a.repo.save(id, { ...first, muscleGroup: 'Spalle' }, first.revision, signal())
  assert.equal(second.id, id); assert.equal(second.revision, 2); assert.equal(second.muscleGroup, 'Spalle')
  await assert.rejects(a.repo.save(id, { ...first, muscleGroup: 'Schiena' }, 1, signal()), error => error instanceof ExercisesFailure && error.kind === 'conflict')
  pass('riclassificazione senza duplicazione e conflitto di revisione HTTP')
  assert.equal(await b.repo.get(id, signal()), null)
  const denied = await b.client.from('exercises').update({ muscle_group: 'Gambe', revision: 3 }).eq('id', id).select('id')
  assert.deepEqual(denied.data, [])
  assert.equal((await a.repo.get(id, signal())).muscleGroup, 'Spalle')
  const anon = createClient(config.apiUrl, config.publicKey, options)
  const privateRead = await anon.from('exercises').select('muscle_group'); assert.ok(privateRead.error)
  pass('A/B e anonimo: categoria personale isolata')
  const implicitId = randomUUID()
  const implicit = await a.repo.save(implicitId, { name: 'Panca piana', variant: '', equipment: '', loadConvention: 'total', loadUnit: 'kg', measurementMode: 'reps', perSide: false, note: '', archivedAt: null }, null, signal())
  assert.equal(implicit.muscleGroup, 'Petto')
  const explicit = await a.repo.save(randomUUID(), { ...emptyExercise(), name: 'Panca piana', muscleGroup: null }, null, signal())
  assert.equal(explicit.muscleGroup, null)
  pass('campo omesso nei vecchi client/import e null esplicito distinti')
  const document = newProgram(), day = newDay([]), item = { ...newPrescription(second), sets: '2', repsMin: '8', repsMax: '10' }
  document.title = 'Programma sintetico gruppi'; day.exercises = [item]; document.days = [day]
  const draft = await a.client.rpc('save_workout_draft', { ...programPayload(document), p_expected_revision: 0 }); assert.equal(draft.error, null)
  const published = await a.client.rpc('publish_workout_version', { p_version_id: document.id, p_expected_revision: 1, p_expected_plan_revision: 1 }); assert.equal(published.error, null)
  const start = await a.client.rpc('start_workout_session', { p_session_id: randomUUID(), p_version_id: document.id, p_day_id: day.id, p_diary_date: '2026-10-02', p_time_zone: 'Europe/Rome' }); assert.equal(start.error, null)
  const snapshot = sessionFromRow(start.data).session
  assert.equal(snapshot.day.exercises[0].muscleGroup, 'Spalle')
  const updated = await a.repo.save(id, { ...second, muscleGroup: 'Petto' }, second.revision, signal()); assert.equal(updated.muscleGroup, 'Petto')
  const historical = await a.client.from('workout_sessions').select('*').eq('id', snapshot.id).single(); assert.equal(historical.error, null)
  assert.deepEqual(sessionFromRow(historical.data).session, snapshot)
  pass('programma pubblicato → seduta → riclassificazione, snapshot storico identico')
  console.log(`PASS ${checks.length} gruppi API locali`)
} finally {
  // Un errore di pulizia non deve nascondere quello del test: si segnala e si chiude con errore.
  for (const user of users) { const result = await admin.auth.admin.deleteUser(user); if (result.error) { console.error('FAIL pulizia account sintetico'); process.exitCode = 1 } }
}
