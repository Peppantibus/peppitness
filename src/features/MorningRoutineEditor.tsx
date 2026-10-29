import { useEffect, useState } from 'react'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { emptyMorningRoutine, morningDaysLabel, morningDuration, morningWeekdays, validMorningRoutine } from '../domain/morning-routine'
import type { MorningExercise, MorningRoutine } from '../domain/morning-routine'

type Section = 'base' | 'extra'
export function MorningRoutineEditor({ value, revision, onSave, onExit, onDirty }: {
  value: MorningRoutine | null; revision: number; onSave: (value: MorningRoutine, revision: number) => boolean; onExit: () => void; onDirty: (dirty: boolean) => void
}) {
  const [initial] = useState(() => structuredClone(value ?? emptyMorningRoutine()))
  const [initialRevision] = useState(revision)
  const [draft, setDraft] = useState(initial), [error, setError] = useState('')
  const [removing, setRemoving] = useState<{ section: Section; item: MorningExercise } | null>(null)
  const [exiting, setExiting] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial)
  useEffect(() => { onDirty(dirty); return () => onDirty(false) }, [dirty, onDirty])
  const exit = () => dirty ? setExiting(true) : onExit()
  const update = (section: Section, id: string, patch: Partial<MorningExercise>) => setDraft(old => ({ ...old, [section]: old[section].map(item => item.id === id ? { ...item, ...patch } : item) }))
  const add = (section: Section) => setDraft(old => ({ ...old, [section]: [...old[section], { id: crypto.randomUUID(), name: 'Nuovo esercizio', area: '', dose: '', minutes: 1, note: '' }] }))
  const move = (section: Section, index: number, direction: number) => setDraft(old => {
    const items = [...old[section]], destination = index + direction
    if (destination < 0 || destination >= items.length) return old
    ;[items[index], items[destination]] = [items[destination]!, items[index]!]
    return { ...old, [section]: items }
  })
  const save = (event: React.FormEvent) => {
    event.preventDefault()
    const document = { ...draft, title: draft.title.trim(), base: draft.base.map(item => ({ ...item, name: item.name.trim() })), extra: draft.extra.map(item => ({ ...item, name: item.name.trim() })) }
    if (!validMorningRoutine(document)) { setError('Aggiungi almeno un esercizio alla base. Per ogni esercizio indica nome e minuti (da 0,5 a 30); il totale deve restare entro 180 minuti.'); return }
    if (!onSave(document, initialRevision)) setError('Non riesco a salvare la routine. La modifica resta aperta: riprova.')
  }
  return <form className="morning-editor morning-page" onSubmit={save}>
    <div className="morning-back"><button type="button" className="icon-button" aria-label="Annulla modifiche" onClick={exit}><Icon name="back" size={20} /></button><h1>Modifica routine<span className="heading-dot">.</span></h1></div>
    <label className="routine-field routine-title-field">Nome della routine<input id="routine-name" maxLength={120} required value={draft.title} onChange={event => setDraft(old => ({ ...old, title: event.target.value }))} /></label>
    <fieldset className="routine-schedule"><legend>Giorni di rinforzo</legend><p>La base rimane tutti i giorni. Il rinforzo si aggiunge nei giorni selezionati.</p>
      <div className="routine-weekdays">{morningWeekdays.map((label, index) => <button type="button" key={label} aria-label={`Rinforzo ${label}`} aria-pressed={draft.strengthDays.includes(index + 1)} onClick={() => setDraft(old => ({ ...old, strengthDays: old.strengthDays.includes(index + 1) ? old.strengthDays.filter(day => day !== index + 1) : [...old.strengthDays, index + 1].sort((a, b) => a - b) }))}>{label}</button>)}</div>
      <span>{morningDuration(draft.base)} min ogni mattina · {morningDuration([...draft.base, ...draft.extra])} min con rinforzo</span>
    </fieldset>
    {(['base', 'extra'] as const).map(section => <section className="routine-editor-section" key={section}>
      <div className="morning-section-heading"><h2>{section === 'base' ? 'Base quotidiana' : 'Rinforzo'}</h2><span>{section === 'base' ? 'Ogni giorno' : morningDaysLabel(draft.strengthDays)} · {morningDuration(draft[section])} min</span></div>
      <div className="routine-editor-items">{draft[section].map((item, index) => <details key={item.id} className="routine-editor-movement" open={item.name === 'Nuovo esercizio' ? true : undefined}>
        <summary><span className="morning-number">{index + 1}</span><strong>{item.name || 'Senza nome'}</strong><span>{item.minutes} min</span><button type="button" className="routine-remove-inline" aria-label={`Rimuovi ${item.name}`} title="Rimuovi esercizio" onClick={event => { event.preventDefault(); event.stopPropagation(); setRemoving({ section, item }) }}><Icon name="close" size={16} /></button><Icon name="chevronDown" size={16} /></summary>
        <div className="routine-editor-body">
          <label className="routine-field">Nome<input required maxLength={120} value={item.name} onChange={event => update(section, item.id, { name: event.target.value })} /></label>
          <div className="routine-field-row"><label className="routine-field">Minuti<input required type="number" min="0.5" max="30" step="0.5" value={Number.isFinite(item.minutes) ? item.minutes : ''} onChange={event => update(section, item.id, { minutes: event.target.value === '' ? NaN : Number(event.target.value) })} /></label><label className="routine-field">Ripetizioni / dose<input maxLength={80} value={item.dose} onChange={event => update(section, item.id, { dose: event.target.value })} /></label></div>
          <label className="routine-field">Area<input maxLength={80} value={item.area} onChange={event => update(section, item.id, { area: event.target.value })} /></label>
          <label className="routine-field">Come si fa<textarea rows={4} maxLength={4000} value={item.note} onChange={event => update(section, item.id, { note: event.target.value })} /></label>
          <div className="routine-item-actions"><button type="button" className="icon-button" disabled={!index} aria-label={`Sposta su ${item.name}`} onClick={() => move(section, index, -1)}><Icon name="arrowUp" size={16} /></button><button type="button" className="icon-button" disabled={index === draft[section].length - 1} aria-label={`Sposta giù ${item.name}`} onClick={() => move(section, index, 1)}><Icon name="arrowDown" size={16} /></button></div>
        </div>
      </details>)}</div>
      <button className="routine-add" type="button" disabled={draft[section].length >= 30} onClick={() => add(section)}><Icon name="plus" size={16} />Aggiungi esercizio</button>
    </section>)}
    <label className="routine-field">Indicazioni generali (facoltative)<textarea rows={3} maxLength={8000} value={draft.note} onChange={event => setDraft(old => ({ ...old, note: event.target.value }))} /></label>
    <p className="routine-edit-note">Le giornate già completate conservano la routine originale.</p>
    <div className="morning-footer routine-editor-footer">{error && <p role="alert">{error}</p>}<button type="button" className="button secondary lg" onClick={exit}>Annulla</button><button type="submit" className="button primary lg" id="save-routine">Salva modifiche</button></div>
    {removing && <Modal label="Rimuovere l’esercizio?" onClose={() => setRemoving(null)}><h2>Rimuovere l’esercizio?</h2><p><strong>{removing.item.name}</strong> verrà rimosso dalla routine. La modifica verrà applicata quando salvi.</p><div className="program-actions program-confirm-actions"><button type="button" className="button secondary" onClick={() => setRemoving(null)}>Annulla</button><button type="button" className="button danger" onClick={() => { setDraft(old => ({ ...old, [removing.section]: old[removing.section].filter(item => item.id !== removing.item.id) })); setRemoving(null) }}>Rimuovi</button></div></Modal>}
    {exiting && <Modal label="Uscire dalla modifica?" onClose={() => setExiting(false)}><h2>Uscire dalla modifica?</h2><p>Le modifiche non salvate andranno perse.</p><div className="program-actions program-confirm-actions"><button type="button" className="button secondary" onClick={() => setExiting(false)}>Annulla</button><button type="button" className="button danger" onClick={onExit}>Esci</button></div></Modal>}
  </form>
}
