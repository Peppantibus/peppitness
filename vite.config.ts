import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readSupabaseConfig } from './src/auth/config'

let headersPath = ''
let supabaseOrigin: string | null = null
let isBuild = false

export default defineConfig({
  plugins: [react(), {
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
