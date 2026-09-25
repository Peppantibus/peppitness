// Attivare dopo `npm run setup:pwa`. Nessun fallback che simuli un service worker.
import { mergeConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import base from './vite.config.ts'

export default mergeConfig(base, {
  plugins: [VitePWA({
    registerType: 'prompt',
    injectRegister: false,
    manifest: false,
    includeAssets: ['logo.svg', 'favicon.svg', 'icons/*.png', 'manifest.webmanifest'],
    workbox: {
      globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      navigateFallback: 'index.html',
      navigateFallbackDenylist: [/^\/auth\//, /^\/api\//],
      cleanupOutdatedCaches: true,
      runtimeCaching: [],
    },
  })],
  define: { 'import.meta.env.VITE_PWA_ENABLED': JSON.stringify('true') },
})
