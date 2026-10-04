/**
 * Regole della scheda (specifica §§6.1, 7.2, 7.5). Due famiglie:
 * - `workoutRuleFindings`: relazioni fra campi e requisiti del dominio sui valori correnti (proposta o
 *   bozza modificata), senza guardare la fonte: dati mancanti, conflitti, intervalli da scegliere, regole
 *   complesse da risolvere, scelta del catalogo richiesta all'08;
 * - `workoutSourceFindings`: contesto delle citazioni e letture deterministiche della fonte sulla sola
 *   proposta immutabile. Un numero vero nella riga sbagliata, una sequenza 12/10/8 resa come intervallo
 *   o un recupero globale che ignora l'override della riga restano errori anche con la citazione giusta.
 *
 * Letture deterministiche (euristiche dichiarate, non certezze): schema `N x M(–K)` con eventuale unità
 * di tempo, `N + M facoltative`, `N serie`, `M rip`, intervalli con trattino, `RIR n`/`RPE n`, durate
 * `90"`, `90 s`, `1'30"`, `1,5 minuti`, `90–120 s`; per il recupero fuori da una colonna dedicata serve
 * la parola «recupero/rec/pausa/riposo» prima del tempo. Un numero senza unità non viene mai convertito.
 * Colonne riconosciute dall'intestazione della tabella (serie, ripetizioni, recupero, durata, RIR, RPE,
 * schema). Quando nessuna lettura è possibile il campo va in revisione (`value_unverified`).
 */
import { exerciseChoiceValues, type ExtractedComplexRule, type SourceBlock } from '../contracts/index.ts'
import {
  columnText, groupSpans, spanColumns, type ColumnRole, type SourceIndex, type UnitEvidence, type VerifiedSpan,
} from './evidence.ts'
import { finding, hasText, isRangeValue, type RuleItem, type ValidationFinding } from './issues.ts'
import { instructionCanBeKept } from './workout-instructions.ts'

// ---------------------------------------------------------------------------
// Relazioni fra campi (valori correnti)
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
/** Data reale YYYY-MM-DD; null se la forma o il giorno non esistono. */
export function realIsoDate(value: string): string | null {
  const match = ISO_DATE.exec(value)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : null
}

const blockingRuleKinds: ReadonlySet<ExtractedComplexRule['kind']> = new Set(['phase', 'progression', 'deload', 'superset', 'circuit'])
const ruleKindLabels: Record<ExtractedComplexRule['kind'], string> = {
  phase: 'Fase', progression: 'Progressione', deload: 'Scarico', superset: 'Superserie', circuit: 'Circuito', cardio: 'Cardio', other: 'Regola',
}
const range = (value: unknown) => typeof value === 'number' ? { min: value, max: value } : isRangeValue(value) ? value : null
const spread = (value: unknown) => { const r = range(value); return r !== null && r.min !== r.max }

