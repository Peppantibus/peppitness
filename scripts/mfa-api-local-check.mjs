// SA-03: prova HTTP reale (Auth + PostgREST locali) dell'enforcement MFA aal2.
// Solo stack locale; fixture sintetiche eliminate al termine.
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readLocalStatus, publicErrorCode } from './lib/local-supabase.mjs'

// MFA_TARGET=cloud: stesse prove sul progetto collegato, solo con account sintetici
// creati e poi eliminati. La chiave amministrativa resta in memoria e serve soltanto
// a creare/eliminare le fixture Auth.
function cloudConfig() {
  const env = Object.fromEntries(readFileSync('.env.local', 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))
  const ref = readFileSync('supabase/.temp/project-ref', 'utf8').trim()
  const apiUrl = env.VITE_SUPABASE_URL.replace(/\/$/, '')
  if (apiUrl !== `https://${ref}.supabase.co`) throw new Error('Progetto configurato diverso da quello collegato')
  const run = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['supabase', 'projects', 'api-keys', '--project-ref', ref, '-o', 'json'], { encoding: 'utf8', shell: process.platform === 'win32' })
  const raw = run.stdout; const list = JSON.parse(raw.slice(Math.min(...['[', '{'].map(c => raw.indexOf(c)).filter(i => i >= 0))))
  const key = list.find(k => k.name === 'service_role' || k.type === 'secret')
  if (typeof key?.api_key !== 'string') throw new Error('Chiave amministrativa non disponibile')
  return { apiUrl, publicKey: env.VITE_SUPABASE_PUBLISHABLE_KEY, adminKey: key.api_key }
}

let config
let checks = 0
const created = new Set()
function check(condition, label) { if (!condition) throw new Error(label); checks++; console.log(`PASS ${label}`) }

async function request(path, { method = 'GET', body, token, admin = false } = {}) {
  if (admin && !path.startsWith('/auth/v1/admin/users')) throw new Error('Admin non ammesso')
  const key = admin ? config.adminKey : config.publicKey
  const headers = { apikey: key, 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  else if (admin && key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`
  const response = await fetch(`${config.apiUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000) })
  const raw = await response.text()
  let data
  try { data = raw ? JSON.parse(raw) : null } catch { data = null }
  return { ok: response.ok, status: response.status, data }
}

function base32Decode(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of text.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0')
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  return Buffer.from(bytes)
}
function totp(secret) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = digest[digest.length - 1] & 15
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000
  return String(value).padStart(6, '0')
}

async function fixture(label) {
  const email = `peppitness-mfa-${label}-${randomUUID()}@peppitness.local`
  const password = `Aa1!${randomBytes(24).toString('base64url')}`
  const made = await request('/auth/v1/admin/users', { method: 'POST', admin: true, body: { email, password, email_confirm: true } })
  check(made.ok, `Creazione account ${label}`)
  created.add(made.data.id)
  const login = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } })
  check(login.ok, `Login ${label}`)
  return { id: made.data.id, token: login.data.access_token, email, password }
}

