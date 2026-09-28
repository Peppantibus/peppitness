import { useState } from 'react'
import { Icon } from './Icon'
import type { IconName } from './Icon'
import { Modal } from './Modal'
import type { DiaryState, DiaryStore } from '../persistence/diary-store'

export const syncLabels: Record<DiaryState['sync'], string> = {
  local: 'Registrazioni solo in questa pagina: il ricaricamento le cancella.',
  synced: 'Sincronizzato.',
  pending: 'Salvato sul dispositivo, in attesa di invio.',
  sending: 'Salvato sul dispositivo, invio in corso…',
  waiting: 'Salvato sul dispositivo. Invio appena torna la connessione.',
  conflict: 'Da risolvere: alcune registrazioni sono diverse online.',
}

const syncIcons: Record<DiaryState['sync'], IconName> = { local: 'alert', synced: 'cloudCheck', pending: 'cloudUp', sending: 'cloudUp', waiting: 'cloudOff', conflict: 'alert' }
const syncTitles: Record<DiaryState['sync'], string> = { local: 'Solo in questa pagina', synced: 'Sincronizzato', pending: 'In attesa di invio', sending: 'Invio in corso', waiting: 'In attesa della connessione', conflict: 'Da risolvere' }

/**
 * Stato del salvataggio in forma compatta: un'icona che si apre per i dettagli.
 * Il riquadro completo (`SyncStatus`) resta solo quando serve un'azione.
 */
export function SyncIndicator({ store, state, localOnly = false, withLabel = false }: { store: DiaryStore; state: DiaryState; localOnly?: boolean; withLabel?: boolean }) {
  const [open, setOpen] = useState(false)
  const sync = localOnly ? 'local' : state.sync
  const pending = !localOnly && state.pending > 0 && sync !== 'conflict' ? state.pending : 0
  const title = `${syncTitles[sync]}${pending ? ` (${pending})` : ''}`
  return <>
    {withLabel
      ? <button type="button" className={`sync-row sync-indicator-${sync}`} data-sync={sync} aria-haspopup="dialog" aria-label={`Stato del salvataggio: ${title}`} onClick={() => setOpen(true)}><Icon name={syncIcons[sync]} size={20} /><span>{title}</span></button>
      : <button type="button" className={`icon-button sync-indicator sync-indicator-${sync}`} data-sync={sync} aria-haspopup="dialog" aria-label={`Stato del salvataggio: ${title}`} title={title} onClick={() => setOpen(true)}><Icon name={syncIcons[sync]} size={20} /></button>}
    {open && <Modal label="Stato del salvataggio" onClose={() => setOpen(false)}>
      <div className="sync-details">
        <span className={`sync-details-icon sync-indicator-${sync}`}><Icon name={syncIcons[sync]} size={24} /></span>
        <h2>{syncTitles[sync]}</h2>
        <p>{syncLabels[sync]}{pending ? ` Registrazioni in attesa: ${pending}.` : ''}</p>
        {!localOnly && !state.storage && <p>Archivio del dispositivo non disponibile: tieni aperta la pagina finché le registrazioni risultano sincronizzate.</p>}
        {sync === 'conflict' && <p>Trovi le registrazioni da confrontare in cima alla pagina.</p>}
        {sync === 'synced' && <p className="muted">Le registrazioni sono salvate anche online e le ritrovi da ogni dispositivo.</p>}
        <div className="program-actions">{sync === 'waiting' && <button type="button" className="button primary" onClick={() => { store.retryNow(); setOpen(false) }}>Riprova ora</button>}<button type="button" className="button secondary" onClick={() => setOpen(false)}>Chiudi</button></div>
      </div>
    </Modal>}
  </>
}

/** Stato reale del diario e conflitti da risolvere con una scelta esplicita. */
export function SyncStatus({ store, state }: { store: DiaryStore; state: DiaryState }) {
  // Gli invii ordinari restano nell'indicatore compatto: il riquadro compare solo
  // quando serve attenzione (rete assente, conflitti, archivio non disponibile).
  if (['local', 'synced', 'pending', 'sending'].includes(state.sync) && state.storage && !state.message) return null
  return <section className={`sync-status sync-${state.sync}`} aria-label="Stato del salvataggio">
    <p role="status"><Icon name={state.sync === 'conflict' ? 'info' : state.sync === 'synced' ? 'check' : 'clock'} size={16} />{syncLabels[state.sync]}{state.pending > 0 && state.sync !== 'conflict' ? ` (${state.pending})` : ''}</p>
    {!state.storage && <p role="alert">Archivio del dispositivo non disponibile: tieni aperta la pagina finché le registrazioni risultano sincronizzate.</p>}
    {state.message && <p className="small">{state.message}</p>}
    {state.sync === 'waiting' && <button className="text-button" onClick={store.retryNow}>Riprova ora</button>}
    {state.conflicts.length > 0 && <ul className="sync-conflicts">{state.conflicts.map(conflict => <li key={conflict.id}>
      <strong>{conflict.label}</strong>
      <span>Su questo dispositivo: {conflict.local}</span>
      <span>{conflict.kind === 'conflict' ? `Online: ${conflict.remote}` : conflict.remote}</span>
      <div className="program-actions">{conflict.kind !== 'rejected' && <button className="button primary" onClick={() => store.keepMine(conflict.id)}>{conflict.kind === 'blocked' ? 'Riprova' : 'Mantieni il mio'}</button>}<button className="button secondary" onClick={() => store.useOnline(conflict.id)}>{conflict.kind === 'conflict' ? 'Usa quello online' : 'Scarta dal dispositivo'}</button></div>
    </li>)}</ul>}
  </section>
}
