// Risposte Auth sintetiche intercettate tramite CDP, senza contatti col cloud.
// Non sono una prova RLS o un sostituto dei test HTTP contro Supabase reale.
import { diaryFixture, diaryPaths } from './diary-fixture.mjs'
import { programsFixture } from './programs-fixture.mjs'
import { importFlowFixture, importFlowPaths } from './import-flow-fixture.mjs'
import { loadEnv } from 'vite'
export const fixtureSupabaseOrigin = new URL(loadEnv('development', process.cwd(), 'VITE_').VITE_SUPABASE_URL).origin
export const fixtureStorageKey = `sb-${new URL(fixtureSupabaseOrigin).hostname.split('.')[0]}-auth-token`
export const fixturePassword = 'Browser-fixture-only-123!'
export function fixtureSession(account = 'a') {
  const id = account === 'a' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222'
  const now = Math.floor(Date.now() / 1000)
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  return {
    access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: id, role: 'authenticated', aud: 'authenticated', exp: now + 3600, iat: now })}.browser-fixture`,
    refresh_token: `browser-refresh-${account}`, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600,
    user: { id, aud: 'authenticated', role: 'authenticated', email: `${account}@example.invalid`, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
  }
}

export async function installAuthFixture(rawSend, socket, appOrigin, state = {}) {
  // Una richiesta annullata da reload/navigazione non esiste più quando arriva la risposta
  // simulata (CDP -32602): non è un errore dell'app.
  const send = (method, params) => rawSend(method, params).catch(error => {
    if (method.startsWith('Fetch.') && String(error?.message).includes('32602')) return undefined
    throw error
  })
  Object.assign(state, { failLogout: state.failLogout ?? false, requests: state.requests ?? [], failures: state.failures ?? [], settings: state.settings ?? new Map(), exercises: state.exercises ?? new Map(), sharedExercises: state.sharedExercises ?? new Map(), exerciseWrites: state.exerciseWrites ?? [] })
  const handle = async params => {
    const { requestId, request } = params
    const url = new URL(request.url)
    state.requests.push(`${request.method} ${url.pathname}`)
    const headers = [
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Supabase-Api-Version', value: '2024-01-01' },
      { name: 'Access-Control-Expose-Headers', value: 'X-Supabase-Api-Version' },
      { name: 'Access-Control-Allow-Origin', value: appOrigin },
      { name: 'Access-Control-Allow-Headers', value: '*' },
      { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PATCH,PUT,DELETE,OPTIONS' },
    ]
    let status = 200, data = {}
    if (request.method === 'OPTIONS') status = 204
    else if (url.pathname === '/auth/v1/token') {
      const body = JSON.parse(request.postData ?? '{}')
      if (url.searchParams.get('grant_type') === 'refresh_token') data = fixtureSession(body.refresh_token?.endsWith('-b') ? 'b' : 'a')
      else if (body.password === fixturePassword) data = fixtureSession(body.email?.startsWith('b@') ? 'b' : 'a')
      else { status = 400; data = { code: 'invalid_credentials', message: 'Invalid login credentials' } }
    } else if (url.pathname === '/auth/v1/logout') {
      status = state.failLogout ? 503 : 204
      data = { code: 'unexpected_failure' }
    } else if (url.pathname === '/auth/v1/user') data = fixtureSession().user
    else if (url.pathname === '/rest/v1/user_settings') {
      const authorization = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
      const owner = JSON.parse(Buffer.from(authorization?.split('.')[1] ?? '', 'base64url').toString()).sub
      const row = state.settings.get(owner)
      if (state.failSettingsReads && request.method === 'GET' || state.failSettingsWrites && request.method !== 'GET') {
        await send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }); return
      }
      if (request.method === 'GET') {
        if (url.searchParams.get('owner_id') !== `eq.${owner}`) state.failures.push('Filtro proprietario mancante')
        data = row ? [row] : []
      } else if (request.method === 'POST' || request.method === 'PATCH') {
        const fields = JSON.parse(request.postData ?? '{}')
        if ('owner_id' in fields) state.failures.push('Proprietario inviato nel corpo')
        if (request.method === 'PATCH' && url.searchParams.get('owner_id') !== `eq.${owner}`) state.failures.push('Filtro update proprietario mancante')
        if (request.method === 'POST' && row) { status = 409; data = { code: '23505' } }
        else if (request.method === 'PATCH' && fields.revision !== row?.revision + 1) { status = 409; data = { code: 'PT409' } }
        else {
          data = { owner_id: owner, ...fields, revision: request.method === 'POST' ? 1 : fields.revision }
          state.settings.set(owner, data)
          if (state.loseSettingsResponse) {
            state.loseSettingsResponse = false
            await send('Fetch.failRequest', { requestId, errorReason: 'ConnectionClosed' }); return
          }
        }
      } else { status = 400; state.failures.push('Operazione preferenze inattesa') }
    }
    else if (url.pathname === '/rest/v1/shared_exercises') {
      if (request.method !== 'GET') { status = 403; data = { code: '42501' }; state.failures.push('Scrittura del catalogo comune inattesa') }
      else data = [...state.sharedExercises.values()].filter(row => !url.searchParams.get('id')?.startsWith('gt.') || row.id > url.searchParams.get('id').slice(3))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(url.searchParams.get('limit') ?? 1000))
    }
    else if (url.pathname === '/rest/v1/rpc/adopt_shared_exercise') {
      const authorization = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
      const owner = JSON.parse(Buffer.from(authorization?.split('.')[1] ?? '', 'base64url').toString()).sub
      const template = state.sharedExercises.get(JSON.parse(request.postData ?? '{}').p_template_id)
      if (request.method !== 'POST' || !template) { status = 400; data = { code: '22023' } }
      else {
        let row = [...state.exercises.values()].find(item => item.owner_id === owner && item.source_template_id === template.id)
        if (!row) {
          row = { ...template, id: crypto.randomUUID(), owner_id: owner, source_template_id: template.id, revision: 1, archived_at: null }
          state.exercises.set(`${owner}:${row.id}`, row)
        }
        data = row.id
      }
    }
    else if (url.pathname === '/rest/v1/exercises') {
      const authorization = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1]
      const owner = JSON.parse(Buffer.from(authorization?.split('.')[1] ?? '', 'base64url').toString()).sub
      if (state.failExerciseReads && request.method === 'GET' || state.failExerciseWrites && request.method !== 'GET') {
        await send('Fetch.failRequest', { requestId, errorReason: 'InternetDisconnected' }); return
      }
      if (request.method !== 'POST' && url.searchParams.get('owner_id') !== `eq.${owner}`) state.failures.push('Filtro esercizi proprietario mancante')
      const idFilter = url.searchParams.get('id')
      if (request.method === 'GET') {
        data = [...state.exercises.values()].filter(row => row.owner_id === owner
          && (!idFilter || (idFilter.startsWith('eq.') ? row.id === idFilter.slice(3) : row.id > idFilter.slice(3))))
          .sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(url.searchParams.get('limit') ?? 1000))
      } else if (request.method === 'POST' || request.method === 'PATCH') {
        const fields = JSON.parse(request.postData ?? '{}')
        state.exerciseWrites.push({ method: request.method, fields })
        if ('owner_id' in fields) state.failures.push('Proprietario esercizio inviato nel corpo')
        const id = request.method === 'POST' ? fields.id : idFilter?.slice(3)
        const key = `${owner}:${id}`, row = state.exercises.get(key)
        if (request.method === 'POST' && row) { status = 409; data = { code: '23505' } }
        else if (request.method === 'PATCH' && row && fields.revision !== row.revision + 1) { status = 409; data = { code: 'PT409' } }
        else if (request.method === 'PATCH' && !row) data = []
        else {
          if (request.method === 'PATCH' && Object.keys(fields).some(key => !['name', 'note', 'archived_at', 'revision'].includes(key))) state.failures.push('Update identità esercizio inatteso')
          data = { ...row, ...fields, owner_id: owner, revision: request.method === 'POST' ? 1 : fields.revision }
          state.exercises.set(key, data)
          if (state.loseExerciseResponse) {
            state.loseExerciseResponse = false
            await send('Fetch.failRequest', { requestId, errorReason: 'ConnectionClosed' }); return
          }
        }
      } else { status = 400; state.failures.push('Operazione esercizi inattesa') }
    }
    else if (diaryPaths.includes(url.pathname)) {
      const result = diaryFixture(request, url, state)
      if (result.failure) { await send('Fetch.failRequest', { requestId, errorReason: result.failure }); return }
      status = result.status; data = result.data
    }
    else if (url.pathname.startsWith('/rest/v1/workout_') || ['/rest/v1/rpc/save_workout_draft', '/rest/v1/rpc/publish_workout_version', '/rest/v1/rpc/save_workout_revision'].includes(url.pathname)) {
      const result = programsFixture(request, url, state)
      if (result.failure) { await send('Fetch.failRequest', { requestId, errorReason: result.failure }); return }
      status = result.status; data = result.data
    }
    else if (importFlowPaths.includes(url.pathname)) {
      const result = await importFlowFixture(request, url, state)
      if (result.failure) { await send('Fetch.failRequest', { requestId, errorReason: result.failure }); return }
      status = result.status; data = result.data
    }
    else { status = 400; state.failures.push(`Richiesta inattesa: ${request.method} ${url.pathname}`) }
    await send('Fetch.fulfillRequest', { requestId, responseCode: status, responseHeaders: headers,
      body: status === 204 ? '' : Buffer.from(JSON.stringify(data)).toString('base64') })
  }
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Fetch.requestPaused') void handle(message.params).catch(error => state.failures.push(`Intercettazione Auth non riuscita: ${error?.message ?? ''}`))
  })
  // Blocca e simula ogni richiesta esterna: nessuna credenziale sintetica inviata a Supabase.
  await send('Fetch.enable', { patterns: [{ urlPattern: 'https://*' }, { urlPattern: 'http://127.0.0.1:54321/*' }, { urlPattern: 'http://localhost:54321/*' }] })
  return state
}
