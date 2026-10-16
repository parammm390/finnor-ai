"use client"

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { centropyPost } from "@/components/centropy/lib/api"
import { useCentropyAuth } from "@/components/centropy/lib/centropy-auth"
import { onBusinessInvalidation } from "@/components/centropy/lib/business-invalidation"
import { DecisionAtlasBuildViewSchema, DecisionAtlasContextViewSchema, DecisionAtlasQueryViewSchema,
  acceptedCellView,type DecisionAtlasBuildView, type DecisionAtlasContextView, type DecisionAtlasQueryView } from "./decision-atlas-view"

type Scoped<T>={scope:string;value:T}
export function DecisionAtlasReview({workId,root}:{workId:string;root:{entityType:string;entityId:string}}) {
  const auth=useCentropyAuth(),token=auth.session?.access_token
  const rootType=root.entityType,rootId=root.entityId
  const scope=`${auth.session?.user.id??"signed-out"}:${token??""}:${workId}:${root.entityType}:${root.entityId}`
  const allowed=Boolean(auth.session&&auth.role==="owner"&&!auth.loading&&!auth.roleLoading&&!auth.roleError)
  const [context,setContext]=useState<Scoped<DecisionAtlasContextView>|null>(null)
  const [build,setBuild]=useState<Scoped<DecisionAtlasBuildView>|null>(null)
  const [query,setQuery]=useState<Scoped<DecisionAtlasQueryView>|null>(null)
  const [values,setValues]=useState<string[]>([]),[versionId,setVersionId]=useState("")
  const [notice,setNotice]=useState("Read the current finite-family owner binding."),[busy,setBusy]=useState(false)
  const epoch=useRef(0),activeScope=useRef(scope),writing=useRef(false)
  const draft=useRef<{digest:string|null;dirty:boolean}>({digest:null,dirty:false})
  activeScope.current=scope
  const current=allowed&&context?.scope===scope?context.value:null
  const currentBuild=allowed&&build?.scope===scope?build.value:null
  const currentQuery=allowed&&query?.scope===scope&&query.value.buildId===currentBuild?.buildId&&
    !["CANCELLED","FAILED","INVALIDATED"].includes(currentBuild?.status??"INVALIDATED")&&
    query.value.parameterRef.contentDigest===current?.parameters?.ref.contentDigest?query.value:null
  const cell=currentBuild?.atlas?acceptedCellView(currentBuild.atlas,currentQuery?.cellId??null):null
  const predicateText=(p:{expression:{a:string[];b:string};relation:"LE"|"LT"|"EQ"|"GT"})=>
    [...p.expression.a.map((v,i)=>`(${v})*${current?.family?.input.source.domain.parameters[i]?.id??`parameter${i}`}`),`(${p.expression.b})`].join(" + ")+
    ` ${p.relation==="LE"?"<=":p.relation==="LT"?"<":p.relation==="GT"?">":"="} 0`
  const clear=useCallback(()=>{setContext(null);setBuild(null);setQuery(null);setValues([]);draft.current={digest:null,dirty:false}},[])
  const valid=(n:number)=>epoch.current===n&&activeScope.current===scope&&document.visibilityState==="visible"
  const refresh=useCallback(async(n:number)=>{
    const data=DecisionAtlasContextViewSchema.parse(await centropyPost("decision-atlases/context",{workId,root:{entityType:rootType,entityId:rootId}}))
    if(epoch.current!==n||activeScope.current!==scope||document.visibilityState!=="visible")return
    if(data.workId!==workId||data.family?.input.work.id!==workId&&data.family)throw Error("Current Work binding differs.")
    setContext({scope,value:data})
    const digest=data.parameters?.ref.contentDigest??null
    const effective=data.effectiveValues??data.parameters?.values??[]
    if(!draft.current.dirty||draft.current.digest!==digest){
      setValues(effective);draft.current={digest,dirty:false}
    }else setValues(old=>effective.map((v,i)=>data.family?.input.source.domain.parameters[i]?.owner==="S5"?v:old[i]??v))
    const selected=data.builds[0]
    if(selected){
      const read=DecisionAtlasBuildViewSchema.parse(await centropyPost("decision-atlases/read",{buildId:selected.id}))
      if(epoch.current!==n||activeScope.current!==scope||document.visibilityState!=="visible")return
      if(read.workId!==workId)throw Error("Atlas Work binding differs.")
      setBuild({scope,value:read})
    }else setBuild(null)
    setQuery(data.lastQuery?{scope,value:data.lastQuery}:null)
  },[scope,workId,rootType,rootId])
  useEffect(()=>{
    epoch.current++;clear();setVersionId("");setNotice("Read the current finite-family owner binding.");setBusy(false);writing.current=false
  },[scope,allowed,clear])
  useEffect(()=>{
    if(!allowed)return
    let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,reading=false
    const tick=async()=>{
      clearTimeout(timer)
      if(!stopped&&!reading&&!writing.current&&document.visibilityState==="visible"){
        reading=true;const n=epoch.current
        try{await refresh(n)}catch{if(epoch.current===n&&activeScope.current===scope){clear();setNotice("Current access or owner binding changed. Private values cleared.")}}
        finally{reading=false}
      }
      if(!stopped)timer=setTimeout(()=>void tick(),currentBuild&&["QUEUED","RUNNING"].includes(currentBuild.status)?1000:10000)
    }
    const invalid=()=>{epoch.current++;clear();if(document.visibilityState==="visible")void tick()}
    const off=onBusinessInvalidation(signal=>{
      if(signal.path?.startsWith("decision-atlases/"))return
      if(signal.tags.some(tag=>["authority","work","source","company-brain"].includes(tag)))invalid()
    })
    document.addEventListener("visibilitychange",invalid);window.addEventListener("pagehide",invalid);void tick()
    return()=>{stopped=true;epoch.current++;clearTimeout(timer);off();document.removeEventListener("visibilitychange",invalid);window.removeEventListener("pagehide",invalid)}
  },[allowed,refresh,clear,scope,currentBuild?.status])
  async function run(fn:(n:number)=>Promise<void>){
    if(!allowed||writing.current)return
    writing.current=true;setBusy(true);const n=++epoch.current;setQuery(null)
    try{await fn(n)}
    catch(error){if(valid(n)){clear();setNotice(error instanceof Error?error.message:"Current owner operation unavailable. Values cleared.")}}
    finally{if(activeScope.current===scope){writing.current=false;setBusy(false)}}
  }
  function register(event:FormEvent){
    event.preventDefault()
    void run(async n=>{
      await centropyPost("decision-atlases/register",{workId,root,evidenceVersionId:versionId,expectedFamilyRef:current?.family?.ref??null})
      if(valid(n)){setNotice("Immutable S1 supplied affine hypothesis bound. Business adequacy and admission remain unqualified.");await refresh(n)}
    })
  }
  function compile(){
    const f=current?.family;if(!f)return
    void run(async n=>{
      await centropyPost("decision-atlases/build",{envelope_inputs:{familyRef:f.ref},problem_ref:f.input.familyRef,
        existing_work_revision:f.input.work.inputId,domain_profile_ref:f.input.domainRef,budget_grant_ref:f.grantRef,cancellation_ref:f.cancellationRef,
        idempotencyKey:crypto.randomUUID()})
      if(valid(n)){setNotice("Durable build queued under the original episode. Cells remain provisional until independently accepted.");await refresh(n)}
    })
  }
  function revise(event:FormEvent){
    event.preventDefault();const f=current?.family,p=current?.parameters;if(!f||!p)return
    void run(async n=>{
      await centropyPost("decision-atlases/parameters",{familyRef:f.ref,expectedRef:p.ref,values})
      if(valid(n)){draft.current.dirty=false;setNotice("Typed owner parameter revision persisted. Requery to select the exact current cell.");await refresh(n)}
    })
  }
  function lookup(fallback:"REQUIRE_ADMITTED"|"DEVELOPMENT_EXACT"){
    if(!currentBuild||!current?.parameters)return
    void run(async n=>{
      const q=DecisionAtlasQueryViewSchema.parse(await centropyPost("decision-atlases/query",{buildId:currentBuild.buildId,
        parameterRef:current.parameters!.ref,idempotencyKey:crypto.randomUUID(),fallback}))
      if(valid(n)&&q.workId===workId){setQuery({scope,value:q});setNotice("Current exact owner lookup retained. No agreement or effect authority.")}
    })
  }
  return <section aria-label="Decision atlas review" aria-busy={busy}>
    <h4>Exact decision atlas</h4>
    <p>Optimum over the named finite family under supplied affine hypotheses. Not whole-programme completeness, causal truth, admission or effect authority.</p>
    <p role="status">{notice}</p>
    {!allowed?<p>Sign in with current owner access.</p>:<>
      <form onSubmit={register}><label>Immutable S1 affine source version <input aria-label="Immutable S1 affine source version" value={versionId} onChange={e=>setVersionId(e.target.value)} required /></label>
        <button disabled={busy} type="submit">Bind current affine family</button></form>
      <button type="button" disabled={busy} onClick={()=>void run(refresh)}>Recheck atlas owners</button>
      {current?.family&&current.parameters?<>
        <p>Family {current.family.input.source.familyKey}, model {current.family.input.source.modelKey}. Source {current.family.evidenceVersionId}. Parameter revision {current.parameters.revision}.</p>
        <form onSubmit={revise}>{current.family.input.source.domain.parameters.map((p,i)=><label key={p.id}>{p.id} ({p.unit}), parameter bounds [{p.lower}, {p.upper}]
          {p.owner==="S5"?<span> Current canonical S5 value, not editable.</span>:null}
          <input aria-label={`Exact parameter ${p.id}`} value={values[i]??""} disabled={p.owner==="S5"} onChange={e=>{draft.current.dirty=true;setValues(old=>old.map((v,k)=>k===i?e.target.value:v))}} required /></label>)}
          <button type="submit" disabled={busy}>Save exact owner parameters</button></form>
        <button type="button" disabled={busy} onClick={compile}>Build checked atlas</button>
      </>:null}
      {currentBuild?<>
        <p>Build {currentBuild.status}, original deadline {currentBuild.deadlineAt}. {currentBuild.atlas?`${currentBuild.atlas.check.acceptedCellIds.length} independently checked cells; ${currentBuild.atlas.check.gapIds.length} explicit gaps.`:"No accepted atlas published."}</p>
        <button type="button" disabled={busy||!currentBuild.atlas} onClick={()=>lookup("REQUIRE_ADMITTED")}>Query exact cell</button>
        <button type="button" disabled={busy||!currentBuild.atlas} onClick={()=>lookup("DEVELOPMENT_EXACT")}>Check full family fallback (development)</button>
        <button type="button" disabled={busy||!["QUEUED","RUNNING"].includes(currentBuild.status)} onClick={()=>void run(async n=>{await centropyPost("decision-atlases/cancel",{buildId:currentBuild.buildId});if(valid(n))await refresh(n)})}>Cancel atlas build</button>
      </>:null}
      {current?.family?<details><summary>Exact domain, current sources and accepted cell</summary>
        <p>The parameter bounds alone are not the domain. Every original predicate below applies. Strict and equality faces use exact ownership, with no epsilon.</p>
        <ul>{current.family.input.source.domain.facets.map((p,i)=><li key={i}><code>{predicateText(p)}</code></li>)}</ul>
        <ul>{current.parameterSources.map(p=><li key={p.parameterId}>{p.parameterId}: current {p.owner} source <code>{p.ref.id}</code>.</li>)}</ul>
        {cell?<><p>Accepted cell {cell.node.id}, affine dimension {cell.node.geometry.affineDimension}, exact witness [{cell.node.geometry.witness.join(", ")}].</p>
          <ul>{cell.predicates.map((p,i)=><li key={i}><code>{predicateText(p)}</code></li>)}</ul>
          <ul>{cell.node.label.policies.map(p=><li key={p.policyId}>{p.policyId}: {p.feasible?"feasible":"infeasible"}.
            {p.violatedConstraintId?` Violated original constraint: ${p.violatedConstraintId}.`:""}
            {p.bindingConstraintIds.length?` Binding original constraints: ${p.bindingConstraintIds.join(", ")}.`:""}</li>)}</ul>
        </>:<p>No current covered-cell predicate is selected.</p>}
        {currentBuild?.atlas?<><p>Checker: {currentBuild.atlas.check.predicate}. Explicit gaps: {currentBuild.atlas.check.gapIds.join(", ")||"none"}.</p>
          <ul>{currentBuild.atlas.proposal.nodes.filter(n=>n.kind==="GAP").map(n=><li key={n.id}>{n.id}: {n.reason}</li>)}</ul></>:null}
        <ul>{current.family.input.source.assumptions.map((a,i)=><li key={i}>{a}</li>)}</ul>
      </details>:null}
      {currentQuery?<article aria-label="Checked atlas recommendation">
        <p>Query {currentQuery.disposition}. Atlas coverage {currentQuery.atlasCoverage}, cell {currentQuery.cellId??"none"}.</p>
        {currentQuery.choice?<><p>Recommended policy {currentQuery.choice.policyId}, original action {currentQuery.choice.action.id} ({currentQuery.choice.action.kind}). Exact robust value {currentQuery.choice.robustValue}.</p>
          <p>Tied alternatives: {currentQuery.choice.tiedPolicyIds.join(", ")}. Worst complete worlds: {currentQuery.choice.worstWorldIds.join(", ")}.</p>
          <p>Exact cost {currentQuery.choice.action.cost}, tail liability {currentQuery.choice.action.tailLiability}, human seconds {currentQuery.choice.action.humanSeconds}. Current S5 checked; reservation still requires owner consumption.</p>
          <button type="button" disabled={busy} onClick={()=>void run(async n=>{
            await centropyPost("decision-atlases/select",{buildId:currentQuery.buildId,queryRef:currentQuery.ref,idempotencyKey:crypto.randomUUID()})
            if(valid(n)){setNotice("Current S4/S5 intent recorded. Resources retained pending qualified S6; no effect executed.");await refresh(n)}
          })}>Prepare ordinary S4/S5 intent</button>
        </>:null}
        <p>{currentQuery.costs.membershipPredicates} exact membership predicates; {currentQuery.costs.fullFamilyEvaluations} full-family evaluations. Money and aggregate memory unmetered.</p>
        {currentQuery.fallback?<p>Fallback {currentQuery.fallback.mode}, not admitted.</p>:null}
        <details><summary>Coverage, currentness and unresolved claims</summary><ul>{currentQuery.reasons.map((r,i)=><li key={i}>{r}</li>)}</ul></details>
      </article>:null}
    </>}
  </section>
}
