import { useEffect, useRef, useState } from 'react'
import type { RestTimerState } from '../domain/types'
import { adjustRest, formatRest, remainingRest } from '../domain/workout'
import { playRestEnd } from '../workout-alerts'
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
  const ratio = ended ? 1 : Math.min(1, seconds / timer.durationSeconds)
  // Avviso solo nel passaggio a «terminato» visto dall'app, non per un recupero già scaduto alla riapertura.
  const previous = useRef(seconds)
  useEffect(() => {
    if (seconds === 0 && previous.current > 0 && timer.pausedSeconds === null && Date.now() - timer.deadline < 3000) playRestEnd()
    previous.current = seconds
  }, [seconds, timer.deadline, timer.pausedSeconds])
  return <aside className={`rest-timer ${ended ? 'rest-ended' : ''} ${paused ? 'rest-paused' : ''}`} aria-label="Timer di recupero">
    <div className="timer-copy"><span className="timer-label" role="status">{ended ? 'Recupero terminato' : paused ? 'Recupero in pausa' : 'Recupero'}</span><span className="timer-context">{timer.exerciseName} · serie {timer.setIndex + 1}</span></div>
    <div className="timer-main">
      {ended ? <span className="timer-done"><Icon name="check" size={24} strokeWidth={2.5} />Pronto per la serie</span> : <strong className="timer-count" role="timer" aria-label={`${seconds} secondi di recupero`}>{formatRest(seconds)}</strong>}
      <div className="timer-controls">{!ended && <><span className="timer-adjust"><button className="timer-less" aria-label="Togli 15 secondi" onClick={() => onChange(adjustRest(timer, -15))}>−15<span className="timer-unit"> s</span></button><button className="timer-extra" aria-label="Aggiungi 15 secondi" onClick={() => onChange(adjustRest(timer, 15))}>+15<span className="timer-unit"> s</span></button></span><button className="timer-pause" aria-label={paused ? 'Riprendi recupero' : 'Pausa recupero'} onClick={() => onChange(paused ? { ...timer, deadline: Date.now() + seconds * 1000, pausedSeconds: null } : { ...timer, pausedSeconds: remainingRest(timer) })}><Icon name={paused ? 'play' : 'pause'} size={24} strokeWidth={2.25} /></button></>}<button className="timer-dismiss" aria-label={ended ? 'Chiudi recupero' : 'Salta recupero'} onClick={() => onChange(null)}><span className="timer-dismiss-label">{ended ? 'Chiudi' : 'Salta'}</span><Icon name={ended ? 'check' : 'close'} size={20} /></button></div>
    </div>
    <div className="timer-progress" aria-hidden="true"><span style={{ transform: `scaleX(${ratio})` }} /></div>
  </aside>
}
