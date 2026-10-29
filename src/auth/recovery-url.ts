export const recoveryHash = '#/recupero'
export const forgotHash = '#/password-dimenticata'

/** Il frammento non viene inviato al server statico né nel Referer. */
export type RecoveryCredentials = { access_token: string; refresh_token: string }
export function readRecoveryLink(hash: string, search = ''): { active: boolean; token: string | null; credentials?: RecoveryCredentials } {
  const [path, query = ''] = hash.split('?')
  const params = new URLSearchParams(query)
  const sensitive = /(?:^|[?#&])(?:access_token|refresh_token|token_hash|error|error_code|error_description|code)=/.test(hash + search)
  const active = path === recoveryHash || sensitive
  const tokens = params.getAll('token_hash')
  const token = path === recoveryHash && params.getAll('type').length === 1 && params.get('type') === 'recovery' && tokens.length === 1
    && /^[a-zA-Z0-9_-]{20,256}$/.test(tokens[0] ?? '') ? tokens[0]! : null
  // Il template standard verifica su Supabase e restituisce una sessione nel frammento.
  // Non interferisce con la sessione dell'app: viene importata solo nel client isolato.
  // GoTrue aggiunge #access_token al redirect già hash: #/recupero#access_token=...
  const implicit = new URLSearchParams(hash.includes('?') ? query : hash.slice(hash.lastIndexOf('#') + 1))
  const one = (name: string) => implicit.getAll(name).length === 1 ? implicit.get(name) : null
  const access = one('access_token'), refresh = one('refresh_token')
  if (!token && one('type') === 'recovery' && one('token_type') === 'bearer'
    && access && /^[A-Za-z0-9._~-]{20,8192}$/.test(access)
    && refresh && /^[A-Za-z0-9._~-]{10,2048}$/.test(refresh)) {
    return { active: true, token: null, credentials: { access_token: access, refresh_token: refresh } }
  }
  return { active, token }
}
