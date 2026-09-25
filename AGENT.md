# peppitness — istruzioni operative e piano di sviluppo

Ultimo aggiornamento: 25 settembre 2026.

**Priorità corrente aggiornata dall'utente:** rifinire layout e interazioni prima del backend. Supabase verrà affrontato successivamente in un thread dedicato. L'utente ha chiesto di rimuovere i riferimenti alla demo dall'interfaccia e ha autorizzato una nuova palette; i limiti tecnici rimangono documentati, senza dichiarare salvataggi persistenti inesistenti.

## 1. Leggere prima di lavorare

Questo file raccoglie le decisioni finali di Giuseppe per peppitness e il piano delle prossime esecuzioni agentiche. Leggerlo all'inizio di ogni esecuzione; non presumere che il nome AGENT.md venga caricato automaticamente da ogni strumento. Le successive istruzioni esplicite dell'utente hanno precedenza.

Il progetto vive in questa cartella. Il documento AGENT.md nella cartella superiore riguarda la preparazione atletica personale: non è una richiesta di generare nuovi programmi durante lo sviluppo software.

Le precedenti proposte nella cartella superiore, Proposta_architettura_PWA.md e Proposta_architettura_App.md, conservano il ragionamento storico. Per peppitness fanno fede le decisioni di questo file: PWA personale, React e Vite, Supabase Free. Il tema attuale è chiaro, verde bosco e lime, proposto su richiesta dell'utente dopo il primo feedback; sostituisce il crema/arancione iniziale. L'ipotesi di app nativa commerciale è accantonata.

**Stato reale alla creazione di questo file:** è stata creata soltanto questa documentazione. Non esistono ancora codice dell'app, database, account applicativi, test eseguiti o pubblicazioni di peppitness. Non descrivere una funzionalità pianificata come già implementata.

## 2. Obiettivo e vincoli confermati

- Nome del progetto e della PWA: **peppitness**.
- Marchio visivo: **manubrio con viso e pizzetto**, verde bosco e lime, in `public/logo.svg`. Sostituisce la scritta peppitness nella navigazione desktop/mobile; mantenere il nome nei metadati e nelle etichette accessibili. Favicon e icone app derivano dallo stesso SVG con `npm run icons` (Chrome dedicato, istruzioni nel README).
- Uso principale personale di Giuseppe, sul suo iPhone. Possibile apertura successiva a pochi amici abilitati manualmente, con account e archivi separati.
- Due tab principali: **Dieta** e **Scheda**. Storico, editor e dettagli dentro le rispettive sezioni; account e impostazioni da icona.
- Interfaccia mobile first, curata, chiara, rapida durante l'allenamento; sfondo avorio neutro, superfici bianche, verde bosco e accento lime. Eliminare grandi banner introduttivi e testi sulla demo dai flussi quotidiani, come richiesto nel feedback del 25 settembre.
- Consultare i propri piani e registrare allenamenti e giornate alimentari precedenti.
- Creare e modificare la propria scheda inserendo manualmente i nomi degli esercizi: funzione della prima versione, non dipendente da un catalogo o da Word.
- Dati conservati online in Supabase e recuperabili accedendo da un altro dispositivo. Non tornare a un progetto esclusivamente locale per semplificare.
- PWA pubblicata su **Cloudflare Pages**, usando l'indirizzo gratuito del servizio.
- **Nessun backend applicativo separato**: Supabase fornisce autenticazione, API, database e autorizzazioni. Non significa assenza di backend.
- Budget dei servizi: **0 euro entro i limiti dei piani Free correnti**. Nessun dominio, iscrizione Apple, API IA o abbonamento necessario al nucleo iniziale.
- Account personale dall'inizio; registrazioni pubbliche disattivate. Predisporre l'isolamento tra utenti anche quando ne esiste uno solo.
- Il ricalcolo dei pasti dopo una variazione è rimandato. Non modificare automaticamente alimentazione o prescrizioni di allenamento.

Il risultato atteso è uno strumento quotidiano utilizzabile. Non progettare freemium, abbonamenti, pubblicità, marketplace, social network o pannello per coach.

## 3. Stack scelto

| Responsabilità | Scelta | Motivazione |
|---|---|---|
| Linguaggio frontend | **TypeScript in modalità strict** | Tipi condivisi per piani, registrazioni, importazione e sincronizzazione |
| Interfaccia | **React** | Componenti riutilizzabili per editor, seduta e diario pasti |
| Sviluppo e build | **Vite**, template react-ts | SPA statica, adatta a Cloudflare Pages, senza rendering server necessario |
| Stile | CSS con variabili di tema e componenti semplici | Personalizzazione visiva senza introdurre subito una libreria UI ampia |
| Backend gestito | **Supabase Free**, client ufficiale supabase-js | Auth, PostgreSQL e Data API |
| Schema e autorizzazioni | Migrazioni **SQL** versionate | Vincoli e permessi verificabili e riproducibili |
| Archivio sul dispositivo | **IndexedDB tramite Dexie** | Copia dei dati scaricati e operazioni offline persistenti |
| Installazione e cache dell'app | **vite-plugin-pwa** | Manifest e service worker, con aggiornamenti controllati |
| Distribuzione | **Cloudflare Pages Free** | Pubblicazione del solo risultato della build |
| Verifiche | Typecheck/build, Vitest per logica critica, test SQL/API e prove browser | Controllare dati e accessi; test su iPhone fisico per i comportamenti iOS |

Non serve React Native, Expo, Next.js, un server C#, una VPS o un database SQLite sul server. La libreria Auth C# preesistente non viene integrata in questa versione.

