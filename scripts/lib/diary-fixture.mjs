// Modello HTTP sintetico di diario, piani seguiti e piani alimentari per i test frontend.
// Riproduce revisioni, unicità e proprietario come il database, non verifica RLS/transazioni reali.
const keys = {
  active_plans: ['owner_id'],
  meal_plans: ['id'],
  workout_sessions: ['id'],
  workout_set_logs: ['session_id', 'prescription_id', 'set_index'],
  meal_logs: ['diary_date', 'meal_id'],
  diary_days: ['diary_date'],
}
const insertable = {
  active_plans: ['workout_plan_id', 'meal_plan_id'],
  meal_plans: ['id', 'name', 'document'],
  workout_set_logs: ['session_id', 'prescription_id', 'set_index', 'load', 'amount', 'completed'],
  meal_logs: ['diary_date', 'meal_id', 'meal_plan_id', 'status', 'note', 'day_type', 'meal_snapshot'],
  diary_days: ['diary_date', 'day_type'],
}
const updatable = {
  active_plans: ['workout_plan_id', 'meal_plan_id', 'revision'],
  meal_plans: ['name', 'document', 'archived_at', 'revision'],
  workout_sessions: ['status', 'note', 'revision'],
  workout_set_logs: ['load', 'amount', 'completed', 'revision'],
  meal_logs: ['status', 'note', 'revision'],
  diary_days: ['day_type', 'revision'],
}
export const diaryPaths = [...Object.keys(keys).map(table => `/rest/v1/${table}`), '/rest/v1/rpc/start_workout_session', '/rest/v1/rpc/activate_workout_version']

function ownerOf(request) {
  const authorization = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
  return JSON.parse(Buffer.from(authorization?.split('.')[1] ?? '', 'base64url').toString()).sub
}
function wantsObject(request) {
  return Object.entries(request.headers).some(([name, value]) => name.toLowerCase() === 'accept' && value.includes('vnd.pgrst.object'))
}
function matches(row, url) {
  return [...url.searchParams.entries()].every(([key, value]) => {
    if (['select', 'order', 'limit', 'offset'].includes(key)) return true
    const raw = row[key]
    if (value.startsWith('eq.')) return String(raw) === value.slice(3)
    if (value.startsWith('gt.')) return String(raw) > value.slice(3)
    return false
  })
}

