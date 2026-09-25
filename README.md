# peppitness

PWA personale per alimentazione e allenamento. Tema chiaro, verde bosco e lime, React, TypeScript strict e Vite. Le decisioni del progetto si trovano in [AGENT.md](AGENT.md).

## Stato al 25 settembre 2026

Prima interfaccia funzionante, **esclusivamente dimostrativa**. Tutti i contenuti sono inventati; non sono state lette o convertite le fonti personali della cartella superiore.

- Dieta e Scheda, calendario settimanale e selezione libera della data.
- Dettaglio pasti, alternative, note e stati Da registrare / Seguito / Modificato / Saltato.
- Selezione delle sedute e dettaglio esercizi; prova con carico, ripetizioni o secondi, completamento e ripresa mentre la pagina rimane aperta.
- Storico temporaneo delle prove, separato per data. Nessun ricalcolo delle prescrizioni.
- Carico e risultato precedenti accanto a ogni serie; card “Ultima volta” apribile con swipe a sinistra, pulsanti o frecce da tastiera. Confronto per esercizio, variante, attrezzo/macchina, convenzione di carico e modalità; nessun dato futuro usato come precedente.
- “Riprendi i carichi” riempie soltanto i carichi vuoti, senza segnare ripetizioni o completamenti.
- Timer recupero al completamento di una serie, con pausa, ripresa, +15 secondi e Salta. Scadenza assoluta in memoria e mantenimento durante la navigazione interna.
- Interfaccia per telefono e desktop, navigazione a tastiera, dialog, safe area e movimento ridotto.
- Manifest, icone locali, configurazione PWA e file Cloudflare Pages predisposti.

**Le modifiche restano in memoria nella pagina: ricaricare o chiudere azzera le registrazioni e il timer.** Su richiesta esplicita dell’utente sono stati rimossi dall’interfaccia badge, avvisi e testi relativi alla demo; i limiti restano documentati qui. Rimane l’avviso nativo del browser prima di abbandonare registrazioni, quando supportato. Non sono stati introdotti salvataggi online o persistenti.

Account, Supabase, RLS, editor dei piani, Dexie, coda offline, import/export e backup devono ancora essere implementati. Confronti e timer operano solo sulle registrazioni disponibili nella pagina aperta; nessuna promessa di suoni o notifiche a schermo bloccato. La cache dell’app e l’installazione PWA completa non sono ancora state verificate. Nessun servizio cloud è stato creato e nessun sito è stato pubblicato.

## Avvio

Ambiente verificato: Node **22.22.0**, npm **10.9.4**, Windows. Usare Node 22.12+ della linea 22 oppure una versione successiva compatibile, preferibilmente LTS.

```sh
npm ci
npm run dev
```

Aprire **http://127.0.0.1:5173**. Su PowerShell, se l’esecuzione di `npm.ps1` è bloccata, usare `npm.cmd` al posto di `npm`.

```sh
npm run typecheck
npm test
npm run build
npm run preview
```

L’anteprima della build è su **http://127.0.0.1:4173**. Il server è associato al loopback per impostazione predefinita. Per un controllo visivo da telefono sulla propria rete, `npm run dev -- --host 0.0.0.0`; non è una prova di installazione PWA, che richiede un contesto sicuro.

### Dipendenze e limitazione dell’ambiente iniziale

Il download da `registry.npmjs.org` è stato rifiutato dall’ambiente di esecuzione con `EACCES`. React 19.2.3, Vite 7.3.1, plugin React 5.1.2 e TypeScript 5.9.3 sono versioni stabili compatibili recuperate dalla cache disponibile, con lockfile generato da npm. **Non sono presentate come le ultime versioni disponibili.** Non è stato possibile eseguire un audit online o installare `vite-plugin-pwa`.

Per ripetere l’installazione offline in questa specifica cartella, dove è stata preparata una cache ignorata:

```sh
npm ci --offline --cache .npm-cache --no-audit --no-fund
```

La cache locale non è parte del progetto distribuibile. Su una nuova macchina usare `npm ci` con rete disponibile. Prima della pubblicazione controllare gli aggiornamenti di sicurezza e l’audit delle dipendenze.

I test di dominio usano provvisoriamente `node:test` con TypeScript nativo perché Vitest non è presente nella cache. Le verifiche sono eseguibili senza scaricare altre dipendenze; valutare il passaggio al runner previsto quando sarà disponibile. Su Windows arrestare i server Vite prima di `npm ci`, per evitare che l’eseguibile esbuild rimanga occupato.

## PWA: configurazione pronta, attivazione da completare

`public/manifest.webmanifest` e le icone PNG sono già inclusi nella build. Il service worker **non viene generato da `npm run build` in questo stato**. Non è stato sostituito il plugin previsto con una cache artigianale.

Quando npm è raggiungibile:

```sh
npm run setup:pwa
npm run build:pwa
npm run preview
```

`setup:pwa` installa `vite-plugin-pwa` come dipendenza di sviluppo e aggiorna il lockfile: verificare compatibilità con Vite e conservare entrambi i file aggiornati. `vite.pwa.config.mjs` estende la configurazione normale. L’app registra `/sw.js` solo in questa build; eventuali errori di registrazione vengono mostrati.

