# Illustrazioni dei gruppi muscolari

Generate con lo strumento integrato `image_gen` di Codex per peppitness.
Manichini e simboli stilizzati verde bosco/lime, senza anatomia realistica,
testo o sfondi. WebP trasparenti a 192 × 192 pixel (qualità 0,9, `npm run images:webp` dai PNG); gli originali
rimangono nella cartella di generazione di Codex. Prompt completi in
[prompts.json](prompts.json).

| Categoria | File |
| --- | --- |
| Petto | chest.webp |
| Schiena | back.webp |
| Spalle | shoulders.webp |
| Bicipiti | biceps.webp |
| Tricipiti | triceps.webp |
| Gambe | legs.webp |
| Glutei | glutes.webp |
| Polpacci | calves.webp |
| Addome | abs.webp |
| Full body | full-body.webp |
| Cardio | cardio.webp |
| Da classificare | unclassified.webp |

`MuscleGroupImage` centralizza la scelta usando il gruppo dell'esercizio:
`null` usa il simbolo neutro; gli snapshot precedenti senza campo mantengono
il riconoscimento già previsto dal dominio. Nome e badge testuale adiacenti
restano accessibili; le immagini sono decorative. Importate da Vite, ricevono
nomi con hash e vengono incluse nel precache della build PWA (estensione webp inclusa in `vite.pwa.config.mjs`).
