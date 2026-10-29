// Nessun cloud, credenziali/token solo in memoria, nessun dump CDP o email su disco.
import assert from 'node:assert/strict'
import { randomUUID, randomBytes, createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import { createClient } from '@supabase/supabase-js'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { readLocalStatus } from './lib/local-supabase.mjs'
import { ensureChrome, openTab, serveStatic, appCsp, pause } from './lib/import-browser-harness.mjs'

const config = readLocalStatus()
assert.ok(config.publishableKey, 'Publishable key locale richiesta')
const directory = resolve('artifacts/password-recovery')
await mkdir(directory, { recursive: true })
await build({ configFile: false, plugins: [react()], logLevel: 'silent', define: {
  'import.meta.env.VITE_SUPABASE_URL': JSON.stringify(config.apiUrl),
  'import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY': JSON.stringify(config.publishableKey),
}, build: { outDir: resolve(directory, 'dist'), emptyOutDir: true, sourcemap: false, target: 'safari16' } })
const server = await serveStatic({ dist: resolve(directory, 'dist'), port: 4173, csp: (await appCsp()).replace("connect-src 'self'", `connect-src 'self' ${config.apiUrl}`) })
if (process.argv.includes('--serve')) { console.log('App Supabase locale: http://127.0.0.1:4173/#/accedi; posta: http://127.0.0.1:54324'); await new Promise(() => {}); }
const admin = createClient(config.apiUrl, config.adminKey, { auth: { persistSession: false, autoRefreshToken: false } })
const makeClient = () => createClient(config.apiUrl, config.publicKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
const owners = [], checks = [], tabs = [], emails = new Set()
let recoveryPosts = 0, passwordWrites = 0
let chrome, secondChrome
const check = (value, label) => { assert.ok(value, label); checks.push(label); console.log(`PASS ${label}`) }
let tab
const input = async (selector, value) => tab.evaluate(`(() => {const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`)
const clickText = async text => tab.evaluate(`[...document.querySelectorAll('button,a')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).click()`)
async function account() {
  const email = `recovery-${randomUUID()}@example.invalid`, password = `Aa1!${randomBytes(20).toString('hex')}`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  assert.ifError(error); owners.push(data.user.id)
  emails.add(email)
  const client = makeClient(), login = await client.auth.signInWithPassword({ email, password }); assert.ifError(login.error)
  return { email, password, client, session: login.data.session, id: data.user.id }
}
async function emailLink(email, previous = '') {
  for (let attempt = 0; attempt < 60; attempt++) {
    const list = await fetch('http://127.0.0.1:54324/api/v1/messages').then(r => r.json())
    const message = list.messages.find(m => m.To?.some(to => to.Address === email))
    if (message) {
      const content = await fetch(`http://127.0.0.1:54324/api/v1/message/${message.ID}`).then(r => r.json())
      const link = /href="([^"]+)"/.exec(content.HTML)?.[1]?.replaceAll('&amp;', '&')
      assert.ok(link?.startsWith(`${config.apiUrl}/auth/v1/verify?`), 'Email standard Supabase con verifica e redirect')
      if (link !== previous) return link
    }
    await pause(100)
  }
  throw new Error('Email locale non arrivata')
}
function countRequests(t) {
  t.socket.addEventListener('message', event => {
    const value = JSON.parse(event.data)
    const request = value.method === 'Network.requestWillBeSent' && value.params.request
    if (request?.method === 'POST' && request.url.includes('/auth/v1/recover')) recoveryPosts++
    if (request?.method === 'PUT' && request.url.endsWith('/auth/v1/user')) passwordWrites++
  })
}
function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of secret.replace(/=+$/, '')) bits += alphabet.indexOf(char).toString(2).padStart(5, '0')
  const bytes = []
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2))
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)))
  const hash = createHmac('sha1', Buffer.from(bytes)).update(counter).digest(), offset = hash.at(-1) & 15
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0')
}
try {
  chrome = await ensureChrome()
  const a = await account(), b = await account()
  assert.ifError((await a.client.from('user_settings').insert({ display_name: 'Recupero sintetico', workout_weekdays: [1] })).error)
  tab = await openTab(); tabs.push(tab); countRequests(tab)
  await tab.navigate(`${server.origin}/#/accedi`, '!!document.querySelector("#login-email")')
  await tab.until('[...document.querySelectorAll("a")].some(e=>e.textContent.includes("Password dimenticata"))', 'link recupero'); await clickText('Password dimenticata?')
  await tab.until('!!document.querySelector("#recovery-email")')
  await input('#recovery-email', a.email)
  await tab.evaluate("document.querySelector('.auth-form').requestSubmit();document.querySelector('.auth-form').requestSubmit()")
  await tab.until('document.body.textContent.includes("Se l’indirizzo")')
  const neutral = await tab.evaluate('document.querySelector("[role=status]").textContent')
  check(recoveryPosts === 1, 'Doppio invio richiesta bloccato')
  const link = await emailLink(a.email)
  // Secondo processo/profilo browser: nessuno storage, cookie o verifier condiviso con il richiedente.
  secondChrome = await ensureChrome({ url: 'http://127.0.0.1:9224' })
  tab = await openTab({ url: 'http://127.0.0.1:9224' }); tabs.push(tab); countRequests(tab)
  await tab.navigate(server.origin)
  const storageKey = `sb-${new URL(config.apiUrl).hostname.split('.')[0]}-auth-token`
  await tab.evaluate(`localStorage.setItem(${JSON.stringify(storageKey)},${JSON.stringify(JSON.stringify(b.session))});localStorage.setItem('peppitness:test-offline-b','preserved')`)
  const before = await tab.evaluate(`JSON.stringify([localStorage.getItem(${JSON.stringify(storageKey)}),localStorage.getItem('peppitness:test-offline-b')])`)
  try { await tab.navigate(link, '!!document.querySelector("#new-password")') } catch {
    console.log(await tab.evaluate(`({path:location.pathname,hashKeys:[...new URLSearchParams(location.hash.slice(1)).keys()],type:new URLSearchParams(location.hash.slice(1)).get('type'),title:document.querySelector('h1')?.textContent,alert:document.querySelector('[role=alert]')?.textContent})`))
    throw new Error('Callback standard non disponibile (diagnostica senza token)')
  }
  check(await tab.evaluate('location.hash==="#/recupero" && !location.search'), 'Token eliminato dall’URL prima della verifica')
  await tab.until('!!document.querySelector("#new-password")', 'form nuova password')
  check(true, 'Link aperto in un secondo profilo browser senza verifier del richiedente')
  check(await tab.evaluate('!document.querySelector(".meal-card") && !document.querySelector(".bottom-nav")'), 'App nascosta durante recupero con B già autenticato')
  await tab.send('Page.reload')
  await tab.until('!!document.querySelector("#new-password")', 'reload conserva sessione isolata')
  check(true, 'Sessione di recupero ripristinata dopo reload')
  for (const width of [320,390,768,1440]) {
    await tab.viewport(width, 844, width < 720)
    check(await tab.evaluate('document.documentElement.scrollWidth<=innerWidth'), `Layout accessibile ${width}px`)
  }
  await tab.screenshot(resolve(directory, 'new-password-empty.png'))
  const nextPassword = `Aa2!${randomBytes(20).toString('hex')}`
  await input('#new-password', nextPassword); await input('#confirm-password', nextPassword)
  await tab.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await clickText('Salva la nuova password')
  await tab.until('document.body.textContent.includes("Salvataggio non confermato")', 'salvataggio offline', 500)
  check(await tab.evaluate('document.querySelector("#new-password").value===""'), 'Salvataggio offline: errore controllato e password rimossa dal form')
  await tab.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await input('#new-password', nextPassword); await input('#confirm-password', 'different')
  await clickText('Salva la nuova password')
  await tab.until('document.body.textContent.includes("non coincidono")')
  await input('#confirm-password', nextPassword)
  await clickText('Mostra password')
  check(await tab.evaluate('document.querySelector("#new-password").type==="text"'), 'Conferma e visibilità password')
  await clickText('Nascondi password')
  await tab.evaluate("document.querySelector('.auth-form').requestSubmit();document.querySelector('.auth-form').requestSubmit()")
  await tab.until('document.body.textContent.includes("Password aggiornata")')
  check(passwordWrites === 1, 'API ufficiale: doppio salvataggio bloccato')
  const after = await tab.evaluate(`JSON.stringify([localStorage.getItem(${JSON.stringify(storageKey)}),localStorage.getItem('peppitness:test-offline-b')])`)
  check(before === after, 'Sessione B e cache offline inalterate')
  await tab.send('Page.reload'); await tab.until('document.body.textContent.includes("Password aggiornata")')
  check(true, 'Reload della conferma non ripete il salvataggio')
  assert.ifError((await a.client.auth.signOut({ scope: 'local' })).error)
  const relogin = await a.client.auth.signInWithPassword({ email: a.email, password: nextPassword })
  check(!relogin.error && relogin.data.user.id === a.id, 'Logout e nuovo login: stesso account')
  const settings = await a.client.from('user_settings').select('display_name').single()
  check(settings.data?.display_name === 'Recupero sintetico', 'Dati conservati sullo stesso account')
  check(!(await b.client.auth.signInWithPassword({ email: b.email, password: b.password })).error, 'Password B invariata')
  const reused = makeClient()
  check(Boolean((await reused.auth.verifyOtp({ token_hash: new URL(link).searchParams.get('token'), type: 'recovery' })).error), 'Link utilizzato respinto dal server')
  await tab.navigate(link, 'document.body.textContent.includes("Il link è scaduto")')
  await tab.until('document.body.textContent.includes("Il link è scaduto")')
  check(true, 'Link riutilizzato: errore controllato, app nascosta')
  await clickText('Torna all’app / accesso')
  const forged = `${server.origin}/#access_token=${b.session.access_token}&refresh_token=${b.session.refresh_token}&type=recovery&token_type=bearer`
  await tab.navigate(forged, 'document.body.textContent.includes("Il link è scaduto")')
  check(!(await makeClient().auth.refreshSession({ refresh_token: b.session.refresh_token })).error, 'Sessione password etichettata recovery respinta senza revocare B')
  await clickText('Torna all’app / accesso')
  await tab.navigate(`${server.origin}/#/password-dimenticata`, '!!document.querySelector("#recovery-email")')
  await input('#recovery-email', `absent-${randomUUID()}@example.invalid`); await clickText('Invia il link di recupero')
  await tab.until('document.body.textContent.includes("Se l’indirizzo")')
  check(await tab.evaluate('document.querySelector("[role=status]").textContent') === neutral, 'Risposta identica per email inesistente')
  // Rete assente nella richiesta: messaggio controllato e possibilità di riprovare.
  await tab.navigate(`${server.origin}/#/accedi`)
  await tab.navigate(`${server.origin}/#/password-dimenticata`, '!!document.querySelector("#recovery-email")')
  await input('#recovery-email', a.email)
  await tab.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await clickText('Invia il link di recupero')
  await tab.until('document.body.textContent.includes("Invio non disponibile")', 'errore rete richiesta', 500)
  await tab.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  check(true, 'Richiesta offline: errore controllato, form recuperabile')
  await tab.navigate(`${server.origin}/#/recupero?token_hash=invalid_synthetic_hash_1234567890&type=recovery`, 'document.body.textContent.includes("Continua con il recupero")')
  await clickText('Continua con il recupero'); await tab.until('document.body.textContent.includes("Il link è scaduto")')
  check(true, 'Token non valido respinto senza mostrare app')
  await clickText('Torna all’app / accesso')
  // MFA reale: il recupero richiede il fattore esistente e non lo rimuove.
  const enrolled = await a.client.auth.mfa.enroll({ factorType: 'totp' }); assert.ifError(enrolled.error)
  const secret = enrolled.data.totp.secret, factorId = enrolled.data.id
  assert.ifError((await a.client.auth.mfa.challengeAndVerify({ factorId, code: totp(secret) })).error)
  await pause(1100)
  assert.ifError((await a.client.auth.resetPasswordForEmail(a.email, { redirectTo: `${server.origin}/#/recupero` })).error)
  const mfaLink = await emailLink(a.email, link)
  await tab.evaluate(`localStorage.setItem(${JSON.stringify(storageKey)},${JSON.stringify(JSON.stringify((await a.client.auth.getSession()).data.session))})`)
  await tab.navigate(mfaLink, '!!document.querySelector("#mfa-code")')
  check(await tab.evaluate('!document.querySelector("#new-password") && !document.querySelector(".meal-card")'), 'MFA richiesto anche con lo stesso account già aperto a livello aal2')
  await input('#mfa-code', '000000'); await clickText('Verifica')
  await tab.until('!!document.querySelector("[role=alert]")')
  await input('#mfa-code', totp(secret)); await clickText('Verifica')
  await tab.until('!!document.querySelector("#new-password")')
  await input('#new-password', nextPassword); await input('#confirm-password', nextPassword)
  await clickText('Salva la nuova password')
  await tab.until('document.body.textContent.includes("diversa da quella attuale")')
  check(true, 'Password identica: errore controllato dopo MFA')
  const mfaPassword = `Aa3!${randomBytes(20).toString('hex')}`
  await input('#new-password', mfaPassword); await input('#confirm-password', mfaPassword)
  await clickText('Salva la nuova password'); await tab.until('document.body.textContent.includes("Password aggiornata")')
  await a.client.auth.signOut({ scope: 'local' })
  assert.ifError((await a.client.auth.signInWithPassword({ email: a.email, password: mfaPassword })).error)
  const factors = await a.client.auth.mfa.listFactors()
  check(factors.data.totp.some(f => f.id === factorId && f.status === 'verified'), 'Cambio password MFA riuscito: fattore originale conservato')
  await clickText('Torna all’app / accesso')
  await pause(1100)
  assert.ifError((await a.client.auth.resetPasswordForEmail(a.email, { redirectTo: `${server.origin}/#/recupero` })).error)
  const expired = await emailLink(a.email, mfaLink)
  const aged = spawnSync('docker', ['exec', 'supabase_db_peppitness', 'psql', '-U', 'postgres', '-d', 'postgres', '-c', `update auth.users set recovery_sent_at = now() - interval '2 hours' where id = '${a.id}'`], { encoding: 'utf8', windowsHide: true })
  check(aged.status === 0, 'Scadenza simulata solo sulla fixture locale')
  await tab.navigate(expired, 'document.body.textContent.includes("Il link è scaduto")')
  check(true, 'Link scaduto respinto da Supabase Auth reale')
  await writeFile(resolve(directory, 'results.json'), JSON.stringify({ checks, cloud: false, iphone: 'NOT_RUN', pwaInstalled: 'NOT_RUN' }, null, 2))
} finally {
  for (const t of tabs) await t.close()
  await secondChrome?.stop(); await chrome?.stop(); await server.stop()
  for (const id of owners) await admin.auth.admin.deleteUser(id)
  // Elimina soltanto le email delle fixture di questa esecuzione.
  const list = await fetch('http://127.0.0.1:54324/api/v1/messages').then(r=>r.json())
  const ids = list.messages.filter(m=>m.To?.some(to=>emails.has(to.Address))).map(m=>m.ID)
  if (ids.length) await fetch('http://127.0.0.1:54324/api/v1/messages', { method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ IDs:ids }) })
}
