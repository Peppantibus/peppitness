# Valutazione e gate di rilascio dell'importazione

**Stato corrente 03/10/2026:** percorso LLM ritirato, `extract-plan` rimossa dal cloud,
budget disabled, bozze legacy eliminate. Il frontend conserva solo l'import Word
strutturato locale e il commit atomico su Supabase. Reader PDF, provider/Edge,
coordinatori di analisi/revisione legacy e runner di valutazione sono rimossi.
Le sezioni successive restano documentazione storica; i loro comandi di analisi,
valutazione e deploy non descrivono più un percorso disponibile nel repository.
Ricevute e ledger (inclusi gli uncertain) conservati senza riscritture.
Controlli correnti e stato cloud sono in `supabase/README.md` e, sul dispositivo,
`docs/SUPABASE_CLEANUP_AUDIT.md`. Nessuna nuova chiamata provider effettuata.

**Aggiornamento revisione 01/10:** validatorev3 e cache allineata; extract-planv11 ACTIVE/JWT. Promptv4/compact.v2 e tutti i secret/budget invariati. Preparazione automatica del catalogo e conservazione delle indicazioni in `docs/IMPORT_REVISION_RESULT.md`; PASS376/21browser/75Edge/9E2E/offline42, nessun nuovo invio pagato. Il recupero v4 qui sotto documenta l’intervento precedente, non chiude qualità reale o iPhone.

## Recupero v4 — stato corrente del 1 ottobre

Implementazione locale completa e backend candidato `extract-plan` **v10 ACTIVE**,
JWT obbligatorio; prompt `peppitness.import-prompts.v4`, wire interno `compact.v2`.
Aggiornato solo il secret della versione prompt; gli altri digest e il budget
rimangono invariati: Luna medium/output16000/timeout135000, due chiamate massime,
USD1/progetto/mese e USD0,20/account/mese. Nessuna migration o nuova chiamata
pagata. Non ripristinare i comandi v2 storici riportati sotto.

Evidence condivise per riga/paragrafo → DTOpubblico1.0 con citazioni ricavate dalla
fonte → validatorev2. Stringhe ristrette mantengono le regioni delle alternative;
numero/colonna/contesto restano controllati. Cache distinta anche per effort e
output; vecchie bozze leggibili. Log solo metadati: effort, formato, prompt, byte,
ID/fase, conteggi e sezioni non coperte. Timer provider esplicito pulito in finally.
Azioni batch di revisione mantengono decisioni per campo e prescrizioni originali.

**PASS:** Node369, build/typecheck, infra5, corpus offline deterministico42,
Edge75, browser18, E2E8+cleanup, cloud204/CORSesatto/403/401. Worker locale
`oneshot` dopo un'attesa sintetica intermittente con concorrenza su worker
riutilizzato; non attribuire a questa prova la causa dei timeout cloud.
Report dettagliato ignorato: `docs/IMPORT_RECOVERY_RESULT.md`.

**OPEN/NOT_RUN:** R3 su Luna, benchmark held-out, costi/tempi/correzioni reali,
iPhone. Prova manuale autenticata sui DOCX correnti; selezionare **Nuova analisi**
o **Rianalizza**, non riaprire la proposta precedente; verificare `cached:false`.
Inventario e confronto privati in `private-imports/import-recovery/`, prima coppia
max4call/riserva teoricaUSD0,049460 dentro i tetti esistenti. Nessun aumento di
budget, replay incerto, impersonazione o riavvio della diagnostica annullata.
I due documenti di sviluppo non qualificano il modello sul corpus held-out.

Regressioni finali: citazioni numeriche a colonne incoerenti rifiutate anche
quando il numero coincide; `complexRules.targetPaths` indirizza sedute/esercizi,
non i loro campi. Il formato provider impone anche il pattern dei target: supporto
verificato nella [guida ufficiale Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs/).

## Stato storico precedente al recupero v4

Parte offline disponibile; nessun modello qualificato per il rilascio.
Dopo il task 25 l'utente ha autorizzato il deploy di `extract-plan`, i secrets
server e le prove manuali con `gpt-6-luna`. Ultimo stato cloud verificato: 15
migration (inclusa la correzione della concorrenza), Edge `extract-plan` v3 ACTIVE
con prompt `peppitness.import-prompts.v2` e validatore v2,
budget abilitato con tetti USD 1/mese progetto e USD 0,20/mese account;
20 analisi/giorno/account e due chiamate massime per analisi.
Il benchmark reale del corpus non è stato autorizzato né eseguito; le prove
manuali hanno evidenziato timeout e citazioni insufficienti. I gate restano aperti.
Deploy v2 autorizzato ed eseguito il 01/10 dal commit `7b120ca`, dopo che l'utente
ha aggiornato il secret prompt; verificati i digest della configurazione, JWT
attivo e HTTP CORS 204/origine estranea 403/senza sessione 401. Budget sospeso
temporaneamente con marcatore e ripristinato identico; nessun secret cambiato
dall'agente, nessuna analisi o chiamata provider di verifica. Il download opzionale
del sorgente remoto via CLI è fallito con `UnsafeFunctionDownloadPathError`
sugli import condivisi `src/`; ciò non ha impedito il deploy, confermato ACTIVE.
Il runner offline non controlla lo stato cloud.
Non modificare la specifica per chiudere gate.

