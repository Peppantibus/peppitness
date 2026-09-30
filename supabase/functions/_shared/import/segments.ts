/**
 * Segmentazione e ricomposizione dell'analisi (specifica §4.5, task 17). Documento breve = una
 * chiamata. Oltre il budget si divide solo per sezioni complete (titoli), mai dentro una tabella,
 * una riga o un blocco; il contesto globale (blocchi prima del primo titolo di sezione) e i titoli
 * antenati si ripetono in ogni segmento. Se la partizione non entra nel numero di chiamate o un'unità
 * da sola supera il budget, serve una selezione esplicita: nessun sottoinsieme estratto in automatico.
 * I segmenti usano gli stessi ID e testi della fonte: nessun blocco nuovo, nessun DTO diverso.
 */
import {
  contractLimits, extractionIssueCodes, validateExtraction,
  type DietExtraction, type ExtractionFor, type ExtractionKind, type ExtractionIssue, type NormalizedDocument,
  type SourceBlock, type WorkoutExtraction,
} from './contracts.ts'

// ---------------------------------------------------------------------------
// Piano dei segmenti
// ---------------------------------------------------------------------------

export interface DocumentSegment {
  index: number
  document: NormalizedDocument
  /** Blocchi propri del segmento (manifest), in ordine di fonte. */
  ownBlockIds: string[]
  /** Blocchi ripetuti come contesto (preambolo, titoli antenati, genitori). */
  contextBlockIds: string[]
}
export type SegmentPlan =
  | { status: 'single'; segments: [DocumentSegment] }
  | { status: 'segmented'; segments: DocumentSegment[] }
  | { status: 'selection_required'; reason: 'unit_too_large' | 'too_many_segments'; segmentsNeeded: number | null; maxSegments: number }

/** Profondità massima dei titoli usati come confine (sezione, sottosezione, paragrafo). */
const MAX_SPLIT_DEPTH = 3

/** Blocchi di una stessa tabella (anche annidata) o figli dello stesso genitore non si separano. */
function tableRoot(block: SourceBlock, byId: ReadonlyMap<string, SourceBlock>): string | null {
  let current: SourceBlock | undefined = block
  let root: string | null = null
  const seen = new Set<string>()
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    if (current.tableId !== null) root = current.tableId
    current = current.parentId === null ? undefined : byId.get(current.parentId)
  }
  return root
}

function topAncestor(block: SourceBlock, byId: ReadonlyMap<string, SourceBlock>): string {
  let current = block
  const seen = new Set<string>([block.id])
  while (current.parentId !== null) {
    const parent = byId.get(current.parentId)
    if (!parent || seen.has(parent.id)) break
    seen.add(parent.id)
    current = parent
  }
  return current.id
}

interface Unit { blocks: SourceBlock[] }

/**
 * Unità indivisibili al livello `depth`: nuova unità a ogni titolo con `depth` antenati, fuori dalle
 * tabelle; poi si uniscono le unità che condividono una tabella o una catena di genitori.
 */
function splitUnits(blocks: readonly SourceBlock[], depth: number, byId: ReadonlyMap<string, SourceBlock>): Unit[] {
  const units: SourceBlock[][] = []
  for (const block of blocks) {
    const boundary = block.kind === 'heading' && block.headingIds.length === depth && block.parentId === null && tableRoot(block, byId) === null
    if (boundary || !units.length) units.push([])
    units.at(-1)!.push(block)
  }
  const keys = (block: SourceBlock) => {
    const table = tableRoot(block, byId)
    return table === null ? [`r:${topAncestor(block, byId)}`] : [`r:${topAncestor(block, byId)}`, `t:${table}`]
  }
  const merged: SourceBlock[][] = []
  const owner = new Map<string, number>()
  for (const unit of units) {
    let target = -1
    for (const block of unit) for (const key of keys(block)) {
      const at = owner.get(key)
      if (at !== undefined) target = target < 0 ? at : Math.min(target, at)
    }
    if (target < 0) { merged.push([...unit]); target = merged.length - 1 }
    else merged[target]!.push(...merged.splice(target + 1).flat(), ...unit)
    for (const block of merged[target]!) for (const key of keys(block)) owner.set(key, target)
  }
  return merged.map(group => ({ blocks: group }))
}

