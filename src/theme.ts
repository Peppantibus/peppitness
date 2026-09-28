/**
 * Tema dell'interfaccia. «Automatico» segue il sistema (media query CSS, già corretta al primo
 * disegno); «Chiaro» e «Scuro» impostano `data-theme` sull'elemento radice. La scelta vale solo
 * per questo dispositivo: è una comodità locale, non un dato dell'account.
 */
export type ThemePreference = 'system' | 'light' | 'dark'

const storageKey = 'peppitness:theme'
/** Deve coincidere con `--color-bg` dei due temi in styles.css. */
export const themeColors = { light: '#f5f6f2', dark: '#121a17' } as const

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch { return 'system' }
}

export function applyTheme(preference: ThemePreference) {
  const root = document.documentElement
  if (preference === 'system') delete root.dataset.theme
  else root.dataset.theme = preference
  // theme-color: in automatico decidono i due meta con `media`; con una scelta esplicita valgono entrambi il tema scelto.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach(meta => {
    const own = meta.media.includes('dark') ? themeColors.dark : themeColors.light
    meta.content = preference === 'system' ? own : themeColors[preference]
  })
}

export function saveThemePreference(preference: ThemePreference) {
  try {
    if (preference === 'system') localStorage.removeItem(storageKey)
    else localStorage.setItem(storageKey, preference)
  } catch { /* archivio non disponibile: la scelta vale fino alla chiusura */ }
  applyTheme(preference)
}
