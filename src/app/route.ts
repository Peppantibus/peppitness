import { useState, useSyncExternalStore } from 'react'
import type { HistoryTab } from '../domain/workout-history'

export type Section = 'dieta' | 'scheda'

function subscribe(callback: () => void) { window.addEventListener('hashchange', callback); return () => window.removeEventListener('hashchange', callback) }
function current() { return window.location.hash.replace(/^#/, '') || '/dieta' }
export function navigate(path: string) { window.location.hash = path }
/** Sostituisce la rotta senza lasciare una voce nella cronologia (collegamenti che aprono un editor). */
export function replaceRoute(path: string) { window.location.replace(`#${path}`) }

const programRoutes = ['/scheda/programmi', '/scheda/programmi/nuovo', '/scheda/programmi/modifica', '/scheda/programmi/rinnova', '/scheda/programmi/riparti']

/** Rotta corrente (hash) e pagine che ne derivano. */
export function useRoute() {
  const route = useSyncExternalStore(subscribe, current)
  // Ultima sezione visitata: Impostazioni e pagine non valide riportano lì.
  const routeSection: Section | null = route.startsWith('/scheda') ? 'scheda' : route.startsWith('/dieta') ? 'dieta' : null
  const [lastSection, setLastSection] = useState<Section>('dieta')
  if (routeSection && routeSection !== lastSection) setLastSection(routeSection)
  const section = routeSection ?? lastSection
  const param = (prefix: string) => route.startsWith(prefix) ? route.split('/')[3] : undefined
  const archived = /^\/scheda\/riepilogo\/archivio\/([a-zA-Z0-9_.-]+)(?:\/passati)?$/.exec(route)
  const workoutHistory = /^\/scheda\/storico(?:\/(passati|liberi))?(?:\/([^/]+))?$/.exec(route)
  const historyTab: HistoryTab = workoutHistory?.[1] === 'passati' ? 'passati' : workoutHistory?.[1] === 'liberi' ? 'liberi' : 'attuale'
  return {
    route, section, lastSection,
    isCatalog: route === '/scheda/catalogo',
    isPrograms: programRoutes.includes(route),
    isProgramStarter: route === '/scheda/programmi/riparti',
    isMealPlans: route === '/dieta/piani' || route === '/dieta/piani/nuovo',
    isProgress: route === '/scheda/progressi',
    isCycleReport: route === '/scheda/riepilogo' || route === '/scheda/riepilogo/storie' || Boolean(archived),
    archivedCycleKey: archived?.[1],
    isImport: route === '/scheda/importa' || route === '/dieta/importa',
    importKind: route === '/dieta/importa' ? 'diet' as const : 'workout' as const,
    isHistory: route === '/dieta/storico' || Boolean(workoutHistory && !workoutHistory[2]),
    historyTab,
    isSettings: route === '/impostazioni',
    isSession: route === '/scheda/seduta',
    isMorning: route === '/scheda/mattino' || route === '/scheda/mattino/modifica',
    isMorningEditor: route === '/scheda/mattino/modifica',
    historySessionId: workoutHistory?.[2],
    mealId: param('/dieta/pasto/'),
    exerciseId: param('/scheda/esercizio/'),
  }
}
export type RouteInfo = ReturnType<typeof useRoute>
