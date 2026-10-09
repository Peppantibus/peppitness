import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adjustRest, carryLoadForward, comparable, completeSetChanges, pendingFilledSet, filledUnchecked, findPreviousExercise, formatResult, isStaleSession, nextExercise, remainingRest, reusePreviousLoads, sessionOrder, sessionProgress } from '../src/domain/workout.ts'
import { applyOp, emptyResults, nextRestTimer } from '../src/domain/diary.ts'
import type { WorkoutSession, ExercisePrescription, RestTimerState, SetResult } from '../src/domain/types.ts'

const exercise: ExercisePrescription = { id: 'p1', exerciseId: 'stable-row', name: 'Rematore', area: 'Schiena', sets: 2, target: '10', mode: 'reps', restSeconds: 90, note: '', comparison: { variant: 'unilaterale', equipment: 'manubrio', loadConvention: 'single-dumbbell', perSide: true } }
const completed: SetResult = { load: '12,5', amount: '10', completed: true }
const empty: SetResult = { load: '', amount: '', completed: false }
function session(id: string, date: string, prescription = exercise, done = true): WorkoutSession {
  return { id, date, startedAt: `${date}T10:00:00Z`, completedAt: done ? `${date}T11:00:00Z` : undefined, day: { id: id + '-day', label: id, title: 'Seduta ' + id, subtitle: '', exercises: [prescription] }, results: { [prescription.id]: [{ ...completed }, { ...empty }] } }
}

test('il precedente segue data e identità, anche con una seduta e un nome diversi', () => {
  const old = session('old', '2026-09-18')
  const recent = session('recent', '2026-09-25', { ...exercise, id: 'p-alt', name: 'Nome aggiornato' })
  const current = session('current', '2026-10-02', exercise, false)
  assert.equal(findPreviousExercise([old, recent, current], exercise, current)?.session.id, 'recent')
  assert.equal(findPreviousExercise([recent], exercise, current)?.results[0].load, '12,5')
})

test('nessun confronto tra macchine, varianti, modalità o convenzioni diverse', () => {
  assert.equal(comparable(exercise, { ...exercise, comparison: undefined }), false)
  assert.equal(comparable(exercise, { ...exercise, mode: 'seconds' }), false)
  assert.equal(comparable(exercise, { ...exercise, exerciseId: 'different' }), false)
  for (const mismatch of [{ equipment: 'macchina-2' }, { variant: 'bilaterale' }, { loadConvention: 'total' as const }, { perSide: false }]) {
    assert.equal(comparable(exercise, { ...exercise, comparison: { ...exercise.comparison!, ...mismatch } }), false)
  }
})

test('ignora futuro, seduta corrente, incompleti e ultimi esercizi senza serie eseguite', () => {
  const current = session('current', '2026-10-02', exercise, false)
  const old = session('old', '2026-09-18')
  const noSets = session('empty', '2026-09-25')
  noSets.results.p1 = [{ ...empty }]
  const sessions = [session('future', '2026-10-09'), session('unfinished', '2026-09-30', exercise, false), current, noSets, old]
  assert.equal(findPreviousExercise(sessions, exercise, current)?.session.id, 'old')
  assert.equal(findPreviousExercise([current], exercise, current), undefined)
})

test('riprendere i carichi conserva ripetizioni vuote e non sovrascrive valori inseriti', () => {
  const current = [{ ...empty }, { ...empty, load: '20' }, { ...completed }, { ...empty }]
  const previous = [{ ...completed }, { ...completed }, { ...completed, load: '25' }, { ...completed, completed: false }]
  const result = reusePreviousLoads(current, previous)
  assert.deepEqual(result[0], { load: '12,5', amount: '', completed: false })
  assert.equal(result[1], current[1])
  assert.equal(result[2], current[2])
  assert.equal(result[3], current[3])
  assert.equal(current[0].load, '')
})

test('zero, corpo libero, durata e serie non eseguite hanno una resa distinta', () => {
  assert.equal(formatResult({ load: '0', amount: '0', completed: true }, 'reps'), '0 kg × 0 rip.')
  assert.equal(formatResult({ load: '', amount: '30', completed: true }, 'seconds'), '30 s')
  assert.equal(formatResult({ load: '10', amount: '30', completed: true }, 'seconds'), '30 s', 'a tempo: il carico non si mostra')
  assert.equal(formatResult({ ...completed, completed: false }, 'reps'), '—')
  assert.equal(formatResult(completed, 'reps', 'lb'), '12,5 lb × 10 rip.')
})

