import { test } from 'node:test'
import assert from 'node:assert/strict'
import { newPrescription, newProgram, programPayload, validateProgram } from '../src/domain/programs.ts'
import type { CatalogExercise } from '../src/domain/exercises.ts'
import { copyWeeklyDay, dayForDate, dayIssues, emptyWeeklyDay, fitsWizard, groupsFromTitle, isWeekly, prefillFromDay, setWeeklyDay, titleFromGroups, weekdayOfDate, weeklyDay, weeklySummary } from '../src/domain/weekly.ts'
import { fitsMealWizard } from '../src/domain/meal-plans.ts'

const squat: CatalogExercise = { id: 'aaaaaaaa-0000-4000-8000-000000000001', name: 'Squat', variant: '', equipment: '', loadConvention: 'total', loadUnit: 'kg', measurementMode: 'reps', perSide: false, note: '', archivedAt: null, revision: 1 }
const plank: CatalogExercise = { ...squat, id: 'aaaaaaaa-0000-4000-8000-000000000002', name: 'Plank', measurementMode: 'seconds' }

test('settimana: giorno della data, lunedì = 0, riposo quando manca la seduta', () => {
  assert.equal(weekdayOfDate('2026-09-28'), 0)
  assert.equal(weekdayOfDate('2026-09-27'), 6)
  const days = [{ label: 'Lun', title: 'Petto' }, { label: 'Gio', title: 'Gambe' }]
  assert.ok(isWeekly(days))
  assert.equal(isWeekly([{ label: 'A' }]), false)
  assert.equal(isWeekly([]), false)
  assert.equal(dayForDate(days, '2026-09-28')?.title, 'Petto')
  assert.equal(dayForDate(days, '2026-09-29'), undefined)
  assert.equal(dayForDate(days, '2026-10-01')?.title, 'Gambe')
  assert.deepEqual(weeklySummary(days).map(item => item.title), ['Petto', null, null, 'Gambe', null, null, null])
})

test('wizard: giorni in ordine, riposo rimuove la seduta, gruppi muscolari nel titolo', () => {
  let document = newProgram()
  assert.ok(fitsWizard(document))
  document = setWeeklyDay(document, 3, { ...emptyWeeklyDay(3), title: titleFromGroups(['Gambe', 'Glutei']) })
  document = setWeeklyDay(document, 0, emptyWeeklyDay(0))
  assert.deepEqual(document.days.map(day => day.label), ['Lun', 'Gio'])
  assert.deepEqual(groupsFromTitle(weeklyDay(document, 3)!.title), ['Gambe', 'Glutei'])
  assert.equal(titleFromGroups([]), 'Allenamento')
  assert.equal(titleFromGroups(['Tricipiti', 'Petto']), 'Petto · Tricipiti', 'ordine stabile dei gruppi')
  document = setWeeklyDay(document, 0, null)
  assert.deepEqual(document.days.map(day => day.label), ['Gio'])
  assert.equal(fitsWizard({ ...document, days: [{ ...document.days[0]!, label: 'A' }] }), false)
})

test('wizard: nessun numero inventato, ripresa dall’esercizio precedente, validazione per campo', () => {
  const day = emptyWeeklyDay(0)
  const first = prefillFromDay(newPrescription(squat), day)
  assert.equal(first.sets, '', 'senza precedente i campi restano vuoti')
  const issues = dayIssues({ ...day, exercises: [first] })
  assert.ok(issues[`${first.id}:sets`]); assert.ok(issues[`${first.id}:reps`])
  const filled = { ...first, sets: '4', repsMin: '6', repsMax: '8', restSeconds: '120' }
  const withFirst = { ...day, exercises: [filled] }
  assert.deepEqual(dayIssues(withFirst), {})
  const second = prefillFromDay(newPrescription(squat), withFirst)
  assert.deepEqual([second.sets, second.repsMin, second.repsMax, second.restSeconds], ['4', '6', '8', '120'])
  const timed = prefillFromDay(newPrescription(plank), withFirst)
  assert.equal(timed.sets, '', 'modalità diversa: nessuna copia')
  assert.ok(dayIssues({ ...day, exercises: [{ ...filled, repsMin: '10', repsMax: '8' }] })[`${filled.id}:reps`])
  assert.ok(dayIssues({ ...day, exercises: [{ ...timed, sets: '3', restSeconds: '0' }] })[`${timed.id}:duration`])
})

test('wizard: il documento prodotto è accettato dalla RPC di salvataggio e pubblicazione', () => {
  let document = { ...newProgram(), title: 'Forza 3 giorni' }
  const monday = { ...emptyWeeklyDay(0), title: 'Petto · Tricipiti', exercises: [{ ...newPrescription(squat), sets: '3', repsMin: '8', repsMax: '10', restSeconds: '90' }] }
  document = setWeeklyDay(document, 0, monday)
  document = setWeeklyDay(document, 4, copyWeeklyDay(monday, 4))
  assert.equal(validateProgram(document, true), null)
  const payload = programPayload(document)
  assert.deepEqual(payload.p_days.map(day => day.label), ['Lun', 'Ven'])
  assert.notEqual(payload.p_days[0]!.exercises[0]!.id, payload.p_days[1]!.exercises[0]!.id, 'copia con nuovi ID')
  assert.equal(payload.p_days[1]!.exercises[0]!.exercise_id, squat.id, 'stesso esercizio del catalogo')
})

test('dieta: struttura compatibile con il wizard', () => {
  const day = (dayType: 'training' | 'rest' | 'any') => ({ id: crypto.randomUUID(), name: 'x', dayType, note: '', meals: [] })
  assert.ok(fitsMealWizard({ guidance: '', days: [] }))
  assert.ok(fitsMealWizard({ guidance: '', days: [day('any')] }))
  assert.ok(fitsMealWizard({ guidance: '', days: [day('training'), day('rest')] }))
  assert.equal(fitsMealWizard({ guidance: '', days: [day('training'), day('training')] }), false)
  assert.equal(fitsMealWizard({ guidance: '', days: [day('rest')] }), false)
})

test('cardio a tempo: solo minuti, 1 serie e nessun recupero richiesti', () => {
  const treadmill: CatalogExercise = { ...plank, id: 'aaaaaaaa-0000-4000-8000-000000000003', name: 'Camminata su tapis roulant', muscleGroup: 'Cardio' }
  const item = { ...newPrescription(treadmill), durationSeconds: '1200' }
  assert.equal(item.sets, '1')
  assert.deepEqual(dayIssues({ ...emptyWeeklyDay(0), exercises: [item] }), {})
  assert.equal(dayIssues({ ...emptyWeeklyDay(0), exercises: [{ ...item, durationSeconds: '' }] })[`${item.id}:duration`], 'Indica i minuti.')
  assert.equal(newPrescription(plank).sets, '')
})