/** Documento del segmento: contesto + blocchi propri + antenati referenziati, in ordine di fonte. */
export function buildSegmentDocument(document: NormalizedDocument, own: ReadonlySet<string>, context: ReadonlySet<string>): { document: NormalizedDocument; contextIds: string[] } {
  const byId = new Map(document.blocks.map(block => [block.id, block]))
  const included = new Set<string>([...own, ...context])
  const pending = [...included]
  while (pending.length) {
    const block = byId.get(pending.pop()!)
    if (!block) continue
    for (const id of [...block.headingIds, ...(block.parentId === null ? [] : [block.parentId])]) {
      if (!included.has(id) && byId.has(id)) { included.add(id); pending.push(id) }
    }
  }
  const blocks = document.blocks.filter(block => included.has(block.id))
  const readingIssues = document.readingIssues
    .filter(issue => issue.sourceRefs.length === 0 || issue.sourceRefs.some(id => included.has(id)))
    .map(issue => ({ ...issue, sourceRefs: issue.sourceRefs.filter(id => included.has(id)) }))
  return {
    document: { readerVersion: document.readerVersion, sourceHash: document.sourceHash, blocks, readingIssues },
    contextIds: blocks.filter(block => !own.has(block.id)).map(block => block.id),
  }
}

/**
 * `fits(document)` misura il body completo della chiamata (prompt, schema e documento) contro il budget.
 * `maxSegments` è il numero di chiamate ancora disponibili per l'analisi, retry compresi.
 */
export function planSegments(document: NormalizedDocument, fits: (segment: NormalizedDocument) => boolean, maxSegments: number): SegmentPlan {
  const whole: DocumentSegment = { index: 0, document, ownBlockIds: document.blocks.map(block => block.id), contextBlockIds: [] }
  if (fits(document)) return { status: 'single', segments: [whole] }
  const byId = new Map(document.blocks.map(block => [block.id, block]))
  const firstSection = document.blocks.findIndex(block => block.kind === 'heading' && block.headingIds.length === 0 && tableRoot(block, byId) === null)
  if (firstSection < 0) return { status: 'selection_required', reason: 'unit_too_large', segmentsNeeded: null, maxSegments }
  const preamble = new Set(document.blocks.slice(0, firstSection).map(block => block.id))
  const body = document.blocks.slice(firstSection)

  const segmentOf = (own: readonly SourceBlock[]) => buildSegmentDocument(document, new Set(own.map(block => block.id)), preamble)
  const fitsOwn = (own: readonly SourceBlock[]) => fits(segmentOf(own).document)
  /** Unità che entrano da sole, suddividendo per titoli più profondi quando serve. */
  const fitting = (blocks: readonly SourceBlock[], depth: number): Unit[] | null => {
    const result: Unit[] = []
    for (const unit of splitUnits(blocks, depth, byId)) {
      if (fitsOwn(unit.blocks)) { result.push(unit); continue }
      if (depth + 1 >= MAX_SPLIT_DEPTH) return null
      const nested = fitting(unit.blocks, depth + 1)
      if (!nested || nested.length < 2) return null
      result.push(...nested)
    }
    return result
  }
  const units = fitting(body, 0)
  if (!units) return { status: 'selection_required', reason: 'unit_too_large', segmentsNeeded: null, maxSegments }

  // Accorpamento goloso in ordine di fonte: meno chiamate, sezioni contigue insieme.
  const groups: SourceBlock[][] = []
  for (const unit of units) {
    const last = groups.at(-1)
    if (last && fitsOwn([...last, ...unit.blocks])) last.push(...unit.blocks)
    else groups.push([...unit.blocks])
  }
  if (groups.length > maxSegments) return { status: 'selection_required', reason: 'too_many_segments', segmentsNeeded: groups.length, maxSegments }
  const segments = groups.map((own, index) => {
    const built = segmentOf(own)
    return { index, document: built.document, ownBlockIds: own.map(block => block.id), contextBlockIds: built.contextIds }
  })
  return segments.length === 1 ? { status: 'single', segments: [segments[0]!] } : { status: 'segmented', segments }
}

// ---------------------------------------------------------------------------
// Ricomposizione
// ---------------------------------------------------------------------------

export interface SegmentResult<K extends ExtractionKind> {
  segment: DocumentSegment
  extraction: ExtractionFor<K>
}

