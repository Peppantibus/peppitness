import { useEffect, useRef, useState } from 'react'
import { MuscleGroupSelect } from '../components/MuscleGroupSelect'
import { MuscleGroupBadge } from '../components/MuscleGroupBadge'
import { exerciseMuscleGroup, groupExercises, inferMuscleGroup } from '../domain/muscle-groups'
import type { MuscleGroupFilter } from '../domain/muscle-groups'

import { SubpageHeader } from '../components/SubpageHeader'
import { Segmented } from '../components/Segmented'
import { Modal } from '../components/Modal'
import { loadLabels, modeLabels, searchExercises } from '../domain/exercises'
import type { ExerciseValues } from '../domain/exercises'
import type { ExercisesState, ExercisesStore } from '../persistence/exercises-store'

function ExerciseContext({ value }: { value: ExerciseValues }) {
  return <p className="small muted">{[value.variant, value.equipment, loadLabels[value.loadConvention], value.loadUnit, modeLabels[value.measurementMode], value.perSide ? 'Per lato' : ''].filter(Boolean).join(' · ')}</p>
}

export function ExerciseCatalog({ store, state }: { store: ExercisesStore | null; state: ExercisesState }) {
  const [search, setSearch] = useState('')
  const [group, setGroup] = useState<MuscleGroupFilter>('all')
  const [groupChosen, setGroupChosen] = useState(false)
  const [filter, setFilter] = useState<'active' | 'archived' | 'all'>('active')
  const [scope, setScope] = useState<'shared' | 'personal'>('shared')
  const [adopting, setAdopting] = useState<string | null>(null)
  const [adoptError, setAdoptError] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const editor = useRef<HTMLElement>(null)
  const newButton = useRef<HTMLButtonElement>(null)
  const draft = state.draft
  useEffect(() => {
    setGroupChosen(false)
    if (draft) { editor.current?.scrollIntoView({ block: 'start' }); editor.current?.focus({ preventScroll: true }) }
  }, [draft?.id])
  const busy = ['saving', 'checking'].includes(state.phase)
  const rows = searchExercises(scope === 'shared' ? state.sharedRows : state.rows, search, scope === 'shared' ? 'active' : filter, group)
  const close = () => { store?.close(); setConfirmDiscard(false); newButton.current?.focus() }
  return <>
    <SubpageHeader back="#/scheda" backLabel="Torna alla scheda" title="Gli esercizi" subtitle="Esplora gli esercizi comuni e aggiungi i tuoi." />
    {!store ? <section className="panel empty-state"><h2>Accedi per gestire i tuoi esercizi</h2><a className="button secondary" href="#/impostazioni">Vai all’account</a></section>
      : <>
        {['idle', 'loading'].includes(state.phase) ? <section className="panel empty-state" role="status">Caricamento degli esercizi…</section>
          : state.phase === 'error' ? <section className="panel empty-state"><p role="alert">{state.message}</p><button className="button secondary" onClick={() => void store.load()}>Riprova</button></section>
            : <>
              <section className="panel catalog-toolbar" aria-label="Cerca nel catalogo">
                <Segmented className="catalog-scope" label="Tipo di esercizi" value={scope} onChange={value => { setScope(value); setAdoptError('') }} options={[{ value: 'shared', label: 'Esercizi comuni' }, { value: 'personal', label: 'I tuoi esercizi' }]} />
                <label htmlFor="exercise-search">Cerca esercizi<input id="exercise-search" type="search" placeholder="Nome, gruppo o attrezzo" value={search} onChange={event => setSearch(event.target.value)} /></label>
                <MuscleGroupSelect id="exercise-group-filter" filter value={group} onChange={setGroup} />
                {scope === 'personal' && <label htmlFor="exercise-filter">Mostra<select id="exercise-filter" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="active">Attivi</option><option value="archived">Archiviati</option><option value="all">Tutti</option></select></label>}
                <div className="catalog-actions"><button ref={newButton} className="button primary" disabled={Boolean(draft)} onClick={() => { setScope('personal'); store.open() }}>Nuovo esercizio</button><button className="button secondary" disabled={Boolean(draft)} onClick={() => void store.load()}>Aggiorna elenco</button></div>
              </section>
              {draft && <section ref={editor} tabIndex={-1} className="panel catalog-editor" aria-labelledby="exercise-editor-title">
                <h2 id="exercise-editor-title">{draft.base ? 'Modifica esercizio' : 'Nuovo esercizio'}</h2>
                <form className="catalog-form" onSubmit={event => { event.preventDefault(); void store.save() }}>
                  <fieldset disabled={busy || state.phase === 'uncertain'}>
                    <label htmlFor="exercise-name">Nome<input id="exercise-name" required maxLength={120} value={draft.values.name} onChange={event => store.edit({ ...draft.values, name: event.target.value, ...(!draft.base && !groupChosen ? { muscleGroup: inferMuscleGroup(event.target.value, draft.values.variant) } : {}) })} /></label>
                    <MuscleGroupSelect id="exercise-muscle-group" value={exerciseMuscleGroup(draft.values) ?? ''} onChange={muscleGroup => { setGroupChosen(true); store.edit({ ...draft.values, muscleGroup }) }} />
                    {draft.base && <p className="small muted">Per cambiare variante, attrezzo o modalità, chiudi il modulo e scegli Crea variante. La rinomina conserva i collegamenti a questo esercizio.</p>}
                    <fieldset className="catalog-identity" disabled={Boolean(draft.base)}><legend>Come lo esegui</legend>
                      <label htmlFor="exercise-variant">Variante <span className="muted">(facoltativa)</span><input id="exercise-variant" maxLength={120} value={draft.values.variant} onChange={event => store.edit({ ...draft.values, variant: event.target.value })} /></label>
                      <label htmlFor="exercise-equipment">Attrezzo o macchina <span className="muted">(facoltativo)</span><input id="exercise-equipment" maxLength={120} value={draft.values.equipment} onChange={event => store.edit({ ...draft.values, equipment: event.target.value })} /></label>
                      <label htmlFor="exercise-load">Carico indicato<select id="exercise-load" value={draft.values.loadConvention} onChange={event => store.edit({ ...draft.values, loadConvention: event.target.value as ExerciseValues['loadConvention'] })}>{Object.entries(loadLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                      <label htmlFor="exercise-unit">Unità del carico<select id="exercise-unit" value={draft.values.loadUnit} onChange={event => store.edit({ ...draft.values, loadUnit: event.target.value as ExerciseValues['loadUnit'] })}><option value="kg">Chilogrammi · kg</option><option value="lb">Libbre · lb</option></select></label>
                      <label htmlFor="exercise-mode">Risultato della serie<select id="exercise-mode" value={draft.values.measurementMode} onChange={event => store.edit({ ...draft.values, measurementMode: event.target.value as ExerciseValues['measurementMode'] })}>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                      <label className="catalog-check"><input id="exercise-side" type="checkbox" checked={draft.values.perSide} onChange={event => store.edit({ ...draft.values, perSide: event.target.checked })} />Valori per ciascun lato</label>
                    </fieldset>
                    <label htmlFor="exercise-note">Note <span className="muted">(facoltative)</span><textarea id="exercise-note" rows={4} maxLength={4000} value={draft.values.note} onChange={event => store.edit({ ...draft.values, note: event.target.value })} /></label>
                    {draft.base && <><label className="catalog-check"><input id="exercise-archived" type="checkbox" checked={Boolean(draft.values.archivedAt)} onChange={event => store.edit({ ...draft.values, archivedAt: event.target.checked ? new Date().toISOString() : null })} />Archiviato</label><p className="small muted">Nasconde l’esercizio dall’elenco degli attivi. Puoi ripristinarlo; i programmi e lo storico conservano i loro riferimenti.</p></>}
                  </fieldset>
                  {state.phase === 'conflict' && <div className="preferences-conflict catalog-conflict" role="region" aria-label="Confronto esercizio">
                    <h3>Dati attualmente online</h3>
                    {state.remote ? <><p><strong>{state.remote.name}</strong></p><MuscleGroupBadge exercise={state.remote} /><ExerciseContext value={state.remote} /><p className="catalog-note">{state.remote.note || 'Nessuna nota'}</p><p>{state.remote.archivedAt ? 'Archiviato' : 'Attivo'}</p></> : <p>Non è presente un esercizio online con questo riferimento.</p>}
                    {!store.canReplaceRemote && <p>Il riferimento online non è compatibile. Puoi caricare i dati online e poi creare un nuovo esercizio.</p>}
                    <div className="catalog-actions"><button type="button" className="button secondary" onClick={store.useRemote}>{state.remote ? 'Usa i dati online' : 'Scarta la bozza'}</button>{store.canReplaceRemote && <button type="button" className="button primary" onClick={() => void store.save(true)}>Salva le mie modifiche</button>}</div>
                  </div>}
                  {state.message && <p className="catalog-message" role={state.phase === 'ready' ? 'status' : 'alert'}>{state.message}</p>}
                  <div className="catalog-actions">
                    {state.phase === 'uncertain' ? <button className="button secondary" type="button" onClick={() => void store.check()}>Verifica online</button>
                      : state.phase !== 'conflict' && <button type="submit" className="button primary" disabled={busy || (!store.dirty && Boolean(draft.base))}>{state.phase === 'saving' ? 'Salvataggio…' : state.phase === 'checking' ? 'Verifica in corso…' : 'Salva esercizio'}</button>}
                    <button type="button" className="button secondary catalog-close" disabled={state.phase !== 'ready'} onClick={() => store.dirty ? setConfirmDiscard(true) : close()}>Chiudi</button>
                  </div>
                  {store.dirty && !state.message && <p className="small muted" role="status">Modifiche da salvare. Restano in questa pagina finché non le salvi online.</p>}
                </form>
              </section>}
              {!draft && state.message && <p className="catalog-message" role="status">{state.message}</p>}
              <p className="small muted catalog-count" role="status">{rows.length} esercizi{scope === 'personal' ? filter === 'archived' ? ' archiviati' : filter === 'active' ? ' attivi' : '' : ' comuni'}</p>
              {adoptError && <p className="form-error" role="alert">{adoptError}</p>}
              {!rows.length ? <section className="panel empty-state"><h2>{search || group !== 'all' ? 'Nessun esercizio trovato' : scope === 'shared' ? 'Catalogo comune vuoto' : 'Il tuo catalogo è vuoto'}</h2><p>{search || group !== 'all' ? 'Prova un altro nome o gruppo muscolare.' : scope === 'shared' ? 'Gli esercizi comuni saranno disponibili dopo il caricamento del pool condiviso.' : 'Aggiungi il primo esercizio con il pulsante Nuovo esercizio.'}</p></section>
                : <div className="catalog-groups">{groupExercises(rows).map(section => <section className="catalog-group" key={section.label} aria-label={section.label}><h2 className="catalog-group-title">{section.label}<span>{section.rows.length}</span></h2><div className="catalog-list">{section.rows.map(row => <article className="panel catalog-card" key={row.id}>
                  <div><h3>{row.name}</h3><MuscleGroupBadge exercise={row} /><ExerciseContext value={row} />{row.note && <p className="catalog-note">{row.note}</p>}{row.archivedAt && <p className="small">Archiviato</p>}</div>
                  {scope === 'shared' ? <div className="catalog-actions">{state.rows.some(personal => personal.sourceTemplateId === row.id)
                    ? <span className="small muted">{state.rows.some(personal => personal.sourceTemplateId === row.id && personal.archivedAt) ? 'Nei tuoi esercizi · archiviato' : 'Nei tuoi esercizi'}</span>
                    : <button className="button secondary" disabled={Boolean(draft) || Boolean(adopting)} onClick={() => { setAdopting(row.id); setAdoptError(''); void store.adoptShared(row.id).then(saved => { if (!saved) setAdoptError('Non riesco ad aggiungere questo esercizio. Riprova quando sei online.'); setAdopting(null) }) }}>{adopting === row.id ? 'Aggiunta…' : 'Aggiungi ai tuoi'}</button>}</div>
                    : <div className="catalog-actions"><button className="button secondary catalog-edit" disabled={Boolean(draft)} onClick={() => store.open(row)} aria-label={`Modifica ${row.name}`}>Modifica</button><button className="button secondary catalog-copy" disabled={Boolean(draft)} onClick={() => store.open(row, true)} aria-label={`Crea variante di ${row.name}`}>Crea variante</button></div>}
                </article>)}</div></section>)}</div>}
            </>}
      </>}
    {confirmDiscard && <Modal label="Scartare le modifiche all’esercizio?" onClose={() => setConfirmDiscard(false)}><h2>Scartare le modifiche?</h2><p>La bozza non salvata verrà persa. L’esercizio già online rimane nel catalogo.</p><div className="catalog-actions"><button className="button secondary" onClick={() => setConfirmDiscard(false)}>Continua a modificare</button><button className="button danger" onClick={close}>Scarta le modifiche</button></div></Modal>}
  </>
}