export function diaryFixture(request, url, state) {
  state.diary ??= { active_plans: [], meal_plans: [], workout_sessions: [], workout_set_logs: [], meal_logs: [], diary_days: [] }
  state.diaryWrites ??= []
  const owner = ownerOf(request)
  const table = url.pathname.split('/').at(-1)
  if (state.failDiary) return { failure: 'InternetDisconnected' }

  if (url.pathname.includes('/rpc/')) {
    const body = JSON.parse(request.postData ?? '{}')
    state.diaryWrites.push({ method: table, body })
    if (table === 'start_workout_session') {
      const existing = state.diary.workout_sessions.find(row => row.id === body.p_session_id)
      if (existing) return existing.owner_id === owner ? { status: 200, data: existing } : { status: 403, data: { code: '42501' } }
      const version = state.programTables?.workout_plan_versions.find(row => row.id === body.p_version_id && row.owner_id === owner)
      if (!version) return { status: 403, data: { code: '42501' } }
      if (version.status !== 'published') return { status: 500, data: { code: '55000' } }
      const day = state.programTables.workout_days.find(row => row.id === body.p_day_id && row.version_id === version.id)
      if (!day) return { status: 403, data: { code: '42501' } }
      if (state.diary.workout_sessions.some(row => row.owner_id === owner && row.status === 'active')) return { status: 409, data: { code: 'PT409' } }
      const exercises = state.programTables.workout_prescriptions.filter(row => row.day_id === day.id).sort((a, b) => a.position - b.position).map(row => ({
        id: row.id, exercise_id: row.exercise_id, name: row.exercise_snapshot.name, variant: row.exercise_snapshot.variant, equipment: row.exercise_snapshot.equipment,
        load_convention: row.exercise_snapshot.load_convention, load_unit: row.exercise_snapshot.load_unit, per_side: row.exercise_snapshot.per_side, exercise_note: row.exercise_snapshot.note,
        mode: row.mode, sets: row.sets, optional_sets: row.optional_sets ?? 0, reps_min: row.reps_min ?? null, reps_max: row.reps_max ?? null, duration_seconds: row.duration_seconds ?? null,
        rest_seconds: row.rest_seconds ?? 0, rir: row.rir ?? null, rpe: row.rpe ?? null, note: row.note ?? '',
      }))
      const row = { id: body.p_session_id, owner_id: owner, plan_id: version.plan_id, version_id: version.id, day_id: day.id, diary_date: body.p_diary_date, time_zone: body.p_time_zone,
        day_snapshot: { label: day.label, title: day.title, note: day.note ?? '', plan_title: version.title, version_number: version.version_number, exercises },
        status: 'active', started_at: new Date().toISOString(), completed_at: null, revision: 1 }
      state.diary.workout_sessions.push(row)
      if (state.loseStart) { state.loseStart = false; return { failure: 'ConnectionClosed' } }
      return { status: 200, data: row }
    }
    if (table === 'activate_workout_version') {
      const version = state.programTables?.workout_plan_versions.find(row => row.id === body.p_version_id && row.owner_id === owner)
      if (!version) return { status: 403, data: { code: '42501' } }
      const plan = state.programTables.workout_plans.find(row => row.id === version.plan_id)
      if (plan.revision !== body.p_expected_plan_revision) return { status: 409, data: { code: 'PT409' } }
      plan.active_version_id = version.id; plan.revision++
      return { status: 200, data: plan }
    }
    state.failures.push(`RPC diario inattesa: ${table}`)
    return { status: 400, data: {} }
  }

  const rows = state.diary[table]
  if (!rows) { state.failures.push(`Tabella diario inattesa: ${table}`); return { status: 400, data: {} } }
  if (url.searchParams.get('owner_id') !== `eq.${owner}` && request.method !== 'POST') state.failures.push(`Filtro proprietario mancante: ${table}`)
  const own = rows.filter(row => row.owner_id === owner && matches(row, url))
  const reply = list => wantsObject(request) ? (list.length === 1 ? { status: 200, data: list[0] } : { status: 406, data: { code: 'PGRST116' } }) : { status: 200, data: list }

  if (request.method === 'GET') {
    const offset = Number(url.searchParams.get('offset') ?? 0), limit = Number(url.searchParams.get('limit') ?? 1000)
    const order = (url.searchParams.get('order') ?? 'id').split('.')[0]
    return reply(own.sort((a, b) => String(a[order]).localeCompare(String(b[order]))).slice(offset, offset + limit))
  }
  const body = JSON.parse(request.postData ?? '{}')
  state.diaryWrites.push({ method: request.method, table, body })
  if ('owner_id' in body) state.failures.push(`Proprietario nel corpo: ${table}`)
  if (request.method === 'POST') {
    if (!insertable[table] || Object.keys(body).some(key => !insertable[table].includes(key))) { state.failures.push(`Insert non consentito: ${table}`); return { status: 403, data: { code: '42501' } } }
    const row = { ...(table === 'meal_plans' ? { archived_at: null } : {}), ...(table === 'active_plans' ? { workout_plan_id: null, meal_plan_id: null } : {}), ...body, owner_id: owner, revision: 1 }
    if (rows.some(item => item.owner_id === owner && keys[table].every(key => String(item[key]) === String(row[key])))) return { status: 409, data: { code: '23505' } }
    rows.push(row)
    if (state.loseDiaryWrite) { state.loseDiaryWrite = false; return { failure: 'ConnectionClosed' } }
    return reply([row])
  }
  if (request.method === 'PATCH') {
    if (Object.keys(body).some(key => !updatable[table]?.includes(key))) { state.failures.push(`Update non consentito: ${table}`); return { status: 403, data: { code: '42501' } } }
    const row = own[0]
    if (!row) return reply([])
    if (body.revision !== row.revision + 1) return { status: 409, data: { code: 'PT409' } }
    Object.assign(row, body)
    if (table === 'workout_sessions' && body.status === 'completed' && !row.completed_at) row.completed_at = new Date().toISOString()
    if (state.loseDiaryWrite) { state.loseDiaryWrite = false; return { failure: 'ConnectionClosed' } }
    return reply([row])
  }
  if (request.method === 'DELETE' && table === 'workout_sessions') {
    const removed = own.filter(row => row.status === 'active')
    state.diary.workout_sessions = rows.filter(row => !removed.includes(row))
    state.diary.workout_set_logs = state.diary.workout_set_logs.filter(row => !removed.some(session => session.id === row.session_id))
    return reply(removed.map(row => ({ id: row.id })))
  }
  state.failures.push(`Operazione diario inattesa: ${request.method} ${table}`)
  return { status: 400, data: {} }
}

/**
 * Account sintetico con catalogo, programma pubblicato e seguito, piano alimentare seguito.
 * Contenuti inventati come la demo locale; nessun dato personale.
 */
