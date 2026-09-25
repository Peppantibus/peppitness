import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDemoState, mealLogKey, recordMeal, startDemoSession } from '../src/persistence/demo-store.ts'
import type { Meal, WorkoutDay } from '../src/domain/types.ts'

const meal: Meal = { id: 'test-meal', name: 'Pasto di prova', timeLabel: 'Demo', description: 'Esempio', items: ['Elemento di prova'], alternative: '', note: '' }
const day: WorkoutDay = { id: 'test-day', label: 'Prova', title: 'Seduta di prova', subtitle: '', exercises: [{ id: 'p1', exerciseId: 'e1', name: 'Esercizio di prova', area: '', sets: 2, target: '8', mode: 'reps', restSeconds: 60, note: '' }] }

test('registrare ieri non altera oggi e conserva la fotografia del pasto', () => {
  let state = recordMeal(createDemoState(), '2026-09-24', meal, 'modified', 'Nota ieri')
  state = recordMeal(state, '2026-09-25', meal, 'followed', '')
  state.dayTypes['2026-09-24'] = 'rest'
  state = recordMeal(state, '2026-09-24', { ...meal, name: 'Nome successivo' }, 'skipped', 'Correzione')
  assert.equal(state.mealLogs[mealLogKey('2026-09-24', meal.id)].snapshot.name, 'Pasto di prova')
  assert.equal(state.mealLogs[mealLogKey('2026-09-24', meal.id)].dayType, 'training')
  assert.equal(state.mealLogs[mealLogKey('2026-09-25', meal.id)].status, 'followed')
})

test('avvii ripetuti e cambio data non duplicano una seduta in corso', () => {
  const state = startDemoSession(createDemoState(), '2026-09-25', day)
  assert.equal(startDemoSession(state, '2026-09-26', day), state)
  assert.equal(state.sessions.length, 1)
  assert.equal(state.sessions[0].date, '2026-09-25')
  assert.equal(state.sessions[0].results.p1[0].amount, '')
  assert.equal(state.sessions[0].results.p1[0].completed, false)
})

test('le prescrizioni di una seduta non seguono cambiamenti successivi', () => {
  const original = structuredClone(day)
  const state = startDemoSession(createDemoState(), '2026-09-25', original)
  original.exercises[0].target = '15'
  assert.equal(state.sessions[0].day.exercises[0].target, '8')
  assert.equal(createDemoState().sessions.length, 0)
})
