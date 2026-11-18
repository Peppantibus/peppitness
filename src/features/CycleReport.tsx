import { SubpageHeader } from '../components/SubpageHeader'
import { cycleRecapKey } from '../domain/cycle-recap'
import type { CycleRecap } from '../domain/cycle-recap'
import { cycleReport } from '../domain/cycle-report'
import type { SavedProgram } from '../domain/programs'
import type { WorkoutDay, WorkoutSession } from '../domain/types'
import { cycleRecapReport } from './CycleReportDetails'
import { CycleStory } from './CycleStory'

export function CycleReport({ workout, days, sessions, today, loading, savedRecap, archiveBack, onArchive }: {
  workout: SavedProgram | null
  days: WorkoutDay[]
  sessions: WorkoutSession[]
  today: string
  loading?: boolean
  savedRecap?: CycleRecap
  archiveBack?: string
  onArchive: (recap: CycleRecap) => void
}) {
  const back = archiveBack ?? '#/scheda'
  if (savedRecap) return <CycleStory key={savedRecap.key} report={savedRecap.report} programName={savedRecap.title} back={back} />

  const header = <SubpageHeader back={back} backLabel={archiveBack ? 'Torna allo Storico' : 'Torna alla scheda'} title="Il tuo riepilogo" />
  if (loading) return <>{header}<p role="status">Caricamento del tuo percorso…</p></>
  if (archiveBack) return <>{header}<section className="panel empty-state"><h2>Riepilogo non disponibile</h2><a className="button secondary" href={back}>Torna allo Storico</a></section></>
  const cycle = workout?.plan.cycle
  if (!workout || !cycle) return <>{header}<section className="panel empty-state"><h2>Programma senza ciclo</h2><p>Per il riepilogo servono una data di inizio e una durata.</p></section></>

  const report = cycleReport(workout.plan.id, sessions, cycle, today, days)
  if (report.info.status !== 'finished') return <>{header}<section className="panel empty-state">
    <h2>{report.info.status === 'upcoming' ? 'Programma in partenza' : 'Programma in corso'}</h2>
    <p>Il riepilogo sarà disponibile a fine programma.</p>
  </section></>
  const recap: CycleRecap = { schema: 1, key: cycleRecapKey(workout.plan.id, cycle), title: workout.plan.name, report: cycleRecapReport(report) }
  return <CycleStory key={recap.key} report={recap.report} programName={recap.title} back={back} onCompleted={() => onArchive(recap)} />
}
