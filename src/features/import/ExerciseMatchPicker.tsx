import { useMemo, useState } from 'react'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { Segmented } from '../../components/Segmented'
import { domainLimits, exerciseChoiceValues, type CatalogExerciseValues, type ExerciseChoice } from '../../import/contracts/index.ts'
import {
  chooseCatalogExercise, chooseNewExercise, identityFields, matchExercises, normalizeExerciseName,
  type CatalogSnapshot, type ExerciseCandidate, type MatchOccurrence,
} from '../../import/matching/exercises.ts'
import { loadLabels, modeLabels } from '../../domain/exercises.ts'
import './review.css'
import './workout-review.css'

/**
 * Scelta dell'esercizio del catalogo per un'occorrenza del documento (task 12): candidati del matching (08)
 * letti dallo snapshot, ricerca nel catalogo, riuso di un nuovo esercizio già scelto in questa revisione o
 * nuovo esercizio con metadati confermati. Produce solo una decisione existing/shared/new: nessuna scrittura,
 * nessuna adozione, nessuna creazione (arrivano con la conferma finale, nella transazione del server).
 */
export interface ReusableNewExercise { localKey: string; values: CatalogExerciseValues; usedBy: string }

type IdentityField = typeof identityFields[number]
const identityLabels: Record<IdentityField, string> = {
  variant: 'Variante', equipment: 'Attrezzo', measurementMode: 'Misura', perSide: 'Per lato', loadUnit: 'Unità del carico', loadConvention: 'Tipo di carico',
}
const unitLabels = { kg: 'kg', lb: 'lb' } as const
function showValue(field: IdentityField, value: unknown): string {
  if (value === null || value === undefined) return 'non indicato'
  if (field === 'perSide') return value ? 'sì' : 'no'
  if (field === 'measurementMode') return modeLabels[value as 'reps' | 'seconds']
  if (field === 'loadConvention') return loadLabels[value as keyof typeof loadLabels]
  if (field === 'loadUnit') return unitLabels[value as 'kg' | 'lb']
  return value === '' ? 'nessuna' : String(value)
}
const identitySummary = (values: CatalogExerciseValues) =>
  [values.variant, values.equipment, modeLabels[values.measurementMode], loadLabels[values.loadConvention], values.loadUnit, values.perSide ? 'per lato' : ''].filter(Boolean).join(' · ')

const adoptionNotes: Record<ExerciseCandidate['adoption'], string> = {
  none: '',
  identical_copy: 'Già nel tuo catalogo come copia identica.',
  changed_copy: 'La tua copia è diversa dal catalogo comune: scegli la tua copia o un nuovo esercizio.',
  archived_copy: 'La tua copia è archiviata: scegli un altro esercizio o creane uno nuovo.',
}
const sourceLabel = (choice: ExerciseChoice) => choice.source === 'existing' ? 'Il tuo catalogo' : choice.source === 'shared' ? 'Catalogo comune · aggiunto al tuo catalogo al salvataggio' : 'Nuovo esercizio'

