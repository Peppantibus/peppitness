import { formatDate, isLocalDate, localDate, shiftDate, weekDates } from '../domain/dates'
import { Icon } from './Icon'

export function DatePicker({ date, onChange }: { date: string; onChange: (date: string) => void }) {
  const today = localDate()
  return <section className="date-panel" aria-label="Seleziona il giorno">
    <div className="date-topline">
      <div className="month-label"><Icon name="calendar" size={18} /><span>{formatDate(date, { month: 'long', year: 'numeric' })}</span></div>
      <div className="date-actions">
        {date !== today && <button className="text-button" onClick={() => onChange(today)}>Oggi</button>}
        <label className="calendar-input" title="Scegli una data"><Icon name="calendar" size={19} /><input type="date" aria-label="Scegli una data" value={date} min="2000-01-01" max="2100-12-31" onChange={e => { if (isLocalDate(e.target.value)) onChange(e.target.value) }} /></label>
        <button className="icon-button" aria-label="Settimana precedente" onClick={() => onChange(shiftDate(date, -7))}><Icon name="back" size={18} /></button>
        <button className="icon-button" aria-label="Settimana successiva" onClick={() => onChange(shiftDate(date, 7))}><Icon name="arrow" size={18} /></button>
      </div>
    </div>
    <div className="week-strip">{weekDates(date).map(day => <button key={day} className={`week-day ${day === date ? 'selected' : ''}`} aria-pressed={day === date} aria-label={formatDate(day, { weekday: 'long', day: 'numeric', month: 'long' })} onClick={() => onChange(day)}><span>{formatDate(day, { weekday: 'short' }).replace('.', '')}</span><strong>{formatDate(day, { day: 'numeric' })}</strong><span className={`today-dot ${day === today ? 'visible' : ''}`} /></button>)}</div>
  </section>
}
