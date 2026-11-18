import { cycleRecapKey } from './cycle-recap.ts'
import { cycleExerciseOverview } from './cycle-exercise-overview.ts'
import type { ProgramCycle } from './programs.ts'
import type { ExercisePrescription, WorkoutDay, WorkoutSession } from './types.ts'
import { cycleInfo } from './progress.ts'
import { beats, setScore } from './records.ts'
import type { SetScore } from './records.ts'
import { comparable, comparisonAllowed } from './workout.ts'

const exerciseOrder = (a: ExercisePrescription, b: ExercisePrescription) =>
  a.name.localeCompare(b.name, 'it') || a.exerciseId.localeCompare(b.exerciseId) || a.id.localeCompare(b.id)
const chronological = (a: WorkoutSession, b: WorkoutSession) =>
  a.date.localeCompare(b.date) || a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id)

function bestCycleRecord(exercises: ExercisePrescription[], history: WorkoutSession[], cycleSessionIds: Set<string>) {
  const records = exercises.flatMap(exercise => {
    let previous: SetScore | null = null
    let record: { exercise: ExercisePrescription; score: SetScore; date: string; order: number } | null = null
    for (const [order, session] of history.entries()) {
      let best: SetScore | null = null
      for (const item of session.day.exercises) {
        if (!comparable(exercise, item) || !comparisonAllowed(session, item)) continue
        for (const set of session.results[item.id] ?? []) {
          const score = setScore(set)
          if (score && (!best || beats(score, best))) best = score
        }
      }
      if (best && (!previous || beats(best, previous))) {
        if (previous && cycleSessionIds.has(session.id)) record = { exercise, score: best, date: session.date, order }
        previous = best
      }
    }
    return record ? [record] : []
  })
  return records.sort((a, b) => b.order - a.order || exerciseOrder(a.exercise, b.exercise))[0] ?? null
}

interface Pause {
  firstWeek: number
  lastWeek: number
  resumedIn: number | null
}

/** Una pausa parte dopo una settimana in cui risulta almeno un allenamento. */
function cyclePauses(weeks: number[]): Pause[] {
  const pauses: Pause[] = []
  let first = weeks.findIndex(count => count > 0)
  while (first >= 0) {
    first = weeks.findIndex((count, index) => index > first && count === 0)
    if (first < 0) break
    const next = weeks.findIndex((count, index) => index > first && count > 0)
    pauses.push({ firstWeek: first + 1, lastWeek: next < 0 ? weeks.length : next, resumedIn: next < 0 ? null : next + 1 })
    first = next
  }
  return pauses
}

function longestStreak(weeks: number[]) {
  let current = 0
  let longest = 0
  for (const count of weeks) {
    current = count > 0 ? current + 1 : 0
    longest = Math.max(current, longest)
  }
  return longest
}

export function cycleReport(planId: string, sessions: WorkoutSession[], cycle: ProgramCycle, today: string, days: WorkoutDay[] = []) {
  const info = cycleInfo(cycle, today)
  if (info.status !== 'finished') return { info, weeks: [], sessions: 0, sets: 0, activeWeeks: 0, streak: 0, groups: [], pauses: [], record: null }

  const history = sessions.filter(session => session.completedAt && session.date <= info.end).sort(chronological)
  const key = cycleRecapKey(planId, cycle)
  const completed = history.filter(session => session.date >= cycle.start && session.planId === planId && session.kind !== 'free'
    && (session.cycle ? cycleRecapKey(planId, session.cycle) === key : !session.cycleRecorded))
  const weeks = Array.from({ length: cycle.weeks }, () => 0)
  const exercises: ExercisePrescription[] = []
  for (const session of completed) {
    const index = cycleInfo(cycle, session.date).week - 1
    weeks[index] = weeks[index]! + 1
    for (const exercise of session.day.exercises) {
      if (exercise.comparison && !exercises.some(other => comparable(other, exercise))) exercises.push(exercise)
    }
  }
  const sets = completed.reduce((sum, session) => sum + Object.values(session.results).flat().filter(set => setScore(set)).length, 0)
  return { info, weeks, sessions: completed.length, sets, activeWeeks: weeks.filter(count => count > 0).length,
    streak: longestStreak(weeks), groups: cycleExerciseOverview(days, completed, cycle),
    pauses: cyclePauses(weeks), record: bestCycleRecord(exercises, history, new Set(completed.map(session => session.id))) }
}
