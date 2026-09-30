/**
 * Entrypoint Edge di extract-plan (task 17). Solo cablaggio del runtime: variabili d'ambiente,
 * client Supabase (Auth con chiave pubblica, RPC server con chiave privilegiata ristretta a jobs e
 * budget) e provider. La logica è in handler.ts, provata in Node. Nessun deploy da questo task.
 */
import { createClient } from '@supabase/supabase-js'
import { createBudgetAdapter, budgetRpcNames } from '../_shared/import/budget.ts'
import { createJobsAdapter, jobServerRpcNames } from '../_shared/import/jobs.ts'
import { ServerRpcError } from '../_shared/import/analysis.ts'
import { createOpenAIProvider } from '../_shared/import/openai-provider.ts'
import { readServerConfig, serverEnvNames } from '../_shared/import/server-config.ts'
import { createSyntheticTransport } from '../_shared/import/synthetic-transport.ts'
import { createExtractPlanHandler } from './handler.ts'

const env = (name: string) => Deno.env.get(name)
const config = readServerConfig(Object.fromEntries(serverEnvNames.map(name => [name, env(name)])))
const supabaseUrl = env('SUPABASE_URL') ?? ''
const publicKey = env('SUPABASE_ANON_KEY') ?? env('SUPABASE_PUBLISHABLE_KEY') ?? ''
const serverKey = env('SUPABASE_SERVICE_ROLE_KEY') ?? env('SUPABASE_SECRET_KEY') ?? ''
const clientOptions = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }
const authClient = createClient(supabaseUrl, publicKey, clientOptions)
const serverClient = createClient(supabaseUrl, serverKey, clientOptions)

/** Client amministrativo limitato alle RPC server di jobs e budget: nessun piano, catalogo o tabella. */
const serverRpcNames = new Set<string>([...Object.values(jobServerRpcNames), ...Object.values(budgetRpcNames)])
async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (!serverRpcNames.has(name)) throw new ServerRpcError('42501', 'Server RPC not allowed')
  const { data, error } = await serverClient.rpc(name, args)
  if (error) throw new ServerRpcError(typeof error.code === 'string' ? error.code : 'unknown', typeof error.message === 'string' ? error.message : '')
  return data
}

/** Log strutturati di soli metadati: codici, stati, conteggi, token, latenze. */
const log = (event: object) => console.log(JSON.stringify(event))
const provider = config.provider.enabled && config.invalid === null
  ? createOpenAIProvider(config.provider.config, {
    transport: config.testTransport === 'synthetic' ? createSyntheticTransport(config.provider.config) : undefined,
    logger: log,
  })
  : null
if (!config.provider.enabled || config.invalid !== null) {
  log({ event: 'extract_plan_config', enabled: false, variable: config.invalid ?? (config.provider.enabled ? null : config.provider.variable) })
}

Deno.serve(createExtractPlanHandler({
  config,
  async authenticate(token) {
    // Verifica ufficiale presso Supabase Auth: JWT utente valido, non revocato, utente esistente.
    const { data, error } = await authClient.auth.getUser(token)
    return error || !data.user ? null : data.user.id
  },
  jobs: createJobsAdapter(rpc),
  budget: createBudgetAdapter(rpc),
  provider,
  randomUUID: () => crypto.randomUUID(),
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  log,
}))
