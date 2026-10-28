import { useRef, useState } from 'react'
import { Modal } from '../components/Modal'
import { formatDate } from '../domain/dates'
import { canUndoChange, changeAt, futurePartners, intact, proposedDose, replacementSnapshot } from '../domain/exercise-changes'
import type { ChangeDose, ChangePartner, ExerciseChange } from '../domain/exercise-changes'
import { prescription } from '../domain/diary'
import type { CatalogExercise } from '../domain/exercises'
import { isTimedCardio } from '../domain/muscle-groups'
import { parseNonNegativeNumber } from '../domain/validation'
import { displaySetAmount, storedSetAmount } from '../domain/workout'
import type { ExercisePrescription, WorkoutDay, WorkoutSession } from '../domain/types'
import type { DiaryStore } from '../persistence/diary-store'
import type { ExercisesState, ExercisesStore } from '../persistence/exercises-store'
import { ExerciseSheet } from './ExerciseSheet'

const dayName = (date: string) => formatDate(date, { weekday: 'long' })
const doseText = (raw: ExerciseChange['before']) => {
  const exercise = prescription(raw)
  return isTimedCardio(exercise) ? `${displaySetAmount(String(raw.duration_seconds ?? ''), exercise)} min`
    : `${raw.sets} × ${raw.mode === 'reps' ? `${raw.reps_min}–${raw.reps_max} rip.` : `${raw.duration_seconds} s`}${raw.optional_sets ? ` · +${raw.optional_sets} facoltative` : ''} · recupero ${raw.rest_seconds} s`
}

