import assert from 'node:assert/strict'
import { randomUUID,createHmac } from 'node:crypto'
import {mkdir,writeFile} from 'node:fs/promises'
import { morningLocalFixture,syntheticMorningRoutine } from './lib/morning-routine-local-fixture.mjs'
import { localDate,shiftDate } from '../src/domain/dates.ts'
import { createMorningRepository } from '../src/persistence/morning-routine-repository.ts'
import { MorningRoutineStore } from '../src/persistence/morning-routine-store.ts'
import {memoryStorage} from '../src/persistence/diary-store.ts'
const f=await morningLocalFixture(),checks=[]
const pass=label=>{checks.push(label);console.log('PASS '+label)}
try{
 const {a,b}=f,doc=syntheticMorningRoutine(),today=localDate(),id=randomUUID()
 let result=await a.client.rpc('save_morning_routine',{p_document:doc,p_expected_revision:0,p_request_id:id});assert.ifError(result.error);assert.equal(result.data.owner_id,a.owner);assert.equal(result.data.revision,1);pass('RPC Auth reale: creazione privata e revisione iniziale')
 result=await a.client.rpc('save_morning_routine',{p_document:doc,p_expected_revision:0,p_request_id:id});assert.ifError(result.error);assert.equal(result.data.revision,1);pass('Retry idempotente senza doppia revisione')
 result=await a.client.rpc('save_morning_routine',{p_document:{...doc,title:'Diversa'},p_expected_revision:0,p_request_id:id});assert.ok(result.error);pass('Identità richiesta riutilizzata con contenuto diverso respinta')
 result=await a.client.rpc('save_morning_routine',{p_document:doc,p_expected_revision:0,p_request_id:randomUUID()});assert.equal(result.error.code,'PT409');pass('Concorrenza: revisione obsoleta respinta')
 for(const [table,payload] of [['morning_routines',{owner_id:a.owner,document:doc,last_request_id:randomUUID()}],['morning_routine_days',{owner_id:a.owner,date:today,snapshot:doc,last_request_id:randomUUID(),completed_at:new Date().toISOString()}]]){
  const read=await b.client.from(table).select('*').eq('owner_id',a.owner);assert.ifError(read.error);assert.deepEqual(read.data,[])
  const direct=await b.client.from(table).insert(payload);assert.ok(direct.error);pass(`${table}: B non legge A e non scrive direttamente`)
 }
 result=await b.client.rpc('save_morning_routine',{p_document:doc,p_expected_revision:0,p_request_id:randomUUID(),p_owner_id:a.owner});assert.ok(result.error);pass('RPC non accetta proprietario arbitrario')
 const dayId=randomUUID();result=await a.client.rpc('set_morning_routine_day',{p_date:today,p_snapshot:doc,p_expected_revision:0,p_request_id:dayId});assert.ifError(result.error);assert.equal(result.data.snapshot.title,doc.title);pass('Completamento datato con snapshot')
 result=await a.client.rpc('set_morning_routine_day',{p_date:today,p_snapshot:doc,p_expected_revision:0,p_request_id:dayId});assert.ifError(result.error);assert.equal(result.data.revision,1);pass('Completamento duplicato idempotente')
 result=await a.client.rpc('set_morning_routine_day',{p_date:shiftDate(today,1),p_snapshot:doc,p_expected_revision:0,p_request_id:randomUUID()});assert.ok(result.error);pass('Completamento futuro respinto dal server')
 result=await a.client.rpc('save_morning_routine',{p_document:{...doc,title:'Aggiornata'},p_expected_revision:1,p_request_id:randomUUID()});assert.ifError(result.error)
 let remote=await createMorningRepository(a.client,a.owner).load(AbortSignal.timeout(10000));assert.equal(remote.routine.document.title,'Aggiornata');assert.equal(remote.days[0].snapshot.title,doc.title);pass('Modifica della routine non riscrive giornate completate')
 result=await a.client.rpc('set_morning_routine_day',{p_date:today,p_snapshot:null,p_expected_revision:1,p_request_id:randomUUID()});assert.ifError(result.error);assert.equal(result.data.completed_at,null);assert.equal(result.data.revision,2);pass('Annullamento persistente con revisione')
 for(const invalid of [{...doc,base:[]},{...doc,strengthDays:[2,2]},{...doc,extra:[doc.base[0]]},{...doc,base:[{...doc.base[0],minutes:0.2}]},{...doc,unexpected:true}]){
  result=await a.client.rpc('save_morning_routine',{p_document:invalid,p_expected_revision:2,p_request_id:randomUUID()});assert.ok(result.error)
 }pass('Documenti invalidi respinti: base, giorni, identità, tempi e campi extra')
 const anon=(await import('@supabase/supabase-js')).createClient(f.config.apiUrl,f.config.publicKey,{auth:{persistSession:false,autoRefreshToken:false}})
 result=await anon.from('morning_routines').select('*');assert.ok(result.error);result=await anon.rpc('save_morning_routine',{p_document:doc,p_expected_revision:0,p_request_id:randomUUID()});assert.ok(result.error);pass('Anonimo senza letture o RPC private')
 const repo=createMorningRepository(a.client,a.owner),storage=memoryStorage();let offline=false,lose=false
 const transport={load:(signal)=>offline?Promise.reject(new Error('offline')):repo.load(signal),send:async(op,signal)=>{if(offline)throw new Error('offline');const row=await repo.send(op,signal);if(lose){lose=false;throw new Error('response lost')}return row}}
 let store=new MorningRoutineStore(transport,storage,a.owner);store.start();await store.synchronize();offline=true;store.complete(today,today);store.stop();store=new MorningRoutineStore(transport,storage,a.owner);store.start();assert.equal(store.getSnapshot().pending,1);offline=false;lose=true;await store.synchronize();assert.equal(store.getSnapshot().pending,1);await store.synchronize();assert.equal(store.getSnapshot().pending,0);assert.ok(store.getSnapshot().days[today].snapshot);store.stop();pass('Store su RPC reali: offline, reload, risposta persa e retry senza duplicare')
 // Enroll a real TOTP factor on B; aal1 is then denied by RLS and RPC.
 const enrolled=await b.client.auth.mfa.enroll({factorType:'totp',friendlyName:'Routine test'});assert.ifError(enrolled.error)
 const secret=enrolled.data.totp.secret,alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';let bits='';for(const char of secret.replace(/=+$/,''))bits+=alphabet.indexOf(char).toString(2).padStart(5,'0')
 const bytes=Buffer.from(bits.match(/.{8}/g).map(byte=>parseInt(byte,2))),counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)))
 const hash=createHmac('sha1',bytes).update(counter).digest(),offset=hash.at(-1)&15,code=String((hash.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0')
 const challenge=await b.client.auth.mfa.challenge({factorId:enrolled.data.id});assert.ifError(challenge.error)
 const verified=await b.client.auth.mfa.verify({factorId:enrolled.data.id,challengeId:challenge.data.id,code});assert.ifError(verified.error)
 const low=(await import('@supabase/supabase-js')).createClient(f.config.apiUrl,f.config.publicKey,{auth:{persistSession:false,autoRefreshToken:false}})
 const lowSet=await low.auth.setSession({access_token:b.session.access_token,refresh_token:b.session.refresh_token});assert.ifError(lowSet.error)
 result=await low.rpc('save_morning_routine',{p_document:doc,p_expected_revision:0,p_request_id:randomUUID()});assert.ok(result.error);pass('Fattore verificato: RPC rifiuta sessione aal1')
 result=await b.client.rpc('save_morning_routine',{p_document:doc,p_expected_revision:0,p_request_id:randomUUID()});assert.ifError(result.error);pass('Sessione aal2 conserva accesso alla propria routine')
 result=await low.from('morning_routines').select('*');assert.ifError(result.error);assert.deepEqual(result.data,[]);pass('Fattore verificato: RLS nasconde dati anche del proprio account ad aal1')
 remote=await createMorningRepository(a.client,a.owner).load(AbortSignal.timeout(10000));assert.ok(remote.routine)
 await mkdir('artifacts/morning-routine-local',{recursive:true});await writeFile('artifacts/morning-routine-local/api-results.json',JSON.stringify({pass:true,checks},null,2))
 console.log(JSON.stringify({pass:true,checks:checks.length}))
}finally{await f.cleanup()}
