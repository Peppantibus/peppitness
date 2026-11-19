import { useEffect, useRef, useState } from 'react'
import type { PointerEvent, ReactNode } from 'react'
import { Icon } from '../components/Icon'
import type { CycleRecapReport } from '../domain/cycle-recap'
import { createWorkoutProgramHref } from '../domain/cycle-recap'
import { formatDate } from '../domain/dates'
import { historyRoute } from '../domain/workout-history'
import { CycleExerciseList } from './CycleReportDetails'
import { saveCycleStoryCard } from './cycle-story-card'
import './cycle-story.css'

type Story = { id: string; label: string; duration: number; content: ReactNode }
const shortDate = (date: string) => formatDate(date, { day: 'numeric', month: 'short' })
const fullDate = (date: string) => formatDate(date, { day: 'numeric', month: 'long' })
const weeksText = (count: number) => count === 1 ? 'settimana' : 'settimane'

function WeekTrack({ weeks }: { weeks: number[] }) {
  return <ol className="cycle-story-track" aria-label="Sedute registrate per settimana">
    {weeks.map((count, index) => <li key={index} className={count ? 'has-workout' : undefined}>
      <span aria-hidden="true">{index + 1}</span>
      <strong aria-hidden="true">{count || '–'}</strong>
      <span className="sr-only">Settimana {index + 1}, {count} {count === 1 ? 'allenamento' : 'allenamenti'}</span>
    </li>)}
  </ol>
}

function storiesFor(report: CycleRecapReport, program: string, range: string): Story[] {
  const { sessions, sets, info, groups, streak, activeWeeks, weeks, pauses, record } = report
  const stories: Story[] = [
    { id: 'opening', label: 'Il tuo ciclo', duration: 6500, content: <>
      <small className="cycle-story-kicker">{info.weeks} {weeksText(info.weeks)} di allenamento</small>
      <h1>Il tuo <br />ciclo<span>.</span></h1>
      <p className="cycle-story-lead">{program}</p>
      <p className="cycle-story-note">{range}</p>
      <dl className="cycle-story-stats">
        <div><dt>Allenamenti registrati</dt><dd>{sessions}</dd></div>
        <div><dt>Serie completate</dt><dd>{sets}</dd></div>
      </dl>
    </> },
  ]

  if (groups.length) stories.push({
    id: 'exercises', label: 'Gli esercizi', duration: 18000, content: <>
      <h1>Gli esercizi <br />del ciclo<span>.</span></h1>
      <CycleExerciseList groups={groups} />
    </>,
  })

  if (sessions) stories.push({
    id: 'rhythm', label: 'Il tuo ritmo', duration: 9500, content: <>
      <small className="cycle-story-kicker">Costanza</small>
      <h1 className="cycle-story-number">
        <strong>{streak >= 2 ? streak : activeWeeks}</strong>
        <span>{streak >= 2 ? 'settimane di fila.' : activeWeeks === 1 ? 'settimana di allenamento.' : 'settimane di allenamento.'}</span>
      </h1>
      <WeekTrack weeks={weeks} />
      <p className="cycle-story-note">{activeWeeks} su {info.weeks} settimane con allenamenti</p>
    </>,
  })

  if (pauses.length) {
    const pause = pauses[0]!
    const duration = pause.lastWeek - pause.firstWeek + 1
    stories.push({
      id: 'pause', label: 'Le pause', duration: 11000, content: <>
        <h1>{pauses.length === 1 ? <>{duration === 1 ? 'Una settimana' : `${duration} settimane`} <br />di pausa<span>.</span></> : <>Il ritmo <br />si è fermato<span>.</span></>}</h1>
        <ul className="cycle-story-breaks">
          {pauses.map(({ firstWeek, lastWeek, resumedIn }) => <li key={firstWeek}>
            <strong>{firstWeek === lastWeek ? `Settimana ${firstWeek}` : `Settimane ${firstWeek}–${lastWeek}`}</strong>
            <p>Senza sedute registrate.{resumedIn && ` Hai ripreso nella settimana ${resumedIn}.`}</p>
          </li>)}
        </ul>
      </>,
    })
  }

  if (record) stories.push({
    id: 'record', label: 'Il tuo record', duration: 9000, content: <>
      <small className="cycle-story-kicker">Record personale</small>
      <h1>{record.value}</h1>
      <p className="cycle-story-lead">{record.exercise}</p>
      <p className="cycle-story-note"><time dateTime={record.date}>{fullDate(record.date)}</time></p>
    </>,
  })

  stories.push({ id: 'finish', label: 'Il ciclo in breve', duration: 0, content: <>
    <h1>Il ciclo <br />in breve<span>.</span></h1>
    <p className="cycle-story-lead">{program}</p>
    <dl className="cycle-story-stats">
      <div><dt>Allenamenti</dt><dd>{sessions}</dd></div>
      <div><dt>Serie completate</dt><dd>{sets}</dd></div>
      {sessions > 0 && <div><dt>Settimane con allenamenti</dt><dd>{activeWeeks}/{info.weeks}</dd></div>}
      {streak > 1 && <div><dt>Settimane di fila</dt><dd>{streak}</dd></div>}
    </dl>
  </> })
  return stories
}

