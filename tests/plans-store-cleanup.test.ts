import assert from 'node:assert/strict'
import test from 'node:test'
import { memoryStorage } from '../src/persistence/diary-store.ts'
import { PlansStore } from '../src/persistence/plans-store.ts'
import type { PlansRepository } from '../src/persistence/plans-repository.ts'
import type { ProgramsRepository } from '../src/persistence/programs-repository.ts'

// SA-01: una richiesta annullata dall'uscita non deve ricreare la copia offline dei piani.
const owner = '11111111-1111-4111-8111-111111111111'
const key = `peppitness:plans:v1:${owner}`
const privatePlan = { id: '33333333-3333-4333-8333-333333333333', name: 'PIANO_PRIVATO_SINTETICO', document: { guidance: '', days: [] }, archivedAt: null, revision: 1 }

function fixture() {
  const state = { reachedSelect: false }
  const plans = {
    selection: async (signal: AbortSignal) => { signal.throwIfAborted(); return { workoutPlanId: null, mealPlanId: null, revision: 1 } },
    mealPlans: async () => [privatePlan],
    select: async (_v: unknown, _r: unknown, signal: AbortSignal) => {
      state.reachedSelect = true
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('annullata')), { once: true }))
    },
  } as unknown as PlansRepository
  const programs = { list: async () => [] } as unknown as ProgramsRepository
  const storage = memoryStorage()
  return { state, storage, store: new PlansStore(plans, programs, storage, owner) }
}

test('clearDevice durante una selezione in corso non ricrea la cache dopo l’abort', async () => {
  const { state, storage, store } = fixture()
  await store.load()
  assert.notEqual(storage.get(key), null, 'cache scritta dopo il caricamento')
  const pending = store.choose({ mealPlanId: null })
  assert.ok(state.reachedSelect, 'richiesta in volo')
  store.clearDevice()
  assert.equal(storage.get(key), null, 'rimossa subito')
  await pending
  assert.equal(storage.get(key), null, 'nessuna cache dopo l’abort')
})

test('un nuovo load intenzionale dopo stop riattiva lo store', async () => {
  const { storage, store } = fixture()
  await store.load()
  store.stop()
  storage.remove(key)
  await store.load()
  assert.notEqual(storage.get(key), null, 'load dopo stop salva di nuovo la cache')
})
