import { useEffect, useState } from 'react'
import type { FocusEvent, KeyboardEvent, ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { Segmented } from '../../components/Segmented'
import type { ProposalDifference } from '../../import/review/decisions.ts'
import type { ValidationFinding } from '../../import/validation/validate.ts'
import { codePoints, formatNumber, parseNumber, type FindingState, type Range } from './review-model'
import './review.css'

/**
 * Controlli comuni delle revisioni d'importazione (task 12/13). I campi tengono il testo in locale e
 * registrano una decisione solo quando si esce dal campo (o con Invio): un valore per decisione, mai
 * una decisione per tasto. Nessun taglio né arrotondamento: i limiti si vedono, i problemi li segnalano.
 */

const stateLabels: Record<FindingState, string> = { open: '', stale: 'Da confermare di nuovo: il valore è cambiato', confirmed: 'Confermato', info: 'Informazione' }
const severityLabels = { blocking: 'Da risolvere', confirmation: 'Da confermare', info: 'Informazione' } as const
export const findingLabel = (finding: ValidationFinding, state: FindingState) => state === 'open' ? severityLabels[finding.issue.severity] : stateLabels[state]

export interface FieldIssue { finding: ValidationFinding; state: FindingState }

/** Campo con etichetta, origine del valore, collegamento alla fonte e problemi del campo. */
export function Field({ id, label, origin, issues = [], onSource, group = false, help, children, actions }: {
  id: string
  label: string
  origin?: string | null
  issues?: readonly FieldIssue[]
  onSource?: () => void
  /** Più controlli (intervallo, scelte): gruppo etichettato invece di <label>. */
  group?: boolean
  help?: ReactNode
  children: ReactNode
  actions?: ReactNode
}) {
  const open = issues.some(issue => issue.state === 'open' || issue.state === 'stale')
  const labelId = `${id}-label`
  const head = <div className="rv-field-head">
    {group ? <span id={labelId} className="rv-label">{label}</span> : <label id={labelId} htmlFor={id} className="rv-label">{label}</label>}
    {origin && <span className="rv-origin">{origin}</span>}
    {onSource && <button type="button" className="text-button rv-source-link" onClick={onSource} aria-label={`Mostra nella fonte: ${label}`}><Icon name="info" size={16} />Fonte</button>}
  </div>
  const body = <>
    {head}
    {children}
    {help && <p className="field-help">{help}</p>}
    {issues.filter(issue => issue.state !== 'confirmed').map((issue, index) => <p key={`${issue.finding.issue.code}-${index}`} className={`rv-field-issue is-${issue.finding.issue.severity} is-${issue.state}`}>
      <strong>{findingLabel(issue.finding, issue.state)}:</strong> {issue.finding.issue.message}
    </p>)}
    {actions && <div className="rv-field-actions">{actions}</div>}
  </>
  return group
    ? <div className={`rv-field${open ? ' has-issue' : ''}`} role="group" aria-labelledby={labelId} id={`${id}-group`} tabIndex={-1}>{body}</div>
    : <div className={`rv-field${open ? ' has-issue' : ''}`}>{body}</div>
}

function Counter({ text, max }: { text: string; max?: number }) {
  if (!max) return null
  const length = codePoints(text)
  if (length < max * 0.8) return null
  return <span className={`rv-counter${length > max ? ' is-over' : ''}`} aria-live="polite">{length} / {max} caratteri{length > max ? ' — oltre il limite, da accorciare' : ''}</span>
}

const commitKeys = (commit: () => void, revert: () => void, multiline: boolean) => (event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
  if (event.key === 'Enter' && !multiline) { event.preventDefault(); commit() }
  if (event.key === 'Escape') { event.preventDefault(); revert() }
}

/** Testo: vuoto = non indicato (null) se `nullable`. */
export function TextField({ id, value, onCommit, nullable = true, multiline = false, max, placeholder }: {
  id: string; value: string | null; onCommit: (value: string | null) => void
  nullable?: boolean; multiline?: boolean; max?: number; placeholder?: string
}) {
  const [text, setText] = useState(value ?? '')
  useEffect(() => setText(value ?? ''), [value])
  const commit = () => {
    if (text === (value ?? '')) return
    onCommit(nullable && text === '' ? null : text)
  }
  const revert = () => setText(value ?? '')
  const props = { id, value: text, placeholder: placeholder ?? (nullable ? 'Non indicato' : undefined), onBlur: commit, onKeyDown: commitKeys(commit, revert, multiline) }
  return <>
    {multiline ? <textarea {...props} rows={3} onChange={event => setText(event.target.value)} /> : <input {...props} type="text" onChange={event => setText(event.target.value)} />}
    <Counter text={text} max={max} />
  </>
}

/** Numero: vuoto = non indicato (null); nessun arrotondamento o limite applicato qui. */
export function NumberField({ id, value, onCommit, suffix }: { id: string; value: number | null; onCommit: (value: number | null) => void; suffix?: string }) {
  const shown = value === null ? '' : String(value).replace('.', ',')
  const [text, setText] = useState(shown)
  const [error, setError] = useState(false)
  useEffect(() => { setText(shown); setError(false) }, [shown])
  const commit = () => {
    const parsed = parseNumber(text)
    if (Number.isNaN(parsed)) { setError(true); return }
    setError(false)
    if (parsed !== value) onCommit(parsed)
  }
  return <span className="rv-number">
    <input id={id} type="text" inputMode="decimal" value={text} placeholder="Non indicato" aria-invalid={error || undefined}
      onChange={event => setText(event.target.value)} onBlur={commit} onKeyDown={commitKeys(commit, () => setText(shown), false)} />
    {suffix && <span className="rv-suffix" aria-hidden="true">{suffix}</span>}
    {error && <span className="form-error" role="alert">Scrivi un numero, per esempio 3 o 2,5.</span>}
  </span>
}

/** Intervallo «da … a …»: un solo valore = valore esatto; vuoto = non indicato. */
export function RangeField({ id, value, onCommit, suffix }: { id: string; value: Range | null; onCommit: (value: Range | null) => void; suffix?: string }) {
  const format = (n: number | undefined) => n === undefined ? '' : String(n).replace('.', ',')
  // Un valore esatto si mostra una volta sola: il secondo campo vuoto vale «uguale al primo».
  const shownMax = value && value.min !== value.max ? format(value.max) : ''
  const [min, setMin] = useState(format(value?.min))
  const [max, setMax] = useState(shownMax)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setMin(format(value?.min)); setMax(shownMax); setError(null) }, [value?.min, value?.max, shownMax])
  const commit = () => {
    const low = parseNumber(min), high = parseNumber(max)
    if (Number.isNaN(low) || Number.isNaN(high)) { setError('Scrivi numeri, per esempio 8 e 10.'); return }
    const next = low === null && high === null ? null : { min: (low ?? high)!, max: (high ?? low)! }
    if (next && next.min > next.max) { setError('Il primo valore non può superare il secondo.'); return }
    setError(null)
    if (next?.min !== value?.min || next?.max !== value?.max) onCommit(next)
  }
  const leave = (event: FocusEvent<HTMLSpanElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit() }
  const keys = commitKeys(commit, () => { setMin(format(value?.min)); setMax(shownMax) }, false)
  return <span className="rv-range" onBlur={leave}>
    <input id={id} type="text" inputMode="decimal" aria-label="Da" value={min} placeholder="Non indicato" onChange={event => setMin(event.target.value)} onKeyDown={keys} aria-invalid={Boolean(error) || undefined} />
    <span aria-hidden="true">–</span>
    <input id={`${id}-max`} type="text" inputMode="decimal" aria-label="A" value={max} placeholder="uguale" onChange={event => setMax(event.target.value)} onKeyDown={keys} aria-invalid={Boolean(error) || undefined} />
    {suffix && <span className="rv-suffix" aria-hidden="true">{suffix}</span>}
    {error && <span className="form-error" role="alert">{error}</span>}
  </span>
}

