import { formatDate, isLocalDate, localDate, shiftDate, weekDates } from '../domain/dates'
import { Icon } from './Icon'

/**
 * Giorno scelto e settimana. La data compare una sola volta, nel pulsante che apre il calendario.
 * Sotto ogni giorno: punto pieno per `done` (qualcosa di registrato), anello per `planned`
 * (seduta prevista). Forme diverse, così lo stato non dipende solo dal colore.
 */
export function DatePicker({ date, onChange, today = localDate(), planned = [], done = [], plannedLabel = 'seduta prevista', doneLabel = 'registrato' }: {
  date: string; onChange: (date: string) => void; today?: string
  planned?: string[]; done?: string[]; plannedLabel?: string; doneLabel?: string
}) {
  const sameYear = date.slice(0, 4) === today.slice(0, 4)
  const year = sameYear ? {} : { year: 'numeric' } as const
  const long = formatDate(date, { weekday: 'long', day: 'numeric', month: 'long', ...year })
  const short = formatDate(date, { weekday: 'short', day: 'numeric', month: 'short', ...year }).replace(/\./g, '')
  return <section className={`date-panel ${date !== today ? 'is-other-day' : ''}`} aria-label="Seleziona il giorno">
    <div className="date-topline">
      <label className="date-button">
        <Icon name="calendar" size={20} />
        <span className="date-button-text" aria-hidden="true">{date === today && <strong>Oggi</strong>}<span className="date-long">{long}</span><span className="date-short">{short}</span></span>
        <Icon name="chevronDown" size={16} />
        <input type="date" aria-label={`Scegli una data. Selezionata: ${date === today ? 'oggi, ' : ''}${long}`} value={date} min="2000-01-01" max="2100-12-31" onChange={e => { if (isLocalDate(e.target.value)) onChange(e.target.value) }} />
      </label>
      <div className="date-actions">
        <button className="icon-button" aria-label="Settimana precedente" onClick={() => onChange(shiftDate(date, -7))}><Icon name="back" size={20} /></button>
        <button className="icon-button" aria-label="Settimana successiva" onClick={() => onChange(shiftDate(date, 7))}><Icon name="arrow" size={20} /></button>
      </div>
    </div>
    <div className="week-strip">{weekDates(date).map(day => {
      const isDone = done.includes(day)
      const isPlanned = !isDone && planned.includes(day)
      return <button key={day} className={`week-day ${day === date ? 'selected' : ''} ${day === today ? 'is-today' : ''}`} aria-pressed={day === date} aria-label={`${formatDate(day, { weekday: 'long', day: 'numeric', month: 'long' })}${day === today ? ', oggi' : ''}${isDone ? `, ${doneLabel}` : isPlanned ? `, ${plannedLabel}` : ''}`} onClick={() => onChange(day)}>
        <span>{formatDate(day, { weekday: 'short' }).replace('.', '')}</span><strong>{formatDate(day, { day: 'numeric' })}</strong><span className={`week-day-mark ${isDone ? 'is-done' : isPlanned ? 'is-planned' : ''}`} />
      </button>
    })}</div>
  </section>
}

/** Promemoria ben visibile quando non si sta guardando oggi, con il ritorno a oggi. */
export function DateContext({ date, today, onToday }: { date: string; today: string; onToday: () => void }) {
  if (date === today) return null
  const label = formatDate(date, { weekday: 'short', day: 'numeric', month: 'short', ...(date.slice(0, 4) === today.slice(0, 4) ? {} : { year: 'numeric' }) }).replace(/\./g, '')
  return <div className="past-notice" role="status">
    <Icon name="calendar" size={20} />
    <span>Stai guardando <strong>{label}</strong> · giornata {date < today ? 'passata' : 'futura'}</span>
    <button type="button" className="past-notice-today" onClick={onToday}>Torna a oggi</button>
  </div>
}
