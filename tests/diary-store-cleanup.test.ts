import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyDiary } from '../src/domain/diary.ts'
import type { DiaryTransport, Row } from '../src/persistence/diary-repository.ts'
import { DiaryStore, memoryStorage } from '../src/persistence/diary-store.ts'

// Come SA-01 per i piani: una risposta arrivata dopo l'uscita non deve ricreare l'archivio del diario.
const owner = '11111111-1111-4111-8111-111111111111'

function fixture() {
  let release: ((row: Row) => void) | undefined
  const transport = {
    loadAll: async () => ({ data: emptyDiary(), revisions: {} }),
    // Risposta già ricevuta prima dell'abort: la promise si risolve comunque.
    insert: () => new Promise<Row>(resolve => { release = resolve }),
  } as unknown as DiaryTransport
  const storage = memoryStorage()
  const store = new DiaryStore(transport, storage, owner)
  return { storage, store, release: (row: Row) => release!(row), inFlight: () => Boolean(release) }
}

test('clearDevice con una scrittura del diario in volo non ricrea l’archivio quando arriva la risposta', async () => {
  const { storage, store, release, inFlight } = fixture()
  await store.refresh()
  store.setDayType('2026-10-04', 'rest')
  const flushing = store.flush()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.ok(inFlight(), 'scrittura in volo')
  store.clearDevice()
  assert.equal(storage.get(store.storageKey), null, 'rimosso subito')
  release({ owner_id: owner, diary_date: '2026-10-04', day_type: 'rest', revision: 1 })
  await flushing
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(storage.get(store.storageKey), null, 'nessun archivio dopo la risposta tardiva')
  assert.equal(storage.get(`peppitness:diary:v2:${owner}:server`), null, 'nessuna copia confermata dopo la risposta tardiva')
})

test('dopo clearDevice né altre schede né il timer riscrivono l’archivio', async () => {
  const { storage, store } = fixture()
  await store.refresh()
  assert.notEqual(storage.get(store.storageKey), null, 'archivio scritto dopo la lettura')
  store.clearDevice()
  store.setRestTimer(null)
  store.reloadFromDevice()
  store.setDayType('2026-10-05', 'training')
  assert.equal(storage.get(store.storageKey), null)
})
