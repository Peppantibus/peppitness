# Illustrazioni dei gruppi muscolari

Generate con lo strumento integrato `image_gen` di Codex per peppitness.
Manichini e simboli stilizzati verde bosco/lime, senza anatomia realistica,
testo o sfondi. PNG trasparenti ottimizzati a 192 × 192 pixel; gli originali
rimangono nella cartella di generazione di Codex. Prompt completi in
[prompts.json](prompts.json).

| Categoria | File |
| --- | --- |
| Petto | chest.png |
| Schiena | back.png |
| Spalle | shoulders.png |
| Bicipiti | biceps.png |
| Tricipiti | triceps.png |
| Gambe | legs.png |
| Glutei | glutes.png |
| Polpacci | calves.png |
| Addome | abs.png |
| Full body | full-body.png |
| Cardio | cardio.png |
| Da classificare | unclassified.png |

`MuscleGroupImage` centralizza la scelta usando il gruppo dell'esercizio:
`null` usa il simbolo neutro; gli snapshot precedenti senza campo mantengono
il riconoscimento già previsto dal dominio. Nome e badge testuale adiacenti
restano accessibili; le immagini sono decorative. Importate da Vite, ricevono
nomi con hash e vengono incluse nel precache PNG della build PWA.
