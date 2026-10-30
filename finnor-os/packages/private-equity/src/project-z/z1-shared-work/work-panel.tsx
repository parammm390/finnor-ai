"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { z } from "zod"
import { centropyPost } from "../../../../../../src/components/centropy/lib/api"
import { usePrivateRequestScope } from "../../../../../../src/components/centropy/lib/use-private-request-scope"
import { onBusinessInvalidation } from "../../../../../../src/components/centropy/lib/business-invalidation"

const reference = z.object({owner:z.string(),id:z.string(),version:z.string(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)})
const viewSchema = z.object({
 workId:z.string().uuid(),requestId:z.string().uuid().optional(),generation:z.number().int().positive().optional(),
 status:z.string(),artifactRef:reference.nullable().optional(),projection:z.unknown().nullable().optional(),
 originalOwnerUses:z.array(z.unknown()).max(1).optional(),costs:z.unknown().optional(),
 unresolvedObligationRefs:z.array(z.string()).max(4096).optional(),originalDeadline:z.string().datetime().optional(),
 executionAuthorityGranted:z.literal(false),businessCompletionGranted:z.literal(false).optional(),
 protectedAdmission:z.literal(false).optional(),
})
type View = z.infer<typeof viewSchema>
type Root = {entityType:"pe_deal";entityId:string}

/** Mounted only in the existing authenticated original Work record. No session,
 * private result or draft survives a root/Work/credential generation change. */
