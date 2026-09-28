# Corpus sintetico dei contratti import

Dati **inventati** per i contratti V1 di `src/import/contracts/` e per i reader di `src/import/readers/`. Nessun documento personale, nessun file di `docs/` o `private-imports/`; nulla di questa cartella entra nel bundle pubblico. Li legge soltanto `tests/import-contracts.test.ts` (`npm test`).

## Struttura

- `documents/*.json` — `NormalizedDocument` attesi (blocchi, coordinate, `readingIssues`), scritti a mano. `readerVersion` è `synthetic-fixture/1`; `sourceHash` è per convenzione `sha256("synthetic:<id>")`, perché non esiste ancora un file binario.
- `extractions/*.json` — proposta attesa dell'interprete (`peppitness.workout-extraction.v1` / `peppitness.diet-extraction.v1`), annotata a mano e coerente con il documento: ogni `evidence.path` punta a un campo esistente e ogni citazione compare nel testo canonico del blocco citato.
- `manifest.json` — indice dei casi (formato di test `formatVersion: 1`).

## Manifest, formato 1

Ogni caso ha tutte le chiavi:

| Chiave | Significato |
|---|---|
| `id`, `domain`, `summary`, `tags` | Identità, dominio `workout`/`diet`, descrizione |
| `readerVersion`, `schemaId` | Versioni del documento atteso e del DTO |
| `sourceFile` | File DOCX/PDF sorgente. Resta `null` per questi casi: i loro documenti sono scritti a mano (`synthetic-fixture/1`) e non provengono da un binario; i binari dei reader hanno un manifest proprio (sotto) |
| `expectedBlocks`, `expectedProposal` | Documento normalizzato e proposta attesi (casi positivi) |
| `candidate` | Solo casi negativi: `target` (`normalized-document`, `workout-extraction`, `diet-extraction`) più una forma fra `base` + `patch` (sottoinsieme RFC 6902: add/replace/remove), `value` (valore JSON diretto) o `json` (testo da interpretare) |
| `expectedContractErrors` | Coppie `path` + `code` attese dai validatori di contratto, confrontate come insieme esatto |
| `expectedIssues`, `userDecisions`, `expectedDomainOutput` | Problemi applicativi (task 06), decisioni della revisione (02/07) e output di dominio (09/10) |

`null` significa **annotazione non ancora presente**, non «nessun problema» o «copertura garantita». I task successivi compilano questi campi per i propri livelli, senza riscrivere la verità già annotata.

## Casi

Positivi: i due esempi completi della specifica (§5.3, §5.4), scheda incompleta (3–4 serie, recupero vuoto, 2 + 1 facoltativa, per lato), intervalli/RIR/RPE/Unicode, A/B/C senza giorni, dieta con alternative e aggiunte condizionali locali/globali, dominio sbagliato con liste vuote, contenuto parzialmente interpretabile, numeri finiti oltre i limiti Peppitness (validi per il contratto: vanno diagnosticati nella bozza, mai limitati).

Negativi: chiavi extra alla radice e annidate, chiave mancante, versione sconosciuta, intervallo invertito, weekday fuori 1–7, evidence sulla radice o con JSON Pointer invalido, DTO dieta al validatore della scheda e viceversa, radice non oggetto, JSON illeggibile, tipi non convertiti, documenti con ID duplicati, riferimenti pendenti, cicli, coordinate/bbox non valide, celle unite sovrapposte, testo non canonico.

Aggiungere un caso: creare i file, referenziarli nel manifest (il test rifiuta file orfani o mancanti) ed eseguire `npm test`.

## DOCX del reader (task 03)

`docx/` contiene DOCX **binari veri** e i golden del reader `peppitness.docx-reader.v1`, letti da `tests/import-docx.test.ts` e da `scripts/import-docx-reader-browser-check.mjs`:

- `docx/manifest.json` (formato 1): per caso `sourceFile`, `sha256`, `expected` (golden `*.expected.json` = `DocumentReadResult` completo, documento + inventario) oppure `expectedError` (codice `DocumentReaderError`), `summary`, `tags`. Il test rifiuta file non referenziati.
- I binari sono prodotti in modo deterministico da `node scripts/generate-docx-fixtures.mjs` (costruttori in `scripts/lib/docx-fixtures.mjs`); il test verifica che i byte versionati coincidano con il generatore. Aperti anche con Microsoft Word (sola lettura) senza riparazioni.
- I golden sono stati rivisti a mano blocco per blocco rispetto a come la fixture è costruita; il test aggiunge asserzioni scritte a mano indipendenti dai golden (parole spezzate, unioni, annidamenti, revisioni, avvisi).
- Casi: `docx-paragraphs`, `docx-tables`, `docx-merged-cells`, `docx-nested-tables`, `docx-unread-components` (baseline di copertura per il task 04), `docx-invalid-package`. I casi ostili (zip bomb, DTD, percorsi esterni, docm, CFB…) sono costruiti in memoria nei test.

Se una modifica del reader cambia blocchi, ID o problemi per lo stesso file, alzare `DOCX_READER_VERSION` (`src/import/readers/docx-version.ts`) e aggiornare i golden rivedendoli.
