# Vettori dei contratti di revisione e conferma

Dati **sintetici** per i contratti del task 02 (`src/import/contracts/{review,commit,jobs,domain-limits}.ts`) e per la canonicalizzazione di `src/import/mapping/canonical.ts`. Nessun documento personale; nulla entra nel bundle. Li legge `tests/import-command-contracts.test.ts` (`npm test`); il test del corpus del task 01 controlla solo `documents/` ed `extractions/`.

## File

| Percorso | Contenuto |
|---|---|
| `canonical-vectors.json` | Testo JSON d’ingresso, forma canonica attesa scritta a mano e SHA-256 dei suoi byte UTF-8. Stesso `group` → stessa forma; gruppi diversi → forme diverse |
| `commands/*.json` | Comandi di conferma validi (scheda e dieta), comprese varianti con soli ID tecnici diversi, follow, riordino e NFD |
| `hash-vectors.json` | `commandHash` e `contentHash` attesi per ogni comando |
| `receipts/*.json` | Ricevute valide coerenti con i comandi (`committed` senza selezione, `deleted` con selezione) |
| `review/*.json` | Bozze di revisione valide costruite sulle proposte `extractions/workout-incomplete.json` e `extractions/diet-spec-example.json` |

Gli UUID sono leggibili per convenzione (`e…` requestId, `9…` proposte, `a…` esercizi personali, `c…` template); i `sourceHash` sono quelli dei documenti sintetici del task 01.

## peppitness.canonical-json.v1

- Valori: null, boolean, numeri finiti, testi senza NUL né surrogati isolati, liste, oggetti. Nient’altro.
- Oggetti: chiavi ordinate per code point Unicode, cioè per byte UTF-8 (`COLLATE "C"`), non per unità UTF-16.
- Testi e chiavi: escape di JSON.stringify, identico a `escape_json` di PostgreSQL: `\"`, `\\`, `\b \f \n \r \t`, altri U+0000–U+001F come `\u00xx` minuscolo; tutto il resto letterale. Nessuna normalizzazione Unicode.
- Numeri: semantica IEEE-754 double. Notazione decimale semplice della rappresentazione più corta di ECMAScript, senza esponente né zeri finali; -0 → 0.
- Nessuno spazio; codifica UTF-8; SHA-256 esadecimale minuscolo.

### Ricetta SQL (informativa, implementata dal task 18)

Funzione ricorsiva su `jsonb`, `set search_path = ''` e `set extra_float_digits = 1` nella definizione:

- `object`: `'{' || string_agg(to_jsonb(key)::text || ':' || canon(value), ',' order by key collate "C") || '}'`, `'{}'` se vuoto;
- `array`: `'[' || string_agg(canon(elem), ',' order by ordinality) || ']'`;
- `string`: `value::text` (jsonb produce già l’escape atteso);
- `number`: `trim_scale(((value #>> '{}')::float8)::text::numeric)::text` — il passaggio da `float8` riproduce l’arrotondamento double del client (vettore `decimals`);
- `boolean`/`null`: `value::text`.

Impronta: `encode(sha256(convert_to(canon(x), 'UTF8')), 'hex')`.

### Ingressi delle impronte

- `commandHash`: `{"hash":"peppitness.command-hash.v1","requestId":…,"payload":…,"provenance":…,"selectionOptions":…}` — in SQL `jsonb_build_object` dei quattro argomenti della RPC. Include ID tecnici, ref, revisioni viste, provenienza e opzioni: qualunque modifica cambia l’hash e richiede un nuovo `requestId`.
- `contentHash`: `{"hash":"peppitness.content-hash.v1","kind":…,"content":…}`. Scheda: titolo, guidance, ciclo, sedute (etichetta, titolo, nota) e prescrizioni in ordine con i valori e l’identità dell’esercizio (`name`, `variant`, `equipment`, `loadConvention`, `loadUnit`, `measurementMode`, `perSide`), senza UUID, ref, fonte della scelta, ID personale, revisione o nota del catalogo. Dieta: nome, guidance, giornate e pasti senza UUID. Mai provenienza, opzioni o metadati del provider.
- `normalizedHash`: `{"hash":"peppitness.normalized-hash.v1","document":NormalizedDocument}`, calcolato dal server.
- `sourceHash`: SHA-256 dei byte del file, dal reader.

Aggiungere un vettore: aggiornare il file, calcolare lo SHA-256 della forma canonica **scritta a mano** e verificare con `npm test`; non rigenerare gli hash dei comandi per far passare un test senza capire la differenza.
