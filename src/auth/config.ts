export interface SupabaseConfig { url: string; publishableKey: string }

// Usata anche da Vite: una chiave privilegiata deve essere respinta prima del bundle.
export function readSupabaseConfig(env: Record<string, string | undefined>): SupabaseConfig | null {
  const url = env.VITE_SUPABASE_URL?.trim() ?? ''
  const publishableKey = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? ''
  if (!url && !publishableKey) return null
  if (!url || !publishableKey) throw new Error('Completa URL e Publishable key Supabase in .env.local.')
  let parsed: URL
  try { parsed = new URL(url) } catch { throw new Error('URL Supabase non valido.') }
  const cloud = parsed.protocol === 'https:' && /^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname)
  const local = parsed.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(parsed.hostname) && parsed.port === '54321'
  if ((!cloud && !local) || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Usa un URL Supabase HTTPS oppure lo stack Supabase locale.')
  }
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw new Error('Serve una Publishable key Supabase (sb_publishable_...). Nessuna chiave privilegiata è ammessa nel frontend.')
  }
  return { url: parsed.origin, publishableKey }
}
