/**
 * Regole della dieta (specifica §§6.2, 7.3, 7.5). Come per la scheda, due famiglie:
 * - `dietRuleFindings`: requisiti del dominio sui valori correnti. Quantità mancante = conferma del
 *   vuoto, mai una quantità inventata; tipo di giornata ignoto ≠ `any`; orario assente solo informativo;
 *   una regola globale ripetuta in un pasto è una duplicazione;
 * - `dietSourceFindings`: ambito delle citazioni sulla proposta immutabile. Un alimento citato dentro
 *   un'alternativa («pasta oppure riso») o dentro un'aggiunta condizionata non è un alimento del pasto
 *   base; una regola sopra la giornata non appartiene a un pasto; «Giorno 1» non è un giorno di palestra.
 *
 * Ambito di un pasto (euristica dichiarata): i blocchi che citano il suo nome con la loro riga, più i
 * blocchi successivi fino al nome del pasto seguente. Alternative, aggiunte e note possono venire anche
 * da un paragrafo della stessa giornata che non appartiene a un altro pasto (per esempio «Opzione B
 * colazione» sotto la tabella).
 */
import { normalizeSourceText, type ExtractedDietRule, type SourceBlock } from '../contracts/index.ts'
import { groupSpans, type SourceIndex, type UnitEvidence, type VerifiedSpan } from './evidence.ts'
import { finding, hasText, type RuleItem, type ValidationFinding } from './issues.ts'
import type { FieldOrigin } from './workout.ts'

const fold = (value: string) => normalizeSourceText(value).toLocaleLowerCase('it')

export function dietRuleFindings(items: readonly RuleItem[], children: (key: string, collection: string) => RuleItem[]): ValidationFinding[] {
  const out: ValidationFinding[] = []
  const root = items.find(item => item.collection === 'root')
  if (!root) return out
  if (!hasText(root.values.title)) out.push(finding('title_missing', root, 'title', 'Manca il nome del piano.'))
  const days = children(root.key, 'days')
  if (!days.length) out.push(finding('no_days', root, null, 'La proposta non contiene giornate.'))
  const globalTexts = new Set(children(root.key, 'globalRules').map(rule => fold(String(rule.values.text ?? ''))).filter(Boolean))

  for (const day of days) {
    if (!hasText(day.values.name)) out.push(finding('day_name_missing', day, 'name', 'Manca il nome della giornata.'))
    if (day.values.dayType === null) out.push(finding('day_type_missing', day, 'dayType', 'Indicare se la giornata vale per l’allenamento, il riposo o qualsiasi giorno.'))
    const meals = children(day.key, 'meals')
    if (!meals.length) out.push(finding('day_without_meals', day, null, 'La giornata non ha pasti.'))
    for (const meal of meals) {
      if (!hasText(meal.values.name)) out.push(finding('meal_name_missing', meal, 'name', 'Manca il nome del pasto.'))
      if (meal.values.timeText === null) out.push(finding('meal_time_missing', meal, 'timeText', 'Orario non indicato.'))
      for (const field of ['alternatives', 'additions'] as const) {
        const lines = meal.values[field] as string[]
        lines.forEach((line, index) => {
          if (globalTexts.has(fold(line))) out.push(finding('global_rule_in_meal', meal, field, 'Questa riga è già una regola generale del piano: va riportata una sola volta.', { path: meal.pointer === null ? undefined : `${meal.pointer}/${field}/${index}` }))
        })
      }
      for (const food of children(meal.key, 'foods')) {
        if (!hasText(food.values.name)) out.push(finding('food_name_missing', food, 'name', 'Manca il nome dell’alimento.'))
        if (food.values.quantityText === null) out.push(finding('food_quantity_missing', food, 'quantityText', 'Quantità non indicata: confermare il campo vuoto o scriverla, senza completarla.'))
      }
    }
  }
  return out
}

export interface DietSourceInput {
  index: SourceIndex
  items: readonly RuleItem[]
  children: (key: string, collection: string) => RuleItem[]
  evidence: ReadonlyMap<string, UnitEvidence>
}

const TRAINING = /allenament|palestra|training|workout|\bON\b/i
const REST = /riposo|\brest\b|\bOFF\b/i
const ANY = /qualsiasi|ogni giorno|tutti i giorni|indifferente/i
const dayTypePatterns = { training: TRAINING, rest: REST, any: ANY } as const

