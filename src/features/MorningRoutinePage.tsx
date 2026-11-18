import { useEffect, useRef, useState } from 'react'
import { navigate } from '../app/route'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { formatDate, shiftDate } from '../domain/dates'
import { morningDaysLabel, morningDuration, morningForDate, morningRoutineDefaultTitle, morningRoutineTitle } from '../domain/morning-routine'
import type { MorningExercise, MorningRoutine } from '../domain/morning-routine'
import type { MorningRoutineStore, MorningState } from '../persistence/morning-routine-store'
import { installAudioUnlock } from '../workout-alerts'
import { MorningExerciseTimer } from './MorningExerciseTimer'
import { MorningRoutineEditor } from './MorningRoutineEditor'

const minutesLabel = (minutes: number) => `${minutes.toLocaleString('it-IT')} min`

function Sequence({ items, offset = 0, active, checkedIds, onCheck, onStart }: {
  items: MorningExercise[]
  offset?: number
  active: string | undefined
  checkedIds: ReadonlySet<string>
  onCheck: (id: string, checked: boolean) => void
  onStart: (item: MorningExercise, button: HTMLButtonElement) => void
}) {
  return <ol className="morning-sequence" role="list" start={offset + 1}>
    {items.map((item, index) => {
      const selected = item.id === active
      const checked = checkedIds.has(item.id)
      const description = [item.area, item.dose].filter(Boolean).join(' · ')
      return <li key={item.id} className={`morning-movement${selected ? ' is-active' : ''}`}>
        <button
          type="button"
          className="morning-movement-check"
          aria-label={`Completato: ${item.name}`}
          aria-pressed={checked}
          onClick={() => onCheck(item.id, !checked)}
        >
          <span className="morning-number" aria-hidden="true">{checked ? <Icon name="check" size={16} /> : offset + index + 1}</span>
        </button>
        <details>
          <summary>
            <span className="morning-movement-copy">
              <strong>{item.name}</strong>
              {description && <small>{description}</small>}
            </span>
            <Icon name="chevronDown" size={16} />
          </summary>
          <p className="morning-movement-detail">{item.note || 'Nessuna istruzione aggiunta.'}</p>
        </details>
        <button
          type="button"
          className="morning-timer-start"
          aria-label={`${selected ? 'Vai al timer di' : 'Avvia timer per'} ${item.name}, ${minutesLabel(item.minutes)}`}
          onClick={event => onStart(item, event.currentTarget)}
        >
          <Icon name={selected ? 'clock' : 'play'} size={16} />
          <span>{minutesLabel(item.minutes)}</span>
        </button>
      </li>
    })}
  </ol>
}

