import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatDate, isLocalDate, localDate, shiftDate, weekDates } from '../src/domain/dates.ts'
import { parseNonNegativeNumber, validateSet } from '../src/domain/validation.ts'

test('il diario segue il giorno italiano vicino alla mezzanotte UTC', () => {
  assert.equal(localDate(new Date('2026-09-25T22:30:00Z')), '2026-09-26')
  assert.equal(localDate(new Date('2026-01-01T23:30:00Z')), '2026-01-02')
})

test('giorni e settimane rimangono stabili attraverso ora legale, mesi e anni', () => {
  assert.equal(shiftDate('2026-03-28', 1), '2026-03-29')
  assert.equal(shiftDate('2026-10-25', 1), '2026-10-26')
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01')
  assert.equal(shiftDate('2024-03-01', -1), '2024-02-29')
  assert.deepEqual(weekDates('2026-09-27'), ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'])
  assert.equal(formatDate('2026-09-25', { day: 'numeric', month: 'long' }), '25 settembre')
})

test('date impossibili non vengono normalizzate silenziosamente', () => {
  assert.equal(isLocalDate('2026-02-30'), false)
  assert.equal(isLocalDate('2026-13-01'), false)
  assert.equal(isLocalDate('2024-02-29'), true)
  assert.throws(() => shiftDate('non-una-data', 1))
})

test('virgola italiana, vuoto e zero conservano significati distinti', () => {
  assert.equal(parseNonNegativeNumber('12,5'), 12.5)
  assert.equal(parseNonNegativeNumber(' 0 '), 0)
  assert.equal(parseNonNegativeNumber(''), null)
  assert.equal(parseNonNegativeNumber('  '), null)
  assert.equal(parseNonNegativeNumber('1000'), 1000)
  for (const value of ['12kg', '-1', '1,2,3', 'Infinity', '2e3']) assert.throws(() => parseNonNegativeNumber(value))
})

test('una serie vuota non è completata; durata e ripetizioni sono distinte', () => {
  assert.ok(validateSet('', '', 'reps'))
  assert.equal(validateSet('', '8', 'reps'), null)
  assert.equal(validateSet('0', '0', 'reps'), null)
  assert.ok(validateSet('12,5', '8,5', 'reps'))
  assert.equal(validateSet('', '30,5', 'seconds'), null)
})