Alla creazione del progetto verificare runtime Node e compatibilità delle versioni disponibili; usare versioni stabili compatibili e un lockfile. Non fissare oggi versioni destinate a diventare obsolete. Usare npm, salvo un vincolo concreto dell'ambiente. Aggiungere altre dipendenze solo quando servono.

La separazione del codice va mantenuta semplice: componenti React, logica di dominio indipendente dalle schermate, adattatori di persistenza e sincronizzazione. La lettura dei componenti non deve dipendere dalla forma grezza delle risposte del database.

## 4. Architettura e significato dei salvataggi

~~~mermaid
flowchart TD
    CF[Cloudflare Pages: file della PWA] --> UI[React sul telefono o sul PC]
    UI <--> AUTH[Supabase Auth: identità]
    UI <--> LOCAL[IndexedDB: copia locale e operazioni in attesa]
    LOCAL <--> SYNC[Sincronizzazione esplicita]
    SYNC <-->|Sessione dell'utente| DB[PostgreSQL: permessi e RLS]
~~~

Cloudflare ospita il codice e gli asset pubblici. Il browser li esegue. Supabase conserva l'archivio condiviso tra dispositivi e applica le autorizzazioni. IndexedDB permette di continuare a registrare quando manca la rete.

La pagina di accesso può essere pubblica: questo non deve rendere pubblici dieta, programmi o progressi. Questi dati si caricano dalle API dopo l'autenticazione; non devono essere inclusi nel bundle o in file statici accessibili tramite URL.

Non usare indirizzo IP, nome del dispositivo, URL nascosto, CORS o una password scritta nel JavaScript come protezione dei dati. L'identità dell'account e i controlli nel database sono il confine di autorizzazione. Un IP mobile cambia e non identifica una persona.

## 5. Interfaccia e tema

Direzione attuale: avorio neutro, superfici bianche, verde bosco per azioni e testo, lime per accenti. Aspetto sportivo, essenziale e leggibile; nessuno sfondo nero come base. Tema modificato dopo il feedback esplicito dell'utente, con priorità ai contenuti utili durante la seduta.

| Token proposto | Colore | Uso |
|---|---|---|
| Sfondo | #F6F7F4 | Fondo avorio neutro |
| Superficie | #FFFFFF | Schede e pannelli |
| Superficie secondaria | #EEF2E9 | Evidenze leggere |
| Testo principale | #20362E | Titoli e contenuti |
| Testo secondario | #627068 | Note e informazioni secondarie |
| Lime accento | #D9EF85 | Accenti e avvio allenamento, con testo verde bosco |
| Verde azione | #234D41 | Pulsanti, navigazione attiva e timer |

Contrasti ricalcolati sui colori pieni: testo principale/sfondo circa 11,99:1; testo secondario/sfondo 4,84:1; bianco/verde azione 9,51:1; verde azione/lime 7,53:1. Ricontrollare gli stati reali, opacità, focus e dimensioni nel prototipo.

Durante la seduta ogni esercizio mostra i valori precedenti accanto alle serie. La card ha due viste, Questa seduta e Ultima volta, con swipe verso sinistra per il precedente, pulsanti espliciti e accesso da tastiera. Il recupero appare in un riquadro fisso dopo Fatto, con tempo rimanente, pausa/ripresa, +15 secondi e Salta. Implementazione UI in memoria; conservazione durevole da collegare nelle fasi dati.

Comandi ampi, etichette leggibili, tastiera numerica adatta a kg e ripetizioni, decimali italiani accettati e normalizzati. Rispettare le aree sicure dell'iPhone e l'ingrandimento del testo. Stati distinguibili anche senza colore. Preferire font di sistema e asset locali; evitare richieste a terze parti prive di utilità.

Ogni tab deve mostrare subito il contenuto del giorno e permettere di cambiare data. L'utente deve riconoscere facilmente quando sta modificando una giornata passata. Non comprimere tabelle Word nella larghezza del telefono.

## 6. Funzioni della prima versione

### 6.1 Scheda e registrazione

- Programma attivo con sedute configurabili, inizialmente A/B/C per Giuseppe. Numero e nomi delle sedute non fissati nel codice.
- Giorni abituali configurabili, seduta suggerita e selettore manuale sempre visibile. Nei giorni liberi è comunque possibile iniziare una seduta.
- Una seduta in corso ha priorità e può essere ripresa dopo chiusura, riapertura o cambio data. Nessun doppio allenamento creato da un tocco ripetuto.
- Se calendario e sequenza divergono, mostrare l'ultima seduta completata e la successiva ancora da fare; non completare automaticamente le sedute saltate.
- Esercizi con nome, ordine, serie, intervallo di ripetizioni o durata, recupero, RIR/RPE quando previsto e note.
- Registrazione delle serie effettive: carico, ripetizioni/durata, completamento, eventuali note. Distinguere valori prescritti e risultati.
- Mostrare accanto ai campi l'ultima esecuzione comparabile con data, anche se apparteneva a un'altra seduta. Stesso esercizio, variante, macchina e convenzione di carico; altrimenti indicare l'assenza di un precedente confrontabile.
- Copiare i vecchi carichi non deve copiare le ripetizioni come già eseguite o spuntare le serie.
- Storico per data e dettaglio della seduta, correggibile. Grafici complessi non necessari al primo rilascio.
- Registrare anche durata e nota del cardio previsto, senza richiedere sensori, smartwatch o integrazioni esterne.
- Timer recupero basato sull'orario di scadenza persistito. Non promettere suoni/notifiche affidabili a schermo bloccato prima di verificarli su iPhone.

