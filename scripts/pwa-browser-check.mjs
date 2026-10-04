// Collaudo del service worker generato da `npm run build:pwa` servito dalla preview su 4173.
// API Supabase simulate; verifica precache dell'app, nessuna cache delle API e reload offline.
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { fixtureSession, fixtureStorageKey, installAuthFixture } from './lib/browser-auth-fixture.mjs'
import { sampleMeals, sampleWorkoutDays, seedFollowedPlans } from './lib/diary-fixture.mjs'

const baseUrl = 'http://127.0.0.1:4173', debugUrl = 'http://127.0.0.1:9223'
const errors = []
const target = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' }).then(r => r.json())
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let sequence = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data), task = pending.get(message.id)
  if (task) { pending.delete(message.id); clearTimeout(task.timeout); if (message.error) task.reject(new Error(`CDP ${message.error.code}`)); else task.resolve(message.result) }
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text)
})
function send(method, params = {}) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout ${method}`)) }, 15000)
    pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate(expression) {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (response.exceptionDetails) throw new Error(`Errore nel test PWA: ${expression}`)
  return response.result.value
}
async function until(expression, tries = 160) {
  for (let i = 0; i < tries; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error(`Condizione non raggiunta: ${expression}`)
}

try {
  await mkdir('artifacts', { recursive: true })
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  const mock = await installAuthFixture(send, socket, baseUrl)
  seedFollowedPlans(mock, fixtureSession().user.id, { workoutDays: sampleWorkoutDays, meals: sampleMeals })
  // Worker e cache lasciati da prove precedenti si azzerano dal browser, prima di aprire la pagina: un
  // unregister() dalla pagina che il worker controlla verrebbe annullato dal register() successivo
  // (stesso script, nessuna nuova installazione) e la precache resterebbe vuota.
  await send('Storage.clearDataForOrigin', { origin: baseUrl, storageTypes: 'service_workers,cache_storage' })
  await send('Page.navigate', { url: baseUrl })
  await until('document.readyState === "complete"')
  await evaluate(`(async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister(); for (const k of await caches.keys()) await caches.delete(k); localStorage.clear(); localStorage.setItem(${JSON.stringify(fixtureStorageKey)}, ${JSON.stringify(JSON.stringify(fixtureSession()))}) })()`)
  await evaluate('location.hash = "#/scheda"')
  await send('Page.reload')
  await until('Boolean(document.querySelector(".workout-overview"))')
  await until('navigator.serviceWorker.getRegistrations().then(list => list.some(r => r.active))')
  // Primo caricamento senza controller; dopo il reload la pagina è servita dal worker.
  await send('Page.reload')
  await until('Boolean(navigator.serviceWorker.controller)')
  await until('Boolean(document.querySelector(".workout-overview"))')
  // Il worker di una prova precedente può controllare la pagina finché il nuovo non ha finito
  // l'installazione: si attende la precache completa invece di leggerla una volta sola.
  const cachedUrls = `(async () => { const urls = []; for (const k of await caches.keys()) for (const r of await (await caches.open(k)).keys()) urls.push(r.url); return urls })()`
  await until(`${cachedUrls}.then(urls => urls.some(url => new URL(url).pathname === '/index.html'))`)
  const cached = await evaluate(cachedUrls)
  assert.ok(cached.some(url => new URL(url).pathname === '/index.html'), 'Shell dell’app in precache')
  assert.ok(cached.every(url => url.startsWith(baseUrl)), 'Nessuna risposta API o esterna nella cache')

  // Rete assente: l'app si riapre dal worker e usa la copia dei piani sul dispositivo.
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  mock.failProgramReads = true; mock.failDiary = true
  await send('Page.reload')
  await until('Boolean(document.querySelector(".workout-overview"))')
  await until('document.querySelector("main").textContent.includes("Rete assente")')
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  mock.failProgramReads = false; mock.failDiary = false
  assert.deepEqual(errors, [], 'Errori console')
  assert.deepEqual(mock.failures, [], 'Nessuna richiesta inattesa nel mock')
  const report = { status: 'passed', checks: ['service worker registrato', 'pagina controllata dopo reload', 'precache solo dell’origine app', 'riapertura offline con piani sul dispositivo'], cachedEntries: cached.length, date: new Date().toISOString() }
  await writeFile('artifacts/pwa-browser-report.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  await evaluate('navigator.serviceWorker.getRegistrations().then(list => Promise.all(list.map(r => r.unregister())))').catch(() => undefined)
  socket.close()
  await fetch(`${debugUrl}/json/close/${target.id}`).catch(() => undefined)
}
