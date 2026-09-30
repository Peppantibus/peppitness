import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { validateCommitCommand, validateImportReceipt, receiptMismatches, importRpcNames } from '../../supabase/functions/_shared/import/contracts.ts'
import { commandHash, contentHash } from '../../supabase/functions/_shared/import/canonical.ts'
import { importLocalSql, sqlLiteral as lit } from './import-local-db.mjs'

/** Task 18. Le RPC commit (19/20) non esistono: la parte server gira con i soli helper
 * privati via SQL locale sotto il ruolo proprietario, come faranno le RPC SECURITY DEFINER.
 * Tutto ciò che fa il browser (lookup, selezione, eliminazione, tentativi diretti) passa via HTTP
 * con sessioni reali; le fixture Auth vengono rimosse dal runner (cascata account).
 */
const dietCommand = JSON.parse(readFileSync(new URL('../../tests/fixtures/import/contracts/commands/diet-basic.json', import.meta.url), 'utf8'))
const privateHelpers = ['claim_import_receipt', 'finalize_import_receipt', 'apply_import_selection', 'lock_import_selection', 'canonical_json', 'import_command_hash']
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

function newCommand(options = { follow: false, expectedActiveRevision: null }) {
  const command = structuredClone(dietCommand)
  command.requestId = randomUUID()
  command.payload.resolved.plan.id = randomUUID()
  command.selectionOptions = options
  const result = validateCommitCommand('diet', command)
  if (!result.ok) throw new Error('Comando dieta sintetico non valido.')
  return command
}

/** Sequenza della futura commit_diet_import: hash server -> claim -> selezione -> piano -> finalize.
 * Gli hash TypeScript servono solo a verificare l'equivalenza, non entrano nella ricevuta. */
async function serverCommit(ownerId, command, holdSeconds = 0) {
  const hashes = { command: await commandHash(command), content: await contentHash(command.payload) }
  await importLocalSql(`do $fixture$
    declare c jsonb := ${lit(JSON.stringify(command))}::jsonb; owner uuid := ${lit(ownerId)};
      request uuid := (c->>'requestId')::uuid; plan uuid := (c#>>'{payload,resolved,plan,id}')::uuid;
      command_hash text; content_hash text; selection jsonb;
    begin
      command_hash := peppitness_private.import_command_hash(request, c->'payload', c->'provenance', c->'selectionOptions');
      content_hash := peppitness_private.import_content_hash(c->'payload');
      if command_hash <> ${lit(hashes.command)} or content_hash <> ${lit(hashes.content)} then raise exception 'Hash SQL/TS mismatch'; end if;
      if peppitness_private.claim_import_receipt(owner, request, 'diet', command_hash) is not null then return; end if;
      perform peppitness_private.lock_import_selection(owner, c->'selectionOptions');
      insert into public.meal_plans(id, owner_id, name, document)
        values (plan, owner, c#>>'{payload,resolved,plan,name}', c#>'{payload,resolved,plan,document}');
      selection := peppitness_private.apply_import_selection(owner, 'diet', plan, c->'selectionOptions');
      perform pg_sleep(${Number(holdSeconds)});
      perform peppitness_private.finalize_import_receipt(owner, request, 'diet', command_hash, content_hash, plan, null,
        '[]'::jsonb, selection, c->'provenance');
    end $fixture$`)
  return hashes
}

async function settle(promise) {
  try { return { ok: true, value: await promise } } catch (error) { return { ok: false, message: error.message } }
}

