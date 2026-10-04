// Lettura incrementale del diario contro lo stack Supabase locale (PostgREST e RLS reali):
// filtro updated_at, cursore, sedute attive. Crea un account sintetico e lo elimina alla fine.
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { readLocalStatus } from './lib/local-supabase.mjs'
import { createDiaryTransport, serverTime } from '../src/persistence/diary-repository.ts'

const config = readLocalStatus()
assert.match(config.apiUrl, /127\.0\.0\.1|localhost/)
const admin = createClient(config.apiUrl, config.adminKey, { auth: { persistSession: false } })
const email = `incr-${randomUUID()}@example.invalid`, password = `Aa1!${randomBytes(18).toString('base64url')}`
const made = await admin.auth.admin.createUser({ email, password, email_confirm: true })
assert.ok(made.data.user, 'utente sintetico')
const owner = made.data.user.id
try {
  const client = createClient(config.apiUrl, config.publicKey, { auth: { persistSession: false } })
  const login = await client.auth.signInWithPassword({ email, password })
  assert.ok(login.data.session, 'login')
  const transport = createDiaryTransport(client, owner)
  const signal = () => AbortSignal.timeout(10_000)
  await transport.insert('diary_days', { diary_date: '2026-10-01', day_type: 'training' }, signal())
  await transport.insert('diary_days', { diary_date: '2026-10-02', day_type: 'rest' }, signal())
  const full = await transport.loadAll(signal())
  assert.ok(full.cursor && Number.isFinite(serverTime(full.cursor)), `cursore dalla lettura completa: ${full.cursor}`)
  assert.equal(Object.keys(full.data.dayTypes).length, 2)
  await new Promise(resolve => setTimeout(resolve, 1200))
  const updated = await transport.update('diary_days', { diary_date: '2026-10-01' }, { day_type: 'rest' }, 2, signal())
  assert.ok(updated, 'aggiornamento')
  // Cursore esatto (senza margine): torna solo la riga cambiata dopo.
  const exact = await transport.loadChanges(full.cursor, signal())
  assert.deepEqual(exact.days.map(row => row.diary_date), ['2026-10-01'], 'solo la riga modificata')
  assert.ok(exact.cursor && serverTime(exact.cursor) > serverTime(full.cursor), 'cursore avanzato')
  assert.deepEqual(exact.activeSessionIds, [])
  assert.deepEqual(exact.counts, { sessions: 0, sets: 0, meals: 0, days: 2 }, 'conteggi reali per tabella (RLS)')
  const future = await transport.loadChanges(new Date(Date.now() + 3600_000).toISOString(), signal())
  assert.equal(future.days.length + future.meals.length + future.sessions.length + future.sets.length, 0, 'nulla dopo il futuro')
  console.log('PASS lettura incrementale su PostgREST locale: filtro updated_at, cursore, sedute attive, conteggi')
} finally {
  await admin.auth.admin.deleteUser(owner)
  console.log('fixture eliminata')
}
