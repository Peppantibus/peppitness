import type { ExercisePrescription, Meal, WorkoutDay } from '../domain/types'

// Contenuti interamente inventati. Nessuna importazione dai documenti personali.
export const demoMeals: Meal[] = [
  { id: 'demo-breakfast', name: 'Colazione', timeLabel: 'Per iniziare', description: 'Yogurt, avena e frutta fresca', items: ['Yogurt bianco · 150 g', 'Fiocchi di avena · 40 g', 'Frutta fresca · 1 porzione'], alternative: 'pane e ricotta.', note: '' },
  { id: 'demo-lunch', name: 'Pranzo', timeLabel: 'Una pausa per te', description: 'Riso, ceci e verdure di stagione', items: ['Riso · 80 g', 'Ceci cotti · 120 g', 'Verdure · 1 porzione', 'Olio extravergine · 10 g'], alternative: 'cous cous al posto del riso.', note: '' },
  { id: 'demo-snack', name: 'Spuntino', timeLabel: 'Tra un impegno e l’altro', description: 'Frutta fresca e mandorle', items: ['Frutta fresca · 1 porzione', 'Mandorle · 15 g'], alternative: 'uno yogurt bianco.', note: '' },
  { id: 'demo-dinner', name: 'Cena', timeLabel: 'Il momento di rallentare', description: 'Uova, pane e un contorno di verdure', items: ['Uova · 2', 'Pane · 60 g', 'Verdure · 1 porzione'], alternative: 'tofu al posto delle uova.', note: 'Il pasto non registrato rimane “Da registrare”: non equivale a un pasto saltato.' },
]

const workoutDays: WorkoutDay[] = [
  { id: 'demo-a', label: 'A', title: 'Full body A', subtitle: 'Un movimento alla volta.', exercises: [
    { id: 'demo-a-1', exerciseId: 'demo-squat', name: 'Goblet squat', area: 'Gambe', sets: 3, target: '8–10', mode: 'reps', restSeconds: 90, note: '' },
    { id: 'demo-a-2', exerciseId: 'demo-row', name: 'Rematore con manubrio', area: 'Schiena · per lato', sets: 3, target: '10–12 per lato', mode: 'reps', restSeconds: 90, note: 'Carico del singolo manubrio. Il risultato delle ripetizioni è per lato.' },
    { id: 'demo-a-3', exerciseId: 'demo-press', name: 'Distensioni con manubri', area: 'Petto', sets: 3, target: '10–12', mode: 'reps', restSeconds: 90, note: 'Inserisci il carico di un singolo manubrio.' },
    { id: 'demo-a-4', exerciseId: 'demo-plank', name: 'Plank', area: 'Core · a tempo', sets: 2, target: '30 secondi', mode: 'seconds', restSeconds: 60, note: 'A corpo libero. Il carico può restare vuoto; registra la durata effettiva.' },
  ] },
  { id: 'demo-b', label: 'B', title: 'Full body B', subtitle: 'Ritrova il tuo ritmo.', exercises: [
    { id: 'demo-b-1', exerciseId: 'demo-step', name: 'Step up', area: 'Gambe · per lato', sets: 2, target: '10 per lato', mode: 'reps', restSeconds: 90, note: 'Carico totale utilizzato.' },
    { id: 'demo-b-2', exerciseId: 'demo-pulley', name: 'Pulley', area: 'Schiena · pulley', sets: 3, target: '10–12', mode: 'reps', restSeconds: 90, note: 'Utilizza la stessa macchina per confrontare i carichi.' },
    { id: 'demo-b-3', exerciseId: 'demo-shoulder', name: 'Shoulder press', area: 'Spalle', sets: 2, target: '8–10', mode: 'reps', restSeconds: 90, note: '' },
  ] },
  { id: 'demo-c', label: 'C', title: 'Full body C', subtitle: 'Prenditi questo tempo.', exercises: [
    { id: 'demo-c-1', exerciseId: 'demo-bridge', name: 'Ponte glutei', area: 'Gambe', sets: 3, target: '12', mode: 'reps', restSeconds: 60, note: 'A corpo libero. Zero e carico non indicato sono valori diversi.' },
    { id: 'demo-c-2', exerciseId: 'demo-row', name: 'Rematore con manubrio', area: 'Schiena · per lato', sets: 3, target: '10 per lato', mode: 'reps', restSeconds: 90, note: 'Carico del singolo manubrio, ripetizioni per lato.' },
    { id: 'demo-c-3', exerciseId: 'demo-deadbug', name: 'Dead bug', area: 'Core', sets: 2, target: '8 per lato', mode: 'reps', restSeconds: 60, note: '' },
  ] },
]

const comparisons: Record<string, NonNullable<ExercisePrescription['comparison']>> = {
  'demo-squat': { variant: 'goblet', equipment: 'manubrio', loadConvention: 'single-dumbbell', perSide: false },
  'demo-row': { variant: 'rematore-unilaterale', equipment: 'manubrio', loadConvention: 'single-dumbbell', perSide: true },
  'demo-press': { variant: 'panca-piana', equipment: 'manubri', loadConvention: 'single-dumbbell', perSide: false },
  'demo-plank': { variant: 'plank', equipment: 'tappetino', loadConvention: 'bodyweight', perSide: false },
  'demo-step': { variant: 'step-up', equipment: 'step', loadConvention: 'total', perSide: true },
  'demo-pulley': { variant: 'presa-neutra', equipment: 'pulley-1', loadConvention: 'total', perSide: false },
  'demo-shoulder': { variant: 'seduto', equipment: 'manubri', loadConvention: 'single-dumbbell', perSide: false },
  'demo-bridge': { variant: 'ponte', equipment: 'tappetino', loadConvention: 'bodyweight', perSide: false },
  'demo-deadbug': { variant: 'dead-bug', equipment: 'tappetino', loadConvention: 'bodyweight', perSide: true },
}

export const demoWorkoutDays: WorkoutDay[] = workoutDays.map(day => ({
  ...day, exercises: day.exercises.map(exercise => ({ ...exercise, comparison: comparisons[exercise.exerciseId] })),
}))
