import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url))

/**
 * Porta API dello stack locale. Default 54321; PEPPITNESS_LOCAL_API_PORT serve solo quando
 * Windows riserva quell'intervallo (winnat/Hyper-V) e lo stack gira su una copia della config.
 * Resta comunque limitata al loopback: nessun URL remoto è accettato.
 */
export function localApiPort(env = process.env) {
  const value = env.PEPPITNESS_LOCAL_API_PORT
  return typeof value === 'string' && /^[1-9]\d{3,4}$/.test(value) && Number(value) <= 65535 ? value : '54321'
}

/** Fail closed: il runner amministrativo accetta solo lo stack locale noto. */
export function localApiUrl(value, port = localApiPort()) {
  let url
  try { url = new URL(value) } catch { throw new Error('URL API locale non valido.') }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)
    || url.port !== port || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash) {
    throw new Error(`I test API accettano soltanto http://127.0.0.1:${port}.`)
  }
  return `http://127.0.0.1:${port}`
}

/** Cartella alternativa della CLI (copia della config con porte diverse), validata. */
export function localWorkdir(env = process.env) {
  const value = env.PEPPITNESS_SUPABASE_WORKDIR
  if (value === undefined || value === '') return null
  if (!/^[A-Za-z0-9_:\\/.-]{1,260}$/.test(value)) throw new Error('PEPPITNESS_SUPABASE_WORKDIR non valida.')
  return value
}

export function parseLocalStatus(output) {
  let status
  try { status = JSON.parse(output) } catch { throw new Error('La CLI non ha restituito uno stato JSON valido.') }
  if (!status || typeof status !== 'object') throw new Error('Stato CLI non valido.')
  const apiUrl = localApiUrl(status.API_URL)
  const publicKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY
  const adminKey = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY
  if (typeof publicKey !== 'string' || !publicKey || typeof adminKey !== 'string' || !adminKey) {
    throw new Error('Lo stato CLI non contiene le chiavi necessarie ai test locali.')
  }
  return { apiUrl, publicKey, adminKey, publishableKey: status.PUBLISHABLE_KEY }
}

export function readLocalStatus() {
  // Nessun argomento da input, nessun log o file con stdout/stderr della CLI.
  const windows = process.platform === 'win32'
  const workdir = localWorkdir()
  // Percorso validato senza spazi né virgolette: nessun quoting passato a cmd.
  const command = `node_modules\\.bin\\supabase.cmd status -o json${workdir ? ` --workdir ${workdir}` : ''}`
  const result = spawnSync(windows ? (process.env.ComSpec ?? 'cmd.exe') : './node_modules/.bin/supabase',
    windows ? ['/d', '/s', '/c', command] : ['status', '-o', 'json', ...(workdir ? ['--workdir', workdir] : [])], {
      cwd: projectRoot, encoding: 'utf8', windowsHide: true, timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' },
    })
  if (result.error || result.status !== 0) {
    throw new Error('Stato Supabase non disponibile: esegui questo comando nel terminale che accede a Docker, con lo stack locale avviato.')
  }
  return parseLocalStatus(result.stdout)
}

export function publicErrorCode(data) {
  const value = data?.error_code ?? data?.code
  return typeof value === 'string' && /^[a-zA-Z0-9_]{1,80}$/.test(value) ? value : 'non_disponibile'
}
