import { Icon } from '../components/Icon'
import { SubpageHeader } from '../components/SubpageHeader'
import { formatDate } from '../domain/dates'
import type { DiaryData } from '../domain/diary'
import type { ProgramIndex, ProgramRoot } from '../domain/programs'
import { mealStatuses } from '../domain/types'
import type { HistoryTab } from '../domain/workout-history'
import { WorkoutHistory } from './WorkoutHistory'

export function History({ section, state, onDate, programs, current, today, tab }: {
  section: 'dieta' | 'scheda'; state: DiaryData; onDate: (date: string) => void
  programs: ProgramIndex[]; current: ProgramRoot | null; today: string; tab: HistoryTab
}) {
  if (section === 'scheda') return <WorkoutHistory state={state} programs={programs.map(entry => entry.plan)} current={current} today={today} tab={tab} />
  const dates = [...new Set(Object.values(state.mealLogs).map(log => log.date))].sort().reverse()
  return <><SubpageHeader back="#/dieta" backLabel="Torna alla dieta" title="Diario dei pasti" subtitle="Le tue registrazioni, giorno per giorno." />
    {dates.length === 0 ? <section className="empty-state panel"><span className="empty-icon"><Icon name="history" size={32} /></span><h2>Il tuo diario parte da qui.</h2>
      <p>Registra un pasto. Ritroverai qui la giornata e potrai tornare a modificarla.</p><a className="button primary" href="#/dieta">Vai ai pasti<Icon name="arrow" size={20} /></a>
    </section> : <div className="history-list">{dates.map(date => {
      const logs = Object.values(state.mealLogs).filter(log => log.date === date)
      return <button className="history-card panel" key={date} onClick={() => { onDate(date); window.location.hash = '/dieta' }}>
        <span className="meal-icon"><Icon name="calendar" /></span><span><strong>{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
          <small>{logs.map(log => `${log.snapshot.name}: ${mealStatuses[log.status]}`).join(' · ')}</small></span><Icon name="chevron" size={20} />
      </button>
    })}</div>}
  </>
}