export function ExerciseMatchPicker({ occurrence, snapshot, current, reusable, onChoose, onCancel, newKey = () => `new-${crypto.randomUUID()}` }: {
  occurrence: MatchOccurrence
  snapshot: CatalogSnapshot
  current: ExerciseChoice | null
  reusable: readonly ReusableNewExercise[]
  onChoose: (choice: ExerciseChoice) => void
  onCancel: () => void
  newKey?: () => string
}) {
  const match = useMemo(() => matchExercises([occurrence], snapshot)[0]!, [occurrence, snapshot])
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'catalog' | 'new'>(match.candidates.length || !snapshot.complete ? 'catalog' : 'new')

  const pick = (source: 'existing' | 'shared', id: string) => {
    try { onChoose(chooseCatalogExercise(snapshot, source, id)) } catch (reason) { setError(reason instanceof Error && /incomplete/.test(reason.message) ? 'Il catalogo non è stato letto per intero: riprova più tardi o scegli un nuovo esercizio.' : 'Questo esercizio non è più disponibile così com’era: aggiorna il catalogo o scegli un’altra opzione.') }
  }
  const query = normalizeExerciseName(search)
  const results = query.length < 2 ? [] : [
    ...snapshot.personal.filter(row => row.archivedAt === null).map(row => ({ row, source: 'existing' as const })),
    ...snapshot.shared.map(row => ({ row, source: 'shared' as const })),
  ].filter(entry => normalizeExerciseName(entry.row.name).includes(query)).slice(0, 20)

  const isCurrent = (choice: ExerciseChoice) => current !== null && JSON.stringify(current) === JSON.stringify(choice)

  return <Modal label="Scegli l’esercizio" variant="sheet" onClose={onCancel}>
    <div className="wr-picker">
      <h2>Scegli l’esercizio</h2>
      <div className="wr-picker-source">
        <span className="mini-label">Nel documento</span>
        <strong>{occurrence.name ?? 'Nome non indicato'}</strong>
        <ul className="wr-identity">{identityFields.map(field => <li key={field}><span>{identityLabels[field]}:</span> {showValue(field, occurrence[field])}</li>)}</ul>
      </div>
      {!snapshot.complete && <p className="import-callout is-warning" role="status"><Icon name="alert" size={20} />Il catalogo non è stato letto per intero: puoi consultare i suggerimenti, ma la scelta dal catalogo sarà possibile quando la lettura è completa.</p>}
      {error && <p className="rv-error" role="alert">{error}</p>}
      <Segmented label="Da dove prendi l’esercizio" value={tab} onChange={setTab} options={[{ value: 'catalog', label: 'Dal catalogo' }, { value: 'new', label: 'Nuovo esercizio' }]} />

      {tab === 'catalog' ? <>
        <h3>Suggeriti</h3>
        {match.candidates.length === 0 ? <p className="muted small">Nessun esercizio con questo nome nel catalogo.</p>
          : <ul className="wr-candidates">{match.candidates.map(candidate => {
            const values = exerciseChoiceValues(candidate.choice)
            const id = candidate.choice.source === 'existing' ? candidate.choice.personalId : candidate.choice.source === 'shared' ? candidate.choice.templateId : candidate.choice.localKey
            const suggested = match.preselected !== null && JSON.stringify(match.preselected) === JSON.stringify(candidate.choice)
            return <li key={`${candidate.choice.source}-${id}`} className="wr-candidate" data-candidate={id}>
              <div className="wr-candidate-head">
                <strong>{values.name}</strong>
                <span className="rv-badge is-neutral">{candidate.nameMatch === 'exact' ? 'Stesso nome' : 'Nome simile'}</span>
                {suggested && <span className="rv-badge is-ok">Suggerito</span>}
                {isCurrent(candidate.choice) && <span className="rv-badge is-ok">Scelto</span>}
              </div>
              <p className="small muted">{sourceLabel(candidate.choice)}</p>
              <p className="small">{identitySummary(values) || 'Nessun dettaglio'}</p>
              {candidate.conflicts.length > 0 && <p className="small wr-conflict">Diverso dal documento: {candidate.conflicts.map(field => `${identityLabels[field].toLowerCase()} (documento: ${showValue(field, occurrence[field])}; catalogo: ${showValue(field, values[field])})`).join('; ')}.</p>}
              {candidate.missing.length > 0 && <p className="small muted">Il documento non indica: {candidate.missing.map(field => identityLabels[field].toLowerCase()).join(', ')}. Controlla che sia l’esercizio giusto.</p>}
              {adoptionNotes[candidate.adoption] && <p className="small muted">{adoptionNotes[candidate.adoption]}</p>}
              <button type="button" className="button secondary" disabled={!candidate.selectable || !snapshot.complete}
                onClick={() => pick(candidate.choice.source === 'shared' ? 'shared' : 'existing', id)}>Usa questo</button>
            </li>
          })}</ul>}
        <label className="wr-search">Cerca nel catalogo
          <input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Nome dell’esercizio" />
        </label>
        {query.length >= 2 && (results.length === 0 ? <p className="muted small" role="status">Nessun risultato.</p>
          : <ul className="wr-candidates">{results.map(({ row, source }) => <li key={`${source}-${row.id}`} className="wr-candidate" data-candidate={row.id}>
            <div className="wr-candidate-head"><strong>{row.name}</strong></div>
            <p className="small muted">{source === 'existing' ? 'Il tuo catalogo' : 'Catalogo comune · aggiunto al tuo catalogo al salvataggio'}</p>
            <p className="small">{identitySummary(row) || 'Nessun dettaglio'}</p>
            <button type="button" className="button secondary" disabled={!snapshot.complete} onClick={() => pick(source, row.id)}>Usa questo</button>
          </li>)}</ul>)}
      </> : <NewExerciseForm occurrence={occurrence} reusable={reusable} current={current} onChoose={onChoose} newKey={newKey} />}
      <div className="button-row">
        <button type="button" className="button secondary" onClick={onCancel}>Annulla</button>
      </div>
    </div>
  </Modal>
}

type NewValues = { [K in keyof CatalogExerciseValues]: CatalogExerciseValues[K] | null }

