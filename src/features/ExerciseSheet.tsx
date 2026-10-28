import { useEffect, useRef, useState } from 'react'
import { MuscleGroupSelect } from '../components/MuscleGroupSelect'
import { MuscleGroupBadge } from '../components/MuscleGroupBadge'
import { Icon } from '../components/Icon'
import { Segmented } from '../components/Segmented'
import { Modal } from '../components/Modal'
import { emptyExercise, loadLabels, searchExercises } from '../domain/exercises'
import type { CatalogExercise, ExerciseValues } from '../domain/exercises'
import { exerciseMuscleGroup, groupExercises, inferMuscleGroup, withCardioDefaults } from '../domain/muscle-groups'
import type { MuscleGroupFilter } from '../domain/muscle-groups'
import type { ExercisesState, ExercisesStore } from '../persistence/exercises-store'

/** Ricerca nel catalogo e creazione rapida di un esercizio nuovo, in un pannello dal basso. */
export function ExerciseSheet({ catalog, onAdd, onClose, label = 'Aggiungi esercizi', hints = {}, single = false }: { catalog: { store: ExercisesStore | null; state: ExercisesState }; onAdd: (exercise: CatalogExercise) => void; onClose: () => void; label?: string; hints?: Record<string, string>; single?: boolean }) {
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<MuscleGroupFilter>('all')
  const [added, setAdded] = useState(0)
  const [draft, setDraft] = useState<ExerciseValues | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const rows = searchExercises(catalog.state.rows, search, 'active', group)
  const shared = searchExercises(catalog.state.sharedRows, search, 'active', group).filter(row => !catalog.state.rows.some(personal => personal.sourceTemplateId === row.id))
  const exact = [...catalog.state.rows, ...catalog.state.sharedRows].some(row => row.name.toLocaleLowerCase('it') === search.trim().toLocaleLowerCase('it'))
  const add = (exercise: CatalogExercise) => { onAdd(exercise); setAdded(value => value + 1) }
  const addShared = async (exercise: CatalogExercise) => {
    if (!catalog.store || creating) return
    setCreating(true); setError('')
    const personal = await catalog.store.adoptShared(exercise.id)
    setCreating(false)
    if (!personal) { setError('Non riesco ad aggiungere l’esercizio comune. Se lo hai archiviato, ripristinalo nel catalogo.'); return }
    add(personal)
  }
  const create = async () => {
    if (!draft || !catalog.store || creating) return
    setCreating(true); setError('')
    const saved = await catalog.store.quickCreate(draft)
    setCreating(false)
    if (!saved) { setError('Esercizio non salvato. Controlla la connessione e riprova.'); return }
    add(saved); setDraft(null); setSearch('')
  }
  return <Modal label={label} variant="sheet" onClose={onClose}>
    <div className="wz-sheet">
      <h2>{label}</h2>
      <label className="wz-search" htmlFor="wizard-search"><Icon name="dumbbell" size={20} /><input ref={input} id="wizard-search" type="search" autoComplete="off" placeholder="Cerca o scrivi un nuovo esercizio" value={search} onChange={event => { setSearch(event.target.value); setDraft(null) }} /></label>
      <MuscleGroupSelect id="wizard-group-filter" filter value={group} onChange={setGroup} disabled={creating} />
      {catalog.state.phase === 'loading' || catalog.state.phase === 'idle' ? <p role="status" className="small muted">Caricamento del catalogo…</p>
        : catalog.state.phase === 'error' ? <p role="alert">Catalogo non disponibile. <button type="button" className="text-button" onClick={() => void catalog.store?.load()}>Riprova</button></p> : null}
      {search.trim() && !exact && catalog.state.phase !== 'error' && (draft ? <section className="wz-create" aria-label="Nuovo esercizio">
        <strong>Nuovo: {draft.name}</strong>
        <MuscleGroupSelect id="wizard-muscle-group" value={exerciseMuscleGroup(draft) ?? ''} onChange={muscleGroup => setDraft(withCardioDefaults({ ...draft, muscleGroup }))} disabled={creating} />
        {exerciseMuscleGroup(draft) !== 'Cardio' && <>
        <Segmented label="Si misura in" value={draft.measurementMode} onChange={measurementMode => setDraft({ ...draft, measurementMode })} options={[{ value: 'reps', label: 'Ripetizioni' }, { value: 'seconds', label: 'Secondi' }]} />
        <Segmented label="Carico" value={draft.loadConvention} onChange={loadConvention => setDraft({ ...draft, loadConvention })} options={(Object.keys(loadLabels) as ExerciseValues['loadConvention'][]).map(key => ({ value: key, label: key === 'single-dumbbell' ? 'Un manubrio' : loadLabels[key] }))} />
        </>}
        <label htmlFor="wizard-equipment">Attrezzo o macchina (facoltativo)<input id="wizard-equipment" maxLength={120} placeholder="Es. Pulley, Smith, manubri" value={draft.equipment} onChange={event => setDraft({ ...draft, equipment: event.target.value })} /></label>
        {exerciseMuscleGroup(draft) !== 'Cardio' && <label className="wz-check"><input type="checkbox" checked={draft.perSide} onChange={event => setDraft({ ...draft, perSide: event.target.checked })} />Ripetizioni per lato</label>}
        {error && <p className="wz-error" role="alert">{error}</p>}
        <div className="program-actions"><button type="button" className="button secondary" onClick={() => setDraft(null)}>Annulla</button><button type="button" className="button primary wz-create-confirm" disabled={creating} onClick={() => void create()}>{creating ? 'Salvataggio…' : 'Crea e aggiungi'}</button></div>
      </section> : <button type="button" className="wz-create-start" onClick={() => setDraft(withCardioDefaults({ ...emptyExercise(), name: search.trim().slice(0, 120), muscleGroup: group === 'unclassified' ? null : group !== 'all' ? group : inferMuscleGroup(search.trim()) }))}><Icon name="plus" size={20} /><span>Crea «{search.trim()}»</span><small>Nuovo esercizio nel tuo catalogo</small></button>)}
      {error && <p className="wz-error" role="alert">{error}</p>}
      {single && rows.some(row => hints[row.id]) && <section aria-label="Più avanti questa settimana"><h3 className="wz-results-title">Più avanti questa settimana</h3><ul className="wz-results">{rows.filter(row => hints[row.id]).map(row => <li key={row.id}><button type="button" disabled={creating} onClick={() => add(row)}><span><strong>{row.name}</strong><small>{hints[row.id]}</small><small>{[row.variant, row.equipment].filter(Boolean).join(' · ')}</small></span><Icon name="arrow" size={20} /></button></li>)}</ul></section>}
      {rows.length > 0 && <section aria-label="I tuoi esercizi"><h3 className="wz-results-title">I tuoi esercizi</h3>{groupExercises(rows).map(section => <section key={section.label}><h4 className="wz-group-title">{section.label} <span>{section.rows.length}</span></h4><ul className="wz-results">{section.rows.map(row => <li key={row.id}><button type="button" disabled={creating} onClick={() => add(row)}><span><strong>{row.name}</strong><MuscleGroupBadge exercise={row} /><small>{[row.variant, row.equipment, row.measurementMode === 'seconds' ? 'a tempo' : 'ripetizioni', row.perSide ? 'per lato' : ''].filter(Boolean).join(' · ')}</small></span><Icon name="plus" size={20} /></button></li>)}</ul></section>)}</section>}
      {shared.length > 0 && <section aria-label="Esercizi comuni"><h3 className="wz-results-title">Esercizi comuni</h3>{groupExercises(shared).map(section => <section key={section.label}><h4 className="wz-group-title">{section.label} <span>{section.rows.length}</span></h4><ul className="wz-results">{section.rows.map(row => <li key={row.id}><button type="button" disabled={creating} onClick={() => void addShared(row)}><span><strong>{row.name}</strong><MuscleGroupBadge exercise={row} /><small>{[row.variant, row.equipment, row.measurementMode === 'seconds' ? 'a tempo' : 'ripetizioni', row.perSide ? 'per lato' : ''].filter(Boolean).join(' · ')}</small></span><Icon name="plus" size={20} /></button></li>)}</ul></section>)}</section>}
      {catalog.state.phase === 'ready' && !rows.length && !shared.length && !search.trim() && group === 'all' && <p className="small muted">Il catalogo è vuoto: scrivi il nome del primo esercizio per crearlo.</p>}
      {catalog.state.phase === 'ready' && !rows.length && !shared.length && (search.trim() || group !== 'all') && <p className="small muted" role="status">Nessun esercizio in questo gruppo corrisponde alla ricerca.</p>}
      <div className="wz-sheet-footer"><button type="button" className="button primary full-width" onClick={onClose}>{!single && added ? `Fatto · ${added} aggiunt${added === 1 ? 'o' : 'i'}` : 'Chiudi'}</button></div>
    </div>
  </Modal>
}
