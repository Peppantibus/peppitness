import { Icon } from '../components/Icon'
import { SubpageHeader } from '../components/SubpageHeader'
import { formatDate } from '../domain/dates'
import { mealStatuses } from '../domain/types'
import type { DiaryData } from '../domain/diary'

export function History({ section, state, onDate }: { section: 'dieta' | 'scheda'; state: DiaryData; onDate: (date: string) => void }) {
  const sessions = state.sessions.filter(session => session.completedAt).sort((a, b) => b.date.localeCompare(a.date) || b.startedAt.localeCompare(a.startedAt))
  const dates = [...new Set(Object.values(state.mealLogs).map(log => log.date))].sort().reverse()
  const isEmpty = section === 'dieta' ? dates.length === 0 : sessions.length === 0
  return <><SubpageHeader back={`#/${section}`} backLabel={section === 'dieta' ? 'Torna alla dieta' : 'Torna alla scheda'} title={section === 'dieta' ? 'Diario dei pasti' : 'Le tue sedute'} subtitle="Le tue registrazioni, giorno per giorno." />{isEmpty ? <section className="empty-state panel"><span className="empty-icon"><Icon name="history" size={32} /></span><h2>Il tuo diario parte da qui.</h2><p>{section === 'dieta' ? 'Registra un pasto. Ritroverai qui la giornata e potrai tornare a modificarla.' : 'Completa un allenamento per ritrovare qui gli esercizi e le serie annotate.'}</p><a className="button primary" href={`#/${section}`}>{section === 'dieta' ? 'Vai ai pasti' : 'Esplora la scheda'}<Icon name="arrow" size={20} /></a></section> : <div className="history-list">{section === 'dieta' ? dates.map(date => {
    const logs = Object.values(state.mealLogs).filter(log => log.date === date)
    return <button className="history-card panel" key={date} onClick={() => { onDate(date); window.location.hash = '/dieta' }}><span className="meal-icon"><Icon name="calendar" /></span><span><strong>{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</strong><small>{logs.map(log => `${log.snapshot.name}: ${mealStatuses[log.status]}`).join(' · ')}</small></span><Icon name="chevron" size={20} /></button>
  }) : sessions.map(session => <a className="history-card panel" key={session.id} href={`#/scheda/storico/${session.id}`}><span className="meal-icon"><Icon name="dumbbell" /></span><span><strong>{session.day.title}</strong><small>{formatDate(session.date)} · {Object.values(session.results).flat().filter(set => set.completed).length} serie completate</small></span><Icon name="chevron" size={20} /></a>)}</div>}</>
}
