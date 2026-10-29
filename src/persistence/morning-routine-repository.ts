import type { SupabaseClient } from '@supabase/supabase-js'
import { isLocalDate } from '../domain/dates.ts'
import { validMorningRoutine } from '../domain/morning-routine.ts'
import type { MorningRoutine } from '../domain/morning-routine.ts'

export interface MorningRow { document: MorningRoutine; revision: number; requestId: string }
export interface MorningDay { date: string; snapshot: MorningRoutine | null; revision: number; requestId: string }
export type MorningOperation = { id: string; revision: number } & ({ kind: 'routine'; document: MorningRoutine } | { kind: 'day'; date: string; snapshot: MorningRoutine | null })
export interface MorningRepository {
  load(signal: AbortSignal): Promise<{ routine: MorningRow | null; days: MorningDay[] }>
  send(operation: MorningOperation, signal: AbortSignal): Promise<MorningRow | MorningDay>
}
export class MorningFailure extends Error {
  readonly kind: 'conflict' | 'session' | 'unavailable' | 'invalid'
  constructor(kind: MorningFailure['kind']) { super(kind); this.kind = kind }
}
const invalid = (): never => { throw new MorningFailure('invalid') }
export function morningRow(value: unknown, owner: string, day = false): MorningRow | MorningDay {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const row = value as Record<string, unknown>
  if (row.owner_id !== owner || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1
    || typeof row.last_request_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(row.last_request_id)) return invalid()
  const common = { revision: row.revision, requestId: row.last_request_id }
  if (day) {
    if (typeof row.date !== 'string' || !isLocalDate(row.date) || (row.snapshot !== null && !validMorningRoutine(row.snapshot))) return invalid()
    return { ...common, date: row.date, snapshot: row.snapshot }
  }
  if (!validMorningRoutine(row.document)) return invalid()
  return { ...common, document: row.document }
}
export function createMorningRepository(client: SupabaseClient, owner: string): MorningRepository {
  async function access(signal: AbortSignal) {
    const { data, error } = await client.auth.getSession()
    signal.throwIfAborted()
    if (error || data.session?.user.id !== owner) throw new MorningFailure('session')
    return data.session.access_token
  }
  function failure(error: { code?: string }) { return new MorningFailure(error.code === 'PT409' ? 'conflict' : ['22023', '23514', '22P02'].includes(error.code ?? '') ? 'invalid' : 'unavailable') }
  return {
    async load(signal) {
      const token = await access(signal)
      const { data, error } = await client.from('morning_routines').select('owner_id,document,revision,last_request_id').eq('owner_id', owner)
        .setHeader('Authorization', `Bearer ${token}`).abortSignal(signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      const days: MorningDay[] = []
      let cursor: string | null = null
      while (true) {
        let request = client.from('morning_routine_days').select('owner_id,date,snapshot,revision,last_request_id').eq('owner_id', owner).order('date').limit(500)
        if (cursor) request = request.gt('date', cursor)
        const result = await request.setHeader('Authorization', `Bearer ${token}`).abortSignal(signal).retry(false)
        if (result.error) throw failure(result.error)
        if (!result.data?.length) break
        for (const raw of result.data) {
          const day = morningRow(raw, owner, true) as MorningDay
          if (cursor && day.date <= cursor) return invalid()
          days.push(day); cursor = day.date
        }
        if (result.data.length < 500) break
      }
      return { routine: data ? morningRow(data, owner) as MorningRow : null, days }
    },
    async send(operation, signal) {
      const token = await access(signal)
      const name = operation.kind === 'routine' ? 'save_morning_routine' : 'set_morning_routine_day'
      const args = { p_expected_revision: operation.revision, p_request_id: operation.id,
        ...(operation.kind === 'routine' ? { p_document: operation.document } : { p_date: operation.date, p_snapshot: operation.snapshot }) }
      const { data, error } = await client.rpc(name, args).setHeader('Authorization', `Bearer ${token}`).abortSignal(signal).retry(false)
      if (error) throw failure(error)
      const row = morningRow(Array.isArray(data) ? data[0] : data, owner, operation.kind === 'day')
      if (row.requestId !== operation.id || row.revision !== operation.revision + 1 || operation.kind === 'day' && (!('date' in row) || row.date !== operation.date)) return invalid()
      return row
    },
  }
}