export function workoutRuleFindings(items: readonly RuleItem[], children: (key: string, collection: string) => RuleItem[], cycleStartBounds: { min: string; max: string }): ValidationFinding[] {
  const out: ValidationFinding[] = []
  const root = items.find(item => item.collection === 'root')
  if (!root) return out
  const v = root.values
  if (!hasText(v.title)) out.push(finding('title_missing', root, 'title', 'Manca il nome della scheda.'))
  const sessions = children(root.key, 'sessions')
  if (!sessions.length) out.push(finding('no_sessions', root, null, 'La proposta non contiene sedute.'))
  const cycle = v.cycle as { startDate: string | null; weeks: number | null }
  if ((cycle.startDate === null) !== (cycle.weeks === null)) {
    out.push(finding('cycle_incomplete', root, 'cycle', cycle.startDate === null ? 'Il ciclo indica le settimane ma non la data d’inizio.' : 'Il ciclo indica la data d’inizio ma non le settimane.'))
  }
  if (cycle.startDate !== null) {
    const date = realIsoDate(cycle.startDate)
    const path = root.pointer === null ? undefined : `${root.pointer}/cycle/startDate`
    if (date === null) out.push(finding('cycle_start_invalid', root, 'cycle', `«${cycle.startDate}» non è una data reale nel formato AAAA-MM-GG.`, { path }))
    else if (date < cycleStartBounds.min || date > cycleStartBounds.max) out.push(finding('value_out_of_bounds', root, 'cycle', `Data d’inizio ${date} fuori dall’intervallo ${cycleStartBounds.min} – ${cycleStartBounds.max}.`, { path }))
  }

  const labels = new Map<string, RuleItem>()
  for (const session of sessions) {
    const s = session.values
    if (!hasText(s.label)) out.push(finding('session_label_missing', session, 'label', 'Manca l’etichetta della seduta (per esempio A, B, 1).'))
    else {
      const label = s.label.trim()
      if (labels.has(label)) out.push(finding('session_label_duplicate', session, 'label', `Etichetta «${label}» già usata da un’altra seduta.`))
      labels.set(label, session)
    }
    if (!hasText(s.title)) out.push(finding('session_title_missing', session, 'title', 'Manca il titolo della seduta.'))
    const exercises = children(session.key, 'exercises')
    if (!exercises.length) out.push(finding('session_empty', session, null, 'La seduta non ha esercizi.'))
    for (const exercise of exercises) out.push(...exerciseRuleFindings(exercise))
  }

  for (const rule of children(root.key, 'complexRules')) {
    const kind = rule.values.kind as ExtractedComplexRule['kind']
    const label = ruleKindLabels[kind]
    if (rule.localId !== null && instructionCanBeKept(rule, items)) {
      out.push(finding('complex_rule_preserved', rule, null, `${label}: conservata nelle indicazioni, da gestire manualmente.`, { refs: rule.values.sourceRefs as string[] }))
      continue
    }
    out.push(blockingRuleKinds.has(kind)
      ? finding('complex_rule_unresolved', rule, null, `${label}: il dominio attuale non la esegue da sé. Scegliere esplicitamente cosa importare (per esempio una fase o una settimana) e conservarla come istruzione.`, { refs: rule.values.sourceRefs as string[] })
      : finding('complex_rule_review', rule, null, `${label}: confermare come conservarla nel piano.`, { refs: rule.values.sourceRefs as string[] }))
  }
  return out
}

function exerciseRuleFindings(item: RuleItem): ValidationFinding[] {
  const out: ValidationFinding[] = []
  const v = item.values
  const chosen = item.catalog ? exerciseChoiceValues(item.catalog) : null
  const mode = chosen?.measurementMode ?? (v.measurementMode as 'reps' | 'seconds' | null)
  if (!hasText(v.name) && !chosen) out.push(finding('exercise_name_missing', item, 'name', 'Manca il nome dell’esercizio.'))
  if (!chosen) out.push(finding('catalog_choice_required', item, null, 'Associare l’esercizio al catalogo: esistente, comune o nuovo.'))
  else if (v.measurementMode !== null && chosen.measurementMode !== v.measurementMode) {
    out.push(finding('catalog_mode_mismatch', item, 'measurementMode', `L’esercizio scelto è ${chosen.measurementMode === 'reps' ? 'a ripetizioni' : 'a tempo'}, la prescrizione no.`))
  }
  if (mode === null) out.push(finding('measurement_mode_missing', item, 'measurementMode', 'Indicare se l’esercizio è a ripetizioni o a tempo.'))
  if (v.sets === null) out.push(finding('sets_missing', item, 'sets', 'Numero di serie mancante o ambiguo: indicarlo esplicitamente.'))
  const reps = v.repetitions, duration = v.durationSeconds
  if (reps !== null && duration !== null) out.push(finding('reps_duration_conflict', item, 'durationSeconds', 'Ripetizioni e durata insieme: sceglierne una.'))
  else if (mode === 'reps') {
    if (duration !== null) out.push(finding('mode_conflict', item, 'durationSeconds', 'Esercizio a ripetizioni con una durata.'))
    else if (reps === null) out.push(finding('repetitions_missing', item, 'repetitions', 'Ripetizioni mancanti.'))
  } else if (mode === 'seconds') {
    if (reps !== null) out.push(finding('mode_conflict', item, 'repetitions', 'Esercizio a tempo con delle ripetizioni.'))
    else if (duration === null) out.push(finding('duration_missing', item, 'durationSeconds', 'Durata mancante.'))
  }
  if (v.restSeconds === null) out.push(finding('rest_missing', item, 'restSeconds', 'Recupero non indicato: sceglierlo esplicitamente (0 solo se voluto).'))
  else if (spread(v.restSeconds)) out.push(finding('rest_range', item, 'restSeconds', 'Recupero a intervallo: scegliere il valore del timer, l’intervallo resta nella fonte.'))
  if (spread(duration)) out.push(finding('duration_range', item, 'durationSeconds', 'Durata a intervallo: scegliere il valore del timer.'))
  if (spread(v.rir)) out.push(finding('rir_range', item, 'rir', 'RIR a intervallo: scegliere il valore da conservare.'))
  if (spread(v.rpe)) out.push(finding('rpe_range', item, 'rpe', 'RPE a intervallo: scegliere il valore da conservare.'))
  if (v.optionalSets === null) out.push(finding('optional_sets_missing', item, 'optionalSets', 'Serie facoltative non indicate: confermare nessuna o indicarle.'))
  if (v.rir === null && v.rpe === null) out.push(finding('intensity_not_prescribed', item, null, 'RIR e RPE non prescritti: restano vuoti.'))
  return out
}

