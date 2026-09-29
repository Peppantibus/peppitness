/**
 * Compatibilità con i limiti del dominio attuale (ultimo passo della validazione). I numeri vengono da
 * `domainLimits` (contratto 02, già confrontato con il dominio e con i CHECK SQL): nessun valore viene
 * limitato, arrotondato o troncato, ogni superamento resta un problema bloccante visibile.
 *
 * I testi che il mapping (09/10) unirà in un solo campo del dominio (indicazioni + regole, note
 * dell'esercizio + istruzioni di carico/tempo, note del pasto + note degli alimenti) sono controllati su
 * un limite inferiore: la loro unione con un a capo. Il mapper verifica poi la proiezione esatta.
 * Lunghezze in code point come `char_length` di PostgreSQL; la dieta ha anche un limite in byte UTF-8.
 */
import { domainLimits, domainText, validate } from '../contracts/index.ts'
import { finding, isRangeValue, type RuleItem, type ValidationFinding } from './issues.ts'

type Bounds = { readonly min: number; readonly max: number }
const texts = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
const text = (value: unknown): string | null => typeof value === 'string' ? value : null
const joined = (...parts: (string | null | string[])[]) => parts.flat().filter((part): part is string => part !== null && part !== '').join('\n')

function textLimit(out: ValidationFinding[], item: RuleItem, field: string, value: string | null, max: number, label: string) {
  if (value === null) return
  const result = validate(domainText(max), value)
  if (result.ok) return
  const tooLong = result.errors.some(error => error.code === 'too_long')
  out.push(tooLong
    ? finding('text_too_long', item, field, `${label}: ${[...value].length} caratteri, il limite è ${max}.`)
    : finding('text_invalid', item, field, `${label}: contiene caratteri di controllo non ammessi.`))
}

function countLimit(out: ValidationFinding[], item: RuleItem, count: number, max: number, label: string) {
  if (count > max) out.push(finding('too_many_items', item, null, `${label}: ${count}, il limite è ${max}.`))
}

function numberLimit(out: ValidationFinding[], item: RuleItem, field: string, value: unknown, bounds: Bounds, integer: boolean, label: string, path?: string) {
  const numbers = typeof value === 'number' ? [value] : isRangeValue(value) ? [value.min, value.max] : []
  if (integer && numbers.some(number => !Number.isInteger(number))) {
    out.push(finding('value_not_integer', item, field, `${label}: serve un numero intero, trovato ${numbers.join('–')}.`, { path }))
    return
  }
  if (numbers.some(number => number < bounds.min || number > bounds.max)) {
    out.push(finding('value_out_of_bounds', item, field, `${label}: ${numbers.join('–')} fuori dall’intervallo ${bounds.min}–${bounds.max}.`, { path }))
  }
}

const utf8 = (value: string) => new TextEncoder().encode(value).length

/** Limiti di un elemento della scheda; `children` = numero di figli diretti per collezione. */
export function workoutLimitFindings(item: RuleItem, children: { sessions: number; exercises: number; rules: string[] }): ValidationFinding[] {
  const limits = domainLimits.workout
  const out: ValidationFinding[] = []
  const v = item.values
  switch (item.collection) {
    case 'root': {
      textLimit(out, item, 'title', text(v.title), limits.title, 'Nome della scheda')
      textLimit(out, item, 'guidance', joined(texts(v.guidance), children.rules), limits.guidance, 'Indicazioni generali e regole')
      countLimit(out, item, children.sessions, limits.days, 'Sedute')
      const cycle = v.cycle as { weeks: number | null } | undefined
      if (cycle && cycle.weeks !== null) numberLimit(out, item, 'cycle', cycle.weeks, limits.cycleWeeks, true, 'Settimane del ciclo', item.pointer === null ? undefined : `${item.pointer}/cycle/weeks`)
      break
    }
    case 'sessions':
      textLimit(out, item, 'label', text(v.label), limits.dayLabel, 'Etichetta della seduta')
      textLimit(out, item, 'title', text(v.title), limits.dayTitle, 'Titolo della seduta')
      textLimit(out, item, 'notes', joined(texts(v.notes)), limits.dayNote, 'Note della seduta')
      countLimit(out, item, children.exercises, limits.prescriptionsPerDay, 'Esercizi della seduta')
      break
    case 'exercises': {
      const exercise = domainLimits.exercise
      textLimit(out, item, 'name', text(v.name), exercise.name, 'Nome dell’esercizio')
      textLimit(out, item, 'variant', text(v.variant), exercise.variant, 'Variante')
      textLimit(out, item, 'equipment', text(v.equipment), exercise.equipment, 'Attrezzo')
      textLimit(out, item, 'notes', joined(text(v.loadInstruction), text(v.tempoInstruction), texts(v.notes)), limits.prescriptionNote, 'Note, carico e tempo dell’esercizio')
      numberLimit(out, item, 'sets', v.sets, limits.sets, true, 'Serie')
      numberLimit(out, item, 'optionalSets', v.optionalSets, limits.optionalSets, true, 'Serie facoltative')
      numberLimit(out, item, 'repetitions', v.repetitions, limits.reps, true, 'Ripetizioni')
      numberLimit(out, item, 'durationSeconds', v.durationSeconds, limits.durationSeconds, true, 'Durata in secondi')
      numberLimit(out, item, 'restSeconds', v.restSeconds, limits.restSeconds, true, 'Recupero in secondi')
      numberLimit(out, item, 'rir', v.rir, limits.rir, false, 'RIR')
      numberLimit(out, item, 'rpe', v.rpe, limits.rpe, false, 'RPE')
      break
    }
    case 'complexRules':
      break
    default:
      break
  }
  return out
}