/** Lista di frasi (note, indicazioni, alternative): una riga per voce, aggiunta e rimozione esplicite. */
export function TextListField({ id, values, onCommit, addLabel, itemLabel, max }: {
  id: string; values: readonly string[]; onCommit: (values: string[]) => void; addLabel: string; itemLabel: string; max?: number
}) {
  const [items, setItems] = useState<string[]>([...values])
  const [focusLast, setFocusLast] = useState(false)
  const joined = JSON.stringify(values)
  useEffect(() => setItems(JSON.parse(joined) as string[]), [joined])
  useEffect(() => {
    if (!focusLast) return
    document.getElementById(`${id}-${items.length - 1}`)?.focus()
    setFocusLast(false)
  }, [focusLast, id, items.length])
  // Le righe aggiunte e lasciate vuote non diventano voci.
  const commit = (next: string[]) => {
    const clean = next.filter((text, index) => text !== '' || index < values.length)
    if (JSON.stringify(clean) !== joined) onCommit(clean)
  }
  const leave = (event: FocusEvent<HTMLDivElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commit(items) }
  return <div className="rv-list" onBlur={leave}>
    {items.map((text, index) => <div className="rv-list-item" key={index}>
      <textarea id={`${id}-${index}`} rows={2} value={text} aria-label={`${itemLabel} ${index + 1}`} onChange={event => setItems(items.map((item, at) => at === index ? event.target.value : item))} />
      <button type="button" className="icon-button" aria-label={`Rimuovi ${itemLabel.toLowerCase()} ${index + 1}`} onClick={() => { const next = items.filter((_, at) => at !== index); setItems(next); commit(next) }}><Icon name="close" size={20} /></button>
      <Counter text={text} max={max} />
    </div>)}
    <button type="button" className="text-button" id={`${id}-add`} onClick={() => { setItems([...items, '']); setFocusLast(true) }}><Icon name="plus" size={16} />{addLabel}</button>
  </div>
}