function ReplacementProposal({ source, selected, partners, onApply, onBack, onClose }: {
  source: ExercisePrescription; selected: CatalogExercise; partners: ChangePartner[]
  onApply: (dose: ChangeDose, partner: ChangePartner | null) => void; onBack: () => void; onClose: () => void
}) {
  const original = source.snapshot!, initial = proposedDose(original, selected)
  const timed = selected.measurementMode === 'seconds', cardio = isTimedCardio(selected)
  const asText = (value: number | null) => value === null ? '' : String(value).replace('.', ',')
  const [values, setValues] = useState(() => ({ sets: asText(initial.sets), optional_sets: asText(initial.optional_sets), rest_seconds: asText(initial.rest_seconds),
    reps_min: asText(initial.reps_min), reps_max: asText(initial.reps_max), duration_seconds: cardio ? displaySetAmount(asText(initial.duration_seconds), { ...source, mode: 'seconds', muscleGroup: 'Cardio' }) : asText(initial.duration_seconds),
    rir: asText(initial.rir), rpe: asText(initial.rpe) }))
  const [error, setError] = useState('')
  const submit = () => {
    try {
      const number = (key: keyof typeof values, min: number, max: number, whole = true, optional = false) => {
        const text = key === 'duration_seconds' && cardio ? storedSetAmount(values[key], { ...source, mode: 'seconds', muscleGroup: 'Cardio' }) : values[key]
        const value = parseNonNegativeNumber(text)
        if (value === null && optional) return null
        if (value === null || value < min || value > max || whole && !Number.isInteger(value)) throw new Error('Controlla la dose: compila i valori richiesti e usa numeri validi.')
        return value
      }
      const repsMin = timed ? null : number('reps_min', 1, 10000), repsMax = timed ? null : number('reps_max', 1, 10000)
      if (repsMin !== null && repsMax !== null && repsMin > repsMax) throw new Error('Le ripetizioni minime non possono superare le massime.')
      onApply({ sets: number('sets', 1, 1000)!, optional_sets: number('optional_sets', 0, 1000)!, rest_seconds: number('rest_seconds', 0, 86400)!,
        reps_min: repsMin, reps_max: repsMax, duration_seconds: timed ? number('duration_seconds', 1, 86400) : null, rir: number('rir', 0, 10, false, true), rpe: number('rpe', 1, 10, false, true) }, null)
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Controlla la dose.') }
  }
  const field = (key: keyof typeof values, label: string) => <label key={key}>{label}<input aria-label={label} inputMode={key === 'duration_seconds' || key === 'rir' || key === 'rpe' ? 'decimal' : 'numeric'} maxLength={8} value={values[key]} onChange={event => setValues({ ...values, [key]: event.target.value })} /></label>
  return <Modal label="Sostituisci esercizio" variant="sheet" onClose={onClose}><div className="wz-sheet replacement-proposal">
    <button className="text-button" type="button" onClick={onBack}>← Cambia esercizio</button>
    <h2>{selected.name}</h2><p className="muted">{[selected.variant, selected.equipment, selected.perSide ? 'per lato' : ''].filter(Boolean).join(' · ')}</p>
    {partners.length > 0 && <section aria-label="Proposta di scambio"><p>Prevista {partners.map(partner => dayName(partner.date)).join(', ')}. Puoi scambiare i due esercizi per questa settimana.</p>
      {partners.map(partner => <div className="replacement-swap" key={`${partner.date}:${partner.prescriptionId}`}>
        <p>Oggi: <strong>{partner.before.name}</strong> · {doseText(partner.before)}<br />{formatDate(partner.date, { weekday: 'long', day: 'numeric', month: 'long' })}: <strong>{source.name}</strong> · {doseText(original)}</p>
        <button type="button" className="button primary full-width" onClick={() => onApply(initial, partner)}>Scambia con {dayName(partner.date)}</button>
      </div>)}
    </section>}
    <section aria-label="Sostituzione solo oggi"><h3>{partners.length ? 'Oppure sostituisci solo oggi' : 'Solo nella seduta di oggi'}</h3>
      {!partners.length && !isTimedCardio(source) && <p className="small muted">Nessun partner disponibile più avanti questa settimana.</p>}
      <p className="small muted">Dose proposta, modificabile{source.mode !== selected.measurementMode ? ': indica la nuova durata o le ripetizioni.' : '.'}</p>
      <div className="replacement-dose">{!cardio && field('sets', 'Serie')}{timed ? field('duration_seconds', cardio ? 'Minuti' : 'Secondi') : <>{field('reps_min', 'Ripetizioni minime')}{field('reps_max', 'Ripetizioni massime')}</>}{!cardio && field('rest_seconds', 'Recupero in secondi')}</div>
      <details><summary>{cardio ? 'RIR/RPE' : 'Serie facoltative e RIR/RPE'}</summary><div className="replacement-dose">{!cardio && field('optional_sets', 'Serie facoltative')}{field('rir', 'RIR')}{field('rpe', 'RPE')}</div></details>
      {selected.note && <p className="small">{selected.note}</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" className={`button ${partners.length ? 'secondary' : 'primary'} full-width`} onClick={submit}>{partners.length ? 'Sostituisci solo oggi' : 'Sostituisci'}</button>
    </section>
  </div></Modal>
}

/** Punto d'accesso sulla card della seduta avviata; mai nello storico. */
export function WorkoutReplacement({ exercise, session, sessions, days, changes, catalog, store, today, enabled, announce, onApplied }: {
  exercise: ExercisePrescription; session: WorkoutSession; sessions: WorkoutSession[]; days: WorkoutDay[]; changes: ExerciseChange[]
  catalog: { store: ExercisesStore | null; state: ExercisesState }; store: DiaryStore; today: string; enabled: boolean; announce: (message: string) => void
  onApplied: (change: ExerciseChange) => void
}) {
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<CatalogExercise | null>(null), [error, setError] = useState('')
  const applied = useRef(false)
  const change = session.versionId ? changeAt(changes, session.versionId, session.date, session.day.id, exercise.id) : undefined
  const available = enabled && session.date === today && !session.completedAt && Boolean(exercise.snapshot) && intact(session, exercise.id)
  const partnersFor = (row: CatalogExercise) => futurePartners({ source: exercise, selected: row, session, sessions, days, changes })
  const hints = Object.fromEntries(catalog.state.rows.map(row => [row.id, partnersFor(row).map(partner => `${formatDate(partner.date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${doseText(partner.before)}`).join(' / ')]))
  const apply = (dose: ChangeDose, partner: ChangePartner | null) => {
    if (!selected || !exercise.snapshot || applied.current || !available) return
    const id = crypto.randomUUID()
    const command: ExerciseChange = { id, sessionId: session.id, planId: session.planId!, versionId: session.versionId!, sourceDate: session.date, sourceDayId: session.day.id,
      sourceId: exercise.id, timeZone: session.timeZone ?? 'Europe/Rome', createdAt: new Date().toISOString(), before: exercise.snapshot,
      after: partner ? { ...partner.before, id: exercise.id } : replacementSnapshot(exercise.snapshot, selected, dose), partner, cancelled: false }
    applied.current = true
    if (!store.changeExercise(command, selected.revision)) { applied.current = false; setError('L’esercizio non è più disponibile per la sostituzione. Controlla le registrazioni.'); return }
    setOpen(false); setSelected(null); onApplied(command)
  }
  if (!enabled && !change) return null
  if (!change && !available && !open && !error) return null
  return <div className="replacement-actions">
    {change ? <><span className="small muted">{change.partner ? `Scambiato con ${dayName(change.sourceDate === session.date ? change.partner.date : change.sourceDate)}` : `Al posto di ${change.before.name}`}</span>
      {canUndoChange(change, sessions) && <button type="button" className="text-button" onClick={() => { if (store.undoChange(change.id)) announce('Modifica annullata'); else setError('Non è più possibile annullare: sono presenti registrazioni.') }}>Annulla</button>}</>
      : available && <button type="button" className="text-button" aria-haspopup="dialog" onClick={() => { applied.current = false; setOpen(true); setError('') }}>Sostituisci</button>}
    {error && <p className="small" role="alert">{error}</p>}
    {open && !selected && <ExerciseSheet catalog={catalog} label={`Sostituisci ${exercise.name}`} single hints={hints} onClose={() => setOpen(false)} onAdd={row => { if (row.id === exercise.exerciseId) { setOpen(false); return } setSelected(row) }} />}
    {open && selected && <ReplacementProposal source={exercise} selected={selected} partners={partnersFor(selected)} onApply={apply} onBack={() => setSelected(null)} onClose={() => setOpen(false)} />}
  </div>
}
