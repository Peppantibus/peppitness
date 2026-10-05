import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { formatDate } from '../domain/dates'
import { sessionSummary } from '../domain/records'
import { formatResult } from '../domain/workout'
import type { WorkoutSession } from '../domain/types'

const decimal = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 })
const duration = (minutes: number) => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`

/** Riepilogo mostrato appena terminato l'allenamento: durata, serie, volume, record e confronto. */
export function SessionSummaryDialog({ session, sessions, onClose }: { session: WorkoutSession; sessions: WorkoutSession[]; onClose: () => void }) {
  const summary = sessionSummary(session, sessions)
  const { previous } = summary
  const change = previous && previous.volume > 0 && summary.volume > 0 ? Math.round((summary.volume - previous.volume) / previous.volume * 100) : null
  const when = previous ? formatDate(previous.date, { day: 'numeric', month: 'long' }) : ''
  const compare = !previous ? 'Prima volta per questa seduta: dalla prossima vedrai il confronto.'
    : change === null ? `${summary.sets} serie completate, la volta scorsa (${when}) ${previous.sets}.`
      : change === 0 ? `Stesso volume della volta scorsa (${when}).`
        : `Volume ${change > 0 ? '+' : ''}${change}% rispetto alla volta scorsa (${when}).`
  const records = summary.records.length
  return <Modal label="Allenamento completato" onClose={onClose}>
    <div className="session-summary">
      <span className="session-summary-icon" aria-hidden="true"><Icon name="check" size={32} strokeWidth={2.5} /></span>
      <h2>Allenamento completato</h2>
      <p className="muted">{session.day.title} · {formatDate(session.date, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
      <dl className="session-summary-stats">
        <div><dt>Durata</dt><dd>{summary.minutes === null ? '—' : duration(summary.minutes)}</dd></div>
        <div><dt>Serie</dt><dd>{summary.sets}<small>/{summary.requiredSets}</small></dd></div>
        <div><dt>Volume</dt><dd>{summary.volume > 0 ? <>{decimal.format(summary.volume)}<small> kg</small></> : '—'}</dd></div>
      </dl>
      {records > 0 && <section className="session-summary-records" aria-labelledby="summary-records">
        <h3 id="summary-records"><Icon name="star" size={20} />{records === 1 ? 'Nuovo record personale' : `${records} nuovi record personali`}</h3>
        <ul>{summary.records.map(record => <li key={record.exercise.id}><span>{record.exercise.name}</span><strong>{formatResult(session.results[record.exercise.id]?.[record.index], record.exercise.mode, record.exercise.loadUnit)}</strong></li>)}</ul>
      </section>}
      <p className={`session-summary-compare ${change !== null && change > 0 ? 'is-up' : ''}`}>{change !== null && change > 0 && <Icon name="trend" size={20} />}{compare}</p>
      <div className="program-actions">
        <a className="button secondary" href={`#/scheda/storico/${session.id}`} onClick={onClose}>Vedi le serie</a>
        <button type="button" className="button primary session-summary-close" onClick={onClose}>Fatto</button>
      </div>
    </div>
  </Modal>
}