export function SharedWorkPanel({root,workId}:{root:Root;workId:string}) {
 const scope=usePrivateRequestScope(JSON.stringify(["z1-original",root.entityType,root.entityId,workId]))
 const currentKey=useRef(scope.key);currentKey.current=scope.key
 const serial=useRef(0),writing=useRef(false)
 const [stored,setStored]=useState<{key:string;view:View}|null>(null)
 const [trace,setTrace]=useState<{key:string;requestId:string;value:unknown}|null>(null)
 const [draft,setDraft]=useState(""),[busy,setBusy]=useState(false)
 const [notice,setNotice]=useState("Reading the current original Work projection.")
 const current=scope.allowed&&stored?.key===scope.key?stored.view:null
 const visible=()=>document.visibilityState==="visible"&&navigator.onLine
 const clear=useCallback(()=>{setStored(null);setTrace(null)},[])
 const refresh=useCallback(async(n:number)=>{
  if(!scope.allowed||!visible())return
  const key=scope.key
  try{
   const view=viewSchema.parse(await centropyPost("company-brain/z1-project-original-work",{root,workId}))
   if(n!==serial.current||key!==currentKey.current||!scope.isCurrent(key)||!visible())return
   if(view.workId!==workId)throw Error("Original Work changed")
   if(view.status==="STALE_OR_REVOKED"||view.originalDeadline&&Date.parse(view.originalDeadline)<=Date.now()){
    clear();setNotice("Original rights, inputs or deadline changed. Private results cleared. Costs and obligations remain.");return
   }
   setStored({key,view});setNotice(view.status.replaceAll("_"," ").toLowerCase()+". Conditional exact derivation, not business completion.")
  }catch{
   if(n===serial.current&&key===currentKey.current){clear();setNotice("Current authorized evidence is unavailable. Private results cleared.")}
  }
 },[scope.allowed,scope.key,scope.isCurrent,root.entityType,root.entityId,workId,clear])
 useEffect(()=>{
  serial.current++;clear();setDraft("");setBusy(false);writing.current=false
 },[scope.key,scope.allowed,clear])
 useEffect(()=>{
  if(!scope.allowed)return
  let stopped=false,reading=false
  const tick=async()=>{if(stopped||reading||writing.current)return;reading=true
   try{await refresh(serial.current)}finally{reading=false}}
  const invalidate=()=>{serial.current++;clear();setDraft("")}
  const recheck=()=>{invalidate();if(visible())void tick()}
  const offline=()=>{invalidate();setNotice("Offline. No write is queued or automatically replayed.")}
  const unsubscribe=onBusinessInvalidation(signal=>{
   if(!writing.current&&signal.tags.some(tag=>["work","company-brain","authority","source","allocation"].includes(tag)))recheck()
  })
  void tick();const timer=setInterval(()=>void tick(),4000)
  window.addEventListener("offline",offline);window.addEventListener("online",recheck)
  window.addEventListener("pagehide",invalidate);window.addEventListener("blur",invalidate);window.addEventListener("focus",recheck)
  document.addEventListener("visibilitychange",recheck)
  return()=>{stopped=true;invalidate();clearInterval(timer);unsubscribe()
   window.removeEventListener("offline",offline);window.removeEventListener("online",recheck)
   window.removeEventListener("pagehide",invalidate);window.removeEventListener("blur",invalidate);window.removeEventListener("focus",recheck)
   document.removeEventListener("visibilitychange",recheck)}
 },[scope.allowed,refresh,clear])
 useEffect(()=>{
  if(!current?.originalDeadline)return
  const timer=setTimeout(()=>{serial.current++;clear();setNotice("Original deadline expired. No budget was renewed.")},
   Math.max(0,Date.parse(current.originalDeadline)-Date.now()))
  return()=>clearTimeout(timer)
 },[current?.originalDeadline,clear])
 async function readTrace(){
  if(!scope.allowed||writing.current||!visible()||!current?.requestId)return
  const key=scope.key,n=serial.current,requestId=current.requestId
  setTrace(null)
  try{
   const value=z.object({requestId:z.literal(requestId),current:z.literal(true),
    events:z.array(z.unknown()).max(64),parents:z.array(z.unknown()).max(1000),
    nextEventId:z.string().nullable(),lifecycleFinancialCostComplete:z.literal(false)}).passthrough()
    .parse(await centropyPost("company-brain/z1-read-shared-work",{root,requestId,view:"TRACE"}))
   if(n===serial.current&&key===currentKey.current&&scope.isCurrent(key)&&visible())setTrace({key,requestId,value})
  }catch{
   if(n===serial.current&&key===currentKey.current){clear();setNotice("Current authorized trace unavailable. Private results cleared.")}
  }
 }
 async function mutate(operation:"submit"|"budget"|"admit"|"cancel"){
  if(!scope.allowed||writing.current||!visible())return
  const key=scope.key,n=++serial.current;writing.current=true;setBusy(true);clear()
  try{
   let body:unknown
   if(operation==="submit"||operation==="budget"){
    const value:unknown=JSON.parse(draft)
    const envelope=z.object({root:z.object({entityType:z.literal("pe_deal"),entityId:z.literal(root.entityId)}),
     works:z.array(z.object({workId:z.string().uuid()})).optional(),workId:z.string().uuid().optional()}).passthrough().parse(value)
    if(operation==="submit"&&!envelope.works?.some(work=>work.workId===workId)||
     operation==="budget"&&envelope.workId!==workId)throw Error("Original Work scope required")
    body=value
   }else if(operation==="admit"){
    if(!current?.artifactRef)throw Error("Current checked artifact required")
    body={root,publication:current.artifactRef}
   }else{
    if(!current?.requestId||!current.generation)throw Error("Current original request required")
    body={root,requestId:current.requestId,expectedGeneration:current.generation}
   }
   if(operation==="submit")await centropyPost("company-brain/z1-submit-shared-work",body)
   else if(operation==="budget")await centropyPost("company-brain/z1-reserve-original-budget",body)
   else if(operation==="admit")await centropyPost("company-brain/z1-admit-shared-work",body)
   else await centropyPost("company-brain/z1-cancel-shared-work",body)
   if(n===serial.current&&key===currentKey.current&&scope.isCurrent(key)&&visible()){setDraft("");await refresh(n)}
  }catch{
   if(n===serial.current&&key===currentKey.current){setDraft("");setNotice("Request refused or outcome uncertain. Read stored evidence before retrying.")}
  }finally{
   if(key===currentKey.current){writing.current=false;setBusy(false)}
  }
 }
 if(!scope.allowed)return null
 return <section aria-label="Shared Work original projection" data-z1-work-id={workId} className="space-y-3 rounded-lg border p-4">
  <h3 className="font-medium">Shared Work, original result</h3>
  <p role="status" className="text-sm">{notice}</p>
  <p className="text-xs">Ordinary disposable engineering only. Exact source-conditional results do not prove source truth,
   protected admission, observed business success or effect authority. Money and full physical storage costs remain unknown.</p>
  {current&&<div data-z1-request-id={current.requestId} data-z1-status={current.status}>
   <dl className="text-sm"><dt>Original deadline</dt><dd>{current.originalDeadline??"Not requested"}</dd>
    <dt>Unresolved original obligations</dt><dd>{current.unresolvedObligationRefs?.length??"Unknown"}</dd></dl>
   {current.projection!=null&&<details><summary>Exact original projection and conditionality</summary>
    <pre className="overflow-auto text-xs">{JSON.stringify(current.projection,null,2)}</pre></details>}
   <details><summary>Original owner use and retained costs</summary>
    <pre className="overflow-auto text-xs">{JSON.stringify({uses:current.originalOwnerUses??[],costs:current.costs??null},null,2)}</pre>
    {current.requestId&&<button type="button" disabled={busy} onClick={()=>void readTrace()}>Read current retained request trace</button>}
    {trace?.key===scope.key&&trace.requestId===current.requestId&&<><p className="text-xs">At most 64 events.
     A continuation reference means more history exists. Financial and full lifecycle costs are not complete.</p>
     <pre className="overflow-auto text-xs">{JSON.stringify(trace.value,null,2)}</pre></>}
   </details>
   {current.artifactRef&&<button type="button" disabled={busy} onClick={()=>void mutate("admit")}>
    Admit checked derivation for original owner use</button>}
   {current.requestId&&<button type="button" disabled={busy} onClick={()=>void mutate("cancel")}>
    Cancel request, retain costs and obligations</button>}
  </div>}
  <details><summary>Explicit original budget or shared programme intake</summary>
   <p className="text-xs">Paste canonical reference-only intake JSON. Each existing original Work keeps its own S5 parent.
    This control creates no source, Work, resource, consent or external effect. No write is retried automatically.</p>
   <label className="block text-sm">Canonical Z1 intake JSON<textarea aria-label="Canonical Z1 intake JSON"
    value={draft} maxLength={134217728} onChange={event=>setDraft(event.target.value)} disabled={busy}
    className="block min-h-28 w-full rounded border bg-transparent p-2 font-mono text-xs"/></label>
   <button type="button" disabled={busy||!draft.trim()} onClick={()=>void mutate("budget")}>Reserve original S5 budget</button>
   <button type="button" disabled={busy||!draft.trim()} onClick={()=>void mutate("submit")}>Submit canonical shared programme</button>
  </details>
  <button type="button" disabled={busy} onClick={()=>{serial.current++;clear();void refresh(serial.current)}}>Refresh original evidence</button>
 </section>
}
