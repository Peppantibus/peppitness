// Converte in WebP le illustrazioni PNG dell'interfaccia (pasti e gruppi muscolari), con il Chrome di test:
// nessuna libreria aggiuntiva. Qualità 0,9: circa un quarto del peso, resa indistinguibile alle dimensioni
// mostrate. Le icone dell'app restano PNG (apple-touch-icon e manifest). Uso: npm run images:webp
import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ensureChrome, openTab, root } from './lib/import-browser-harness.mjs'

const folders = ['src/assets/meals', 'src/assets/muscle-groups']
const quality = 0.9
const debugUrl = process.env.TEST_DEBUG_URL ?? 'http://127.0.0.1:9431'

const chrome = await ensureChrome({ url: debugUrl })
const tab = await openTab({ url: debugUrl })
let before = 0, after = 0
try {
  for (const folder of folders) {
    for (const name of (await readdir(join(root, folder))).filter(file => file.endsWith('.png')).sort()) {
      const source = join(root, folder, name)
      const png = await readFile(source)
      const data = 'data:image/png;base64,' + png.toString('base64')
      // Stesse dimensioni e trasparenza dell'originale; l'encoder WebP di Chrome conserva il canale alfa.
      const webp = await tab.evaluate(`new Promise((resolve, reject) => { const image = new Image(); image.onload = () => { const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext('2d').drawImage(image, 0, 0); const url = canvas.toDataURL('image/webp', ${quality}); url.startsWith('data:image/webp') ? resolve(url.split(',')[1]) : reject(new Error('WebP non supportato')) }; image.onerror = () => reject(new Error('PNG non leggibile')); image.src = ${JSON.stringify(data)} })`)
      const bytes = Buffer.from(webp, 'base64')
      if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP') throw new Error(`Uscita non WebP: ${name}`)
      await writeFile(source.replace(/\.png$/, '.webp'), bytes)
      await rm(source)
      before += png.length; after += bytes.length
      console.log(`${folder}/${name}: ${png.length} → ${bytes.length} byte`)
    }
  }
  console.log(`Totale: ${before} → ${after} byte (${before ? Math.round((1 - after / before) * 100) : 0}% in meno)`)
} finally {
  await tab.close()
  await chrome.stop()
}
