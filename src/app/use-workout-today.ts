import { useMemo, useState } from 'react'
import { demoWorkoutDays } from '../data/demo'
import { formatDate, weekDates } from '../domain/dates'
import { suggestedDay, workoutDaysFromProgram } from '../domain/diary'
import type { CatalogExercise } from '../domain/exercises'
import { withCatalogMuscleGroups } from '../domain/programs'
import type { ProgramIndex, SavedProgram } from '../domain/programs'
import { adherence, cycleInfo, weeklyProgress } from '../domain/progress'
import type { WorkoutSession } from '../domain/types'
import { dayForDate, isWeekly } from '../domain/weekly'
import type { CycleSummary } from '../features/Workout'

/**
 * Scheda della data mostrata: versione corrente del programma seguito (nessun programma inventato sotto
 * un account), seduta prevista o scelta, ciclo e date con sedute. Nel programma settimanale la seduta
 * segue il giorno e una scelta diversa vale solo per quella data.
 */
export function useWorkoutToday({ configured, workout, programs, catalogRows, sessions, date, today }: {
  configured: boolean; workout: SavedProgram | null; programs: ProgramIndex[]; catalogRows: readonly CatalogExercise[]
  sessions: WorkoutSession[]; date: string; today: string
}) {
  const [dayId, setDayId] = useState<string | null>(null)
  const [dayChoice, setDayChoice] = useState<{ date: string; id: string } | null>(null)
  const workoutDays = useMemo(() => configured ? workout ? workoutDaysFromProgram(withCatalogMuscleGroups(workout.document, catalogRows)) : [] : demoWorkoutDays, [configured, workout, catalogRows])
  const weekly = isWeekly(workoutDays)
  const planned = weekly ? dayForDate(workoutDays, date) : undefined
  const suggestion = weekly ? planned : suggestedDay(workoutDays, sessions)
  const chosen = weekly ? (dayChoice?.date === date ? workoutDays.find(item => item.id === dayChoice.id) : undefined) : workoutDays.find(item => item.id === dayId)
  const day = weekly ? chosen ?? planned : chosen ?? suggestion ?? workoutDays[0]
  const selectDay = (id: string) => { if (weekly) setDayChoice({ date, id }); else setDayId(id) }

  // Ciclo del programma seguito: settimana corrente e sedute fatte su quelle previste finora.
  const cycle = workout?.plan.cycle ?? null
  const cycleNow = cycle ? cycleInfo(cycle, date) : null
  const programSessions = sessions.filter(session => session.planId === workout?.plan.id)
  const cycleScore = cycle && workoutDays.length ? adherence(weeklyProgress(workoutDays, programSessions, cycle, today)) : null
  const cycleSummary: CycleSummary | undefined = !cycleNow ? undefined
    : cycleNow.status === 'upcoming' ? { label: `Inizia il ${formatDate(cycleNow.start, { day: 'numeric', month: 'long' })}`, ratio: 0 }
      : cycleNow.status === 'finished' ? { label: 'Ciclo concluso', ratio: 1 }
        : { label: `Settimana ${cycleNow.week} di ${cycleNow.weeks}`, detail: cycleScore && cycleScore.due > 0 ? `${cycleScore.done} di ${cycleScore.due} sedute fatte` : undefined, ratio: cycleNow.week / cycleNow.weeks }

  const shownWeek = weekDates(date)
  return {
    workoutDays, weekly, planned, suggestion, day, selectDay,
    /** Cambio di programma: la scelta manuale della seduta non vale più. */
    resetDay: () => setDayId(null),
    followable: programs.filter(item => item.plan.activeVersionId && !item.plan.archivedAt),
    activeSession: sessions.find(session => !session.completedAt),
    cycleFinished: cycleNow?.status === 'finished', cycleScore, cycleSummary, programSessions,
    // Giorni con una seduta prevista nella settimana mostrata (solo programmi settimanali).
    trainingDates: weekly && workout ? shownWeek.filter(value => dayForDate(workoutDays, value)) : [],
    // Giorni della settimana mostrata con una seduta completata.
    sessionDates: shownWeek.filter(value => sessions.some(session => session.completedAt && session.date === value)),
    /** Tipo di giornata proposto dalla scheda settimanale seguita: riposo se quel giorno non ha seduta. */
    programDayType: weekly && workout ? (planned ? 'training' as const : 'rest' as const) : undefined,
  }
}
export type WorkoutToday = ReturnType<typeof useWorkoutToday>
