// Server di sviluppo in modalità locale: senza Supabase, con il programma dimostrativo e il diario in memoria
// (si perde ricaricando la pagina). Le variabili d'ambiente prevalgono su .env.local; uno spazio, ripulito da
// readSupabaseConfig, spegne il client senza toccare il file. Uso: npm run dev:local
import { createServer, loadEnv } from 'vite'

process.env.VITE_SUPABASE_URL = ' '
process.env.VITE_SUPABASE_PUBLISHABLE_KEY = ' '

// Mai partire collegati al cloud: se un'altra fonte reimpostasse le chiavi, ci si ferma.
const env = loadEnv('development', process.cwd(), 'VITE_')
if (env.VITE_SUPABASE_URL?.trim() || env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim()) {
  console.error('Configurazione Supabase ancora presente: modalità locale non avviata.')
  process.exit(1)
}

const server = await createServer({ server: { host: '127.0.0.1', port: 5180, strictPort: true } })
await server.listen()
server.printUrls()
console.log('  Modalità locale: nessuna chiamata a Supabase, dati in memoria (persi al ricaricamento).')
