# peppitness

**Allenamento, alimentazione e progressi in un posto solo.**

PWA mobile-first per seguire una scheda di allenamento e un piano alimentare giorno per giorno: la seduta di oggi, le serie da completare, il recupero e i pasti della giornata.

<p align="center">
  <img src=".github/readme/landing.png" width="200" alt="Pagina di benvenuto">
  <img src=".github/readme/scheda.png" width="200" alt="La scheda del giorno">
  <img src=".github/readme/seduta.png" width="200" alt="Seduta in corso con timer di recupero">
  <img src=".github/readme/riepilogo.png" width="200" alt="Riepilogo con record personale">
</p>

## Funzionalità

- **Allenamento**: programmi a cicli settimanali, serie e carichi registrati durante la seduta, timer di recupero con avviso, record personali e riepilogo a fine allenamento.
- **Alimentazione**: piano con periodo di validità, calorie stimate dagli alimenti e diario dei pasti.
- **Progressi**: costanza settimanale e andamento di ogni esercizio.
- **Fine programma.** Alla scadenza puoi estendere il ciclo o chiuderlo per salvare il Wrapped in **Storico → Passati**. Puoi creare il ciclo successivo da zero o ripartire dalla struttura del precedente.
- **Importazione**: scheda e dieta da due modelli Word strutturati, letti sul dispositivo e confermati con un'anteprima modificabile.
- **Offline**: le registrazioni restano sul telefono e si sincronizzano quando torna la rete.

## Stack

- **Frontend**: React 19 + TypeScript, build con [Vite](https://vite.dev) e installabile come PWA (`vite-plugin-pwa`).
- **Backend**: [Supabase](https://supabase.com): Postgres con Row Level Security su ogni tabella, Auth e RPC atomiche per i salvataggi.

## Sicurezza

- **Autenticazione a due fattori** (TOTP con app di autenticazione). Quando è attiva, non la controlla solo l'interfaccia: le policy del database richiedono una sessione `aal2`.
- Ogni account vede solo i propri dati, garantito dalle policy RLS.
- Accesso su invito: niente registrazioni pubbliche.

## Backup automatici

Il piano Free di Supabase non include backup, quindi li fa una [GitHub Action](.github/workflows/backup.yml) ogni notte:

1. dump di schema e dati, in sola lettura;
2. prova di ripristino in un Postgres effimero in Docker, con confronto di hash e conteggi delle righe;
3. archivio cifrato con [age](https://age-encryption.org) (la chiave privata non lascia il mio PC) e conservato 30 giorni come artifact.

## Sviluppo

```bash
npm ci
cp .env.example .env   # URL e chiave pubblica del progetto Supabase
npm run dev        # server di sviluppo
npm test           # test unitari
npm run build:pwa  # build di produzione della PWA
```

### Come nasce la panoramica del Wrapped

Il riepilogo usa la durata salvata nel programma e le sue sedute concluse. Per ogni gruppo confronta carichi a parità di ripetizioni o ripetizioni allo stesso carico. Dà precedenza a una progressione in cui almeno due settimane superano il valore iniziale, poi alla stabilità, alle variazioni e ai picchi isolati. A parità di esito valuta la presenza di serie a inizio e fine, il numero di fasi coperte, le settimane di conferma, le settimane e le sedute confrontabili e l’intervallo tra i due estremi. In caso di ulteriore parità ordina per nome e identificativo dell’esercizio.

Mostra fino a tre serie registrate. La serie centrale deve cadere vicino a metà ciclo. Cerca il miglior risultato confrontabile nelle ultime tre settimane e, se lì mancano serie utili, usa l’ultima serie confrontabile. Se ha solo un risultato utile per un gruppo, mostra quella serie con la sua settimana. Le sedute di prova e le serie registrate su un macchinario diverso restano nello Storico e nei totali.

Per riprodurre il collaudo con account sintetici, avvia Supabase in locale con le migrazioni applicate ed esegui `npm run test:workout-history:local`. Il test apre Chrome e verifica la chiusura, l’estensione, il Wrapped salvato, la copia del programma e l’allenamento libero prima del ciclo successivo.
