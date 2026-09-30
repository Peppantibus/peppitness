// Solo bootstrap/pulizia di fixture import sul DB locale; mai URL o credenziali.
import { spawn } from 'node:child_process'
import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { projectRoot, localWorkdir } from './local-supabase.mjs'

export const sqlLiteral = value => "'" + String(value).replaceAll("'", "''") + "'"
// Solo messaggi applicativi stabili (PT409) risalgono al test; ogni altro errore resta generico.
const stableErrors = ['Import request conflict', 'Active selection conflict']
function stableError(output) {
  try {
    const message = JSON.parse(output)?.error?.message
    return stableErrors.find(text => typeof message === 'string' && message.endsWith(`error: ${text}`))
  } catch { return undefined }
}
export async function importLocalSql(sql) {
  const path = `artifacts/import-db-${randomUUID()}.sql`
  await mkdir(new URL('../../artifacts/', import.meta.url), { recursive: true })
  await writeFile(new URL(`../../${path}`, import.meta.url), sql)
  const workdir = localWorkdir()
  try {
    return await new Promise((resolve, reject) => {
      const windows = process.platform === 'win32'
      const command = `node_modules\\.bin\\supabase.cmd db query --local --file ${path} --output-format json${workdir ? ` --workdir ${workdir}` : ''}`
      const proc = spawn(windows ? (process.env.ComSpec ?? 'cmd.exe') : './node_modules/.bin/supabase',
        windows ? ['/d', '/s', '/c', command] : ['db', 'query', '--local', '--file', path, '--output-format', 'json', ...(workdir ? ['--workdir', workdir] : [])],
        { cwd: projectRoot, windowsHide: true, timeout: 30_000, env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: '1' } })
      let output = ''
      proc.stdout.on('data', chunk => { output += chunk })
      proc.stderr.resume() // Mai propagare query/contenuti o dettagli del trasporto.
      proc.on('error', () => reject(new Error('Bootstrap SQL import locale non disponibile.')))
      proc.on('close', code => {
        if (code !== 0) { reject(new Error(stableError(output) ?? 'Bootstrap SQL import locale fallito.')); return }
        if (output.trim() === 'DO') { resolve([]); return }
        try {
          const parsed = JSON.parse(output)
          if (!Array.isArray(parsed.rows)) throw new Error('query')
          resolve(parsed.rows)
        } catch { reject(new Error('Verifica SQL import locale fallita; controllare configurazione e fixture locali.')) }
      })
    })
  } finally { await unlink(new URL(`../../${path}`, import.meta.url)) }
}