// ---------------------------------------------------------------------------
// Letture deterministiche del testo
// ---------------------------------------------------------------------------

export type ConversionRule = 'number' | 'seconds' | 'minutes' | 'minutes_seconds'
interface Value { min: number; max: number; rule: ConversionRule }
type Flag = 'sequence' | 'non_numeric' | 'range'
interface Reading { values: Value[]; flags: Set<Flag> }
const emptyReading = (): Reading => ({ values: [], flags: new Set() })
const merge = (target: Reading, source: Reading) => { target.values.push(...source.values); source.flags.forEach(flag => target.flags.add(flag)); return target }

const decimal = (text: string) => Number(text.replace(',', '.'))
const N = String.raw`\d+(?:[.,]\d+)?`
const DASH = String.raw`\s*[-–—]\s*`
const SEC = String.raw`(?:secondi|secondo|sec\.?|s(?![a-zà-ÿ])|"|″|''|”)`
const MIN = String.raw`(?:minuti|minuto|min\.?(?![a-zà-ÿ])|['′’](?!\s*\d))`
const REST_WORD = /\b(recupero|rec|pausa|riposo|rest)\b[^\d]*$/i

interface Located extends Value { start: number; end: number }
/** Tempi con unità esplicita, convertiti in secondi; le parti già lette non vengono rilette. */
function durations(text: string): Located[] {
  let work = text
  const found: Located[] = []
  const take = (pattern: RegExp, make: (match: RegExpExecArray) => Value | null) => {
    for (const match of work.matchAll(pattern)) {
      const value = make(match)
      if (!value) continue
      found.push({ ...value, start: match.index, end: match.index + match[0].length })
      work = work.slice(0, match.index) + ' '.repeat(match[0].length) + work.slice(match.index + match[0].length)
    }
  }
  take(/(\d+)\s*['′’]\s*(\d{1,2})\s*(?:"|″|''|”)?(?!\d)/g, m => { const s = Number(m[1]) * 60 + Number(m[2]); return { min: s, max: s, rule: 'minutes_seconds' } })
  take(new RegExp(`(${N})${DASH}(${N})\\s*${SEC}`, 'gi'), m => ({ min: decimal(m[1]!), max: decimal(m[2]!), rule: 'seconds' }))
  take(new RegExp(`(${N})${DASH}(${N})\\s*${MIN}`, 'gi'), m => ({ min: decimal(m[1]!) * 60, max: decimal(m[2]!) * 60, rule: 'minutes' }))
  take(new RegExp(`(${N})\\s*${SEC}`, 'gi'), m => ({ min: decimal(m[1]!), max: decimal(m[1]!), rule: 'seconds' }))
  take(new RegExp(`(${N})\\s*${MIN}`, 'gi'), m => ({ min: decimal(m[1]!) * 60, max: decimal(m[1]!) * 60, rule: 'minutes' }))
  return found.sort((a, b) => a.start - b.start)
}

const SCHEME = new RegExp(String.raw`(\d+)\s*[x×X]\s*(${N})(?:${DASH}(${N}))?(\s*(?:${SEC}|${MIN}))?`, 'g')
const SEQUENCE = /\b\d+(?:\s*\/\s*\d+){2,}\b/
const DASH_SEQUENCE = /\b\d+(?:\s*[-–—]\s*\d+){2,}\b/
const NON_NUMERIC = /\b(AMRAP|max(?:imo|imali)?|cedimento|esaurimento|drop[- ]?set|rest[- ]?pause)\b/i

function schemes(text: string) {
  return [...text.matchAll(SCHEME)].map(match => {
    const unit = match[4]?.trim() ?? ''
    const first = decimal(match[2]!), second = match[3] === undefined ? first : decimal(match[3])
    const minutes = unit !== '' && new RegExp(`^${MIN}$`, 'i').test(unit)
    return { sets: Number(match[1]), low: first, high: second, timed: unit !== '', minutes }
  })
}

type NumericField = 'sets' | 'optionalSets' | 'repetitions' | 'durationSeconds' | 'restSeconds' | 'rir' | 'rpe'
const numericFields: readonly NumericField[] = ['sets', 'optionalSets', 'repetitions', 'durationSeconds', 'restSeconds', 'rir', 'rpe']
const scalar = (value: number, rule: ConversionRule = 'number'): Value => ({ min: value, max: value, rule })

/** Lettura di un campo in un testo. `cell` = testo della colonna dedicata al campo: un numero isolato vale. */
function read(field: NumericField, text: string, cell: boolean): Reading {
  const reading = emptyReading()
  const values = reading.values
  switch (field) {
    case 'sets': {
      if (new RegExp(`(\\d+)${DASH}(\\d+)\\s*(?:serie|sets?\\b|[x×X])`, 'i').test(text) || (cell && new RegExp(`^\\D*\\d+${DASH}\\d+(?!\\s*[x×X])`).test(text) && !/facoltativ|opzional/i.test(text))) reading.flags.add('range')
      for (const scheme of schemes(text)) values.push(scalar(scheme.sets))
      for (const match of text.matchAll(/(\d+)\s*\+\s*\d+\s*(?:serie\s*)?(?:facoltativ|opzional)/gi)) values.push(scalar(Number(match[1])))
      for (const match of text.matchAll(/(?<![+\d]\s*)(\d+)\s*serie\b(?!\s*(?:facoltativ|opzional))/gi)) values.push(scalar(Number(match[1])))
      if (cell && !values.length && !reading.flags.has('range')) { const match = /^\D*?(\d+)(?![\d.,])/.exec(text); if (match) values.push(scalar(Number(match[1]))) }
      break
    }
    case 'optionalSets':
      if (new RegExp(`(\\d+)${DASH}(\\d+)\\s*(?:serie|sets?\\b|[x×X])`, 'i').test(text) || (cell && new RegExp(`^\\D*\\d+${DASH}\\d+`).test(text))) reading.flags.add('range')
      for (const match of text.matchAll(new RegExp(String.raw`(${N})\s*(?:serie\s*)?(?:facoltativ|opzional)`, 'gi'))) values.push(scalar(decimal(match[1]!)))
      break
    case 'repetitions': {
      if (SEQUENCE.test(text) || (cell && DASH_SEQUENCE.test(text))) reading.flags.add('sequence')
      if (NON_NUMERIC.test(text)) reading.flags.add('non_numeric')
      for (const scheme of schemes(text)) if (!scheme.timed) values.push({ min: scheme.low, max: scheme.high, rule: 'number' })
      for (const match of text.matchAll(new RegExp(`(\\d+)(?:${DASH}(\\d+))?\\s*(?:ripetizioni|rip\\b|reps?\\b)`, 'gi'))) values.push({ min: Number(match[1]), max: Number(match[2] ?? match[1]), rule: 'number' })
      if (cell && !values.length) {
        const match = new RegExp(`(\\d+)(?:${DASH}(\\d+))?(?!\\s*(?:${SEC}|${MIN}|[\\d/.,]))`, 'i').exec(text)
        if (match) values.push({ min: Number(match[1]), max: Number(match[2] ?? match[1]), rule: 'number' })
      }
      break
    }
    case 'durationSeconds':
      for (const scheme of schemes(text)) if (scheme.timed) values.push({ min: scheme.low * (scheme.minutes ? 60 : 1), max: scheme.high * (scheme.minutes ? 60 : 1), rule: scheme.minutes ? 'minutes' : 'seconds' })
      for (const found of durations(text)) {
        if (!cell && REST_WORD.test(text.slice(Math.max(0, found.start - 25), found.start))) continue
        values.push(found)
      }
      break
    case 'restSeconds':
      for (const found of durations(text)) if (cell || REST_WORD.test(text.slice(Math.max(0, found.start - 25), found.start))) values.push(found)
      break
    case 'rir':
    case 'rpe': {
      const label = field === 'rir' ? 'RIR' : 'RPE'
      for (const match of text.matchAll(new RegExp(`\\b${label}\\s*:?\\s*(${N})(?:${DASH}(${N}))?`, 'gi'))) values.push({ min: decimal(match[1]!), max: decimal(match[2] ?? match[1]!), rule: 'number' })
      if (cell && !values.length) { const match = new RegExp(`(${N})(?:${DASH}(${N}))?`).exec(text); if (match) values.push({ min: decimal(match[1]!), max: decimal(match[2] ?? match[1]!), rule: 'number' }) }
      break
    }
  }
  return reading
}

const rolesFor: Record<NumericField, readonly ColumnRole[]> = {
  sets: ['sets', 'scheme'], optionalSets: ['sets', 'scheme'], repetitions: ['repetitions', 'scheme'], durationSeconds: ['durationSeconds', 'scheme'],
  restSeconds: ['restSeconds'], rir: ['rir'], rpe: ['rpe'],
}
/** Una colonna dedicata permette di leggere un numero isolato (la colonna «Serie» per le serie, non per le facoltative). */
const cellMode = (field: NumericField, role: ColumnRole) => role === field || (field === 'optionalSets' && role === 'sets')

// ---------------------------------------------------------------------------
// Contesto delle citazioni e verifica sulla fonte (sola proposta)
// ---------------------------------------------------------------------------

export interface SourceCheckInput {
  index: SourceIndex
  items: readonly RuleItem[]
  children: (key: string, collection: string) => RuleItem[]
  evidence: ReadonlyMap<string, UnitEvidence>
}
export type FieldOrigin = 'source' | 'converted' | 'inherited'
export interface SourceCheckResult { findings: ValidationFinding[]; origins: Map<string, { origin: FieldOrigin; rule: ConversionRule | 'inherited_rule' }> }

type SpanPlace = 'own' | 'header' | 'rule' | 'foreign'

// Confini espliciti: `\b` non funziona dopo le vocali accentate («lunedì»).
const day = (names: string) => new RegExp(`(?<![a-zà-ÿ])(?:${names})(?![a-zà-ÿ])`, 'i')
const WEEKDAYS: readonly RegExp[] = [
  day(String.raw`luned[iì]|lun\.|monday|mon`), day(String.raw`marted[iì]|mar\.|tuesday|tue`), day(String.raw`mercoled[iì]|mer\.|wednesday|wed`),
  day(String.raw`gioved[iì]|gio\.|thursday|thu`), day(String.raw`venerd[iì]|ven\.|friday|fri`), day(String.raw`sabato|sab\.|saturday|sat`), day(String.raw`domenica|dom\.|sunday|sun`),
]
const ABSENT = /\b(non indicat\w*|non specificat\w*|non prescritt\w*|assente|a piacere|libero|a scelta)\b/i
const PER_SIDE =/\b(per lato|per gamba|per braccio|per parte|each side|per side|a lato)\b|\bdx\s*[/e]\s*sx\b/i
const START_WORD = /\b(dal|dall[a’']|inizio|iniziare|inizia|a partire|partenza|start|parte)\b/i
const ROTATION_WORD = /\b(altern\w*|rotazion\w*|a rotazione|senza giorni|in sequenza|ciclic\w*)\b/i

export function workoutSourceFindings(input: SourceCheckInput): SourceCheckResult {
  const { index, items, children, evidence } = input
  const findings: ValidationFinding[] = []
  const origins: SourceCheckResult['origins'] = new Map()
  const spansOf = groupSpans(evidence)
  const root = items.find(item => item.collection === 'root')!
  const sessions = children(root.key, 'sessions')

  // Blocchi d'ancoraggio di ogni esercizio: citazioni del nome e del testo della prescrizione, con la riga intera.
  const anchors = new Map<string, SourceBlock[]>()
  const owners = new Map<string, Set<string>>()
  for (const session of sessions) for (const exercise of children(session.key, 'exercises')) {
    const blocks = [...spansOf(exercise, 'name'), ...spansOf(exercise, 'prescriptionText')].map(span => span.block)
    const unique = [...new Map(blocks.map(block => [block.id, block])).values()]
    anchors.set(exercise.key, unique)
    for (const block of unique) for (const id of index.family(block)) {
      const set = owners.get(id) ?? new Set<string>()
      set.add(exercise.key)
      owners.set(id, set)
    }
  }
  const sessionHeadings = new Map<string, Set<string>>()
  for (const session of sessions) {
    const headings = [...spansOf(session, 'label'), ...spansOf(session, 'title')].filter(span => span.block.kind === 'heading').map(span => span.block.id)
    sessionHeadings.set(session.key, new Set(headings))
  }
  const allSessionHeadings = new Set([...sessionHeadings.values()].flatMap(set => [...set]))

  const place = (exercise: RuleItem, session: RuleItem, span: VerifiedSpan): SpanPlace => {
    const own = anchors.get(exercise.key) ?? []
    const block = span.block
    if (owners.get(block.id)?.has(exercise.key)) return 'own'
    // Esercizio con il nome come titolo: i blocchi sotto quel titolo sono suoi.
    if (own.some(anchor => anchor.kind === 'heading' && block.headingIds.includes(anchor.id))) return 'own'
    // Un blocco che ancora un altro esercizio resta estraneo anche se una parentela lo collega a questo.
    if (owners.has(block.id)) return 'foreign'
    const headingIds = new Set(own.flatMap(anchor => anchor.headingIds))
    if (block.kind === 'heading' && (headingIds.has(block.id) || sessionHeadings.get(session.key)?.has(block.id))) return 'header'
    for (const anchor of own) {
      const row = index.rowOf(anchor)
      const header = row?.tableId ? index.headerRow(row.tableId) : null
      if (header && index.family(header).includes(block.id)) return 'header'
      for (let parent = anchor.parentId; parent !== null; parent = index.blocks.get(parent)?.parentId ?? null) if (parent === block.id) return 'header'
    }
    const otherSession = block.headingIds.some(id => allSessionHeadings.has(id) && !sessionHeadings.get(session.key)?.has(id))
    if (!otherSession && (block.kind === 'paragraph' || block.kind === 'heading') && own.length && block.headingIds.every(id => headingIds.has(id))) return 'rule'
    return 'foreign'
  }

  for (const session of sessions) {
    const headings = sessionHeadings.get(session.key)!
    // Giorno della settimana: solo se il nome del giorno è nella citazione.
    const weekday = session.values.weekday as number | null
    const weekdaySpans = spansOf(session, 'weekday')
    if (weekday !== null && weekdaySpans.length) {
      const quotes = weekdaySpans.map(span => span.quote).join(' ')
      const other = WEEKDAYS.findIndex((pattern, position) => position !== weekday - 1 && pattern.test(quotes))
      if (!WEEKDAYS[weekday - 1]!.test(quotes)) {
        findings.push(other >= 0
          ? finding('value_contradicts_source', session, 'weekday', 'La citazione indica un altro giorno della settimana.', { refs: weekdaySpans.map(span => span.blockId) })
          : finding('value_unverified', session, 'weekday', 'Il giorno della settimana non compare nella citazione: non si deduce da A/B/C.', { refs: weekdaySpans.map(span => span.blockId) }))
      }
    }

    for (const exercise of children(session.key, 'exercises')) {
      const own = anchors.get(exercise.key) ?? []
      if (!own.length) continue
      const refs = own.map(block => block.id)
      if (headings.size && own.some(block => block.kind !== 'heading' && block.headingIds.length > 0 && !block.headingIds.some(id => headings.has(id)))) {
        findings.push(finding('wrong_section', exercise, 'name', 'L’esercizio è citato da una sezione diversa da quella della seduta.', { refs }))
      }
      const rows = [...new Map(own.map(block => index.rowOf(block) ?? block).map(block => [block.id, block])).values()]
      const failed = new Set<string>()

      // Contesto di ogni campo citato, esclusi nome e testo della prescrizione che definiscono l'ancoraggio.
      for (const field of Object.keys(exercise.values)) {
        if (field === 'name' || field === 'prescriptionText') continue
        const foreign = spansOf(exercise, field).filter(span => place(exercise, session, span) === 'foreign')
        if (foreign.length) {
          findings.push(finding('wrong_context', exercise, field, `Citazione presa da un altro esercizio, da un’altra riga o sezione («${foreign[0]!.quote}»).`, { refs: foreign.map(span => span.blockId) }))
          failed.add(field)
        }
      }

      for (const field of numericFields) {
        const target = range(exercise.values[field])
        const spans = spansOf(exercise, field)
        if (target === null || !spans.length || failed.has(field)) continue
        const result = verifyNumber(field, target, exercise, session, spans, rows)
        if (result.finding) { findings.push(result.finding); failed.add(field) }
        else if (result.origin) origins.set(`${exercise.pointer}/${field}`, result.origin)
      }

      // Modalità: coerente con il campo verificato, contraddetta se la riga dice il contrario.
      const mode = exercise.values.measurementMode as 'reps' | 'seconds' | null
      const modeSpans = spansOf(exercise, 'measurementMode')
      const modeValue = mode === 'reps' ? exercise.values.repetitions : exercise.values.durationSeconds
      if (mode !== null && modeValue !== null && modeSpans.length && !failed.has('measurementMode') && !failed.has('repetitions') && !failed.has('durationSeconds')) {
        const verified = mode === 'reps' ? origins.has(`${exercise.pointer}/repetitions`) : origins.has(`${exercise.pointer}/durationSeconds`)
        if (!verified) {
          const texts = rows.map(block => block.text).join('\n')
          const reps = read('repetitions', texts, false).values.length > 0
          const timed = schemes(texts).some(scheme => scheme.timed)
          const contradicted = mode === 'reps' ? timed && !reps : reps && !timed
          findings.push(contradicted
            ? finding('value_contradicts_source', exercise, 'measurementMode', mode === 'reps' ? 'La riga prescrive un tempo, non ripetizioni.' : 'La riga prescrive ripetizioni, non un tempo.', { refs })
            : finding('value_unverified', exercise, 'measurementMode', 'Modalità non ricavabile in modo certo dalla riga.', { refs }))
        }
      }
      const perSide = exercise.values.perSide
      const sideSpans = spansOf(exercise, 'perSide')
      if (perSide === true && sideSpans.length && !failed.has('perSide') && !PER_SIDE.test(sideSpans.map(span => span.quote).join(' '))) {
        findings.push(finding('value_unverified', exercise, 'perSide', '«Per lato» non compare nella citazione.', { refs: sideSpans.map(span => span.blockId) }))
      }
      const unit = exercise.values.loadUnit
      const unitSpans = spansOf(exercise, 'loadUnit')
      if (unit !== null && unitSpans.length && !failed.has('loadUnit')) {
        const quotes = unitSpans.map(span => span.quote).join(' ')
        if (!(unit === 'kg' ? /\bkg\b|chil/i : /\blbs?\b|libbr/i).test(quotes)) findings.push(finding('value_unverified', exercise, 'loadUnit', 'L’unità di carico non compare nella citazione.', { refs: unitSpans.map(span => span.blockId) }))
      }
    }
  }

  // Programmazione e ciclo della radice.
  const scheduleSpans = spansOf(root, 'schedule')
  const schedule = root.values.schedule
  if (scheduleSpans.length && schedule !== 'unknown') {
    const quotes = scheduleSpans.map(span => span.quote).join(' ')
    const ok = schedule === 'weekly' ? WEEKDAYS.some(pattern => pattern.test(quotes)) || /settiman/i.test(quotes) : ROTATION_WORD.test(quotes)
    if (!ok) findings.push(finding('value_unverified', root, 'schedule', schedule === 'weekly' ? 'La citazione non indica giorni della settimana.' : 'La citazione non indica una rotazione.', { refs: scheduleSpans.map(span => span.blockId) }))
  }
  const start = evidence.get('/cycle/startDate')
  if (start?.spans.length && !start.spans.some(span => START_WORD.test(span.quote) || START_WORD.test(span.block.text.slice(Math.max(0, span.offsets[0]! - 20), span.offsets[0])))) {
    findings.push(finding('cycle_start_unconfirmed', root, 'cycle', 'La fonte non presenta questa data come inizio del ciclo (una data in copertina non basta).', { refs: start.spans.map(span => span.blockId), path: '/cycle/startDate' }))
  }
  const weeks = evidence.get('/cycle/weeks')
  const weeksValue = (root.values.cycle as { weeks: number | null }).weeks
  if (weeks?.spans.length && weeksValue !== null) {
    const numbers = weeks.spans.flatMap(span => [...span.quote.matchAll(/\d+(?:[.,]\d+)?/g)].map(match => decimal(match[0])))
    if (!numbers.includes(weeksValue)) findings.push(finding('value_unverified', root, 'cycle', `Il numero ${weeksValue} non compare nelle citazioni delle settimane.`, { refs: weeks.spans.map(span => span.blockId), path: '/cycle/weeks' }))
  }
  return { findings, origins }

  function verifyNumber(field: NumericField, target: { min: number; max: number }, exercise: RuleItem, session: RuleItem, spans: VerifiedSpan[], rows: SourceBlock[]) {
    const refs = [...new Set([...spans.map(span => span.blockId), ...rows.map(row => row.id)])]
    const matches = (reading: Reading) => reading.values.find(value => value.min === target.min && value.max === target.max)
    const originOf = (value: Value, inherited = false): { origin: FieldOrigin; rule: Value['rule'] | 'inherited_rule' } => ({
      origin: inherited ? 'inherited' : value.rule === 'minutes' || value.rule === 'minutes_seconds' ? 'converted' : 'source',
      rule: inherited ? 'inherited_rule' as const : value.rule,
    })
    const make = (code: Parameters<typeof finding>[0], message: string) => ({ finding: finding(code, exercise, field, message, { refs }), origin: null })
    // «Recupero non indicato», «a piacere»: la fonte dichiara l'assenza, un numero sarebbe inventato.
    if (spans.some(span => ABSENT.test(span.quote))) return make('value_contradicts_source', 'La fonte dice che il valore non è indicato: non va completato.')

    // Lettura propria della riga: colonna dedicata se l'intestazione la riconosce, altrimenti tutto il testo.
    const own = emptyReading()
    const ownTexts: string[] = []
    const allowed = new Set<number>()
    let roleTable = false
    for (const row of rows) {
      const roles = row.kind === 'table_row' && row.tableId !== null ? index.roles(row.tableId) : new Map<number, ColumnRole>()
      if (roles.size) roleTable = true
      const columns = [...roles.entries()].filter(([, role]) => rolesFor[field].includes(role))
      columns.forEach(([column]) => allowed.add(column))
      if (columns.length) {
        for (const [column, role] of columns) {
          const text = columnText(index, row, column) ?? ''
          ownTexts.push(text)
          merge(own, read(field, text, cellMode(field, role)))
        }
      } else {
        ownTexts.push(row.text)
        merge(own, read(field, row.text, false))
      }
    }
    if (field === 'repetitions' && own.flags.has('sequence') && !matches(own)) return make('reps_sequence_as_range', 'La fonte indica una sequenza di ripetizioni (es. 12/10/8), non un intervallo: conservarla come istruzione e scegliere la prescrizione.')
    if (field === 'repetitions' && own.flags.has('non_numeric') && !matches(own)) return make('non_numeric_reps', 'La fonte indica AMRAP, cedimento o simili: non è un numero di ripetizioni.')
    if ((field === 'sets' || field === 'optionalSets') && own.flags.has('range')) return make('sets_range_as_number', 'La fonte indica un intervallo di serie (es. 3–4): non è un numero né 3 più una facoltativa.')
    const hit = matches(own)
    if (hit) return { finding: null, origin: originOf(hit) }

    const places = spans.map(span => ({ span, place: place(exercise, session, span) }))
    const ruleReading = places.filter(entry => entry.place === 'rule').reduce((reading, entry) => merge(reading, read(field, entry.span.quote, false)), emptyReading())
    const swapped = (field === 'rir' || field === 'rpe') && matches(read(field === 'rir' ? 'rpe' : 'rir', [...ownTexts, ...spans.map(span => span.quote)].join('\n'), false))
    if (swapped) return make('rir_rpe_swapped', field === 'rir' ? 'Il valore viene da un RPE: RIR e RPE non si convertono.' : 'Il valore viene da un RIR: RIR e RPE non si convertono.')
    const wrongColumn = roleTable && allowed.size > 0 && places.some(entry => {
      if (entry.place !== 'own') return false
      const columns = spanColumns(index, entry.span)
      return columns !== null && columns.size > 0 && ![...columns].some(column => allowed.has(column))
    })
    if (own.values.length) {
      if (matches(ruleReading)) return make('local_override_ignored', 'La riga indica un valore proprio: la regola generale non si applica qui.')
      if (wrongColumn) return make('wrong_column', 'Il numero citato viene da un’altra colonna della riga.')
      return make('value_contradicts_source', `La riga indica ${[...new Set(own.values.map(value => value.min === value.max ? `${value.min}` : `${value.min}–${value.max}`))].join(', ')}.`)
    }
    const inherited = matches(ruleReading)
    if (inherited) return { finding: null, origin: originOf(inherited, true) }
    if (wrongColumn) return make('wrong_column', 'Il numero citato viene da un’altra colonna della riga.')
    if (ruleReading.values.length) return make('value_contradicts_source', 'La regola citata indica un valore diverso.')
    const quoted = places.filter(entry => entry.place === 'own').reduce((reading, entry) => merge(reading, read(field, entry.span.quote, false)), emptyReading())
    const fromQuote = matches(quoted)
    if (fromQuote) return { finding: null, origin: originOf(fromQuote) }
    if (quoted.values.length) return make('value_contradicts_source', 'La citazione indica un valore diverso.')
    return make('value_unverified', 'Valore non ricavabile in modo deterministico dalla riga: controllarlo.')
  }
}
