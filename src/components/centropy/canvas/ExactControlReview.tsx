"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { centropyPost, CentropyApiError } from "@/components/centropy/lib/api"
import { onBusinessInvalidation } from "@/components/centropy/lib/business-invalidation"
import { R1ProjectionSchema, R1ReviewSchema, R1HistorySchema, type R1Projection, type R1Review, type R1History } from "./exact-control-view"

type Scoped<T>={scope:string;value:T}
const pending=(status:string)=>["QUEUED","RUNNING"].includes(status)
const words=(v:string)=>v.toLowerCase().replaceAll("_"," ")
/** Mounted inside the existing Capital Work. Every private response carries
 * the full parent auth/Work scope and an invalidatable request epoch. */
export function ExactControlReview({scope,authorized,workId,root}:{
 scope:string;authorized:boolean;workId:string;root:{entityType:string;entityId:string}
}){
 const rootType=root.entityType,rootId=root.entityId
 const [projection,setProjection]=useState<Scoped<R1Projection>|null>(null),[review,setReview]=useState<Scoped<R1Review>|null>(null),[history,setHistory]=useState<Scoped<R1History>|null>(null)
 const [busy,setBusy]=useState(false),[notice,setNotice]=useState("Loading current exact control owners."),[error,setError]=useState<string|null>(null)
 const epoch=useRef(0),scopeRef=useRef(scope),writing=useRef(false),refreshing=useRef(false)
 scopeRef.current=scope
 const available=authorized&&projection?.scope===scope?projection.value:null
 const current=authorized&&review?.scope===scope&&available?.runs.some(r=>r.id===review.value.id)?review.value:null
 const policy=current?.review&&Date.now()<Date.parse(current.review.validUntil)?current.review:null
 const past=authorized&&history?.scope===scope?history.value:null
 const active=useCallback((generation:number)=>generation===epoch.current&&scopeRef.current===scope&&document.visibilityState==="visible",[scope])
 const clear=useCallback(()=>{setProjection(null);setReview(null);setHistory(null)},[])
 const refresh=useCallback(async(generation:number)=>{
  if(refreshing.current)return
  refreshing.current=true
  try{
   const p=R1ProjectionSchema.parse(await centropyPost("policies/r1-projection",{workId,root:{entityType:rootType,entityId:rootId}}))
   if(!active(generation))return
   if(p.workId!==workId)throw Error("Current Work differs")
   setProjection({scope,value:p})
   const newest=p.runs[0]
   if(newest){const r=R1ReviewSchema.parse(await centropyPost("policies/r1-review",{runId:newest.id}))
    if(!active(generation))return
    if(r.workId!==workId||r.id!==newest.id||p.workRevision&&r.workRevision!==p.workRevision)throw Error("Current input differs")
    setReview({scope,value:r});if(!r.review)setHistory(null)
    setNotice(pending(r.status)?"Checking the original model under its original deadline. Claims remain provisional.":words(r.status))
   }else{setReview(null);setNotice(p.eligibility.candidates.some(c=>c.request)?"An original exact model and issued compute grant are available.":"No current exact model with an original funded Work is available.")}
   setError(null)
  }catch(cause){if(!active(generation))return;clear();setError(cause instanceof CentropyApiError&&[401,403,404].includes(cause.status)?"Exact control is unavailable in your current access scope. Values cleared.":"Current exact control could not be verified. Values cleared.")}
  finally{refreshing.current=false}
 },[active,clear,rootId,rootType,scope,workId])
 useEffect(()=>{
  const requestEpoch=epoch
  requestEpoch.current++;clear();writing.current=false;setBusy(false);setError(null)
  if(!authorized){setNotice("Sign in with current owner access to review exact control.");return}
  let cancelled=false,timer:ReturnType<typeof setTimeout>
  const cycle=async()=>{if(cancelled)return;if(document.visibilityState==="visible")await refresh(epoch.current);if(!cancelled)timer=setTimeout(cycle,5000)}
  void cycle()
  const visibility=()=>{epoch.current++;clear();if(document.visibilityState==="visible")void refresh(epoch.current)}
  const unsubscribe=onBusinessInvalidation(signal=>{
   if(!signal.tags.some(t=>["work","company-brain","source","authority"].includes(t)))return
   if(writing.current&&signal.path?.startsWith("policies/r1-"))return
   epoch.current++;clear();setNotice("Owners changed. Rechecking current Work.");if(document.visibilityState==="visible")void refresh(epoch.current)
  })
  document.addEventListener("visibilitychange",visibility)
  return()=>{cancelled=true;requestEpoch.current++;clearTimeout(timer);unsubscribe();document.removeEventListener("visibilitychange",visibility)}
 },[authorized,clear,refresh])
 async function perform(operation:"submit"|"cancel"|"reconcile",body:object){
  if(!authorized||writing.current)return
  const generation=++epoch.current;writing.current=true;setBusy(true);setReview(null);setHistory(null)
  try{
   await centropyPost("policies/r1-"+operation,body)
   if(active(generation))await refresh(generation)
  }catch(cause){if(active(generation)){clear();setError(cause instanceof CentropyApiError?cause.message:"Current owner operation failed. Values cleared.")}}
  finally{if(scopeRef.current===scope){writing.current=false;setBusy(false)}}
 }
 async function inspectHistory(){if(!current)return;const generation=epoch.current
  try{const h=R1HistorySchema.parse(await centropyPost("policies/r1-history",{runId:current.id}));if(active(generation)&&h.runId===current.id)setHistory({scope,value:h})}
  catch{if(active(generation)){setHistory(null);setError("Historical evidence is unavailable in the current access scope.")}}
 }
 const eligible=available?.eligibility.candidates.find(c=>c.request)
 return <section aria-label="Exact control review" className="ct-capital-program__exact" aria-busy={busy}>
  <h4>Exact control review</h4>
  <p>Compare lawful continuations of a supplied finite model. Causal adequacy, independent admission and economic value remain unqualified.</p>
  <p role="status" aria-live="polite">{notice}</p>
  {error?<p role="alert">{error}</p>:null}
  <div className="ct-capital-program__actions">
   <button type="button" disabled={!authorized||busy} onClick={()=>{epoch.current++;clear();void refresh(epoch.current)}}>Recheck exact control owners</button>
   {eligible?.request?<button type="button" disabled={busy||Boolean(current&&pending(current.status))} onClick={()=>perform("submit",{...eligible.request,idempotencyKey:crypto.randomUUID()})}>Check reusable continuations</button>:null}
   {current?<><button type="button" disabled={busy||!pending(current.status)} onClick={()=>perform("cancel",{runId:current.id})}>Cancel continuation check</button>
    <button type="button" disabled={busy} onClick={inspectHistory}>Inspect retained control evidence</button>
    {current.costs.unknown?<button type="button" disabled={busy} onClick={()=>perform("reconcile",{runId:current.id})}>Reconcile interrupted work</button>:null}</>:null}
  </div>
  {current?<p>{words(current.status)}. {current.costs.attempts} physical attempts; {current.costs.unknown} unresolved. Original response deadline {current.decisionDeadlineAt}. Money and aggregate peak memory are unmetered.</p>:null}
  {current?.predicate?<p>Owner predicate: {current.predicate}.</p>:null}
  {current?.fallback?<p>{current.fallback==="ORIGINAL_PATH_EXECUTED"?"The original S4 continuation path ran under the remaining original grant.":"Fallback disposition: "+words(current.fallback)}.</p>:null}
  {current?.status==="INVALIDATED"?<p>Source, Work, rights, method or grant changed. Earlier claims are historical; prepare current owner inputs before another check.</p>:null}
  {current?.head?<p>{current.head.beforeStates} original information states; {current.head.afterStates??"unknown"} checked classes. {current.head.stats.continuationEvaluations} unique continuation evaluations; {current.head.stats.reuseHits} checked reuse hits. Relation {current.head.relationComplete?"complete":"unaccepted"}; search {current.head.searchComplete?"complete":"incomplete"}.</p>:null}
  {policy?<div>
   <p>Supplied model value: {policy.exactValue?.numerator}/{policy.exactValue?.denominator} {policy.utilityUnit}. This planning result grants no execution authority.</p>
   <h5>Original observable alternatives</h5>
   <ol>{policy.originalChoices.map((choice,index)=><li key={index}>Period {choice.period}; history {choice.actionHistory.join(", ")||"initial"}; received observations {choice.observations.map(o=>o.instrumentId+": "+o.token).join(", ")||"none"}. Optimal actions: {choice.optimalActions.join(", ")}. {choice.selectedAction?"Owner tie choice: "+choice.selectedAction+".":""}</li>)}</ol>
   <details><summary>Original rational demand and owner bindings</summary><pre tabIndex={0}>{JSON.stringify({source:policy.sourceRef,mandate:policy.mandateRef,rights:policy.rightsRef,demand:policy.exactDemand},null,2)}</pre></details>
   <details><summary>Model premises and unresolved claims</summary><ul>{[...policy.assumptions,...policy.limitations,...(current?.head?.envelope.gaps??[])].map((gap,index)=><li key={index}>{gap}</li>)}</ul></details>
  </div>:null}
  {past?<details open><summary>Historical control evidence</summary><p>Historical records retain original costs and responsibility. They do not establish a current claim.</p><ol>{past.events.map(event=><li key={event.id}>{event.created_at}: {words(event.kind)}<details><summary>Retained witness</summary><pre tabIndex={0}>{JSON.stringify(event.body,null,2)}</pre></details></li>)}</ol>{past.hasMore?<p>More retained events exist beyond this bounded view.</p>:null}</details>:null}
  {available?.eligibility.candidates.filter(c=>c.state==="UNAVAILABLE").map(c=><p key={c.programId}>Original owner input unavailable: {c.predicate}.</p>)}
 </section>
}
