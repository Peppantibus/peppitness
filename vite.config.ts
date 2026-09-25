import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    fs: {
      strict: true,
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.codex/**', '**/.agents/**', '**/.npm-cache/**', '**/.browser-profile/**', '**/artifacts/**', '**/private-imports/**', '**/backups/**', '**/AGENT.md'],
    },
  },
  build: { target: 'safari16', sourcemap: false },
})
