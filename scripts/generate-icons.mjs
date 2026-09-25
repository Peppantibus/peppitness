// Esporta le icone dalla stessa sorgente SVG del marchio, senza librerie aggiuntive.
// Richiede una istanza Chrome dedicata con CDP su 127.0.0.1:9223 (vedi README).
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const publicDir = new URL('../public/', import.meta.url)
const source = await readFile(new URL('logo.svg', publicDir), 'utf8')
const content = source.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
// Il disegno resta dentro l'area sicura circolare delle icone maskable.
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#F6F7F4"/><g transform="translate(11.52 21.36) scale(.82)" fill="none">${content}</g></svg>`
const debugUrl = process.env.TEST_DEBUG_URL ?? 'http://127.0.0.1:9223'
const response = await fetch(`${debugUrl}/json/new?about:blank`, { method: 'PUT' })
if (!response.ok) throw new Error('Avvia il browser Chrome dedicato prima di generare le icone.')
const target = await response.json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
let sequence = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  const task = pending.get(message.id)
  if (!task) return
  clearTimeout(task.timeout)
  pending.delete(message.id)
  if (message.error) task.reject(new Error(message.error.message))
  else task.resolve(message.result)
})
function send(method, params) {
  const id = ++sequence
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Timeout durante la generazione delle icone')) }, 10000)
    pending.set(id, { resolve, reject, timeout })
    socket.send(JSON.stringify({ id, method, params }))
  })
}
try {
  await mkdir(new URL('icons/', publicDir), { recursive: true })
  await writeFile(new URL('favicon.svg', publicDir), icon + '\n')
  for (const [size, name] of [[180, 'apple-touch-icon.png'], [192, 'icon-192.png'], [512, 'icon-512.png']]) {
    const imageUrl = 'data:image/svg+xml;base64,' + Buffer.from(icon).toString('base64')
    const result = await send('Runtime.evaluate', {
      expression: `new Promise((resolve, reject) => { const image = new Image(); image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = ${size}; canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size}); resolve(canvas.toDataURL('image/png').split(',')[1]); }; image.onerror = () => reject(new Error('SVG non renderizzabile')); image.src = ${JSON.stringify(imageUrl)}; })`,
      awaitPromise: true, returnByValue: true,
    })
    if (result.exceptionDetails || !result.result.value) throw new Error(`Esportazione fallita: ${name}`)
    await writeFile(new URL(`icons/${name}`, publicDir), Buffer.from(result.result.value, 'base64'))
    console.log(`${name}: ${size} × ${size}`)
  }
} finally {
  socket.close()
  await fetch(`${debugUrl}/json/close/${target.id}`).catch(() => undefined)
}
