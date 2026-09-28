/**
 * Versione del reader PDF, separata dal motore perché il client del worker la confronti senza
 * caricare PDF.js nel bundle principale. Cambia quando cambiano blocchi, ID o problemi prodotti
 * per lo stesso file (anche con un aggiornamento di PDF.js che cambi l'estrazione).
 */
export const PDF_READER_VERSION = 'peppitness.pdf-reader.v1'
