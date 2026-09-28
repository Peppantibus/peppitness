import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readSupabaseConfig } from './src/auth/config'
import { PDFJS_ASSET_DIRECTORY, PDFJS_DECODER_FILES } from './src/import/readers/pdf-assets'

/**
 * Decodificatori JavaScript di PDF.js (JBIG2, JPEG 2000) come asset same-origin con nomi stabili:
 * PDF.js compone l'URL dal nome del file, quindi niente hash. Vedi src/import/readers/pdf-assets.ts.
 * Copiati solo se la build contiene i worker PDF: finché nessuna pagina importa i reader (task 11)
 * non pesano sul precache della PWA.
 */
function pdfjsDecoderAssets(): Plugin {
  const source = (name: string) => resolve('node_modules', 'pdfjs-dist', 'wasm', name)
  return {
    name: 'pdfjs-decoder-assets',
    async generateBundle(_, bundle) {
      // Solo nelle build che leggono o mostrano PDF (worker del reader o del rendering).
      if (!Object.keys(bundle).some(name => /pdf-(render-)?worker/.test(name))) return
      for (const name of PDFJS_DECODER_FILES) this.emitFile({ type: 'asset', fileName: `${PDFJS_ASSET_DIRECTORY}/${name}`, source: await readFile(source(name)) })
    },
    configureServer(server) {
      server.middlewares.use(`/${PDFJS_ASSET_DIRECTORY}/`, (request, response, next) => {
        const name = (request.url ?? '').replace(/^\//, '').split('?')[0]
        if (!(PDFJS_DECODER_FILES as readonly string[]).includes(name ?? '')) { next(); return }
        readFile(source(name!)).then(body => { response.setHeader('Content-Type', 'text/javascript'); response.end(body) }, next)
      })
    },
  }
}

let headersPath = ''
let supabaseOrigin: string | null = null
let isBuild = false

export default defineConfig({
  plugins: [react(), pdfjsDecoderAssets(), {
    name: 'validate-public-supabase-config',
    config(_, { command, mode }) {
      isBuild = command === 'build'
      const config = readSupabaseConfig(loadEnv(mode, process.cwd(), 'VITE_'))
      if (isBuild && !config) throw new Error('Configura Supabase prima della build di produzione.')
      supabaseOrigin = config?.url ?? null
    },
    configResolved(config) { headersPath = resolve(config.root, config.build.outDir, '_headers') },
    async closeBundle() {
      if (!isBuild || !supabaseOrigin) return
      const headers = await readFile(headersPath, 'utf8')
      if (!headers.includes('__SUPABASE_ORIGIN__')) throw new Error('Placeholder CSP mancante in public/_headers.')
      await writeFile(headersPath, headers.replaceAll('__SUPABASE_ORIGIN__', supabaseOrigin))
    },
  }],
  server: {
    fs: {
      strict: true,
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.codex/**', '**/.agents/**', '**/.npm-cache/**', '**/.browser-profile/**', '**/artifacts/**', '**/private-imports/**', '**/backups/**', '**/AGENT.md'],
    },
  },
  build: {
    target: 'safari16',
    sourcemap: false,
    // SDK e React in chunk separati: cache più stabile fra un rilascio e l'altro.
    rollupOptions: { output: { manualChunks: { supabase: ['@supabase/supabase-js'], react: ['react', 'react-dom'] } } },
  },
})
