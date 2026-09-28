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

## DOCX del reader (task 03 e 04)

`docx/` contiene DOCX **binari veri** e i golden del reader `peppitness.docx-reader.v2`, letti da `tests/import-docx.test.ts`, `tests/import-docx-coverage.test.ts` e da `scripts/import-docx-reader-browser-check.mjs`:

- `docx/manifest.json` (formato 1): per caso `sourceFile`, `sha256`, `expected` (golden `*.expected.json` = `DocumentReadResult` completo, documento + inventario) oppure `expectedError` (codice `DocumentReaderError`), `summary`, `tags`. Il test rifiuta file non referenziati.
- I binari sono prodotti in modo deterministico da `node scripts/generate-docx-fixtures.mjs` (costruttori in `scripts/lib/docx-fixtures.mjs`); il test verifica che i byte versionati coincidano con il generatore. Aperti anche con Microsoft Word (sola lettura) senza riparazioni, tranne `docx-remote-links` (ostile per costruzione: non va aperto in Word, che potrebbe tentare i collegamenti) e `docx-invalid-package`.
- I golden sono stati rivisti a mano blocco per blocco rispetto a come la fixture è costruita; il test aggiunge asserzioni scritte a mano indipendenti dai golden (parole spezzate, unioni, annidamenti, revisioni, avvisi).
- Casi 03: `docx-paragraphs`, `docx-tables`, `docx-merged-cells`, `docx-nested-tables`, `docx-unread-components` (baseline 03; dal task 04 è un **rifiuto** perché contiene una revisione aperta), `docx-invalid-package`.
- Casi 04, distinti per esito (tag `coverage-complete`, `coverage-partial`, `rejection`): `docx-side-content` (copertura completa: intestazioni per sezione e prima pagina, piè di pagina condiviso con contatti minimizzati, note con richiamo NOTEREF, nota di chiusura, caselle di testo), `docx-partial-coverage` (immagine, grafico, formula, simbolo, testo nascosto, commento, nota non richiamata, intestazione non usata, parte sconosciuta, tabella irregolare e interrotta), `docx-remote-links` (collegamenti esterni ostili, mai richiesti), `docx-tracked-changes` (revisioni in corpo, tabella, nota e intestazione: rifiuto).
- I casi ostili (zip bomb, DTD anche nelle parti laterali, percorsi esterni, docm, CFB, parti danneggiate, metadati personali…) sono costruiti in memoria nei test.

Se una modifica del reader cambia blocchi, ID o problemi per lo stesso file, alzare `DOCX_READER_VERSION` (`src/import/readers/docx-version.ts`) e aggiornare i golden rivedendoli.

## PDF del reader (task 05)

`pdf/` contiene PDF **binari veri** e i golden del reader `peppitness.pdf-reader.v1`, letti da `tests/import-pdf.test.ts` e da `scripts/import-pdf-reader-browser-check.mjs`:

- `pdf/manifest.json` (formato 1, come quello DOCX): per caso `sourceFile`, `sha256`, `expected` (golden = `DocumentReadResult` completo, con pagine, bbox e inventario per pagina) oppure `expectedError`, `summary`, `tags`. Il test rifiuta file non referenziati.
- I binari sono prodotti in modo deterministico da `node scripts/generate-pdf-fixtures.mjs` (costruttori in `scripts/lib/pdf-fixtures.mjs`: oggetti, xref e flussi scritti a mano, font standard Helvetica/Symbol, un font CID senza mappa Unicode, immagini in scala di grigi o CCITT che simulano scansioni); il test verifica che i byte versionati coincidano con il generatore.
- I golden sono rivisti a mano rispetto alla costruzione (ordine, testo, coordinate, problemi per pagina); il test aggiunge asserzioni indipendenti dai golden. Blocchi ed evidence sono golden della fonte, distinti dai valori interpretati (task 06 e successivi).
- Casi: `pdf-simple`, `pdf-two-columns` (numeri simili, stesso valore in due colonne), `pdf-table` (numero fuori riga, colonne senza spazio), `pdf-rotated`, `pdf-scan-only`, `pdf-mixed`, `pdf-last-page-scan`, `pdf-unreadable-text` (font senza mappa Unicode, testo invisibile), `pdf-ccitt-scan`, `pdf-damaged-page`, `pdf-password`, `pdf-corrupt`. Il PDF oltre il limite di pagine e la fixture limite di quasi 10 MiB sono costruiti in memoria dai test e dalla prova browser.

Se una modifica del reader o di PDF.js cambia blocchi, ID o problemi per lo stesso file, alzare `PDF_READER_VERSION` (`src/import/readers/pdf-version.ts`) e aggiornare i golden rivedendoli.
