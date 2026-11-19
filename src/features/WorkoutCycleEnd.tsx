import { useState } from 'react'
import { Icon } from '../components/Icon'
import { Modal } from '../components/Modal'
import { createWorkoutProgramHref } from '../domain/cycle-recap'
import type { CycleRecap } from '../domain/cycle-recap'
import { formatDate } from '../domain/dates'
import { cycleInfo } from '../domain/progress'
import type { CycleInfo } from '../domain/progress'

const shortDate = (date: string) => formatDate(date, { day: 'numeric', month: 'long' })
const weeksText = (weeks: number) => `${weeks} ${weeks === 1 ? 'settimana' : 'settimane'}`

function ExtendCycle({ info, choices, onClose, onExtend }: {
  info: CycleInfo; choices: CycleInfo[]; onClose: () => void; onExtend: (weeks: number) => Promise<boolean>
}) {
  const [weeks, setWeeks] = useState(choices[0]!.weeks)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const target = choices.find(choice => choice.weeks === weeks)!
  const submit = async () => {
    setPending(true); setFailed(false)
    if (await onExtend(weeks)) { onClose(); return }
    setPending(false); setFailed(true)
  }
  return <Modal label="Estendi il ciclo" variant="sheet" onClose={() => { if (!pending) onClose() }}>
    <h2>Estendi il ciclo</h2>
    <p>Le sedute già registrate resteranno nello stesso ciclo.</p>
    <label className="cycle-extension-field">Settimane da aggiungere
      <select value={weeks} onChange={event => setWeeks(Number(event.target.value))} disabled={pending}>
        {choices.map(choice => <option key={choice.weeks} value={choice.weeks}>{weeksText(choice.weeks - info.weeks)}</option>)}
      </select>
    </label>
    <p>Nuova fine del ciclo <strong>{shortDate(target.end)}</strong></p>
    {failed && <p role="alert">Estensione non confermata. Riprova.</p>}
    <button type="button" className="button primary cycle-confirm-extension" disabled={pending} onClick={() => void submit()}>
      {pending ? 'Salvataggio…' : 'Conferma estensione'}
    </button>
  </Modal>
}

export function WorkoutCycleEnd({ info, name, today, recap, waiting, blocked, onFinish, onExtend }: {
  info: CycleInfo; name: string; today: string; recap?: CycleRecap; waiting: boolean; blocked: boolean
  onFinish: () => void; onExtend?: (weeks: number) => Promise<boolean>
}) {
  const [extending, setExtending] = useState(false)
  const choices = onExtend && !recap ? Array.from({ length: 52 - info.weeks }, (_, index) => cycleInfo({ start: info.start, weeks: info.weeks + 1 + index }, today))
    .filter(choice => choice.status === 'active') : []
  return <section className="cycle-end" aria-labelledby="cycle-end-title">
    <div className="cycle-end-copy">
      <span className="cycle-end-program">{name} · {weeksText(info.weeks)}</span>
      <h2 id="cycle-end-title">{recap ? recap.unseen ? 'Il tuo Wrapped è pronto.' : 'Pronto per un nuovo ciclo?' : 'Il tuo ciclo è arrivato alla fine.'}</h2>
      {!recap && <p>Il ciclo era previsto fino al {shortDate(info.end)}.</p>}
    </div>
    {recap ? <div className="cycle-end-actions">
      {recap.unseen && <a className="button cycle-end-primary" href="#/scheda/riepilogo">Apri il tuo Wrapped<Icon name="arrow" size={20} /></a>}
      <a className={`button ${recap.unseen ? 'cycle-end-secondary' : 'cycle-end-primary'}`} href={createWorkoutProgramHref}>
        Crea un nuovo programma<Icon name={recap.unseen ? 'plus' : 'arrow'} size={20} />
      </a>
    </div> : waiting ? <p role="status">Caricamento del diario…</p> : blocked ? <p>Termina la seduta in corso prima di chiudere il ciclo.</p> : <div className="cycle-end-actions">
      <button type="button" className="button cycle-end-primary cycle-finish-program" onClick={onFinish}>Termina il programma<Icon name="check" size={20} /></button>
      {choices.length > 0 && <button type="button" className="button cycle-end-secondary cycle-extend-program" onClick={() => setExtending(true)}>Estendi il ciclo</button>}
    </div>}
    {extending && onExtend && choices.length > 0 && <ExtendCycle info={info} choices={choices} onExtend={onExtend} onClose={() => setExtending(false)} />}
  </section>
}
