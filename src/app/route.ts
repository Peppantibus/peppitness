import { useState, useSyncExternalStore } from 'react'

export type Section = 'dieta' | 'scheda'

function subscribe(callback: () => void) { window.addEventListener('hashchange', callback); return () => window.removeEventListener('hashchange', callback) }
function current() { return window.location.hash.replace(/^#/, '') || '/dieta' }
export function navigate(path: string) { window.location.hash = path }
/** Sostituisce la rotta senza lasciare una voce nella cronologia (collegamenti che aprono un editor). */
export function replaceRoute(path: string) { window.location.replace(`#${path}`) }

const programRoutes = ['/scheda/programmi', '/scheda/programmi/nuovo', '/scheda/programmi/modifica', '/scheda/programmi/rinnova']

/** Rotta corrente (hash) e pagine che ne derivano. */
export function useRoute() {
  const route = useSyncExternalStore(subscribe, current)
  // Ultima sezione visitata: Impostazioni e pagine non valide riportano lì.
  const routeSection: Section | null = route.startsWith('/scheda') ? 'scheda' : route.startsWith('/dieta') ? 'dieta' : null
  const [lastSection, setLastSection] = useState<Section>('dieta')
  if (routeSection && routeSection !== lastSection) setLastSection(routeSection)
  const section = routeSection ?? lastSection
  const param = (prefix: string) => route.startsWith(prefix) ? route.split('/')[3] : undefined
  return {
    route, section, lastSection,
    isCatalog: route === '/scheda/catalogo',
    isPrograms: programRoutes.includes(route),
    isMealPlans: route === '/dieta/piani' || route === '/dieta/piani/nuovo',
    isProgress: route === '/scheda/progressi',
    isImport: route === '/scheda/importa' || route === '/dieta/importa',
    importKind: route === '/dieta/importa' ? 'diet' as const : 'workout' as const,
    isHistory: route === `/${section}/storico`,
    isSettings: route === '/impostazioni',
    isSession: route === '/scheda/seduta',
    historySessionId: param('/scheda/storico/'),
    mealId: param('/dieta/pasto/'),
    exerciseId: param('/scheda/esercizio/'),
  }
}
export type RouteInfo = ReturnType<typeof useRoute>
