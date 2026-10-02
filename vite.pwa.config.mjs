// Build distribuibile con service worker (vite-plugin-pwa). Nessuna cache delle API: runtimeCaching vuoto.
import { mergeConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import base from './vite.config.ts'

export default mergeConfig(base, {
  plugins: [VitePWA({
    registerType: 'prompt',
    injectRegister: false,
    manifest: false,
    includeAssets: ['logo.svg', 'favicon.svg', 'icons/*.png', 'manifest.webmanifest', 'templates/*.docx'],
    workbox: {
      globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
      // Il worker del reader PDF (PDF.js 6.3.289 legacy + motore) è di circa 1,7 MiB, vicino ai 2 MiB
      // predefiniti di Workbox: oltre quella soglia uscirebbe dal precache con un solo avviso e la
      // lettura dei PDF non funzionerebbe offline. La prova import-pdf-reader-browser-check lo verifica.
      maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      navigateFallback: 'index.html',
      navigateFallbackDenylist: [/^\/auth\//, /^\/api\//],
      cleanupOutdatedCaches: true,
      runtimeCaching: [],
    },
  })],
  define: { 'import.meta.env.VITE_PWA_ENABLED': JSON.stringify('true') },
})
