import assert from 'node:assert/strict'
import { randomUUID,randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import { readLocalStatus } from './local-supabase.mjs'

export function syntheticMorningRoutine(){
 const item=(index,minutes)=>({id:randomUUID(),name:'Movimento sintetico '+index,area:'Mobilità',dose:'6 rip.',minutes,note:'Istruzioni sintetiche '+index})
 return {title:'Routine sintetica',base:[1,2,2,2,1,1,1].map((minutes,i)=>item(i+1,minutes)),extra:[item(8,2),item(9,2)],strengthDays:[2,4,6],note:'Indicazioni sintetiche'}
}
export async function morningLocalFixture(){
 const config=readLocalStatus();assert.match(config.apiUrl,/^http:\/\/(127\.0\.0\.1|localhost):/)
 const admin=createClient(config.apiUrl,config.adminKey,{auth:{persistSession:false,autoRefreshToken:false}}),owners=[]
 const cleanup=async()=>{for(const owner of owners){const result=await admin.auth.admin.deleteUser(owner);assert.ifError(result.error)}}
 const account=async()=>{
  const email=`morning-${randomUUID()}@example.invalid`,password=`Aa1!${randomBytes(18).toString('hex')}`
  const result=await admin.auth.admin.createUser({email,password,email_confirm:true});assert.ifError(result.error);owners.push(result.data.user.id)
  const client=createClient(config.apiUrl,config.publicKey,{auth:{persistSession:false,autoRefreshToken:false}})
  const login=await client.auth.signInWithPassword({email,password});assert.ifError(login.error)
  return {owner:result.data.user.id,client,session:login.data.session}
 }
 try{return {config,admin,a:await account(),b:await account(),cleanup}}catch(error){await cleanup();throw error}
}
