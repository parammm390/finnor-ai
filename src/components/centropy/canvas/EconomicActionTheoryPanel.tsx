"use client"
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {z} from 'zod'
import {useCentropyAuth} from '../lib/centropy-auth'
import {CentropyApiError,centropyGet,centropyPost} from '../lib/api'
const paths={
 submit:'company-brain/economic-theory-submit',read:'company-brain/economic-theory-read',list:'company-brain/economic-theory-list',
 admit:'company-brain/economic-theory-admit',resume:'company-brain/economic-theory-resume',cancel:'company-brain/economic-theory-cancel',
 artifact:'company-brain/economic-theory-artifact',compare:'company-brain/economic-theory-compare',
 reserve:'company-brain/economic-reservation-create',reservation:'company-brain/economic-reservation-read',
 compose:'company-brain/economic-programme-create',run:'company-brain/economic-programme-run',
 programme:'company-brain/economic-programme-read',reconcile:'company-brain/economic-programme-reconcile',
} as const
type Operation=keyof typeof paths
type OriginalRequest={scope:string;operation:Operation;body:Record<string,unknown>;expiresAt:number}
// WORLD remounts its private subtree when a token changes. Keep only bounded
// uncertain invocations, never credentials or response data, across that remount.
const originalRequests=new Map<string,OriginalRequest>()
function originalRequest(scope:string){
 for(const [key,value] of originalRequests)if(value.expiresAt<=Date.now())originalRequests.delete(key)
 return originalRequests.get(scope)??null
}
const Root=z.object({entityType:z.string(),entityId:z.string().uuid()})
const Projection=z.object({theoryId:z.string().uuid(),tenantId:z.string().uuid(),principalId:z.string().uuid(),
 workId:z.string().uuid(),workInputId:z.string().uuid(),root:Root,generation:z.number().int(),status:z.string(),current:z.boolean(),
 currentnessReasons:z.array(z.string()),artifact:z.unknown().nullable(),admission:z.unknown().nullable(),fallbackId:z.string().nullable(),
 counters:z.object({episodeId:z.string(),attempts:z.number(),maxAttempts:z.number(),searchStepsOccupied:z.number(),
  semanticApplicationsOccupied:z.number(),retainedBytes:z.number(),deadlineAt:z.string()}),
 events:z.array(z.unknown()),resumable:z.boolean(),protectedQualification:z.literal(false),productionActivated:z.literal(false),
 externalEffectsSupported:z.literal(false),financialEfficacyEstablished:z.literal(false)})
type View=z.infer<typeof Projection>
const Programme=z.object({programme:z.object({id:z.string().uuid(),theoryId:z.string().uuid(),workId:z.string().uuid(),root:Root}).passthrough(),
 status:z.string(),observedGoalDigest:z.string().nullable()}).passthrough()
