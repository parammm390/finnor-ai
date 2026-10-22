"use client"
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {z} from 'zod'
import {useCentropyAuth} from '../lib/centropy-auth'
import {centropyGet,centropyPost,CentropyApiError} from '../lib/api'
const paths={
 submit:'response-model-submit',list:'response-model-list',read:'response-model-read',admit:'response-model-admit',
 resume:'response-model-resume',cancel:'response-model-cancel',artifact:'response-model-artifact',compare:'response-model-compare',
 forecast:'response-forecast',programme:'response-programme',use:'response-use-read',useResume:'response-use-resume',useCancel:'response-use-cancel',
} as const
type Operation=keyof typeof paths
type Original={scope:string;operation:Operation;body:Record<string,unknown>;expiresAt:number}
// Memory-only uncertain requests survive token remounts, never a different
// canonical principal/tenant/root/Work. No credentials or results are retained.
const originals=new Map<string,Original>()
function original(scope:string){
 for(const [key,value] of originals)if(value.expiresAt<=Date.now())originals.delete(key)
 return originals.get(scope)??null
}
const Root=z.object({entityType:z.string(),entityId:z.string().uuid()})
const Projection=z.object({modelId:z.string().uuid(),tenantId:z.string().uuid(),principalId:z.string().uuid(),workId:z.string().uuid(),
 workInputId:z.string().uuid(),root:Root,status:z.string(),generation:z.number().int(),current:z.boolean(),currentnessReasons:z.array(z.string()),
 artifact:z.unknown().nullable(),admission:z.unknown().nullable(),fallbackId:z.string().nullable(),resumable:z.boolean(),
 uses:z.array(z.object({id:z.string().uuid(),requested_model_id:z.string().uuid(),kind:z.string(),status:z.string()})),
 events:z.array(z.unknown()),counters:z.object({episodeId:z.string(),attempts:z.number(),maxAttempts:z.number(),uses:z.number(),maxUses:z.number(),
  retainedBytes:z.string(),semanticApplicationsOccupied:z.string(),deadlineAt:z.string()}),
 protectedQualification:z.literal(false),productionActivated:z.literal(false),externalEffectsSupported:z.literal(false),financialEfficacyEstablished:z.literal(false)})
const Use=z.object({modelId:z.string().uuid(),useId:z.string().uuid(),tenantId:z.string().uuid(),principalId:z.string().uuid(),
 workId:z.string().uuid(),root:Root,kind:z.string(),status:z.string(),current:z.boolean(),resumable:z.boolean(),artifact:z.unknown().nullable(),
 check:z.unknown().nullable(),executionAuthorityGranted:z.literal(false)}).passthrough()
