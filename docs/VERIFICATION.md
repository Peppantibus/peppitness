# Verifiche della prima interfaccia

Data: 25 settembre 2026. Ambiente: Windows, Node 22.22.0, npm 10.9.4, Chrome headless locale tramite DevTools Protocol. Dati esclusivamente dimostrativi.

## Eseguite

- Installazione offline delle dipendenze dalla cache disponibile e generazione di `package-lock.json`.
- Reinstallazione riproducibile con `npm ci --offline --cache .npm-cache --no-audit --no-fund`, seguita da build e test: superata. Il primo tentativo con preview ancora attiva ha incontrato un lock Windows su esbuild; risolto arrestando quel server.
- `npm run typecheck`: superato, TypeScript strict e noUncheckedIndexedAccess.
- `npm run build`: superato, SPA statica in `dist`.
- `npm test`: 15 test superati su giorno italiano vicino a mezzanotte, ora legale, date invalide, decimali italiani, distinzione zero/vuoto, serie a tempo, separazione delle date, snapshot, avvio idempotente, precedenti comparabili, copia dei carichi e scadenza del recupero.
- `npm run test:browser`: superato sul build di produzione, dimensioni 320, 390, 768 e 1440 px senza overflow orizzontale per Dieta, Scheda e seduta con timer.
- Navigazione, dettaglio pasti, chiusura dialog con Escape, stati e note, modifica di ieri senza alterare oggi, storico giornaliero.
- Dettaglio esercizio, blocco completamento di una serie vuota, carico con virgola, completamento serie, ripresa della seduta dopo cambio data, consultazione della seduta terminata.
- Regressione richiesta dall’utente: completamento di un allenamento con 12,5 kg × 10, avvio una settimana dopo, precedente visibile con data, copia del solo carico mantenendo ripetizioni vuote e serie non completata.
- Apertura di “Ultima volta” mediante pulsante e gesto touch reale simulato tramite CDP; ritorno alla registrazione. Precedente basato su ID e contesto comparabile, anche tra sedute diverse; test di esclusione per varianti/macchine/convenzioni differenti, futuro e serie non eseguite.
- Recupero visibile dopo Fatto, pausa verificata, +15 secondi, ripresa, mantenimento nella navigazione e scadenza provata spostando l’orologio del browser, senza aspettare un minuto reale. Test di annullamento del timer riaprendo la serie e nessun riavvio per completamenti ripetuti.
- Nessun testo demo/anteprima mostrato sulle schermate principali e impostazioni, come richiesto dall’utente; dati e persistenza rimangono quelli del prototipo in memoria.
- Avviso di rete assente e navigazione della pagina già caricata offline. **Non è una verifica della riapertura offline.**
- Reset delle prove al reload, con avviso beforeunload quando permesso dal browser; nessuna persistenza dichiarata.
- Nessun errore runtime/console e nessuna richiesta HTTP esterna rilevata dalla pagina durante il flusso verificato.
- Screenshot desktop e mobile ispezionati. Icone PNG locali generate in 180, 192 e 512 px.
- Ispezione di `dist`: solo HTML, JavaScript, CSS, icone, manifest, `_headers` e `_redirects`. Nessuna corrispondenza ai nomi delle fonti personali o a marker di chiavi privilegiate cercati nei file distribuiti. Non è una certificazione generale di assenza di segreti.

Report e screenshot rigenerabili in `artifacts/`, cartella ignorata e non pubblicata.

## Limiti e controlli da completare

- `vite-plugin-pwa` non disponibile nella cache e download npm bloccato (`EACCES`): build PWA, registrazione service worker, update e precache non eseguiti. Sono presenti configurazione e comandi per completarli con rete disponibile.
- Nessun test di API, SQL, RLS o isolamento reale tra account: schema, database e login non sono ancora implementati. I test del mock non sono prove di autorizzazione.
- Nessuna prova di sincronizzazione, storage persistente, backup o ripristino: funzionalità previste nelle fasi successive.
- Nessun iPhone fisico, Safari iOS o PWA installata collaudati; da verificare tastiera, VoiceOver, ingrandimento testo, focus, safe area, primo avvio e riapertura offline.
- Header, CSP, fallback e HTTPS di Cloudflare Pages predisposti ma non provati su un deployment.
- Audit npm online e disponibilità delle versioni più recenti non verificabili dal terminale senza rete. Le versioni installate sono quelle stabili compatibili presenti nella cache iniziale.

Il risultato verificato è una **prima interfaccia demo**, non un diario utilizzabile per conservare dati reali.