async function run() {
  config = process.env.MFA_TARGET === 'cloud' ? cloudConfig() : readLocalStatus()
  const a = await fixture('a')
  const b = await fixture('b')
  const settings = token => request('/rest/v1/user_settings?select=owner_id', { token })
  const rpc = (token, name, body) => request(`/rest/v1/rpc/${name}`, { method: 'POST', token, body })
  const planId = randomUUID()

  check((await rpc(a.token, 'is_mfa_satisfied', {})).data === true, 'Senza fattori e flag spento: aal1 soddisfa')
  check((await rpc(a.token, 'delete_meal_plans', { p_plan_id: planId })).ok, 'Senza fattori: RPC ammessa')

  const enroll = await request('/auth/v1/factors', { method: 'POST', token: a.token, body: { factor_type: 'totp', friendly_name: 'test' } })
  check(enroll.ok && Boolean(enroll.data.totp?.secret), 'Enrollment TOTP')
  check((await rpc(a.token, 'is_mfa_satisfied', {})).data === true, 'Fattore non verificato: nessun requisito')
  const challenge = await request(`/auth/v1/factors/${enroll.data.id}/challenge`, { method: 'POST', token: a.token, body: {} })
  check(challenge.ok, 'Challenge TOTP')
  const wrong = await request(`/auth/v1/factors/${enroll.data.id}/verify`, { method: 'POST', token: a.token, body: { challenge_id: challenge.data.id, code: '000000' } })
  check(!wrong.ok, 'Codice errato respinto')
  const challenge2 = await request(`/auth/v1/factors/${enroll.data.id}/challenge`, { method: 'POST', token: a.token, body: {} })
  const verified = await request(`/auth/v1/factors/${enroll.data.id}/verify`, { method: 'POST', token: a.token, body: { challenge_id: challenge2.data.id, code: totp(enroll.data.totp.secret) } })
  check(verified.ok && typeof verified.data.access_token === 'string', 'Codice corretto: sessione aal2')
  const aal2 = verified.data.access_token

  // Il vecchio token aal1 di A resta valido come JWT ma non basta più ai dati.
  check((await rpc(a.token, 'is_mfa_satisfied', {})).data === false, 'Con fattore verificato: aal1 non soddisfa')
  const aal1Read = await settings(a.token)
  check(aal1Read.ok && aal1Read.data.length === 0, 'aal1 di A: lettura propri dati vuota')
  const aal1Insert = await request('/rest/v1/user_settings', { method: 'POST', token: a.token, body: { display_name: 'x', workout_weekdays: [1] } })
  check(!aal1Insert.ok, 'aal1 di A: scrittura diretta negata')
  const aal1Rpc = await rpc(a.token, 'delete_meal_plans', { p_plan_id: planId })
  check(!aal1Rpc.ok && publicErrorCode(aal1Rpc.data) === '42501', 'aal1 di A: RPC definer negata (42501)')
  const aal1Adopt = await rpc(a.token, 'adopt_shared_exercise', { p_template_id: planId })
  check(!aal1Adopt.ok, 'aal1 di A: RPC invoker negata')

  check((await rpc(aal2, 'is_mfa_satisfied', {})).data === true, 'aal2 di A soddisfa')
  check((await rpc(aal2, 'delete_meal_plans', { p_plan_id: planId })).ok, 'aal2 di A: RPC ammessa')
  const own = await request('/rest/v1/user_settings', { method: 'POST', token: aal2, body: { display_name: 'A', workout_weekdays: [1] } })
  check(own.ok, 'aal2 di A: scrittura propria ammessa')
  const read2 = await settings(aal2)
  check(read2.ok && read2.data.length === 1 && read2.data[0].owner_id === a.id, 'aal2 di A: legge solo i propri dati')
  const bRead = await settings(b.token)
  check(bRead.ok && bRead.data.length === 0, 'B (senza fattori) non vede dati di A')
  const spoof = await request('/rest/v1/user_settings', { method: 'POST', token: aal2, body: { owner_id: b.id, display_name: 'forged', workout_weekdays: [1] } })
  check(!spoof.ok, 'aal2 di A non scrive per conto di B')

  const refreshed = await request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: verified.data.refresh_token } })
  check(refreshed.ok && (await rpc(refreshed.data.access_token, 'is_mfa_satisfied', {})).data === true, 'Rinnovo mantiene aal2')

  // Nuovo accesso (aal1) di un account con fattore: l'interfaccia deve poter leggere i fattori e superare la challenge.
  const relogin = await request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: a.email, password: a.password } })
  check(relogin.ok, 'Nuovo login di A (aal1)')
  const me = await request('/auth/v1/user', { token: relogin.data.access_token })
  check(me.ok && me.data.factors?.some(f => f.status === 'verified' && f.factor_type === 'totp'), 'aal1 legge i propri fattori (listFactors)')
  const ch = await request(`/auth/v1/factors/${enroll.data.id}/challenge`, { method: 'POST', token: relogin.data.access_token, body: {} })
  check(ch.ok, 'aal1 apre la challenge')
  const ver = await request(`/auth/v1/factors/${enroll.data.id}/verify`, { method: 'POST', token: relogin.data.access_token, body: { challenge_id: ch.data.id, code: totp(enroll.data.totp.secret) } })
  check(ver.ok && typeof ver.data.access_token === 'string', 'aal1 supera la challenge con il codice')

  const anon = await request('/rest/v1/user_settings?select=owner_id')
  check(!anon.ok || (Array.isArray(anon.data) && anon.data.length === 0), 'Anonimo: nessun dato')
  check((await request('/rest/v1/rpc/is_mfa_satisfied', { method: 'POST', body: {} })).ok === false, 'Anonimo: stato MFA non chiamabile')
}

let failed = false
try { await run() } catch (error) { failed = true; console.error(`FAIL ${error.message}`) }
let cleaned = 0
for (const id of created) {
  const response = await request(`/auth/v1/admin/users/${id}`, { method: 'DELETE', admin: true }).catch(() => ({ ok: false }))
  if (response.ok) cleaned++; else { failed = true; console.error(`FAIL pulizia ${id}`) }
}
console.log(`Result: ${failed ? 'FAIL' : 'PASS'}; controlli: ${checks}; fixture eliminate: ${cleaned}/${created.size}.`)
process.exitCode = failed ? 1 : 0
