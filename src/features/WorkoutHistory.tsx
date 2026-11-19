import { useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { Segmented } from '../components/Segmented'
import { SubpageHeader } from '../components/SubpageHeader'
import { navigate } from '../app/route'
import { cycleRecapHref } from '../domain/cycle-recap'
import { formatDate } from '../domain/dates'
import type { DiaryData } from '../domain/diary'
import { cycleInfo } from '../domain/progress'
import type { ProgramCycle, ProgramRoot } from '../domain/programs'
import type { WorkoutSession } from '../domain/types'
import { historyRoute, historySessionGroups, historySessionHref, workoutHistory } from '../domain/workout-history'
import type { HistoryTab } from '../domain/workout-history'
import { completedCardioMinutes } from '../domain/workout'
import './workout-history.css'

type HistoryCycle = ReturnType<typeof workoutHistory>['past'][number]
const tabs = [{ value: 'attuale', label: 'Attuale' }, { value: 'passati', label: 'Passati' }, { value: 'liberi', label: 'Liberi' }] satisfies { value: HistoryTab; label: string }[]
const shortDate = (date: string) => formatDate(date, { day: 'numeric', month: 'short', year: 'numeric' })
const countText = (count: number, singular: string, plural: string) => `${count} ${count === 1 ? singular : plural}`
const sessionCount = (count: number) => countText(count, 'seduta', 'sedute')
const minutesText = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 })

function HistoryDisclosure({ className, label, initiallyOpen = false, children }: {
  className: string; label: ReactNode; initiallyOpen?: boolean; children: ReactNode
}) {
  const [open, setOpen] = useState(initiallyOpen)
  return <details className={className} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}<Icon name="chevronDown" size={16} /></summary>
    {open && children}
  </details>
}

function SessionLinks({ sessions, tab }: { sessions: WorkoutSession[]; tab: HistoryTab }) {
  return <ul className="workout-history-session-list">
    {sessions.map(session => {
      const sets = Object.values(session.results).flat().filter(set => set.completed).length
      const cardio = session.kind === 'free' ? completedCardioMinutes(session) : 0
      return <li key={session.id}><a href={historySessionHref(tab, session.id)}>
        <span><strong>{session.day.title}</strong><small>{formatDate(session.date)} · {cardio > 0 && sets === 0 ? `${minutesText.format(cardio)} min cardio`
          : <>{countText(sets, 'serie completata', 'serie completate')}{cardio > 0 && ` · ${minutesText.format(cardio)} min cardio`}</>}</small></span>
        <Icon name="chevron" size={16} />
      </a></li>
    })}
  </ul>
}

function SessionGroups({ sessions, cycle, tab, openLatest = false }: {
  sessions: WorkoutSession[]; cycle?: ProgramCycle; tab: HistoryTab; openLatest?: boolean
}) {
  const groups = historySessionGroups(sessions, cycle)
  const [latest, previous, ...earlier] = groups
  if (!latest) return null
  const group = ({ key, sessions }: typeof groups[number], open = false) =>
    <HistoryDisclosure key={key} className="workout-history-group" initiallyOpen={open}
      label={<><strong>{cycle ? `Settimana ${key}` : formatDate(`${key}-01`, { month: 'long', year: 'numeric' })}</strong>
        <small>{sessionCount(sessions.length)}</small></>}>
      <SessionLinks sessions={sessions} tab={tab} />
    </HistoryDisclosure>
  return <div className="workout-history-groups">
    {group(latest, openLatest)}{previous && group(previous)}
    {earlier.length > 0 && <HistoryDisclosure className="workout-history-group workout-history-earlier"
      label={<><strong>{cycle ? 'Settimane precedenti' : 'Mesi precedenti'}</strong>
        <small>{sessionCount(earlier.reduce((total, item) => total + item.sessions.length, 0))}</small></>}>
      <div className="workout-history-groups">{earlier.map(item => group(item))}</div>
    </HistoryDisclosure>}
  </div>
}

function CycleLabel({ entry, today, actual }: { entry: HistoryCycle; today: string; actual?: boolean }) {
  const info = entry.cycle ? cycleInfo(entry.cycle, today) : undefined
  return <>
    <span><strong>{entry.title}</strong>
      <small>{info ? `${shortDate(info.start)} – ${shortDate(info.end)}` : 'Sedute senza ciclo'} · {sessionCount(entry.sessions.length)}
        {actual && info?.status === 'active' && ` · Settimana ${info.week}`}</small>
    </span>
    <span className="workout-history-status">{entry.status}</span>
  </>
}

export function WorkoutHistory({ state, programs, current, today, tab }: {
  state: DiaryData; programs: ProgramRoot[]; current: ProgramRoot | null; today: string; tab: HistoryTab
}) {
  const history = workoutHistory(state, programs, current, today)
  const emptyCurrent = history.expiredSelection?.recap ? 'Il programma selezionato è concluso. Trovi le sedute in Passati.'
    : history.expiredSelection ? 'Il ciclo è arrivato alla fine. Puoi terminarlo o estenderlo dalla Scheda.' : 'Nessun programma attivo.'
  return <>
    <SubpageHeader back="#/scheda" backLabel="Torna alla scheda" title="Storico allenamenti" />
    <Segmented value={tab} options={tabs} onChange={value => navigate(historyRoute(value))} label="Storico allenamenti" className="workout-history-tabs" />
    {tab === 'attuale' && (history.current ? <section aria-label="Programma attuale">
      <div className="workout-history-current panel"><CycleLabel entry={history.current} today={today} actual /></div>
      {history.current.sessions.length > 0
        ? <SessionGroups key={history.current.key} sessions={history.current.sessions} cycle={history.current.cycle} tab={tab} openLatest />
        : <p className="panel workout-history-empty">Le sedute del programma compariranno qui appena le registri.</p>}
    </section> : <p className="panel workout-history-empty">{emptyCurrent}</p>)}
    {tab === 'passati' && (history.past.length ? <div className="workout-history-cycles">
      {history.past.map(entry => <HistoryDisclosure className="panel workout-history-cycle" key={entry.key}
        label={<CycleLabel entry={entry} today={today} />}>
        {entry.recap && <a className="button secondary workout-history-wrapped" href={cycleRecapHref(entry.recap.key)}><Icon name="star" size={16} />{entry.recap.unseen ? 'Apri il Wrapped' : 'Rivedi il Wrapped'}</a>}
        <SessionGroups sessions={entry.sessions} cycle={entry.cycle} tab={tab} openLatest />
      </HistoryDisclosure>)}
    </div> : <p className="panel workout-history-empty">I programmi precedenti compariranno qui.</p>)}
    {tab === 'liberi' && (history.free.length
      ? <SessionGroups sessions={history.free} tab={tab} openLatest />
      : <p className="panel workout-history-empty">Gli allenamenti liberi compariranno qui dopo averli registrati.</p>)}
  </>
}
