import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { validateExtraction } from '../src/import/contracts/index.ts'
import { e2eExtraction, e2eProposals } from '../supabase/functions/_shared/import/synthetic-e2e.ts'

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/import/e2e/${name}.json`, import.meta.url), 'utf8'))

test('24: risposte congelate del provider sintetico E2E = fixture annotate, conformi al contratto 01', () => {
  for (const kind of ['workout', 'diet'] as const) {
    assert.deepEqual(e2eProposals[kind], fixture(kind), `${kind}: nessuna deriva fra Edge sintetica e fixture`)
    assert.ok(validateExtraction(kind, e2eProposals[kind]).ok, `${kind}: DTO valido`)
  }
})

test('24: la proposta sintetica si attiva solo sulla fonte E2E e cita i blocchi letti davvero', () => {
  const blocks = [{ id: 'p:1', text: 'Scheda E2E sintetica' }, { id: 'p:2', text: 'Seduta A' }, { id: 't:1:r:0', text: 'Squat | 3 x 8-10 | recupero non indicato' }]
  const value = e2eExtraction('workout', blocks) as { evidence: { spans: { blockId: string }[] }[]; issues: { sourceRefs: string[] }[] }
  assert.ok(value.evidence.every(entry => entry.spans.every(span => blocks.some(block => block.id === span.blockId))))
  assert.deepEqual(value.issues[0]!.sourceRefs, ['t:1:r:0'])
  assert.equal(e2eExtraction('workout', [{ id: 'p:1', text: 'Altro documento' }]), null, 'altre fonti: trasporto sintetico standard')
  assert.throws(() => e2eExtraction('workout', blocks.slice(0, 2)), /Incomplete synthetic E2E source/)
})
