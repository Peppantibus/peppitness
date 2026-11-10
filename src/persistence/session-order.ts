import type { ExercisePrescription } from '../domain/types'

const ORDER_KEY = 'peppitness:workout-order:v1'
const LATER_KEY = 'peppitness:workout-later:v1'

function readIds(key: string, sessionId: string): string[] | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? 'null') as { sessionId?: unknown; ids?: unknown } | null
    return value?.sessionId === sessionId && Array.isArray(value.ids)
      ? value.ids.filter((id): id is string => typeof id === 'string') : null
  } catch { return null }
}

/** Recupera anche i rinvii creati prima del riordino libero. Nessuna modifica al programma. */
export function readSessionOrder(sessionId: string, exercises: ExercisePrescription[]): string[] {
  const ids = readIds(ORDER_KEY, sessionId)
  if (ids) return ids
  const later = readIds(LATER_KEY, sessionId) ?? []
  return [...exercises.filter(exercise => !later.includes(exercise.id)).map(exercise => exercise.id), ...later]
}

export function writeSessionOrder(sessionId: string, ids: string[]) {
  try {
    window.localStorage.setItem(ORDER_KEY, JSON.stringify({ sessionId, ids }))
    window.localStorage.removeItem(LATER_KEY)
  } catch { /* Il riordino resta disponibile in memoria se l'archivio è pieno o bloccato. */ }
}

export function forgetSessionOrder() {
  try { window.localStorage.removeItem(ORDER_KEY); window.localStorage.removeItem(LATER_KEY) } catch { /* archivio non disponibile */ }
}