## Aggiornamento della correzione v2, solo dopo autorizzazione

Per provarla dalla PWA collegata al cloud occorre aggiornare sia `extract-plan`
sia il secret `IMPORT_PROMPT_VERSION=peppitness.import-prompts.v2`. La v1 del
secret con codice v2 (o viceversa) disabilita l'endpoint: non cambiare solo uno.
Prima verificare configurazione e consumi; sospendere il budget durante
l'aggiornamento coordinato e ripristinare soltanto lo stato autorizzato dall'utente.
Non cambiare modello, prezzi, limiti o chiave; non servono nuove migration per
questa correzione. Il profilo di cache include prompt e validatore, quindi una
nuova analisi v2 non riusa la proposta prodotta con v1. Le vecchie bozze restano
rivedibili; nessuna analisi è avviata automaticamente.
Verificare CORS/auth/configurazione senza inviare documenti, poi effettuare solo
la prova manuale espressamente autorizzata. Il successo di quella prova non
chiude il benchmark reale né i gate di rilascio.

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
   `IMPORT_PROMPT_VERSION=peppitness.import-prompts.v2`,
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

## Diagnostica di una singola analisi incerta

La prova su un documento personale è distinta da `--real` del benchmark: quel
runner percorre il corpus e non va lanciato per diagnosticare un solo file.
Recuperare `public.import_drafts.normalized_document` tramite il job e conservarlo
soltanto in `private-imports/`. Ricostruire con `planSegments` e `provider.prepare`
gli stessi body, misurare byte/token prudenziali, hash, parametri e riserva di
ogni segmento. Il massimo di due chiamate comprende tutti i segmenti e retry;
due segmenti consumano già entrambe le chiamate disponibili. La preparazione
offline non è una prenotazione e non autorizza il dispatch.

Il log provider include `clientRequestId` (reservationId), `phase` (`not_sent`,
`headers` = attesa della risposta HTTP, `body` = lettura, `decode` = corpo ricevuto),
codice, stato HTTP, request ID, latenza e usage. Gli header già ricevuti devono
restare disponibili anche quando il corpo si interrompe. HTTP 200 da solo non
prova risposta completa né costo noto: timeout/rete/abort restano incerti e senza
retry. Questi nuovi metadati richiedono il deploy del codice aggiornato prima
di comparire nel cloud; nessun deploy è implicito nella diagnostica locale.

Per conservare anche il JSON grezzo, predisporre **prima dell'unico dispatch**
un trasporto server locale con cattura privata del body serializzato e dei byte
ricevuti, tempi/header consentiti/status, risposta completa o marcata parziale,
usage, risultato adapter e validazione. Non salvare Authorization, chiavi o
token; nessun testo nei log cloud. Il normale endpoint restituisce il risultato
del job, non il body provider grezzo: invocarlo da solo non soddisfa questa
raccolta diagnostica. Non rigenerare per ottenere un dato non registrato.
Ogni invio richiede Auth verificata e prenotazione/dispatch nel ledger esistente,
oltre al tetto aggiuntivo della prova; un journal durevole equivalente deve
rispettare anche i limiti preesistenti, non soltanto il tetto locale. Un nuovo
analysisRequestId identifica la prova distinta; la riserva incerta precedente
resta contabilizzata. Se mancano accessi sicuri, lasciare la prova NOT_RUN.

La CLI SQL legge Postgres, non i log Edge. Per questi ultimi occorre una
connessione Supabase MCP in sola lettura, oppure Management API con accesso ai
log (`SUPABASE_ACCESS_TOKEN` solo nel processo), oppure un export privato da
Studio. Usare una finestra UTC stretta e cercare `provider_error`, correlando
request ID/esecuzione: una sola coincidenza temporale non prova la causa.
Vedi [query ufficiali dei log](https://supabase.com/docs/guides/observability/advanced-log-filtering).

Verifica ufficiale del 01/10/2026: [Supabase Free](https://supabase.com/docs/guides/functions/limits)
ha wall clock 150 s e request idle timeout 150 s (CPU 2 s, I/O asincrono escluso).
Nel codice i default restano 90 s per chiamata e 140 s per l'intera analisi:
alzare soltanto il primo non risolve due segmenti o la deadline complessiva.
[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) usa reasoning
`medium` quando omesso (supporta none/low/medium/high/xhigh/max), input massimo
922.000 e output massimo 128.000 token; restano vincolanti i tetti applicativi
più bassi. Non variare modello/reasoning/schema/segmentazione senza una misura.
Il [listino Standard](https://developers.openai.com/api/docs/pricing) consultato
indica USD 0,10 input / 0,50 output per milione per il contesto breve; non prova
usage o costo effettivo di una chiamata incerta.

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