### 6.2 Editor manuale delle schede

L'utente crea un programma, aggiunge sedute e scrive gli esercizi a mano. Per ogni esercizio può configurare serie, ripetizioni o durata, recupero e note; RIR/RPE e macchina sono facoltativi. Può riordinare, duplicare, modificare e rimuovere elementi da una bozza.

Gli identificativi sono gestiti dall'app. Offrire il riuso di un esercizio personale già inserito per mantenere confronti coerenti; una semplice rinomina non crea automaticamente un nuovo esercizio. Distinguere modifiche del nome da un cambio di variante o macchina.

Flusso: bozza modificabile, controllo dei campi, attivazione della versione. Modificare una versione già utilizzata genera una nuova versione e lascia intatte le sedute precedenti. Rimuovere un esercizio dal nuovo programma non elimina le serie storiche. Non aggiungere un limite artificiale di programmi per ragioni commerciali.

### 6.3 Dieta e diario

- Piano dell'utente con giornate, pasti, quantità, alternative e note. Selezione del tipo di giornata palestra/riposo quando previsto dal piano.
- Stati di ogni pasto: **Da registrare, Seguito, Modificato, Saltato**.
- Una registrazione mancante non significa pasto saltato o zero calorie. Seguito è una dichiarazione delle quantità previste, sempre correggibile.
- Modificato permette inizialmente una nota libera su cosa è cambiato; non richiede un catalogo alimentare o un calcolo nutrizionale.
- Storico delle giornate con data, piano di riferimento, stato e note. Cambiare programma o tipo di giornata non riscrive ciò che è già stato registrato.
- Nessuna etichetta Pasto fallito e nessun voto nutrizionale dedotto dalle spunte.
- Un editor essenziale di giornate/pasti con testo, quantità e note, oppure importazione strutturata dello stesso modello, permette a ciascun account di avere il proprio piano. Nessuna generazione automatica di diete.

Per gli amici l'editor delle schede è utilizzabile senza file. Il loro piano alimentare può essere inserito con l'editor essenziale o importato; non assegnare loro il piano di Giuseppe.

### 6.4 Account, impostazioni e backup

Accesso, uscita, stato della sincronizzazione, importazione dei propri piani, esportazione/ripristino e istruzioni di recupero account. Le azioni distruttive devono indicare cosa eliminano e distinguere copia locale, programma e storico.

## 7. Fonti personali e conversione iniziale

Le fonti operative nella cartella superiore sono:

- ../Scheda_Full_Body_Giuseppe_Olympus_Empire_v1_3.md e relativo DOCX.
- ../Piano_Alimentare_Giuseppe_Atleta_Ibrido.md e relativo DOCX.

Usare preferibilmente le versioni Markdown per una conversione controllata; confrontare il risultato con le prescrizioni complete. Le vecchie versioni della scheda non sono il riferimento corrente. Non cambiare esercizi o alimentazione durante una conversione software.

La scheda contiene fasi di 12 settimane, indicazioni globali per la ripresa, serie che cambiano, incrementi facoltativi, scarichi, cardio e adattamenti al trekking. Non estrarre soltanto le tabelle perdendo le istruzioni. La fase deve essere selezionabile/ripetibile; una terza serie facoltativa non va aggiunta automaticamente.

Il piano alimentare contiene giornate intercambiabili, alternative e aggiunte condizionate all'allenamento. Conservare quantità, unità e distinzione tra piano base e aggiunte.

Preparare pacchetti strutturati versionati, con anteprima e validazione, e importarli tramite l'account destinatario. Il pacchetto personale deve restare fuori dal repository condivisibile, da public, dai dati demo e da dist. Usare una cartella locale ignorata, per esempio private-imports, se serve un artefatto temporaneo. Non conservare il Word completo nel cloud quando bastano i dati del piano.

Per lo sviluppo usare dati inventati chiaramente dimostrativi, senza misure, foto, dati personali o contenuti dei documenti privati. I file nella cartella Fitness non devono essere pubblicati.

Il parser di Word arbitrari non è incluso. Aggiornare un programma tramite editor o nuovo pacchetto non deve richiedere una nuova versione dell'app né cancellare lo storico.

## 8. Modello dati: decisioni da rispettare

Entità proposte da affinare nella prima fase tecnica:

| Area | Entità |
|---|---|
| Impostazioni personali | user_settings |
| Esercizi personali | exercises con ID stabile, nome, variante e unità |
| Programmi | workout_plans, workout_plan_versions, workout_days, workout_prescriptions |
| Allenamenti | workout_sessions, workout_sets, eventuale blocco cardio |
| Alimentazione | meal_plans, meal_plan_versions, meal_days, meals |
| Diario alimentare | meal_logs con data, stato, nota e riferimento al pasto previsto |

Ogni record personale deve essere associato al proprietario autenticato, direttamente o tramite relazioni verificabili. Preferire un owner_id esplicito anche nei figli per rendere controlli e indici leggibili, con vincoli che ne garantiscano la coerenza col padre. Non affidarsi al valore owner_id inviato dal client.

Separare prescrizioni e risultati. Una sessione conserva versione del programma e fotografia delle prescrizioni effettive all'avvio; il diario pasti conserva il contesto storico del pasto. Bozze modificabili, versioni utilizzate non riscritte in modo retroattivo. Proteggere anche lato database i vincoli essenziali, compresa la gestione delle versioni.

Usare UUID stabili, created_at, updated_at e una revisione per le modifiche concorrenti. Timestamp degli eventi in UTC; giorno del diario come data locale con fuso pertinente, inizialmente Europe/Rome. Non calcolare il giorno italiano tagliando semplicemente una stringa ISO UTC.

