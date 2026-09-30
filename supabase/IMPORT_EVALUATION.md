# Valutazione e gate di rilascio dell'importazione

Stato al task 25: parte offline disponibile. Nessun modello MVP scelto,
nessuna valutazione pagata eseguita, nessuna autorizzazione alla spesa.
Cloud: 14 migration applicate secondo la ripresa S9, retention con pg_cron;
nessuna Edge deployata/secrets, budget `enabled=false`. Non attivare il cloud
per eseguire il benchmark offline. Non modificare la specifica per chiudere gate.

## Prova locale senza rete o costi

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:infra
node scripts/import-evaluate.mjs --offline
Get-FileHash artifacts/import-evaluation/report.json -Algorithm SHA256
node scripts/import-evaluate.mjs --offline
Get-FileHash artifacts/import-evaluation/report.json -Algorithm SHA256
```

Gli hash devono coincidere. Il runner impone il trasporto delle registrazioni
sintetiche in `tests/fixtures/import/provider/evaluation/`, impedisce `fetch`,
non legge secrets e non accede a Edge/DB. Non necessita dello stack o di Chrome.
E2E/API/Edge non vanno eseguiti in parallelo sullo stack condiviso. Il task 24
non viene rifatto da questo comando: il suo report è una prova distinta con
browser/SDK/Edge/Auth/DB reali e provider sintetico, iPhone `NOT_RUN`.

## Cosa deve fornire l'utente prima di qualsiasi spesa

1. Account/progetto OpenAI con credito o fatturazione utilizzabile.
2. Chiave API del progetto da custodire **solo nell'ambiente server fidato**,
   mai in chat, argomenti della CLI, frontend, fixture, report o repository.
3. Nomi/snapshot esatti dei candidati OpenAI autorizzati e disponibilità nel
   progetto; parametri output/reasoning supportati da verificare sul candidato.
4. Autorizzazione esplicita distinta e limiti: importo totale della valutazione
   condiviso fra candidati/ripetizioni/retry, massimo chiamate/token/output,
   budget mensile progetto e account e quota giornaliera per il futuro rilascio.

Non c'è un listino preconfigurato. Verificare nel giorno dell'esecuzione le
[tariffe ufficiali](https://openai.com/api/pricing/) e la documentazione ufficiale
del candidato, annotando URL, data UTC, valuta USD e prezzi input/output per
milione. Controllare cache, reasoning, eventuali costi extra e limiti dell'account.
Il runner fattura conservativamente input senza sconto cache, output inclusivo
del reasoning, senza Batch/tool/OCR. Confrontare i risultati anche con i consumi
del progetto; stime e limiti applicativi non sono una garanzia contabile assoluta.
Non copiare i prezzi storici della specifica come default.

## Esecuzione reale futura, soltanto dopo autorizzazione

Il benchmark CLI è un processo server fidato che usa direttamente lo stesso
adapter 16 (`createOpenAIProvider` / `prepare` / un invio); non attiva l'Edge né
il budget cloud. Ha un budget privato distinto, con lock esclusivo e journal
durevole prima di ogni dispatch. Il ledger atomico 15 resta il confine delle
richieste dell'app. Non eseguire il benchmark su dispositivi client.

1. Copiare `tests/fixtures/import/evaluation/real-config.example.json` in
   `private-imports/evaluation/config.json`; lasciare disabilitato finché manca
   anche una sola condizione. Il template propone **$0,25 complessivi**, massimo
   250 chiamate, 100000 input token, tre ripetizioni critiche: sono limiti da
   approvare, non un budget già autorizzato né una promessa che bastino. Il runner
   rifiuta più di $2/run-authorization, 250 chiamate o cinque ripetizioni.
2. Nella configurazione privata impostare `enabled=true`,
   `authorization.paidCalls=true` e un riferimento unico all'autorizzazione;
   `allowedModels` elenca candidati esatti. Riutilizzare **lo stesso riferimento
   e gli stessi tetti per tutti i candidati**: cambiarlo non è un modo di
   azzerare i costi. Una nuova autorizzazione richiede approvazione distinta.
3. Per ogni candidato aggiungere `prices[MODEL]` con `currency: "USD"`,
   `verifiedOn: "YYYY-MM-DD"` (oggi UTC), `source` URL ufficiale,
   `inputMicrosPerMillion` e `outputMicrosPerMillion`: USD × 1000000, interi.
   Zero/prezzi mancanti/data passata disabilitano la prova. Annotare separatamente
   profilo, condizioni di fatturazione e snapshot scelto.
4. In un ambiente server impostare da secret manager `OPENAI_API_KEY` e
   `IMPORT_PROVIDER=openai`, `IMPORT_MODEL`,
   `IMPORT_PROMPT_VERSION=peppitness.import-prompts.v1`,
   `IMPORT_MAX_OUTPUT_TOKENS`, eventualmente `IMPORT_RETRY_MAX_OUTPUT_TOKENS`,
   `IMPORT_REASONING_EFFORT`, `IMPORT_PROVIDER_TIMEOUT_MS` (contratti 16).
   `IMPORT_RETRY_MODEL` deve essere assente o uguale al primario; il ledger
   dell'app ha un solo modello/prezzo. `IMPORT_TEST_TRANSPORT` deve essere assente.
5. Eseguire un candidato per volta, senza cambiare reader/schema/prompt/validator/
   mapping fra candidati. Questi comandi sono istruzioni future, **non eseguiti**:

   ```powershell
   node scripts/import-evaluate.mjs --real --config private-imports/evaluation/config.json --output private-imports/evaluation/candidate-a.json
   ```

   Il corpo completo serializzato (prompt/schema/documento) viene prenotato con
   upper bound byte UTF-8 + framing prima dell'invio. Limite raggiunto/documento
   lungo: stop prima della chiamata. Massimo due tentativi per caso/ripetizione:
   429/5xx/output non JSON/incomplete certi, attesa Retry-After fino a 10 s;
   timeout/rete/risposta incerta: nessun retry, riserva mantenuta. Rifiuto resta
   un esito senza bozza. Usage mancante resta stima prudente, non costo noto.
   Se i prezzi osservati superano la riserva il runner si ferma.
6. Le risposte sono persistite dopo ogni tentativo in `candidate-a.records.json`.
   Il journal `budget-<digest-autorizzazione>.json` copre riavvii e tutti i candidati.
   Non cancellare/ridurre il journal per riprovare. Dopo un crash un lock residuo
   richiede verifica del processo e riconciliazione prudente prima di rimuoverlo;
   la riserva resta conteggiata. I file reali non vengono sovrascritti: usare
   percorsi distinti. Un run incompleto non supera i gate.
7. Rivedere ogni proposta con fonte e UI di revisione. Annotare nei records
   `correctionSeconds` realmente cronometrati e `acceptedByReviewer` booleano
   dopo le correzioni; non modificare `data`/usage/latency come se le correzioni
   fossero estrazione del provider, né trasformarle nel golden atteso.
   Ricalcolare senza rete/costi:

   ```powershell
   node scripts/import-evaluate.mjs --score-real --records private-imports/evaluation/candidate-a.records.json --output private-imports/evaluation/candidate-a.json
   node scripts/import-evaluate.mjs --compare private-imports/evaluation/candidate-a.json private-imports/evaluation/candidate-b.json
   ```

   Scegliere il costo cumulativo minore per importazione accettata, **inclusi
   tentativi falliti e retry**, solo fra candidati reali con copertura completa,
   almeno tre ripetizioni critiche, nessun errore critico/omissione held-out
   non segnalato, proposte held-out rivedibili, annotazioni misurate e usage noto.
   Annotare anche le importazioni non accettate: il loro costo resta al numeratore,
   mentre il denominatore conta solo quelle accettate. Non selezionare da fixture,
   report incompleti o drift del modello. Il confronto espone tutte le metriche
   separate; non produce una confidence. Gate di dispositivo/cloud restano aperti.

Il corpus pubblico è esclusivamente sintetico. Qualsiasi ampliamento con dati
personali richiede un corpus privato e report privati in `private-imports/`, una
valutazione autorizzata separata e annotazioni umane; il runner corrente accetta
solo il manifest sintetico versionato. Non esportare testi/documenti reali in
`artifacts/`, fixture, log o report pubblici. Verificare condizioni di retention
del provider prima di dati personali; `store:false` non promette zero retention.

## Rilascio cloud futuro, separato dal benchmark

1. Chiudere i gate reali del modello sopra, prova fisica iPhone/Safari del 24
   (picker, memoria, ripresa, tastiera, safe area/PWA), review sempre disponibile
   e limiti dichiarati DOCX/PDF testuali; fasi selezionate esplicitamente e regole
   manuali conservate. Nessuna promessa di scansioni/OCR/fasi complete.
2. Controllare progetto collegato, storico e `migration list --linked`, fare
   `db push --linked --dry-run` in ambiente autorizzato: attese 14 migration,
   nessuna nuova introdotta dal 25. Se la storia diverge fermarsi; niente rewrite
   delle migration o reset remoto. Applicare solo migration pendenti autorizzate.
   Verificare `supabase/checks/verify_import_schema.sql` e stato/esiti reali di
   `peppitness_private.import_retention_status()`/pg_cron (migration 23).
3. Con budget ancora **disabled**, configurare secrets nell'ambiente Supabase
   server tramite dashboard/secret manager/file protetto mai versionato:
   variabili provider elencate sopra + `IMPORT_ALLOWED_ORIGINS` con origine PWA
   esatta; ambiente Supabase server privilegiato come già previsto dall'endpoint.
   Nessun `IMPORT_TEST_TRANSPORT`, nessuna chiave `VITE_*`, nessuna chiave negli
   argomenti o nei log. Deploy di `extract-plan` solo su autorizzazione distinta;
   controllare Auth/CORS/503 con budget disabilitato prima di spendere.
4. Preparare tramite SQL amministrativo una configurazione **ancora disabled**
   in `peppitness_private.import_budget_config`: `config_version`, `price_version`
   con data/profilo, `provider=openai`, `model` uguale al secret, `currency=USD`,
   prezzi verificati, `project_limit_micros`, `account_limit_micros`,
   `max_active_per_account=1`, `daily_analyses` basso (iniziale massimo 5),
   `max_attempts=2`, `max_input_tokens`, `max_output_tokens` che copra il maggiore
   dei profili, `framing_tokens`. Tetti mensili bassi scelti dall'utente, non
   ereditati implicitamente dal budget del benchmark. Ricontrollare consumi
   esistenti, riserve incerte e corrispondenza modello/prezzi.
5. Solo dopo autorizzazione a spesa/cloud esplicita, abilitare budget per uno
   smoke sintetico bounded e seriale Auth A/B, review, commit/reload/diario,
   retention/receipt e metadati usage. Se fallisce disabilitare subito il budget,
   conservare riserve incerte e ricevute; non resettare dati reali.
6. Rilascio candidabile solo con tutti i gate chiusi e prove registrate; attivare
   PWA/deploy del sito richiede autorizzazione distinta. Il task 26/27 resta
   post-MVP e non chiude retroattivamente gate mancanti.

Le istruzioni cloud non sono eseguite dal runner. Gli incrementi offline possono
essere versionati mentre la feature per dati reali e la scelta del modello
restano aperte.
