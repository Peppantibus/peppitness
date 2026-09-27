import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Session, SupabaseClient, AuthChangeEvent } from '@supabase/supabase-js'
import { readSupabaseConfig } from '../src/auth/config.ts'
import { authErrorMessage } from '../src/auth/errors.ts'
import { observeSession } from '../src/auth/session.ts'
import type { AuthState } from '../src/auth/session.ts'

const url = 'https://sample-project.supabase.co'
const publicKey = 'sb_publishable_fixture'
const session = { user: { id: 'fixture-a' }, access_token: 'test-only' } as Session

test('configurazione assente distinta da incompleta; destinazione limitata a Supabase o al locale', () => {
  assert.equal(readSupabaseConfig({}), null)
  assert.deepEqual(readSupabaseConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: publicKey }), { url, publishableKey: publicKey })
  for (const badUrl of ['http://sample-project.supabase.co', 'https://example.com', 'https://sample-project.supabase.co.evil.example', `${url}/x`, `${url}?key=private`, 'http://user:pass@localhost:54321', 'http://localhost:54322']) {
    assert.throws(() => readSupabaseConfig({ VITE_SUPABASE_URL: badUrl, VITE_SUPABASE_PUBLISHABLE_KEY: publicKey }))
  }
  assert.throws(() => readSupabaseConfig({ VITE_SUPABASE_URL: url }))
})

test('chiavi privilegiate respinte senza ripeterle nel messaggio', () => {
  for (const key of ['sb_secret_private_fixture', 'eyJ.privileged-fixture.signature']) {
    assert.throws(() => readSupabaseConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key }), error => {
      return error instanceof Error && !error.message.includes(key)
    })
  }
})

test('errori Auth mostrano solo messaggi controllati', () => {
  assert.equal(authErrorMessage({ code: 'invalid_credentials', message: 'private-value' }), 'Email o password non corrette.')
  assert.ok(!authErrorMessage({ code: 'unknown', message: 'private-value' }).includes('private-value'))
  assert.ok(!authErrorMessage(new Error('private-value')).includes('private-value'))
})

function fixture() {
  let callback: (event: AuthChangeEvent, value: Session | null) => void = () => undefined
  let complete!: (value: { data: { session: Session | null }; error: Error | null }) => void
  let unsubscribed = false
  const pending = new Promise(resolve => { complete = resolve })
  const client = { auth: {
    onAuthStateChange: (listener: typeof callback) => { callback = listener; return { data: { subscription: { unsubscribe: () => { unsubscribed = true } } } } },
    getSession: () => pending,
  } } as unknown as Pick<SupabaseClient, 'auth'>
  const states: AuthState[] = []
  const stop = observeSession(client, value => states.push(value))
  return { states, stop, complete, emit: (event: AuthChangeEvent, value: Session | null) => callback(event, value), isUnsubscribed: () => unsubscribed }
}

test('sessione iniziale ripristinata e rinnovo aggiornato', async () => {
  const f = fixture()
  f.complete({ data: { session }, error: null }); await Promise.resolve()
  assert.equal(f.states[0]?.status, 'signed-in')
  f.emit('TOKEN_REFRESHED', { ...session, access_token: 'renewed-fixture' })
  assert.equal(f.states[1]?.session?.user.id, session.user.id)
  f.stop()
})

test('logout durante bootstrap: una risposta tardiva non riapre l’account', async () => {
  const f = fixture()
  f.emit('SIGNED_OUT', null)
  f.complete({ data: { session }, error: null }); await Promise.resolve()
  assert.deepEqual(f.states, [{ status: 'signed-out', session: null }])
  f.stop()
})

test('smontaggio: nessun aggiornamento da promise o callback tardive', async () => {
  const f = fixture()
  f.stop(); f.emit('SIGNED_IN', session)
  f.complete({ data: { session }, error: null }); await Promise.resolve()
  assert.equal(f.isUnsubscribed(), true)
  assert.deepEqual(f.states, [])
})

test('errore iniziale non apre l’app senza sessione', async () => {
  const f = fixture()
  f.complete({ data: { session: null }, error: new Error('storage failure') }); await Promise.resolve()
  assert.deepEqual(f.states, [{ status: 'error', session: null }])
  f.stop()
})
