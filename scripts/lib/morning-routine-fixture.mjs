export const morningPaths=['/rest/v1/morning_routines','/rest/v1/morning_routine_days','/rest/v1/rpc/save_morning_routine','/rest/v1/rpc/set_morning_routine_day']
export function morningFixture(request,url,state){
 state.morningRoutines??=new Map();state.morningDays??=new Map();state.morningWrites??=[]
 const authorization=Object.entries(request.headers).find(([name])=>name.toLowerCase()==='authorization')?.[1]
 const owner=JSON.parse(Buffer.from(authorization?.split('.')[1]??'','base64url').toString()).sub
 const day=url.pathname.endsWith('morning_routine_days')||url.pathname.endsWith('set_morning_routine_day')
 if(request.method==='GET'){
  if(url.searchParams.get('owner_id')!==`eq.${owner}`)state.failures.push('Filtro proprietario routine mancante')
  const rows=day?[...state.morningDays.values()].filter(row=>row.owner_id===owner):[state.morningRoutines.get(owner)].filter(Boolean)
  return {status:200,data:rows.filter(row=>!url.searchParams.get('date')?.startsWith('gt.')||row.date>url.searchParams.get('date').slice(3)).sort((a,b)=>a.date?.localeCompare(b.date??'')??0).slice(0,500)}
 }
 if(request.method!=='POST'||!url.pathname.includes('/rpc/'))return {status:403,data:{code:'42501'}}
 const body=JSON.parse(request.postData??'{}'),key=day?owner+':'+body.p_date:owner,collection=day?state.morningDays:state.morningRoutines,current=collection.get(key)
 state.morningWrites.push({path:url.pathname,owner,body})
 if(current?.last_request_id===body.p_request_id)return {status:200,data:current}
 if((current?.revision??0)!==body.p_expected_revision)return {status:409,data:{code:'PT409'}}
 const row={owner_id:owner,revision:(current?.revision??0)+1,last_request_id:body.p_request_id,...(day?{date:body.p_date,snapshot:body.p_snapshot}:{document:body.p_document})}
 collection.set(key,row)
 return {status:200,data:row}
}
