/**
 * Sorgente runtime unica dei contratti import: costruttori minimi di schemi chiusi.
 * Da una sola definizione derivano il tipo TypeScript (Infer), il validatore puro e il
 * JSON Schema 2020-12 che l'adapter del provider potrà tradurre. Nessuna dipendenza:
 * il modulo si importa da Node, browser/worker e Deno con percorsi relativi `.ts`.
 */

/** Protezioni del parsing, non limiti Peppitness: un valore finito oltre i limiti di dominio resta diagnosticabile. */
export const contractLimits = {
  /** Caratteri Unicode di un singolo testo: pari al limite iniziale del testo normalizzato (specifica §4.1). */
  textChars: 200_000,
  idChars: 200,
  versionChars: 100,
  codeChars: 64,
  pointerChars: 1_000,
  /** Elementi di una collezione di prescrizioni, pasti o problemi: molto oltre i limiti di dominio. */
  items: 20_000,
  /** Blocchi del documento e prove: possono superare di molto le prescrizioni. */
  largeItems: 200_000,
  refsPerItem: 2_000,
  /** Estensione massima di una cella unita e celle logiche controllate per documento. */
  cellSpan: 1_000,
  tableCells: 1_000_000,
  errors: 200,
} as const

export type ContractErrorCode =
  | 'invalid_json' | 'type' | 'missing_key' | 'unknown_key' | 'const' | 'enum'
  | 'not_finite' | 'not_integer' | 'below_minimum' | 'above_maximum'
  | 'too_short' | 'too_long' | 'pattern' | 'invalid_text' | 'too_few_items' | 'too_many_items'
  | 'range_order' | 'json_pointer' | 'root_pointer' | 'bbox_bounds' | 'bbox_without_page'
  | 'table_coordinates' | 'duplicate_table_row' | 'overlapping_cells'
  | 'duplicate_id' | 'duplicate_ref' | 'dangling_ref' | 'self_ref' | 'parent_cycle' | 'heading_ref'
  | 'non_canonical_text' | 'reader_mismatch' | 'inventory' | 'too_many_errors'
  // Contratti di revisione, conferma e jobs (task 02).
  | 'too_deep' | 'not_trimmed' | 'blank_text' | 'invalid_date' | 'too_large' | 'kind_mismatch'
  | 'unknown_field' | 'parent_mismatch' | 'missing_local_id' | 'no_op_decision' | 'decision_reason'
  | 'unused_binding' | 'binding_mismatch' | 'mode_mismatch' | 'selection_options' | 'status_mismatch'

/** `path` è un JSON Pointer RFC 6901 sul valore validato; '' indica la radice. */
export interface ContractError { path: string; code: ContractErrorCode; message: string }
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: ContractError[] }

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

/** Regola fra campi, eseguita solo se la forma sottostante è valida. `report` riceve un percorso relativo. */
export interface Rule<T> {
  code: ContractErrorCode
  description: string
  check(value: T, report: (relativePath: string, message: string) => void): void
}

type Node =
  | { type: 'string'; minLength: number; maxLength: number; pattern: RegExp | null }
  | { type: 'number'; integer: boolean; minimum: number | null; maximum: number | null }
  | { type: 'boolean' }
  | { type: 'enum'; values: readonly string[] }
  | { type: 'nullable'; inner: Node }
  | { type: 'array'; items: Node; minItems: number; maxItems: number }
  | { type: 'tuple'; items: readonly Node[] }
  | { type: 'object'; properties: Readonly<Record<string, Node>> }
  | { type: 'union'; key: string; variants: Readonly<Record<string, Node>> }
  | { type: 'json'; maxDepth: number }
  | { type: 'refine'; inner: Node; rules: readonly Rule<never>[]; json: JsonObject }

/** `__output` esiste solo nel tipo: collega lo schema alla forma inferita. */
export interface Schema<T> { readonly node: Node; readonly __output: T }
export type Infer<S> = S extends Schema<infer T> ? T : never
export type InferProperties<P> = { [K in keyof P]: Infer<P[K]> }

const schema = <T>(node: Node): Schema<T> => ({ node }) as Schema<T>

