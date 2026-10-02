import type { RuleItem } from './issues.ts'

/** Conditional additions are instructions, not optional sets executable from week one. */
export const hasDelayedOptionalSets = (text: string): boolean =>
  /(?:facoltativ\w*|opzional\w*).*?(?:da(?:lla|lle)?|a partire|dopo).*?(?:\bS\s*\d|settim|fase)/i.test(text.replace(/\s+/g, ' '))

export function instructionTargets(rule: RuleItem, items: readonly RuleItem[]): RuleItem[] | null {
  const paths = rule.values.targetPaths as string[]
  if (!paths.length) return items.filter(i => i.collection === 'exercises')
  const targets: RuleItem[] = []
  for (const path of paths) {
    const target = items.find(i => i.pointer === path)
    if (!target || !['sessions', 'exercises'].includes(target.collection)) return null
    targets.push(...(target.collection === 'exercises' ? [target] : items.filter(i => i.collection === 'exercises' && i.parentKey === target.key)))
  }
  return targets
}

/** Source/evidence checks still run independently. This only checks executable base doses. */
export function instructionCanBeKept(rule: RuleItem, items: readonly RuleItem[]): boolean {
  if (typeof rule.values.text !== 'string' || !rule.values.text.trim()) return false
  const targets = instructionTargets(rule, items)
  if (!targets?.length) return false
  return targets.every(item => {
    const v = item.values
    const mode = item.catalog?.source === 'new' ? item.catalog.values.measurementMode
      : item.catalog ? item.catalog.seen.measurementMode : v.measurementMode
    const reps = v.repetitions !== null, seconds = v.durationSeconds !== null
    if (!Number.isSafeInteger(v.sets) || Number(v.sets) < 1 || reps === seconds) return false
    if ((mode === 'seconds' && !seconds) || (mode === 'reps' && !reps)) return false
    return !hasDelayedOptionalSets(rule.values.text as string) || v.optionalSets === 0
  })
}
