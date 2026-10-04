import { useEffect, useRef, useState } from 'react'
import type { SavedProgram } from '../domain/programs'
import { mondayOf } from '../domain/progress'
import { fitsWizard } from '../domain/weekly'
import type { MealWizardStep } from '../features/MealPlanWizard'
import type { WizardStep } from '../features/ProgramWizard'
import type { PlansState, PlansStore } from '../persistence/plans-store'
import type { ProgramsState, ProgramsStore } from '../persistence/programs-store'
import { replaceRoute } from './route'

type Mode = 'wizard' | 'advanced'

/**
 * Modalità (guidata o avanzata) e passo degli editor di programmi e piani alimentari, più i collegamenti
 * che aprono un editor (`…/nuovo`, `…/rinnova`, `…/modifica`): consumati quando il relativo store è pronto,
 * poi sostituiti dalla pagina dell'editor nella cronologia.
 */
export function useEditors({ route, programs, plans, workout, today }: {
  route: string
  programs: { store: ProgramsStore | null; state: ProgramsState }
  plans: { store: PlansStore | null; state: PlansState }
  workout: SavedProgram | null
  today: string
}) {
  const [programMode, setProgramMode] = useState<Mode>('wizard')
  const [programStep, setProgramStep] = useState<WizardStep>('name')
  const [mealMode, setMealMode] = useState<Mode>('wizard')
  const [mealStep, setMealStep] = useState<MealWizardStep>('name')
  const opening = useRef(false)

  const programsStore = programs.store, programsReady = programs.state.phase === 'ready', programDocument = programs.state.document, index = programs.state.index
  const plansStore = plans.store, plansReady = plans.state.phase === 'ready', mealEditor = plans.state.editor.phase, followedProgram = plans.state.selection?.workoutPlanId
  useEffect(() => {
    // Lo stato degli editor cambia qui di proposito: il collegamento si consuma solo quando lo store,
    // caricato su richiesta, è pronto. Ogni ramo sostituisce subito la rotta, quindi non si ripete.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (route === '/scheda/programmi/nuovo' && programsStore && programsReady) {
      if (!programDocument) { setProgramMode('wizard'); setProgramStep('name'); programsStore.create() }
      replaceRoute('/scheda/programmi')
    }
    if (route === '/scheda/programmi/rinnova' && programsStore && programsReady && workout?.plan.cycle) {
      if (!programDocument) {
        setProgramMode('wizard'); setProgramStep('name')
        programsStore.createFrom(workout, { start: mondayOf(today, true), weeks: workout.plan.cycle.weeks })
      }
      replaceRoute('/scheda/programmi')
    }
    if (route === '/scheda/programmi/modifica' && programsStore && programsReady && !opening.current) {
      // Dalla Scheda: apre la versione in uso; il database decide se aggiornarla o crearne una nuova.
      const item = index.find(value => value.plan.id === followedProgram)
      const target = item?.versions.find(version => version.id === item.plan.activeVersionId) ?? item?.versions[0]
      if (programDocument || !target) { replaceRoute('/scheda/programmi'); return }
      opening.current = true
      void programsStore.open(target.id).then(() => {
        const opened = programsStore.getSnapshot()
        const weekly = Boolean(opened.document && fitsWizard(opened.document))
        if (opened.base?.version.status === 'published' && !opened.base.plan.archivedAt) programsStore.revise()
        setProgramMode(weekly ? 'wizard' : 'advanced'); setProgramStep('name')
      }).finally(() => { opening.current = false; replaceRoute('/scheda/programmi') })
    }
    if (route === '/dieta/piani/nuovo' && plansStore && plansReady) {
      if (mealEditor === 'closed') { setMealMode('wizard'); setMealStep('name'); plansStore.createMealPlan() }
      replaceRoute('/dieta/piani')
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [route, programsStore, programsReady, programDocument, index, plansStore, plansReady, mealEditor, followedProgram, workout, today])

  return { programMode, setProgramMode, programStep, setProgramStep, mealMode, setMealMode, mealStep, setMealStep }
}
