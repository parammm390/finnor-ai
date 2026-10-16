"use client"

import {useCallback,useEffect,useRef,useState,type FormEvent} from "react"
import {usePathname,useRouter,useSearchParams} from "next/navigation"
import {centropyGet,centropyPost,CentropyApiError} from "@/components/centropy/lib/api"
import {useCentropyAuth} from "@/components/centropy/lib/centropy-auth"

type Ref={owner:string;id:string;revision:string;contentDigest:string}
type Root={entityType:string;entityId:string}
type Packet={mandateRef:Ref;authorityProfileRef:Ref;domainProfileRef:Ref;budgetGrantRef:Ref;sourceProfileRef:Ref;relationshipPolicyRef:Ref;eligibleCompanyIds:string[];universeDefinition:string;underwritingGapAssertions:unknown[]}
type Artifact={artifactId:string;opportunityId:string;companyRef:Ref;buyerEntityRef:Ref;counterpartyRef:Ref;originationClass:string;communicatedTermsRevision:Ref;
 terms:{purchasePrice:{amount:string;currency:string;units:string};controlShareBps:number;retainedShareBps:number;managementParticipationBps:number;managementContinuity:string;proposedClosingAt:string;consideration:Array<{amount:string;dueAt:string;condition:string}>};
 confirmedInterestStatementAndSource:{statement:string};preliminaryFitChecks:Array<{id:string;status:string}>;remainingUnderwritingGaps:Array<{assertionId:string;exactPredicate:string}>;indicationBindingStatus:string;
 agreedNextStep:{description:string;scheduledAt:string};validityAndExpiry:{expiresAt:string};independentCheckRefs:Ref[];environment:string;evidenceLabels:string[]}
type Read={programmeId:string;root:Root;ref:Ref;workId:string;workRevision:string;status:string;reason:string|null;
 candidates:Array<{id:string;company_id:string;disposition:string;reason:string|null}>;artifacts:Artifact[];
 frozenCut:{knowledgeCut:string;baselinePipelineDigest:string;universeDefinition:string}|null;originalDeadline:string;
 nextObligationRefs:Ref[];requiredApprovalRefs:Ref[];principalArtifactRef:Ref|null;
 advanceBindings:{mandateRef:Ref;authorityProfileRef:Ref;domainProfileRef:Ref;budgetGrantRef:Ref;evidenceRevisionVector:Array<{key:string;revision:number}>};
 costReceipts:Array<{id:string;kind:string;status:string;microUsd:string|null;possibleAdditionalMicroUsd:string;cpuMicros:string|null;bytes:number;reasons:string[]}>}
type Handoff={artifactRef:Ref;root:Root;workId:string;expectedWorkInputId:string;predecessorRef:Ref;assertions:unknown[];acquisitionPermissionGranted:false}

/** This is the ordinary mounted Work controller. A packet supplies owner
 * references and scope, never a future reply or an accepted opportunity. */