test('il recupero parte una sola volta su Fatto e si annulla riaprendo la stessa serie', () => {
  const day = session('fixture', '2026-10-02').day
  let data = { sessions: [{ id: 'live', date: '2026-10-02', startedAt: '2026-10-02T10:00:00Z', day, results: emptyResults(day) }], mealLogs: {}, dayTypes: {} }
  let timer: RestTimerState | null = null
  const set = (index: number, result: SetResult, now: number) => {
    timer = nextRestTimer(timer, data.sessions[0]!, exercise.id, index, result, now)
    data = applyOp(data, { type: 'set', opId: String(now), sessionId: 'live', prescriptionId: exercise.id, index, result })
  }
  set(0, completed, 1000)
  assert.equal(timer!.deadline, 91000)
  set(0, completed, 2000)
  assert.equal(timer!.deadline, 91000)
  set(1, completed, 5000)
  assert.equal(timer!.deadline, 95000)
  set(0, empty, 6000)
  assert.equal(timer!.setIndex, 1)
  set(1, empty, 7000)
  assert.equal(timer, null)
})

test('il timer usa una scadenza assoluta, recupera il tempo passato e rispetta la pausa', () => {
  const timer: RestTimerState = { sessionId: 's', exerciseId: 'e', exerciseName: 'Esercizio', setIndex: 0, durationSeconds: 90, deadline: 91000, pausedSeconds: null }
  assert.equal(remainingRest(timer, 1000), 90)
  assert.equal(remainingRest(timer, 61000), 30)
  assert.equal(remainingRest(timer, 200000), 0)
  assert.equal(remainingRest({ ...timer, pausedSeconds: 20 }, 200000), 20)
})

test('il carico passa alla serie successiva vuota dello stesso tipo, mai ripetizioni né spunta', () => {
  const done = { load: '40', amount: '8', completed: true }
  // Obbligatoria → obbligatoria: solo il carico, la serie resta da fare.
  assert.deepEqual(carryLoadForward([done, { ...empty }, { ...empty }], 0, 3), { index: 1, result: { load: '40', amount: '', completed: false } })
  // Un carico già scritto, una serie già fatta o un corpo libero senza carico non cambiano nulla.
  assert.equal(carryLoadForward([done, { ...empty, load: '35' }], 0, 2), null)
  assert.equal(carryLoadForward([done, { ...completed }], 0, 2), null)
  assert.equal(carryLoadForward([{ ...done, load: '' }, { ...empty }], 0, 2), null)
  assert.equal(carryLoadForward([{ ...done, completed: false }, { ...empty }], 0, 2), null, 'solo dopo la spunta')
  assert.equal(carryLoadForward([done], 0, 1), null, 'ultima serie')
  // L'ultima obbligatoria non attiva la prima facoltativa; fra facoltative sì.
  assert.equal(carryLoadForward([done, { ...empty }], 0, 1), null)
  assert.equal(carryLoadForward([done, done, { ...empty }], 1, 1)?.index, 2)
})

test('passando all’esercizio successivo si segna solo l’ultima serie compilata e accettabile', () => {
  const done = { load: '40', amount: '8', completed: true }
  // Serie 2 compilata, serie 3 vuota: è la 2 quella appena fatta.
  assert.equal(pendingFilledSet([done, { load: '40', amount: '8', completed: false }, { ...empty }], 'reps'), 1)
  // Già spuntata, solo il carico, valore incompleto o niente di scritto: nulla da segnare.
  assert.equal(pendingFilledSet([done, done], 'reps'), undefined)
  assert.equal(pendingFilledSet([done, { ...empty, load: '40' }], 'reps'), undefined)
  assert.equal(pendingFilledSet([done, { load: '', amount: '8,5', completed: false }], 'reps'), undefined)
  assert.equal(pendingFilledSet([{ ...empty }], 'reps'), undefined)
  // A tempo: basta il tempo.
  assert.equal(pendingFilledSet([{ load: '', amount: '30', completed: false }], 'seconds'), 0)
  // La spunta porta con sé il carico alla serie successiva ancora vuota.
  assert.deepEqual(completeSetChanges([{ load: '40', amount: '8', completed: false }, { ...empty }], 0, 2), [
    { index: 0, result: { load: '40', amount: '8', completed: true } },
    { index: 1, result: { load: '40', amount: '', completed: false } },
  ])
  assert.deepEqual(completeSetChanges([{ load: '', amount: '30', completed: false }], 0, 1), [{ index: 0, result: { load: '', amount: '30', completed: true } }])
})

