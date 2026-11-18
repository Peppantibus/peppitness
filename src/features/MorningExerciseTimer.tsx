import { useEffect, useRef, useState } from 'react'
import type { Ref } from 'react'
import { Icon } from '../components/Icon'
import { formatRest } from '../domain/workout'
import { playRestEnd, useScreenWakeLock } from '../workout-alerts'

export function MorningExerciseTimer({ minutes, name, onClose, onFinish, controlRef }: {
  minutes: number
  name: string
  onClose: () => void
  onFinish: () => void
  controlRef: Ref<HTMLButtonElement>
}) {
  const duration = minutes * 60
  const [clock, setClock] = useState(() => ({ deadline: Date.now() + duration * 1000, remaining: duration, paused: false }))
  const seconds = clock.remaining
  const ended = seconds === 0
  const finished = useRef(false)
  useScreenWakeLock(!clock.paused && !ended)
  useEffect(() => {
    if (clock.paused || ended) return
    const tick = () => setClock(current => {
      const remaining = Math.max(0, Math.ceil((current.deadline - Date.now()) / 1000))
      return current.paused || remaining === current.remaining ? current : { ...current, remaining }
    })
    const interval = window.setInterval(tick, 250)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', tick)
      window.removeEventListener('focus', tick)
    }
  }, [clock.paused, ended])
  useEffect(() => {
    if (ended && !finished.current) {
      finished.current = true
      onFinish()
      if (Date.now() - clock.deadline < 3000) playRestEnd()
    }
  }, [ended, clock.deadline, onFinish])
  const restart = () => {
    finished.current = false
    setClock({ deadline: Date.now() + duration * 1000, remaining: duration, paused: false })
  }
  const togglePause = () => setClock(current => {
    const now = Date.now()
    if (current.paused) return { ...current, deadline: now + current.remaining * 1000, paused: false }
    return { ...current, remaining: Math.max(0, Math.ceil((current.deadline - now) / 1000)), paused: true }
  })
  const finish = () => {
    onFinish()
    onClose()
  }

  return <section className={`morning-exercise-timer${ended ? ' is-ended' : ''}`} aria-label={`Timer ${name}`}>
    <div className="morning-timer-meta">
      <div className="morning-timer-context">
        <strong title={name}>{name}</strong>
        <span role="status">{ended ? 'Tempo terminato' : clock.paused ? 'In pausa' : 'In corso'}</span>
      </div>
      <button type="button" className="morning-timer-reset" aria-label="Chiudi timer" title="Chiudi timer" onClick={onClose}>
        <Icon name="close" size={20} />
      </button>
    </div>
    <div className="morning-timer-main">
      <strong role="timer" aria-label={`${seconds} secondi rimanenti`}>{formatRest(seconds)}</strong>
      <div className="morning-timer-controls">
        <button ref={controlRef} type="button" className="morning-timer-toggle" onClick={ended ? restart : togglePause}>
          <Icon name={ended ? 'history' : clock.paused ? 'play' : 'pause'} size={16} />
          {ended ? 'Ricomincia' : clock.paused ? 'Riprendi' : 'Pausa'}
        </button>
        <button type="button" className="morning-timer-done" onClick={finish}><Icon name="check" size={16} />Fatto</button>
      </div>
    </div>
    <progress className="morning-timer-progress" max={duration} value={duration - seconds} aria-hidden="true" />
  </section>
}
