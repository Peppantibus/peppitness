import { mkdirSync, writeFileSync, readFileSync, openSync, closeSync, unlinkSync, existsSync, renameSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import {
  EVALUATION_VERSION, loadCorpus, fixture, readJson, digest, offlineConfig, recordedTransport,
  evaluateAttempt, scoreCase, summarize, modelGates, versions, validateRealConfig, reserveAttempt,
} from './lib/import-evaluation.mjs'
import { estimateCostMicros } from '../supabase/functions/_shared/import/budget.ts'

const privatePath = path => {
  const root = resolve('private-imports'), target = resolve(path)
  if (!target.startsWith(root + sep)) throw new Error('Real evaluation files must be under private-imports/')
  return target
}
function save(path, value) {
  const temporary = path + '.tmp'
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n')
  renameSync(temporary, path)
}
function safeAttempt(attempt, price, reserve) {
  const known = attempt.usage?.inputTokens != null && attempt.usage?.outputTokens != null
  return { status: attempt.status, delivery: attempt.delivery ?? 'received', model: attempt.model, usage: attempt.usage,
    latencyMs: attempt.latencyMs, retryAfterSeconds: attempt.retryAfterSeconds ?? null, costKind: known ? 'usage_at_profile_price' : 'conservative_reservation',
    accountedCostMicros: known ? estimateCostMicros(attempt.usage.inputTokens, attempt.usage.outputTokens, price.inputMicrosPerMillion, price.outputMicrosPerMillion) : reserve }
}
export function reportFor(manifest, rows, mode, metadata = {}) {
  const summary = summarize(rows)
  return {
    version: EVALUATION_VERSION, mode, result: mode === 'offline' ? 'PASS' : 'EVALUATED',
    interpretation: mode === 'offline' ? 'Offline PASS proves runner, adapter decoding and validation pipeline only. Synthetic responses, latency, tokens, prices and correction times do not establish real model quality.' : 'Real responses scored against independently annotated source truth. Zero observed errors do not guarantee future correctness.',
    corpusHash: digest(JSON.stringify(manifest)), versions: versions(), ...metadata,
    corpus: { cases: manifest.cases.length, documents: new Set(manifest.cases.map(c => fixture(c.input).sourceHash)).size,
      domains: Object.fromEntries(['workout','diet'].map(k=>[k,manifest.cases.filter(c=>c.domain===k).length])),
      split: Object.fromEntries(['development','held-out'].map(k=>[k,manifest.cases.filter(c=>c.split===k).length])),
      limitation: 'Small synthetic corpus; several fault cases share a source. No production representativeness or scan/OCR support claim.' },
    summary, releaseGates: modelGates(rows, manifest, mode),
    externalEvidence: { atomicityAuth: 'Task 24 report inspected: local real pipeline PASS 8/8, synthetic provider', retention: 'Task 23 prior real local verification; not rerun by this benchmark', iphone: 'NOT_RUN', cloud: 'NOT_CHECKED: this runner does not inspect deployed functions, secrets or cloud budget' },
    costPerAcceptedImportMicros: rows.some(r=>r.acceptedByReviewer === true) ? rows.reduce((n,r)=>n+r.attempts.reduce((s,a)=>s+a.accountedCostMicros,0),0)/rows.filter(r=>r.acceptedByReviewer===true).length : null,
    rows,
  }
}

export async function runOffline(manifest = loadCorpus()) {
  const rows = [], price = { currency:'USD', inputMicrosPerMillion:100_000, outputMicrosPerMillion:500_000, provenance:'arbitrary synthetic test prices, not an OpenAI list price' }
  for (const entry of manifest.cases) for (let repetition=1; repetition <= (entry.critical?3:1); repetition++) {
    const document=fixture(entry.input), attempts=[]
    let final
    for(const step of entry.offlineAttempts) {
      const recording=fixture(step.response)
      let clock=0
      const call=await evaluateAttempt({...entry,profile:step.profile},document,offlineConfig(),recordedTransport(recording),()=>{const t=clock;clock+=recording.latencyMs;return t})
      final=await call.send()
      assert.equal(final.status, step.expectedStatus, `${entry.id}: provider status`)
      const reserve=reserveAttempt({framingTokens:1024,maxInputTokens:200_000,maxCalls:250,maxSpendMicros:2_000_000},call.prepared,price,0,0)
      attempts.push(safeAttempt(final,price,reserve))
    }
    const score=scoreCase(entry,document,final.data,final.status)
    if(entry.offlineExpectedValidation) assert.deepEqual(score.validation,entry.offlineExpectedValidation,`${entry.id}: recorded validation`)
    rows.push({id:entry.id,split:entry.split,domain:entry.domain,repetition,readerVersion:document.readerVersion,attempts,score,correctionSeconds:entry.annotation.offlineCorrectionSeconds,acceptedByReviewer:null})
  }
  return reportFor(manifest,rows,'offline',{priceProfile:price,model:'synthetic-evaluation-v1',network:'ZERO: injected recording transport; global fetch not used',timing:'deterministic simulated milliseconds; correction seconds manually estimated'})
}

/** Lock and pessimistic journal cover all candidate runs sharing an authorization, across restarts. */
export async function runReal(manifest, config, env, output) {
  const {provider,price}=validateRealConfig(config,env)
  const authorization=config.authorization.reference
  const journalPath=privatePath(`private-imports/evaluation/budget-${digest(authorization)}.json`)
  mkdirSync(resolve('private-imports/evaluation'),{recursive:true})
  const lockPath=journalPath+'.lock', lock=openSync(lockPath,'wx')
  try {
    let journal=existsSync(journalPath)?readJson(journalPath):{authorizationDigest:digest(authorization),ceiling:config.maxSpendMicros,callCeiling:config.maxCalls,spentMicros:0,calls:0}
    if(journal.ceiling!==config.maxSpendMicros || journal.callCeiling!==config.maxCalls) throw new Error('Budget ceilings cannot change within an authorization')
    const rows=[], raw={mode:'real',corpusHash:digest(JSON.stringify(manifest)),versions:versions(),model:provider.profiles.standard.model,priceProfile:price,rows}
    if(existsSync(output)) throw new Error('Refusing to overwrite real evaluation records')
    save(output,raw)
    for(const entry of manifest.cases) for(let repetition=1;repetition <= (entry.critical?config.criticalRepetitions:1);repetition++) {
      const document=fixture(entry.input), attempts=[]
      let final
      for(let attempt=0;attempt<2;attempt++) {
        const call=await evaluateAttempt({...entry,profile:attempt?'retry':'standard'},document,provider)
        const reserve=reserveAttempt(config,call.prepared,price,journal.spentMicros,journal.calls)
        journal.spentMicros+=reserve;journal.calls++
        // Persist BEFORE dispatch; crash/timeout leaves the reservation charged. No auto refund.
        save(journalPath,journal)
        final=await call.send()
        const recorded=safeAttempt(final,price,reserve)
        journal.spentMicros+=recorded.accountedCostMicros-reserve
        save(journalPath,journal)
        attempts.push(recorded)
        // Persist each paid attempt immediately, even if the next retry exceeds budget.
        if(!attempt) rows.push({id:entry.id,split:entry.split,domain:entry.domain,repetition,readerVersion:document.readerVersion,attempts,correctionSeconds:null,acceptedByReviewer:null})
        Object.assign(rows.at(-1),{data:final.data,status:final.status,score:scoreCase(entry,document,final.data,final.status)})
        save(output,raw)
        if(journal.spentMicros>config.maxSpendMicros) throw new Error('Observed cost exceeded reserved estimate; stopped')
        const wait=final.retryAfterSeconds??0
        const retry=final.delivery!=='uncertain' && (['rate_limited','server_error','invalid_output'].includes(final.status) || final.status==='incomplete')
        if(!retry || attempt || wait>10) break
        if(wait) await new Promise(r=>setTimeout(r,wait*1000))
      }
    }
    return reportFor(manifest,rows,'real',{model:raw.model,priceProfile:price,budget:{authorizationDigest:journal.authorizationDigest,spentMicros:journal.spentMicros,calls:journal.calls},providerModelDrift:rows.some(r=>r.attempts.some(a=>a.model!==raw.model))})
  } finally { closeSync(lock);unlinkSync(lockPath) }
}

export function scoreRealRecords(manifest, records) {
  if(records.mode!=='real' || records.corpusHash!==digest(JSON.stringify(manifest)) || JSON.stringify(records.versions)!==JSON.stringify(versions())) throw new Error('Real records/corpus/version mismatch')
  const seen=new Set()
  const rows=records.rows.map(row=>{
    const entry=manifest.cases.find(c=>c.id===row.id), key=`${row.id}:${row.repetition}`
    if(!entry || seen.has(key) || !Number.isSafeInteger(row.repetition) || row.repetition<1 || !row.attempts?.length || row.attempts.length>2) throw new Error('Invalid recorded case/repetition')
    seen.add(key)
    if(row.correctionSeconds!==null && (!Number.isFinite(row.correctionSeconds)||row.correctionSeconds<0)) throw new Error('Invalid manual correction time')
    if(row.acceptedByReviewer!==null && typeof row.acceptedByReviewer!=='boolean') throw new Error('Invalid manual acceptance annotation')
    return {...row,split:entry.split,domain:entry.domain,score:scoreCase(entry,fixture(entry.input),row.data,row.status)}
  })
  return reportFor(manifest,rows,'real',{model:records.model,priceProfile:records.priceProfile,providerModelDrift:rows.some(r=>r.attempts.some(a=>a.model!==records.model))})
}

export function compareReports(reports) {
  if(reports.length<2) throw new Error('Comparison needs at least two authorized candidates')
  const baseline=reports[0]
  if(reports.some(r=>r.corpusHash!==baseline.corpusHash || JSON.stringify(r.versions)!==JSON.stringify(baseline.versions))) throw new Error('Candidate corpus/version mismatch')
  const candidates=reports.map(r=>({model:r.model,eligible:r.mode==='real' && !r.providerModelDrift &&
    ['realCorpus','noUnflaggedCriticalErrors','noUnflaggedOmissions','reviewAvailable','manualCorrectionMeasured'].every(g=>r.releaseGates[g]==='PASS') &&
    r.costPerAcceptedImportMicros !== null && r.rows.every(row=>row.attempts.every(a=>a.costKind==='usage_at_profile_price')),
    costPerAcceptedImportMicros:r.costPerAcceptedImportMicros,summary:r.summary}))
  const eligible=candidates.filter(c=>c.eligible).sort((a,b)=>a.costPerAcceptedImportMicros-b.costPerAcceptedImportMicros)
  return {result:eligible.length?'CANDIDATE_SELECTED':'OPEN',chosenModel:eligible[0]?.model??null,candidates,release:'Still requires iPhone, authorized cloud configuration/deployment and smoke tests. Model comparison does not close these gates.'}
}

export async function main(args=process.argv.slice(2)) {
  const modes=['--offline','--real','--score-real','--compare']
  const chosen=modes.filter(m=>args.includes(m))
  if(chosen.length!==1) throw new Error('Choose exactly one mode: --offline | --real --config private-imports/... | --score-real --records private-imports/... | --compare private report paths')
  const option=name=>{const i=args.indexOf(name);if(i<0)return null;if(!args[i+1]||args[i+1].startsWith('--'))throw new Error('Missing option value');return args[i+1]}
  const manifest=loadCorpus(),mode=chosen[0]
  if(args[0]!==mode) throw new Error('Mode must be the first argument')
  if(mode!=='--compare' && mode!=='--offline') {
    const required=mode==='--real'?'--config':'--records'
    const seen=new Set()
    for(let i=1;i<args.length;i+=2) {
      if(![required,'--output'].includes(args[i]) || seen.has(args[i]) || !args[i+1] || args[i+1].startsWith('--')) throw new Error('Invalid or duplicate evaluation option')
      seen.add(args[i])
    }
    if(!seen.has(required)) throw new Error('Required configuration/records option missing')
  }
  let report,output
  if(mode==='--offline') {
    if(args.length!==1) throw new Error('Offline takes no secrets/configuration/options')
    output=resolve('artifacts/import-evaluation/report.json');mkdirSync(resolve('artifacts/import-evaluation'),{recursive:true})
    const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Offline network forbidden')}
    try {report=await runOffline(manifest)} finally {globalThis.fetch=original}
  } else if(mode==='--real') {
    const config=readJson(privatePath(option('--config')??''))
    validateRealConfig(config,process.env)
    output=privatePath(option('--output')??'private-imports/evaluation/report.json');mkdirSync(resolve(output,'..'),{recursive:true})
    report=await runReal(manifest,config,process.env,privatePath(output.replace(/\.json$/, '')+'.records.json'))
  } else if(mode==='--score-real') {
    output=privatePath(option('--output')??'private-imports/evaluation/report.json');mkdirSync(resolve(output,'..'),{recursive:true})
    report=scoreRealRecords(manifest,readJson(privatePath(option('--records')??'')))
  } else {
    report=compareReports(args.slice(1).map(p=>readJson(privatePath(p))))
    output=privatePath('private-imports/evaluation/comparison.json');mkdirSync(resolve(output,'..'),{recursive:true})
  }
  save(output,report)
  console.log(JSON.stringify({mode,result:report.result,output,modelGates:report.releaseGates??report.chosenModel}))
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main().catch(()=>{console.error('FAIL: evaluation stopped; verify mode, corpus, authorization/configuration and private budget journal. No secrets or provider payload logged.');process.exitCode=1})