type Extraction = WorkoutExtraction | DietExtraction
type Collection = 'guidance' | 'sessions' | 'complexRules' | 'days' | 'globalRules' | 'unassigned'
const escape = (token: string) => token.replace(/~/g, '~0').replace(/\//g, '~1')

function tokens(pointer: string): string[] {
  return pointer === '' ? [] : pointer.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))
}
/** Blocchi citati dalle prove di un elemento (puntatore `prefix` o discendenti). */
function citedBlocks(extraction: Extraction, prefix: string): string[] {
  const ids = new Set<string>()
  for (const entry of extraction.evidence) {
    if (entry.path === prefix || entry.path.startsWith(`${prefix}/`)) for (const span of entry.spans) ids.add(span.blockId)
  }
  return [...ids].sort()
}
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Ricompone in ordine di fonte (ordine dei segmenti). Si deduplica solo un'identità di fonte verificabile:
 * stesso valore citato dagli stessi blocchi, tutti di contesto condiviso. Numeri uguali in righe diverse
 * restano distinti. Regole con gli stessi sourceRefs ma testo diverso: prima tenuta, conflitto segnalato.
 * Puntatori di evidence, issues e targetPaths sono rimappati sugli indici finali.
 */
export function mergeSegmentExtractions<K extends ExtractionKind>(kind: K, results: readonly SegmentResult<K>[]): ExtractionFor<K> {
  if (results.length === 1) return results[0]!.extraction
  const shared = new Set<string>()
  for (const result of results) for (const id of result.segment.contextBlockIds) shared.add(id)
  const onlyShared = (ids: readonly string[]) => ids.length > 0 && ids.every(id => shared.has(id))

  const collections: Collection[] = kind === 'workout' ? ['guidance', 'sessions', 'complexRules', 'unassigned'] : ['guidance', 'days', 'globalRules', 'unassigned']
  const merged: Record<string, unknown[]> = Object.fromEntries(collections.map(name => [name, []]))
  const identities: Record<string, { value: unknown; cited: string[] }[]> = Object.fromEntries(collections.map(name => [name, []]))
  const issues: ExtractionIssue[] = []
  const evidence: Extraction['evidence'] = []
  let title: string | null = null
  let titleSource = -1
  let schedule: WorkoutExtraction['schedule'] = 'unknown'
  let scheduleSource = -1
  const cycle: { startDate: string | null; weeks: number | null } = { startDate: null, weeks: null }
  const cycleSource: Record<'startDate' | 'weeks', number> = { startDate: -1, weeks: -1 }
  const extracted = results.filter(result => result.extraction.outcome === 'extracted')

  results.forEach((result, segmentIndex) => {
    const extraction = result.extraction as Extraction
    if (extraction.outcome !== 'extracted') {
      if (extraction.outcome !== 'no_relevant_content' && extracted.length) {
        issues.push({
          code: extraction.outcome === 'unreadable' ? 'unreadable' : 'unsupported', path: '',
          sourceRefs: result.segment.ownBlockIds.slice(0, contractLimits.refsPerItem),
          message: extraction.outcome === 'unreadable' ? 'Una parte del documento non è leggibile.' : `Una parte del documento non è stata interpretata come ${kind === 'workout' ? 'scheda' : 'dieta'}.`,
        })
      }
      return
    }
    /** Mappa indice locale → finale (null = duplicato di fonte già presente). */
    const maps: Partial<Record<Collection, (number | null)[]>> = {}
    for (const name of collections) {
      const list = (extraction as unknown as Record<string, unknown[]>)[name]!
      maps[name] = list.map((value, index) => {
        const pointer = `/${name}/${index}`
        const cited = name === 'unassigned' || name === 'complexRules' || name === 'globalRules'
          ? [...(value as { sourceRefs: string[] }).sourceRefs].sort()
          : citedBlocks(extraction, pointer)
        const known = identities[name]!
        const duplicate = known.findIndex(entry => sameJson(entry.value, value) && sameJson(entry.cited, cited) && onlyShared(cited))
        if (duplicate >= 0) return null
        if ((name === 'complexRules' || name === 'globalRules') && onlyShared(cited)) {
          const conflict = known.findIndex(entry => sameJson(entry.cited, cited) && !sameJson(entry.value, value))
          if (conflict >= 0) {
            issues.push({ code: 'conflicting', path: `/${name}/${conflict}`, sourceRefs: cited, message: 'La stessa regola è stata interpretata in modo diverso fra segmenti del documento.' })
            return null
          }
        }
        known.push({ value, cited })
        merged[name]!.push(structuredClone(value))
        return merged[name]!.length - 1
      })
    }
    const scalarOwner = (field: string): boolean => {
      if (field === 'title') return titleSource === segmentIndex
      if (field === 'schedule') return scheduleSource === segmentIndex
      if (field === 'cycle/startDate') return cycleSource.startDate === segmentIndex
      if (field === 'cycle/weeks') return cycleSource.weeks === segmentIndex
      return false
    }
    if (extraction.title !== null && title === null) { title = extraction.title; titleSource = segmentIndex }
    if (extraction.kind === 'workout') {
      if (extraction.schedule !== 'unknown') {
        if (schedule === 'unknown') { schedule = extraction.schedule; scheduleSource = segmentIndex }
        else if (schedule !== extraction.schedule) {
          issues.push({ code: 'conflicting', path: '/schedule', sourceRefs: [], message: 'Organizzazione delle sedute diversa fra parti del documento.' })
        }
      }
      for (const field of ['startDate', 'weeks'] as const) {
        const value = extraction.cycle[field]
        if (value === null) continue
        if (cycle[field] === null) { (cycle as Record<string, unknown>)[field] = value; cycleSource[field] = segmentIndex }
        else if (cycle[field] !== value) issues.push({ code: 'conflicting', path: `/cycle/${field}`, sourceRefs: [], message: 'Ciclo indicato in modo diverso fra parti del documento.' })
      }
    }
    /** null = puntatore di un elemento scartato o di uno scalare fornito da un altro segmento. */
    const remap = (pointer: string): string | null => {
      const parts = tokens(pointer)
      if (!parts.length) return ''
      const [head, index, ...rest] = parts
      const map = maps[head as Collection]
      if (map) {
        const target = map[Number(index)]
        return target === undefined || target === null ? null : `/${head}/${target}${rest.map(part => `/${escape(part)}`).join('')}`
      }
      return scalarOwner(parts.join('/')) || (head === 'cycle' && scalarOwner(`cycle/${index}`)) ? pointer : null
    }
    for (const entry of extraction.evidence) {
      const path = remap(entry.path)
      if (path) evidence.push({ path, spans: structuredClone(entry.spans) })
    }
    for (const issue of extraction.issues) {
      const path = remap(issue.path)
      if (path !== null) issues.push({ ...structuredClone(issue), path })
    }
    if (kind === 'workout') {
      const rules = merged.complexRules as WorkoutExtraction['complexRules']
      maps.complexRules!.forEach(target => {
        if (target === null) return
        const rule = rules[target]!
        rule.targetPaths = rule.targetPaths.map(remap).filter((path): path is string => path !== null && path !== '')
      })
    }
  })

  const common = {
    schemaVersion: '1.0' as const,
    outcome: extracted.length ? 'extracted' as const : results[0]!.extraction.outcome,
    title: extracted.length ? title : null,
    guidance: merged.guidance as string[],
  }
  const tail = {
    evidence, unassigned: merged.unassigned as Extraction['unassigned'],
    issues: issues.filter(issue => (extractionIssueCodes as readonly string[]).includes(issue.code)).slice(0, contractLimits.items),
  }
  const value: Extraction = kind === 'workout'
    ? { ...common, kind: 'workout', schedule, cycle, sessions: merged.sessions as WorkoutExtraction['sessions'], complexRules: merged.complexRules as WorkoutExtraction['complexRules'], ...tail }
    : { ...common, kind: 'diet', days: merged.days as DietExtraction['days'], globalRules: merged.globalRules as DietExtraction['globalRules'], ...tail }
  // Ordine delle chiavi come nel contratto (contenuto prima delle prove).
  const ordered = kind === 'workout'
    ? (({ schemaVersion, kind: k, outcome, title: t, guidance, schedule: s, cycle: c, sessions, complexRules, evidence: e, issues: i, unassigned }) => ({ schemaVersion, kind: k, outcome, title: t, guidance, schedule: s, cycle: c, sessions, complexRules, evidence: e, issues: i, unassigned }))(value as WorkoutExtraction)
    : (({ schemaVersion, kind: k, outcome, title: t, guidance, days, globalRules, evidence: e, issues: i, unassigned }) => ({ schemaVersion, kind: k, outcome, title: t, guidance, days, globalRules, evidence: e, issues: i, unassigned }))(value as DietExtraction)
  const checked = validateExtraction(kind, ordered)
  if (!checked.ok) throw new TypeError('Merged extraction violates the contract')
  return checked.value
}
