import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { prepareImportJob, parseServerJob } from '../../supabase/functions/_shared/import/jobs.ts'
import { parseBudgetReservation } from '../../supabase/functions/_shared/import/budget.ts'
import { sha256Hex } from '../../supabase/functions/_shared/import/canonical.ts'
import { importLocalSql, sqlLiteral as lit } from './import-local-db.mjs'

/** SQL admin solo per configurazione/cleanup sintetici non esposti come RPC.
 * Rifiuta una configurazione reale o un ledger preesistente, non li sovrascrive.
 * Le prenotazioni, i replay e la concorrenza sotto test passano tutti via HTTP.
 */
export async function importBudgetApiChecks(context, a, b) {
  const { request, check, expectOk, expectDenied, concurrentRequests } = context
  const rpc = (name, body, token, admin = false) => request(`/rest/v1/rpc/${name}`, { method: 'POST', body, token, admin })
  const server = (name, body) => rpc(name, body, undefined, true)
  const marker = `budget-http/${randomUUID()}`
  const original = (await importLocalSql('select to_jsonb(c) as config from peppitness_private.import_budget_config c where singleton'))[0]?.config
  check(original && original.enabled === false && original.provider === null, 'budget HTTP: configurazione locale disabilitata senza provider reale')
  const ownerList = [a.id, b.id].map(lit).join(',')
  const baseline = lit(JSON.stringify(original))
  try {
    await importLocalSql(`do $fixture$ begin
      perform 1 from peppitness_private.import_budget_config where singleton for update;
      if not exists(select 1 from peppitness_private.import_budget_config c where to_jsonb(c)=${baseline}::jsonb)
        or exists(select 1 from peppitness_private.import_usage_ledger)
        or exists(select 1 from peppitness_private.import_budget_retired) then
        raise exception 'Budget HTTP fixture requires pristine disabled local configuration';
      end if;
      update peppitness_private.import_budget_config set enabled=true,config_version=${lit(marker)},price_version='synthetic/1',
        provider='synthetic',model='budget-http-test',currency='USD',project_limit_micros=30,account_limit_micros=30,
        input_micros_per_million=1000000,output_micros_per_million=1000000,max_active_per_account=1,daily_analyses=5,
        max_attempts=2,max_input_tokens=1000,max_output_tokens=10,framing_tokens=0 where singleton;
    end $fixture$`)
    const input = { kind: 'workout', expectedSchemaVersion: '1.0', normalizedDocument: JSON.parse(readFileSync(new URL('../../tests/fixtures/import/documents/workout-incomplete.json', import.meta.url), 'utf8')) }
    const profile = { promptVersion: marker, rulesVersion: 'synthetic/1', provider: 'synthetic', model: 'budget-http-test' }
    const actors = [a, b]
    const jobs = []
    for (const actor of actors) jobs.push(parseServerJob(expectOk(await server('create_import_job', await prepareImportJob(actor.id, { ...input, analysisRequestId: randomUUID() }, profile)), 'budget HTTP: job sintetico')))
    const body = '"12345678"' // 10 byte, nessun invio a provider.
    const requestHash = await sha256Hex(body)
    const args = jobs.map((job, index) => ({ p_owner_id: actors[index].id, p_job_id: job.job.jobId, p_reservation_id: randomUUID(),
      p_expected_revision: job.revision, p_request_hash: requestHash, p_input_bytes: 10, p_max_output_tokens: 10, p_retry: false }))
    for (const actor of actors) {
      expectDenied(await rpc('get_import_budget_config', {}, actor.token), 'budget HTTP: client non legge config')
      expectDenied(await rpc('reserve_import_budget', args[0], actor.token), 'budget HTTP: client non prenota o sceglie quota')
      expectDenied(await rpc('dispatch_import_attempt', { p_owner_id: a.id, p_reservation_id: args[0].p_reservation_id }, actor.token), 'budget HTTP: client non autorizza invio')
    }
    expectDenied(await rpc('get_import_budget_config', {}), 'budget HTTP: config anonima respinta')
    const raced = await concurrentRequests(args.map(item => server('reserve_import_budget', item)))
    check(raced.filter(x => x.ok).length === 1 && raced.filter(x => x.status === 429 && x.data?.message === 'Import project budget exhausted').length === 1,
      'budget HTTP: due account concorrenti, tetto 30 non supera due riserve da 20')
    const winner = raced[0].ok ? 0 : 1, loser = 1 - winner
    const owner = actors[winner].id, reservationId = args[winner].p_reservation_id
    const reserved = parseBudgetReservation(expectOk(raced[winner], 'budget HTTP: prenotazione vincente'))
    check(reserved.reservedMicros === 20 && !reserved.sendGranted && reserved.attempt === null, 'budget HTTP: riserva senza chiamata')
    const replay = parseBudgetReservation(expectOk(await server('reserve_import_budget', args[winner]), 'budget HTTP: replay riserva'))
    check(replay.reservationId === reservationId && replay.reservedMicros === 20, 'budget HTTP: replay senza doppio budget')
    const dispatchArgs = { p_owner_id: owner, p_reservation_id: reservationId }
    const dispatches = await concurrentRequests([server('dispatch_import_attempt', dispatchArgs), server('dispatch_import_attempt', dispatchArgs)])
    const permissions = dispatches.map(x => parseBudgetReservation(expectOk(x, 'budget HTTP: dispatch concorrente')))
    check(permissions.filter(x => x.sendGranted).length === 1 && permissions.every(x => x.attempt === 1), 'budget HTTP: un solo permesso di invio fra due tab')
    const usage = { inputTokens: null, outputTokens: null, reasoningTokens: null }
    const uncertain = parseBudgetReservation(expectOk(await server('reconcile_import_usage', { ...dispatchArgs, p_outcome: 'uncertain', p_usage: usage }), 'budget HTTP: timeout simulato dopo permesso'))
    check(uncertain.actualMicros === null && uncertain.reservedMicros === 20, 'budget HTTP: timeout mantiene riserva, non zero')
    const stillBlocked = await server('reserve_import_budget', args[loser])
    check(stillBlocked.status === 429 && stillBlocked.data?.message === 'Import project budget exhausted', 'budget HTTP: incertezza impedisce overbooking')
    const settlement = { ...dispatchArgs, p_outcome: 'known', p_usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 1 } }
    for (let i = 0; i < 2; i++) {
      const known = parseBudgetReservation(expectOk(await server('reconcile_import_usage', settlement), 'budget HTTP: riconciliazione/replay'))
      check(known.actualMicros === 2, 'budget HTTP: reasoning non sommato e nessun doppio addebito')
    }
    const secondAccount = parseBudgetReservation(expectOk(await server('reserve_import_budget', args[loser]), 'budget HTTP: disponibilita liberata solo dopo usage noto'))
    check(secondAccount.reservedMicros === 20, 'budget HTTP: noto 2 + riserva 20 entro tetto 30')
    expectOk(await server('reconcile_import_usage', { p_owner_id: actors[loser].id, p_reservation_id: secondAccount.reservationId, p_outcome: 'not_sent',
      p_usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 } }), 'budget HTTP: annulla solo riserva mai inviata')
    const fresh = parseServerJob(expectOk(await server('find_import_job', { p_owner_id: owner, p_request_id: jobs[winner].job.analysisRequestId }), 'budget HTTP: revisione corrente'))
    const retryArgs = { ...args[winner], p_reservation_id: randomUUID(), p_expected_revision: fresh.revision, p_retry: true }
    const retry = parseBudgetReservation(expectOk(await server('reserve_import_budget', retryArgs), 'budget HTTP: retry con nuova riserva'))
    const retryPermit = parseBudgetReservation(expectOk(await server('dispatch_import_attempt', { p_owner_id: owner, p_reservation_id: retry.reservationId }), 'budget HTTP: secondo invio'))
    check(retryPermit.attempt === 2, 'budget HTTP: retry conta seconda chiamata')
    const retried = parseBudgetReservation(expectOk(await server('reconcile_import_usage', { p_owner_id: owner, p_reservation_id: retry.reservationId, p_outcome: 'known',
      p_usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 } }), 'budget HTTP: esito zero noto'))
    const third = await server('reserve_import_budget', { ...retryArgs, p_reservation_id: randomUUID(), p_expected_revision: retried.job.revision })
    check(third.status === 429 && third.data?.message === 'Import attempt quota exhausted', 'budget HTTP: terza chiamata bloccata')
    await importLocalSql(`update peppitness_private.import_budget_config set enabled=false where config_version=${lit(marker)} returning singleton`)
    const disabled = await server('reserve_import_budget', { ...args[loser], p_reservation_id: randomUUID(), p_expected_revision: secondAccount.job.revision })
    check(disabled.status === 503 && disabled.data?.message === 'Import analysis disabled', 'budget HTTP: kill switch blocca nuove chiamate')
    expectOk(await server('get_import_reservation', dispatchArgs), 'budget HTTP: lookup continua con kill switch')
    expectOk(await rpc('get_import_job', { p_job_id: jobs[winner].job.jobId }, actors[winner].token), 'budget HTTP: lettura job continua con kill switch')
  } finally {
    await importLocalSql(`do $cleanup$ begin
      perform 1 from peppitness_private.import_budget_config where singleton for update;
      if exists(select 1 from peppitness_private.import_budget_config where config_version=${lit(marker)}) then
        delete from public.import_jobs where owner_id in (${ownerList}) and versions->>'prompt'=${lit(marker)};
        if exists(select 1 from peppitness_private.import_usage_ledger) then raise exception 'Unexpected ledger during fixture cleanup'; end if;
        delete from peppitness_private.import_budget_retired;
        delete from peppitness_private.import_budget_config;
        insert into peppitness_private.import_budget_config select * from jsonb_populate_record(null::peppitness_private.import_budget_config,${baseline}::jsonb);
      end if;
    end $cleanup$`)
  }
  const restored = (await importLocalSql('select to_jsonb(c) as config from peppitness_private.import_budget_config c where singleton'))[0]?.config
  check(JSON.stringify(restored) === JSON.stringify(original), 'budget HTTP: configurazione originale ripristinata')
}
