import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { readLocalStatus } from './local-supabase.mjs'
import { createExercisesRepository } from '../../src/persistence/exercises-repository.ts'
import { newPrescription, programPayload } from '../../src/domain/programs.ts'
import { workoutDaysFromProgram } from '../../src/domain/diary.ts'
import { localDate, weekDates } from '../../src/domain/dates.ts'

export async function workoutChangesFixture() {
  const config = readLocalStatus()
  assert.match(config.apiUrl, /^http:\/\/(127\.0\.0\.1|localhost):/)
  const admin = createClient(config.apiUrl, config.adminKey, { auth: { persistSession: false, autoRefreshToken: false } })
  const owners = []
  const cleanup = async () => {
    for (const id of owners) { const result = await admin.auth.admin.deleteUser(id); assert.ifError(result.error) }
  }
  try {
    const account = async () => {
      const email = `changes-${randomUUID()}@example.invalid`, password = `Aa1!${randomBytes(18).toString('base64url')}`
      const made = await admin.auth.admin.createUser({ email, password, email_confirm: true })
      assert.ifError(made.error); owners.push(made.data.user.id)
      const client = createClient(config.apiUrl, config.publicKey, { auth: { persistSession: false, autoRefreshToken: false } })
      const login = await client.auth.signInWithPassword({ email, password })
      assert.ifError(login.error)
      return { client, owner: made.data.user.id, session: login.data.session }
    }
    const a = await account(), b = await account()
    const entries = [
      ['Chest press', 'Petto', 'reps', 'total'], ['Lat machine', 'Schiena', 'reps', 'total'], ['Spinta con manubri', 'Petto', 'reps', 'single-dumbbell'],
      ['Stairs Master', 'Cardio', 'seconds', 'bodyweight'], ['Tapis roulant', 'Cardio', 'seconds', 'bodyweight'], ['Plank', 'Addome', 'seconds', 'bodyweight'],
      ['Lat machine simile', 'Schiena', 'reps', 'total'], ['Carry', 'Full body', 'seconds', 'bodyweight'],
    ]
    const inserted = await a.client.from('exercises').insert(entries.map(([name, muscle_group, measurement_mode, load_convention]) => ({
      id: randomUUID(), name, muscle_group, measurement_mode, load_convention, equipment: 'Attrezzo sintetico', note: `Tecnica ${name}`,
    })))
    assert.ifError(inserted.error)
    const catalog = await createExercisesRepository(a.client, a.owner).list(AbortSignal.timeout(10000))
    const find = name => catalog.find(row => row.name === name)
    const item = (name, sets, amount, rest = '90') => ({ ...newPrescription(find(name)), sets, repsMin: find(name).measurementMode === 'reps' ? amount : '',
      repsMax: find(name).measurementMode === 'reps' ? amount : '', durationSeconds: find(name).measurementMode === 'seconds' ? amount : '', restSeconds: rest, rir: '', rpe: '', note: `Prescrizione ${name}` })
    const chest = { ...item('Chest press', '3', '8'), optionalSets: '1', repsMax: '12', rir: '2' }
    const lat = { ...item('Lat machine', '5', '6', '150'), optionalSets: '2', repsMax: '8', rpe: '8' }
    const stairs = { ...item('Stairs Master', '1', '600', '0'), note: '' }, tapis = { ...item('Tapis roulant', '1', '900', '0'), note: '' }
    const document = { planId: randomUUID(), id: randomUUID(), title: 'Settimana sintetica sostituzioni', guidance: '', days: [
      { id: randomUUID(), label: 'Lun', title: 'Lunedì sintetico', note: '', exercises: [chest, stairs, item('Plank', '1', '30')] },
      { id: randomUUID(), label: 'Mer', title: 'Mercoledì sintetico', note: '', exercises: [lat, tapis] },
      { id: randomUUID(), label: 'Ven', title: 'Venerdì sintetico', note: '', exercises: [{ ...lat, id: randomUUID() }] },
    ] }
    const saved = await a.client.rpc('save_workout_draft', { ...programPayload(document), p_expected_revision: 0 })
    assert.ifError(saved.error)
    const published = await a.client.rpc('publish_workout_version', { p_version_id: document.id, p_expected_revision: 1, p_expected_plan_revision: 1 })
    assert.ifError(published.error)
    const followed = await a.client.from('active_plans').insert({ workout_plan_id: document.planId })
    assert.ifError(followed.error)
    return { config, a, b, catalog, find, document, days: workoutDaysFromProgram(document), today: localDate(), monday: weekDates(localDate())[0], cleanup }
  } catch (error) { await cleanup(); throw error }
}
