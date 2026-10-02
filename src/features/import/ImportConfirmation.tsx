import { useState } from 'react'
import { Icon } from '../../components/Icon'
import type { ReviewItem } from '../../import/contracts/index.ts'
import type { ImportNetwork } from '../../persistence/imports-store'
import { DietImportPreview } from './DietImportPreview'
import type { DietReviewResult } from './DietReview'
import { WorkoutImportPreview } from './WorkoutImportPreview'
import type { WorkoutReviewResult } from './WorkoutReview'

export type ConfirmationResult = { kind: 'workout'; result: WorkoutReviewResult } | { kind: 'diet'; result: DietReviewResult }

const dateFormat = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })
const ruleKinds: Record<string, string> = { phase: 'fasi', progression: 'progressioni', deload: 'scarichi', superset: 'superserie', circuit: 'circuiti', cardio: 'cardio', other: 'altre regole' }

/**
 * Conferma finale (task 22): nome, cosa è stato deciso e cosa resta da seguire a mano, anteprima esatta del
 * mapping 09/10 (la stessa del comando), scelta «Inizia a seguirlo» disattivata per default anche su un
 * account vuoto, duplicato con riapertura o copia esplicita. Nessuna scrittura qui: `onSave` passa allo store 21.
 */
export function ImportConfirmation({ value, selectionKnown, followedName, network, saving, online, onSave, onBack }: {
  value: ConfirmationResult
  /** false se la selezione attiva non è stata letta dal server: «segui» non è disponibile. */
  selectionKnown: boolean
  /** Nome del piano seguito ora nella stessa sezione, se c'è. */
  followedName: string | null
  network: ImportNetwork
  saving: boolean
  online: boolean
  onSave: (options: { follow: boolean; allowDuplicate: boolean }) => void
  onBack: () => void
}) {
  const [follow, setFollow] = useState(false)
  // Copia scelta esplicitamente: resta valida per i tentativi successivi della stessa conferma (es. dopo un conflitto).
  const [copy, setCopy] = useState(false)
  const workout = value.kind === 'workout'
  const name = workout ? value.result.mapping.resolved.title : value.result.mapping.plan.name
  const current = value.result.draft.current as readonly ReviewItem[]
  const confirmed = value.result.draft.decisions.filter(decision => decision.op === 'confirm').length
  const prepared = value.result.draft.decisions.filter(decision => decision.decisionId.startsWith('prep-catalog-') || decision.decisionId.startsWith('prep-optional-')).length
  const edited = value.result.draft.decisions.filter(decision => decision.op !== 'confirm' && !decision.decisionId.startsWith('prep-')).length
  const rules = current.filter(item => item.collection === (workout ? 'complexRules' : 'globalRules'))
  const manualKinds = workout ? [...new Set(rules.map(item => ruleKinds[(item.values as { kind: string }).kind] ?? 'altre regole'))] : []
  const section = workout ? 'Scheda' : 'Dieta'
  const duplicates = network.duplicates ?? []
  const disabled = saving || !online || network.activity !== null

  return <section className="panel import-confirmation" aria-labelledby="import-confirmation-title" data-confirmation={value.kind}>
    <h2 id="import-confirmation-title">Conferma l’importazione</h2>
    <p className="import-confirmation-name"><strong>{name}</strong></p>
    <ul className="import-confirmation-facts">
      <li><Icon name="check" size={16} />{workout ? `Nuovo programma con ${value.result.mapping.resolved.days.length} ${value.result.mapping.resolved.days.length === 1 ? 'seduta' : 'sedute'}, pubblicato al salvataggio` : `Nuovo piano alimentare con ${value.result.mapping.plan.document.days.length} ${value.result.mapping.plan.document.days.length === 1 ? 'giornata' : 'giornate'}`}.</li>
      <li><Icon name="edit" size={16} />{edited ? `${edited} ${edited === 1 ? 'modifica tua' : 'modifiche tue'}` : 'Nessuna modifica'} e {confirmed} {confirmed === 1 ? 'punto confermato' : 'punti confermati'} nella revisione.</li>
      {prepared > 0 && <li><Icon name="check" size={16} />Abbinamenti e dosi base predisposti dall’app sono inclusi in questa conferma. I nuovi esercizi mostrati nell’anteprima verranno creati al salvataggio.</li>}
      {rules.length > 0 && <li className="is-manual"><Icon name="alert" size={16} />{workout
        ? `Da seguire a mano: ${rules.length} ${rules.length === 1 ? 'regola' : 'regole'} (${manualKinds.join(', ')}) riportate nelle indicazioni, non trasformate in sedute automatiche.`
        : `${rules.length} ${rules.length === 1 ? 'regola generale riportata' : 'regole generali riportate'} nelle indicazioni del piano: vanno applicate a mano.`}</li>}
      <li><Icon name="info" size={16} />Nessuna seduta o pasto viene segnato come svolto: lo storico non cambia.</li>
    </ul>

    {value.kind === 'workout'
      ? <WorkoutImportPreview mapping={{ ok: true, value: value.result.mapping, issues: [] }} draft={value.result.draft} />
      : <DietImportPreview mapping={{ ok: true, value: value.result.mapping, issues: [] }} />}

    <fieldset className="import-follow">
      <legend>Dopo il salvataggio</legend>
      <label className="import-follow-option">
        <input type="checkbox" checked={follow} disabled={!selectionKnown || disabled} onChange={event => setFollow(event.target.checked)} />
        <span><strong>Inizia a seguirlo</strong><small>{!selectionKnown
          ? 'Non riesco a leggere il piano che segui ora: puoi salvare senza seguirlo e sceglierlo dopo.'
          : followedName ? `Sostituisce «${followedName}» solo nella ${section}; l’altra sezione non cambia.` : `Diventa il piano seguito nella ${section}; l’altra sezione non cambia.`}</small></span>
      </label>
    </fieldset>

    {network.rejection === 'selection_conflict' && <div className="import-callout is-warning" role="alert"><Icon name="alert" size={20} /><div><strong>Il piano seguito è cambiato</strong><p>Nulla è stato salvato. Ho riletto la selezione: controlla la scelta qui sopra e conferma di nuovo, seguendolo o no.</p></div></div>}
    {duplicates.length > 0 && <div className="import-callout is-warning import-duplicate" role="alert"><Icon name="alert" size={20} /><div>
      <strong>Hai già importato lo stesso contenuto</strong>
      <p>{duplicates.length === 1 ? `Salvato il ${dateFormat.format(new Date(duplicates[0]!.createdAt))}.` : `${duplicates.length} importazioni identiche, l’ultima il ${dateFormat.format(new Date(duplicates[0]!.createdAt))}.`} Puoi aprire quello già salvato oppure crearne una copia separata.</p>
      <div className="button-row">
        <a className="button secondary" href={workout ? '#/scheda/programmi' : '#/dieta/piani'}>Apri {workout ? 'i programmi' : 'i piani'}</a>
        <button type="button" className="button secondary import-copy" disabled={disabled} onClick={() => { setCopy(true); onSave({ follow, allowDuplicate: true }) }}>Crea comunque una copia</button>
      </div>
    </div></div>}

    <div className="button-row import-confirmation-actions">
      <button type="button" className="button secondary" disabled={saving} onClick={onBack}>Torna alla revisione</button>
      <button type="button" className="button primary lg import-save" disabled={disabled || duplicates.length > 0} onClick={() => onSave({ follow, allowDuplicate: copy })}>
        {saving ? 'Salvataggio…' : workout ? 'Salva il programma' : 'Salva il piano'}
      </button>
    </div>
    {!online && <p className="import-notice is-warning" role="status">Sei offline: la revisione resta qui, il salvataggio riparte quando torna la connessione.</p>}
  </section>
}
