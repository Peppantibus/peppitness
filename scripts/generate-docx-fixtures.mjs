// Rigenera i DOCX sintetici del reader in tests/fixtures/import/docx/ (task 03).
// Uso: node scripts/generate-docx-fixtures.mjs  — byte deterministici: `npm test` verifica che i
// file versionati coincidano con questo generatore. I golden *.expected.json sono scritti a mano.
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { docxFixtureBuilders } from './lib/docx-fixtures.mjs'

const folder = new URL('../tests/fixtures/import/docx/', import.meta.url)
for (const [name, build] of Object.entries(docxFixtureBuilders)) {
  const bytes = build()
  await writeFile(new URL(`${name}.docx`, folder), bytes)
  console.log(`${name}.docx ${bytes.length} byte sha256=${createHash('sha256').update(bytes).digest('hex')}`)
}
