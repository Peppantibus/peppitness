import type { cycleReport } from './cycle-report.ts'
import { isLocalDate } from './dates.ts'
import type { ProgramCycle } from './programs.ts'

export interface CycleRecapGroup {
  label: string
  exercise: string
  points: { value: string; week: number }[]
  caption?: string
  perSide?: boolean
}

export type CycleRecapReport = Pick<ReturnType<typeof cycleReport>, 'sessions' | 'sets' | 'weeks' | 'activeWeeks' | 'streak' | 'pauses'> & {
  info: Pick<ReturnType<typeof cycleReport>['info'], 'start' | 'end' | 'weeks'>
  groups: CycleRecapGroup[]
  record: { exercise: string; value: string; date: string } | null
}

export interface CycleRecap {
  schema: 1
  key: string
  title: string
  report: CycleRecapReport
  unseen?: true
}

/** Una modifica del nome o della versione della scheda non cambia l'identità del ciclo. */
export function cycleRecapKey(planId: string, cycle: ProgramCycle) {
  return `${planId}.${cycle.start}.${cycle.weeks}`
}

export const cycleRecapHref = (key: string) => `#/scheda/riepilogo/archivio/${key}/passati`
export const createWorkoutProgramHref = '#/scheda/programmi/riparti'

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const date = (value: unknown): value is string => typeof value === 'string' && isLocalDate(value)

export function readCycleRecap(value: unknown): CycleRecap | null {
  if (!object(value) || value.schema !== 1 || typeof value.key !== 'string' || typeof value.title !== 'string') return null
  if (value.unseen !== undefined && value.unseen !== true) return null
  const { report } = value
  if (!object(report) || !object(report.info) || !date(report.info.start) || !date(report.info.end) || !integer(report.info.weeks)) return null
  if (!/^[a-zA-Z0-9_-]+\.\d{4}-\d{2}-\d{2}\.\d+$/.test(value.key) || !value.key.endsWith(`.${report.info.start}.${report.info.weeks}`)) return null
  if (!integer(report.sessions) || !integer(report.sets) || !integer(report.activeWeeks) || !integer(report.streak)) return null
  if (!Array.isArray(report.weeks) || report.weeks.length !== report.info.weeks || !report.weeks.every(integer)) return null
  if (!Array.isArray(report.groups) || !report.groups.every(group => object(group) && typeof group.label === 'string' && typeof group.exercise === 'string'
    && (group.caption === undefined || typeof group.caption === 'string') && (group.perSide === undefined || typeof group.perSide === 'boolean')
    && Array.isArray(group.points) && group.points.every(point => object(point) && typeof point.value === 'string' && integer(point.week)))) return null
  if (!Array.isArray(report.pauses) || !report.pauses.every(pause => object(pause) && integer(pause.firstWeek) && integer(pause.lastWeek)
    && (pause.resumedIn === null || integer(pause.resumedIn)))) return null
  const record = report.record
  if (record !== null && (!object(record) || typeof record.exercise !== 'string' || typeof record.value !== 'string' || !date(record.date))) return null
  return value as unknown as CycleRecap
}

export function cycleRecapsFrom(items: unknown[]) {
  const recaps: Record<string, CycleRecap> = {}
  for (const item of items) {
    const recap = readCycleRecap(item)
    if (recap) recaps[recap.key] = recap
  }
  return recaps
}
