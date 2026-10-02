# Idee per sistemare l'importazione dei Word

Stato al 01/10/2026, dopo la prova su `Scheda_Full_Body_Giuseppe.docx` con `reasoning low`.

## 1. Cosa è emerso dalla prova

- La chiamata ora finisce: 13.614 token input, 5.069 output, 154 reasoning, circa USD 0,004.
- Il Word ha 3 sedute (A, B, C) e 18 esercizi. Il modello ha estratto **solo la A** (6 esercizi).
  B e C risultano `section_not_covered`.
- Errori del modello:
  - `restSeconds` lasciato `null` quando il recupero è un intervallo ("90–120 s", "60–90 s").
  - RIR "2–3" segnalato come ambiguo invece di min 2 / max 3.
  - citazione di `restSeconds/min` per A6 senza valore scritto (`evidence_dangling_path`).
- Per costruzione dell'app (non sono errori):
  - un `catalog_choice_required` bloccante per ogni esercizio (18 su tutto il documento);
  - una regola complessa bloccante per ogni "terza facoltativa da S5" o "1 × … in S1–2; poi 2 × …".
- Rumore: 6 conferme `optional_sets_missing`, perché l'informazione è finita nelle regole.

I 25 punti sono quindi: 6 catalogo, 5 regole, 4 serie/recupero (errori), 6 serie facoltative,
2 sezioni non coperte, 1 RIR, 1 rotazione. Su tutto il documento sarebbero molti di più.

## 2. Ipotesi sulla causa principale

Il prompt chiede una citazione per ogni campo (circa 14 per esercizio, circa 80 per la sola seduta A).
Su 18 esercizi sarebbero più di 240 citazioni, e gran parte dell'output è evidence.
Con reasoning basso il modello ha probabilmente tagliato dopo la prima sezione.
**È un'ipotesi, non verificata.**

## 3. Idee, dalla meno invasiva

### A. Restare tutto col modello (mantiene la generalità)
1. Una chiamata per sezione (A, B, C). Il meccanismo dei segmenti c'è già (`segments.ts`) ma scatta
   solo se l'input supera il budget. Servirebbe una regola che divida anche prima, per esempio
   "più di N righe di tabella" o "più di N sezioni".
2. Citazioni per riga/cella invece che per campo. Riduce molto l'output. Va adattato il validatore
   delle evidence, quindi da valutare con cura.
3. Correggere nel prompt la regola sugli intervalli di recupero e RIR (min/max).
4. Dire al modello di mettere "terza facoltativa da S5" in `optionalSets` oltre che nella regola,
   così spariscono le 6 conferme.

### B. Revisione meno pesante
1. Azione "tutti nuovi" (o "tutti comuni") per l'associazione al catalogo.
2. Per regole del tipo "da S5" una sola conferma "conserva come istruzione", senza far riscrivere
   la scelta a mano per ogni regola.

### C. Ibrido generale (solo se A non basta)
Il modello legge intestazione e un paio di righe di ogni tabella e restituisce solo una mappa
delle colonne (nome, serie × ripetizioni, RIR, recupero, note). Il codice applica la mappa a tutte
le righe, con citazioni esatte alla cella. Funziona con qualsiasi layout; le celle non interpretabili
tornano al modello. Testo libero e PDF senza tabelle seguono il percorso attuale.
Non provato sul codice del progetto. Non è un parser fisso su un layout.

## 4. Prova con `gpt 6.1 sol`, effort medium

Prezzi indicati da te: input USD 2,00 / 1M token, output USD 10,00 / 1M token.
Il modello attuale, dal costo registrato (USD 0,003897 per 13.614 in + 5.069 out), sembra costare
circa USD 0,10 input e 0,50 output per milione. **Sol costerebbe circa 20 volte di più.**
(Stima mia dai dati, da confermare con i prezzi reali del modello attuale.)

### Costo stimato per analisi
| Scenario | Input | Output | Costo |
|---|---|---|---|
| Come la prova di oggi (solo seduta A) | 13.614 | 5.069 | circa USD 0,078 |
| Documento completo (3 sedute), output stimato 3× | circa 14.000 | circa 15.000 | circa USD 0,18 |
| Come sopra, con reasoning medium (+ token di reasoning nell'output) | circa 14.000 | 20.000 o più | USD 0,23 o più |

Il reasoning è conteggiato come output. Con effort medium potrebbe pesare molto più dei 154 token di oggi.

### Attenzione ai limiti del budget
- Tetto mensile per account: **USD 0,20**. Una sola analisi completa con sol potrebbe consumarlo tutto,
  o superarlo. Tetto mensile del progetto: USD 1.
- Il sistema prenota il costo **prima** della chiamata, in base al massimo di output token
  (`IMPORT_MAX_OUTPUT_TOKENS`, valore attuale non visibile: nei secrets c'è solo l'hash).
  Con USD 10/M, 20.000 token di output massimo = USD 0,20 di sola riserva: la chiamata verrebbe
  rifiutata per budget.
- Con effort medium il tempo di risposta aumenta. Il timeout del provider è ora 135 s (limite
  Supabase Free: 150 s).

### Cosa serve cambiare per provarlo (da fare insieme, nessuna modifica fatta)
1. Secret `IMPORT_MODEL` con il nome esatto del modello.
2. Secret `IMPORT_REASONING_EFFORT=medium` (oggi è `low`). Verificare che il livello sia accettato dal modello.
3. Tabella `peppitness_private.import_budget_config`:
   - `provider` e `model` uguali ai secrets, altrimenti l'endpoint si disattiva;
   - `input_micros_per_million = 2000000`, `output_micros_per_million = 10000000`;
   - `price_version` aggiornata, con URL e data della fonte dei prezzi;
   - `account_limit_micros` e `project_limit_micros` adeguati alla prova (decidi tu l'importo);
   - `max_output_tokens` coerente con `IMPORT_MAX_OUTPUT_TOKENS`.
4. Non serve nuovo deploy né cambio di `IMPORT_PROMPT_VERSION`. La cache considera il modello,
   quindi la prova non riusa le proposte vecchie.
5. Una sola analisi alla volta, su un solo file, e poi controllare i consumi nel dashboard OpenAI.
6. Dopo la prova ripristinare i tetti e il modello precedenti se non si decide di tenerli.

### Cosa guardare nel risultato
- B e C compaiono nell'estrazione? (la domanda principale)
- Gli intervalli di recupero e RIR sono compilati?
- Quanti punti restano da risolvere rispetto ai 25 di oggi?
- Latenza, token di reasoning e costo reale.

Se sol con medium risolve la completezza ma costa troppo, la strada A (una chiamata per sezione,
citazioni più leggere) con il modello economico resta l'alternativa da confrontare.

## 5. Da raccogliere prima di decidere

- Altri 2–3 Word/PDF di piani con layout diversi, per vedere dove le idee A e C reggono.
- Il valore attuale di `IMPORT_MAX_OUTPUT_TOKENS` (lo vedi tu nel dashboard, o lo imposti noto).
- Prezzi ufficiali e nome esatto del modello attuale, per confermare il confronto dei costi.
