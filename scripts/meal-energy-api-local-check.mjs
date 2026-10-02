// Solo Supabase locale, sessioni sintetiche A/B; mai token o credenziali nell'output.
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createClient} from '@supabase/supabase-js'
import {readLocalStatus} from './lib/local-supabase.mjs'
import {createPlansRepository,PlansFailure} from '../src/persistence/plans-repository.ts'
import {newMealPlan,newPlanDay,newPlanMeal,mealFromPlan} from '../src/domain/meal-plans.ts'
import {mealLogFromRow} from '../src/persistence/diary-repository.ts'
import {dailyEnergyBudget} from '../src/domain/food-energy.ts'
const config=readLocalStatus(),users=[],checks=[]
const options={auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}
const admin=createClient(config.apiUrl,config.adminKey,options),signal=()=>AbortSignal.timeout(15000)
const pass=s=>{checks.push(s);console.log('PASS '+s)}
async function actor(){
 const email=`meal-energy-${randomUUID()}@example.invalid`,password=`Aa1!${randomUUID()}`
 const {data,error}=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.equal(error,null);users.push(data.user.id)
 const client=createClient(config.apiUrl,config.publicKey,options);assert.equal((await client.auth.signInWithPassword({email,password})).error,null)
 return {client,id:data.user.id,repo:createPlansRepository(client,data.user.id)}
}
try{
 const a=await actor(),b=await actor(),draft=newMealPlan(),day=newPlanDay([])
 draft.name='Piano energetico sintetico';draft.document={guidance:'',cycle:{start:'2026-10-02',weeks:4},dailyCalories:2000,days:[{...day,dayType:'any',meals:[{...newPlanMeal(),name:'Colazione',foods:[{name:'Prodotto sintetico',quantity:'100 g',kcalPer100g:200}]}]}]}
 const first=await a.repo.saveMealPlan(draft,null,signal());assert.deepEqual(first.document,draft.document)
 assert.deepEqual((await a.repo.mealPlan(first.id,signal())).document,draft.document)
 pass('SDK: periodo, target e valore confezione salvati e riletti')
 const snapshot=mealFromPlan(first.document.days[0].meals[0]);assert.equal(snapshot.energy.kcal,200)
 const inserted=await a.client.from('meal_logs').insert({diary_date:'2026-10-02',meal_id:snapshot.id,meal_plan_id:first.id,status:'followed',note:'',day_type:'rest',meal_snapshot:snapshot}).select().single();assert.equal(inserted.error,null)
 const log=mealLogFromRow(inserted.data).log;assert.deepEqual(log.snapshot,snapshot)
 assert.equal(dailyEnergyBudget(log.date,[snapshot],{meal:log},2000).remaining,1800)
 pass('SDK: stima e override nello snapshot, 2000 → 1800')
 const changed=structuredClone(draft);changed.document.dailyCalories=2100;changed.document.days[0].meals[0].foods[0].kcalPer100g=300
 const second=await a.repo.saveMealPlan(changed,first.revision,signal());assert.equal(second.revision,2)
 await assert.rejects(a.repo.saveMealPlan(draft,first.revision,signal()),e=>e instanceof PlansFailure&&e.kind==='conflict')
 const stored=await a.client.from('meal_logs').select().eq('meal_id',snapshot.id).single();assert.equal(stored.error,null);assert.equal(mealLogFromRow(stored.data).log.snapshot.energy.kcal,200)
 pass('SDK: conflitto revisione e snapshot invariato dopo modifica piano')
 const skipped=await a.client.from('meal_logs').update({status:'skipped',revision:2}).eq('id',inserted.data.id).select().single();assert.equal(skipped.error,null)
 assert.equal(dailyEnergyBudget(log.date,[snapshot],{meal:mealLogFromRow(skipped.data).log},2000).remaining,2000)
 pass('SDK: saltato rimuove la stima dal conteggio senza riscrivere lo snapshot')
 assert.equal(await b.repo.mealPlan(first.id,signal()),null)
 const denied=await b.client.from('meal_logs').select('id');assert.deepEqual(denied.data,[])
 const anon=createClient(config.apiUrl,config.publicKey,options);assert.ok((await anon.from('meal_plans').select('id')).error)
 pass('SDK/Auth: isolamento A/B e anonimo su periodi e calorie')
 const invalid=await a.client.from('meal_plans').update({revision:3,document:{...changed.document,dailyCalories:'2000'}}).eq('id',first.id);assert.equal(invalid.error?.code,'23514')
 const invalidSnapshot=await a.client.from('meal_logs').insert({diary_date:'2026-10-03',meal_id:snapshot.id,meal_plan_id:first.id,status:'followed',note:'',day_type:'rest',meal_snapshot:{...snapshot,energy:{version:1,missing:0}}});assert.equal(invalidSnapshot.error?.code,'23514')
 pass('SDK: contratto energetico invalido respinto dal DB')
 console.log(`PASS ${checks.length} controlli API locali`)
}finally{
 let removed=0;for(const id of users){const result=await admin.auth.admin.deleteUser(id);if(result.error)throw Error('Pulizia fixture locale fallita');removed++}
 console.log(`Fixture locali eliminate ${removed}/${users.length}`)
}
