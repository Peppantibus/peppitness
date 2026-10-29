import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { readSupabaseConfig } from './config'

const config = readSupabaseConfig(import.meta.env)
let client: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient | null {
  if (!config) return null
  if (!client) client = createClient(config.url, config.publishableKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // Il recupero verifica esplicitamente token_hash con un client isolato.
      detectSessionInUrl: false,
    },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }) },
  })
  return client
}
