"use client"

import {useCallback,useEffect,useRef,useState} from "react"
import {z} from "zod"
import {centropyPost} from "../lib/api"
import {useCentropyAuth} from "../lib/centropy-auth"
import {onBusinessInvalidation} from "../lib/business-invalidation"
import {usePrivateRequestScope} from "../lib/use-private-request-scope"
import type {PeWorldRootRef} from "../pe/contracts"

const id=z.string().uuid()
const reference=z.object({owner:z.string(),id:z.string(),version:z.string(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)})
const quantity=z.object({key:z.string(),mantissa:z.string().regex(/^-?(0|[1-9]\d*)$/).max(26),
 scale:z.number().int().min(0).max(36),semantics:z.object({unit:z.string(),currencyCode:z.string().nullable()}).passthrough()})
const viewSchema=z.object({computationId:id,workId:id,root:z.object({entityType:z.string(),entityId:id}),
 status:z.string(),current:z.boolean(),currentnessReason:z.string().nullable(),validUntil:z.string().datetime({offset:true}),
 releases:z.array(z.object({id,body:z.object({truthClass:z.literal("DERIVED_VALUE"),sourceTruthProven:z.literal(false),
  protectedAdmission:z.literal(false),executionAuthorityGranted:z.literal(false),outputs:z.array(quantity).max(16)})})).max(8),
 history:z.array(z.object({id:z.string(),kind:z.string()})).max(64),
 protectedAdmission:z.literal(false),productionActive:z.literal(false),executionAuthorityGranted:z.literal(false)})
type View=z.infer<typeof viewSchema>
const label=(text:string)=>text.replaceAll("_"," ").toLowerCase()
const CONFIDENTIAL_POST_OPERATIONS=["intake","plan","submit","source-handle","consent","commit","revoke","underwriting",
 "prepare","import-release","reconcile","retry","cancel"] as const
