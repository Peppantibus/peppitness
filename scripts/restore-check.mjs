// Prova di ripristino isolata (SA-02): ripristina un backup di backups/ in un
// container Postgres effimero, senza porte pubblicate e senza toccare il cloud,
// poi confronta i conteggi con il manifest. Uso: node scripts/restore-check.mjs [cartella]
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const base = join(root, 'backups')
const dirName = process.argv[2] ?? readdirSync(base).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort().at(-1)
if (!dirName) { console.error('Nessun backup trovato.'); process.exit(1) }
const dir = join(base, dirName)
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
// Stessa immagine su due registri: il registro AWS limita i download anonimi (i runner GitHub condividono
// gli IP, «toomanyrequests» nella notte del 07/10), quindi più tentativi e poi Docker Hub.
const images = ['public.ecr.aws/supabase/postgres:17.6.1.166', 'supabase/postgres:17.6.1.166']
const name = `peppitness-restore-${Date.now()}`
const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts })
const pause = (seconds) => spawnSync(process.platform === 'win32' ? 'ping' : 'sleep', process.platform === 'win32' ? ['-n', String(seconds + 1), '127.0.0.1'] : [String(seconds)])
const result = { backup: dirName, startedAt: new Date().toISOString(), hashes: 'ok', errors: {}, tables: {}, mismatches: [], pullErrors: [] }
const started = Date.now()

function pullImage() {
  for (const candidate of images) {
    if (docker(['image', 'inspect', candidate]).status === 0) return candidate
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const pull = docker(['pull', '-q', candidate])
      if (pull.status === 0) return candidate
      result.pullErrors.push(`${candidate} (tentativo ${attempt}): ${(pull.stderr || '').trim().split('\n').at(-1)}`)
      if (attempt < 3) pause(15 * attempt)
    }
  }
  throw new Error(`download immagine non riuscito da nessun registro: ${result.pullErrors.at(-1)}`)
}

for (const f of manifest.files) {
  const hash = createHash('sha256').update(readFileSync(join(dir, f.file))).digest('hex')
  if (hash !== f.sha256) { result.hashes = `MISMATCH ${f.file}`; }
}

try {
  result.image = pullImage()
  const run = docker(['run', '-d', '--name', name, '-e', 'POSTGRES_PASSWORD=restore-test-only', result.image])
  if (run.status !== 0) throw new Error(`avvio container: ${run.stderr}`)
  let ready = false
  for (let i = 0; i < 60 && !ready; i += 1) {
    ready = docker(['exec', name, 'pg_isready', '-U', 'supabase_admin', '-h', '127.0.0.1']).status === 0
    if (!ready) spawnSync(process.platform === 'win32' ? 'ping' : 'sleep', process.platform === 'win32' ? ['-n', '3', '127.0.0.1'] : ['2'])
  }
  if (!ready) throw new Error('Postgres non pronto')
  const psql = (args, input) => docker(['exec', '-i', name, 'psql', '-U', 'supabase_admin', '-h', '127.0.0.1', '-d', 'postgres', ...args], input ? { input } : {})

  // L'immagine include uno schema auth parziale: va azzerato per ripristinare quello del backup.
  psql(['-q', '-c', 'drop schema if exists auth cascade'])
  for (const file of ['schema-auth.sql', 'schema.sql', 'data-auth.sql', 'data-app.sql']) {
    const out = psql(['-q', '-v', 'ON_ERROR_STOP=0'], readFileSync(join(dir, file), 'utf8'))
    const errs = (out.stderr || '').split('\n').filter((l) => /ERROR:/.test(l))
    result.errors[file] = errs.length
    if (errs.length) result.errors[`${file}:first`] = errs.slice(0, 5)
  }

  for (const f of manifest.files.filter((x) => x.rows)) {
    for (const [table, expected] of Object.entries(f.rows)) {
      const q = psql(['-At', '-c', `select count(*) from ${table}`])
      const got = Number((q.stdout || '').trim())
      result.tables[table] = { expected, got }
      if (got !== expected) result.mismatches.push(table)
    }
  }
  const checks = {
    rls_public: "select count(*) from pg_tables where schemaname='public' and not rowsecurity",
    users: 'select count(*) from auth.users',
    fk_orphans_active_plans: 'select count(*) from public.active_plans a left join auth.users u on u.id=a.owner_id where u.id is null',
  }
  result.checks = {}
  for (const [k, sql] of Object.entries(checks)) result.checks[k] = (psql(['-At', '-c', sql]).stdout || '').trim()
} catch (error) {
  result.fatal = String(error.message ?? error)
} finally {
  docker(['rm', '-f', '-v', name])
}
result.seconds = Math.round((Date.now() - started) / 1000)
const ok = !result.fatal && result.hashes === 'ok' && result.mismatches.length === 0
result.outcome = ok ? 'PASS' : 'FAIL'
writeFileSync(join(dir, 'restore-check.json'), JSON.stringify(result, null, 2))
// A console solo i conteggi degli errori: le righe di errore possono contenere dati e i log
// di GitHub Actions sono pubblici. Il dettaglio resta in restore-check.json.
const errorCounts = Object.fromEntries(Object.entries(result.errors).filter(([k]) => !k.endsWith(':first')))
console.log(JSON.stringify({ outcome: result.outcome, image: result.image, pullErrors: result.pullErrors, hashes: result.hashes, errors: errorCounts, mismatches: result.mismatches, checks: result.checks, seconds: result.seconds, fatal: result.fatal }, null, 2))
process.exit(ok ? 0 : 1)
