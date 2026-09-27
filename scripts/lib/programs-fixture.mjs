// Modello HTTP sintetico per i test frontend. Non verifica transazioni/RLS PostgreSQL.
export function programsFixture(request, url, state) {
  state.programTables ??= { workout_plans: [], workout_plan_versions: [], workout_days: [], workout_prescriptions: [] }
  state.programWrites ??= []
  const authorization = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
  const owner = JSON.parse(Buffer.from(authorization?.split('.')[1] ?? '', 'base64url').toString()).sub
  if (request.method === 'GET') {
    if (state.failProgramReads) return { failure: 'InternetDisconnected' }
    if (url.searchParams.get('owner_id') !== `eq.${owner}`) state.failures.push('Filtro programmi proprietario mancante')
    const table = url.pathname.split('/').at(-1)
    const rows = state.programTables[table]
    if (!rows) { state.failures.push('Tabella programmi inattesa'); return { status: 400, data: {} } }
    const data = rows.filter(row => row.owner_id === owner && [...url.searchParams.entries()].every(([key, value]) => {
      if (['select', 'order', 'limit'].includes(key)) return true
      if (value.startsWith('eq.')) return row[key] === value.slice(3)
      if (value.startsWith('gt.')) return row[key] > value.slice(3)
      return false
    })).sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(url.searchParams.get('limit') ?? 1000))
    return { status: 200, data }
  }
  if (state.failProgramWrites) return { failure: 'InternetDisconnected' }
  if (request.method === 'PATCH' && url.pathname.endsWith('/workout_plans')) {
    // Solo inizio e durata del ciclo, con revisione letta + 1 come nel database.
    const body = JSON.parse(request.postData ?? '{}')
    state.programWrites.push({ method: 'cycle', body })
    if (Object.keys(body).some(key => !['cycle_start', 'cycle_weeks', 'revision'].includes(key))) { state.failures.push('Update programma inatteso'); return { status: 403, data: { code: '42501' } } }
    const plan = state.programTables.workout_plans.find(row => row.owner_id === owner && `eq.${row.id}` === url.searchParams.get('id'))
    if (!plan) return { status: 200, data: [] }
    if (body.revision !== plan.revision + 1) return { status: 409, data: { code: 'PT409' } }
    Object.assign(plan, body)
    return { status: 200, data: [plan] }
  }
  if (request.method !== 'POST' || !url.pathname.includes('/rpc/')) { state.failures.push('Scrittura diretta programmi inattesa'); return { status: 403, data: { code: '42501' } } }
  const body = JSON.parse(request.postData ?? '{}'), method = url.pathname.split('/').at(-1)
  state.programWrites.push({ method, body })
  if ('owner_id' in body) state.failures.push('Owner esplicito nella RPC')
  const tables = structuredClone(state.programTables)
  const find = (table, id) => tables[table].find(row => row.id === id && row.owner_id === owner)
  let version = find('workout_plan_versions', body.p_version_id)
  if (method === 'save_workout_draft') {
    if (state.rejectProgramSave) { state.rejectProgramSave = false; return { status: 400, data: { code: '23514' } } }
    if ((version?.revision ?? 0) !== body.p_expected_revision) return { status: 409, data: { code: 'PT409' } }
    if (version?.status === 'published') return { status: 500, data: { code: '55000' } }
    let plan = find('workout_plans', body.p_plan_id)
    if (!plan) { plan = { id: body.p_plan_id, owner_id: owner, name: body.p_title, revision: 1, active_version_id: null, archived_at: null }; tables.workout_plans.push(plan) }
    if (plan.archived_at) return { status: 500, data: { code: '55000' } }
    if (!version) {
      version = { id: body.p_version_id, owner_id: owner, plan_id: plan.id, version_number: Math.max(0, ...tables.workout_plan_versions.filter(row => row.plan_id === plan.id).map(row => row.version_number)) + 1, status: 'draft', revision: 0 }
      tables.workout_plan_versions.push(version)
    }
    Object.assign(version, { title: body.p_title, guidance: body.p_guidance, revision: version.revision + 1 })
    const oldDays = tables.workout_days.filter(day => day.version_id === version.id).map(day => day.id)
    tables.workout_days = tables.workout_days.filter(day => day.version_id !== version.id)
    tables.workout_prescriptions = tables.workout_prescriptions.filter(item => !oldDays.includes(item.day_id))
    for (const [position, day] of body.p_days.entries()) {
      tables.workout_days.push({ id: day.id, owner_id: owner, version_id: version.id, position, label: day.label, title: day.title, note: day.note })
      for (const [exercisePosition, item] of day.exercises.entries()) {
        const exercise = state.exercises.get(`${owner}:${item.exercise_id}`)
        if (!exercise || exercise.archived_at) return { status: 403, data: { code: '42501' } }
        if ('exercise_snapshot' in item) state.failures.push('Snapshot client inviato nella RPC')
        const snapshot = Object.fromEntries(['id', 'name', 'variant', 'equipment', 'load_convention', 'load_unit', 'per_side', 'note'].map(key => [key, exercise[key]]))
        snapshot.mode = exercise.measurement_mode
        tables.workout_prescriptions.push({ ...item, owner_id: owner, day_id: day.id, position: exercisePosition, exercise_snapshot: snapshot, mode: exercise.measurement_mode })
      }
    }
  } else if (method === 'publish_workout_version') {
    if (!version) return { status: 403, data: { code: '42501' } }
    const plan = find('workout_plans', version.plan_id)
    if (version.revision !== body.p_expected_revision || plan.revision !== body.p_expected_plan_revision) return { status: 409, data: { code: 'PT409' } }
    if (version.status !== 'draft') return { status: 500, data: { code: '55000' } }
    const days = tables.workout_days.filter(day => day.version_id === version.id)
    if (!days.length || days.some(day => !tables.workout_prescriptions.some(item => item.day_id === day.id))) return { status: 400, data: { code: '23514' } }
    version.status = 'published'; version.revision++; plan.revision++; plan.active_version_id = version.id
  } else { state.failures.push('RPC inattesa'); return { status: 400, data: {} } }
  state.programTables = tables
  const lost = method === 'save_workout_draft' ? 'loseProgramSave' : 'loseProgramPublish'
  if (state[lost]) { state[lost] = false; return { failure: 'ConnectionClosed' } }
  return { status: 200, data: [version] }
}
