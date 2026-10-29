import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { morningForDate, validMorningRoutine } from '../src/domain/morning-routine.ts'
import type { MorningRoutine } from '../src/domain/morning-routine.ts'
import { MorningRoutineStore } from '../src/persistence/morning-routine-store.ts'
import { MorningFailure } from '../src/persistence/morning-routine-repository.ts'
import type { MorningDay, MorningRepository, MorningRow } from '../src/persistence/morning-routine-repository.ts'
import { memoryStorage } from '../src/persistence/diary-store.ts'
const document = (): MorningRoutine => ({ title: 'Routine sintetica', base: [{ id: randomUUID(), name: 'Movimento A', area: '', dose: '6 rip.', minutes: 10, note: 'Nota' }], extra: [{ id: randomUUID(), name: 'Movimento B', area: '', dose: '', minutes: 4, note: '' }], strengthDays: [2,4,6], note: '' })
function fake() {
  const data: { routine: MorningRow | null; days: MorningDay[] } = { routine: null, days: [] }
  let loseResponse = false, offline = false
  const repo: MorningRepository = {
    async load() { if (offline) throw new Error('offline'); return structuredClone(data) },
    async send(op) {
      if (offline) throw new Error('offline')
      const current = op.kind === 'routine' ? data.routine : data.days.find(day => day.date === op.date)
      if (current?.requestId === op.id) return structuredClone(current)
      if ((current?.revision ?? 0) !== op.revision) throw new MorningFailure('conflict')
      const common = { revision: op.revision + 1, requestId: op.id }
      const row = op.kind === 'routine' ? { ...common, document: structuredClone(op.document) } : { ...common, date: op.date, snapshot: structuredClone(op.snapshot) }
      if ('document' in row) data.routine = row
      else { data.days = data.days.filter(day => day.date !== row.date); data.days.push(row) }
      if (loseResponse) { loseResponse = false; throw new Error('response lost') }
      return structuredClone(row)
    },
  }
  return { data, repo, offline: (value: boolean) => { offline = value }, lose: () => { loseResponse = true } }
}
test('routine: giorno ISO, 10/14 minuti e nessuna modifica al documento', () => {
  const value = document(), original = structuredClone(value)
  for (const date of ['2026-10-27','2026-10-29','2026-10-31']) assert.equal(morningForDate(value,date).minutes,14)
  for (const date of ['2026-10-26','2026-10-28','2026-10-30','2026-11-01']) assert.equal(morningForDate(value,date).minutes,10)
  assert.deepEqual(value,original); assert.throws(()=>morningForDate(value,'2026-02-30'))
})
test('routine: struttura, identità, mezzi minuti e limiti validati', () => {
  const value=document(); assert.equal(validMorningRoutine(value),true)
  for(const invalid of [{...value,extra:[value.base[0]]},{...value,strengthDays:[2,2]},{...value,base:[]},{...value,hidden:'x'},{...value,base:[{...value.base[0],minutes:.3}]},{...value,base:[{...value.base[0],minutes:NaN}]}])assert.equal(validMorningRoutine(invalid),false)
})
test('routine: offline, reload, invio ordinato e storico con snapshot immutabile', async () => {
  const f=fake(),storage=memoryStorage();let store=new MorningRoutineStore(f.repo,storage,'A');store.start();await store.synchronize()
  f.offline(true);const value=document();assert.equal(store.save(value),true);assert.equal(store.complete('2026-10-29','2026-10-29'),true)
  store.stop();store=new MorningRoutineStore(f.repo,storage,'A');store.start();assert.equal(store.getSnapshot().pending,2)
  const edited={...value,title:'Modificata',base:[{...value.base[0]!,minutes:12}]};store.save(edited)
  assert.equal(store.getSnapshot().days['2026-10-29']?.snapshot?.title,value.title)
  assert.equal(store.complete('2026-10-30','2026-10-29'),false)
  f.offline(false);await store.synchronize();assert.equal(store.getSnapshot().pending,0)
  assert.equal(f.data.routine?.document.title,'Modificata');assert.equal(f.data.days[0]?.snapshot?.title,value.title)
  store.undo('2026-10-29');await store.synchronize();assert.equal(f.data.days[0]?.snapshot,null);store.stop()
})
test('routine: risposta persa, retry idempotente, nessuna doppia revisione',async()=>{
  const f=fake(),store=new MorningRoutineStore(f.repo,memoryStorage(),'A');store.start();await store.synchronize();store.save(document());f.lose();await store.synchronize()
  assert.equal(store.getSnapshot().pending,1);assert.equal(f.data.routine?.revision,1)
  await store.synchronize();assert.equal(store.getSnapshot().pending,0);assert.equal(f.data.routine?.revision,1);store.stop()
})
test('routine: due client in conflitto preservano le modifiche e risolvono esplicitamente',async()=>{
  const f=fake(),a=new MorningRoutineStore(f.repo,memoryStorage(),'A'),b=new MorningRoutineStore(f.repo,memoryStorage(),'A')
  a.start();b.start();await a.synchronize();await b.synchronize();a.save(document());await a.synchronize();b.save({...document(),title:'B'});await b.synchronize()
  assert.equal(b.getSnapshot().sync,'conflict');assert.equal(b.getSnapshot().routine?.title,'B');assert.equal(b.getSnapshot().pending,1)
  await b.resolve(true);await b.synchronize();assert.equal(f.data.routine?.document.title,'B');assert.equal(f.data.routine?.revision,2);a.stop();b.stop()
})
test('routine: uso online scarta solo la chiave in conflitto; account isolati e logout svuota la copia',async()=>{
  const f=fake(),storage=memoryStorage(),store=new MorningRoutineStore(f.repo,storage,'A');store.start();await store.synchronize();store.save(document());await store.synchronize()
  store.save({...document(),title:'Locale'});store.complete('2026-10-29','2026-10-29');f.data.routine!.revision++
  await store.synchronize();assert.equal(store.getSnapshot().sync,'conflict');await store.resolve(false);await store.synchronize()
  assert.equal(store.getSnapshot().pending,0);assert.equal(f.data.days.length,1)
  const other=new MorningRoutineStore(null,storage,'B');assert.equal(other.getSnapshot().routine,null)
  store.clearDevice();assert.equal(storage.get(store.storageKey),null);other.stop()
})
test('routine: storage indisponibile resta segnalato, risposta dopo stop non riapre account',async()=>{
  const f=fake(),storage={get:()=>null,set:()=>{throw new Error('full')},remove:()=>{}}
  const store=new MorningRoutineStore(f.repo,storage,'A');store.start();await store.synchronize();store.save(document());assert.equal(store.getSnapshot().storage,false)
  store.clearDevice();await store.synchronize();assert.equal(store.getSnapshot().pending,0);assert.equal(store.getSnapshot().routine,null)
})
test('routine: un editor aperto prima di una rilettura non sovrascrive una versione nuova',async()=>{
  const f=fake(),store=new MorningRoutineStore(f.repo,memoryStorage(),'A');store.start();await store.synchronize()
  const openedRevision=store.getSnapshot().routineRevision
  f.data.routine={document:document(),requestId:randomUUID(),revision:1};await store.synchronize()
  store.save({...document(),title:'Bozza precedente'},openedRevision);await store.synchronize()
  assert.equal(store.getSnapshot().sync,'conflict');assert.notEqual(f.data.routine.document.title,'Bozza precedente');store.stop()
})