const pretty=(value:unknown)=>JSON.stringify(value,null,2)
export function EconomicActionTheoryPanel({root,workId}:{root:{entityType:string;entityId:string};workId:string|null}){
 const {session}=useCentropyAuth(),logical=JSON.stringify([session?.user.id??null,root.entityType,root.entityId,workId]),
  identity=JSON.stringify([logical,session?.access_token??null])
 const identityRef=useRef(identity);identityRef.current=identity
 const epoch=useRef(0),selected=useRef(''),busyRef=useRef(false),logicalRef=useRef(logical)
 const actorRef=useRef<string|null>(null),pending=useRef<OriginalRequest|null>(null)
 const [actor,setActor]=useState<{identity:string;scope:string}|null>(null),[formIdentity,setFormIdentity]=useState(identity),
  [display,setDisplay]=useState<{identity:string;value:View}|null>(null),
  [rows,setRows]=useState<{identity:string;items:Array<{id:string;status:string}>}|null>(null),
  [result,setResult]=useState<{identity:string;value:unknown}|null>(null),
  [programme,setProgramme]=useState<{identity:string;value:z.infer<typeof Programme>}|null>(null),
  [message,setMessage]=useState('Select exact Work to construct or inspect an economic theory.'),[busy,setBusy]=useState(false),
  [problem,setProblem]=useState(''),[reservation,setReservation]=useState(''),[composition,setComposition]=useState(''),
  [programmeId,setProgrammeId]=useState(''),[incumbent,setIncumbent]=useState(''),[reservationReference,setReservationReference]=useState('')
 const visible=display?.identity===identity?display.value:null,shownProgramme=programme?.identity===identity&&programme.value.programme.theoryId===visible?.theoryId?programme.value:null,
  enabled=!!session&&!!workId&&formIdentity===identity&&actor?.identity===identity
 const resetForms=()=>{setProblem('');setReservation('');setComposition('');setProgrammeId('');setIncumbent('');setReservationReference('');setProgramme(null)}
 const refresh=useCallback(async(sequence:number,preferred?:string)=>{
  if(!session||!workId)return
  const expected=identity,current=()=>identityRef.current===expected&&epoch.current===sequence
  try{
   const me=await centropyGet<{tenantId:string;userId:string;employeeId:string|null}>('me')
   if(!current())return
   if(!me.tenantId||!me.userId)throw Error('Y1_ACTOR_UNAVAILABLE')
   const scope=JSON.stringify([logical,me.tenantId,me.userId,me.employeeId])
   if(actorRef.current!==null&&actorRef.current!==scope){pending.current=null;selected.current='';setDisplay(null);setResult(null);resetForms()}
   pending.current=originalRequest(scope)
   actorRef.current=scope;setActor({identity:expected,scope})
   const list=z.object({workId:z.string().uuid(),root:Root,theories:z.array(z.object({id:z.string().uuid(),status:z.string()})),truncated:z.boolean()})
    .parse(await centropyPost(paths.list,{root,workId}))
   if(!current())return
   if(list.workId!==workId||list.root.entityId!==root.entityId||list.root.entityType!==root.entityType)throw Error('Y1_LIST_SCOPE')
   setRows({identity:expected,items:list.theories})
   const id=preferred||selected.current||list.theories[0]?.id
   if(!id){setDisplay(null);setMessage('No theory is registered. Supply canonical meanings and bounded transition observations, not executable operators.');return}
   const view=Projection.parse(await centropyPost(paths.read,{theoryId:id}))
   if(!current())return
   if(view.tenantId!==me.tenantId||view.principalId!==(me.employeeId??me.userId)||view.workId!==workId||
    view.root.entityId!==root.entityId||view.root.entityType!==root.entityType)throw Error('Y1_THEORY_SCOPE')
   selected.current=id;setDisplay({identity:expected,value:view})
   setMessage(view.current?`${view.status}. Finite development result only. Protected qualification and financial efficacy are not established.`
    :`${view.status}. Currentness failed: ${view.currentnessReasons.join(', ')||'cancelled or invalidated'}. Original responsibility remains.`)
  }catch{if(current()){setDisplay(null);setRows(null);setActor(null);setProgramme(null);setResult(null);setMessage('Current identity, rights and Work could not be verified. Reload before acting.')}}
 },[identity,logical,session,workId,root])
 useEffect(()=>{
  if(logicalRef.current!==logical){logicalRef.current=logical;pending.current=null;actorRef.current=null}
  const fence=epoch,sequence=++fence.current;selected.current='';busyRef.current=false
  setBusy(false);setActor(null);setDisplay(null);setRows(null);setResult(null);resetForms();setFormIdentity(identity)
  void refresh(sequence)
  return()=>{fence.current++}
  // Identity changes synchronously hide private state before the reset effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[identity])
 useEffect(()=>{
  if(!session||!workId)return
  const poll=()=>{if(!busyRef.current&&document.visibilityState==='visible')void refresh(++epoch.current)}
  const focus=()=>{if(!busyRef.current){setDisplay(null);setProgramme(null);void refresh(++epoch.current)}}
  const timer=setInterval(poll,4000);window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus)
  return()=>{clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus)}
 },[refresh,session,workId])
 async function act(operation:Operation,body:Record<string,unknown>,mutation=true,retry=false){
  if(!enabled||busyRef.current)return
  if(mutation&&pending.current&&!retry){setMessage('Resolve the uncertain original request before starting another mutation.');return}
  if(retry&&pending.current?.scope!==actor!.scope)return
  const invocation=retry?pending.current!.body:body,op=retry?pending.current!.operation:operation,
   expected=identity,sequence=++epoch.current,current=()=>identityRef.current===expected&&epoch.current===sequence,
   oldId=selected.current
  if(mutation&&!retry){
   originalRequest(actor!.scope)
   if(originalRequests.size>=4&&!originalRequests.has(actor!.scope)||new TextEncoder().encode(JSON.stringify(invocation)).byteLength>2097152){
    setMessage('Resolve an uncertain original request before using more local request storage.');return
   }
   pending.current={scope:actor!.scope,operation:op,body:invocation,
    expiresAt:Math.min(Date.now()+900000,visible?Date.parse(visible.counters.deadlineAt):Infinity)}
   originalRequests.set(actor!.scope,pending.current)
  }
  const original=mutation?pending.current:null
  busyRef.current=true;setBusy(true);setResult(null)
  if(op==='cancel')setDisplay(null)
  try{
   const value=await centropyPost<unknown>(paths[op],invocation)
   if(original&&originalRequests.get(original.scope)===original)originalRequests.delete(original.scope)
   if(!current())return
   if(mutation)pending.current=null
   if(op==='programme'){
    const data=Programme.parse(value)
    if(data.programme.workId!==workId||data.programme.root.entityId!==root.entityId||data.programme.root.entityType!==root.entityType||
     data.programme.theoryId!==visible?.theoryId)throw Error('Y1_PROGRAMME_SCOPE')
    setProgramme({identity:expected,value:data})
   }
   if(op==='artifact'){
    const download=z.object({theoryId:z.string(),workId:z.string(),root:Root,current:z.literal(true),fileName:z.string(),
     sha256:z.string(),bytesBase64:z.string()}).parse(value)
    if(download.theoryId!==oldId||download.workId!==workId||download.root.entityId!==root.entityId||download.root.entityType!==root.entityType)throw Error('Y1_DOWNLOAD_SCOPE')
    const bytes=Uint8Array.from(atob(download.bytesBase64),c=>c.charCodeAt(0)),
     hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('')
    if(!current())return
    if(hash!==download.sha256)throw Error('Y1_DOWNLOAD_PREIMAGE')
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/json'})),link=document.createElement('a')
    link.href=url;link.download=download.fileName;link.click();URL.revokeObjectURL(url)
    setMessage('Downloaded the exact current checked artifact. This is not protected qualification.')
   }else setResult({identity:expected,value})
   const record=value&&typeof value==='object'?value as Record<string,unknown>:null
   if(op==='reserve'&&record?.origin&&typeof record.origin==='object'&&'ref' in record.origin)setReservationReference(pretty(record.origin.ref))
   if(op==='compose'&&typeof record?.id==='string')setProgrammeId(record.id)
   await refresh(sequence,typeof record?.theoryId==='string'?record.theoryId:oldId)
  }catch(error){if(current()){
   const scopeChanged=error instanceof CentropyApiError&&error.details!==null&&typeof error.details==='object'&&'code' in error.details&&error.details.code==='AUTHENTICATED_SCOPE_CHANGED'
   if(mutation&&!scopeChanged&&error instanceof CentropyApiError&&error.status>=400&&error.status<500&&![401,408,429].includes(error.status)){
    if(original&&originalRequests.get(original.scope)===original)originalRequests.delete(original.scope)
    pending.current=null
   }
   setDisplay(null);setProgramme(null);setMessage(error instanceof Error?error.message:'Owner response unavailable. The original server request may remain durable.')
  }}finally{if(current()){busyRef.current=false;setBusy(false)}}
 }
 function jsonForm(event:FormEvent,operation:Operation,text:string,extra:Record<string,unknown>){
  event.preventDefault()
  try{
   const parsed:unknown=JSON.parse(text)
   if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error()
   void act(operation,{...parsed,...extra,idempotencyKey:crypto.randomUUID()})
  }catch{setMessage('Supply a bounded JSON object matching this owner operation.')}
 }
 return <section className="ct-evidence" aria-label="Economic action theory" data-economic-work={workId??'none'} data-economic-theory={visible?.theoryId??'none'}>
  <h4>Economic action theory</h4><p role="status" aria-live="polite">{formIdentity===identity?message:'Identity changed. Rechecking the exact Work.'}</p>
  <p>Constructs finite operator meanings and composition laws from observations. Ordinary disposable use only. No external settlement, protected admission, novelty, or financial efficacy is implied.</p>
  {enabled?<><button disabled={busy} onClick={()=>{setDisplay(null);setProgramme(null);void refresh(++epoch.current)}}>Reload economic theory</button>
   {pending.current?.scope===actor?.scope?<div><p>An uncertain original request is retained.</p>
    <button disabled={busy} onClick={()=>{const p=pending.current;if(p)void act(p.operation,p.body,true,true)}}>Retry original economic request</button>
    <button disabled={busy} onClick={()=>{originalRequests.delete(actor!.scope);pending.current=null;setMessage('Stopped retrying locally. Server work and responsibility remain.')}}>Stop retrying, retain responsibility</button></div>:null}
   {rows?.identity===identity&&rows.items.length?<label>Theory<select disabled={busy||!!pending.current} value={visible?.theoryId??selected.current} onChange={e=>{selected.current=e.target.value;setDisplay(null);setResult(null);resetForms();void refresh(++epoch.current,e.target.value)}}>{rows.items.map(row=><option key={row.id} value={row.id}>{row.id} · {row.status}</option>)}</select></label>:null}
   <details><summary>Construct from canonical observations</summary><form onSubmit={e=>{
    e.preventDefault();try{void act('submit',{schema:'finnor.economic-theory-request.v1',root,workId,problem:JSON.parse(problem),
     idempotencyKey:crypto.randomUUID(),...(visible?{parentTheoryId:visible.theoryId}:{})})}catch{setMessage('Supply the economic problem JSON. No executable transition body is accepted.')}
   }}><label>Economic construction problem JSON<textarea rows={8} value={problem} onChange={e=>setProblem(e.target.value)} spellCheck={false} required maxLength={1900000}/></label>
    <p>Quantities require exact units, currencies, entity, accounting basis, period and finite domains. Interpretation and consent references must resolve to current canonical evidence.</p>
    <button disabled={busy}>Queue economic construction{visible?', original episode':''}</button></form></details>
  </>:null}
  {visible?<><p>{visible.status} · {visible.current?'current':'not current'} · attempts {visible.counters.attempts}/{visible.counters.maxAttempts}. Original deadline {visible.counters.deadlineAt}. Retained occupation {visible.counters.retainedBytes} bytes.</p>
   <details><summary>Constructed semantics, independent checks and envelope</summary><pre>{pretty(visible.artifact)}</pre></details>
   <details><summary>Native attempts, invalidation and cost history</summary><pre>{pretty(visible.events)}</pre></details>
   {enabled?<><button disabled={busy} onClick={()=>void act('cancel',{theoryId:visible.theoryId})}>Cancel new use, retain responsibility</button>
    {visible.resumable?<button disabled={busy} onClick={()=>void act('resume',{theoryId:visible.theoryId})}>Resume original construction</button>:null}
    {visible.current&&visible.status==='CHECKED'?<>
     <button disabled={busy} onClick={()=>void act('artifact',{theoryId:visible.theoryId},false)}>Download checked economic artifact</button>
     {!visible.admission?<button disabled={busy} onClick={()=>void act('admit',{theoryId:visible.theoryId})}>Request typed development admission</button>:null}
     {visible.admission?<><form onSubmit={e=>jsonForm(e,'reserve',reservation,{theoryId:visible.theoryId})}><label>Original right state and canonical resource bindings JSON<textarea value={reservation} onChange={e=>setReservation(e.target.value)} required rows={4}/></label><button disabled={busy}>Reserve inside canonical S5 portfolio</button></form>
      <form onSubmit={e=>jsonForm(e,'compose',composition,{theoryId:visible.theoryId})}><label>Reservation, exact revision, goal state and parameters JSON<textarea value={composition} onChange={e=>setComposition(e.target.value)} required rows={4}/></label><button disabled={busy}>Compose economic programme</button></form></>:null}
    </>:null}
    <label>Canonical reservation reference JSON<textarea rows={3} value={reservationReference} onChange={e=>setReservationReference(e.target.value)} maxLength={2048}/></label>
    <button disabled={busy||!reservationReference} onClick={()=>{try{void act('reservation',{reservationRef:JSON.parse(reservationReference)},false)}catch{setMessage('Supply the exact original canonical reservation reference.')}}}>Inspect canonical reservation</button>
    <label>Programme to inspect<input value={programmeId} onChange={e=>{setProgrammeId(e.target.value);setProgramme(null)}}/></label>
    <button disabled={busy||!programmeId} onClick={()=>void act('programme',{programmeId},false)}>Inspect original economic programme</button>
    {shownProgramme?<><p>Programme: {shownProgramme.status}. Canonical observation, not an effect acknowledgement, establishes the finite goal.</p>
     {visible.current&&visible.admission?<button disabled={busy} onClick={()=>void act('run',{programmeId:shownProgramme.programme.id})}>Queue guarded internal programme</button>:null}
     <button disabled={busy} onClick={()=>void act('reconcile',{programmeId:shownProgramme.programme.id})}>Reconcile original effects, never repeat external delivery</button>
     <pre>{pretty(shownProgramme)}</pre></>:null}
    <label>Incumbent theory to compare, optional<input value={incumbent} onChange={e=>setIncumbent(e.target.value)}/></label>
    <button disabled={busy} onClick={()=>void act('compare',{theoryId:visible.theoryId,...(incumbent?{incumbentTheoryId:incumbent}:{})},false)}>Inspect current fallback eligibility</button>
   </>:null}
  </>:null}
  {result?.identity===identity?<details open><summary>Exact owner response</summary><pre>{pretty(result.value)}</pre></details>:null}
 </section>
}
