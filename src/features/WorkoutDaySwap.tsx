import { WorkoutCardMenu } from './WorkoutCardMenu'
import { useRef, useState } from 'react'
import { Modal } from '../components/Modal'
import { Icon } from '../components/Icon'
import { formatDate, weekDates } from '../domain/dates'
import { inCycle, scheduledDay, swapAt, swapBlocked } from '../domain/day-swaps'
import type { DaySwap } from '../domain/day-swaps'
import type { SavedProgram } from '../domain/programs'
import type { WorkoutDay } from '../domain/types'
import type { DiaryState, DiaryStore } from '../persistence/diary-store'

const dateName = (date: string) => formatDate(date, { weekday: 'long', day: 'numeric', month: 'short' })
const assignment = (day?: WorkoutDay) => day ? (/^[a-z]\d?$/i.test(day.title) ? `Allenamento ${day.title}` : day.title) : 'Riposo'

/** Disponibile anche nel riposo. Le scelte manuali della scheda sono indipendenti. */
export function WorkoutDaySwap({ workout, days, date, today, timeZone, store, state, onApplied, variant = 'rest', onChooseDay }: {
  workout: SavedProgram; days: WorkoutDay[]; date: string; today: string; timeZone: string
  store: DiaryStore; state: DiaryState; onApplied: () => void; variant?: 'rest' | 'menu'; onChooseDay?: () => void
}) {
  const [open, setOpen] = useState(false), [source, setSource] = useState(''), [target, setTarget] = useState(''), [error, setError] = useState('')
  const [choosingSource, setChoosingSource] = useState(false)
  const sourceButton = useRef<HTMLButtonElement>(null)
  const { view } = state, swaps = view.swaps ?? [], versionId = workout.version.id, planId = workout.plan.id
  const dates = weekDates(date), cycle = workout.plan.cycle
  const dayAt = (value: string) => scheduledDay(days, value, versionId, swaps, cycle)
  const occurrenceReason = (value: string) => !inCycle(cycle, value) ? 'Fuori dal ciclo del programma.'
    : swapAt(swaps, versionId, value) ? 'Annulla prima lo spostamento presente.'
      : view.sessions.some(session => (session.versionId === versionId || !session.versionId && session.planId === planId) && session.date === value) ? 'Allenamento già avviato.'
        : view.changes?.some(change => !change.cancelled && change.versionId === versionId && (change.sourceDate === value || change.partner?.date === value)) ? 'Modifica datata agli esercizi presente.' : null
  const candidate: DaySwap = { id: '', planId, versionId, sourceDate: source, targetDate: target, sourceDayId: dayAt(source)?.id ?? null, targetDayId: dayAt(target)?.id ?? null, timeZone, cancelled: false }
  const blocked = source && target ? swapBlocked(candidate, view, today) : 'Scegli le due giornate.'
  const canOpen = state.phase === 'ready' && !occurrenceReason(date) && (variant === 'menu' || date >= today)
  const chooseSource = (value: string) => {
    setSource(value); if (target === value) setTarget(''); setChoosingSource(false)
    window.requestAnimationFrame(() => sourceButton.current?.focus())
  }
  const apply = () => {
    try {
      store.swapDays({ planId, versionId, days, sourceDate: source, targetDate: target, timeZone, cycle })
      onApplied(); setOpen(false); setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Spostamento non disponibile.') }
  }
  const openSwap = () => {
    setChoosingSource(!dayAt(date)); setSource(dayAt(date) ? date : ''); setTarget(!dayAt(date) && date >= today ? date : ''); setError(''); setOpen(true)
  }
  if (!canOpen && !onChooseDay && !error && !open) return null
  return <div className={`day-swap-controls${variant === 'menu' ? ' day-swap-menu' : ''}`}>
    {variant === 'menu'
      ? <WorkoutCardMenu onMove={canOpen ? openSwap : undefined} onChoose={onChooseDay} />
      : canOpen && <button type="button" className="button primary lg day-swap-open" aria-haspopup="dialog" onClick={openSwap}><Icon name="calendar" size={20} />Sposta un allenamento qui</button>}
    {error && <p className="small" role="alert">{error}</p>}
    {open && <Modal label="Sposta allenamento" variant="sheet" onClose={() => setOpen(false)}>
      <div className="day-swap-panel"><h2>Sposta allenamento</h2><p className="muted">Scambia due giornate solo per questa settimana, prima di iniziare.</p>
        <button ref={sourceButton} type="button" className="day-swap-source-toggle" aria-expanded={choosingSource} aria-controls="day-swap-choices" aria-label={`Allenamento da spostare: ${source ? `${dateName(source)}, ${assignment(dayAt(source))}` : 'scegli la giornata'}`} data-date={source} onClick={() => setChoosingSource(!choosingSource)}>
          <Icon name="calendar" size={20} /><span><small>Allenamento da spostare</small><strong>{source ? dateName(source) : 'Scegli la giornata'}</strong>{source && <span>{assignment(dayAt(source))}</span>}</span><Icon name={choosingSource ? 'chevronDown' : 'chevron'} size={16} />
        </button>
        <fieldset className="day-swap-dates" id="day-swap-choices">
          <legend>{choosingSource ? 'Quale allenamento vuoi spostare?' : 'Scegli la destinazione'}</legend>
          <div className="day-swap-choices">{dates.map(value => {
            const day = dayAt(value)
            const reason = choosingSource ? occurrenceReason(value) ?? (!day ? 'Giorno di riposo.' : null)
              : value === source ? 'Giornata di partenza.' : value < today ? 'La destinazione non può precedere oggi.' : occurrenceReason(value)
            const selected = (choosingSource ? source : target) === value
            const reasonId = `swap-reason-${value}`
            return <label key={`${choosingSource ? 'source' : 'target'}-${value}`} className={`day-swap-choice${selected ? ' is-selected' : ''}${reason ? ' is-unavailable' : ''}`}>
              <input type="radio" name={choosingSource ? 'swap-source' : 'swap-target'} value={value} checked={selected} disabled={Boolean(reason)} aria-describedby={reason ? reasonId : undefined} onClick={() => { if (choosingSource && selected) chooseSource(value) }} onChange={() => { if (choosingSource) chooseSource(value); else setTarget(value) }} />
              <span className="day-swap-choice-copy"><strong>{dateName(value)}{value === today && <em>Oggi</em>}</strong><span>{assignment(day)}</span>{reason && <small id={reasonId}>{reason}</small>}</span>
              <Icon name={day ? 'dumbbell' : 'moon'} size={20} />
            </label>
          })}</div>
        </fieldset>
        {!choosingSource && source && target && <div className="day-swap-effects" aria-live="polite"><p>{dateName(source)} → <strong>{assignment(dayAt(target))}</strong></p><p>{dateName(target)} → <strong>{assignment(dayAt(source))}</strong></p></div>}
        {!choosingSource && blocked && source && target && <p role="status">{blocked}</p>}
        {!choosingSource && <button type="button" className="button primary full-width" disabled={Boolean(blocked) || !candidate.sourceDayId} onClick={apply}>{candidate.targetDayId ? 'Scambia' : 'Sposta'}</button>}
      </div>
    </Modal>}
  </div>
}

/** Indicazione e annullamento rimangono visibili anche quando l'azione è nel menu. */
export function WorkoutDaySwapStatus({ workout, date, today, store, state, onApplied }: {
  workout: SavedProgram; date: string; today: string; store: DiaryStore; state: DiaryState; onApplied: () => void
}) {
  const [error, setError] = useState('')
  const dates = weekDates(date)
  const involved = (state.view.swaps ?? []).filter(swap => !swap.cancelled && swap.versionId === workout.version.id && dates.includes(swap.sourceDate))
  if (!involved.length && !error) return null
  return <div className="day-swap-controls day-swap-status">{involved.map(swap => {
    const reason = swapBlocked(swap, state.view, today, swap.id)
    return <div key={swap.id} className="day-swap-notice"><span role="status">Spostamento · {dateName(swap.sourceDate)} ↔ {dateName(swap.targetDate)}</span>
      {!reason ? <button type="button" className="text-button" onClick={() => { if (store.undoSwap(swap.id)) { onApplied(); setError('') } else setError('Non è più possibile annullare: verifica le giornate.') }}>Annulla spostamento</button> : <small>{reason}</small>}
    </div>
  })}{error && <p className="small" role="alert">{error}</p>}</div>
}