Validare numeri, campi richiesti, lunghezze e relazioni sia nell'app sia nel database dove necessario. Valore vuoto, zero e serie non completata hanno significati diversi. Gestire esercizi a tempo, per lato e a corpo libero. Limiti e unità devono essere espliciti, senza vietare carichi validi con assunzioni arbitrarie.

Le operazioni composte richiedono una transazione o un'operazione atomica verificata: salvare metà programma dopo un errore di rete non è accettabile. Un'eventuale funzione SQL non è un backend separato; non introdurre privilegi elevati senza necessità.

## 9. Sicurezza Supabase: modello e requisiti

### 9.1 Valutazione onesta

Supabase è una scelta adatta a questa architettura se configurato e verificato correttamente. Fornisce infrastruttura, Auth e controlli nel database; il progetto rimane responsabile di accessi, schema, codice e protezione dei segreti. Non promettere rischio zero o account impossibili da compromettere. Aggiungere un server proprio non elimina automaticamente questi rischi. [S1]

Il piano Free offre i controlli di base necessari, ma non tutte le protezioni dei piani a pagamento. Per esempio non assumere disponibile il controllo delle password già compromesse. Le password sono gestite da Supabase Auth come hash: non implementare un archivio password nelle tabelle dell'app. [S4, S7]

L'isolamento tra utenti non è cifratura end-to-end: chi amministra il progetto Supabase dispone di accessi privilegiati ai dati. Non descrivere i dati degli amici come illeggibili al proprietario del progetto. Minimizzare le informazioni raccolte e spiegare questa gestione prima di invitare persone reali.

### 9.2 Accesso iniziale e amici

1. Creare un account applicativo personale tramite gli strumenti amministrativi. Email e password come metodo iniziale; sessione persistente finché valida e gestione del rinnovo tramite client ufficiale.
2. Disabilitare registrazioni pubbliche e accessi anonimi **nel servizio Supabase**, non soltanto nella UI. Disabilitare provider non usati. [S5]
3. Gli eventuali amici ricevono account individuali creati o invitati amministrativamente; non condividono password, dati o sessioni di Giuseppe.
4. Distinguere account dell'app e account amministrativo Supabase. Gli amici non diventano membri del team o amministratori del progetto.
5. Usare password uniche e proteggere con MFA gli account amministrativi Supabase, Cloudflare e del repository. Predisporre MFA TOTP per gli utenti dell'app prima dell'estensione agli amici, con procedura di recupero. Se viene attivata come protezione, verificarla anche nel livello di autorizzazione tramite assurance level, non solo in una schermata. Il controllo MFA deve aggiungersi a quello di proprietà dei record. [S6]

Le email predefinite Supabase hanno destinatari e frequenza limitati e non costituiscono un servizio di invito/recupero generale. Per il solo proprietario verificare l'indirizzo consentito oppure definire il recupero tramite amministrazione. Prima degli amici configurare e provare un invio email adatto, oppure una procedura amministrativa chiara senza dipendere da email automatiche. Non aggiungere amici al team Supabase per aggirare questo limite. Un servizio email gratuito può richiedere un dominio: non acquistarlo o introdurre costi senza una nuova scelta esplicita dell'utente. [S8]

### 9.3 Database e API

- Abilitare RLS su tutte le tabelle personali esposte. Revocare accessi anonimi ai dati privati e concedere a authenticated soltanto le operazioni necessarie. [S2, S3]
- Definire regole per lettura, inserimento, modifica e cancellazione: identità verificata uguale al proprietario. Per inserimenti e aggiornamenti verificare anche i valori nuovi, impedendo trasferimenti di proprietà.
- Impedire riferimenti tra proprietari diversi: per esempio una serie di B non può puntare a una sessione di A. Valutare chiavi esterne composite e controlli coerenti nelle policy.
- Non utilizzare come autorizzazione campi modificabili dall'utente, parametri del browser o semplice conoscenza di un UUID.
- Applicare la stessa attenzione a viste e funzioni RPC: possono esporre dati o usare privilegi diversi. Preferire funzioni con privilegi del chiamante; eventuale SECURITY DEFINER deve avere giustificazione, controlli espliciti e search_path sicuro.
- Storage non necessario nella prima versione. Se aggiunto, bucket privati e policy specifiche, senza considerare RLS delle tabelle una protezione automatica dei file.

### 9.4 Chiavi, frontend e sessioni

Nel frontend soltanto URL del progetto e chiave pubblicabile, nelle variabili VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY. La chiave pubblicabile è visibile per progetto: identifica l'app, non autorizza da sola l'accesso ai dati. Segreti e service_role aggirano le protezioni e non devono arrivare al browser. [S9]

Mai inserire password del database, token amministrativi, chiavi segrete o credenziali personali in bundle, repository, schermate, log o file di esempio. Le variabili VITE_ finiscono nel codice distribuito: un file .env non le rende segrete. Preparare .env.example soltanto con segnaposto. [S10]

Usare HTTPS, rendering del testo sicuro, nessuna esecuzione di HTML/script provenienti da esercizi o importazioni. Evitare dangerouslySetInnerHTML per dati dell'utente. Configurare header e CSP compatibili con i servizi effettivamente usati; non risolvere errori aprendo indiscriminatamente origini e script. Non registrare token, password, pasti o misure nei log di errore.

Una SPA conserva una sessione sul dispositivo e deve proteggerla da script malevoli: RLS non impedisce un abuso con una sessione rubata. Gestire scadenza e nuovo accesso senza perdere bozze. Separare archivi/cache per utente e impedirne la visualizzazione dopo logout o cambio account. La cache del service worker deve riguardare app e asset; non memorizzare indiscriminatamente risposte Auth/API private.

