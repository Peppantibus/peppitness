import { Icon } from '../components/Icon'
import { formatDate } from '../domain/dates'
import { mealStatuses } from '../domain/types'
import type { DemoState } from '../persistence/demo-store'

export function History({ section, state, onDate }: { section: 'dieta' | 'scheda'; state: DemoState; onDate: (date: string) => void }) {
  const sessions = state.sessions.filter(session => session.completedAt).slice().reverse()
  const dates = [...new Set(Object.values(state.mealLogs).map(log => log.date))].sort().reverse()
  const isEmpty = section === 'dieta' ? dates.length === 0 : sessions.length === 0
  return <><a className="back-link" href={`#/${section}`}><Icon name="back" size={18} />Torna {section === 'dieta' ? 'alla dieta' : 'alla scheda'}</a><div className="page-heading"><div><span className="eyebrow">I TUOI PASSI, GIORNO PER GIORNO</span><h1>{section === 'dieta' ? 'Diario dei pasti' : 'Le tue sedute'}</h1><p>Le tue registrazioni, giorno per giorno.</p></div></div>{isEmpty ? <section className="empty-state panel"><span className="empty-icon"><Icon name="history" size={32} /></span><h2>Il tuo diario parte da qui.</h2><p>{section === 'dieta' ? 'Registra un pasto. Ritroverai qui la giornata e potrai tornare a modificarla.' : 'Completa un allenamento per ritrovare qui gli esercizi e le serie annotate.'}</p><a className="button primary" href={`#/${section}`}>{section === 'dieta' ? 'Vai ai pasti' : 'Esplora la scheda'}<Icon name="arrow" size={18} /></a></section> : <div className="history-list">{section === 'dieta' ? dates.map(date => {
    const logs = Object.values(state.mealLogs).filter(log => log.date === date)
    return <button className="history-card panel" key={date} onClick={() => { onDate(date); window.location.hash = '/dieta' }}><span className="meal-icon"><Icon name="calendar" /></span><span><strong>{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</strong><small>{logs.map(log => `${log.snapshot.name}: ${mealStatuses[log.status]}`).join(' · ')}</small></span><Icon name="chevron" size={18} /></button>
  }) : sessions.map(session => <a className="history-card panel" key={session.id} href={`#/scheda/storico/${session.id}`}><span className="meal-icon"><Icon name="dumbbell" /></span><span><strong>{session.day.title}</strong><small>{formatDate(session.date)} · {Object.values(session.results).flat().filter(set => set.completed).length} serie completate</small></span><Icon name="chevron" size={18} /></a>)}</div>}</>
}