type View=z.infer<typeof Projection>
const pretty=(v:unknown)=>JSON.stringify(v,null,2)
export function StrategicResponsePanel({root,workId}:{root:{entityType:string;entityId:string};workId:string|null}){
 const {session}=useCentropyAuth(),logical=JSON.stringify([session?.user.id??null,root.entityType,root.entityId,workId]),
  identity=JSON.stringify([logical,session?.access_token??null])
 const identityRef=useRef(identity);identityRef.current=identity
 const epoch=useRef(0),selected=useRef(''),inspected=useRef(''),busyRef=useRef(false),pending=useRef<Original|null>(null)
 const [actor,setActor]=useState<{identity:string;scope:string;tenantId:string;principalId:string}|null>(null),
  [display,setDisplay]=useState<{identity:string;value:View}|null>(null),[formIdentity,setFormIdentity]=useState(identity),
  [rows,setRows]=useState<{identity:string;items:Array<{id:string;status:string}>}|null>(null),
  [response,setResponse]=useState<{identity:string;value:unknown}|null>(null),
  [use,setUse]=useState<{identity:string;value:z.infer<typeof Use>}|null>(null),
  [message,setMessage]=useState('Select exact Work to learn and inspect strategic responses.'),[busy,setBusy]=useState(false),
  [problem,setProblem]=useState(''),[forecast,setForecast]=useState(''),[decision,setDecision]=useState('')
 const visible=display?.identity===identity?display.value:null,visibleUse=use?.identity===identity?use.value:null,
  enabled=!!session&&!!workId&&formIdentity===identity&&actor?.identity===identity
 const refresh=useCallback(async(sequence:number,preferred?:string)=>{
  if(!session||!workId)return
  const expected=identity,current=()=>identityRef.current===expected&&epoch.current===sequence
  try{
   const me=await centropyGet<{tenantId:string;userId:string;employeeId:string|null}>('me')
   if(!current())return
   if(!me.tenantId||!me.userId)throw Error('Current canonical actor unavailable')
   const principalId=me.employeeId??me.userId,scope=JSON.stringify([logical,me.tenantId,principalId])
   pending.current=original(scope);setActor({identity:expected,scope,tenantId:me.tenantId,principalId})
   const list=z.object({workId:z.string(),root:Root,models:z.array(z.object({id:z.string().uuid(),status:z.string()})),truncated:z.boolean()})
    .parse(await centropyPost('company-brain/'+paths.list,{root,workId}))
   if(!current())return
   if(list.workId!==workId||list.root.entityId!==root.entityId||list.root.entityType!==root.entityType)throw Error('Response list scope changed')
   setRows({identity:expected,items:list.models})
   const id=preferred||selected.current||list.models[0]?.id
   if(!id){inspected.current='';setDisplay(null);setUse(null);setResponse(null);setMessage('No response model is registered for this Work. Supply canonical joint evidence and public rule meanings.');return}
   if(id!==selected.current){inspected.current='';setUse(null);setResponse(null)}
   const useId=inspected.current
   const view=Projection.parse(await centropyPost('company-brain/'+paths.read,{modelId:id}))
   if(!current())return
   if(view.tenantId!==me.tenantId||view.principalId!==principalId||view.workId!==workId||
    view.root.entityId!==root.entityId||view.root.entityType!==root.entityType)throw Error('Response model scope changed')
   if(useId){
    const currentUse=Use.parse(await centropyPost('company-brain/'+paths.use,{modelId:id,useId}))
    if(!current()||inspected.current!==useId)return
    if(currentUse.modelId!==id||currentUse.useId!==useId||currentUse.tenantId!==me.tenantId||
     currentUse.principalId!==principalId||currentUse.workId!==workId||currentUse.root.entityId!==root.entityId||
     currentUse.root.entityType!==root.entityType)throw Error('Original use scope changed')
    setUse({identity:expected,value:currentUse.current?currentUse:{...currentUse,artifact:null,check:null}})
    if(!currentUse.current)setResponse(null)
   }
   selected.current=id;setDisplay({identity:expected,value:view})
   setMessage(view.current?`${view.status}. Conditional finite model set. Field identification, protected qualification and financial efficacy remain unestablished.`
    :`${view.status}. New use is fenced. ${view.currentnessReasons.join(', ')}. Prior commitments remain.`)
  }catch{if(current()){setActor(null);setDisplay(null);setRows(null);setUse(null);setResponse(null);setMessage('Current identity, rights or Work could not be verified. Reload before acting.')}}
 },[identity,logical,session,workId,root])
 useEffect(()=>{
  const fence=epoch,sequence=++fence.current;selected.current='';inspected.current='';pending.current=null;busyRef.current=false
  setActor(null);setDisplay(null);setRows(null);setUse(null);setResponse(null);setBusy(false)
  setProblem('');setForecast('');setDecision('');setFormIdentity(identity)
  void refresh(sequence)
  return()=>{fence.current++}
  // Private fields disappear synchronously on identity mismatch, before effects.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[identity])
 useEffect(()=>{
  if(!session||!workId)return
  const poll=()=>{if(!busyRef.current&&document.visibilityState==='visible')void refresh(++epoch.current)}
  const focus=()=>{if(!busyRef.current){setDisplay(null);setUse(null);setResponse(null);void refresh(++epoch.current)}}
  const timer=setInterval(poll,4000);window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus)
  return()=>{clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus)}
 },[refresh,session,workId])
 async function act(operation:Operation,body:Record<string,unknown>,mutation=true,retry=false){
  if(!enabled||!actor||busyRef.current)return
  if(mutation&&pending.current&&!retry){setMessage('Resolve the uncertain original request before starting another mutation.');return}
  if(retry&&pending.current?.scope!==actor.scope)return
  const op=retry?pending.current!.operation:operation,input=retry?pending.current!.body:body,
   expected=identity,sequence=++epoch.current,current=()=>identityRef.current===expected&&epoch.current===sequence,oldId=selected.current
  if(mutation&&!retry){
   original(actor.scope)
   if(originals.size>=4&&!originals.has(actor.scope)||new TextEncoder().encode(JSON.stringify(input)).byteLength>2097152){
    setMessage('Resolve an uncertain original request before occupying more local request storage.');return
   }
   pending.current={scope:actor.scope,operation:op,body:input,expiresAt:Math.min(Date.now()+900000,visible?Date.parse(visible.counters.deadlineAt):Infinity)}
   originals.set(actor.scope,pending.current)
  }
  const request=mutation?pending.current:null
  busyRef.current=true;setBusy(true);setResponse(null)
  if(op==='cancel'){inspected.current='';setDisplay(null);setUse(null)}
  try{
   const value=await centropyPost<unknown>('company-brain/'+paths[op],input)
   if(!current())return
   if(request&&originals.get(request.scope)===request)originals.delete(request.scope)
   if(mutation)pending.current=null
   if(op==='use'){
    const v=Use.parse(value)
    if(v.modelId!==oldId||v.useId!==input.useId||v.tenantId!==actor.tenantId||v.principalId!==actor.principalId||v.workId!==workId||
     v.root.entityId!==root.entityId||v.root.entityType!==root.entityType)throw Error('Original use scope changed')
    inspected.current=v.useId;setUse({identity:expected,value:v.current?v:{...v,artifact:null,check:null}})
   }
   if(op==='artifact'){
    const file=z.object({modelId:z.string(),workId:z.string(),root:Root,current:z.literal(true),fileName:z.string(),sha256:z.string(),bytesBase64:z.string()}).parse(value)
    if(file.modelId!==oldId||file.workId!==workId||file.root.entityId!==root.entityId||file.root.entityType!==root.entityType||
     !/^strategic-response-model-[a-f0-9-]+\.json$/.test(file.fileName))throw Error('Download scope changed')
    const bytes=Uint8Array.from(atob(file.bytesBase64),c=>c.charCodeAt(0)),
     sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(v=>v.toString(16).padStart(2,'0')).join('')
    if(!current())return
    if(sha!==file.sha256)throw Error('Download preimage changed')
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/json'})),link=document.createElement('a')
    link.href=url;link.download=file.fileName;link.click();URL.revokeObjectURL(url)
   }else if(op!=='use')setResponse({identity:expected,value})
   const record=value&&typeof value==='object'?value as Record<string,unknown>:null
   await refresh(sequence,op==='submit'&&typeof record?.modelId==='string'?record.modelId:oldId)
  }catch(error){if(current()){
   const scopeChanged=error instanceof CentropyApiError&&error.details!==null&&typeof error.details==='object'&&
    'code' in error.details&&error.details.code==='AUTHENTICATED_SCOPE_CHANGED'
   if(request&&!scopeChanged&&error instanceof CentropyApiError&&error.status>=400&&error.status<500&&![401,408,429].includes(error.status)){
    if(originals.get(request.scope)===request)originals.delete(request.scope);pending.current=null
   }
   setDisplay(null);setUse(null);setResponse(null);setMessage(error instanceof Error?error.message:'Owner response unavailable. Original server work may remain durable.')
  }}finally{if(current()){busyRef.current=false;setBusy(false)}}
 }
 function form(event:FormEvent,operation:'submit'|'forecast'|'programme',text:string){
  event.preventDefault()
  try{
   const data:unknown=JSON.parse(text)
   if(!data||typeof data!=='object'||Array.isArray(data))throw Error()
   const body=operation==='submit'?{...data,schema:'finnor.strategic-response-request.v1',root,workId,
    ...(visible?{parentModelId:visible.modelId}:{}),idempotencyKey:crypto.randomUUID()}:
    {...data,modelId:visible!.modelId,idempotencyKey:crypto.randomUUID()}
   void act(operation,body)
  }catch{setMessage('Supply the strict data-only JSON object for this owner operation. No fitted coefficients or success certificate is accepted.')}
 }
 return <section className="ct-evidence" aria-label="Strategic response model" data-response-work={workId??'none'} data-response-root={`${root.entityType}:${root.entityId}`} data-response-model={visible?.modelId??'none'}>
  <h4>Strategic response model</h4>
  <p role="status" aria-live="polite">{formIdentity===identity?message:'Identity changed. Rechecking exact Work.'}</p>
  <p>Learns actor-local responses from canonical joint evidence. Keeps competing preferences, behavior and shared regimes. Predictions and programme values are conditional, not observed outcomes or execution authority.</p>
  {enabled?<><button disabled={busy} onClick={()=>{setDisplay(null);setUse(null);void refresh(++epoch.current)}}>Reload strategic response</button>
   {pending.current?.scope===actor?.scope?<div><p>An uncertain original request is retained.</p>
    <button disabled={busy} onClick={()=>{const p=pending.current;if(p)void act(p.operation,p.body,true,true)}}>Retry original response request</button>
    <button disabled={busy} onClick={()=>{originals.delete(actor!.scope);pending.current=null;setMessage('Stopped retrying locally. Server work and prior commitments remain.')}}>Stop retrying, retain commitments</button></div>:null}
   {rows?.identity===identity&&rows.items.length?<label>Response model<select value={visible?.modelId??selected.current} disabled={busy||!!pending.current}
    onChange={event=>{selected.current=event.target.value;inspected.current='';setDisplay(null);setUse(null);setResponse(null);setForecast('');setDecision('');void refresh(++epoch.current,event.target.value)}}>
    {rows.items.map(row=><option key={row.id} value={row.id}>{row.id} · {row.status}</option>)}</select></label>:null}
   <details><summary>Learn from canonical joint evidence</summary><form onSubmit={e=>form(e,'submit',problem)}>
    <label>Response problem and evidence pin JSON<textarea value={problem} onChange={e=>setProblem(e.target.value)} required rows={8} maxLength={1900000} spellCheck={false}/></label>
    <p>Supply problem and evidence. Canonical source version must bind private-information boundaries, observations, public rules, payoff dimensions and transport assumptions. Requested experiments are not observations.</p>
    <button disabled={busy}>Queue response learning{visible?', original episode':''}</button>
   </form></details>
  </>:null}
  {visible?<><p>{visible.status} · {visible.current?'current':'not current'} · fit attempts {visible.counters.attempts}/{visible.counters.maxAttempts} · uses {visible.counters.uses}/{visible.counters.maxUses}. Original deadline {visible.counters.deadlineAt}.</p>
   <details><summary>Learned alternatives, independent checks and envelope</summary><pre>{pretty(visible.artifact)}</pre></details>
   <details><summary>Response attempts, invalidation and cost history</summary><pre>{pretty(visible.events)}</pre></details>
   {enabled?<><button disabled={busy} onClick={()=>void act('cancel',{modelId:visible.modelId})}>Cancel new response use, retain commitments</button>
    {visible.resumable?<button disabled={busy} onClick={()=>void act('resume',{modelId:visible.modelId})}>Resume original response learning</button>:null}
    {visible.current&&visible.status==='CHECKED'?<>
     <button disabled={busy} onClick={()=>void act('artifact',{modelId:visible.modelId},false)}>Download checked response artifact</button>
     {!visible.admission?<button disabled={busy} onClick={()=>void act('admit',{modelId:visible.modelId})}>Request response model-set development admission</button>:null}
    </>:null}
    {visible.current&&(visible.admission||visible.fallbackId)?<>
     <form onSubmit={e=>form(e,'forecast',forecast)}><label>Joint forecast query JSON<textarea rows={5} value={forecast} onChange={e=>setForecast(e.target.value)} required maxLength={1000000}/></label>
      <button disabled={busy}>Queue coupled strategic prediction</button></form>
     <form onSubmit={e=>form(e,'programme',decision)}><label>Original S4 mandate, problem, query and action rules JSON<textarea rows={7} value={decision} onChange={e=>setDecision(e.target.value)} required maxLength={1900000}/></label>
      <button disabled={busy}>Queue checked S4 strategic programme</button></form>
    </>:null}
    <button disabled={busy} onClick={()=>void act('compare',{modelId:visible.modelId},false)}>Inspect executable response fallback</button>
    {visible.uses.filter(u=>u.requested_model_id===visible.modelId).map(u=><button key={u.id} disabled={busy} onClick={()=>void act('use',{modelId:visible.modelId,useId:u.id},false)}>Inspect {u.kind.toLowerCase()} {u.id} · {u.status}</button>)}
   </>:null}
  </>:null}
  {visibleUse?<div><p>Original {visibleUse.kind.toLowerCase()} use: {visibleUse.status}. No external effect authority.</p>
   <pre>{pretty(visibleUse)}</pre>
   {enabled&&visibleUse.resumable?<button disabled={busy} onClick={()=>void act('useResume',{modelId:visibleUse.modelId,useId:visibleUse.useId})}>Resume original response use</button>:null}
   {enabled?<button disabled={busy} onClick={()=>void act('useCancel',{modelId:visibleUse.modelId,useId:visibleUse.useId})}>Cancel new programme use, retain commitments</button>:null}
  </div>:null}
  {response?.identity===identity?<details open><summary>Exact strategic owner response</summary><pre>{pretty(response.value)}</pre></details>:null}
 </section>
}
