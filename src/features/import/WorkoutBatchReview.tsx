import { useMemo, useState } from 'react'
import { exerciseChoiceValues, type NormalizedDocument, type ValidationIssue, type WorkoutReviewDraft } from '../../import/contracts/index.ts'
import type { CatalogSnapshot } from '../../import/matching/exercises.ts'
import { applyCatalogBatch, applyScalarBatch, applyScopeBatch, catalogBatchOffers, scalarBatchGroups, type ScalarBatchGroup } from '../../import/review/batch.ts'

const labels = { restSeconds: 'Recupero', durationSeconds: 'Durata', rir: 'RIR', rpe: 'RPE' }
export function WorkoutBatchReview({ draft, document, catalog, issues, onApply }: {
  draft: WorkoutReviewDraft; document: NormalizedDocument; catalog: CatalogSnapshot; issues: readonly ValidationIssue[]
  onApply: (change: (draft: WorkoutReviewDraft) => WorkoutReviewDraft) => void
}) {
  const offers = useMemo(() => catalogBatchOffers(draft, catalog), [draft, catalog])
  const ranges = useMemo(() => scalarBatchGroups(draft), [draft])
  const unresolved = new Set(issues.filter(i => ['complex_rule_unresolved', 'complex_rule_review'].includes(i.code)).map(i => i.localId))
  const rules = draft.current.filter(i => i.collection === 'complexRules' && unresolved.has(i.localId))
  const [scope, setScope] = useState('')
  if (!offers.length && !ranges.length && !rules.length) return null
  return <section className="panel wr-batch" aria-labelledby="rv-batch-title">
    <h2 id="rv-batch-title">Scelte in gruppo</h2>
    {offers.length > 0 && <details>
      <summary>Rivedi {offers.length} abbinamenti al catalogo</summary>
      <p className="field-help">Controlla anche variante, attrezzo e misura: confermando accetti i dati del catalogo mostrati qui.</p>
      <ul>{offers.map(o => { const v = exerciseChoiceValues(o.choice); return <li key={o.localId}><strong>{o.name}</strong>: {[v.variant, v.equipment, v.measurementMode === 'reps' ? 'ripetizioni' : 'secondi', v.perSide ? 'per lato' : 'non per lato', v.loadUnit, v.loadConvention === 'total' ? 'carico totale' : v.loadConvention === 'single-dumbbell' ? 'un manubrio' : 'corpo libero'].filter(Boolean).join(' · ')}</li> })}</ul>
      <button type="button" className="button secondary" onClick={() => onApply(current => applyCatalogBatch(current, catalog, offers))}>Conferma {offers.length} abbinamenti</button>
    </details>}
    {ranges.map(group => <ScalarGroup key={`${group.field}:${group.min}:${group.max}:${group.items.map(i => i.localId).join(',')}`} group={group}
      onChoose={chosen => onApply(current => applyScalarBatch(current, group, chosen))} />)}
    {rules.length > 0 && <details>
      <summary>Gestisci insieme {rules.length} regole</summary>
      <ul>{rules.map(rule => <li key={rule.localId}>{(rule.values as { text: string }).text}</li>)}</ul>
      <p className="field-help">Scrivi quale fase o settimana importi, oppure come gestirai queste regole a mano. Controlla poi serie e altri valori dei singoli esercizi.</p>
      <label htmlFor="rv-batch-scope">Scelta per queste regole</label>
      <textarea id="rv-batch-scope" value={scope} maxLength={1500} onChange={e => setScope(e.target.value)} />
      <button type="button" className="button secondary" disabled={!scope.trim()} onClick={() => onApply(current => applyScopeBatch(current, document, rules.map(r => r.localId), scope))}>Applica la scelta alle {rules.length} regole</button>
    </details>}
  </section>
}
function ScalarGroup({ group, onChoose }: { group: ScalarBatchGroup; onChoose: (value: number) => void }) {
  const [chosen, setChosen] = useState('')
  const valid = chosen.trim() !== '' && Number.isSafeInteger(Number(chosen)) && Number(chosen) >= group.min && Number(chosen) <= group.max
  const seconds = group.field === 'restSeconds' || group.field === 'durationSeconds'
  const id = `rv-batch-${group.field}-${group.min}-${group.max}`
  return <details>
    <summary>{labels[group.field]} {group.min}–{group.max}{seconds ? ' s' : ''}: {group.items.length} esercizi</summary>
    <ul>{group.items.map(item => <li key={item.localId}>{item.name}</li>)}</ul>
    <label htmlFor={id}>{seconds ? 'Valore da usare per il timer' : 'Valore da usare'} ({group.min}–{group.max})</label>
    <input id={id} type="number" inputMode="numeric" min={group.min} max={group.max} step={1} value={chosen} onChange={e => setChosen(e.target.value)} />
    <button type="button" className="button secondary" disabled={!valid} onClick={() => onChoose(Number(chosen))}>Applica a {group.items.length} esercizi</button>
  </details>
}