I dati già scaricati offline non possono essere revocati a distanza da un dispositivo disconnesso. Non promettere cifratura locale o end-to-end che non è stata implementata. Il blocco del telefono rimane parte della protezione del dispositivo.

### 9.5 Prove di accesso prima dei dati reali

Usare due account di prova A/B e chiamate API reali, senza privilegi amministrativi nel client dei test. Controllare almeno:

- Visitatore senza sessione: nessuna lettura o modifica dei dati personali.
- A: può gestire i propri dati previsti dall'app.
- B: non può leggere, aggiornare o cancellare i record di A, anche conoscendone gli ID.
- B: non può inserire un record intestato ad A, modificare owner_id o collegare propri record a quelli di A.
- Verifiche equivalenti per tutte le tabelle, eventuali viste, RPC e file esposti.
- Registrazione non autorizzata e accesso anonimo rifiutati dal servizio.
- Logout/cambio account senza residui visibili e operazioni offline mai inviate sotto un altro utente.
- Se MFA è prevista, una sessione che non ha superato il secondo fattore non deve aggirarla tramite API.

Il Security Advisor di Supabase è un aiuto; non sostituisce queste prove. Una build riuscita o un login funzionante non sono evidenze sufficienti. Non segnare completata una verifica mai eseguita. [S1, S3]

Se emerge una fuga di segreti, interrompere l'esposizione e ruotare le credenziali interessate; rimuoverle solo dal file corrente non basta. In caso di incidente su dati/sessioni seguire una procedura documentata di contenimento e recupero, senza cancellare lo storico per nascondere il problema.

## 10. Offline, sincronizzazione e backup

Il primo accesso e il primo download richiedono rete. Poi salvare ogni modifica prima in IndexedDB insieme a un'operazione persistente da inviare. Mostrare stati comprensibili: **Salvato sul dispositivo**, **Sincronizzato**, **Da risolvere**. Non dichiarare riuscito un salvataggio cloud prima della conferma.

Supabase e Dexie non producono automaticamente una sincronizzazione tra loro. Implementare:

- Operazioni con ID univoco e retry idempotente, senza serie o pasti duplicati.
- Invio all'apertura, al ritorno in primo piano e quando la rete torna disponibile; non affidarsi all'esecuzione continua in background su iOS.
- Lettura degli aggiornamenti cloud con revisioni e gestione delle eliminazioni, così che un vecchio dispositivo non ricrei dati cancellati.
- Rilevamento dei conflitti: il server deve verificare atomicamente la revisione attesa. Non sovrascrivere silenziosamente la stessa seduta modificata da due dispositivi.
- Un solo dispositivo alla volta per una seduta come convenzione iniziale, senza eliminare per questo il rilevamento dei conflitti.
- Logout con modifiche non sincronizzate: proporre sincronizzazione o esportazione prima di rimuovere la copia locale; eventuale scarto dev'essere esplicito.
- Migrazioni dello schema locale e pacchetti di import/export versionati.

Service worker con aggiornamento controllato: non ricaricare la PWA nel mezzo di una serie o con modifiche in attesa. Un aggiornamento non deve eliminare il database. Le prove nel browser desktop non sostituiscono quelle della PWA installata su iPhone.

Supabase Free non comprende backup automatici. Prevedere esportazione e ripristino dei dati dell'utente, con note sulle modifiche ancora locali, e una procedura periodica di backup amministrativo del database. I backup devono stare fuori da repository e hosting pubblici. Provare il ripristino senza duplicazioni e senza assegnare dati a un account diverso. Una sincronizzazione non è un backup indipendente. [S7, S11]

Il cambio telefono recupera i dati già sincronizzati dopo l'accesso. La cancellazione dello storage del browser può perdere modifiche non inviate: non presentare lo storage locale come permanente garantito. [S12]

## 11. Costi e limiti da tenere presenti

Configurazione iniziale proposta: Cloudflare Pages Free con indirizzo pages.dev, Supabase Free e librerie gratuite. Nessun acquisto automatico. L'eventuale costo dell'agente AI usato per sviluppare è separato dai servizi della PWA.

Listini controllati al 25 settembre 2026; riverificarli prima dell'attivazione. Supabase Free include 500 MB di database, 1 GB di file e quote di traffico, e prevede sospensione dopo una settimana di inattività. Non offre backup automatici né tutte le funzioni di sicurezza dei piani a pagamento. Per un piccolo diario il piano gratuito è una scelta plausibile da monitorare, non una promessa di capacità o disponibilità illimitata. [S7]

L'app deve spiegare un'eventuale indisponibilità cloud senza fingere che le scritture siano riuscite. Non aggiungere richieste artificiali periodiche soltanto per aggirare l'inattività del piano. Documentare riattivazione, monitoraggio quote e recupero.

Il deployment deve avere come root questa cartella e come output **dist** generata da Vite. Non pubblicare la cartella Fitness, documenti personali, backup, .env, migrazioni o file di lavoro. Preparare il fallback SPA per le rotte e verificarlo su URL diretti. [S13]

## 12. Piano delle prossime esecuzioni agentiche

Le fasi sono ordinate per dipendenze. Si possono completare più fasi nella stessa esecuzione se verificabili; non occorre chiedere conferme per ogni scelta ordinaria già coperta da questo documento. Il lavoro attuale riguarda soltanto la preparazione del piano: lo sviluppo inizierà con la prossima richiesta operativa.

