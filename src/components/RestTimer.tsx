import { useEffect, useState } from 'react'
import type { RestTimerState } from '../domain/types'
import { formatRest, remainingRest } from '../domain/workout'
import { Icon } from './Icon'

export function RestTimer({ timer, onChange }: { timer: RestTimerState; onChange: (timer: RestTimerState | null) => void }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const tick = () => setNow(Date.now())
    tick()
    const interval = window.setInterval(tick, 250)
    document.addEventListener('visibilitychange', tick)
    window.addEventListener('focus', tick)
    return () => { window.clearInterval(interval); document.removeEventListener('visibilitychange', tick); window.removeEventListener('focus', tick) }
  }, [timer.deadline])
  const seconds = remainingRest(timer, now)
  const ended = seconds === 0
  const paused = timer.pausedSeconds !== null
  const ratio = Math.min(1, seconds / timer.durationSeconds)
  return <aside className={`rest-timer ${ended ? 'rest-ended' : ''}`} aria-label="Timer di recupero">
    <div className="timer-ring" aria-hidden="true"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" /><circle className="timer-ring-progress" cx="24" cy="24" r="20" strokeDasharray={`${ratio * 125.67} 125.67`} transform="rotate(-90 24 24)" /></svg><Icon name={ended ? 'check' : paused ? 'pause' : 'clock'} size={20} /></div>
    <div className="timer-copy"><span className="timer-label" role="status">{ended ? 'Recupero terminato' : paused ? 'Recupero in pausa' : 'Recupero'}</span><span className="timer-context">{timer.exerciseName} · serie {timer.setIndex + 1}</span></div>
    <strong className="timer-count" role="timer" aria-label={`${seconds} secondi di recupero`}>{formatRest(seconds)}</strong>
    <div className="timer-controls">{!ended && <><button className="timer-extra" onClick={() => { const remaining = remainingRest(timer); onChange({ ...timer, durationSeconds: timer.durationSeconds + 15, deadline: timer.deadline + 15000, pausedSeconds: paused ? remaining + 15 : null }) }}>+15s</button><button className="icon-button" aria-label={paused ? 'Riprendi recupero' : 'Pausa recupero'} onClick={() => onChange(paused ? { ...timer, deadline: Date.now() + seconds * 1000, pausedSeconds: null } : { ...timer, pausedSeconds: remainingRest(timer) })}><Icon name={paused ? 'play' : 'pause'} size={20} /></button></>}<button className="timer-dismiss" aria-label={ended ? 'Chiudi recupero' : 'Salta recupero'} onClick={() => onChange(null)}>{ended ? 'Chiudi' : 'Salta'}<Icon name={ended ? 'check' : 'close'} size={16} /></button></div>
  </aside>
}
