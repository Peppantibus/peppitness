# Database peppitness

La configurazione locale usa PostgreSQL 17 e Supabase CLI 2.118.0, fissata nelle dipendenze npm. I metadati del collegamento al progetto cloud in `.temp/` sono ignorati da Git. `config.toml` configura lo stack locale e non aggiorna automaticamente le impostazioni cloud.

## Primo incremento

`migrations/20260926120000_account_and_exercises.sql` introduce:

- `user_settings`: una riga per account, nome visualizzato, fuso orario valido e giorni abituali ISO (1 = lunedì, 7 = domenica, lista anche vuota).
- `exercises`: esercizi personali con UUID stabile, nome, variante, attrezzo, convenzione/unità di carico, ripetizioni o secondi, per-lato e note.
- Proprietà verificata da RLS e permessi espliciti. Un utente autenticato legge/inserisce/modifica solo le proprie righe; il ruolo senza sessione non ha accesso. Le funzioni trigger sono in uno schema privato e usano i privilegi del chiamante.
- Revisione controllata atomicamente dal server per ogni aggiornamento. Il client manda `revision` uguale alla revisione letta + 1; in caso di `PT409` (HTTP 409, dopo la migrazione correttiva) deve proporre una risoluzione del conflitto, senza ritentare sovrascrivendo automaticamente.
- Identità di confronto dell'esercizio immutabile. Rinomina e note mantengono l'ID; una variante, macchina o unità diversa richiede un nuovo esercizio. Un esercizio si archivia con `archived_at` insieme alla nuova revisione, e si ripristina rimettendo `archived_at` a `null` con una successiva revisione. Non è esposta la cancellazione fisica dal client.

`(owner_id, id)` è una chiave univoca degli esercizi da usare nelle future relazioni: i figli dovranno riferire entrambi i valori. Timestamp di creazione/aggiornamento sono assegnati dal server. Gli inserimenti iniziano dalla revisione 1. Il default di `owner_id` deriva dalla sessione, ma RLS controlla anche un valore fornito esplicitamente dal client.

Questa migrazione non inserisce utenti o dati demo, non modifica la funzione remota preesistente `public.rls_auto_enable` e non collega ancora il frontend.

## Secondo incremento: programmi

`20260926130000_workout_plans.sql` aggiunge programmi, versioni, giorni e prescrizioni. Due RPC salvano atomicamente le bozze e pubblicano versioni immutabili, con revisioni, chiavi esterne che includono il proprietario e fotografie del catalogo esercizi. I vincoli e i permessi sono definiti nelle migrazioni SQL.

## Quarto incremento: diario e piani seguiti