/** Scelta fra poche opzioni; `null` = non indicato, sempre visibile e mai preselezionato al posto dell'utente. */
export function ChoiceField<T extends string>({ labelledBy, value, options, onChange, nullable = true }: {
  labelledBy: string; value: T | null; options: { value: T; label: string }[]; onChange: (value: T | null) => void; nullable?: boolean
}) {
  const all = [...options.map(option => ({ value: option.value as string, label: option.label })), ...(nullable || value === null ? [{ value: '', label: 'Non indicato' }] : [])]
  return <Segmented labelledBy={labelledBy} value={value ?? ''} options={all} onChange={next => onChange(next === '' ? null : next as T)} className="rv-choice" />
}

/** Problema con stato, contesto, fonte e azioni proposte dal dominio. */
export function FindingCard({ finding, state, context, onSource, onGo, actions }: {
  finding: ValidationFinding; state: FindingState; context?: string; onSource?: () => void; onGo?: () => void; actions?: ReactNode
}) {
  return <li className={`rv-finding is-${finding.issue.severity} is-${state}`}>
    <p className="rv-finding-state">{findingLabel(finding, state)}{context && <span> · {context}</span>}</p>
    <p>{finding.issue.message}</p>
    <div className="rv-finding-actions">
      {onGo && <button type="button" className="text-button" onClick={onGo}>Vai al punto</button>}
      {onSource && <button type="button" className="text-button" onClick={onSource}>Mostra nella fonte</button>}
      {actions}
    </div>
  </li>
}

/** Nuova analisi disponibile: confronto con la revisione in corso, adozione solo esplicita. */
export function ReanalysisPanel({ differences, describe, editCount, onAdopt, onDismiss }: {
  differences: readonly ProposalDifference[]; describe: (difference: ProposalDifference) => string; editCount: number
  onAdopt?: () => void; onDismiss?: () => void
}) {
  const verbs = { added: 'Nuovo', removed: 'Non più presente', changed: 'Cambiato' } as const
  return <section className="panel rv-reanalysis" aria-labelledby="rv-reanalysis-title">
    <h2 id="rv-reanalysis-title">Nuova analisi del documento</h2>
    <p>La tua revisione resta com’è finché non scegli. {editCount > 0 ? `Hai fatto ${editCount} ${editCount === 1 ? 'modifica' : 'modifiche'}: usando la nuova analisi riparti dalla nuova proposta, e la revisione attuale resta conservata come precedente.` : 'Non hai ancora modifiche nella revisione attuale.'}</p>
    {differences.length === 0 ? <p className="muted">La nuova analisi coincide con la revisione attuale.</p>
      : <ul className="rv-diff-list">{differences.map(difference => <li key={`${difference.change}-${difference.pointer}`}>
        <strong>{verbs[difference.change]}:</strong> {describe(difference)}{difference.fields.length > 0 && <span className="muted"> ({difference.fields.join(', ')})</span>}
      </li>)}</ul>}
    <div className="button-row">
      {onAdopt && <button type="button" className="button secondary" onClick={onAdopt}>Usa la nuova analisi</button>}
      {onDismiss && <button type="button" className="button secondary" onClick={onDismiss}>Continua con la revisione attuale</button>}
    </div>
  </section>
}

/** Valore scalare scelto dentro un intervallo del documento (timer, RIR, RPE). */
export function ScalarChoice({ id, range, suffix, label, onChoose }: { id: string; range: Range; suffix?: string; label: string; onChoose: (value: number) => void }) {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const choose = () => {
    const value = parseNumber(text)
    if (value === null || Number.isNaN(value)) { setError('Scrivi il valore da usare.'); return }
    setError(null)
    onChoose(value)
  }
  return <div className="rv-scalar">
    <label htmlFor={id}>{label} (documento: {formatNumber(range.min)}–{formatNumber(range.max)}{suffix ?? ''})</label>
    <span className="rv-number">
      <input id={id} type="text" inputMode="decimal" value={text} onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); choose() } }} />
      {suffix && <span className="rv-suffix" aria-hidden="true">{suffix}</span>}
    </span>
    <button type="button" className="button secondary" onClick={choose}>Usa questo valore</button>
    {error && <span className="form-error" role="alert">{error}</span>}
  </div>
}
