// Non riportare messaggi del server, indirizzi email, URL o token nell'interfaccia/log.
export function authErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'invalid_credentials') return 'Email o password non corrette.'
  if (code === 'email_not_confirmed') return 'Questo account deve ancora confermare l’indirizzo email.'
  if (code === 'over_request_rate_limit' || code === 'over_email_send_rate_limit') return 'Troppi tentativi. Attendi qualche minuto e riprova.'
  if (code === 'user_banned') return 'Questo account non può accedere. Contatta l’amministratore.'
  return 'Accesso non riuscito. Controlla la connessione e riprova.'
}
