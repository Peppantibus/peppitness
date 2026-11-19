import { SubpageHeader } from '../components/SubpageHeader'
import type { CycleRecap } from '../domain/cycle-recap'
import { cycleInfo } from '../domain/progress'
import type { SavedProgram } from '../domain/programs'
import { CycleStory } from './CycleStory'

export function CycleReport({ workout, today, loading, savedRecap, archiveBack, onViewed }: {
  workout: SavedProgram | null
  today: string
  loading?: boolean
  savedRecap?: CycleRecap
  archiveBack?: string
  onViewed: (key: string) => void
}) {
  const back = archiveBack ?? '#/scheda'
  if (savedRecap) return <CycleStory key={savedRecap.key} report={savedRecap.report} programName={savedRecap.title} back={back}
    nextProgram={!archiveBack} onCompleted={savedRecap.unseen ? () => onViewed(savedRecap.key) : undefined} />

  const header = <SubpageHeader back={back} backLabel={archiveBack ? 'Torna allo Storico' : 'Torna alla scheda'} title="Il tuo riepilogo" />
  if (loading) return <>{header}<p role="status">Caricamento del tuo percorso…</p></>
  if (archiveBack) return <>{header}<section className="panel empty-state"><h2>Riepilogo non disponibile</h2><a className="button secondary" href={back}>Torna allo Storico</a></section></>
  const cycle = workout?.plan.cycle
  if (!workout || !cycle) return <>{header}<section className="panel empty-state"><h2>Programma senza ciclo</h2><p>Per il riepilogo servono una data di inizio e una durata.</p></section></>

  const info = cycleInfo(cycle, today)
  if (info.status !== 'finished') return <>{header}<section className="panel empty-state">
    <h2>{info.status === 'upcoming' ? 'Programma in partenza' : 'Programma in corso'}</h2>
    <p>Il riepilogo sarà disponibile a fine programma.</p>
  </section></>
  return <>{header}<section className="panel empty-state"><h2>Il ciclo è arrivato alla fine</h2>
    <p>Termina il programma dalla Scheda per aprire il tuo Wrapped.</p>
    <a className="button primary" href={back}>Torna alla Scheda</a>
  </section></>
}
