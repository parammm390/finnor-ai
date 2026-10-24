"use client"

import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {z} from 'zod'
import {useCentropyAuth,getCurrentAccessGeneration} from '../lib/centropy-auth'
import {centropyGet,centropyPost,CentropyApiError} from '../lib/api'
import {getSupabaseBrowser} from '@/lib/centropy/supabase-browser'

const paths={
 submit:'interaction-submit',read:'interaction-read',list:'interaction-list',admit:'interaction-admit',resume:'interaction-resume',
 cancel:'interaction-cancel',artifact:'interaction-artifact',compare:'interaction-compare',terms:'interaction-terms',
 local:'interaction-local',consent:'interaction-consent',start:'interaction-start',runRead:'interaction-run-read',
 observe:'interaction-observe',action:'interaction-action',materialize:'interaction-materialize',run:'interaction-run',reconcile:'interaction-reconcile',
} as const
type Operation=keyof typeof paths
type Pending={scope:string;operation:Operation;body:Record<string,unknown>;expiresAt:number}
const originals=new Map<string,Pending>()
let watching=false
function watchLogout(){
 if(watching)return
 watching=true
 void getSupabaseBrowser().then(client=>{
  let previousUser:string|null=null
  client.auth.onAuthStateChange((event,next)=>{
   if(event==='SIGNED_OUT'||!next||previousUser&&previousUser!==next.user.id)originals.clear()
   previousUser=next?.user.id??null
  })
 }).catch(()=>{watching=false;originals.clear()})
}
const Ref=z.object({owner:z.string(),id:z.string(),version:z.string(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)})
const Root=z.object({entityType:z.string(),entityId:z.string().uuid()})
const Terms=z.object({ref:Ref,id:z.string().uuid(),revision:z.number().int(),validUntil:z.string()}).passthrough()
const Local=z.object({protocolId:z.string().uuid(),tenantId:z.string().uuid(),principalId:z.string().uuid(),participant:z.enum(['P0','P1']),
 workId:z.string().uuid(),root:Root,current:z.boolean(),status:z.string(),currentnessReasons:z.array(z.string()),
 terms:Terms.nullable(),consents:z.array(z.unknown()),runs:z.array(z.object({id:z.string().uuid(),status:z.string()})),
 protectedQualification:z.literal(false),productionActivated:z.literal(false),financialEfficacyEstablished:z.literal(false)})
const Owner=z.object({protocolId:z.string().uuid(),tenantId:z.string().uuid(),principalId:z.string().uuid(),workId:z.string().uuid(),
 root:Root,status:z.string(),current:z.boolean(),artifact:z.unknown().nullable(),admission:z.unknown().nullable(),resumable:z.boolean(),
 counters:z.object({episodeId:z.string(),attempts:z.number(),maxAttempts:z.number(),retainedBytes:z.number(),deadlineAt:z.string()}),
 events:z.array(z.unknown()),protectedQualification:z.literal(false),productionActivated:z.literal(false)}).passthrough()
const Run=z.object({runId:z.string().uuid(),protocolId:z.string().uuid(),workId:z.string().uuid(),root:Root,participant:z.enum(['P0','P1']),
 current:z.boolean(),status:z.string(),programmeId:z.string().uuid().nullable(),
 local:z.object({viewDigest:z.string(),revision:z.number().int(),status:z.string(),observations:z.array(z.unknown()),
  actions:z.array(z.object({id:z.string(),prescribedProbability:z.string(),permittedDeviation:z.literal(true)}))}).passthrough().nullable(),
 intent:z.object({ref:Ref}).passthrough().nullable(),protectedQualification:z.literal(false),financialEfficacyEstablished:z.literal(false)}).passthrough()
const pretty=(value:unknown)=>JSON.stringify(value,null,2)
const keyed=new Set<Operation>(['submit','terms','consent','start','observe','action','materialize'])