export function string(options: { minLength?: number; maxLength: number; pattern?: RegExp }): Schema<string> {
  return schema({ type: 'string', minLength: options.minLength ?? 0, maxLength: options.maxLength, pattern: options.pattern ?? null })
}
/** Sempre finito: NaN e Infinity sono rifiutati anche nell'API interna. */
export function number(options: { integer?: boolean; minimum?: number; maximum?: number } = {}): Schema<number> {
  return schema({ type: 'number', integer: options.integer ?? false, minimum: options.minimum ?? null, maximum: options.maximum ?? null })
}
export function boolean(): Schema<boolean> { return schema({ type: 'boolean' }) }
export function literal<const V extends string>(value: V): Schema<V> { return schema({ type: 'enum', values: [value] }) }
export function enumeration<const V extends readonly [string, ...string[]]>(values: V): Schema<V[number]> {
  return schema({ type: 'enum', values })
}
export function nullable<T>(inner: Schema<T>): Schema<T | null> { return schema({ type: 'nullable', inner: inner.node }) }
export function array<T>(items: Schema<T>, options: { minItems?: number; maxItems: number }): Schema<T[]> {
  return schema({ type: 'array', items: items.node, minItems: options.minItems ?? 0, maxItems: options.maxItems })
}
export function tuple<const S extends readonly Schema<unknown>[]>(...items: S): Schema<{ -readonly [K in keyof S]: Infer<S[K]> }> {
  return schema({ type: 'tuple', items: items.map(item => item.node) })
}
/** Oggetto chiuso: ogni chiave dichiarata è obbligatoria, ogni chiave extra è un errore. */
export function object<P extends Record<string, Schema<unknown>>>(properties: P): Schema<InferProperties<P>> {
  return schema({ type: 'object', properties: Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, value.node])) })
}
export function refine<T>(inner: Schema<T>, rules: readonly Rule<T>[], json: JsonObject = {}): Schema<T> {
  return schema({ type: 'refine', inner: inner.node, rules: rules as readonly Rule<never>[], json })
}

function objectNode(target: Schema<unknown>, builder: string) {
  if (target.node.type !== 'object') throw new TypeError(`${builder}: serve uno schema object() senza refine.`)
  return target.node
}
/** Sottoinsieme chiuso di un oggetto: stesse regole per le chiavi scelte, nessuna copia della definizione. */
export function pick<T, const K extends keyof T & string>(target: Schema<T>, keys: readonly K[]): Schema<Pick<T, K>> {
  const { properties } = objectNode(target, 'pick')
  return schema({ type: 'object', properties: Object.fromEntries(keys.map(key => {
    if (!Object.hasOwn(properties, key)) throw new TypeError(`pick: chiave assente ${key}.`)
    return [key, properties[key]!]
  })) })
}
/** Schemi dei singoli campi di un oggetto chiuso, per validare una modifica a un solo campo. */
export function objectFields(target: Schema<unknown>): ReadonlyMap<string, Schema<unknown>> {
  return new Map(Object.entries(objectNode(target, 'objectFields').properties).map(([key, node]) => [key, schema<unknown>(node)]))
}
/**
 * Union chiusa con discriminante testuale: ogni variante è un object() con `key` literal.
 * Un discriminante sconosciuto è un errore `enum`, mai una variante scelta per tentativi.
 */
export function taggedUnion<const K extends string, const V extends readonly Schema<{ [P in K]: string }>[]>(key: K, variants: V): Schema<Infer<V[number]>> {
  const byTag: Record<string, Node> = {}
  for (const variant of variants) {
    const tag = objectNode(variant, 'taggedUnion').properties[key]
    if (!tag || tag.type !== 'enum' || tag.values.length !== 1) throw new TypeError(`taggedUnion: ogni variante dichiara ${key} con literal().`)
    if (Object.hasOwn(byTag, tag.values[0]!)) throw new TypeError(`taggedUnion: variante ripetuta ${tag.values[0]}.`)
    byTag[tag.values[0]!] = variant.node
  }
  return schema({ type: 'union', key, variants: byTag })
}
/**
 * Qualsiasi valore JSON (null, boolean, numero finito, testo valido, lista, oggetto semplice)
 * entro una profondità massima: per valori «prima/dopo» validati poi contro lo schema del campo.
 */
export function jsonValue(options: { maxDepth: number }): Schema<JsonValue> { return schema({ type: 'json', maxDepth: options.maxDepth }) }

/** UUID in forma canonica minuscola, come `valid_uuid` del database e `crypto.randomUUID()`. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
export const uuidSchema = string({ minLength: 36, maxLength: 36, pattern: UUID_PATTERN })
/** SHA-256 esadecimale minuscolo (sourceHash, normalizedHash, commandHash, contentHash). */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/
export const sha256HexSchema = string({ minLength: 64, maxLength: 64, pattern: SHA256_HEX_PATTERN })

/** Elenco di errori con tetto: un input ostile non produce elenchi illimitati. */
export function errorList() {
  const errors: ContractError[] = []
  let full = false
  return {
    errors,
    get full() { return full },
    add(path: string, code: ContractErrorCode, message: string) {
      if (full) return
      if (errors.length >= contractLimits.errors) {
        errors.push({ path, code: 'too_many_errors', message: 'Troppi errori: elenco interrotto.' })
        full = true
        return
      }
      errors.push({ path, code, message })
    },
  }
}
type Errors = ReturnType<typeof errorList>

