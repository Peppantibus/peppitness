import { Icon } from './Icon'
import type { DiaryState, DiaryStore } from '../persistence/diary-store'

export const syncLabels: Record<DiaryState['sync'], string> = {
  local: 'Registrazioni solo in questa pagina: il ricaricamento le cancella.',
  synced: 'Sincronizzato.',
  pending: 'Salvato sul dispositivo, in attesa di invio.',
  sending: 'Salvato sul dispositivo, invio in corso…',
  waiting: 'Salvato sul dispositivo. Invio appena torna la connessione.',
  conflict: 'Da risolvere: alcune registrazioni sono diverse online.',
}

/** Stato reale del diario e conflitti da risolvere con una scelta esplicita. */
export function SyncStatus({ store, state }: { store: DiaryStore; state: DiaryState }) {
  // Gli invii rapidi restano silenziosi (nota in fondo alla pagina): il riquadro compare
  // solo quando serve attenzione (rete assente, conflitti, archivio non disponibile).
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
