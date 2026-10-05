# Illustrazioni dei pasti

Sei illustrazioni vettoriali disegnate a mano in SVG (05/10): colazione, metà mattina,
pranzo, merenda, cena e un piatto neutro per i pasti personalizzati. Sostituiscono le
precedenti WebP generate con `image_gen`.

Stile flat senza contorni, coerente col logo (`public/logo.svg`): salvia `#8CC59F`,
verde `#5E9A73`, lime `#D9EF85`, più i colori naturali dei cibi. viewBox 64 × 64,
circa 1 KB ciascuna: Vite le incorpora nel bundle come `data:` URI (permesso dalla CSP
`img-src 'self' data:`), quindi sono disponibili offline senza voci di precache.

Le immagini identificano il momento del pasto: gli ingredienti illustrati sono
decorativi. Alimenti e quantità visualizzati provengono esclusivamente dal piano.
`MealImage` sceglie l'immagine dal nome e, in assenza di un nome riconoscibile,
dall'orario. Non introduce categorie o dosi nei dati salvati.
