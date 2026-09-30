# Corpus di valutazione, task 25

40 casi pubblicabili, tutti inventati e annotati rispetto alla fonte: 26 scheda,
14 dieta; 29 sviluppo e 11 held-out. Ci sono 21 documenti normalizzati distinti:
le varianti di errore condividono una fonte, non sono 40 documenti indipendenti.
Questo corpus piccolo e sbilanciato non garantisce rappresentatività dei file reali.

`manifest.json` è l'indice della valutazione, separato dal manifest dei contratti.
`documents/` contiene input, `goldens/` verità della fonte; `provider/evaluation/`
contiene registrazioni HTTP **sintetiche**. Nessun file E2E del task 24 è una verità
di qualità. Le 31 basi/varianti provengono dai golden annotati dei task 01/06;
nove fonti held-out sono aggiunte qui con valori scritti a mano. I golden della
fonte differiscono intenzionalmente dalle risposte sbagliate: ad esempio Crunch
45 secondi contro 90 della risposta, serie reali contro istruzione ostile,
seconda seduta PDF presente nella fonte contro risposta che la omette.

Per caso: `input`, `golden`, `family`, `split`, `tags`, `critical`, `labels`,
`expectedProblems`, `offlineExpectedValidation`, `offlineAttempts`, `annotation`.
Le labels hanno puntatore JSON, valore atteso, blocchi della fonte e policy di
avviso; quelle degli elementi identificano gli slot attesi. Il valore `null`
nelle labels numeriche significa mancante, mai zero. Quantità alimentari restano
testi interi con unità/crudo/cotto; non si convertono nutrizionalmente in grammi.
`expectedProblems` conserva mancanze/ambiguità della fonte; i problemi applicativi
precisi delle risposte registrate sono in `offlineExpectedValidation`.

Lo split è congelato prima degli esperimenti: varianti della stessa famiglia e
hash della fonte non possono attraversarlo. Non modificare il prompt in base agli
esiti held-out. Il trasporto riceve solo il documento, mai labels o golden.
Una modifica motivata alla verità richiede revisione umana rispetto alla fonte;
non ricavare golden dall'output di un modello. Nuovi esperimenti richiedono un
held-out indipendente se quello corrente è stato usato per adattare i prompt.

Le metriche restano separate:

- numeri/intervalli/quantità: uguaglianza dei valori, compresi null e unità;
- associazioni: nome/etichetta nella posizione gerarchica attesa e blocchi citati;
- condizioni: testo e ambito esatti, alternative/aggiunte/regole separate;
- omissioni: slot attesi assenti; riordini e spostamenti sono errori di associazione;
- elementi extra e discrepanze critiche: avviso pertinente per campo o copertura
  della fonte; un avviso generico di catalogo non nasconde un errore;
- rifiuti/incomplete/429/errori: esiti espliciti, nessuna bozza inventata;
- latenza totale e distribuzione, usage noto/mancante, costo cumulativo inclusi
  retry e riserve prudenti; reasoning è già nell'output e non si somma di nuovo;
- secondi di correzione: annotazioni manuali **stimate nello scenario sintetico**,
  non misure di un utente o modello reale.

Le comparazioni sono volutamente rigorose e sensibili all'ordine; parafrasi e
alternative strutturali richiedono controllo umano, non un punteggio unico di
confidence. Errori di categorie diverse possono contare lo stesso slot:
`criticalErrors` conta discrepanze di campo, non documenti errati.

```powershell
node scripts/import-evaluate.mjs --offline
```

Tre ripetizioni identiche per caso critico verificano la riproducibilità del
runner; non misurano la variabilità di un modello. `artifacts/import-evaluation/report.json`
è sintetico e rigenerabile (ignorato da git). PASS indica runner/adapter/validator
funzionanti; i gate reali sono OPEN anche se un particolare campione non mostra
errori. Alcune risposte introducono omissioni non segnalate proprio per provarne
lo scoring. Latenze, token e prezzi offline sono fittizi.

`real-config.example.json` è deliberatamente disabilitato, senza candidati,
prezzi o chiavi. Copiarlo solo in `private-imports/` quando ci sarà una distinta
autorizzazione alla spesa. Runbook: [supabase/IMPORT_EVALUATION.md](../../../../supabase/IMPORT_EVALUATION.md).
Documenti personali, risposte reali e report reali restano in `private-imports/`.
