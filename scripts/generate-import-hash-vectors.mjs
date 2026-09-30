// Include pgTAP dei vettori canonici e hash del task 02: stessi file del test TypeScript,
// nessuna copia scritta a mano. `node scripts/generate-import-hash-vectors.mjs` rigenera;
// tests/import-receipts.test.ts fallisce se l'include non coincide con i JSON.
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const contracts = 'tests/fixtures/import/contracts/'
export const importHashVectorsInclude = 'supabase/tests/database/import_hash_vectors.inc'

const read = path => readFileSync(new URL(path, root), 'utf8')
// standard_conforming_strings: solo l'apice va raddoppiato; i backslash restano letterali.
const literal = text => `'${String(text).replaceAll("'", "''")}'`

export function renderImportHashVectors() {
  const canonical = JSON.parse(read(`${contracts}canonical-vectors.json`))
  const hashes = JSON.parse(read(`${contracts}hash-vectors.json`))
  const canonicalRows = canonical.vectors.map(v => `  (${[v.id, v.json, v.canonical, v.sha256].map(literal).join(', ')})`)
  const hashRows = hashes.vectors.map(v => {
    // Stesso valore che il test TypeScript ottiene con JSON.parse, indipendente dai fine riga.
    const command = JSON.stringify(JSON.parse(read(`${contracts}${v.command}`)))
    return `  (${literal(v.id)}, ${literal(v.kind)}, ${literal(command)}::jsonb, ${literal(v.commandHash)}, ${literal(v.contentHash)})`
  })
  return [
    '-- Generato da scripts/generate-import-hash-vectors.mjs: NON modificare a mano.',
    `-- Fonte: ${contracts}{canonical-vectors,hash-vectors}.json e commands/*.json.`,
    'create temporary table import_canonical_vectors(id text primary key, input text not null, canonical text not null, sha256 text not null);',
    'insert into import_canonical_vectors values',
    canonicalRows.join(',\n') + ';',
    'create temporary table import_hash_vectors(id text primary key, kind text not null, command jsonb not null, command_hash text not null, content_hash text not null);',
    'insert into import_hash_vectors values',
    hashRows.join(',\n') + ';',
    '',
  ].join('\n')
}

// Scrive solo se eseguito direttamente (Windows: percorsi senza distinzione di maiuscole).
const invokedDirectly = process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()
if (invokedDirectly) {
  writeFileSync(new URL(importHashVectorsInclude, root), renderImportHashVectors())
  console.log(`Scritto ${importHashVectorsInclude}.`)
}
