import test from 'node:test'
import assert from 'node:assert/strict'
import { localApiPort, localApiUrl, parseLocalStatus, publicErrorCode } from '../scripts/lib/local-supabase.mjs'

test('runner amministrativo limitato alla porta dello stack locale', () => {
  assert.equal(localApiUrl('http://127.0.0.1:54321'), 'http://127.0.0.1:54321')
  assert.equal(localApiUrl('http://localhost:54321/'), 'http://127.0.0.1:54321')
  for (const url of ['https://example.supabase.co', 'http://127.0.0.1:54322', 'http://user:pass@localhost:54321',
    'http://localhost.evil.test:54321', 'http://localhost:54321/remote', 'http://localhost:54321/?target=remote',
    'http://localhost:54321/#remote', 'https://localhost:54321', undefined]) assert.throws(() => localApiUrl(url))
})
test('porta alternativa solo numerica e sempre sul loopback', () => {
  assert.equal(localApiPort({}), '54321')
  assert.equal(localApiPort({ PEPPITNESS_LOCAL_API_PORT: '55321' }), '55321')
  for (const value of ['0', 'abc', '99999', '55321/remote', '']) assert.equal(localApiPort({ PEPPITNESS_LOCAL_API_PORT: value }), '54321')
  assert.equal(localApiUrl('http://127.0.0.1:55321', '55321'), 'http://127.0.0.1:55321')
  assert.throws(() => localApiUrl('https://example.supabase.co:55321', '55321'))
  assert.throws(() => localApiUrl('http://127.0.0.1:54321', '55321'))
})
test('stato incompleto o remoto rifiutato senza riportarne credenziali', () => {
  for (const input of ['invalid-secret-value', 'null', '{}', JSON.stringify({ API_URL: 'https://example.supabase.co', SECRET_KEY: 'private-value' })]) {
    assert.throws(() => parseLocalStatus(input), error => !error.message.includes('private-value') && !error.message.includes('invalid-secret-value'))
  }
})
test('stato CLI locale con chiavi legacy o publishable/secret riconosciuto', () => {
  for (const keys of [{ ANON_KEY: 'public-fixture', SERVICE_ROLE_KEY: 'admin-fixture' }, { PUBLISHABLE_KEY: 'public-fixture', SECRET_KEY: 'admin-fixture' }]) {
    assert.deepEqual(parseLocalStatus(JSON.stringify({ API_URL: 'http://localhost:54321', ...keys })), {
      apiUrl: 'http://127.0.0.1:54321', publicKey: 'public-fixture', adminKey: 'admin-fixture', publishableKey: keys.PUBLISHABLE_KEY,
    })
  }
})
test('diagnostica stampa soltanto codici errore delimitati', () => {
  assert.equal(publicErrorCode({ code: '42501', message: 'contenuto privato' }), '42501')
  assert.equal(publicErrorCode({ error_code: 'signup_disabled' }), 'signup_disabled')
  assert.equal(publicErrorCode({ code: 'valore con dati privati' }), 'non_disponibile')
  assert.equal(publicErrorCode(null), 'non_disponibile')
})