Il plugin è configurato per aggiornamenti su richiesta e precache dei soli asset dell’app. Nessuna cache di risposte Auth/API. L’interfaccia impedisce l’aggiornamento durante una seduta demo o un dettaglio aperto e avverte del reset delle prove. Questo codice di aggiornamento è **predisposto ma non collaudato con un service worker generato**. La futura coda offline richiederà controlli aggiuntivi sulle operazioni pendenti prima di consentire update e logout.

Provare installazione, riapertura offline, aggiornamento controllato e layout sulla PWA installata su iPhone prima di considerare conclusa questa parte.

Il marchio è un manubrio con viso e pizzetto, senza scritta, in `public/logo.svg`. Viene usato nella sidebar e nell’intestazione mobile; il nome peppitness rimane nel titolo dell’app e nelle etichette accessibili. Dopo aver avviato il browser Chrome dedicato descritto sotto, `npm run icons` rigenera favicon e icone PNG da questa singola sorgente SVG, mantenendo il disegno nell’area sicura maskable. Nessuna libreria o richiesta esterna necessaria.

## Organizzazione

```text
src/
  components/       struttura, calendario, icone, dialog e prompt PWA
  domain/           tipi, date Europe/Rome e validazione dei numeri
  data/demo.ts      soli contenuti inventati
  features/         dieta, scheda, storico e impostazioni
  persistence/      adattatore demo in memoria, da affiancare al vero archivio
tests/              logica di date, numeri, snapshot e idempotenza demo
scripts/            verifica browser e generazione icone
public/             soli asset pubblicabili, manifest e configurazione Pages
```

La navigazione iniziale usa hash URL (`/#/dieta`, `/#/scheda`, `/#/scheda/storico`) e supporta indietro/avanti. Nessuna libreria di routing aggiunta in questa fase. L’adattatore demo non è un’alternativa locale all’architettura Supabase/Dexie prevista: serve solo alla prima interfaccia.

## Verifiche browser riproducibili

Gli smoke test usano il Chrome DevTools Protocol con il WebSocket integrato in Node, senza dipendenze di test browser. Avviare `npm run preview -- --port 4173 --strictPort` in un terminale. Avviare poi una **istanza Chrome dedicata**, con un profilo di test dentro il progetto:

```powershell
$testProfile = Join-Path (Get-Location).Path '.browser-profile'
Start-Process -FilePath 'C:\Program Files\Google\Chrome\Application\chrome.exe' -WindowStyle Hidden -ArgumentList @('--headless=new', '--remote-debugging-port=9223', '--remote-debugging-address=127.0.0.1', "--user-data-dir=$testProfile", '--no-first-run', '--disable-background-networking', 'about:blank')
npm.cmd run test:browser
```

Non usare il proprio profilo Chrome quotidiano e tenere il debugger sul loopback. Nell’ambiente sandbox iniziale Chrome ha richiesto `--no-sandbox --disable-gpu` per avviarsi; questo workaround è stato limitato al browser di test locale con dati demo, non è necessario nel normale ambiente desktop. Chiudere l’istanza dedicata dopo le prove.

`TEST_BASE_URL` e `TEST_DEBUG_URL` permettono di cambiare indirizzi. I test generano screenshot e un rapporto in `artifacts/`, ignorata. Il resoconto delle verifiche effettive è in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Configurazione cloud successiva

`.env.example` contiene soltanto segnaposto pubblici. In questa fase non è necessario copiarlo e le variabili Supabase non vengono usate. **Compilarle non attiva un login o un salvataggio.** Mai aggiungere service role, password, token amministrativi o chiavi segrete alle variabili `VITE_`.

La prossima fase definisce schema, versionamento, grants, RLS e prove con due utenti. Poi gli editor, il diario persistente, Auth, sincronizzazione e backup. Non invitare account reali prima delle prove previste da AGENT.md.

## Cloudflare Pages

Configurazione predisposta, nessun deploy effettuato:

- Root: cartella `peppitness`.
- Comando attuale: `npm run build`; dopo il collaudo PWA: `npm run build:pwa`.
- Output: **solo `dist`**.
- `_redirects` include il fallback SPA; `_headers` contiene header e CSP per l’attuale demo senza richieste esterne.

Quando verrà collegato Supabase, aggiungere alla CSP soltanto l’origine HTTPS effettiva del progetto e le origini strettamente necessarie; non aprire tutte le connessioni. Controllare header effettivi, rotte dirette e URL Auth sul sito distribuito: Vite preview non simula gli header Cloudflare.

Documenti personali, `private-imports`, backup, `.env`, test e AGENT.md non sono nel bundle di produzione. `.gitignore` esclude importazioni private, backup, cache, artefatti di test e credenziali locali. I documenti nella cartella Fitness non vanno pubblicati.

Riferimenti tecnici consultati per questa fase: [Vite](https://vite.dev/guide/), [Vite PWA](https://vite-pwa-org.netlify.app/guide/), [aggiornamenti PWA su richiesta](https://vite-pwa-org.netlify.app/guide/prompt-for-update.html), [Cloudflare Pages e React](https://developers.cloudflare.com/pages/framework-guides/deploy-a-react-site/).