test('il recupero si accorcia di 15 s fino a zero, anche in pausa; +15 s allunga anche la durata', () => {
  const timer: RestTimerState = { sessionId: 's', exerciseId: 'e', exerciseName: 'Esercizio', setIndex: 0, durationSeconds: 90, deadline: 91000, pausedSeconds: null }
  assert.equal(remainingRest(adjustRest(timer, -15, 1000), 1000), 75)
  assert.equal(adjustRest(timer, -15, 1000).durationSeconds, 90)
  assert.equal(remainingRest(adjustRest(timer, -15, 85000), 85000), 0, 'a 6 s restanti: terminato, non negativo')
  assert.equal(adjustRest(timer, 15, 1000).durationSeconds, 105)
  assert.equal(remainingRest(adjustRest(timer, 15, 1000), 1000), 105)
  const paused = { ...timer, pausedSeconds: 10 }
  assert.equal(adjustRest(paused, -15, 1000).pausedSeconds, 0)
  assert.equal(adjustRest(paused, 15, 1000).pausedSeconds, 25)
})

test('serie compilate senza spunta, avanzamento e seduta dimenticata', () => {
  const live = session('live', '2026-10-02', { ...exercise, sets: 2, optionalSets: 1 }, false)
  live.results.p1 = [{ ...completed }, { load: '12,5', amount: '9', completed: false }, { load: '12,5', amount: '', completed: false }]
  assert.deepEqual(sessionProgress(live), { required: 2, completedRequired: 1 })
  assert.deepEqual(filledUnchecked(live).map(item => [item.index, item.required]), [[1, true]], 'mai una serie senza risultato')
  const started = Date.parse(live.startedAt)
  assert.equal(isStaleSession(live, started + 3 * 3600_000), false)
  assert.equal(isStaleSession(live, started + 4 * 3600_000), true)
  assert.equal(isStaleSession(session('done', '2026-10-02'), started + 24 * 3600_000), false, 'una seduta completata non è mai aperta')
})

test('«Fallo dopo»: il rimandato va in fondo e il passaggio automatico lo salta finché resta altro', () => {
  const make = (id: string): ExercisePrescription => ({ ...exercise, id, exerciseId: id, sets: 1 })
  const [a, b, c] = [make('a'), make('b'), make('c')]
  const live: WorkoutSession = { id: 'live', date: '2026-10-02', startedAt: '2026-10-02T10:00:00Z', day: { id: 'd', label: 'A', title: 'A', subtitle: '', exercises: [a, b, c] }, results: { a: [{ ...empty }], b: [{ ...empty }], c: [{ ...empty }] } }
  assert.deepEqual(sessionOrder(live.day.exercises, ['a']).map(item => item.id), ['b', 'c', 'a'])
  assert.deepEqual(sessionOrder(live.day.exercises, ['c', 'a']).map(item => item.id), ['b', 'c', 'a'], 'nell’ordine in cui sono stati rimandati')
  // Rimandando «a» si passa a «b»; completato «b» si va a «c», non al rimandato.
  assert.equal(nextExercise(live, [], 'a'), 'b')
  assert.equal(nextExercise(live, ['a'], 'b'), 'c')
  // Completati gli altri resta solo il rimandato: allora sì.
  live.results.b = [{ ...completed }]; live.results.c = [{ ...completed }]
  assert.equal(nextExercise(live, ['a'], 'c'), 'a')
  live.results.a = [{ ...completed }]
  assert.equal(nextExercise(live, ['a'], 'a'), undefined)
})