/** Limiti di un elemento della dieta; `children` = numero di figli diretti e testi delle regole globali. */
export function dietLimitFindings(item: RuleItem, children: { days: number; meals: number; foods: number; rules: string[]; foodNotes: string[] }): ValidationFinding[] {
  const limits = domainLimits.diet
  const out: ValidationFinding[] = []
  const v = item.values
  switch (item.collection) {
    case 'root':
      textLimit(out, item, 'title', text(v.title), limits.name, 'Nome del piano')
      textLimit(out, item, 'guidance', joined(texts(v.guidance), children.rules), limits.guidance, 'Indicazioni generali e regole')
      countLimit(out, item, children.days, limits.days, 'Giornate')
      break
    case 'days':
      textLimit(out, item, 'name', text(v.name), limits.dayName, 'Nome della giornata')
      textLimit(out, item, 'notes', joined(texts(v.notes)), limits.note, 'Note della giornata')
      countLimit(out, item, children.meals, limits.mealsPerDay, 'Pasti della giornata')
      break
    case 'meals': {
      textLimit(out, item, 'name', text(v.name), limits.mealName, 'Nome del pasto')
      textLimit(out, item, 'timeText', text(v.timeText), limits.mealTime, 'Orario del pasto')
      textLimit(out, item, 'notes', joined(texts(v.notes), children.foodNotes), limits.note, 'Note del pasto e degli alimenti')
      countLimit(out, item, children.foods, limits.foodsPerMeal, 'Alimenti del pasto')
      for (const field of ['alternatives', 'additions'] as const) {
        const lines = texts(v[field])
        const label = field === 'alternatives' ? 'Alternative' : 'Aggiunte'
        if (lines.length > limits.linesPerList) out.push(finding('too_many_items', item, field, `${label}: ${lines.length} righe, il limite è ${limits.linesPerList}.`))
        lines.forEach((line, index) => {
          const path = item.pointer === null ? undefined : `${item.pointer}/${field}/${index}`
          if (line.trim() === '') out.push(finding('text_invalid', item, field, `${label}: riga ${index + 1} vuota.`, { path }))
          else if ([...line].length > limits.lineChars) out.push(finding('text_too_long', item, field, `${label}: riga ${index + 1} di ${[...line].length} caratteri, il limite è ${limits.lineChars}.`, { path }))
          else if (!validate(domainText(limits.lineChars), line).ok) out.push(finding('text_invalid', item, field, `${label}: riga ${index + 1} con caratteri di controllo.`, { path }))
        })
      }
      break
    }
    case 'foods':
      textLimit(out, item, 'name', text(v.name), limits.foodName, 'Nome dell’alimento')
      textLimit(out, item, 'quantityText', text(v.quantityText), limits.foodQuantity, 'Quantità')
      break
    default:
      break
  }
  return out
}

/**
 * Limite inferiore dei byte del documento dieta: somma dei byte UTF-8 dei testi che finiranno in
 * `meal_plans.document`. Se già questo supera il limite dell'editor, il piano non è salvabile.
 */
export function dietDocumentBytesFinding(root: RuleItem, items: readonly RuleItem[]): ValidationFinding | null {
  let bytes = 0
  for (const item of items) {
    if (item.collection === 'root') continue
    if (item.collection === 'globalRules') { bytes += utf8(text(item.values.text) ?? ''); continue }
    for (const value of Object.values(item.values)) {
      if (typeof value === 'string') bytes += utf8(value)
      else if (Array.isArray(value)) for (const entry of value) if (typeof entry === 'string') bytes += utf8(entry)
    }
  }
  for (const entry of texts(root.values.guidance)) bytes += utf8(entry)
  const max = domainLimits.diet.documentBytes
  return bytes > max ? finding('document_too_large', root, null, `Il testo del piano occupa almeno ${bytes} byte: il limite del documento è ${max}.`) : null
}
