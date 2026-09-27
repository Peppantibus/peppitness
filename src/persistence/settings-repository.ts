import type { SupabaseClient } from '@supabase/supabase-js'
import type { SavedSettings, SettingsValues } from '../domain/settings.ts'
import { validateSettings } from '../domain/settings.ts'

export interface SettingsRepository {
  load(signal: AbortSignal): Promise<SavedSettings | null>
  save(value: SettingsValues, revision: number | null, signal: AbortSignal): Promise<SavedSettings>
}

export class SettingsFailure extends Error {
  readonly kind: 'conflict' | 'unavailable' | 'session'
  constructor(kind: SettingsFailure['kind']) { super(kind); this.kind = kind }
}

const columns = 'owner_id,display_name,time_zone,workout_weekdays,revision'

// Contratto ristretto alle colonne utilizzate, validato a runtime. La generazione
// CLI dei tipi è bloccata dalla pipe Docker nell'ambiente dell'agente.
function decodeSettings(data: unknown, ownerId: string): SavedSettings {
  if (!data || typeof data !== 'object') throw new SettingsFailure('unavailable')
  const row = data as Record<string, unknown>
  if (row.owner_id !== ownerId || typeof row.display_name !== 'string' || typeof row.time_zone !== 'string'
    || !Array.isArray(row.workout_weekdays) || !row.workout_weekdays.every(day => typeof day === 'number')
    || typeof row.revision !== 'number' || !Number.isInteger(row.revision) || row.revision < 1) throw new SettingsFailure('unavailable')
  const value = { displayName: row.display_name, timeZone: row.time_zone, workoutWeekdays: row.workout_weekdays as number[], revision: row.revision }
  if (validateSettings(value)) throw new SettingsFailure('unavailable')
  return value
}

export function createSettingsRepository(client: SupabaseClient, ownerId: string): SettingsRepository {
  async function query(signal: AbortSignal) {
    const { data, error } = await client.auth.getSession()
    signal.throwIfAborted()
    if (error || data.session?.user.id !== ownerId) throw new SettingsFailure('session')
    // Cattura il token dell'utente dell'operazione: un cambio account durante
    // una richiesta non deve inviarla sotto la nuova identità.
    return { token: data.session.access_token, signal }
  }
  function failure(error: { code?: string }) {
    return new SettingsFailure(error.code === 'PT409' || error.code === '23505' ? 'conflict' : 'unavailable')
  }
  return {
    async load(signal) {
      const request = await query(signal)
      const { data, error } = await client.from('user_settings').select(columns).eq('owner_id', ownerId)
        .setHeader('Authorization', `Bearer ${request.token}`).abortSignal(request.signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      return data === null ? null : decodeSettings(data, ownerId)
    },
    async save(value, revision, signal) {
      if (validateSettings(value)) throw new SettingsFailure('unavailable')
      const request = await query(signal)
      const fields = { display_name: value.displayName, time_zone: value.timeZone, workout_weekdays: value.workoutWeekdays }
      const table = client.from('user_settings')
      // Nessun upsert: il primo inserimento concorrente deve produrre conflitto.
      // Gli update inviano la revisione letta + 1 al trigger atomico già collaudato.
      const change = revision === null ? table.insert(fields) : table.update({ ...fields, revision: revision + 1 }).eq('owner_id', ownerId)
      const { data, error } = await change.select(columns).setHeader('Authorization', `Bearer ${request.token}`)
        .abortSignal(request.signal).retry(false).maybeSingle()
      if (error) throw failure(error)
      if (!data) throw new SettingsFailure('conflict')
      return decodeSettings(data, ownerId)
    },
  }
}
