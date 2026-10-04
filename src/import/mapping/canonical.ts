/**
 * Canonicalizzazione JSON versionata e impronte dell'importazione (specifica §§12.3, 13).
 * Solo Web API (TextEncoder, crypto.subtle) e import relativi dei contratti: stesso modulo
 * per browser, worker e Deno; la futura implementazione SQL (18) deve riprodurre i vettori di
 * tests/fixtures/import/contracts/.
 *
 * Quattro impronte distinte, mai intercambiabili:
 * - sourceHash: SHA-256 dei byte del file (reader, sul dispositivo). Riconosce il file, non il significato.
 * - normalizedHash: SHA-256 del NormalizedDocument canonico ricevuto, calcolato dal server per cache e job;
 *   il valore dichiarato dal browser non è fidato.
 * - commandHash: comando completo (requestId, payload con ID tecnici e revisioni, provenienza, opzioni):
 *   stesso requestId con hash diverso è un conflitto. Qualsiasi modifica del comando cambia l'hash.
 * - contentHash: significato del piano confermato, senza UUID tecnici, riferimenti provvisori, chiavi locali,
 *   provenienza, opzioni, timestamp o metadati del provider; ordine, valori e identità degli esercizi inclusi.
 *   Propone «sembra già importato», non vieta una copia. Non è `sameContent` di programs.ts, che conserva
 *   gli ID del catalogo e ignora il comando.
 */
import {
  exerciseChoiceValues,
  type CommitCommand, type CommitPayload, type ExerciseChoice, type NormalizedDocument, type ResolvedDietImport, type ResolvedWorkoutImport,
} from '../contracts/index.ts'

/**
 * peppitness.canonical-json.v1:
 * - solo null, boolean, numeri finiti, testi senza NUL né surrogati isolati, liste, oggetti semplici;
 *   undefined, funzioni, classi e buchi nelle liste sono errori, non chiavi omesse;
 * - oggetti con chiavi ordinate per code point Unicode (= ordine dei byte UTF-8, `COLLATE "C"`),
 *   liste nell'ordine dato, nessuno spazio;
 * - testi e chiavi come JSON.stringify / escape_json di PostgreSQL: `\"`, `\\`, `\b \f \n \r \t`,
 *   altri controlli U+0000–U+001F come `\u00xx` minuscolo, tutto il resto letterale (nessuna
 *   normalizzazione Unicode: NFC e NFD restano diversi);
 * - numeri in notazione decimale semplice dalla rappresentazione più corta di ECMAScript, senza
 *   esponente né zeri finali, -0 → 0 (in SQL: `trim_scale(n)::text` sul numeric ricevuto come JSON);
 * - codifica UTF-8, SHA-256 esadecimale minuscolo.
 */
export const CANONICAL_JSON_VERSION = 'peppitness.canonical-json.v1'
export const hashVersions = {
  normalized: 'peppitness.normalized-hash.v1',
  command: 'peppitness.command-hash.v1',
  content: 'peppitness.content-hash.v1',
} as const
/** Protezione contro input ostili: un comando reale usa meno di 10 livelli. */
export const CANONICAL_MAX_DEPTH = 64

export class CanonicalJsonError extends Error {
  readonly path: string
  constructor(path: string, message: string) {
    super(`${message} (${path || 'radice'})`)
    this.name = 'CanonicalJsonError'
    this.path = path
  }
}

