/** Vuoto e zero rimangono distinti. Nessun parseFloat che accetti input parziale. */
export function parseNonNegativeNumber(value: string): number | null {
  const normalized = value.trim().replace(',', '.')
  if (normalized === '') return null
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error('Inserisci un numero positivo o zero, per esempio 12,5.')
  const number = Number(normalized)
  if (!Number.isFinite(number)) throw new Error('Numero non valido.')
  return number
}

export function validateSet(load: string, amount: string, mode: 'reps' | 'seconds'): string | null {
  try {
    parseNonNegativeNumber(load)
    const result = parseNonNegativeNumber(amount)
    if (result === null) return 'Inserisci il risultato prima di completare la serie.'
    if (mode === 'reps' && !Number.isInteger(result)) return 'Le ripetizioni devono essere un numero intero.'
    return null
  } catch (error) {
    return error instanceof Error ? error.message : 'Controlla i valori inseriti.'
  }
}