export function InteractionProtocolPanel({root,workId}:{root:{entityType:string;entityId:string};workId:string}){
 const {session}=useCentropyAuth(),logical=JSON.stringify([session?.user.id??null,root.entityType,root.entityId,workId]),
  identity=JSON.stringify([logical,session?.access_token??null,getCurrentAccessGeneration()]),
  identityRef=useRef(identity),epoch=useRef(0),selected=useRef(''),selectedRun=useRef(''),busyRef=useRef(false),
  actorRef=useRef<string|null>(null),pending=useRef<Pending|null>(null)
 identityRef.current=identity
 const [actor,setActor]=useState<{identity:string;scope:string}|null>(null),[formIdentity,setFormIdentity]=useState(identity),
  [list,setList]=useState<{identity:string;rows:Array<{id:string;status:string;owner:boolean}>}|null>(null),
  [view,setView]=useState<{identity:string;local:z.infer<typeof Local>;owner:z.infer<typeof Owner>|null}|null>(null),
  [run,setRun]=useState<{identity:string;value:z.infer<typeof Run>}|null>(null),
  [result,setResult]=useState<{identity:string;value:unknown}|null>(null),[busy,setBusy]=useState(false),
  [message,setMessage]=useState('Select the exact Work to construct or inspect a dynamic interaction.'),
  [specification,setSpecification]=useState(''),[reservation,setReservation]=useState(''),[observation,setObservation]=useState(''),
  [online,setOnline]=useState(true)
 const shown=view?.identity===identity?view:null,shownRun=run?.identity===identity&&run.value.protocolId===shown?.local.protocolId?run.value:null,
  enabled=!!session&&online&&formIdentity===identity&&actor?.identity===identity
 const wipe=()=>{setView(null);setRun(null);setResult(null);setList(null);setSpecification('');setReservation('');setObservation('')}
 const refresh=useCallback(async(sequence:number,preferred?:string)=>{
  if(!session||!navigator.onLine)return
  const expected=identity,current=()=>identityRef.current===expected&&epoch.current===sequence
  try{
   const me=await centropyGet<{tenantId:string;userId:string;employeeId:string|null}>('me')
   if(!current())return
   if(!me.tenantId||me.userId!==session.user.id)throw Error('Y3_ACTOR_UNAVAILABLE')
   const scope=JSON.stringify([logical,me.tenantId,me.employeeId??me.userId])
   for(const [key,value] of originals)if(value.expiresAt<=Date.now())originals.delete(key)
   if(actorRef.current!==null&&actorRef.current!==scope){pending.current=null;selected.current='';selectedRun.current='';wipe()}
   actorRef.current=scope;pending.current=originals.get(scope)??null;setActor({identity:expected,scope})
   const data=z.object({workId:z.string(),root:Root,protocols:z.array(z.object({id:z.string().uuid(),status:z.string(),owner:z.boolean()}))})
    .parse(await centropyPost('company-brain/'+paths.list,{root,workId}))
   if(!current())return
   if(data.workId!==workId||data.root.entityType!==root.entityType||data.root.entityId!==root.entityId)throw Error('Y3_LIST_SCOPE')
   setList({identity:expected,rows:data.protocols})
   const id=preferred||selected.current||data.protocols[0]?.id
   if(!id){setView(null);setRun(null);setMessage('No protocol is registered. Supply original models, canonical source bindings and fixed Y1 meanings, never a strategy.');return}
   const item=data.protocols.find(p=>p.id===id)
   if(!item)throw Error('Y3_PROTOCOL_LIST_SCOPE')
   const local=Local.parse(await centropyPost('company-brain/'+paths.local,{protocolId:id}))
   if(!current())return
   if(local.tenantId!==me.tenantId||local.principalId!==(me.employeeId??me.userId)||local.workId!==workId||
    local.protocolId!==id||local.root.entityId!==root.entityId||local.root.entityType!==root.entityType)throw Error('Y3_LOCAL_SCOPE')
   const owner=item.owner?Owner.parse(await centropyPost('company-brain/'+paths.read,{protocolId:id})):null
   if(!current())return
   if(owner&&(owner.tenantId!==me.tenantId||owner.principalId!==(me.employeeId??me.userId)||owner.protocolId!==id||
    owner.workId!==workId||owner.root.entityId!==root.entityId||owner.root.entityType!==root.entityType))throw Error('Y3_OWNER_SCOPE')
   selected.current=id;setView({identity:expected,local,owner})
   const runId=local.runs.some(r=>r.id===selectedRun.current)?selectedRun.current:local.runs[0]?.id
   if(runId){
    const value=Run.parse(await centropyPost('company-brain/'+paths.runRead,{runId}))
    if(!current())return
    if(value.runId!==runId||value.protocolId!==id||value.workId!==workId||value.participant!==local.participant||
     value.root.entityId!==root.entityId||value.root.entityType!==root.entityType)throw Error('Y3_RUN_SCOPE')
    selectedRun.current=runId;setRun({identity:expected,value})
   }else setRun(null)
   setMessage(local.current?`${local.status}. Exact supplied-model development only. No protected qualification or financial efficacy.`:
    `${local.status}. New use is disabled. Original consents, reservations, costs and responsibilities remain.`)
  }catch{if(current()){wipe();setActor(null);setMessage('Current identity, rights and Work could not be verified. Reload before acting.')}}
 },[identity,logical,session,root,workId])
 useEffect(()=>{
  watchLogout();const sequence=++epoch.current;selected.current='';selectedRun.current='';actorRef.current=null;busyRef.current=false
  pending.current=null;setBusy(false);setActor(null);wipe();setFormIdentity(identity);setOnline(navigator.onLine);void refresh(sequence)
  return()=>{
   // This is a monotone request fence, not a DOM-node reference.
   // eslint-disable-next-line react-hooks/exhaustive-deps
   epoch.current++
  }
  // Hide old private fields synchronously through the identity checks above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[identity])
 useEffect(()=>{
  const close=()=>{epoch.current++;busyRef.current=false;setBusy(false);setOnline(false);setActor(null);wipe();setMessage('Offline. Private results are hidden; server responsibility remains.')}
  const reopen=()=>{busyRef.current=false;setBusy(false);setOnline(navigator.onLine);setView(null);setRun(null);setResult(null);setActor(null);if(navigator.onLine)void refresh(++epoch.current)}
  const poll=()=>{if(!busyRef.current&&document.visibilityState==='visible'&&navigator.onLine)void refresh(++epoch.current)}
  const timer=setInterval(poll,4000)
  window.addEventListener('offline',close);window.addEventListener('online',reopen);window.addEventListener('focus',reopen)
  return()=>{clearInterval(timer);window.removeEventListener('offline',close);window.removeEventListener('online',reopen);window.removeEventListener('focus',reopen)}
 },[refresh])
 async function act(operation:Operation,body:Record<string,unknown>,mutation=true,retry=false){
  if(!enabled||busyRef.current)return
  if(mutation&&pending.current&&!retry){setMessage('Resolve the uncertain original request before starting another mutation.');return}
  if(retry&&pending.current?.scope!==actor!.scope)return
  const invocation=retry?pending.current!.body:keyed.has(operation)?{...body,idempotencyKey:crypto.randomUUID()}:body,
   op=retry?pending.current!.operation:operation,expected=identity,sequence=++epoch.current,
   current=()=>identityRef.current===expected&&epoch.current===sequence,oldId=selected.current
  if(mutation&&!retry){
   if(originals.size>=4&&!originals.has(actor!.scope)||new TextEncoder().encode(pretty(invocation)).byteLength>1048576){
    setMessage('The bounded original-request store is full. No new request was sent.');return
   }
   pending.current={scope:actor!.scope,operation:op,body:invocation,
    expiresAt:Math.min(Date.now()+900000,shown?.owner?Date.parse(shown.owner.counters.deadlineAt):Infinity)}
   originals.set(actor!.scope,pending.current)
  }
  const original=mutation?pending.current:null
  busyRef.current=true;setBusy(true);setResult(null)
  try{
   const value=await centropyPost<unknown>('company-brain/'+paths[op],invocation)
   if(original&&originals.get(original.scope)===original)originals.delete(original.scope)
   if(!current())return
   if(mutation)pending.current=null
   if(op==='artifact'){
    const download=z.object({protocolId:z.string(),workId:z.string(),root:Root,current:z.literal(true),fileName:z.string(),
     sha256:z.string(),bytesBase64:z.string()}).parse(value)
    if(download.protocolId!==oldId||download.workId!==workId||download.root.entityId!==root.entityId||download.root.entityType!==root.entityType)throw Error('Y3_DOWNLOAD_SCOPE')
    const bytes=Uint8Array.from(atob(download.bytesBase64),c=>c.charCodeAt(0)),
     hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('')
    if(!current())return
    if(hash!==download.sha256)throw Error('Y3_DOWNLOAD_PREIMAGE')
    const url=URL.createObjectURL(new Blob([bytes],{type:'application/json'})),link=document.createElement('a')
    link.href=url;link.download=download.fileName;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000)
   }else setResult({identity:expected,value})
   const record=value&&typeof value==='object'?value as Record<string,unknown>:null
   if(typeof record?.runId==='string')selectedRun.current=record.runId
   await refresh(sequence,typeof record?.protocolId==='string'?record.protocolId:oldId)
  }catch(error){if(current()){
   if(mutation&&error instanceof CentropyApiError&&error.status>=400&&error.status<500&&![401,408,429].includes(error.status)){
    if(original&&originals.get(original.scope)===original)originals.delete(original.scope);pending.current=null
   }
   setView(null);setRun(null);setResult(null)
   setMessage(error instanceof CentropyApiError&&error.details&&typeof error.details==='object'&&'code' in error.details?
    String(error.details.code):'Owner response unavailable. The original server request may remain durable.')
  }}finally{if(current()){busyRef.current=false;setBusy(false)}}
 }
 function jsonForm(event:FormEvent,operation:Operation,text:string,extra:Record<string,unknown>){
  event.preventDefault()
  try{const body:unknown=JSON.parse(text);if(!body||typeof body!=='object'||Array.isArray(body))throw Error();void act(operation,{...body,...extra})}
  catch{setMessage('Supply the bounded JSON object for this exact owner operation.')}
 }
 const terms=shown?.local.terms,intent=shownRun?.intent
 const consent=(scope:'TERMS'|'EFFECT',decision:'ACCEPT'|'WITHDRAW')=>{
  if(shown&&terms)void act('consent',{protocolId:shown.local.protocolId,termsRef:terms.ref,scope,
   subjectDigest:scope==='TERMS'?terms.ref.contentDigest:intent!.ref.contentDigest,decision})
 }
 return <section className="ct-evidence" aria-label="Dynamic interaction protocol" data-interaction-work={workId} data-interaction-protocol={shown?.local.protocolId??'none'}>
  <h4>Dynamic interaction protocol</h4><p role="status" aria-live="polite">{formIdentity===identity?message:'Identity changed. Rechecking this exact Work.'}</p>
  <p>Constructs disclosure, communication and commitment timing under exact supplied models. Development only. Protected qualification, external settlement and financial efficacy are not established.</p>
  {enabled?<><button disabled={busy} onClick={()=>{wipe();void refresh(++epoch.current)}}>Reload interaction protocol</button>
   {pending.current?.scope===actor?.scope?<div><p>An uncertain original interaction request remains.</p>
    <button disabled={busy} onClick={()=>{const p=pending.current;if(p)void act(p.operation,p.body,true,true)}}>Retry original interaction request</button>
    <button disabled={busy} onClick={()=>{originals.delete(actor!.scope);pending.current=null;setMessage('Stopped retrying locally. Server work and responsibility remain.')}}>Stop retrying, retain responsibility</button></div>:null}
   {list?.identity===identity&&list.rows.length?<label>Interaction<select disabled={busy||!!pending.current} value={shown?.local.protocolId??selected.current}
    onChange={e=>{selected.current=e.target.value;selectedRun.current='';wipe();void refresh(++epoch.current,e.target.value)}}>
    {list.rows.map(p=><option key={p.id} value={p.id}>{p.id} · {p.status}</option>)}</select></label>:null}
   <details><summary>Construct from original models and fixed meanings</summary><form onSubmit={e=>jsonForm(e,'submit',specification,
    {schema:'finnor.interaction-request.v1',root,workId,...(shown?.owner?{parentProtocolId:shown.local.protocolId}:{})})}>
    <label>Original problem, fixed Y1 lowering and canonical source bindings JSON<textarea value={specification} onChange={e=>setSpecification(e.target.value)}
     rows={8} required maxLength={1000000} spellCheck={false}/></label><button disabled={busy}>Queue dynamic synthesis</button></form></details>
  </>:null}
  {enabled&&shown?<><p>{shown.local.participant} · {shown.local.status} · {shown.local.current?'current':'new use disabled'}.</p>
   {shown.owner?<><p>Attempts {shown.owner.counters.attempts}/{shown.owner.counters.maxAttempts}. Original deadline {shown.owner.counters.deadlineAt}. Retained occupation {shown.owner.counters.retainedBytes} bytes.</p>
    <details><summary>Constructed policy, exact incentive and global-belief checks</summary><pre>{pretty(shown.owner.artifact)}</pre></details>
    <details><summary>Native attempts, invalidation, costs and recovery</summary><pre>{pretty(shown.owner.events)}</pre></details>
    <button disabled={busy} onClick={()=>void act('cancel',{protocolId:shown.local.protocolId})}>Cancel new interaction use, retain responsibility</button>
    {shown.owner.resumable?<button disabled={busy} onClick={()=>void act('resume',{protocolId:shown.local.protocolId})}>Resume original interaction</button>:null}
    {shown.owner.current&&shown.owner.status==='CHECKED'?<>
     <button disabled={busy} onClick={()=>void act('artifact',{protocolId:shown.local.protocolId},false)}>Download checked interaction artifact</button>
     {!shown.owner.admission?<button disabled={busy} onClick={()=>void act('admit',{protocolId:shown.local.protocolId})}>Request typed interaction development admission</button>:null}
     {shown.owner.admission?<form onSubmit={e=>jsonForm(e,'terms',reservation,{protocolId:shown.local.protocolId})}>
      <label>Original canonical reservation reference and expected revision JSON<textarea value={reservation} onChange={e=>setReservation(e.target.value)} required rows={4}/></label>
      <button disabled={busy}>Publish exact interaction terms</button></form>:null}
    </>:null}
    <button disabled={busy} onClick={()=>void act('compare',{protocolId:shown.local.protocolId},false)}>Inspect current dynamic fallback</button>
   </>:null}
   {terms&&shown.local.current?<><details open><summary>Exact current terms, no effect authority</summary><pre>{pretty(terms)}</pre></details>
    <button disabled={busy} onClick={()=>consent('TERMS','ACCEPT')}>Accept exact protocol terms</button>
    <button disabled={busy} onClick={()=>consent('TERMS','WITHDRAW')}>Withdraw exact protocol terms</button>
    {shown.owner?<button disabled={busy} onClick={()=>void act('start',{protocolId:shown.local.protocolId,termsRef:terms.ref})}>Start consented local continuation</button>:null}
   </>:null}
   <details><summary>Your immutable consent history</summary><pre>{pretty(shown.local.consents)}</pre></details>
   {shown.local.runs.length?<label>Original interaction run<select disabled={busy} value={shownRun?.runId??selectedRun.current}
    onChange={e=>{selectedRun.current=e.target.value;setRun(null);void refresh(++epoch.current)}}>{shown.local.runs.map(r=><option key={r.id} value={r.id}>{r.id} · {r.status}</option>)}</select></label>:null}
   {shownRun?<><p>Continuation: {shownRun.status}. Participant-local knowledge only. Assertions are not sourced facts.</p>
    <details open><summary>Your lawful observations and next actions</summary><pre>{pretty(shownRun.local)}</pre></details>
    {shownRun.current&&shown.local.current&&shownRun.local?<><form onSubmit={e=>jsonForm(e,'observe',observation,{runId:shownRun.runId,expectedRevision:shownRun.local!.revision})}>
     <label>Available observation, classification and canonical fact source JSON<textarea rows={4} value={observation} onChange={e=>setObservation(e.target.value)} required/></label>
     <button disabled={busy}>Record participant-local observation</button></form>
     {shownRun.local.actions.map(action=><button key={action.id} disabled={busy} onClick={()=>void act('action',{runId:shownRun.runId,
      expectedRevision:shownRun.local!.revision,viewDigest:shownRun.local!.viewDigest,actionId:action.id})}>
      Record {action.id}, prescribed {action.prescribedProbability}, permitted deviation</button>)}
    </>:null}
    {intent&&shownRun.current&&shown.local.current?<><details open><summary>Exact internal effect intent, new consent required</summary><pre>{pretty(intent)}</pre></details>
     <button disabled={busy} onClick={()=>consent('EFFECT','ACCEPT')}>Consent to this exact internal effect</button>
     <button disabled={busy} onClick={()=>consent('EFFECT','WITHDRAW')}>Withdraw this exact internal effect consent</button>
     {shown.owner?<button disabled={busy} onClick={()=>void act('materialize',{runId:shownRun.runId,intentRef:intent.ref})}>Lower consented intent through fixed Y1 owners</button>:null}
    </>:null}
    {shown.owner&&shownRun.programmeId?<><button disabled={busy||!shownRun.current} onClick={()=>void act('run',{runId:shownRun.runId})}>Queue guarded original internal effect</button>
     <button disabled={busy} onClick={()=>void act('reconcile',{runId:shownRun.runId})}>Reconcile original native responsibility</button></>:null}
    <details><summary>Original run and canonical readback</summary><pre>{pretty(shownRun)}</pre></details>
    {shownRun.nativeProgramme&&typeof shownRun.nativeProgramme==='object'&&'status' in shownRun.nativeProgramme?
     <p>Canonical native outcome: {String(shownRun.nativeProgramme.status)}. Financial efficacy and external settlement are not established.</p>:null}
   </>:null}
  </>:null}
  {result?.identity===identity&&online?<details open><summary>Exact interaction owner response</summary><pre>{pretty(result.value)}</pre></details>:null}
 </section>
}