function RoutineDay({ routine, date, today, done, store, onDate }: {
  routine: MorningRoutine
  date: string
  today: string
  done: boolean
  store: MorningRoutineStore
  onDate: (date: string) => void
}) {
  const [active, setActive] = useState<MorningExercise | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [checkedIds, setCheckedIds] = useState<ReadonlySet<string>>(() => new Set())
  const schedule = morningForDate(routine, date)
  const dayKey = JSON.stringify([date, schedule.exercises.map(item => [item.id, item.name, item.minutes, item.area, item.dose, item.note])])
  const [previousDay, setPreviousDay] = useState({ key: dayKey, done })
  if (previousDay.key !== dayKey || previousDay.done !== done) {
    setPreviousDay({ key: dayKey, done })
    setActive(null)
    setUndoing(false)
    if (previousDay.key !== dayKey) setCheckedIds(new Set())
  }
  const triggerRef = useRef<HTMLButtonElement>(null)
  const controlsRef = useRef<HTMLButtonElement>(null)
  useEffect(installAudioUnlock, [])
  useEffect(() => {
    if (active) controlsRef.current?.focus({ preventScroll: true })
  }, [active])

  const start = (item: MorningExercise, button: HTMLButtonElement) => {
    if (item.id === active?.id) {
      controlsRef.current?.focus({ preventScroll: true })
      return
    }
    triggerRef.current = button
    setActive(item)
  }
  const clearTimer = () => {
    setActive(null)
    triggerRef.current?.focus()
  }
  const checkExercise = (id: string, checked: boolean) => {
    setCheckedIds(previous => {
      if (previous.has(id) === checked) return previous
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const future = date > today
  const current = date === today

  return <div className={`morning-page morning-view${active ? ' has-morning-timer' : ''}`}>
    <header className="morning-toolbar">
      <a className="morning-back-link" href="#/scheda"><Icon name="back" size={20} />Scheda</a>
      <a className="button secondary morning-edit" href="#/scheda/mattino/modifica"><Icon name="edit" size={16} />Modifica</a>
    </header>

    <div className="morning-layout">
      <div className="morning-overview">
        <div className="morning-heading">
          <div className="morning-heading-top">
            <span className="morning-sun"><Icon name="sun" size={24} /></span>
            <span className={`morning-status${done ? ' is-done' : ''}`}>
              {done ? <><Icon name="check" size={16} />Fatta</> : future ? 'In programma' : 'Da fare'}
            </span>
          </div>
          <h1>{morningRoutineTitle(routine.title)}<span className="heading-dot">.</span></h1>
          <div className="morning-metrics">
            <span><Icon name="clock" size={16} /><strong id="routine-duration">{minutesLabel(schedule.minutes)}</strong></span>
            <span>{schedule.exercises.length} {schedule.exercises.length === 1 ? 'esercizio' : 'esercizi'}</span>
          </div>
          <div className="morning-date" role="group" aria-label="Giorno della routine">
            <button type="button" className="icon-button" aria-label="Giorno precedente" onClick={() => onDate(shiftDate(date, -1))}><Icon name="back" size={16} /></button>
            <div className="morning-date-copy" aria-live="polite">
              {current && <strong>Oggi</strong>}
              <time dateTime={date}>{formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' })}</time>
            </div>
            <button type="button" className="icon-button" aria-label="Giorno successivo" onClick={() => onDate(shiftDate(date, 1))}><Icon name="arrow" size={16} /></button>
          </div>
        </div>
        {active && <MorningExerciseTimer key={active.id} minutes={active.minutes} name={active.name} onClose={clearTimer} onFinish={() => checkExercise(active.id, true)} controlRef={controlsRef} />}
      </div>

      <div className="morning-program">
        <section className="morning-group" aria-labelledby="morning-base-heading">
          <div className="morning-group-heading">
            <span className="morning-group-icon"><Icon name="leaf" size={20} /></span>
            <h2 id="morning-base-heading">Base quotidiana</h2>
            <span className="morning-group-duration">{minutesLabel(morningDuration(routine.base))}</span>
          </div>
          <Sequence key={dayKey} items={routine.base} active={active?.id} checkedIds={checkedIds} onCheck={checkExercise} onStart={start} />
        </section>
        {schedule.withStrength ? <section className="morning-group morning-strength" aria-labelledby="morning-strength-heading">
          <div className="morning-group-heading">
            <span className="morning-group-icon"><Icon name="dumbbell" size={20} /></span>
            <div><h2 id="morning-strength-heading">Rinforzo</h2><p>{morningDaysLabel(routine.strengthDays)}</p></div>
            <span className="morning-group-duration">+{minutesLabel(morningDuration(routine.extra))}</span>
          </div>
          <Sequence key={dayKey} items={routine.extra} offset={routine.base.length} active={active?.id} checkedIds={checkedIds} onCheck={checkExercise} onStart={start} />
        </section> : routine.extra.length > 0 && <div className="morning-strength-days">
          <Icon name="dumbbell" size={20} />
          <p><strong>Rinforzo</strong><span>{morningDaysLabel(routine.strengthDays)}</span></p>
          <span>+{minutesLabel(morningDuration(routine.extra))}</span>
        </div>}

        <div className="morning-finish">
          {done ? <>
            <a className="button secondary lg" href="#/scheda">Torna alla scheda<Icon name="arrow" size={20} /></a>
            <button type="button" className="text-button morning-undo" onClick={() => setUndoing(true)}>Annulla completamento</button>
          </> : <button type="button" className="button primary lg" id="mark-routine-done" disabled={future} onClick={() => store.complete(date, today)}>
            <Icon name="check" size={20} />{future ? 'Disponibile quel giorno' : 'Segna come fatta'}
          </button>}
        </div>
      </div>
    </div>
    {undoing && <Modal label="Annullare il completamento?" onClose={() => setUndoing(false)}>
      <h2>Annullare il completamento?</h2><p>La routine di questa giornata tornerà da fare.</p>
      <div className="program-actions program-confirm-actions">
        <button type="button" className="button secondary" onClick={() => setUndoing(false)}>Mantieni</button>
        <button type="button" className="button danger" onClick={() => { store.undo(date); setUndoing(false) }}>Annulla completamento</button>
      </div>
    </Modal>}
  </div>
}

export function MorningRoutinePage({ store, state, editing, date, today, onDate, onDirty }: {
  store: MorningRoutineStore
  state: MorningState
  editing: boolean
  date: string
  today: string
  onDate: (date: string) => void
  onDirty: (dirty: boolean) => void
}) {
  const snapshot = state.days[date]?.snapshot
  const routine = snapshot ?? state.routine
  if (!state.known) return <section className="panel empty-state"><h1>{morningRoutineDefaultTitle}</h1><p>{state.sync === 'waiting' ? 'Routine non disponibile. Collegati per scaricarla.' : 'Caricamento…'}</p><button className="button secondary" onClick={store.retry}>Riprova</button><a className="text-link" href="#/scheda">Torna alla scheda</a></section>
  if (editing) return <MorningRoutineEditor value={state.routine} revision={state.routineRevision} onDirty={onDirty} onExit={() => navigate('/scheda/mattino')} onSave={(value, revision) => {
    if (!store.save(value, revision)) return false
    navigate('/scheda/mattino')
    return true
  }} />
  if (!routine) return <section className="panel empty-state"><Icon name="sun" size={32} /><h1>{morningRoutineDefaultTitle}</h1><p>Aggiungi i tuoi esercizi e scegli in quali giorni fare anche il rinforzo.</p><a className="button primary" href="#/scheda/mattino/modifica">Crea routine</a><a className="text-link" href="#/scheda">Torna alla scheda</a></section>
  return <RoutineDay routine={routine} date={date} today={today} done={Boolean(snapshot)} store={store} onDate={onDate} />
}
