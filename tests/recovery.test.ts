import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readRecoveryLink } from '../src/auth/recovery-url.ts'

test('recovery accepts only one explicit recovery hash token, independent of PKCE/device', () => {
  assert.deepEqual(readRecoveryLink('#/recupero?token_hash=synthetic_hash_1234567890&type=recovery'), { active: true, token: 'synthetic_hash_1234567890' })
  for (const hash of ['#/recupero', '#/recupero?type=invite&token_hash=synthetic_hash_1234567890', '#/recupero?type=recovery&token_hash=a&token_hash=b', '#access_token=synthetic&refresh_token=synthetic', '#error=otp_expired', '#/dieta?token_hash=synthetic_hash_1234567890']) {
    assert.equal(readRecoveryLink(hash).active, true)
    assert.equal(readRecoveryLink(hash).token, null)
  }
  assert.equal(readRecoveryLink('#/dieta', '?code=synthetic').active, true)
  assert.equal(readRecoveryLink('#/scheda').active, false)
})

test('standard callback accepts only a complete, unambiguous recovery session in the fragment', () => {
  const payload = 'access_token=synthetic_access_1234567890&refresh_token=synthetic_refresh_12345&token_type=bearer&type=recovery'
  assert.ok(readRecoveryLink(`#${payload}`).credentials)
  assert.ok(readRecoveryLink(`#/recupero&${payload}`).credentials)
  assert.ok(readRecoveryLink(`#/recupero?${payload}`).credentials)
  assert.ok(readRecoveryLink(`#/recupero#${payload}`).credentials)
  for (const invalid of [payload.replace('type=recovery', 'type=magiclink'), `${payload}&type=recovery`, payload.replace('refresh_token=', 'other='), `${payload}&access_token=duplicate`]) {
    assert.equal(readRecoveryLink(`#${invalid}`).credentials, undefined)
    assert.equal(readRecoveryLink(`#${invalid}`).active, true)
  }
})