interface Region { blockId: string; start: number; end: number }
const regionsOf = (spans: readonly VerifiedSpan[]): Region[] => spans.flatMap(span => span.offsets.map(offset => ({ blockId: span.blockId, start: offset, end: offset + span.quote.length })))
/**
 * Una frase completa può citare il cibo base insieme alla sostituzione fra parentesi:
 * «Yogurt 170 g (in alternativa latte 200 ml)». Solo la parentesi è un'alternativa.
 * Il restringimento richiede questa forma esplicita e chiusa; opzioni/alternative già
 * dichiarate prima della parentesi conservano l'intera regione, come i casi ambigui.
 */
function alternativeRegionsOf(spans: readonly VerifiedSpan[]): Region[] {
  return spans.flatMap(span => {
    const markers = [...span.quote.matchAll(/\(\s*in alternativa\b/giu)]
    if (markers.length !== 1 || markers[0]!.index === 0) return regionsOf([span])
    const start = markers[0]!.index!
    let depth = 1, end = start + 1
    for (; end < span.quote.length && depth > 0; end++) {
      if (span.quote[end] === '(') depth++
      else if (span.quote[end] === ')') depth--
    }
    if (depth !== 0) return regionsOf([span])
    return span.offsets.map(offset => {
      const prefix = span.block.text.slice(0, offset + start)
      const alreadyOptional = /\b(?:opzion[ei]|alternativ[ae]|oppure|scegli|scelta)\b/iu.test(prefix)
      return { blockId: span.blockId, start: offset + (alreadyOptional ? 0 : start), end: offset + (alreadyOptional ? span.quote.length : end) }
    })
  })
}
/** Tutte le occorrenze della citazione cadono dentro una delle regioni. */
const insideRegions = (span: VerifiedSpan, regions: readonly Region[]) =>
  regions.length > 0 && span.offsets.every(offset => regions.some(region => region.blockId === span.blockId && offset >= region.start && offset + span.quote.length <= region.end))

export function dietSourceFindings(input: DietSourceInput): { findings: ValidationFinding[]; origins: Map<string, { origin: FieldOrigin; rule: 'number' }> } {
  const { index, items, children, evidence } = input
  const findings: ValidationFinding[] = []
  const spansOf = groupSpans(evidence)
  const root = items.find(item => item.collection === 'root')!
  const days = children(root.key, 'days')
  const rules = children(root.key, 'globalRules')
  const globalTexts = new Set(rules.map(rule => fold(String(rule.values.text ?? ''))).filter(Boolean))

  // Fonti delle regole globali: blocchi indicati e regioni citate (aggiunte e sostituzioni generali).
  const ruleBlocks = new Set<string>()
  const globalAdditionRegions: Region[] = []
  for (const rule of rules) {
    const refs = (rule.values.sourceRefs as string[]).filter(id => index.blocks.has(id))
    refs.forEach(id => ruleBlocks.add(id))
    const spans = spansOf(rule, 'text')
    spans.forEach(span => ruleBlocks.add(span.blockId))
    const kind = rule.values.kind as ExtractedDietRule['kind']
    if (kind === 'addition' || kind === 'substitution') {
      globalAdditionRegions.push(...(spans.length ? regionsOf(spans) : refs.map(id => ({ blockId: id, start: 0, end: index.blocks.get(id)!.text.length }))))
    }
  }

  // Ancoraggi e ambito dei pasti.
  const meals = days.flatMap(day => children(day.key, 'meals').map(meal => ({ day, meal })))
  const owners = new Map<string, Set<string>>()
  const anchors = new Map<string, SourceBlock[]>()
  for (const { meal } of meals) {
    const blocks = [...new Map(spansOf(meal, 'name').map(span => [span.block.id, span.block])).values()]
    anchors.set(meal.key, blocks)
    for (const block of blocks) for (const id of index.family(block)) owners.set(id, new Set([...owners.get(id) ?? [], meal.key]))
  }
  const starts = meals.map(({ meal }) => ({ key: meal.key, at: Math.min(...(anchors.get(meal.key) ?? []).map(block => index.order.get(block.id)!)) }))
    .filter(entry => Number.isFinite(entry.at)).sort((a, b) => a.at - b.at)
  const scopeEnd = new Map(starts.map((entry, position) => [entry.key, starts[position + 1]?.at ?? Number.POSITIVE_INFINITY]))
  const inScope = (mealKey: string, block: SourceBlock) => {
    if (owners.get(block.id)?.has(mealKey)) return true
    if (owners.has(block.id)) return false
    const start = starts.find(entry => entry.key === mealKey)?.at
    const at = index.order.get(block.id)!
    return start !== undefined && at > start && at < scopeEnd.get(mealKey)!
  }
  const dayHeadings = new Map(days.map(day => [day.key, new Set(spansOf(day, 'name').filter(span => span.block.kind === 'heading').map(span => span.blockId))]))

  for (const day of days) {
    const headings = dayHeadings.get(day.key)!
    const typeSpans = spansOf(day, 'dayType')
    const dayType = day.values.dayType as keyof typeof dayTypePatterns | null
    if (dayType !== null && typeSpans.length) {
      const quotes = typeSpans.map(span => span.quote).join(' ')
      if (!dayTypePatterns[dayType].test(quotes)) {
        const other = (Object.keys(dayTypePatterns) as (keyof typeof dayTypePatterns)[]).some(type => type !== dayType && dayTypePatterns[type].test(quotes))
        findings.push(finding(other ? 'value_contradicts_source' : 'value_unverified', day, 'dayType',
          other ? 'La citazione indica un altro tipo di giornata.' : 'La citazione non dice se è un giorno di allenamento, di riposo o qualsiasi: il tipo non si deduce dai cibi.',
          { refs: typeSpans.map(span => span.blockId) }))
      }
    }

    for (const meal of children(day.key, 'meals')) {
      const own = anchors.get(meal.key) ?? []
      if (!own.length) continue
      if (headings.size && own.some(block => block.kind !== 'heading' && block.headingIds.length > 0 && !block.headingIds.some(id => headings.has(id)))) {
        findings.push(finding('wrong_section', meal, 'name', 'Il pasto è citato da una sezione diversa da quella della giornata.', { refs: own.map(block => block.id) }))
      }
      // Alternative, aggiunte e note: nel pasto o nella stessa giornata, mai da un altro pasto né da sopra la giornata.
      for (const entry of evidence.values()) {
        const { item, field, path, value } = entry.unit
        if (item !== meal || (field !== 'alternatives' && field !== 'additions' && field !== 'notes')) continue
        // Una riga identica a una regola globale è già segnalata dalle regole sui valori.
        if (field !== 'notes' && typeof value === 'string' && globalTexts.has(fold(value))) continue
        for (const span of entry.spans) {
          if (inScope(meal.key, span.block)) continue
          if (owners.has(span.blockId)) { findings.push(finding('wrong_context', meal, field, `Citazione presa da un altro pasto («${span.quote}»).`, { refs: [span.blockId], path })); break }
          const aboveDay = headings.size > 0 && !span.block.headingIds.some(id => headings.has(id)) && !headings.has(span.blockId)
          if (field !== 'notes' && (ruleBlocks.has(span.blockId) || aboveDay)) { findings.push(finding('global_rule_in_meal', meal, field, 'Regola generale collocata in un pasto: va riportata una sola volta fra le regole del piano.', { refs: [span.blockId], path })); break }
        }
      }
      const alternativeRegions = alternativeRegionsOf(spansOf(meal, 'alternatives'))
      const additionRegions = [...regionsOf(spansOf(meal, 'additions')), ...globalAdditionRegions]
      for (const food of children(meal.key, 'foods')) {
        let reported = false
        for (const field of ['name', 'quantityText', 'notes'] as const) {
          const outside = spansOf(food, field).filter(span => !inScope(meal.key, span.block))
          if (outside.length && !reported) {
            findings.push(finding('wrong_context', food, field, `Alimento citato fuori dal pasto «${String(meal.values.name ?? '')}» («${outside[0]!.quote}»).`, { refs: outside.map(span => span.blockId) }))
            reported = true
          }
        }
        const nameSpans = spansOf(food, 'name')
        if (!reported && nameSpans.length) {
          if (nameSpans.every(span => insideRegions(span, alternativeRegions))) findings.push(finding('alternative_in_base', food, 'name', 'L’alimento compare solo come alternativa: non va sommato al pasto base.', { refs: nameSpans.map(span => span.blockId) }))
          else if (nameSpans.every(span => insideRegions(span, additionRegions))) findings.push(finding('conditional_in_base', food, 'name', 'L’alimento compare solo in un’aggiunta condizionata: non fa parte del pasto base.', { refs: nameSpans.map(span => span.blockId) }))
        }
      }
    }
  }
  return { findings, origins: new Map() }
}
