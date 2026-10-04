// Backup amministrativo del database Supabase collegato (SA-02).
// Solo lettura sul cloud: tre dump separati (schema, dati app, dati Auth) in
// backups/<timestamp>/ (cartella ignorata da Git) + manifest con hash e conteggi.
// Richiede Docker attivo e `supabase login`/link già eseguiti. Nessun segreto in output.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const expectedRef = 'sngaiyaumgnnjbefnnwl'
const linkedRef = readFileSync(join(root, 'supabase', '.temp', 'project-ref'), 'utf8').trim()
if (linkedRef !== expectedRef) {
  console.error('Progetto collegato diverso da quello atteso: backup interrotto.')
  process.exit(1)
}

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
const outDir = join(root, 'backups', stamp)
mkdirSync(outDir, { recursive: true })

const dumps = [
  { file: 'schema.sql', args: ['--schema', 'public,peppitness_private'], desc: 'schema public+peppitness_private' },
  { file: 'schema-auth.sql', args: ['--schema', 'auth'], desc: 'schema auth (necessario al ripristino)' },
  { file: 'data-app.sql', args: ['--data-only', '--use-copy', '--schema', 'public,peppitness_private'], desc: 'dati app' },
  { file: 'data-auth.sql', args: ['--data-only', '--use-copy', '--schema', 'auth'], desc: 'dati Auth (SENSIBILI: hash password)' },
]

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const files = []
for (const dump of dumps) {
  const target = join(outDir, dump.file)
  const run = spawnSync(
    npx,
    ['supabase', 'db', 'dump', '--linked', '--file', target, ...dump.args],
    { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' },
  )
  if (run.status !== 0) {
    console.error(`Dump fallito (${dump.file}):`, (run.stderr || '').split('\n').slice(-5).join('\n'))
    process.exit(1)
  }
  const content = readFileSync(target)
  const tables = {}
  if (dump.file.startsWith('data-')) {
    const lines = content.toString('utf8').split('\n')
    let current = null
    for (const line of lines) {
      const copy = /^COPY (\S+) \(/.exec(line)
      if (copy) { current = copy[1]; tables[current] = 0; continue }
      if (current && line === '\\.') { current = null; continue }
      if (current) tables[current] += 1
    }
  }
  files.push({
    file: dump.file,
    description: dump.desc,
    bytes: statSync(target).size,
    sha256: createHash('sha256').update(content).digest('hex'),
    ...(dump.file.startsWith('data-') ? { rows: tables } : {}),
  })
}

const migrations = readdirSync(join(root, 'supabase', 'migrations')).filter((n) => n.endsWith('.sql')).sort()
const cli = spawnSync(npx, ['supabase', '--version'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
const manifest = {
  createdAt: new Date().toISOString(),
  projectRef: linkedRef,
  cliVersion: (cli.stdout || '').trim(),
  localMigrations: migrations.length,
  lastMigration: migrations.at(-1),
  files,
  note: 'Contiene dati personali e hash password: non copiare in repository, hosting o log. Copia cifrata fuori dal dispositivo a cura dell\'utente.',
}
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`Backup completato in backups/${stamp}`)
for (const f of files) console.log(`- ${f.file}: ${f.bytes} byte, sha256 ${f.sha256.slice(0, 12)}…`)