function NewExerciseForm({ occurrence, reusable, current, onChoose, newKey }: {
  occurrence: MatchOccurrence; reusable: readonly ReusableNewExercise[]; current: ExerciseChoice | null
  onChoose: (choice: ExerciseChoice) => void; newKey: () => string
}) {
  // Solo ciò che il documento indica è precompilato; le scelte mancanti restano da fare.
  const [values, setValues] = useState<NewValues>(() => {
    const start = current?.source === 'new' ? current.values : null
    return {
      name: start?.name ?? occurrence.name?.trim() ?? '', variant: start?.variant ?? occurrence.variant, equipment: start?.equipment ?? occurrence.equipment,
      measurementMode: start?.measurementMode ?? occurrence.measurementMode, perSide: start?.perSide ?? occurrence.perSide,
      loadUnit: start?.loadUnit ?? occurrence.loadUnit, loadConvention: start?.loadConvention ?? occurrence.loadConvention, note: start?.note ?? '',
    }
  })
  const [confirmed, setConfirmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = <K extends keyof NewValues>(field: K, value: NewValues[K]) => { setValues({ ...values, [field]: value }); setConfirmed(false) }
  const missing = (['measurementMode', 'perSide', 'loadUnit', 'loadConvention'] as const).filter(field => values[field] === null)
  const submit = () => {
    try {
      onChoose(chooseNewExercise(newKey(), { ...values, variant: values.variant ?? '', equipment: values.equipment ?? '', note: values.note ?? '' }, confirmed))
    } catch { setError('Completa il nome e tutte le scelte, poi conferma i dati del nuovo esercizio.') }
  }
  const choice = <T extends string>(field: 'measurementMode' | 'loadUnit' | 'loadConvention', label: string, options: { value: T; label: string }[]) =>
    <div className="rv-field" role="group" aria-labelledby={`wr-new-${field}`}>
      <span id={`wr-new-${field}`} className="rv-label">{label}{occurrence[field] === null && <span className="rv-origin">Non indicato nel documento</span>}</span>
      <Segmented labelledBy={`wr-new-${field}`} value={(values[field] ?? '') as T | ''} onChange={value => { if (value !== '') set(field, value as never) }}
        options={options as { value: T | ''; label: string }[]} className="rv-choice" />
    </div>

  return <div className="wr-new">
    {reusable.length > 0 && <div className="wr-reuse">
      <h3>Nuovi esercizi di questa revisione</h3>
      <p className="small muted">Stesso esercizio creato una sola volta, con la prescrizione di ciascuna seduta.</p>
      <ul className="wr-candidates">{reusable.map(entry => <li key={entry.localKey} className="wr-candidate">
        <div className="wr-candidate-head"><strong>{entry.values.name}</strong></div>
        <p className="small">{identitySummary(entry.values)}</p>
        <p className="small muted">Usato per: {entry.usedBy}</p>
        <button type="button" className="button secondary" onClick={() => onChoose({ source: 'new', localKey: entry.localKey, values: { ...entry.values } })}>Usa lo stesso</button>
      </li>)}</ul>
    </div>}
    <h3>Nuovo esercizio</h3>
    <p className="small muted">Verrà creato nel tuo catalogo solo quando confermi l’importazione.</p>
    <div className="rv-fields">
      <label className="rv-field"><span className="rv-label">Nome</span>
        <input type="text" value={values.name ?? ''} onChange={event => set('name', event.target.value)} aria-describedby="wr-new-name-help" />
        <span id="wr-new-name-help" className="field-help">Massimo {domainLimits.exercise.name} caratteri.</span>
      </label>
      <label className="rv-field"><span className="rv-label">Variante{occurrence.variant === null && <span className="rv-origin">Non indicata nel documento</span>}</span>
        <input type="text" value={values.variant ?? ''} placeholder="Nessuna" onChange={event => set('variant', event.target.value)} />
      </label>
      <label className="rv-field"><span className="rv-label">Attrezzo{occurrence.equipment === null && <span className="rv-origin">Non indicato nel documento</span>}</span>
        <input type="text" value={values.equipment ?? ''} placeholder="Nessuno" onChange={event => set('equipment', event.target.value)} />
      </label>
      {choice('measurementMode', 'Misura', [{ value: 'reps', label: 'Ripetizioni' }, { value: 'seconds', label: 'Secondi' }])}
      {choice('loadConvention', 'Tipo di carico', Object.entries(loadLabels).map(([value, label]) => ({ value, label })))}
      {choice('loadUnit', 'Unità del carico', [{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }])}
      <div className="rv-field" role="group" aria-labelledby="wr-new-perSide">
        <span id="wr-new-perSide" className="rv-label">Per lato{occurrence.perSide === null && <span className="rv-origin">Non indicato nel documento</span>}</span>
        <Segmented labelledBy="wr-new-perSide" value={values.perSide === null ? '' : values.perSide ? 'yes' : 'no'} className="rv-choice"
          onChange={value => { if (value !== '') set('perSide', value === 'yes') }} options={[{ value: 'no', label: 'No' }, { value: 'yes', label: 'Sì, per lato' }] as { value: '' | 'yes' | 'no'; label: string }[]} />
      </div>
      <label className="rv-field"><span className="rv-label">Nota dell’esercizio</span>
        <textarea rows={2} value={values.note ?? ''} onChange={event => set('note', event.target.value)} />
      </label>
    </div>
    {missing.length > 0 && <p className="small wr-conflict" role="status">Da scegliere: {missing.map(field => identityLabels[field].toLowerCase()).join(', ')}.</p>}
    <label className="catalog-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Confermo i dati del nuovo esercizio</label>
    {error && <p className="rv-error" role="alert">{error}</p>}
    <button type="button" className="button primary" disabled={!confirmed || missing.length > 0 || !(values.name ?? '').trim()} onClick={submit}>Usa come nuovo esercizio</button>
  </div>
}
