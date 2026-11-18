import { exerciseMuscleGroup, groupExercises } from './muscle-groups.ts'
import { cycleInfo } from './progress.ts'
import type { ProgramCycle } from './programs.ts'
import { beats, setScore } from './records.ts'
import type { ExercisePrescription, SetResult, WorkoutDay, WorkoutSession } from './types.ts'
import { comparable, comparisonAllowed } from './workout.ts'

interface Sample {
  set: SetResult
  value: number
  week: number
  order: number
}

const trendPriority = { progress: 4, stable: 3, down: 2, variable: 2, isolated: 1 }
type Trend = keyof typeof trendPriority

interface Evidence {
  exercise: ExercisePrescription
  trend: Trend
  points: Sample[]
  endpoints: number
  phases: number
  confirmingWeeks: number
  weeks: number
  sessions: number
  span: number
}

const exerciseOrder = (a: ExercisePrescription, b: ExercisePrescription) =>
  a.name.localeCompare(b.name, 'it') || a.exerciseId.localeCompare(b.exerciseId) || a.id.localeCompare(b.id)

function compareEvidence(a: Evidence, b: Evidence) {
  return trendPriority[b.trend] - trendPriority[a.trend]
    || b.endpoints - a.endpoints || b.phases - a.phases || b.confirmingWeeks - a.confirmingWeeks
    || b.weeks - a.weeks || b.sessions - a.sessions || b.span - a.span
    || exerciseOrder(a.exercise, b.exercise)
}

function evaluateTrace(exercise: ExercisePrescription, trace: Sample[], weeks: number): Evidence | null {
  const [first] = trace
  if (!first) return null
  const later = trace.filter(point => point.week > first.week)
  const latest = later.at(-1)
  if (!latest) return null
  const late = later.filter(point => point.week >= Math.max(1, weeks - 2))
  const last = late.reduce((best, point) =>
    point.value > best.value || point.value === best.value && point.order > best.order ? point : best, late[0] ?? latest)
  const center = (weeks + 1) / 2
  const distance = ({ week }: Sample) => Math.abs(week - center)
  const nearCenter = (point: Sample) => distance(point) <= Math.max(1, weeks / 6)
  const middle = later.filter(point => point.week < last.week && nearCenter(point))
    .sort((a, b) => distance(a) - distance(b) || a.week - b.week || b.value - a.value || a.order - b.order)[0]
  const early = first.week <= Math.ceil(weeks / 3)
  const improvedWeeks = new Set(later.filter(point => point.value > first.value).map(point => point.week))
  const trend = last.value > first.value ? improvedWeeks.size >= 2 ? 'progress' : 'isolated'
    : last.value < first.value ? 'down'
      : later.every(point => point.value === first.value) ? 'stable' : 'variable'

  return { exercise, trend, points: middle ? [first, middle, last] : [first, last],
    endpoints: Number(early) + Number(late.length > 0),
    phases: Number(early) + Number(trace.some(nearCenter)) + Number(late.length > 0),
    confirmingWeeks: trend === 'progress' ? improvedWeeks.size - 1 : 0,
    weeks: new Set(trace.map(point => point.week)).size, sessions: trace.length, span: last.week - first.week }
}

function evidenceFor(exercise: ExercisePrescription, sessions: WorkoutSession[], cycle: ProgramCycle) {
  const loadsAtSameReps = new Map<number, Sample[]>()
  const amountsAtSameLoad = new Map<number | null, Sample[]>()
  sessions.forEach((session, order) => {
    const sets = session.day.exercises.filter(item => comparable(exercise, item) && comparisonAllowed(session, item))
      .flatMap(item => session.results[item.id] ?? []).flatMap(set => {
        const score = setScore(set)
        return score ? [{ set, ...score, load: exercise.mode === 'seconds' ? 0 : score.load }] : []
      })
    if (!sets.length) return
    const { week } = cycleInfo(cycle, session.date)
    const retain = <Key extends number | null>(traces: Map<Key, Sample[]>, fixed: Key, value: number, set: SetResult) => {
      const trace = traces.get(fixed) ?? []
      const previous = trace.at(-1)
      const point = { set, value, week, order }
      if (previous?.order !== order) trace.push(point)
      else if (value > previous.value) trace[trace.length - 1] = point
      traces.set(fixed, trace)
    }
    for (const point of sets) {
      // Una serie più debole nella stessa seduta non crea una base favorevole.
      if (sets.some(other => other.load >= point.load && other.amount >= point.amount && beats(other, point))) continue
      const hasLoad = point.set.load.trim() !== ''
      retain(amountsAtSameLoad, hasLoad ? point.load : null, point.amount, point.set)
      if (exercise.mode === 'reps' && hasLoad) retain(loadsAtSameReps, point.amount, point.load, point.set)
    }
  })
  return [...loadsAtSameReps.values(), ...amountsAtSameLoad.values()].flatMap(trace => {
    const evidence = evaluateTrace(exercise, trace, cycle.weeks)
    return evidence ? [evidence] : []
  }).sort(compareEvidence)[0]
}

// L'ultima seduta utile offre una serie reale anche quando manca un confronto.
function latestGroupPoints(sessions: WorkoutSession[], cycle: ProgramCycle) {
  const points = new Map<ReturnType<typeof exerciseMuscleGroup>, { exercise: ExercisePrescription; set: SetResult; week: number }>()
  for (const session of [...sessions].reverse()) {
    for (const exercise of [...session.day.exercises].sort(exerciseOrder)) {
      const group = exerciseMuscleGroup(exercise)
      if (points.has(group) || !comparisonAllowed(session, exercise)) continue
      let best: { set: SetResult; score: NonNullable<ReturnType<typeof setScore>> } | undefined
      for (const set of session.results[exercise.id] ?? []) {
        const score = setScore(set)
        if (!score) continue
        if (exercise.mode === 'seconds') score.load = 0
        if (!best || beats(score, best.score)) best = { set, score }
      }
      if (best) points.set(group, { exercise, set: best.set, week: cycleInfo(cycle, session.date).week })
    }
  }
  return points
}

export function cycleExerciseOverview(days: WorkoutDay[], sessions: WorkoutSession[], cycle: ProgramCycle) {
  const planned = days.flatMap(day => day.exercises)
  const exercises: ExercisePrescription[] = []
  for (const exercise of [...planned, ...sessions.flatMap(session => session.day.exercises)].sort(exerciseOrder)) {
    if (exercise.comparison && !exercises.some(other => comparable(other, exercise) && exerciseMuscleGroup(other) === exerciseMuscleGroup(exercise))) exercises.push(exercise)
  }
  const comparisons = exercises.flatMap(exercise => {
    const evidence = evidenceFor(exercise, sessions, cycle)
    return evidence ? [evidence] : []
  }).sort(compareEvidence)
  const latest = latestGroupPoints(sessions, cycle)
  return groupExercises(planned).flatMap<{ label: string; exercise: ExercisePrescription; points: Pick<Sample, 'set' | 'week'>[]; trend?: Trend }>(({ group, label }) => {
    const comparison = comparisons.find(item => exerciseMuscleGroup(item.exercise) === group)
    if (comparison) return [{ label, exercise: comparison.exercise, points: comparison.points, trend: comparison.trend }]
    const point = latest.get(group)
    return point ? [{ label, exercise: point.exercise, points: [{ set: point.set, week: point.week }] }] : []
  })
}
