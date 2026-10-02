// Esporta le icone dalla stessa sorgente SVG del marchio, senza librerie aggiuntive.
// Avvia, se necessario, un Chrome dedicato con profilo temporaneo; non usa quello personale.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { ensureChrome, openTab } from './lib/import-browser-harness.mjs'

const publicDir = new URL('../public/', import.meta.url)
const source = await readFile(new URL('logo.svg', publicDir), 'utf8')
const content = source.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
// Centra il viewBox quadrato e lascia margine per il ritaglio circolare maskable.
const viewBox = /viewBox="([^"]+)"/.exec(source)?.[1].trim().split(/\s+/).map(Number)
if (!viewBox || viewBox.length !== 4 || viewBox.some(value => !Number.isFinite(value)) || viewBox[2] <= 0 || viewBox[3] <= 0) throw new Error('viewBox del logo non valido')
const [x, y, width, height] = viewBox
const scale = 128 * .72 / Math.max(width, height)
const tx = (128 - width * scale) / 2 - x * scale, ty = (128 - height * scale) / 2 - y * scale
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" fill="#F5F6F2"/><g transform="translate(${tx} ${ty}) scale(${scale})" fill="none">${content}</g></svg>`
const debugUrl = process.env.TEST_DEBUG_URL ?? 'http://127.0.0.1:9430'
const chrome = await ensureChrome({ url: debugUrl })
let tab
try {
  tab = await openTab({ url: debugUrl })
  await mkdir(new URL('icons/', publicDir), { recursive: true })
  await writeFile(new URL('favicon.svg', publicDir), icon + '\n')
  for (const [size, name] of [[180, 'apple-touch-icon.png'], [192, 'icon-192.png'], [512, 'icon-512.png']]) {
    const imageUrl = 'data:image/svg+xml;base64,' + Buffer.from(icon).toString('base64')
    const result = await tab.evaluate(`new Promise((resolve, reject) => { const image = new Image(); image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = ${size}; canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size}); resolve(canvas.toDataURL('image/png').split(',')[1]); }; image.onerror = () => reject(new Error('SVG non renderizzabile')); image.src = ${JSON.stringify(imageUrl)}; })`)
    if (!result) throw new Error(`Esportazione fallita: ${name}`)
    await writeFile(new URL(`icons/${name}`, publicDir), Buffer.from(result, 'base64'))
    console.log(`${name}: ${size} × ${size}`)
  }
} finally {
  await tab?.close()
  await chrome.stop()
}