export async function importReceiptsApiChecks(context, a, b) {
  const { request, check, expectOk, expectDenied, concurrentRequests } = context
  const rpc = (name, body, token) => request(`/rest/v1/rpc/${name}`, { method: 'POST', body, token })
  const receipt = (requestId, token) => rpc(importRpcNames.receipt, { p_request_id: requestId }, token)
  const selection = async actor => expectOk(await request(`/rest/v1/active_plans?select=revision,workout_plan_id,meal_plan_id`, { token: actor.token }), 'ricevute HTTP: selezione')[0] ?? null
  const plans = async actor => expectOk(await request('/rest/v1/meal_plans?select=id', { token: actor.token }), 'ricevute HTTP: piani').map(row => row.id)

  // Stessa chiave in due account; hash SQL = TS su un comando nuovo (UUID casuali).
  const first = newCommand()
  const hashes = await serverCommit(a.id, first)
  const sameKey = structuredClone(first); sameKey.payload.resolved.plan.id = randomUUID()
  await serverCommit(b.id, sameKey)
  const own = expectOk(await receipt(first.requestId, a.token), 'ricevute HTTP: lookup A')
  check(validateImportReceipt(own).ok && receiptMismatches(own, first, hashes.command).length === 0
    && own.resultState === 'committed' && own.selection === null, 'ricevute HTTP: ricevuta valida, hash server = TypeScript')
  const other = expectOk(await receipt(first.requestId, b.token), 'ricevute HTTP: lookup B')
  check(other.planId === sameKey.payload.resolved.plan.id && other.planId !== own.planId, 'ricevute HTTP: stessa chiave isolata per account')
  check(expectOk(await receipt(randomUUID(), a.token), 'ricevute HTTP: chiave ignota') === null, 'ricevute HTTP: assente = null')
  expectDenied(await receipt(first.requestId), 'ricevute HTTP: lookup anonimo respinto')

  // Il browser non raggiunge helper né tabella in scrittura.
  for (const name of privateHelpers) {
    expectDenied(await rpc(name, {}, a.token), `ricevute HTTP: helper ${name} non esposto`, ['PGRST202', '42501'])
  }
  const forged = { owner_id: a.id, request_id: randomUUID(), kind: 'diet', command_hash: hashes.command, content_hash: hashes.content,
    plan_id: own.planId, provenance: first.provenance }
  expectDenied(await request('/rest/v1/import_receipts', { method: 'POST', body: forged, token: a.token }), 'ricevute HTTP: insert client respinto')
  expectDenied(await request(`/rest/v1/import_receipts?request_id=eq.${first.requestId}`, { method: 'PATCH', body: { result_state: 'deleted' }, token: a.token }), 'ricevute HTTP: update client respinto')
  expectDenied(await request(`/rest/v1/import_receipts?request_id=eq.${first.requestId}`, { method: 'DELETE', token: a.token }), 'ricevute HTTP: delete client respinto')
  expectDenied(await request('/rest/v1/import_receipts?select=request_id'), 'ricevute HTTP: tabella anonima respinta')
  check(expectOk(await request(`/rest/v1/import_receipts?select=request_id&owner_id=eq.${b.id}`, { token: a.token }), 'ricevute HTTP: filtro altrui').length === 0,
    'ricevute HTTP: RLS A non vede B')

  // Replay e conflitto dopo il primo esito (lookup dopo risposta persa).
  await serverCommit(a.id, first)
  check((await plans(a)).filter(id => id === own.planId).length === 1, 'ricevute HTTP: replay senza secondo piano')
  const changed = structuredClone(first); changed.payload.resolved.plan.name = 'Menu cambiato'
  const conflict = await settle(serverCommit(a.id, changed))
  check(!conflict.ok && conflict.message === 'Import request conflict', 'ricevute HTTP: stessa chiave, comando diverso PT409')

  // Stessa chiave in concorrenza (due tab/tocchi): stesso comando -> un solo piano; comando diverso -> un solo vincitore.
  const twice = newCommand()
  const doubled = await Promise.all([settle(serverCommit(a.id, twice, 1.5)), settle(serverCommit(a.id, twice, 1.5))])
  check(doubled.every(x => x.ok) && (await plans(a)).filter(id => id === twice.payload.resolved.plan.id).length === 1,
    'ricevute HTTP: doppio invio concorrente, un solo piano')
  const contested = newCommand()
  const variant = structuredClone(contested); variant.payload.resolved.plan.name = 'Menu variante'
  const contest = await Promise.all([settle(serverCommit(a.id, contested, 1.5)), settle(serverCommit(a.id, variant, 1.5))])
  const kept = expectOk(await receipt(contested.requestId, a.token), 'ricevute HTTP: lookup chiave contesa')
  check(contest.filter(x => x.ok).length === 1 && contest.filter(x => !x.ok && x.message === 'Import request conflict').length === 1
    && [await commandHash(contested), await commandHash(variant)].includes(kept?.commandHash), 'ricevute HTTP: stessa chiave e comandi diversi concorrenti, uno solo')

  // Selezione assente (B non ne ha) creata in concorrenza: una sola vince, l'altra non lascia ricevuta.
  check(await selection(b) === null, 'ricevute HTTP: selezione iniziale di B assente')
  const racers = [newCommand({ follow: true, expectedActiveRevision: null }), newCommand({ follow: true, expectedActiveRevision: null })]
  const race = await Promise.all(racers.map(command => settle(serverCommit(b.id, command, 1.5))))
  check(race.filter(x => x.ok).length === 1 && race.filter(x => !x.ok && x.message === 'Active selection conflict').length === 1,
    'ricevute HTTP: due follow concorrenti su selezione assente, uno solo')
  const winner = racers[race.findIndex(x => x.ok)], loser = racers[race.findIndex(x => !x.ok)]
  const created = await selection(b)
  check(created?.revision === 1 && created.meal_plan_id === winner.payload.resolved.plan.id && created.workout_plan_id === null,
    'ricevute HTTP: selezione creata una volta, altra sezione vuota')
  check(expectOk(await receipt(loser.requestId, b.token), 'ricevute HTTP: lookup perdente') === null
    && !(await plans(b)).includes(loser.payload.resolved.plan.id), 'ricevute HTTP: conflitto annulla piano e ricevuta')

  // Helper server contro un altro dispositivo di A che modifica la selezione: esattamente uno vince.
  const before = await selection(a)
  check(before !== null, 'ricevute HTTP: A ha già una selezione dal diario')
  const follower = newCommand({ follow: true, expectedActiveRevision: before.revision })
  const serverSide = settle(serverCommit(a.id, follower, 2))
  await pause(900)
  const device = await request(`/rest/v1/active_plans?owner_id=eq.${a.id}`, {
    method: 'PATCH', body: { meal_plan_id: null, revision: before.revision + 1 }, token: a.token })
  const helper = await serverSide
  check([helper.ok, device.ok].filter(Boolean).length === 1 && (helper.ok || helper.message === 'Active selection conflict')
    && (device.ok || device.status === 409), 'ricevute HTTP: selezione concorrente, revisione rispettata')
  const after = await selection(a)
  const followed = expectOk(await receipt(follower.requestId, a.token), 'ricevute HTTP: lookup follow')
  check(after.revision === before.revision + 1 && after.workout_plan_id === before.workout_plan_id && (helper.ok
    ? after.meal_plan_id === follower.payload.resolved.plan.id && followed?.selection?.revision === after.revision
    : after.meal_plan_id === null && followed === null), 'ricevute HTTP: stato coerente col vincitore, sezione scheda preservata')

  // Eliminazione concorrente al lookup: mai "assente"; poi tombstone e vecchio retry.
  const [deleted, looked] = await concurrentRequests([
    rpc('delete_meal_plans', { p_plan_id: own.planId }, a.token), receipt(first.requestId, a.token)])
  check(expectOk(deleted, 'ricevute HTTP: delete singolo') === 1 && ['committed', 'deleted'].includes(expectOk(looked, 'ricevute HTTP: lookup concorrente')?.resultState),
    'ricevute HTTP: lookup durante delete vede committed o deleted')
  const tombstone = expectOk(await receipt(first.requestId, a.token), 'ricevute HTTP: lookup tombstone')
  check(validateImportReceipt(tombstone).ok && tombstone.resultState === 'deleted' && tombstone.commandHash === hashes.command
    && tombstone.planId === own.planId, 'ricevute HTTP: deleted esplicito con hash conservato')
  await serverCommit(a.id, first)
  check(!(await plans(a)).includes(own.planId) && expectOk(await receipt(first.requestId, a.token), 'ricevute HTTP: retry dopo delete').resultState === 'deleted',
    'ricevute HTTP: vecchio retry non ricrea il piano')

  // Delete all mentre un import è in corso: nessuna ricevuta committed senza piano, nessun piano vivo con tombstone.
  const inFlight = newCommand()
  const pending = settle(serverCommit(a.id, inFlight, 2))
  await pause(900)
  const removed = await rpc('delete_meal_plans', { p_plan_id: null }, a.token)
  check((await pending).ok && removed.ok, 'ricevute HTTP: delete all e import concorrenti completati')
  const receipts = expectOk(await request('/rest/v1/import_receipts?select=request_id,result_state,plan_id', { token: a.token }), 'ricevute HTTP: elenco')
  const alive = new Set(await plans(a))
  check(receipts.length > 0 && receipts.every(row => (row.result_state === 'committed') === alive.has(row.plan_id)),
    'ricevute HTTP: committed se e solo se il piano esiste')
  check(expectOk(await receipt(first.requestId, b.token), 'ricevute HTTP: B dopo delete di A').resultState === 'committed',
    'ricevute HTTP: tombstone limitato all\'account')
}