export const escapePointerToken = (token: string) => token.replace(/~/g, '~0').replace(/\//g, '~1')

// NUL non è ammesso in jsonb; i surrogati isolati cambierebbero in UTF-8.
const invalidText = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
const describe = (value: unknown) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

function check(node: Node, value: unknown, path: string, errors: Errors): boolean {
  if (errors.full) return false
  const fail = (code: ContractErrorCode, message: string) => { errors.add(path, code, message); return false }
  switch (node.type) {
    case 'string': {
      if (typeof value !== 'string') return fail('type', `Atteso un testo, trovato ${describe(value)}.`)
      if (invalidText.test(value)) return fail('invalid_text', 'Testo con NUL o surrogati Unicode isolati.')
      // Conta i code point, come PostgreSQL, solo quando le unità UTF-16 non bastano a decidere.
      const units = value.length
      const length = units > node.maxLength || units < node.minLength * 2 ? [...value].length : units
      if (length < node.minLength) return fail('too_short', `Almeno ${node.minLength} caratteri.`)
      if (length > node.maxLength) return fail('too_long', `Al massimo ${node.maxLength} caratteri.`)
      if (node.pattern && !node.pattern.test(value)) return fail('pattern', 'Formato non valido.')
      return true
    }
    case 'number': {
      if (typeof value !== 'number') return fail('type', `Atteso un numero, trovato ${describe(value)}.`)
      if (!Number.isFinite(value)) return fail('not_finite', 'Il numero deve essere finito.')
      if (node.integer && !Number.isInteger(value)) return fail('not_integer', 'Atteso un intero.')
      if (node.minimum !== null && value < node.minimum) return fail('below_minimum', `Minimo ${node.minimum}.`)
      if (node.maximum !== null && value > node.maximum) return fail('above_maximum', `Massimo ${node.maximum}.`)
      return true
    }
    case 'boolean':
      return typeof value === 'boolean' || fail('type', `Atteso true o false, trovato ${describe(value)}.`)
    case 'enum':
      if (typeof value === 'string' && node.values.includes(value)) return true
      return node.values.length === 1
        ? fail('const', `Atteso "${node.values[0]}".`)
        : fail('enum', `Valori ammessi: ${node.values.join(', ')}.`)
    case 'nullable':
      return value === null || check(node.inner, value, path, errors)
    case 'array': {
      if (!Array.isArray(value)) return fail('type', `Attesa una lista, trovato ${describe(value)}.`)
      if (value.length < node.minItems) return fail('too_few_items', `Almeno ${node.minItems} elementi.`)
      if (value.length > node.maxItems) return fail('too_many_items', `Al massimo ${node.maxItems} elementi.`)
      let ok = true
      for (let index = 0; index < value.length; index++) ok = check(node.items, value[index], `${path}/${index}`, errors) && ok
      return ok
    }
    case 'tuple': {
      if (!Array.isArray(value)) return fail('type', `Attesa una lista, trovato ${describe(value)}.`)
      if (value.length !== node.items.length) return fail(value.length < node.items.length ? 'too_few_items' : 'too_many_items', `Attesi esattamente ${node.items.length} elementi.`)
      let ok = true
      node.items.forEach((item, index) => { ok = check(item, value[index], `${path}/${index}`, errors) && ok })
      return ok
    }
    case 'object': {
      if (!isPlainObject(value)) return fail('type', `Atteso un oggetto, trovato ${describe(value)}.`)
      let ok = true
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(node.properties, key)) { errors.add(`${path}/${escapePointerToken(key)}`, 'unknown_key', 'Chiave non prevista dal contratto.'); ok = false }
      }
      for (const [key, child] of Object.entries(node.properties)) {
        const childPath = `${path}/${escapePointerToken(key)}`
        if (!Object.hasOwn(value, key)) { errors.add(childPath, 'missing_key', 'Chiave obbligatoria assente: usare null o [] per l’ignoto.'); ok = false }
        else ok = check(child, value[key], childPath, errors) && ok
      }
      return ok
    }
    case 'union': {
      if (!isPlainObject(value)) return fail('type', `Atteso un oggetto, trovato ${describe(value)}.`)
      const tagPath = `${path}/${escapePointerToken(node.key)}`
      if (!Object.hasOwn(value, node.key)) { errors.add(tagPath, 'missing_key', 'Discriminante obbligatorio assente.'); return false }
      const tag = value[node.key]
      if (typeof tag !== 'string' || !Object.hasOwn(node.variants, tag)) {
        errors.add(tagPath, 'enum', `Valori ammessi: ${Object.keys(node.variants).join(', ')}.`)
        return false
      }
      return check(node.variants[tag]!, value, path, errors)
    }
    case 'json':
      return checkJson(value, path, node.maxDepth, errors)
    case 'refine': {
      if (!check(node.inner, value, path, errors)) return false
      let ok = true
      for (const rule of node.rules) {
        (rule.check as (value: unknown, report: (relativePath: string, message: string) => void) => void)(value, (relativePath, message) => {
          errors.add(path + relativePath, rule.code, message); ok = false
        })
      }
      return ok
    }
  }
}