export function seedFollowedPlans(state, owner, { workoutDays, meals }) {
  state.exercises ??= new Map()
  state.programTables ??= { workout_plans: [], workout_plan_versions: [], workout_days: [], workout_prescriptions: [] }
  state.diary ??= { active_plans: [], meal_plans: [], workout_sessions: [], workout_set_logs: [], meal_logs: [], diary_days: [] }
  // ID distinti per account: nessuna collisione fra le fixture di A e B.
  const uuid = n => `${owner.slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`
  let counter = 1
  const planId = uuid(counter++), versionId = uuid(counter++)
  const catalog = new Map()
  for (const day of workoutDays) for (const item of day.exercises) {
    if (catalog.has(item.exerciseId)) continue
    const id = uuid(counter++)
    const row = { id, owner_id: owner, name: item.name, variant: item.comparison?.variant ?? '', equipment: item.comparison?.equipment ?? '', load_convention: item.comparison?.loadConvention ?? 'total', load_unit: 'kg', measurement_mode: item.mode, per_side: item.comparison?.perSide ?? false, note: '', archived_at: null, revision: 1 }
    catalog.set(item.exerciseId, row)
    state.exercises.set(`${owner}:${id}`, row)
  }
  state.programTables.workout_plans.push({ id: planId, owner_id: owner, name: 'Full body', revision: 2, active_version_id: versionId, archived_at: null })
  state.programTables.workout_plan_versions.push({ id: versionId, owner_id: owner, plan_id: planId, title: 'Full body', guidance: '', version_number: 1, revision: 2, status: 'published' })
  for (const [position, day] of workoutDays.entries()) {
    const dayId = uuid(counter++)
    state.programTables.workout_days.push({ id: dayId, owner_id: owner, version_id: versionId, position, label: day.label, title: day.title, note: '' })
    for (const [index, item] of day.exercises.entries()) {
      const exercise = catalog.get(item.exerciseId)
      const [min, max] = item.target.match(/\d+/g).map(Number)
      state.programTables.workout_prescriptions.push({ id: uuid(counter++), owner_id: owner, day_id: dayId, exercise_id: exercise.id, position: index,
        exercise_snapshot: { id: exercise.id, name: exercise.name, variant: exercise.variant, equipment: exercise.equipment, load_convention: exercise.load_convention, load_unit: 'kg', mode: exercise.measurement_mode, per_side: exercise.per_side, note: '' },
        mode: item.mode, sets: item.sets, optional_sets: 0, reps_min: item.mode === 'reps' ? min : null, reps_max: item.mode === 'reps' ? (max ?? min) : null,
        duration_seconds: item.mode === 'seconds' ? min : null, rest_seconds: item.restSeconds, rir: null, rpe: null, note: item.note })
    }
  }
  const mealPlanId = uuid(counter++)
  const document = { guidance: '', days: [{ id: uuid(counter++), name: 'Giornata tipo', dayType: 'any', note: '', meals: meals.map(meal => ({
    id: uuid(counter++), name: meal.name, time: meal.timeLabel, note: meal.note, alternatives: meal.alternative ? [meal.alternative] : [], additions: [],
    foods: meal.items.map(item => { const [name, quantity = ''] = item.split(' · '); return { name, quantity } }),
  })) }] }
  state.diary.meal_plans.push({ id: mealPlanId, owner_id: owner, name: 'Piano di prova', document, archived_at: null, revision: 1 })
  state.diary.active_plans.push({ owner_id: owner, workout_plan_id: planId, meal_plan_id: mealPlanId, revision: 1 })
  return { planId, versionId, mealPlanId }
}

/** Contenuti inventati per le prove browser (stessa forma della demo locale). */
export const sampleWorkoutDays = [
  { label: 'A', title: 'Full body A', exercises: [
    { exerciseId: 'squat', name: 'Goblet squat', sets: 3, target: '8–10', mode: 'reps', restSeconds: 90, note: '', comparison: { variant: 'goblet', equipment: 'manubrio', loadConvention: 'single-dumbbell', perSide: false } },
    { exerciseId: 'row', name: 'Rematore con manubrio', sets: 3, target: '10–12', mode: 'reps', restSeconds: 90, note: 'Carico del singolo manubrio.', comparison: { variant: 'rematore-unilaterale', equipment: 'manubrio', loadConvention: 'single-dumbbell', perSide: true } },
    { exerciseId: 'press', name: 'Distensioni con manubri', sets: 3, target: '10–12', mode: 'reps', restSeconds: 90, note: '', comparison: { variant: 'panca-piana', equipment: 'manubri', loadConvention: 'single-dumbbell', perSide: false } },
    { exerciseId: 'plank', name: 'Plank', sets: 2, target: '30 secondi', mode: 'seconds', restSeconds: 60, note: '', comparison: { variant: 'plank', equipment: 'tappetino', loadConvention: 'bodyweight', perSide: false } },
  ] },
  { label: 'B', title: 'Full body B', exercises: [
    { exerciseId: 'pulley', name: 'Pulley', sets: 3, target: '10–12', mode: 'reps', restSeconds: 90, note: '', comparison: { variant: 'presa-neutra', equipment: 'pulley-1', loadConvention: 'total', perSide: false } },
  ] },
]
export const sampleMeals = [
  { name: 'Colazione', timeLabel: 'Per iniziare', items: ['Yogurt bianco · 150 g', 'Fiocchi di avena · 40 g'], alternative: 'Pane e ricotta', note: '' },
  { name: 'Pranzo', timeLabel: 'Una pausa per te', items: ['Riso · 80 g', 'Ceci cotti · 120 g'], alternative: 'Cous cous al posto del riso', note: '' },
  { name: 'Spuntino', timeLabel: 'Tra un impegno e l’altro', items: ['Frutta fresca · 1 porzione'], alternative: '', note: '' },
  { name: 'Cena', timeLabel: 'Il momento di rallentare', items: ['Uova · 2', 'Pane · 60 g'], alternative: '', note: '' },
]
