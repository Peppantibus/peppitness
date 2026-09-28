// Rigenera i PDF sintetici del reader in tests/fixtures/import/pdf/ (task 05).
// Uso: node scripts/generate-pdf-fixtures.mjs — byte deterministici: `npm test` verifica che i file
// versionati coincidano con questo generatore. I golden *.expected.json sono rivisti a mano.
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { pdfFixtureBuilders } from './lib/pdf-fixtures.mjs'

const folder = new URL('../tests/fixtures/import/pdf/', import.meta.url)
await mkdir(folder, { recursive: true })
for (const [name, build] of Object.entries(pdfFixtureBuilders)) {
  const bytes = build()
  await writeFile(new URL(`${name}.pdf`, folder), bytes)
  console.log(`${name}.pdf ${bytes.length} byte sha256=${createHash('sha256').update(bytes).digest('hex')}`)
}