function checkJson(value: unknown, path: string, depth: number, errors: Errors): boolean {
  if (errors.full) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return true
    errors.add(path, 'not_finite', 'Il numero deve essere finito.'); return false
  }
  if (typeof value === 'string') {
    if (invalidText.test(value)) { errors.add(path, 'invalid_text', 'Testo con NUL o surrogati Unicode isolati.'); return false }
    if (value.length > contractLimits.textChars && [...value].length > contractLimits.textChars) { errors.add(path, 'too_long', `Al massimo ${contractLimits.textChars} caratteri.`); return false }
    return true
  }
  const container = Array.isArray(value) || isPlainObject(value)
  if (!container) { errors.add(path, 'type', `Atteso un valore JSON, trovato ${describe(value)}.`); return false }
  if (depth <= 0) { errors.add(path, 'too_deep', 'Valore JSON troppo annidato.'); return false }
  const entries: [string, unknown][] = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value)
  if (entries.length > contractLimits.largeItems) { errors.add(path, 'too_many_items', `Al massimo ${contractLimits.largeItems} elementi.`); return false }
  let ok = true
  for (const [key, child] of entries) {
    if (!Array.isArray(value) && invalidText.test(key)) { errors.add(path, 'invalid_text', 'Chiave con NUL o surrogati Unicode isolati.'); ok = false; continue }
    ok = checkJson(child, `${path}/${escapePointerToken(key)}`, depth - 1, errors) && ok
  }
  return ok
}

/** Valida senza copiare né convertire: null, 0 e false arrivano intatti al chiamante. */
export function validate<T>(target: Schema<T>, value: unknown): ValidationResult<T> {
  const errors = errorList()
  check(target.node, value, '', errors)
  return errors.errors.length ? { ok: false, errors: errors.errors } : { ok: true, value: value as T }
}

/** JSON non leggibile resta un errore distinto da uno schema violato o da un valore fuori limite. */
export function parseJson(text: string): ValidationResult<unknown> {
  try { return { ok: true, value: JSON.parse(text) as unknown } }
  catch { return { ok: false, errors: [{ path: '', code: 'invalid_json', message: 'JSON non leggibile.' }] } }
}

function nodeToJson(node: Node): JsonObject {
  switch (node.type) {
    case 'string': return {
      type: 'string',
      ...(node.minLength > 0 ? { minLength: node.minLength } : {}),
      maxLength: node.maxLength,
      ...(node.pattern ? { pattern: node.pattern.source } : {}),
    }
    case 'number': return {
      type: node.integer ? 'integer' : 'number',
      ...(node.minimum !== null ? { minimum: node.minimum } : {}),
      ...(node.maximum !== null ? { maximum: node.maximum } : {}),
    }
    case 'boolean': return { type: 'boolean' }
    case 'enum': return node.values.length === 1 ? { type: 'string', const: node.values[0]! } : { type: 'string', enum: [...node.values] }
    case 'nullable': return { anyOf: [nodeToJson(node.inner), { type: 'null' }] }
    case 'array': return {
      type: 'array', items: nodeToJson(node.items),
      ...(node.minItems > 0 ? { minItems: node.minItems } : {}),
      maxItems: node.maxItems,
    }
    case 'tuple': return {
      type: 'array', prefixItems: node.items.map(nodeToJson), items: false,
      minItems: node.items.length, maxItems: node.items.length,
    }
    case 'object': return {
      type: 'object',
      properties: Object.fromEntries(Object.entries(node.properties).map(([key, child]) => [key, nodeToJson(child)])),
      required: Object.keys(node.properties),
      additionalProperties: false,
    }
    case 'union': return { oneOf: Object.values(node.variants).map(nodeToJson) }
    case 'json': return { $comment: `Qualsiasi valore JSON, profondità massima ${node.maxDepth}.` }
    case 'refine': return { ...nodeToJson(node.inner), ...node.json, $comment: node.rules.map(rule => rule.description).join(' ') }
  }
}

/**
 * JSON Schema 2020-12 derivato, con `$id` di radice. I vincoli fra campi compaiono come
 * `$comment`: restano applicati dal validatore, anche se un provider ne supporta solo una parte.
 */
export function toJsonSchema(target: Schema<unknown>, root: { id: string; title: string }): JsonObject {
  return { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: root.id, title: root.title, ...nodeToJson(target.node) }
}
