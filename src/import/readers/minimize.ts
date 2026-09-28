/**
 * Minimizzazione deterministica dei dati di contatto nel testo dei blocchi (specifica §4.4),
 * comune ai reader DOCX e PDF. Si applica al testo canonico prima che diventi un blocco: il
 * NormalizedDocument, l'unico destinato al server, non contiene mai questi identificativi.
 *
 * Solo forme riconoscibili senza ambiguità: indirizzi email, telefoni con etichetta o prefisso
 * internazionale, cellulari italiani a 10 cifre, codici fiscali, partite IVA con etichetta.
 * Nessuna cancellazione generica dei numeri: serie, ripetizioni, grammature, orari, date e
 * calorie restano intatti, come nomi, note e annotazioni che possono cambiare la prescrizione.
 * Nomi e indirizzi postali non sono rimossi: nessuna regola deterministica li distingue in modo
 * affidabile dal contenuto del piano. Cambiare le regole richiede una nuova versione del reader.
 */
import { normalizeSourceText } from '../contracts/normalized-document.ts'

export const CONTACT_MINIMIZATION_VERSION = 'peppitness.contact-minimization.v1'

export interface ContactRule { id: string; placeholder: string; description: string; pattern: RegExp; minDigits?: number }

const digits = (text: string) => text.replace(/\D/g, '').length

/** Regole in ordine di applicazione; i segnaposto non sono mai riconosciuti dalle regole successive. */
export const contactMinimizationRules: readonly ContactRule[] = [
  {
    id: 'email',
    placeholder: '[email]',
    description: 'Indirizzo email (anche preceduto da mailto:).',
    pattern: /(?:mailto:)?(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}])/gu,
  },
  {
    id: 'vat_number',
    placeholder: '[partita IVA]',
    description: 'Partita IVA con etichetta (P.IVA, Partita IVA, VAT) seguita da 11 cifre.',
    pattern: /(?<![\p{L}\p{N}])(?:P\.?\s?IVA|Partita\s+IVA|VAT(?:\s+(?:no\.?|number))?)\s*[:.]?\s*(?:IT\s?)?\d{11}(?![\p{N}])/giu,
  },
  {
    id: 'tax_code',
    placeholder: '[codice fiscale]',
    description: 'Codice fiscale italiano di persona fisica (16 caratteri).',
    pattern: /(?<![\p{L}\p{N}])[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z](?![\p{L}\p{N}])/giu,
  },
  {
    id: 'labeled_phone',
    placeholder: '[telefono]',
    description: 'Numero con etichetta (tel, telefono, cell, cellulare, mobile, phone, whatsapp, fax) e almeno 8 cifre.',
    pattern: /(?<![\p{L}\p{N}])(?:tel(?:efono)?|cell(?:ulare)?|mobile|phone|whatsapp|fax)\.?\s*[:.]?\s*\+?\d[\d ./-]*\d(?![\p{N}])/giu,
    minDigits: 8,
  },
  {
    id: 'international_phone',
    placeholder: '[telefono]',
    description: 'Numero con prefisso internazionale (+ o 00) e almeno 8 cifre.',
    pattern: /(?<![\p{L}\p{N}+])(?:\+|00)\d{1,3}(?:[ ./-]?\d){6,12}(?![\p{N}])/gu,
    minDigits: 8,
  },
  {
    id: 'italian_mobile',
    placeholder: '[telefono]',
    description: 'Cellulare italiano di 10 cifre che inizia con 3 (333 1234567, 333 123 4567, 3331234567).',
    pattern: /(?<![\p{L}\p{N}.,/:-])3\d{2}(?:[ .-]?\d{7}|[ .-]\d{3}[ .-]\d{4})(?![\p{L}\p{N}]|[.,/:-]\d)/gu,
  },
]

export interface MinimizedText { text: string; replaced: number }

/** Sostituisce i dati di contatto con segnaposto; il risultato resta testo canonico. */
export function minimizeContactData(text: string): MinimizedText {
  let replaced = 0
  let result = text
  for (const rule of contactMinimizationRules) {
    result = result.replace(rule.pattern, match => {
      if (rule.minDigits !== undefined && digits(match) < rule.minDigits) return match
      replaced++
      return rule.placeholder
    })
  }
  return replaced ? { text: normalizeSourceText(result), replaced } : { text, replaced: 0 }
}
