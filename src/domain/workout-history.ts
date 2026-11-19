import { cycleRecapKey } from './cycle-recap.ts'
import type { CycleRecap } from './cycle-recap.ts'
import type { DiaryData } from './diary.ts'
import type { ProgramCycle, ProgramRoot } from './programs.ts'
import { cycleInfo } from './progress.ts'
import type { WorkoutSession } from './types.ts'

export type HistoryTab = 'attuale' | 'passati' | 'liberi'
export const historyRoute = (tab: HistoryTab) => tab === 'attuale' ? '/scheda/storico' : `/scheda/storico/${tab}`
export const historySessionHref = (tab: HistoryTab, id: string) => `#${historyRoute(tab)}/${id}`

interface HistoryCycle {
  key: string
  title: string
  cycle?: ProgramCycle
  sessions: WorkoutSession[]
  recap?: CycleRecap
  status: string
}

const planKey = (planId: string) => `${planId}.senza-ciclo`
const newestSession = (a: WorkoutSession, b: WorkoutSession) => b.date.localeCompare(a.date) || b.startedAt.localeCompare(a.startedAt)

export function workoutHistory(view: DiaryData, programs: ProgramRoot[], current: ProgramRoot | null, today: string) {
  const names = new Map(programs.map(program => [program.id, program.name]))
  const followableCycles = new Set(programs.flatMap(program => program.cycle && program.activeVersionId && !program.archivedAt
    ? [cycleRecapKey(program.id, program.cycle)] : []))
  const periods = new Map<string, Map<string, ProgramCycle>>()
  function remember(planId: string, cycle: ProgramCycle) {
    const known = periods.get(planId) ?? new Map<string, ProgramCycle>()
    known.set(cycleRecapKey(planId, cycle), cycle)
    periods.set(planId, known)
  }

  for (const program of programs) if (program.cycle) remember(program.id, program.cycle)
  if (current?.cycle) remember(current.id, current.cycle)

  const workouts = view.sessions.filter(session => session.completedAt).sort(newestSession)
  for (const session of workouts) if (session.planId && session.cycle && session.kind !== 'free') remember(session.planId, session.cycle)

  const interruptions = new Set(view.interruptedCycles ?? [])
  for (const key of interruptions) {
    const [planId, start, weeks] = key.split('.')
    if (planId && start && weeks) remember(planId, { start, weeks: Number(weeks) })
  }

  const cycles = new Map<string, HistoryCycle>()
  for (const recap of Object.values(view.cycleRecaps ?? {})) {
    const planId = recap.key.split('.')[0]!
    const cycle = { start: recap.report.info.start, weeks: recap.report.info.weeks }
    remember(planId, cycle)
    cycles.set(recap.key, { key: recap.key, title: recap.title, cycle, recap, sessions: [], status: 'Concluso' })
  }

  const selectedKey = current?.cycle ? cycleRecapKey(current.id, current.cycle) : current ? planKey(current.id) : null
  const selectedStatus = current?.cycle ? cycleInfo(current.cycle, today).status : null
  const currentKey = selectedKey && selectedStatus !== 'finished' && !cycles.has(selectedKey) ? selectedKey : null
  if (current && selectedKey && !cycles.has(selectedKey)) {
    cycles.set(selectedKey, { key: selectedKey, title: current.name, cycle: current.cycle ?? undefined, sessions: [],
      status: selectedStatus === 'finished' ? 'Da chiudere' : selectedStatus === 'upcoming' ? 'In partenza' : 'In corso' })
  }

  const free: WorkoutSession[] = []
  for (const session of workouts) {
    if (session.kind === 'free') { free.push(session); continue }

    const planId = session.planId ?? ''
    const candidates = session.cycle || session.cycleRecorded ? [] : [...(periods.get(planId)?.values() ?? [])]
      .filter(period => cycleInfo(period, session.date).status === 'active')
    // Le sedute precedenti allo snapshot entrano in un ciclo solo se il periodo è univoco.
    const cycle = session.cycle ?? (candidates.length === 1 ? candidates[0] : undefined)
    const key = cycle ? cycleRecapKey(planId, cycle) : planKey(planId)
    let entry = cycles.get(key)
    if (!entry) {
      const status = interruptions.has(key) ? 'Interrotto'
        : cycle && followableCycles.has(key) && cycleInfo(cycle, today).status === 'finished' ? 'Da chiudere' : 'Archiviato'
      entry = { key, cycle, title: session.day.subtitle || names.get(planId) || 'Sedute precedenti', sessions: [], status }
      cycles.set(key, entry)
    }
    entry.sessions.push(session)
  }

  const activityDate = (entry: HistoryCycle) => entry.cycle ? cycleInfo(entry.cycle, today).end : entry.sessions[0]?.date ?? ''
  return {
    current: currentKey ? cycles.get(currentKey) : undefined,
    expiredSelection: selectedKey && !currentKey ? cycles.get(selectedKey) : undefined,
    past: [...cycles.values()].filter(entry => entry.key !== currentKey)
      .sort((a, b) => activityDate(b).localeCompare(activityDate(a)) || a.title.localeCompare(b.title, 'it')),
    free,
  }
}

export function historySessionGroups(sessions: WorkoutSession[], cycle?: ProgramCycle) {
  const groups = new Map<string, WorkoutSession[]>()
  for (const session of sessions) {
    const key = cycle ? String(cycleInfo(cycle, session.date).week) : session.date.slice(0, 7)
    const items = groups.get(key) ?? []
    items.push(session)
    groups.set(key, items)
  }
  return [...groups].map(([key, sessions]) => ({ key, sessions }))
}
