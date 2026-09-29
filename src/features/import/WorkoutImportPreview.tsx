import { Icon } from '../../components/Icon'
import { workoutDaysFromProgram } from '../../domain/diary.ts'
import { isWeekly } from '../../domain/weekly.ts'
import type { MappingResult, WorkoutReviewDraft } from '../../import/contracts/index.ts'
import type { WorkoutMapping } from '../../import/mapping/workout.ts'
import { formatRange, isRange, mappingOnlyIssues, originalRange } from './review-model'
import './review.css'
import './workout-review.css'

const dateFormat = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
const scalarFields = [
  { field: 'restSeconds', label: 'Recupero', unit: ' s' },
  { field: 'durationSeconds', label: 'Durata', unit: ' s' },
  { field: 'rir', label: 'RIR', unit: '' },
  { field: 'rpe', label: 'RPE', unit: '' },
] as const

/**
 * Anteprima del programma che verrebbe salvato (task 12): solo dal risultato del mapper 09 e dalle viste del
 * dominio (`workoutDaysFromProgram`, le stesse del diario), mai ricostruita dal DTO. Senza un mapping valido
 * non mostra un programma «quasi pronto». Per i valori scelti dentro un intervallo mostra anche l'intervallo
 * del documento; gli esercizi comuni o nuovi sono riferimenti provvisori, creati solo alla conferma.
 */
export function WorkoutImportPreview({ mapping, draft }: { mapping: MappingResult<WorkoutMapping>; draft: WorkoutReviewDraft }) {
  if (!mapping.ok) {
    const blocking = mapping.issues.filter(issue => issue.severity === 'blocking').length
    return <section className="panel wr-preview" aria-labelledby="wr-preview-title">
      <h2 id="wr-preview-title">Anteprima del programma</h2>
      <p className="rv-status is-blocked"><Icon name="alert" size={20} />L’anteprima compare quando la revisione non ha più problemi da risolvere ({blocking} {blocking === 1 ? 'aperto' : 'aperti'}{mappingOnlyIssues(mapping).length ? ', compresi calendario, fasi o scelte da completare' : ''}).</p>
    </section>
  }
  const { program, cycle, provisionalRefs, targets, resolved } = mapping.value
  const days = workoutDaysFromProgram(program)
  const localOf = new Map(Object.entries(targets).flatMap(([localId, id]) => id ? [[id, localId] as const] : []))
  const bindings = new Map(resolved.catalog.map(binding => [binding.ref, binding.choice.source]))
  const weekly = isWeekly(program.days)
  return <section className="panel wr-preview" aria-labelledby="wr-preview-title" data-preview="workout">
    <h2 id="wr-preview-title">Anteprima del programma</h2>
    <p className="small muted">Così verrà salvato e usato nel diario, dopo la conferma.</p>
    <h3 className="wr-preview-name">{program.title}</h3>
    <ul className="wr-preview-facts">
      <li><Icon name="calendar" size={16} />{weekly ? `Settimanale: ${program.days.map(day => day.label).join(', ')}` : `A rotazione: ${program.days.map(day => day.label).join(' → ')}`}</li>
      <li><Icon name="clock" size={16} />{cycle ? `Ciclo di ${cycle.weeks} ${cycle.weeks === 1 ? 'settimana' : 'settimane'} dal ${dateFormat.format(new Date(`${cycle.start}T00:00:00Z`))}` : 'Nessun ciclo indicato'}</li>
    </ul>
    {program.guidance && <div className="wr-preview-guidance"><h4>Indicazioni</h4><p>{program.guidance}</p></div>}
    <ol className="wr-preview-days">{days.map(day => <li key={day.id} className="wr-preview-day" data-day={day.id}>
      <h4>{day.label} · {day.title}</h4>
      {day.notes && <p className="wr-preview-note">{day.notes}</p>}
      <ol className="wr-preview-exercises">{day.exercises.map(exercise => {
        const localId = localOf.get(exercise.id)
        const binding = provisionalRefs.includes(exercise.exerciseId) ? bindings.get(exercise.exerciseId) : 'existing'
        const chosen = localId ? scalarFields.flatMap(entry => {
          const range = originalRange(draft, localId, entry.field)
          const current = (draft.current.find(item => item.localId === localId)?.values as Record<string, unknown> | undefined)?.[entry.field]
          return range && isRange(current) ? [`${entry.label}: documento ${formatRange(range, entry.unit)}, scelto ${formatRange(current, entry.unit)}`] : []
        }) : []
        return <li key={exercise.id} className="wr-preview-exercise" data-prescription={exercise.id}>
          <div className="wr-preview-head">
            <strong>{exercise.name}</strong>
            <span className={`rv-badge ${binding === 'existing' ? 'is-neutral' : 'is-ok'}`}>{binding === 'shared' ? 'Dal catalogo comune · aggiunto alla conferma' : binding === 'new' ? 'Nuovo · creato alla conferma' : 'Dal tuo catalogo'}</span>
          </div>
          <p className="small muted">{exercise.area}</p>
          <p className="wr-preview-dose">{exercise.sets}{exercise.optionalSets ? ` (+${exercise.optionalSets} facoltative)` : ''} × {exercise.target} · recupero {exercise.restSeconds} s{exercise.effortLabel ? ` · ${exercise.effortLabel}` : ''} · {exercise.loadLabel} ({exercise.loadUnit})</p>
          {chosen.length > 0 && <ul className="wr-preview-ranges">{chosen.map(text => <li key={text}>{text}</li>)}</ul>}
          {exercise.note && <p className="wr-preview-note">{exercise.note}</p>}
        </li>
      })}</ol>
    </li>)}</ol>
  </section>
}