export function BilateralOpportunityPanel({root,workId,investigation,onSelectWork}:{root:Root;workId:string|null;investigation:{threadId:string;expectedRevision:number};onSelectWork?:(id:string)=>void}){
 const {session}=useCentropyAuth(),pathname=usePathname(),router=useRouter(),search=useSearchParams()
 const identity=`${session?.user.id??"signed-out"}:${session?.access_token??""}:${root.entityType}:${root.entityId}:${workId??""}:${investigation.threadId}`
 const identityRef=useRef(identity),epoch=useRef(0),readSequence=useRef(0),pending=useRef<number|null>(null);identityRef.current=identity
 const [packet,setPacket]=useState(""),[primaryPacket,setPrimaryPacket]=useState(""),[mode,setMode]=useState("protected")
 const [busy,setBusy]=useState(false),[message,setMessage]=useState("Supply the eligible market and original mandate, contact, source, domain and S5 grant references.")
 const [programmeId,setProgramme]=useState<string|null>(null),[read,setRead]=useState<{identity:string;data:Read}|null>(null)
 const [handoff,setHandoff]=useState<{identity:string;data:Handoff}|null>(null)
 const parameter=search.get("bilateralProgramme")
 const clear=useCallback(()=>{setRead(null);setHandoff(null)},[])
 const refresh=useCallback(async(id:string,generation:number)=>{
  if(pending.current!==null||document.visibilityState!=="visible"||!navigator.onLine)return
  const sequence=++readSequence.current
  try{
   const data=await centropyPost<Read>("company-brain/bilateral-read",{programmeId:id})
   if(generation!==epoch.current||sequence!==readSequence.current||identityRef.current!==identity||document.visibilityState!=="visible")return
   if(data.root.entityType!==root.entityType||data.root.entityId!==root.entityId||workId&&data.workId!==workId)throw Error("Current Work identity changed")
   setRead({identity,data});setHandoff(previous=>previous?.identity===identity&&previous.data.artifactRef.contentDigest===data.principalArtifactRef?.contentDigest?previous:null);setMessage(data.reason??data.status)
  }catch(error){
   if(generation!==epoch.current||sequence!==readSequence.current||identityRef.current!==identity)return
   epoch.current++
   clear();if(error instanceof CentropyApiError&&[401,403,404].includes(error.status)){setPacket("");setPrimaryPacket("")}setMessage(error instanceof CentropyApiError&&[401,403,404].includes(error.status)
    ?"Bilateral evidence is unavailable in your current access, source or authority scope."
    :"Current qualification could not be revalidated. Private values cleared.")
  }
 },[identity,root.entityType,root.entityId,workId,clear])
 useEffect(()=>{
  epoch.current++;pending.current=null;clear();setPacket("");setPrimaryPacket("");setBusy(false)
  setProgramme(parameter&&/^[0-9a-f-]{36}$/i.test(parameter)?parameter:null)
 },[identity,parameter,clear])
 useEffect(()=>{
  if(!programmeId||!session)return
  let active=true,timer:ReturnType<typeof setTimeout>
  const tick=async()=>{if(!active)return;if(document.visibilityState==="visible")await refresh(programmeId,epoch.current);if(active)timer=setTimeout(tick,2000)}
  const hide=()=>{epoch.current++;clear()}
  const resume=()=>{hide();if(document.visibilityState==="visible")void refresh(programmeId,epoch.current)}
  void tick();window.addEventListener("pagehide",hide);window.addEventListener("offline",hide);window.addEventListener("online",resume);document.addEventListener("visibilitychange",resume)
  return()=>{active=false;clearTimeout(timer);hide();window.removeEventListener("pagehide",hide);window.removeEventListener("offline",hide);window.removeEventListener("online",resume);document.removeEventListener("visibilitychange",resume)}
 },[programmeId,session,refresh,clear])
 const current=read?.identity===identity?read.data:null,transfer=handoff?.identity===identity?handoff.data:null
 const errorText=(error:unknown)=>error instanceof CentropyApiError?(error.details as {predicate?:string})?.predicate??error.message:error instanceof Error?error.message:"Current owner predicate unpassed"
 function finish(generation:number){if(pending.current===generation||pending.current===null){pending.current=null;if(identityRef.current===identity)setBusy(false)}}
 async function start(event:FormEvent){
  event.preventDefault();if(pending.current!==null||!session)return;const generation=++epoch.current;pending.current=generation;clear();setBusy(true);setMessage("Accepting the original Work scope. Pipeline and interest are not yet established.")
  try{
   if(packet.length>60000)throw Error("The sourcing packet exceeds the bounded request size")
   const input=JSON.parse(packet) as Packet
   if(!Array.isArray(input.eligibleCompanyIds)||!input.eligibleCompanyIds.length)throw Error("An explicit eligible company universe is required")
   let boundWork=workId,inputId:string
   if(boundWork){
    const response=await centropyGet<{work:{work:{id:string};inputs:Array<{id:string}>;read?:{complete:boolean}}}>("works/"+boundWork)
    if(response.work.work.id!==boundWork||response.work.read?.complete===false)throw Error("Current complete Work input unavailable")
    inputId=response.work.inputs.at(-1)?.id??""
   }else{
    const opened=await centropyPost<{workId:string;workInputId:string}>("company-brain/bilateral-open-work",{root,investigation,instruction:"Create and independently qualify buyer-bound bilateral opportunities in the registered eligible universe.",idempotencyKey:crypto.randomUUID()})
    boundWork=opened.workId;inputId=opened.workInputId
   }
   if(!inputId)throw Error("The current immutable Work input is unavailable")
   if(generation!==epoch.current||identityRef.current!==identity)return
   const accepted=await centropyPost<{programmeId:string;workId:string}>("company-brain/bilateral-submit",{...input,
    schema:"finnor.bilateral-programme.v1",root,workId:boundWork,expectedWorkInputId:inputId,idempotencyKey:crypto.randomUUID(),mode})
   if(generation!==epoch.current||identityRef.current!==identity)return
   const params=new URLSearchParams(search.toString());params.set("bilateralProgramme",accepted.programmeId)
   router.replace(`${pathname}?${params}`,{scroll:false});setProgramme(accepted.programmeId)
   setMessage("Durable sourcing accepted. Proposed structures and transport acceptance are not confirmed interest.")
   if(!workId)onSelectWork?.(accepted.workId)
  }catch(error){if(generation!==epoch.current||identityRef.current!==identity)return;clear();setMessage(errorText(error))}
  finally{finish(generation)}
 }
 async function cancel(){
  if(!programmeId||pending.current!==null||!session)return
  const generation=++epoch.current;pending.current=generation;clear();setBusy(true)
  try{await centropyPost("company-brain/bilateral-cancel",{programmeId});if(generation===epoch.current&&identityRef.current===identity)setMessage("Cancellation requested. Earlier contacts, charges and unknown outcomes remain accountable.")}
  catch{if(generation===epoch.current&&identityRef.current===identity)setMessage("Cancellation is not confirmed. Private values cleared.")}
  finally{finish(generation)}
 }
 async function advance(){
  if(!current||pending.current!==null||!session)return
  const generation=++epoch.current;pending.current=generation;clear();setBusy(true)
  try{
   await centropyPost("company-brain/bilateral-advance",{...current.advanceBindings,programmeRef:current.ref,
    expectedRevision:Number(current.ref.revision),triggerRef:current.nextObligationRefs[0]??current.ref})
   if(pending.current===generation)pending.current=null
   await refresh(current.programmeId,generation)
  }catch(error){if(generation===epoch.current&&identityRef.current===identity)setMessage(errorText(error)+". No original grant or deadline was reset.")}
  finally{finish(generation)}
 }
 async function loadHandoff(){
  if(!current?.principalArtifactRef||pending.current!==null||!session)return
  const generation=++epoch.current;pending.current=generation;setBusy(true)
  try{
   const data=await centropyPost<Handoff>("company-brain/bilateral-handoff",{artifactRef:current.principalArtifactRef})
   if(generation===epoch.current&&identityRef.current===identity)setHandoff({identity,data})
  }catch(error){if(generation===epoch.current&&identityRef.current===identity){epoch.current++;clear();setMessage(errorText(error))}}
  finally{finish(generation)}
 }
 async function startPrimary(event:FormEvent){
  event.preventDefault();if(!transfer||pending.current!==null||!session)return
  const generation=++epoch.current;pending.current=generation;clear();setBusy(true)
  try{
   if(primaryPacket.length>60000)throw Error("The V2 owner packet exceeds its bounded size")
   const owners=JSON.parse(primaryPacket) as Record<string,unknown>
   const accepted=await centropyPost<{programmeId:string}>("company-brain/primary-submit",{...owners,
    schema:"finnor.primary-diligence.v1",root:transfer.root,workId:transfer.workId,expectedWorkInputId:transfer.expectedWorkInputId,
    predecessorRef:transfer.predecessorRef,assertions:transfer.assertions,idempotencyKey:crypto.randomUUID(),mode})
   if(generation!==epoch.current||identityRef.current!==identity)return
   const params=new URLSearchParams(search.toString());params.set("root",JSON.stringify(transfer.root));params.set("primaryProgramme",accepted.programmeId)
   router.replace(`${pathname}?${params}`,{scroll:false});setMessage("V2 accepted the same Opportunity, Work input and unchanged unresolved gaps.")
  }catch(error){if(generation===epoch.current&&identityRef.current===identity){epoch.current++;clear();setMessage(errorText(error))}}
  finally{finish(generation)}
 }
 return <section className="ct-evidence" aria-label="Private market opportunity creation">
  <p>Adaptive sourcing links evidence, exact feasible structures, governed contact and independently confirmed interest. Live contact and protected activation are not authorized by this development path.</p>
  <form onSubmit={start}>
   <label>Frozen sourcing scope and original owner references<textarea aria-label="Bilateral sourcing register" value={packet} onChange={e=>setPacket(e.target.value)} required maxLength={60000} rows={8}/></label>
   <p>Required: eligibleCompanyIds, universeDefinition, underwritingGapAssertions, mandateRef, authorityProfileRef, domainProfileRef, budgetGrantRef, sourceProfileRef and relationshipPolicyRef. Do not paste credentials or future replies.</p>
   <label>Programme scope<select aria-label="Bilateral programme scope" value={mode} onChange={e=>setMode(e.target.value)}><option value="protected">Protected, requires admission</option><option value="ordinary_disposable">Disposable development sources</option></select></label>
   <button type="submit" disabled={busy||!session||!!current&&["PROGRESS","RECONCILING"].includes(current.status)}>Start bilateral opportunity creation</button>
  </form>
  <p role="status" aria-live="polite">{message.replaceAll("_"," ").toLowerCase()}</p>
  {programmeId?<button type="button" onClick={()=>void cancel()} disabled={busy||!session}>Cancel bilateral programme and reconcile</button>:null}
  {current&&["WAITING","RECONCILING"].includes(current.status)?<button type="button" disabled={busy} onClick={()=>void advance()}>Reconcile or continue within the original sourcing grant</button>:null}
  {current?<><p>Original deadline {current.originalDeadline}. Work input {current.workRevision}.</p>
   {current.frozenCut?<p>Frozen authorized universe: {current.frozenCut.universeDefinition}. Knowledge cut {current.frozenCut.knowledgeCut}.</p>:<p>Source and pipeline freeze pending. No qualification is established.</p>}
   <ul>{current.candidates.map(co=><li key={co.id}>Company {co.company_id}: {co.disposition.replaceAll("_"," ").toLowerCase()}{co.reason?` (${co.reason.replaceAll("_"," ").toLowerCase()})`:""}</li>)}</ul>
   {current.artifacts.map(a=><article key={a.artifactId} data-bilateral-qualification="DEVELOPMENT_ACCEPTED">
    <h4>Independently confirmed bilateral opportunity (development)</h4>
    <p>Canonical Opportunity {a.opportunityId}. Origination: {a.originationClass}. Incremental causal creation is not established.</p>
    <p>{a.confirmedInterestStatementAndSource.statement}</p>
    <p>{a.indicationBindingStatus}. Not underwritten, funded, IC-approved, exclusive or legally effective.</p>
    <p>Buyer {a.buyerEntityRef.id}. Exact terms revision {a.communicatedTermsRevision.revision}: {a.terms.purchasePrice.amount} {a.terms.purchasePrice.currency} minor units, control {a.terms.controlShareBps}/10000, retained participation {a.terms.retainedShareBps}/10000.</p>
    <p>{a.terms.managementContinuity==="NONE"?"No management-continuity condition proposed.":"Twelve-month management continuity is a proposed contractual condition, not an accomplished fact or an employment guarantee."}</p>
    <p>Agreed next step: {a.agreedNextStep.description} at {a.agreedNextStep.scheduledAt}. Confirmation expires {a.validityAndExpiry.expiresAt}.</p>
    <ul>{a.remainingUnderwritingGaps.map(gap=><li key={gap.assertionId}>Unresolved underwriting: {gap.exactPredicate}</li>)}</ul>
    <details><summary>Inspect exact terms, evidence labels and independent checks</summary>
     <ul>{a.terms.consideration.map((stage,i)=><li key={i}>{stage.amount} minor units at {stage.dueAt}, {stage.condition.toLowerCase()}</li>)}</ul>
     <p>Preliminary fit: {a.preliminaryFitChecks.map(check=>`${check.id}: ${check.status}`).join(", ")}.</p>
     <p>{a.evidenceLabels.join(", ")}. Independent checks: {a.independentCheckRefs.map(ref=>ref.contentDigest).join(", ")}.</p>
    </details>
   </article>)}
   {current.principalArtifactRef?<button type="button" onClick={()=>void loadHandoff()}>Prepare same-Opportunity V2 handoff</button>:null}
   <details><summary>Original sourcing charges and retained exposure</summary><ul>{current.costReceipts.map(cost=><li key={cost.id}>{cost.kind}: {cost.status}, {cost.microUsd??"unknown"} microUSD, additional exposure {cost.possibleAdditionalMicroUsd}, CPU {cost.cpuMicros??"unknown"} microseconds, {cost.bytes} bytes. {cost.reasons.join(", ")}</li>)}</ul><p>Development tariffs and incomplete meters do not establish economic gain.</p></details>
  </>:null}
  {transfer?<form onSubmit={startPrimary}>
   <p>The same Opportunity, Work input and {transfer.assertions.length} immutable unresolved assertions transfer to V2. This handoff grants no data acquisition permission.</p>
   <label>Current V2 source, consent, semantics, mandate and original S5 grant references<textarea aria-label="V2 handoff owner packet" value={primaryPacket} onChange={e=>setPrimaryPacket(e.target.value)} required maxLength={60000} rows={6}/></label>
   <p>Supply startingEvidenceRefs, mandateRef, authorityProfileRef, budgetGrantRef, sourceProfileRefs, consentRefs and referenceSemanticsRefs. Assertions and predecessor identity come from the current V1 artifact, not this packet.</p>
   <button type="submit" disabled={busy||!session||!transfer.assertions.length}>Start primary diligence from this opportunity</button>
  </form>:null}
 </section>
}