const invalidText = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Numero finito in notazione decimale semplice, identica al testo di `trim_scale(numeric)`. */
export function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) throw new CanonicalJsonError('', 'Numero non finito')
  if (value === 0) return '0'
  const sign = value < 0 ? '-' : ''
  const shortest = String(Math.abs(value))
  const match = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(shortest)
  if (!match) return sign + shortest
  const digits = match[1]! + (match[2] ?? '')
  const point = 1 + Number(match[3])
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`
  if (point >= digits.length) return sign + digits + '0'.repeat(point - digits.length)
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

/** Confronto per code point: coincide con l'ordine dei byte UTF-8 anche oltre il piano di base. */
function compareCodePoints(a: string, b: string): number {
  const left = a[Symbol.iterator](), right = b[Symbol.iterator]()
  while (true) {
    const x = left.next(), y = right.next()
    if (x.done || y.done) return x.done ? (y.done ? 0 : -1) : 1
    const difference = x.value.codePointAt(0)! - y.value.codePointAt(0)!
    if (difference !== 0) return difference
  }
}

function canonicalString(value: string, path: string): string {
  if (invalidText.test(value)) throw new CanonicalJsonError(path, 'Testo con NUL o surrogati isolati')
  return JSON.stringify(value)
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function write(value: unknown, path: string, depth: number, out: string[]): void {
  if (value === null) { out.push('null'); return }
  switch (typeof value) {
    case 'boolean': out.push(value ? 'true' : 'false'); return
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError(path, 'Numero non finito')
      out.push(canonicalNumber(value)); return
    case 'string': out.push(canonicalString(value, path)); return
    case 'object': break
    default: throw new CanonicalJsonError(path, `Valore non JSON (${typeof value})`)
  }
  if (depth >= CANONICAL_MAX_DEPTH) throw new CanonicalJsonError(path, 'JSON troppo annidato')
  if (Array.isArray(value)) {
    out.push('[')
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) throw new CanonicalJsonError(`${path}/${index}`, 'Lista con buchi')
      if (index) out.push(',')
      write(value[index], `${path}/${index}`, depth + 1, out)
    }
    out.push(']')
    return
  }
  if (!isPlainObject(value)) throw new CanonicalJsonError(path, 'Oggetto non semplice')
  const record = value
  const keys = Object.keys(record).sort(compareCodePoints)
  out.push('{')
  keys.forEach((key, index) => {
    const child = `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
    if (index) out.push(',')
    out.push(canonicalString(key, child), ':')
    write(record[key], child, depth + 1, out)
  })
  out.push('}')
}

/** Testo canonico V1 di un valore JSON. Lancia CanonicalJsonError per valori non rappresentabili. */
export function canonicalJson(value: unknown): string {
  const out: string[] = []
  write(value, '', 0, out)
  return out.join('')
}

/** SHA-256 esadecimale minuscolo dei byte, o della codifica UTF-8 di un testo. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Impronta di un valore canonico: sha256(utf8(canonicalJson(value))). */
export const canonicalHash = (value: unknown) => sha256Hex(canonicalJson(value))

/** Calcolato dal server sul documento ricevuto e già validato. */
export const normalizedHash = (document: NormalizedDocument) =>
  canonicalHash({ hash: hashVersions.normalized, document })

/** Ingresso canonico del commandHash: in SQL `jsonb_build_object('hash', …, 'requestId', p_request_id, 'payload', p_resolved_payload, 'provenance', p_provenance, 'selectionOptions', p_selection_options)`. */
export const commandHashInput = (command: CommitCommand) => ({
  hash: hashVersions.command,
  requestId: command.requestId,
  payload: command.payload,
  provenance: command.provenance,
  selectionOptions: command.selectionOptions,
})
export const commandHash = (command: CommitCommand) => canonicalHash(commandHashInput(command))

/** Identità significativa di un esercizio: nome e metadati che rendono comparabile lo storico; non ID, fonte o nota. */
function exerciseIdentity(choice: ExerciseChoice) {
  const { name, variant, equipment, loadConvention, loadUnit, measurementMode, perSide } = exerciseChoiceValues(choice)
  return { name, variant, equipment, loadConvention, loadUnit, measurementMode, perSide }
}

function workoutContent(resolved: ResolvedWorkoutImport) {
  const catalog = new Map(resolved.catalog.map(binding => [binding.ref, binding.choice]))
  return {
    title: resolved.title,
    guidance: resolved.guidance,
    cycle: resolved.cycle,
    days: resolved.days.map(day => ({
      label: day.label, title: day.title, note: day.note,
      prescriptions: day.prescriptions.map(prescription => {
        const choice = catalog.get(prescription.exerciseRef)
        if (!choice) throw new CanonicalJsonError('', `Esercizio senza associazione: ${prescription.exerciseRef}`)
        const { id: _id, exerciseRef: _ref, ...values } = prescription
        return { exercise: exerciseIdentity(choice), ...values }
      }),
    })),
  }
}

function dietContent(resolved: ResolvedDietImport) {
  const { name, document } = resolved.plan
  return {
    name,
    guidance: document.guidance,
    days: document.days.map(({ id: _day, meals, ...day }) => ({ ...day, meals: meals.map(({ id: _meal, ...meal }) => meal) })),
  }
}

/** Ingresso canonico del contentHash per un payload valido (validateCommitCommand). */
export const contentHashInput = (payload: CommitPayload) => ({
  hash: hashVersions.content,
  kind: payload.kind,
  content: payload.kind === 'workout' ? workoutContent(payload.resolved) : dietContent(payload.resolved),
})
export const contentHash = (payload: CommitPayload) => canonicalHash(contentHashInput(payload))