function exact(q:z.infer<typeof quantity>){
 const n=BigInt(q.mantissa),zero=BigInt(0),s=(n<zero?-n:n).toString().padStart(q.scale+1,"0")
 return (n<zero?"-":"")+(q.scale?s.slice(0,-q.scale)+"."+s.slice(-q.scale):s)
}
export function ConfidentialComputationPanel({root,workId,onWorkCreated}:{
 root:PeWorldRootRef;workId?:string;onWorkCreated?:(workId:string)=>void
}){
 const auth=useCentropyAuth(),requestScope=usePrivateRequestScope(JSON.stringify([root.entityType,root.entityId,workId??"new-intake"]))
 const scope=requestScope.key
 const scopeRef=useRef(scope);scopeRef.current=scope
 const epoch=useRef(0),writing=useRef<object|null>(null)
 const [stored,setStored]=useState<{scope:string;view:View}|null>(null)
 const [notice,setNotice]=useState(workId?"Reading current confidential computation evidence.":"Create a new original analytical Work. Existing Work inputs are never rewritten.")
 const [busy,setBusy]=useState(false),[publicRequest,setPublicRequest]=useState("")
 const [operation,setOperation]=useState(workId?"plan":"intake")
 const [publicResult,setPublicResult]=useState<{scope:string;value:unknown}|null>(null)
 const authorized=Boolean(requestScope.allowed&&!auth.loading&&!auth.roleLoading)
 const authorizedRef=useRef(authorized);authorizedRef.current=authorized
 const current=authorized&&stored?.scope===scope?stored.view:null
 const clear=useCallback(()=>setStored(null),[])
 const active=(n:number)=>n===epoch.current&&scopeRef.current===scope&&requestScope.isCurrent(scope)
  &&authorizedRef.current&&document.visibilityState==="visible"&&navigator.onLine
 const refresh=useCallback(async(n:number)=>{
  if(!authorized||!workId||document.visibilityState!=="visible"||!navigator.onLine)return
  const expected=scope
  try{
   const list=z.object({computations:z.array(z.object({id,status:z.string()})).max(64)}).parse(
    await centropyPost("company-brain/confidential-list",{root,workId}))
   if(n!==epoch.current||scopeRef.current!==expected||!requestScope.isCurrent(expected)||document.visibilityState!=="visible"||!navigator.onLine)return
   if(!list.computations.length){clear();setNotice("No confidential computation is registered for this Work.");return}
   const view=viewSchema.parse(await centropyPost("company-brain/confidential-read",{computationId:list.computations[0]!.id}))
   if(n!==epoch.current||scopeRef.current!==expected||!requestScope.isCurrent(expected)||document.visibilityState!=="visible"||!navigator.onLine)return
   if(view.workId!==workId||view.root.entityId!==root.entityId||view.root.entityType!==root.entityType)throw Error("Scope changed")
   if(!view.current||Date.parse(view.validUntil)<=Date.now()){
    clear();setNotice("Current rights, input cut or original deadline could not be verified. Private output cleared.");return
   }
   setStored(previous=>previous?.scope===expected&&JSON.stringify(previous.view)===JSON.stringify(view)
    ?previous:{scope:expected,view})
   setNotice(label(view.status)+". Local engineering only. No protected admission or effect authority.")
  }catch{
   if(n===epoch.current&&scopeRef.current===expected){clear();setNotice("Current authorized evidence is unavailable. Private output cleared.")}
  }
 },[authorized,scope,root,workId,clear])
 useEffect(()=>{
  epoch.current++;clear();setPublicRequest("");setPublicResult(null);setBusy(false);writing.current=null
  setOperation(workId?"plan":"intake")
 },[scope,authorized,clear])
 useEffect(()=>{
  if(!authorized)return
  let stopped=false,reading=false
  const tick=async()=>{
   if(stopped||reading||writing.current)return
   reading=true;try{await refresh(epoch.current)}finally{reading=false}
  }
  const invalidate=()=>{epoch.current++;clear();setPublicResult(null);setPublicRequest("")}
  const recheck=()=>{invalidate();if(navigator.onLine&&document.visibilityState==="visible")void tick()}
  const offline=()=>{invalidate();setNotice("Offline. Private output cleared; no queued write will be replayed.")}
  const unsubscribe=onBusinessInvalidation(signal=>{
   // The write already cleared private state and always rereads its result.
   // Its own invalidation must not discard the plan/handle response.
   if(!writing.current&&signal.tags.some(tag=>["work","company-brain","authority","source","underwriting"].includes(tag)))recheck()
  })
  void tick()
  const timer=setInterval(()=>void tick(),4000)
  window.addEventListener("offline",offline);window.addEventListener("online",recheck)
  window.addEventListener("pagehide",invalidate);window.addEventListener("blur",invalidate)
  window.addEventListener("focus",recheck);document.addEventListener("visibilitychange",recheck)
  return()=>{stopped=true;invalidate();clearInterval(timer);unsubscribe()
   window.removeEventListener("offline",offline);window.removeEventListener("online",recheck)
   window.removeEventListener("pagehide",invalidate);window.removeEventListener("blur",invalidate)
   window.removeEventListener("focus",recheck);document.removeEventListener("visibilitychange",recheck)}
 },[authorized,refresh,clear])
 useEffect(()=>{
  if(!current)return
  const timer=setTimeout(()=>{epoch.current++;clear();setNotice("Original rights or freshness expired. Private output cleared. No resources renewed.")},
   Math.max(0,Date.parse(current.validUntil)-Date.now()))
  return()=>clearTimeout(timer)
 },[current,clear])
 async function mutate(operation:string,body:unknown,accepted?:(result:unknown)=>void){
  if(!authorized||writing.current||!navigator.onLine||document.visibilityState!=="visible")return
  const n=++epoch.current,marker={};writing.current=marker;setBusy(true);clear();setPublicResult(null)
  try{
   const registered=CONFIDENTIAL_POST_OPERATIONS.find(value=>value===operation)
   if(!registered)throw Error("CONFIDENTIAL_INVALID_OPERATION")
   const result=await centropyPost("company-brain/confidential-"+registered,body)
   if(active(n)){setPublicRequest("");await refresh(n);if(active(n))accepted?.(result)}
  }catch{if(active(n))setNotice("Request refused or outcome uncertain. Recheck stored evidence. No automatic write replay.")}
  finally{if(writing.current===marker){writing.current=null;if(scopeRef.current===scope)setBusy(false)}}
 }
 function submitPublic(){
  try{
   const body=JSON.parse(publicRequest)
   if(["intake","plan","submit"].includes(operation)){
    if(body.root?.entityId!==root.entityId||body.root?.entityType!==root.entityType)throw Error("Scope")
    if(operation!=="intake"&&body.workId!==workId)throw Error("Work")
   }else if(operation!=="source-handle"&&body.computationId!==current?.computationId
    &&!(operation==="underwriting"&&body.workId===workId))throw Error("Computation")
   void mutate(operation,body,result=>{
    if(operation==="intake"){
     const accepted=z.object({workId:id,workInputId:id}).parse(result)
     setPublicResult({scope,value:accepted});setNotice("Original Work accepted. No computation or economic effect has run.")
     onWorkCreated?.(accepted.workId)
    }else if(operation==="plan"){
     const accepted=z.object({workRevisionRef:reference}).parse(result)
     setPublicResult({scope,value:accepted});setOperation("submit")
     setPublicRequest(JSON.stringify({...body,schema:"finnor.y4.submit.v1",
      function:{...body.function,workRevisionRef:accepted.workRevisionRef},idempotencyKey:crypto.randomUUID()},null,2))
     setNotice("Native analytical plan selected. Review the public submission before compiling.")
    }else if(operation==="source-handle"){
     const accepted=z.object({sourceRef:reference,grantRef:reference}).parse(result)
     setPublicResult({scope,value:accepted});setNotice("Owner-issued opaque references only. No original bytes or source truth were disclosed.")
    }else setNotice("Request recorded. Current evidence was reread. No effect authority was granted.")
   })
  }catch{setNotice("A valid public request for the selected operation and exact current scope is required.")}
 }
 async function importRecipientFile(file:File|undefined){
  if(!file||file.size>262144||!current||!active(epoch.current))return
  const n=epoch.current,computationId=current.computationId
  try{
   const opening=z.object({receipt:z.object({participantId:z.string()}),releaseNonce:z.string().regex(/^[a-f0-9]{32}$/),
    outputs:z.array(quantity.omit({semantics:true})).max(16)}).parse(JSON.parse(await file.text()))
   if(!active(n))return
   await mutate("import-release",{computationId,participantId:opening.receipt.participantId,
    releaseNonce:opening.releaseNonce,outputs:opening.outputs,idempotencyKey:crypto.randomUUID()})
  }catch{if(active(n))setNotice("Recipient export refused. Use an unchanged local participant export; no private input file is accepted.")}
 }
 return <section aria-label="Confidential economic computation" className="ct-world-work__section">
  <h4>Confidential economic computation</h4>
  <p>Derived values, not primary facts. Local engineering only. Participant inputs stay local. Execution requires separate authority.</p>
  <p role="status" aria-live="polite">{authorized?notice:"Sign in with current owner access. Private output is hidden."}</p>
  {authorized&&workId?<button type="button" disabled={busy} onClick={()=>{epoch.current++;clear();void refresh(epoch.current)}}>Recheck confidential evidence</button>:null}
  {current?<article><p>{label(current.status)}</p><p>Current until <time dateTime={current.validUntil}>{current.validUntil}</time></p>
   {current.releases.map(release=><div key={release.id}><h5>Recipient-authorized derived outputs</h5>
    <dl>{release.body.outputs.map(q=><div key={q.key}><dt>{q.key}</dt><dd>{exact(q)} {q.semantics.currencyCode??q.semantics.unit}</dd></div>)}</dl></div>)}
   <details><summary>Retained computation history</summary><ol>{current.history.map(e=><li key={e.id}>{label(e.kind)}</li>)}</ol></details>
   {current.status==="AWAITING_PARTICIPANTS"?<button type="button" disabled={busy} onClick={()=>void mutate("prepare",{
    computationId:current.computationId})}>Prepare consented session</button>:null}
   {current.status==="COMPUTED"?<label>Import your recipient-private participant export
    <input type="file" accept="application/json,.json" disabled={busy} onChange={event=>{
     const file=event.currentTarget.files?.[0];event.currentTarget.value="";void importRecipientFile(file)
    }}/></label>:null}
   {current.status==="RECONCILIATION_REQUIRED"?<button type="button" disabled={busy} onClick={()=>void mutate("reconcile",{
    computationId:current.computationId,reason:"Explicit read-only participant reconciliation",idempotencyKey:crypto.randomUUID()
   })}>Reconcile without resubmission</button>:null}
   {current.status==="FAILED"?<button type="button" disabled={busy} onClick={()=>void mutate("retry",{
    computationId:current.computationId,reason:"Explicit pre-input compilation retry",idempotencyKey:crypto.randomUUID()
   })}>Retry pre-input compilation</button>:null}
   {["QUEUED","COMPILING","AWAITING_PARTICIPANTS","READY","RUNNING"].includes(current.status)?
    <button type="button" disabled={busy} onClick={()=>void mutate("cancel",{computationId:current.computationId,
     reason:"Explicit cancellation from this Work",idempotencyKey:crypto.randomUUID()})}>Cancel confidential computation</button>:null}
  </article>:null}
  {authorized?<details><summary>{workId?"Public function and participant controls":"Create original confidential analytical Work"}</summary>
   <p>Do not enter private input values, records, credentials, keys or nonces. Use the exact existing Work and source-owner references.</p>
   <p>Source handles narrow existing owner rights. Planning does not prove completion. Import private recipient exports only through the file control above.</p>
   <form onSubmit={event=>{event.preventDefault();submitPublic()}}>
    <label>Public operation<select value={operation} disabled={busy} onChange={event=>{
     setOperation(event.target.value);setPublicRequest("");setPublicResult(null)
    }}>
     {workId?<><option value="plan">Select original analytical plan</option><option value="submit">Submit checked compilation</option></>:
      <option value="intake">Accept original Work</option>}
     <option value="source-handle">Issue my opaque source handle</option>
     {current?<><option value="consent">Consent to this exact computation</option><option value="commit">Accept my local input commitments</option>
      <option value="revoke">Revoke my future derivative consent</option><option value="underwriting">Bind my release to an exact underwriting model</option></>:null}
    </select></label>
    <label>Public function request<textarea value={publicRequest} maxLength={262144} onChange={event=>setPublicRequest(event.target.value)} disabled={busy}/></label>
    <button type="submit" disabled={busy||!publicRequest.trim()}>Record public request</button>
   </form></details>:null}
  {authorized&&publicResult?.scope===scope?<details open><summary>Current owner references</summary>
   <pre>{JSON.stringify(publicResult.value,null,2)}</pre></details>:null}
 </section>
}