function startStoryTimer(duration: number, advance: () => void) {
  const startedAt = performance.now()
  const timeout = window.setTimeout(advance, duration)
  return () => {
    window.clearTimeout(timeout)
    return Math.max(0, duration - (performance.now() - startedAt))
  }
}

export function CycleStory({ report, programName, back, nextProgram, onCompleted }: {
  report: CycleRecapReport; programName: string; back: string; nextProgram?: boolean; onCompleted?: () => void
}) {
  const range = `${shortDate(report.info.start)} – ${shortDate(report.info.end)}`
  const stories = storiesFor(report, programName, range)
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [message, setMessage] = useState('')
  const archiveRequested = useRef(false)
  const clock = useRef({ story: '', remaining: 0 })
  const gesture = useRef<{ id: number; x: number; y: number } | null>(null)
  const last = stories.length - 1
  const current = Math.min(index, last)
  const story = stories[current]!
  const auto = playing && current < last

  useEffect(() => {
    if (current !== last || !onCompleted || archiveRequested.current) return
    archiveRequested.current = true
    onCompleted()
  }, [current, last, onCompleted])

  function move(index: number, play = false) {
    setPlaying(play)
    setMessage('')
    setIndex(Math.min(last, Math.max(0, index)))
  }

  useEffect(() => {
    if (clock.current.story !== story.id) clock.current = { story: story.id, remaining: story.duration }
    if (!auto) return
    const timing = clock.current
    const stop = startStoryTimer(timing.remaining, () => setIndex(current + 1))
    const pauseWhenHidden = () => { if (document.hidden) setPlaying(false) }
    document.addEventListener('visibilitychange', pauseWhenHidden)
    return () => {
      timing.remaining = stop()
      document.removeEventListener('visibilitychange', pauseWhenHidden)
    }
  }, [auto, current, story.duration, story.id])

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.defaultPrevented) return
      if (event.key === 'Escape') {
        window.location.hash = back.slice(1)
        return
      }
      const target = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: last }
      if (!Object.hasOwn(target, event.key)) return
      event.preventDefault()
      setPlaying(false)
      setMessage('')
      setIndex(Math.min(last, Math.max(0, target[event.key as keyof typeof target])))
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [back, current, last])

  function beginGesture(event: PointerEvent<HTMLElement>) {
    if (!event.isPrimary || (event.target as Element).closest('a, button')) return
    setPlaying(false)
    if (event.pointerType !== 'touch') return
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
  }

  function endGesture(event: PointerEvent<HTMLElement>) {
    const start = gesture.current
    gesture.current = null
    if (!start || start.id !== event.pointerId) return
    const dx = event.clientX - start.x, dy = event.clientY - start.y
    if (Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.35) {
      move(current + (dx < 0 ? 1 : -1))
    }
  }

  const saveCard = () => {
    const metrics = [
      { label: 'Allenamenti', value: String(report.sessions) },
      { label: 'Serie completate', value: String(report.sets) },
      { label: 'Settimane con allenamenti', value: `${report.activeWeeks}/${report.info.weeks}` },
    ]
    setMessage(saveCycleStoryCard({
      program: programName, range, metrics,
      detail: report.record
        ? `Record · ${report.record.value} · ${report.record.exercise}`
        : report.streak >= 2 ? `${report.streak} settimane di fila` : '',
    }) ? 'Card PNG pronta.' : 'Impossibile scaricare la card. Riprova.')
  }

  return <>
    <div className={`cycle-deck cycle-deck--${story.id}`} onClick={event => {
      if (!(event.target as Element).closest('a, button')) setPlaying(false)
    }}>
      <header className="cycle-deck-header">
        <a href={back} aria-label={back.startsWith('#/scheda/storico') ? 'Chiudi il riepilogo e torna allo Storico' : 'Chiudi il riepilogo e torna alla Scheda'} className="cycle-deck-icon"><Icon name="close" size={20} /></a>
        <span className="cycle-deck-brand">peppitness<span>.</span></span>
        {current < last && <button type="button" className="cycle-deck-icon" aria-label="Avanzamento automatico" aria-pressed={auto} onClick={() => setPlaying(!auto)}>
          <Icon name={auto ? 'pause' : 'play'} size={20} />
        </button>}
      </header>
      <nav className="cycle-deck-progress" aria-label="Storie del ciclo">
        {stories.map(({ id, label, duration }, step) => <button key={id} type="button"
          aria-label={`${step + 1} di ${stories.length} · ${label}`} aria-current={step === current ? 'step' : undefined}
          className={step < current ? 'is-seen' : step === current ? 'is-current' : undefined} onClick={() => move(step)}>
          <span>{(step <= current) && <i key={step === current ? 'current' : 'seen'} className={step === current && current < last ? 'is-timed' : undefined}
            style={{ animationDuration: `${duration}ms`, animationPlayState: auto ? 'running' : 'paused' }} />}</span>
        </button>)}
      </nav>
      <span className="sr-only" role="status" aria-live="polite">{current + 1} di {stories.length}. {story.label}.</span>
      <section className="cycle-deck-slide" key={story.id} aria-label={story.label} tabIndex={0}
        onPointerDown={beginGesture} onPointerUp={endGesture} onPointerCancel={() => { gesture.current = null }}
        onWheel={() => setPlaying(false)} onFocus={() => setPlaying(false)}>
        <div className="cycle-deck-art" aria-hidden="true"><i /><i /><i /></div>
        <div className="cycle-deck-content">
          {story.content}
          {current === last && <div className="cycle-story-end-actions">
            <button type="button" className="cycle-deck-button" onClick={saveCard}><Icon name="arrowDown" size={20} />Scarica la card</button>
            <button type="button" className="cycle-deck-button cycle-deck-print" onClick={() => window.print()}>Salva PDF</button>
            {nextProgram && <a className="cycle-deck-button cycle-story-next-program" href={createWorkoutProgramHref}>Crea un nuovo programma<Icon name="arrow" size={20} /></a>}
            {message && <p className="cycle-story-feedback" role="status">{message}</p>}
            {!onCompleted && <a className="cycle-story-history-link" href={`#${historyRoute('passati')}`}>Apri lo Storico</a>}
          </div>}
        </div>
      </section>
      <footer className="cycle-deck-footer">
        <button type="button" className="cycle-deck-icon" aria-label="Storia precedente" disabled={current === 0} onClick={() => move(current - 1)}><Icon name="back" size={20} /></button>
        {current < last
          ? <button type="button" className="cycle-deck-button" onClick={() => move(current + 1)}>Continua<Icon name="arrow" size={20} /></button>
          : <button type="button" className="cycle-deck-button cycle-deck-replay" onClick={() => move(0, true)}><Icon name="history" size={20} />Rivedi le storie</button>}
      </footer>
    </div>
    <article className="cycle-story-print" aria-label="Riepilogo del programma">
      {stories.slice(0, -1).map(item => <section key={item.id}>{item.content}</section>)}
    </article>
  </>
}
