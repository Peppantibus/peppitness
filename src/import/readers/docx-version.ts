/**
 * Versione del reader DOCX, separata dal motore perché il client del worker la confronti senza
 * caricare nel bundle principale il codice di lettura. Cambia quando cambiano blocchi, ID o
 * problemi prodotti per lo stesso file.
 */
export const DOCX_READER_VERSION = 'peppitness.docx-reader.v1'