### Fase 1 — Fondamenta e prima interfaccia

Ispezionare la cartella, eventuali modifiche dell'utente e gli strumenti disponibili. Creare React + Vite + TypeScript, configurazione PWA iniziale, tema crema/arancione, due tab e navigazione ai dettagli con dati demo. Impostare struttura, ignore, lockfile, .env.example e README con comandi reali.

**Uscita verificabile:** build e typecheck riusciti, navigazione mobile funzionante, nessun dato personale nel pacchetto. Non bloccare la UI se le credenziali Supabase non sono ancora disponibili. Dopo il feedback esplicito dell'utente, il carattere dimostrativo è documentato in README e nel registro, senza badge o avvisi ripetuti nell'interfaccia; non inviare dati reali né fingere salvataggi cloud.

### Fase 2 — Modello dati e autorizzazioni

Definire i tipi di dominio, le regole di versionamento e le migrazioni SQL; creare vincoli, indici essenziali, grants e RLS. Scrivere test di isolamento con due utenti e tentativi di collegamento tra proprietari diversi. Documentare configurazione Auth, regione del progetto, recupero e gestione degli account.

**Uscita verificabile:** migrazioni e test riproducibili; prove eseguite in ambiente di test disponibile. Se manca un ambiente Supabase/local stack, dichiarare esattamente ciò che resta da eseguire e continuare il lavoro locale indipendente. Non presentare SQL scritto come sicurezza già validata.

### Fase 3 — Editor e piani

Realizzare editor manuale delle schede, riuso degli esercizi personali, bozza/attivazione e versioni. Aggiungere editor essenziale dei pasti e formato di importazione con anteprima. Preparare la conversione privata dei documenti operativi di Giuseppe, verificando le fasi e le eccezioni; attivarla soltanto nell'account corretto quando disponibile.

**Uscita verificabile:** un utente può costruire una scheda senza file; un cambio programma preserva uno storico di prova; import non valido respinto senza lasciare mezzo piano salvato.

### Fase 4 — Diario quotidiano

Implementare scelta della seduta, avvio/ripresa, registrazione serie, precedente comparabile, timer e storico. Implementare dieta del giorno, stati dei pasti, note e consultazione/modifica delle date precedenti. Usare prescrizioni risolte e snapshot storici.

**Uscita verificabile:** completare una seduta, riaprirla nello storico e ritrovarne il precedente nella successiva; registrare ieri nella dieta senza alterare oggi. Provare anche serie a tempo, zero/vuoto e date vicino a mezzanotte.

### Fase 5 — Accesso e collegamento cloud

Collegare Supabase con chiave pubblicabile, login personale, sessione e recupero. Ripetere le prove dei permessi sulle API realmente esposte e verificare la separazione delle cache. Consentire il recupero dell'archivio da un secondo browser/dispositivo.

**Uscita verificabile:** dati persistenti nel cloud, utente estraneo respinto, nessuna credenziale privilegiata nel bundle. Nessun invito ad amici prima che isolamento e recupero siano stati provati.

### Fase 6 — Offline e conservazione dei dati

Completare archivio locale, coda, retry, revisioni, conflitti e aggiornamenti del service worker. Aggiungere esportazione/ripristino e procedura di backup. Provare chiusura/riapertura, rete assente, riconnessione, cambio account e update dell'app con operazioni in attesa.

**Uscita verificabile:** nessuna perdita o duplicazione nei casi testati; stato di sincronizzazione corretto; ripristino riuscito. Indicare separatamente le prove ancora necessarie sul telefono reale.

### Fase 7 — Prova su iPhone e pubblicazione

Verificare il flusso completo nella PWA installata, tastiera, layout, accessibilità, timer, uso offline e riapertura. Preparare configurazione Cloudflare Pages, output dist, fallback delle rotte, header, URL Auth di produzione e istruzioni di installazione. Controllare i file distribuiti.

**Uscita verificabile:** una build concreta pronta per la pubblicazione e controlli documentati. Effettuare la pubblicazione solo quando rientra nella richiesta operativa e gli accessi sono disponibili; non creare flussi di approvazione ripetitivi per azioni già autorizzate. Non acquistare servizi.

### Fase 8 — Eventuali amici

Solo dopo uso personale stabile: provare abilitazione di un nuovo account, impostazione/recupero della sua password, MFA se attivata, archivio vuoto, creazione della propria scheda e caricamento della propria dieta. Informare su dati trattati, ruolo dell'amministratore, esportazione e cancellazione. Controllare quote e backup dopo l'estensione.

**Uscita verificabile:** l'amico usa il proprio diario, non vede dati di Giuseppe e non possiede accessi amministrativi. L'aggiunta di un amico non attiva registrazioni pubbliche.

## 13. Metodo di lavoro e passaggio tra agenti

- Leggere questo file e lo stato effettivo; distinguere completato, parziale, non verificato e ancora da fare. Non ricominciare da zero.
- Tenere le modifiche dell'app dentro peppitness. Non modificare i documenti originali della dieta o della scheda senza richiesta.
- Procedere con modifiche piccole ma complete e verificabili; evitare riscritture dello stack o nuove funzioni non richieste.
- Non delegare ad altri agenti automaticamente: questo piano riguarda esecuzioni successive, non autorizza da solo lavoro multi-agente.
- Non chiedere password o segreti da incollare in chat. Usare i canali sicuri disponibili e configurazioni locali appropriate; non stampare credenziali negli output.
- Se manca un accesso esterno, preparare codice, migrazioni, test e istruzioni che non ne dipendono; segnalare il passaggio preciso rimasto. Non fingere che una risorsa sia stata creata.
- Eseguire test utili a logica, sicurezza e conservazione dei dati. Non introdurre test che controllano soltanto colori o ripetono l'implementazione.
- Al termine di ogni esecuzione aggiornare il registro qui sotto con modifiche, verifiche effettive, problemi aperti e prossimo passo concreto. Il riepilogo all'utente deve essere breve e in italiano.