`20260927190000_active_plans_and_diary.sql` aggiunge `active_plans`, `meal_plans`, `workout_sessions`, `workout_set_logs`, `meal_logs`, `diary_days` e le RPC `activate_workout_version`, `start_workout_session`. Test in `tests/database/003_active_plans_and_diary.test.sql`. Verificata in locale (pgTAP, HTTP, integrazione con l'app) e applicata al cloud dall'utente il 27/09 e verificata con `verify_schema.sql` (tutti i controlli `true`, storico remoto con le quattro versioni).

## Esecuzione dei test locali

La terza migrazione `20260926140000_revision_conflicts_http409.sql` corregge i conflitti applicativi: usa `PT409` al posto di `40001`, che PostgREST 14 ritenta continuamente. Non cambia dati o permessi e conserva le migrazioni già applicate. Il problema si è manifestato nei test HTTP con PostgREST locale 14.5; [riferimento Supabase](https://supabase.com/docs/guides/troubleshooting/high-cpu-and-infinite-transaction-retries-when-using-custom-error-codes-in-rpc-functions-77326b).

Nel terminale PowerShell dell'utente, dentro `peppitness`, con Docker Desktop avviato:

```powershell
npx.cmd supabase start
npx.cmd supabase migration up --local
npx.cmd supabase test db --local
```

Eseguire un comando alla volta e fermarsi in caso di errore. `start` scarica le immagini e prepara il database locale; al primo avvio applica anche le migrazioni. `migration up --local` applica soltanto quelle locali eventualmente ancora mancanti, utile se il database esisteva già. `test db --local` esegue la suite pgTAP in `tests/database/`.

L'output di `start` può contenere chiavi e credenziali locali: non incollarlo integralmente in chat o nel repository. Per i test comunicare soltanto il riepilogo PASS/FAIL e le eventuali righe di errore, senza credenziali. Non occorre impostare password o token nei file del progetto.

La suite di base usa due account inventati in una transazione che termina con rollback. Controlla ruoli SQL autenticati e anonimi, isolamento di impostazioni/esercizi, proprietario falsificato, identità di confronto, revisioni obsolete, validazione, archiviazione e rifiuto della cancellazione fisica. Sono prove PostgreSQL con identità simulate: **non sostituiscono i test via API con login reali** o la verifica della configurazione Auth cloud.

Il secondo file pgTAP include anche `tests/database/workout_plans_smoke.inc`: prova relazioni padre/figlio, snapshot, salvataggio atomico, versioni immutabili, isolamento e pulizia account. È eseguibile separatamente con `npx.cmd supabase db query --local --file supabase/tests/database/workout_plans_smoke.inc` e in caso di errore annulla l'intero statement. L'include deve restare nella stessa cartella montata dal runner pgTAP.

Per verificare anche le API reali locali:

```powershell
npm.cmd run test:api:local
```

Per condividere un riepilogo breve, eseguire `node scripts/test-supabase-api.mjs --summary`: stessi controlli, con la fase in corso, eventuali errori e risultato finale. Attendere la riga `Result` prima di copiare l'output; la riga riporta anche quante fixture sono state eliminate.

Lo script recupera le chiavi locali dalla CLI solo in memoria, crea account inventati tramite Auth e verifica dati e RPC attraverso sessioni utente senza privilegi amministrativi. Controlla anche signup/anonimo disabilitati, rinnovo e logout, concorrenza HTTP e pulizia delle fixture. Rifiuta URL diversi dallo stack su `127.0.0.1:54321`; non è un runner per il cloud. I controlli del runner si eseguono con `npm.cmd run test:infra`.

Configurazione Auth locale corretta: `[auth].enable_signup = false`, `enable_anonymous_sign_ins = false`, `[auth.email].enable_signup = true`, `enable_confirmations = true`. Il parametro della sezione email deve mantenere il provider attivo: impostarlo a false ha impedito anche il login (`email_provider_disabled`). Dopo una modifica a `config.toml`, eseguire `supabase stop` e `supabase start` senza opzioni che eliminino i dati, come previsto dalla [guida CLI](https://supabase.com/docs/guides/local-development/cli/config).

Non usare `db reset --linked`. In questo passaggio non serve neppure un reset locale: si applicano le migrazioni pendenti conservando l'eventuale database di test esistente.

## Stato verificato al 26 settembre 2026

- Ricognizione SQL remota eseguita dall'utente: PostgreSQL 17.6, nessuna relazione `public`, nessuno storico migrazioni, funzione `rls_auto_enable` presente.
- Prima migrazione applicata localmente e 53 test pgTAP superati secondo il riepilogo fornito dall'utente.
- Seconda migrazione applicata localmente dall'agente; controllo SQL sui programmi superato. Il controllo Docker resta negato, ma la CLI accede al database locale tramite `migration up --local` e `db query --local`.
- Quattro test del runner API superati. Primo tentativo HTTP fermato su provider email locale disabilitato; configurazione corretta e login/prime prove di isolamento passate al successivo tentativo dell'utente.
- Prima esecuzione pgTAP estesa fallita per include fuori dalla cartella montata. File spostato accanto al test: nuova esecuzione confermata dall'utente, **54 test superati in due file**.
- Primo riepilogo HTTP completo: FAIL dopo 26 controlli, timeout nella scrittura concorrente delle impostazioni, fixture eliminate 2/2. Terza migrazione PT409 applicata localmente; nuova esecuzione confermata dall'utente: **54 test pgTAP PASS, 129 controlli HTTP PASS, fixture eliminate 2/2**.
- Tre migrazioni applicate anche al cloud: verifica remota fornita dall'utente interamente positiva su sei tabelle, tre funzioni e schema privato. Nessun dato personale caricato; frontend ancora in memoria. Test HTTP cloud ancora da eseguire.

Dopo test locali riusciti, controllare nuovamente il progetto e le migrazioni pendenti; preparare l'anteprima remota prima di qualsiasi applicazione. Conservare separati gli esiti dei test locali, l'applicazione cloud e i successivi test API.

## Primo deploy cloud: applicato e verificato

Verificare che la CLI sia collegata al proprio progetto cloud prima di procedere. Nel terminale autenticato:

```powershell
npx.cmd supabase migration list --linked
npx.cmd supabase db push --linked --dry-run --skip-vault
```

Attese soltanto le migrazioni `20260926120000`, `20260926130000` e `20260926140000`. Se l'elenco è diverso, fermarsi e confrontare lo storico. L'anteprima non applica SQL; `--skip-vault` impedisce l'aggiornamento dei segreti Vault dalla configurazione.

L'utente ha confermato che l'anteprima propone esattamente questi tre file e che lo storico remoto non li contiene ancora. `npx.cmd supabase db push --linked --skip-vault` applica queste migrazioni al cloud. Dopo il successo, eseguire:

```powershell
npx.cmd supabase db query --linked --file supabase/checks/verify_schema.sql --output-format json
```

Tutti i controlli devono essere `true` e le tre versioni presenti. La query non legge utenti o dati applicativi. L'utente ha confermato questo risultato anche sul cloud: primo deploy applicato e metadati verificati. Non occorre ripeterlo; questo non sostituisce i successivi test HTTP sul cloud.

Riferimenti: [migrazioni Supabase](https://supabase.com/docs/guides/deployment/database-migrations), [RLS e test](https://supabase.com/docs/guides/database/postgres/row-level-security), [pgTAP](https://supabase.com/docs/guides/local-development/testing/pgtap-extended).

## Importazione: provider di estrazione (server, task 16)

Adapter server in `supabase/functions/_shared/import/`: `provider.ts` (interfaccia 01, configurazione, `prepare`/`send`), `openai-provider.ts` (primo adapter, OpenAI Responses API), `prompts.ts` (due prompt distinti, versione `peppitness.import-prompts.v1`), `provider-errors.ts` (errori tipizzati). Nessun modulo di `src/` li importa; la chiave non ha mai prefisso `VITE_`.

**Capacità del primo adapter:** output strutturato strict sì; immagini e PDF diretto no. Richiesta: `instructions` = prompt del dominio, un solo messaggio utente con i blocchi del documento in JSON (id, tipo, testo canonico, struttura di tabella, titoli; niente hash del file o bbox), `text.format` `json_schema` strict con radice distinta per dominio, `store: false` (non equivale a Zero Data Retention), `tools: []`, `truncation: "disabled"`, `max_output_tokens` e, solo se configurato, `reasoning.effort`. Nessun `temperature`, nessuna storia di chat, nessun retry o fallback nell'adapter: ogni `send` è un solo invio e il coordinatore dell'endpoint (17) passa ogni chiamata dal budget 15.

**Schema tradotto:** da `extractionJsonSchema(kind)` si conservano `type`, `properties`, `required`, `additionalProperties:false`, `items`, `anyOf` (nullable), `enum` (anche al posto di `const`), `minimum`/`maximum`, `minItems`; si omettono `$schema`, `$id`, `title`, `$comment`, `minLength`/`maxLength`, `pattern`, `maxItems`. Intervalli ordinati, JSON Pointer, pattern degli ID e lunghezze restano verificati da `validateProposal`, sempre obbligatorio dopo l'adapter.

**Terminazioni:** `completed` (dati `unknown`), `incomplete` (`data` null, mai bozza parziale), `refused` (rifiuto esplicito o filtro contenuti). Errori `ExtractionProviderError` con `code` (`timeout`, `network`, `aborted`, `rate_limited`, `server_error`, `bad_request`, `auth`, `invalid_response`, `invalid_output`, `failed`, `configuration`) e `delivery`: `not_sent`, `rejected` (errore HTTP senza output, usage 0), `received` (usage dal corpo, se presente), `uncertain` (timeout/rete/abort dopo l'avvio o corpo non riconosciuto: la riserva resta). Log solo metadati: codice, stato, HTTP, request ID, latenza, token.

**Configurazione (solo secrets server, disabilitata se incompleta o non valida):**

| Variabile | Obbligatoria | Significato |
|---|---|---|
| `IMPORT_PROVIDER` | sì | `openai` (unico valore accettato) |
| `IMPORT_MODEL` | sì | modello/snapshot del profilo standard, scelto dal corpus 25; nessun default |
| `IMPORT_RETRY_MODEL` | no | profilo `retry`; se assente coincide con lo standard |
| `IMPORT_PROMPT_VERSION` | sì | deve essere `peppitness.import-prompts.v1` |
| `IMPORT_MAX_OUTPUT_TOKENS` | sì | tetto output (reasoning compreso), 1–128000 |
| `IMPORT_RETRY_MAX_OUTPUT_TOKENS` | no | tetto del profilo retry |
| `IMPORT_REASONING_EFFORT` | no | solo se provato con il modello scelto |
| `IMPORT_PROVIDER_TIMEOUT_MS` | no | 1000–300000, default 90000 |
| `OPENAI_API_KEY` | sì | chiave server; mai in log, errori, body o frontend |

URL del provider, prompt, strumenti e modello non sono configurabili dal client. Nessun modello è dichiarato scelto prima della valutazione del task 25; i test usano solo trasporto simulato (`tests/import-provider.test.ts`, risposte in `tests/fixtures/import/provider/`).

## Importazione: endpoint `extract-plan` (task 17, solo locale)

Funzione `supabase/functions/extract-plan/` (`index.ts` cablaggio Deno, `handler.ts` logica provata in Node), con `_shared/import/{analysis,segments,server-config,synthetic-transport}.ts`. Registrata in `config.toml` (`[functions.extract-plan]`, `verify_jwt = true`, import map `deno.json` con `@supabase/supabase-js` 2.117.2). **Nessun deploy**: la funzione non è pubblicata nel progetto cloud.

**Contratto HTTP (per il task 21):** `POST /functions/v1/extract-plan`, `Authorization: Bearer <sessione utente>`, corpo `ExtractPlanRequest` (contratto 02). Risposta con job = `ImportJobResult`: `ready`/`failed`/`expired` HTTP 200, `running` HTTP 202. Errori senza job = `{ error: ImportError }`: 401 `unauthenticated`, 400 `invalid_request`/`unsupported_schema_version`, 403 origine non configurata, 405 metodo, 409 `request_conflict` (stessa chiave con altro input; `retryable: true` se un'altra analisi dell'account è attiva), 413 `limit_exceeded` (byte, profondità, blocchi, testo, token, oppure `providerCallsPerAnalysis` = serve una selezione esplicita di sezioni/pagine), 429 `budget_exhausted`, 503 `provider_unavailable` (analisi disattivata o budget/provider non configurati), 500 `internal`. Ripresa: `get_import_job(p_job_id)` con la sessione utente (RLS/ownership), oppure lo stesso POST con la stessa `analysisRequestId` e lo stesso input (replay senza nuove chiamate). Un job `running` rimasto oltre lease e scadenza viene chiuso al replay (`provider_outcome_uncertain` se la chiamata era partita, altrimenti `internal`).

**Garanzie:** identità verificata dal gateway e da `auth.getUser` (sessione revocata o utente inesistente → 401), mai `owner_id` dal corpo; client privilegiato limitato alle RPC server di jobs e budget; nessuna scrittura di piani/esercizi/catalogo; ogni chiamata (segmenti e retry) passa da `runBudgetedAttempt` con al massimo 2 chiamate per analisi (`min(providerCallsPerAnalysis, max_attempts)`); timeout dopo l'invio = esito incerto con riserva mantenuta, nessun retry; retry solo per errori certi (429/5xx/output non JSON o non valido, incompleto se il profilo retry ha più token) dopo attesa del `Retry-After` entro `IMPORT_MAX_RETRY_WAIT_SECONDS` e il tempo residuo, e dopo ricontrollo del job; risultato validato con `validateProposal` sul documento completo e salvato con `complete_import_job` prima della risposta; esiti `wrong_document_type`/`no_relevant_content`/`unreadable` salvati come `ready` senza contenuto (i mapper 09/10 li bloccano); disconnessione del client non annulla analisi né salvataggio. Documento oltre budget: segmenti per sezioni complete (titoli), contesto globale e titoli antenati ripetuti, tabelle/righe mai spezzate, ricomposizione in ordine di fonte con puntatori rimappati; se non entra in 2 chiamate → 413 con richiesta di selezione, nessun job creato.

**Variabili server aggiuntive:** `IMPORT_ALLOWED_ORIGINS` (origini esatte, separate da virgola), `IMPORT_ANALYSIS_DEADLINE_MS` (5000–400000, default 140000), `IMPORT_MAX_RETRY_WAIT_SECONDS` (0–60, default 10), `IMPORT_TEST_TRANSPORT=synthetic` (solo con `SUPABASE_URL` locale; altrimenti la funzione resta disattivata). Finché il ledger ha un solo modello/prezzo, `IMPORT_RETRY_MODEL` diverso da `IMPORT_MODEL` disattiva l'endpoint. La configurazione budget (`peppitness_private.import_budget_config`) deve avere `enabled=true` e `provider`/`model` uguali a quelli del server.

**Prova locale** (Docker e stack avviati, nessun costo):

```powershell
node scripts/import-edge-local-check.mjs --write-env      # crea supabase/functions/.env sintetico (ignorato)
npx.cmd supabase functions serve extract-plan             # terminale dedicato
node scripts/import-edge-local-check.mjs --summary        # altro terminale
```

Lo script accetta solo lo stack su `127.0.0.1`, rifiuta un `.env` non sintetico, abilita temporaneamente il budget locale via SQL e lo ripristina, crea e rimuove tre account inventati. Il gateway Kong locale risponde da sé ai preflight `OPTIONS` e riscrive `Access-Control-Allow-Origin` in `*`: il 403 per origini non configurate è del handler, il valore esatto dell'header è provato nei test Node. Dopo la prova fermare `functions serve` e, se resta attivo, il contenitore `supabase_edge_runtime_peppitness`.
