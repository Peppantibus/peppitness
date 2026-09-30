// Include pgTAP dei comandi di conferma 19/20: generato dai mapper 09/10 sul corpus sintetico
// (scripts/lib/import-commit-fixtures.mjs), nessuna copia scritta a mano.
// `node scripts/generate-import-commit-fixtures.mjs` rigenera; tests/import-commit-fixtures.test.ts
// fallisce se l'include non coincide.
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogSeed, commitFixtureRows } from './lib/import-commit-fixtures.mjs'

const root = new URL('../', import.meta.url)
export const importCommitFixturesInclude = 'supabase/tests/database/import_commit_fixtures.inc'

// standard_conforming_strings: solo l'apice va raddoppiato; i backslash restano letterali.
const literal = text => `'${String(text).replaceAll("'", "''")}'`
const json = value => `${literal(JSON.stringify(value))}::jsonb`

export async function renderImportCommitFixtures() {
  const rows = (await commitFixtureRows()).map(row =>
    `  (${[literal(row.id), literal(row.kind), json(row.document), json(row.extraction), json(row.command), literal(row.contentHash), json(row.expected)].join(', ')})`)
  return [
    '-- Generato da scripts/generate-import-commit-fixtures.mjs: NON modificare a mano.',
    '-- Fonte: corpus tests/fixtures/import (manifest, golden mapping 09/10) e mapper reali.',
    'create temporary table import_commit_fixtures(id text primary key, kind text not null, document jsonb not null,',
    '  extraction jsonb not null, command jsonb not null, content_hash text not null, expected jsonb not null);',
    'insert into import_commit_fixtures values',
    rows.join(',\n') + ';',
    `create temporary table import_commit_catalog as select ${json(catalogSeed)} as seed;`,
    'grant select on import_commit_fixtures, import_commit_catalog to authenticated, service_role;',
    '',
  ].join('\n')
}

// Scrive solo se eseguito direttamente (Windows: percorsi senza distinzione di maiuscole).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (invokedDirectly) {
  writeFileSync(new URL(importCommitFixturesInclude, root), await renderImportCommitFixtures())
  console.log(`Scritto ${importCommitFixturesInclude}.`)
}
