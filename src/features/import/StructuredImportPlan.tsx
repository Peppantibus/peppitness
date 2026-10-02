import { useState, useSyncExternalStore } from 'react'
import { SubpageHeader } from '../../components/SubpageHeader'
import { buildStructured, columns, identityKey, structuredCandidates, type Cell, type StructuredDraft } from '../../import/structured/parser.ts'
import { exerciseChoiceValues, type CatalogExerciseValues } from '../../import/contracts/review.ts'
import type { ImportPlan } from './ImportPlan'
import './structured-import.css'

const idle = { opening: true, slots: { workout: { record: null, busy: false, problem: null, durable: false, restored: false, refreshFailed: false }, diet: { record: null, busy: false, problem: null, durable: false, restored: false, refreshFailed: false } } }
const getIdle = () => idle
const subscribeIdle = () => () => undefined
export function StructuredImportPlan({ kind, store, loadFailed, onRetryLoad, context }: Parameters<typeof ImportPlan>[0]) {
  const engine = store?.structured
  const state = useSyncExternalStore(engine?.subscribe ?? subscribeIdle, engine?.getSnapshot ?? getIdle)
  const slot = state.slots[kind]
  const record = slot.record
  const [follow, setFollow] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const diet = kind === 'diet'
  const back = diet ? '#/dieta/piani' : '#/scheda/programmi'
  const built = record && !record.receipt ? buildStructured(record.draft, context.catalog, follow, context.selection?.revision ?? null) : null
  const locked = slot.busy || Boolean(record?.command && !record.receipt)
  const edit = (change: (draft: StructuredDraft) => void) => {
    if (!engine || !record || locked) return
    const draft = structuredClone(record.draft); change(draft); setConfirming(false); void engine.edit(kind, draft)
  }
  const setting = (key: string, values: CatalogExerciseValues, patch: Partial<CatalogExerciseValues>) => edit(d => { d.choices[key] = { source: 'new', localKey: `new:${d.ids[`exercise:${key}`]}`, values: { ...values, ...patch } } })
  const field = (cell: Cell, label: string) => <label className="si-cell" key={cell.id}>
    <span className="sr-only">{label}</span>
    <textarea rows={1} aria-label={label} data-cell={cell.id} disabled={locked || confirming} value={cell.text}
      aria-invalid={built?.problems.some(p => p.cellId === cell.id) || undefined}
      onChange={event => edit(draft => { const target = draft.title.id === cell.id ? draft.title : draft.tables.flatMap(t => t.rows.flatMap(r => r.cells)).find(c => c.id === cell.id)!; target.text = event.target.value })} />
    {built?.problems.filter(p => p.cellId === cell.id).map((p, i) => <small role="alert" key={i}>{p.message}</small>)}
  </label>
  return <>
    <SubpageHeader back={back} backLabel="Torna ai piani" title={diet ? 'Importa un piano alimentare' : 'Importa una scheda'} subtitle="Da un modello Word strutturato, letto sul dispositivo." />
    <nav className="import-kind" aria-label="Cosa importi"><a href="#/scheda/importa" aria-current={!diet ? 'page' : undefined}>Scheda di allenamento</a><a href="#/dieta/importa" aria-current={diet ? 'page' : undefined}>Piano alimentare</a></nav>
    <section className="panel si-template">
      <h2>Modello Word · versione 1</h2>
      <p>Scarica il modello, sostituisci gli esempi e compilalo in Word. Sono accettati solo DOCX con le sezioni e le colonne del modello.</p>
      <a className="button secondary" href={`/templates/peppitness-${kind}-v1.docx`} download>Scarica il modello {diet ? 'dieta' : 'scheda'}</a>
      <p className="field-help">Lettura e anteprima locali. Nessuna richiesta a servizi di IA. Il salvataggio invia soltanto il piano confermato e la provenienza al tuo account.</p>
    </section>
    {!engine ? <section className="panel"><p>{loadFailed ? 'Importazione non disponibile.' : 'Preparo l’importazione…'}</p>{loadFailed && <button className="button secondary" onClick={onRetryLoad}>Riprova</button>}</section> : <>
      <section className="panel si-file">
        {record && <p><strong>{record.fileName}</strong>{slot.restored ? ' · Bozza recuperata' : ''}</p>}
        {<label className="button secondary import-change">{record?.receipt ? 'Importa un altro DOCX' : record ? 'Cambia DOCX' : 'Scegli il DOCX compilato'}<input className="import-file-input" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={locked || state.opening} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) { setConfirming(false); setFollow(false); void engine.select(kind, file) } }} /></label>}
        {record && <button className="button ghost" disabled={locked} onClick={() => { setConfirming(false); void engine.remove(kind) }}>Rimuovi importazione</button>}
        {slot.busy && <p role="status">{record?.command ? 'Salvataggio e verifica in corso…' : 'Lettura sul dispositivo…'}</p>}
        {slot.problem && <p className="si-error" role="alert">{slot.problem}</p>}
        {record && !record.receipt && <p className="field-help">{slot.durable ? 'Bozza conservata su questo dispositivo per 7 giorni; viene rimossa all’uscita dall’account.' : 'Bozza non persistente: il salvataggio è bloccato.'}</p>}
        {slot.problem && <div className="button-row"><button className="button secondary" disabled={slot.busy} onClick={() => void engine.reload()}>Ricarica la bozza</button><button className="button secondary" disabled={slot.busy} onClick={() => { context.onCatalogStale(); context.onSelectionStale(); edit(d => { d.choices = {} }); setConfirming(false) }}>Aggiorna catalogo e selezione</button></div>}
      </section>
      {record?.receipt ? <section className="panel si-saved" role="status"><h2>{record.receipt.resultState === 'deleted' ? 'Piano già eliminato' : 'Importazione salvata'}</h2><p>{record.receipt.selection ? 'Il piano è seguito nel diario.' : 'Puoi selezionare il piano da seguire nell’elenco.'}</p>{slot.refreshFailed && <p role="alert">Piano salvato; ricarica la pagina per aggiornare il diario.</p>}<a className="button primary" href={diet ? '#/dieta' : '#/scheda'}>Apri {diet ? 'Dieta' : 'Scheda'}</a><a className="button secondary" href={back}>Apri i piani</a></section>
        : record?.command ? <section className="panel si-pending"><h2>Salvataggio da verificare</h2><p>La richiesta è conservata. La verifica e il retry usano sempre lo stesso comando, anche dopo una ricarica.</p><button className="button primary" disabled={slot.busy || !context.online} onClick={() => void engine.save(kind)}>Verifica e riprova il salvataggio</button></section>
        : record && built && <section className="panel si-preview" data-structured={kind}>
          <h2>{confirming ? 'Conferma finale' : 'Anteprima modificabile'}</h2>
          <p>{diet ? `${built.preview.kind === 'diet' ? built.preview.resolved.plan.document.days.length : 0} giornate` : `${built.preview.kind === 'workout' ? built.preview.resolved.days.length : 0} sedute`} · {record.draft.tables.find(t => t.section === (diet ? 'Alimenti' : 'Allenamento'))?.rows.length ?? 0} {diet ? 'alimenti' : 'esercizi'}</p>
          {field(record.draft.title, 'Titolo')}
          {record.draft.tables.map(table => <details key={table.id} open={table.section === 'Allenamento' || table.section === 'Alimenti' || Boolean(built.problems.some(p => table.rows.some(r => r.cells.some(c => c.id === p.cellId))))}>
            <summary>{table.section} · {table.rows.length} righe</summary>
            <div className="si-table-scroll"><table><thead><tr><th>Riga</th>{columns[table.section].map(c => <th key={c}>{c}</th>)}</tr></thead><tbody>{table.rows.map(row => <tr key={row.id}><th>{row.number}</th>{row.cells.map((cell, index) => <td key={cell.id}>{field(cell, `${table.section} riga ${row.number}, ${columns[table.section][index]}`)}</td>)}</tr>)}</tbody></table></div>
          </details>)}
          {built.problems.filter(p => !p.cellId).map((p, i) => <p className="si-error" role="alert" key={i}>{p.message}</p>)}
          {!diet && record.draft.tables.find(t => t.section === 'Allenamento')?.rows.filter((row, index, rows) => rows.findIndex(other => identityKey(other.cells[1]!.text, other.cells[3]!.text ? 'reps' : 'seconds') === identityKey(row.cells[1]!.text, row.cells[3]!.text ? 'reps' : 'seconds')) === index).map(row => {
            const name = row.cells[1]!.text, mode = row.cells[3]!.text ? 'reps' : 'seconds'
            const candidates = structuredCandidates(name, mode, context.catalog)
            if (candidates.length < 2) return null
            const key = identityKey(name, mode)
            const selected = record.draft.choices[key]
            return <label key={row.id}>Identità per {name}<select disabled={locked || confirming} value={selected ? JSON.stringify(selected) : ''} onChange={e => edit(d => { d.choices[key] = JSON.parse(e.target.value) })}><option value="" disabled>Scegli l’identità</option>{candidates.map((c, i) => { const v = exerciseChoiceValues(c.choice); return <option key={i} value={JSON.stringify(c.choice)}>{v.name} · {v.variant || 'senza variante'} · {v.equipment || 'senza attrezzo'} · {v.perSide ? 'per lato' : 'totale'} · {v.loadUnit}</option> })}</select></label>
          })}
          {built.preview.kind === 'workout' && <div className="si-catalog"><p>Dal tuo catalogo: {built.preview.resolved.catalog.filter(b => b.choice.source === 'existing').map(b => exerciseChoiceValues(b.choice).name).join(', ') || 'nessuno'}. Dal catalogo condiviso: {built.preview.resolved.catalog.filter(b => b.choice.source === 'shared').map(b => exerciseChoiceValues(b.choice).name).join(', ') || 'nessuno'}.</p><h3>Nuovi esercizi ({built.preview.resolved.catalog.filter(b => b.choice.source === 'new').length})</h3><ul>{built.preview.resolved.catalog.filter(b => b.choice.source === 'new').map(b => {
            const v = exerciseChoiceValues(b.choice), key = identityKey(v.name, v.measurementMode)
            return <li key={b.ref}><strong>{v.name}</strong> · {v.measurementMode === 'reps' ? 'ripetizioni' : 'secondi'}<details><summary>Impostazioni: {v.loadUnit}, {v.loadConvention === 'total' ? 'carico totale' : v.loadConvention === 'bodyweight' ? 'corpo libero' : 'un manubrio'}, {v.perSide ? 'per lato' : 'non per lato'}</summary>
              <label>Unità <select aria-label={`Unità ${v.name}`} disabled={locked || confirming} value={v.loadUnit} onChange={e => setting(key, v, { loadUnit: e.target.value as 'kg' | 'lb' })}><option value="kg">kg</option><option value="lb">lb</option></select></label>
              <label>Carico <select aria-label={`Carico ${v.name}`} disabled={locked || confirming} value={v.loadConvention} onChange={e => setting(key, v, { loadConvention: e.target.value as CatalogExerciseValues['loadConvention'] })}><option value="total">Totale</option><option value="single-dumbbell">Un manubrio</option><option value="bodyweight">Corpo libero</option></select></label>
              <label><input type="checkbox" aria-label={`Per lato ${v.name}`} disabled={locked || confirming} checked={v.perSide} onChange={e => setting(key, v, { perSide: e.target.checked })} />Per lato</label>
              <label>Variante <input aria-label={`Variante ${v.name}`} disabled={locked || confirming} value={v.variant} onChange={e => setting(key, v, { variant: e.target.value })} /></label>
              <label>Attrezzo <input aria-label={`Attrezzo ${v.name}`} disabled={locked || confirming} value={v.equipment} onChange={e => setting(key, v, { equipment: e.target.value })} /></label>
            </details></li>
          })}</ul><p className="field-help">Impostazioni iniziali dell’app: kg, carico totale, non per lato; variante e attrezzo vuoti. Sono modificabili e accettate con la conferma finale. Misura dalla colonna compilata. Gli esercizi ripetuti compatibili vengono creati una sola volta al salvataggio.</p><p className="field-help">Nessun ciclo automatico; serie facoltative iniziali 0, RIR/RPE non impostati. Condizioni e progressioni restano nelle note.</p></div>}
          {diet && <p className="field-help">Quantità testuali, anche vuote se non prescritte. Le Note degli alimenti vengono conservate nel pasto con il nome dell’alimento; alternative e aggiunte rimangono separate dal pasto base. Orario non impostato.</p>}
          <label className="si-follow"><input type="checkbox" checked={follow} disabled={locked || confirming || !context.selectionKnown} onChange={e => setFollow(e.target.checked)} />Inizia a seguirlo nel diario</label>
          {!context.selectionKnown && <p className="field-help" role="status">Attendo la selezione dei piani online per attivare «Inizia a seguirlo».</p>}
          {follow && context.followedName && <p>Sostituirà il piano seguito: {context.followedName}.</p>}
          {!context.online && <p role="status">Sei offline: puoi correggere la bozza; torna online per salvare.</p>}
          {confirming ? <div className="button-row"><button className="button secondary" disabled={locked} onClick={() => setConfirming(false)}>Torna alle correzioni</button><button className="button primary si-save" disabled={locked || !built.command || !context.online || !slot.durable} onClick={() => { if (built.command) void engine.save(kind, built.command) }}>Conferma e salva</button></div>
            : <button className="button primary si-confirm" disabled={locked || !built.command || !slot.durable || !context.online} onClick={() => setConfirming(true)}>Continua al salvataggio</button>}
        </section>}
    </>}
  </>
}
