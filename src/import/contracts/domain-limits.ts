/**
 * Inventario dei limiti del dominio attuale (baseline del 28/09, otto migration), ricavato da
 * src/domain/{programs,meal-plans,exercises}.ts e dai CHECK/trigger SQL. È la fonte unica dei
 * bounds per la validazione (06), i mapper (09/10) e i payload risolti di commit.ts: nessun clamp
 * né taglio, un valore oltre limite resta un problema visibile. Il test dei comandi lo confronta
 * con il dominio. Lunghezze in caratteri Unicode (code point), come `char_length` di PostgreSQL.
 */
import { refine, string, type Rule, type Schema } from './schema.ts'

export const domainLimits = {
  /** exercises / shared_exercises (20260926120000, 20260927230000), validateExercise. */
  exercise: { name: 120, variant: 120, equipment: 120, note: 4000 },
  /** workout_plans/versions/days/prescriptions (20260926130000, 20260927210000), programPayload. */
  workout: {
    title: 160, guidance: 16000, days: 50, prescriptionsPerDay: 200, dayLabel: 40, dayTitle: 160, dayNote: 4000, prescriptionNote: 4000,
    /** Interi. */
    sets: { min: 1, max: 1000 }, optionalSets: { min: 0, max: 1000 }, reps: { min: 1, max: 10000 },
    durationSeconds: { min: 1, max: 86400 }, restSeconds: { min: 0, max: 86400 },
    /** Decimali ammessi (numeric). */
    rir: { min: 0, max: 10 }, rpe: { min: 1, max: 10 },
    /** Entrambi presenti oppure entrambi null. */
    cycleWeeks: { min: 1, max: 52 }, cycleStart: { min: '2000-01-01', max: '2200-01-01' },
  },
  /** meal_plans + trigger validate_meal_plan (20260927190000), mealPlanLimits, MEAL_PLAN_MAX_BYTES. */
  diet: {
    name: 160, guidance: 16000, days: 14, mealsPerDay: 20, foodsPerMeal: 60, linesPerList: 30, lineChars: 500,
    dayName: 120, mealName: 120, mealTime: 60, note: 4000, foodName: 200, foodQuantity: 60,
    /** JSON compatto del documento in UTF-8, limite dell'editor; il database accetta 262.144 byte di jsonb testuale. */
    documentBytes: 180_000, databaseDocumentBytes: 262_144,
  },
} as const

/** Caratteri di controllo rifiutati da `valid_text` del database; tab e a capo restano ammessi. */
const DOMAIN_CONTROL = /[\u0001-\u0008\u000B\u000C\u000E-\u001F]/
const noControl: Rule<string> = {
  code: 'invalid_text', description: 'Nessun carattere di controllo tranne tab e a capo.',
  check(value, report) { if (DOMAIN_CONTROL.test(value)) report('', 'Carattere di controllo non ammesso dal database.') },
}
const notBlank: Rule<string> = {
  code: 'blank_text', description: 'Testo non vuoto dopo trim().',
  check(value, report) { if (value.trim() === '') report('', 'Il testo non può essere vuoto.') },
}
const trimmed: Rule<string> = {
  code: 'not_trimmed', description: 'Nessuno spazio iniziale o finale.',
  check(value, report) { if (value !== value.trim()) report('', 'Rimuovere gli spazi iniziali e finali prima della conferma.') },
}

/** Testo facoltativo del dominio: vuoto ammesso. */
export const domainText = (max: number): Schema<string> => refine(string({ maxLength: max }), [noControl])
/** Testo obbligatorio (righe di alternative/aggiunte, nomi alimento): non vuoto, spazi interni liberi. */
export const requiredDomainText = (max: number): Schema<string> => refine(string({ minLength: 1, maxLength: max }), [noControl, notBlank])
/** Nomi, titoli ed etichette: obbligatori e già senza spazi ai bordi, mai rifilati in silenzio. */
export const trimmedDomainText = (max: number): Schema<string> => refine(string({ minLength: 1, maxLength: max }), [noControl, notBlank, trimmed])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
/** Data di calendario reale `YYYY-MM-DD` entro [min, max], confronto lessicografico sulla forma canonica. */
export function isoDateSchema(min: string, max: string): Schema<string> {
  return refine(string({ minLength: 10, maxLength: 10, pattern: ISO_DATE }), [{
    code: 'invalid_date', description: `Data reale fra ${min} e ${max}.`,
    check(value, report) {
      const [year, month, day] = value.split('-').map(Number) as [number, number, number]
      const date = new Date(Date.UTC(year, month - 1, day))
      const real = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      if (!real) report('', 'Data inesistente.')
      else if (value < min || value > max) report('', `Data fuori dall’intervallo ${min} – ${max}.`)
    },
  }])
}
