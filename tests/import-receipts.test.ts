import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { importHashVectorsInclude, renderImportHashVectors } from '../scripts/generate-import-hash-vectors.mjs'
import { commandHash, contentHash } from '../src/import/mapping/canonical.ts'
import { validateImportReceipt } from '../src/import/contracts/index.ts'

const readJson = (path: string) => JSON.parse(readFileSync(new URL(`./fixtures/import/contracts/${path}`, import.meta.url), 'utf8'))

/** Ricostruisce l'oggetto con le chiavi in ordine inverso a ogni livello. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedKeys(item)]))
}

test('include pgTAP 009 generato dagli stessi vettori JSON del task 02', () => {
  const included = readFileSync(new URL(`../${importHashVectorsInclude}`, import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  assert.equal(included, renderImportHashVectors(), 'rigenerare con node scripts/generate-import-hash-vectors.mjs')
  const vectors = readJson('hash-vectors.json').vectors as { id: string }[]
  for (const vector of vectors) assert.ok(included.includes(`('${vector.id}', `), vector.id)
})

test('ordine delle proprietà irrilevante per commandHash e contentHash', async () => {
  for (const vector of readJson('hash-vectors.json').vectors) {
    const command = reversedKeys(readJson(vector.command)) as Parameters<typeof commandHash>[0]
    assert.equal(await commandHash(command), vector.commandHash, vector.id)
    assert.equal(await contentHash(command.payload), vector.contentHash, vector.id)
  }
})

test('forma della ricevuta SQL = contratto ImportReceipt, senza owner né provenienza', () => {
  // Chiavi prodotte da peppitness_private.import_receipt_result (verificate anche in pgTAP 009).
  const sqlKeys = ['commandHash', 'contentHash', 'exerciseBindings', 'kind', 'planId', 'requestId', 'resultState', 'selection', 'versionId']
  for (const name of ['receipts/workout-basic-committed.json', 'receipts/diet-follow-deleted.json']) {
    const receipt = readJson(name)
    assert.ok(validateImportReceipt(receipt).ok, name)
    assert.deepEqual(Object.keys(receipt).sort(), sqlKeys, name)
    assert.equal(validateImportReceipt({ ...receipt, ownerId: '91111111-1111-4111-8111-111111111111' }).ok, false, 'owner mai esposto')
  }
})
