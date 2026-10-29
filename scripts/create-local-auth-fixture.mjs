import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { readLocalStatus } from './lib/local-supabase.mjs'

const config = readLocalStatus() // Rifiuta il cloud prima di leggere qualunque input.
if (!process.stdin.isTTY) throw new Error('Esegui da un terminale interattivo: la password non deve comparire nei comandi.')
process.stdout.write('Scegli una password locale (almeno 12 caratteri, maiuscole, minuscole, numeri; input nascosto): ')
process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8')
const password = await new Promise(resolve => {
  let value = ''
  const listener = chunk => {
    for (const char of chunk) {
      if (char === '\u0003') process.exit(130)
      if (char === '\r' || char === '\n') { process.stdin.off('data', listener); resolve(value); return }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
      else if (char >= ' ') value += char
    }
  }
  process.stdin.on('data', listener)
})
process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n')
if (password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) throw new Error('Requisiti password non soddisfatti.')
const email = `manual-recovery-${randomUUID()}@example.invalid`
const client = createClient(config.apiUrl, config.adminKey, { auth: { persistSession: false, autoRefreshToken: false } })
const { error } = await client.auth.admin.createUser({ email, password, email_confirm: true })
if (error) throw new Error('Creazione fixture locale non riuscita.')
console.log(`Account sintetico locale: ${email}\nAccedi su http://127.0.0.1:4173/#/accedi con la password appena scelta.\nRecupero: posta su http://127.0.0.1:54324. Nessuna email reale.`)