La precedente stima di 25–40 ore era orientativa per una piccola PWA con account, cloud e offline. L'editor e le verifiche ampliano il lavoro: non trattarla come un preventivo o una scadenza garantita. Rivalutare dopo la prima fase sul codice e sull'ambiente reali.

## 14. Fuori dal perimetro attuale

Rimandati: ricalcolo alimentare, generazione di diete o schede, IA nel prodotto, parser universale DOCX/PDF, foto dei pasti, catalogo alimentare esteso, integrazione Salute/smartwatch, notifiche push avanzate, funzioni social, coach, vendite e app native.

Se in futuro si affronta l'adattamento dei pasti, distinguere semplice registrazione e stime da una nuova proposta nutrizionale: dati verificabili, alternative circoscritte al piano, anteprima e conferma. Nessun digiuno, pasto saltato o esercizio compensatorio proposto per azzerare uno scostamento. Non introdurre ora codice o dipendenze per questa funzione futura.

## 15. Fonti ufficiali per le decisioni tecniche

Consultate il 25 settembre 2026. Rileggere solo le parti pertinenti quando versioni, piani o configurazioni cambiano. Le procedure del progetto sopra sono scelte operative; la documentazione del fornitore non certifica che siano state implementate.

- [S1 — Supabase: responsabilità condivisa](https://supabase.com/docs/guides/deployment/shared-responsibility-model)
- [S2 — Supabase: sicurezza della Data API](https://supabase.com/docs/guides/api/securing-your-api)
- [S3 — Supabase: Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [S4 — Supabase: password](https://supabase.com/docs/guides/auth/password-security)
- [S5 — Supabase: configurazione accessi](https://supabase.com/docs/guides/auth/general-configuration)
- [S6 — Supabase: MFA](https://supabase.com/docs/guides/auth/auth-mfa)
- [S7 — Supabase: piano Free e limiti](https://supabase.com/pricing)
- [S8 — Supabase: SMTP e limiti delle email](https://supabase.com/docs/guides/auth/auth-smtp)
- [S9 — Supabase: chiavi pubblicabili e segrete](https://supabase.com/docs/guides/getting-started/api-keys)
- [S10 — Vite: variabili esposte al client](https://vite.dev/guide/env-and-mode)
- [S11 — Supabase: backup](https://supabase.com/docs/guides/platform/backups)
- [S12 — WebKit: archiviazione locale](https://webkit.org/blog/14403/updates-to-storage-policy/)
- [S13 — Cloudflare Pages: React](https://developers.cloudflare.com/pages/framework-guides/deploy-a-react-site/)
- [Vite: configurazione iniziale](https://vite.dev/guide/)
- [vite-plugin-pwa: guida](https://vite-pwa-org.netlify.app/guide/)
- [Dexie: IndexedDB](https://dexie.org/docs/Tutorial/Getting-started)

## 16. Registro e prossima esecuzione

### 25 settembre 2026 — Preparazione

- Completato: cartella peppitness e questo piano; stack, tema, funzioni, sicurezza, isolamento utenti e fasi definiti.
- Verificato: documentazione ufficiale dei servizi e contrasti base della palette.
- Non ancora eseguito: scaffold, codice, migrazioni, connessioni cloud, test di sicurezza, prove su iPhone e deploy.
- Prossima esecuzione: **Fase 1**, creare lo scheletro React/Vite/TypeScript e le due tab con tema crema/arancione e dati demo, mantenendo fin da subito la separazione tra dominio e persistenza.
- Domande non bloccanti: dettagli estetici e preferenze minori da risolvere sul prototipo. Credenziali, progetto Supabase e account Cloudflare serviranno quando si collega o pubblica davvero l'app; non sono necessari per disegnare e implementare la prima interfaccia.

### 25 settembre 2026 — Prima interfaccia implementata

- Completato: progetto React 19.2.3 / Vite 7.3.1 / TypeScript 5.9.3 strict, plugin React 5.1.2, lockfile npm, tema crema/arancione, layout desktop e mobile con Dieta e Scheda. Navigazione iniziale tramite hash URL, calendario in Europe/Rome, dettagli pasti/esercizi, schermata impostazioni, dati interamente inventati e separazione tra dominio, schermate e adattatore demo.
- Interazioni dimostrative: stati e note dei pasti per data, selettore di seduta, avvio/ripresa in memoria senza duplicazione della seduta in corso, carichi con virgola italiana, ripetizioni/durate e serie completate, snapshot e storico temporaneo. Non sono il diario persistente delle fasi 4–6: chiusura o ricaricamento azzerano tutto, come indicato nella UI. Nessun accesso a documenti personali e nessuna conversione privata effettuata.
- Predisposto: manifest, icone PNG locali, configurazione separata `vite.pwa.config.mjs`, registrazione e aggiornamento controllato nella build PWA, `.env.example`, ignore, header/CSP e fallback Cloudflare, README e `docs/VERIFICATION.md`. Non installate dipendenze cloud o Dexie prima del relativo utilizzo.
- Verificato: Node 22.22.0 / npm 10.9.4; installazione e reinstallazione offline dal lockfile, typecheck e build riusciti; 8 test di dominio/mock superati; smoke test in Chrome con viewport 320/390/768/1440 px, senza overflow orizzontale, errori console o richieste esterne nel flusso verificato. Provati dettagli, Escape, pasti su date diverse, validazione, ripresa e storico della seduta, pagina già caricata senza rete e reset dichiarato al reload. Ispezionati screenshot e contenuto di dist.
- Problema dell'ambiente: npm non può raggiungere il registry (`EACCES`), quindi sono state usate versioni stabili compatibili già in cache, senza dichiararle le ultime. `vite-plugin-pwa` e Vitest non sono in cache: PWA configurata ma service worker non generato/collaudato; test critici eseguiti con `node:test` come soluzione provvisoria documentata. La cache copiata e il profilo Chrome di test restano nelle cartelle ignorate del progetto. Un lock Windows durante `npm ci` è stato risolto arrestando la preview.
- Stato Fase 1: prima interfaccia e build verificate; **parte PWA parziale**, da attivare con rete npm disponibile (`npm run setup:pwa`, poi `npm run build:pwa`) e collaudare. Nessuna pubblicazione, nessun Supabase, autenticazione, RLS, editor, confronto carichi, timer, storage persistente, sincronizzazione o backup ancora implementati. Test iPhone e autorizzazioni reali non eseguiti.
- Prossimo passo concreto: completare e verificare il service worker quando il registry è raggiungibile; procedere con **Fase 2**, modello versionato, migrazioni, vincoli/grants/RLS e prove riproducibili a due utenti. In assenza di un ambiente Supabase continuare con tipi, SQL e test predisposti distinguendo quelli non eseguiti. Non usare la demo per conservare dati reali e non considerare i test del mock una verifica di sicurezza.

### 25 settembre 2026 — Revisione layout su feedback dell'utente

- Richiesta e priorità: concentrarsi sull'interfaccia; togliere i testi relativi alla demo, cambiare palette, rendere visibili i carichi precedenti e mostrare il recupero dopo Fatto. Supabase rinviato a un thread dedicato dopo il feedback sul layout. Questa decisione sostituisce la priorità immediata del registro precedente.
- Realizzato: tema avorio/bianco, verde bosco e lime; navigazione semplificata, calendario compatto, eliminazione di hero illustrativi, badge demo, avvisi ripetuti e footer introduttivi. Avvio allenamento visibile prima degli esercizi; schede leggibili, tastiere numeriche e indicatore di avanzamento della seduta. Icone e manifest aggiornati alla palette.
- Precedenti: carico/ripetizioni o durata dell'ultima esecuzione confrontabile visibili sotto ogni serie, con data nella tab Ultima volta. Scorrimento della card a sinistra, pulsanti e frecce da tastiera per alternare le viste. Ricerca tra sedute completate, anche diverse, tramite ID esercizio, variante, attrezzo/macchina, convenzione di carico, modalità e per-lato. Esclusi futuro, seduta corrente e serie non completate. Riprendi i carichi riempie solo carichi vuoti senza copiare ripetizioni o completamenti.
- Recupero: riquadro fisso dopo Fatto, timer dalla prescrizione dell'esercizio, pausa/ripresa, +15 secondi e Salta. Scadenza assoluta mantenuta nello stato della pagina anche cambiando sezione; annullamento quando si riapre la serie relativa o si termina la seduta. Nessuna promessa di timer persistente al reload, notifiche o suoni a schermo bloccato.
- Verificato: typecheck/build superati; 15 test superati; smoke test Chrome 320/390/768/1440 px senza overflow orizzontale, errori console o chiamate esterne. Riprodotto il caso 12,5 kg × 10 registrato e mostrato nella seduta della settimana dopo; testato swipe touch via CDP, copia del solo carico, timer e salto dell'orologio. Ispezionati screenshot della nuova UI e ricalcolati i contrasti della palette.
- Limiti invariati: contenuti inventati, allenamenti/pasti e timer solo in memoria, persi al ricaricamento; nessun collegamento Supabase, IndexedDB o sincronizzazione aggiunti. Non ripristinare automaticamente i testi demo nella UI: la loro rimozione è esplicita; tenere lo stato tecnico onesto in README. Restano da provare Safari/iPhone reale e PWA/service worker.
- Prossimo passo: raccogliere il prossimo feedback sul layout e rifinire i flussi indicati dall'utente. Affrontare modello dati, Auth/RLS e persistenza nel successivo lavoro dedicato a Supabase, riutilizzando questo stato.

### 25 settembre 2026 — Logo manubrio con pizzetto

- Richiesta: creare un logo di un manubrio con pizzetto e usarlo al posto della scritta peppitness.
- Realizzato: marchio SVG locale, manubrio con viso e pizzetto nei colori verde bosco/lime. Sostituita la scritta nella sidebar desktop e nell'intestazione mobile, conservando etichette accessibili e nome dell'app. Aggiornate favicon e icone PNG 180/192/512 con margini per l'area maskable.
- Manutenzione: unica sorgente `public/logo.svg`; nuovo comando `npm run icons` tramite Chrome CDP per esportare tutti i formati, senza dipendenze aggiuntive. Rimosso il vecchio generatore Python della lettera p; logo incluso nella configurazione di precache PWA.
- Verificato: build e typecheck superati; controlli mirati nel browser su caricamento SVG, sostituzione della scritta e assenza di overflow a 390/1440 px. Ispezione visiva delle icone e delle intestazioni. Nessun test funzionale aggiunto per questa modifica grafica.
- Prossimo passo: proseguire con il feedback dell'utente sul layout; restano invariati i limiti di persistenza e PWA documentati nelle voci precedenti.
