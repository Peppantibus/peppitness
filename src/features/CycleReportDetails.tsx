import type { CycleRecapReport } from '../domain/cycle-recap'
import type { cycleReport } from '../domain/cycle-report'
import { formatDecimal } from '../domain/diary'
import type { ExercisePrescription, SetResult } from '../domain/types'
import { formatResult } from '../domain/workout'

type Report = ReturnType<typeof cycleReport>

const trendLabels = {
  stable: 'Valori stabili',
  down: 'Valore finale più basso',
  variable: 'Valori variabili',
  isolated: 'Miglioramento in una sola settimana',
}

const decimal = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 6 })
const numberText = (value: string) => decimal.format(Number(value.replace(',', '.')))

function pointValue(set: SetResult, exercise: ExercisePrescription) {
  if (exercise.mode === 'seconds') return formatResult(set, exercise)
  if (set.load.trim()) {
    return `${numberText(set.load)} ${exercise.loadUnit ?? 'kg'} × ${numberText(set.amount)}`
  }
  return formatResult({ ...set, amount: numberText(set.amount) }, exercise)
}

export function cycleRecapReport(report: Report): CycleRecapReport {
  const { info, groups, record, sessions, sets, weeks, activeWeeks, streak, pauses } = report
  return {
    info: { start: info.start, end: info.end, weeks: info.weeks }, sessions, sets, weeks, activeWeeks, streak, pauses,
    groups: groups.map(({ label, exercise, points, trend }) => ({
      label, exercise: exercise.name,
      points: points.map(({ set, week }) => ({ value: pointValue(set, exercise), week })),
      ...(trend && trend !== 'progress' ? { caption: trendLabels[trend] } : {}),
      ...(exercise.comparison?.perSide ? { perSide: true } : {}),
    })),
    record: record ? {
      exercise: record.exercise.name, date: record.date,
      value: formatResult({
        load: record.score.load ? formatDecimal(record.score.load) : '',
        amount: formatDecimal(record.score.amount), completed: true,
      }, record.exercise),
    } : null,
  }
}

export function CycleExerciseList({ groups }: Pick<CycleRecapReport, 'groups'>) {
  if (!groups.length) return null
  return <ul className="cycle-report-exercises" aria-label="Panoramica per gruppo muscolare">
    {groups.map(({ label, exercise, points, caption, perSide }) => <li className="cycle-report-exercise" key={label}>
      <h3><span>{label}</span> · {exercise}</h3>
      {caption && <p className="cycle-report-caption">{caption}</p>}
      <ol className="cycle-report-points">
        {points.map(({ value, week }) => <li key={week}>
          <strong>{value}</strong>
          <small>Settimana {week}</small>
        </li>)}
      </ol>
      {perSide && <p className="cycle-report-caption">Ripetizioni per lato</p>}
    </li>)}
  </ul>
}
