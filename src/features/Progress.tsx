import { Icon } from '../components/Icon'
import { SubpageHeader } from '../components/SubpageHeader'
import { formatDate, shiftDate } from '../domain/dates'
import { formatDecimal } from '../domain/diary'
import { adherence, cycleInfo, exerciseTrends, mondayOf, weeklyProgress } from '../domain/progress'
import type { ExerciseTrend, PlannedSlot } from '../domain/progress'
import type { SavedProgram } from '../domain/programs'
import type { WorkoutDay, WorkoutSession } from '../domain/types'
import { weekdays } from '../domain/weekly'

const short = (date: string) => formatDate(date, { day: 'numeric', month: 'short' })
const stateLabel: Record<PlannedSlot['state'], string> = { done: 'fatta', missed: 'saltata', planned: 'da fare' }

/** Serie singola: linea sottile, punto finale evidenziato, valori leggibili al passaggio. */
function Sparkline({ trend, unit }: { trend: ExerciseTrend; unit: string }) {
  const values = trend.points.map(point => trend.metric === 'best' ? point.best : point.volume)
  const valid = values.map((value, index) => ({ value, index, date: trend.points[index]!.date })).filter((item): item is { value: number; index: number; date: string } => item.value !== null)
  if (valid.length < 2) return null
  const width = 132, height = 44, pad = 5
  const min = Math.min(...valid.map(item => item.value)), max = Math.max(...valid.map(item => item.value))
  const x = (i: number) => pad + (i / (valid.length - 1)) * (width - pad * 2)
  const y = (value: number) => max === min ? height / 2 : height - pad - ((value - min) / (max - min)) * (height - pad * 2)
  const path = valid.map((item, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(item.value).toFixed(1)}`).join(' ')
  return <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`Andamento: da ${formatDecimal(valid[0]!.value)} a ${formatDecimal(valid.at(-1)!.value)} ${unit}`}>
    <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    {valid.map((item, i) => <circle key={item.date + i} cx={x(i)} cy={y(item.value)} r={i === valid.length - 1 ? 4 : 2.5} className={i === valid.length - 1 ? 'is-last' : ''}><title>{`${short(item.date)}: ${formatDecimal(item.value)} ${unit}`}</title></circle>)}
    {/* Area di passaggio più ampia dei punti */}
    {valid.map((item, i) => <rect key={`hit-${item.date}-${i}`} x={x(i) - 8} y={0} width={16} height={height} fill="transparent"><title>{`${short(item.date)}: ${formatDecimal(item.value)} ${unit}`}</title></rect>)}
  </svg>
}

function TrendCard({ trend }: { trend: ExerciseTrend }) {
  const unit = trend.metric === 'best' ? trend.exercise.loadUnit ?? 'kg' : trend.exercise.mode === 'seconds' ? 's' : trend.exercise.loadUnit ? `${trend.exercise.loadUnit}·rip` : 'rip.'
  const caption = trend.metric === 'best' ? 'Carico massimo' : trend.exercise.mode === 'seconds' ? 'Secondi totali' : 'Volume (ripetizioni)'
  const delta = trend.first !== null && trend.last !== null ? trend.last - trend.first : null
  const changeText = { up: 'In crescita', down: 'In calo', flat: 'Stabile', new: 'Prima seduta', none: 'Nessuna seduta' }[trend.change]
  const bestLoad = Math.max(0, ...trend.points.map(point => point.best ?? 0))
  const volume = trend.points.reduce((total, point) => total + point.volume, 0)
  const volumeUnit = trend.exercise.mode === 'seconds' ? 's' : bestLoad ? `${trend.exercise.loadUnit ?? 'kg'} · rip.` : 'rip.'
  return <article className="trend-card">
    <div className="trend-head"><div><h3>{trend.exercise.name}</h3><small>{caption} · {trend.points.length} {trend.points.length === 1 ? 'seduta' : 'sedute'}</small></div>
      <span className={`trend-badge is-${trend.change}`}>{trend.change === 'up' ? <Icon name="arrow" size={16} style={{ transform: 'rotate(-45deg)' }} /> : trend.change === 'down' ? <Icon name="arrow" size={16} style={{ transform: 'rotate(45deg)' }} /> : null}{changeText}</span></div>
    {trend.last !== null ? <div className="trend-body">
      <div><strong className="trend-value">{formatDecimal(Math.round(trend.last * 10) / 10)}<small> {unit}</small></strong>
        {delta !== null && trend.points.length > 1 && <span className="trend-delta">{delta > 0 ? '+' : delta < 0 ? '−' : '±'}{formatDecimal(Math.round(Math.abs(delta) * 10) / 10)} {unit} dall’inizio</span>}</div>
      <Sparkline trend={trend} unit={unit} />
    </div> : <p className="small muted">Completa una seduta con questo esercizio per vedere l’andamento.</p>}
    {trend.points.length > 0 && <div className="trend-metrics"><span>Carico migliore <strong>{bestLoad ? `${formatDecimal(bestLoad)} ${trend.exercise.loadUnit ?? 'kg'}` : '—'}</strong></span><span>Volume totale <strong>{formatDecimal(Math.round(volume * 10) / 10)} {volumeUnit}</strong></span></div>}
  </article>
}

export function Progress({ workout, days, sessions, today }: { workout: SavedProgram | null; days: WorkoutDay[]; sessions: WorkoutSession[]; today: string }) {
  const header = (subtitle?: string) => <SubpageHeader back="#/scheda" backLabel="Torna alla scheda" title="I tuoi progressi" subtitle={subtitle} />
  if (!workout || !days.length) return <>{header()}<section className="panel empty-state"><span className="empty-icon"><Icon name="trend" size={32} /></span><h2>Nessun programma da seguire</h2><p>Scegli o crea un programma: qui vedrai costanza e andamento degli esercizi.</p><a className="button primary" href="#/scheda/programmi/nuovo">Crea il tuo programma</a></section></>
  const cycle = workout.plan.cycle ?? { start: shiftDate(mondayOf(today), -7 * 7), weeks: 8 }
  const info = cycleInfo(cycle, today)
  const weeks = weeklyProgress(days, sessions, cycle, today)
  const score = adherence(weeks)
  const trends = exerciseTrends(days, sessions, cycle.start, info.end)
  const setsDone = sessions.filter(session => session.completedAt && session.date >= cycle.start && session.date <= info.end).reduce((sum, session) => sum + Object.values(session.results).flat().filter(set => set.completed).length, 0)
  const improving = trends.filter(trend => trend.change === 'up').length
  const featuredWeek = weeks.find(week => week.current) ?? weeks[Math.min(Math.max(info.week, 1), weeks.length) - 1]
  const otherWeeks = weeks.filter(week => week !== featuredWeek)
  const weekRow = (week: typeof weeks[number]) => <li key={week.index} className={week.current ? 'is-current' : ''}>
    <div className="week-name"><strong>Settimana {week.index}</strong><small>{short(week.start)} – {short(week.end)}</small></div>
    <div className="week-slots">{week.slots.map((slot, i) => <span key={`${slot.label}-${i}`} className={`slot is-${slot.state}`} title={`${weekdays.find(day => day.code === slot.label)?.name ?? slot.label} · ${slot.title}: ${stateLabel[slot.state]}`} aria-label={`${slot.label} ${slot.title}: ${stateLabel[slot.state]}`}>{slot.state === 'done' ? <Icon name="check" size={16} /> : slot.state === 'missed' ? '–' : null}<em>{slot.label.slice(0, 3)}</em></span>)}{week.extra > 0 && <span className="slot-extra">+{week.extra}</span>}</div>
  </li>
  return <>
    {header(workout.plan.name)}
    <div className="progress-summary">
    <section className="cycle-card" aria-label="Riepilogo del programma">
      <div><span className="eyebrow">Riepilogo del ciclo</span><h2>{score.percent === null ? '—' : `${score.percent}%`} <small>di costanza</small></h2><p>{score.done} di {score.due} sedute previste finora</p></div>
      <div className="cycle-meta"><strong>{info.status === 'upcoming' ? `Inizia ${formatDate(info.start, { day: 'numeric', month: 'long' })}` : info.status === 'finished' ? 'Ciclo concluso' : `Settimana ${info.week} di ${info.weeks}`}</strong><span>{short(info.start)} – {short(info.end)}</span></div>
      <div className="cycle-bar" role="progressbar" aria-label="Settimane trascorse" aria-valuemin={0} aria-valuemax={info.weeks} aria-valuenow={Math.min(info.week, info.weeks)}><span style={{ width: `${Math.min(info.week, info.weeks) / info.weeks * 100}%` }} /></div>
    </section>
    <div className="progress-tiles">
      <div className="progress-tile"><strong>{score.done + score.extra}</strong><span>Sedute fatte</span><small>{score.extra ? `di cui ${score.extra} in più` : `su ${score.planned} del ciclo`}</small></div>
      <div className="progress-tile"><strong>{setsDone}</strong><span>Serie completate</span><small>{improving ? `${improving} ${improving === 1 ? 'esercizio' : 'esercizi'} in crescita` : 'nel ciclo'}</small></div>
    </div>
    </div>
    <section className="progress-section" aria-labelledby="weeks-title">
      <div className="section-heading"><h2 id="weeks-title">{info.status === 'upcoming' ? 'Prima settimana' : info.status === 'finished' ? 'Ultima settimana' : 'Questa settimana'}</h2></div>
      <p className="progress-legend"><span className="slot is-done"><Icon name="check" size={16} /></span>fatta <span className="slot is-missed">–</span>saltata <span className="slot is-planned" />da fare</p>
      {featuredWeek && <ol className="week-rows">{weekRow(featuredWeek)}</ol>}
      {otherWeeks.length > 0 && <details className="progress-week-history"><summary>Vedi tutte le settimane <Icon name="chevron" size={16} /></summary><ol className="week-rows">{otherWeeks.map(weekRow)}</ol></details>}
    </section>
    <section className="progress-section" aria-labelledby="trends-title">
      <div className="section-heading"><h2 id="trends-title">Andamento degli esercizi</h2><span>{improving} in crescita</span></div>
      <div className="trend-list">{trends.map(trend => <TrendCard key={trend.exercise.id} trend={trend} />)}</div>
    </section>
  </>
}
