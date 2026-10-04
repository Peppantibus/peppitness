import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { commitFixtureCases } from '../scripts/lib/import-commit-fixtures.mjs'
import type { CommitCommand, ImportReceipt } from '../src/import/contracts/index.ts'
import { commandHash, contentHash } from '../src/import/mapping/canonical.ts'
import {
  commitFailure, CommitRejected, createImportsRepository, ImportsFailure,
} from '../src/persistence/imports-repository.ts'

const OWNER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const REQUEST = '44444444-4444-4444-8444-444444444444'
const cases = commitFixtureCases() as { id: string; kind: 'workout' | 'diet'; command: CommitCommand }[]
const workoutCommand = cases.find(item => item.id === 'workout-catalog')!.command
const dietCommand = cases.find(item => item.kind === 'diet')!.command

async function receiptFor(command: CommitCommand, patch: Partial<ImportReceipt> = {}): Promise<ImportReceipt> {
  const planId = command.payload.kind === 'workout' ? command.payload.resolved.planId : command.payload.resolved.plan.id
  return {
    requestId: command.requestId, kind: command.payload.kind, commandHash: await commandHash(command), contentHash: await contentHash(command.payload),
    resultState: 'committed', planId, versionId: command.payload.kind === 'workout' ? command.payload.resolved.versionId : null,
    exerciseBindings: command.payload.kind === 'workout' ? command.payload.resolved.catalog.map(binding => ({
      ref: binding.ref, exerciseId: binding.choice.source === 'existing' ? binding.ref : '55555555-5555-4555-8555-555555555555',
      resolution: binding.choice.source === 'existing' ? 'existing' as const : binding.choice.source === 'shared' ? 'adopted' as const : 'created' as const,
    })) : [],
    selection: null, ...patch,
  }
}

interface Call { kind: 'rpc' | 'from'; name: string; args?: unknown; filters: [string, string, unknown][]; headers: Record<string, string>; retry: boolean | null; signal: AbortSignal | null }
type Reply = { data: unknown; error: { code?: string; message?: string } | null } | Promise<{ data: unknown; error: { code?: string; message?: string } | null }>

/** Client Supabase simulato: registra intestazioni, retry, segnale e filtri; risponde con `reply`. */
function fakeClient(options: { user?: string | null; reply?: (call: Call) => Reply; invoke?: (call: Call) => Promise<unknown> }) {
  const calls: Call[] = []
  const builder = (call: Call) => {
    const chain: Record<string, unknown> = {
      setHeader(name: string, value: string) { call.headers[name] = value; return chain },
      abortSignal(signal: AbortSignal) { call.signal = signal; return chain },
      retry(value: boolean) { call.retry = value; return chain },
      then(resolve: (value: unknown) => void, reject: (error: unknown) => void) {
        return Promise.resolve(options.reply?.(call) ?? { data: null, error: null }).then(resolve, reject)
      },
    }
    for (const method of ['select', 'order', 'limit', 'maybeSingle']) chain[method] = () => chain
    for (const method of ['eq', 'not']) chain[method] = (column: string, ...rest: unknown[]) => { call.filters.push([method, column, rest.at(-1)]); return chain }
    return chain
  }
  const client = {
    auth: { getSession: async () => ({ data: { session: options.user === null ? null : { access_token: 'token-a', user: { id: options.user ?? OWNER } } }, error: null }) },
    rpc: (name: string, args: unknown) => { const call: Call = { kind: 'rpc', name, args, filters: [], headers: {}, retry: null, signal: null }; calls.push(call); return builder(call) },
    from: (name: string) => { const call: Call = { kind: 'from', name, filters: [], headers: {}, retry: null, signal: null }; calls.push(call); return builder(call) },
  }
  return { client: client as unknown as SupabaseClient, calls }
}
const signal = () => new AbortController().signal

test('21: sessione catturata per account; Authorization esplicita, retry SDK spento e segnale sempre passato', async () => {
  const { client, calls } = fakeClient({ user: OTHER })
  const repository = createImportsRepository(client, OWNER)
  await assert.rejects(repository.getReceipt(REQUEST, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'session')
  await assert.rejects(repository.commitWorkout(workoutCommand as never, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'session')
  assert.equal(calls.length, 0, 'nessuna richiesta con la sessione di un altro account')

  const receipt = await receiptFor(workoutCommand)
  const ok = fakeClient({ reply: call => call.name === 'commit_workout_import' ? { data: receipt, error: null } : { data: null, error: null } })
  const own = createImportsRepository(ok.client, OWNER)
  assert.deepEqual(await own.commitWorkout(workoutCommand as never, signal()), receipt)
  const [call] = ok.calls
  assert.deepEqual([call!.name, call!.headers.Authorization, call!.retry, call!.signal instanceof AbortSignal], ['commit_workout_import', 'Bearer token-a', false, true])
  assert.deepEqual(call!.args, { p_request_id: workoutCommand.requestId, p_resolved_payload: workoutCommand.payload, p_provenance: workoutCommand.provenance, p_selection_options: workoutCommand.selectionOptions })
  assert.equal(await own.getReceipt(REQUEST, signal()), null)
  assert.deepEqual([ok.calls[1]!.name, ok.calls[1]!.args, ok.calls[1]!.retry], ['get_import_receipt', { p_request_id: REQUEST }, false])
})

test('21: esiti delle RPC di conferma — rifiuti certi, sessione, esito incerto', async () => {
  const cases: [{ code?: string; message?: string } | null, string][] = [
    [{ code: 'PT410', message: 'Import analysis expired' }, 'analysis_expired'],
    [{ code: 'PT409', message: 'Import request conflict' }, 'request_conflict'],
    [{ code: 'PT409', message: 'Active selection conflict' }, 'selection_conflict'],
    [{ code: 'PT409', message: 'Catalog changed' }, 'catalog_conflict'],
    [{ code: '22023', message: 'Invalid import command' }, 'invalid_command'],
    [{ code: '42501', message: 'Import reference not available' }, 'not_available'],
    [{ code: '42501', message: 'Authentication required' }, 'session'],
    [{ code: '', message: 'TypeError: fetch failed' }, 'uncertain'],
    [{ code: 'PGRST301', message: 'gateway' }, 'uncertain'],
    [null, 'uncertain'],
  ]
  for (const [error, expected] of cases) {
    const failure = commitFailure(error)
    assert.equal(failure instanceof CommitRejected ? failure.reason : failure.kind, expected, JSON.stringify(error))
  }
  // Una 2xx con una ricevuta non conforme non vale come salvato: si verifica con la ricevuta.
  const { client } = fakeClient({ reply: () => ({ data: { requestId: REQUEST }, error: null }) })
  await assert.rejects(createImportsRepository(client, OWNER).commitDiet(dietCommand as never, signal()), (error: unknown) => error instanceof ImportsFailure && error.kind === 'uncertain')
  // Annullamento voluto (logout) ≠ tempo scaduto (esito incerto).
  const hanging = fakeClient({ reply: call => new Promise(resolve => call.signal!.addEventListener('abort', () => resolve({ data: null, error: { code: '20', message: 'AbortError' } }))) })
  const controller = new AbortController()
  const pending = createImportsRepository(hanging.client, OWNER).commitDiet(dietCommand as never, controller.signal)
  setTimeout(() => controller.abort(), 5)
  await assert.rejects(pending, (error: unknown) => error instanceof ImportsFailure && error.kind === 'aborted')
})
