"use client"

import {useCallback,useEffect,useRef,useState} from "react"
import {usePathname,useRouter,useSearchParams} from "next/navigation"
import {centropyGet,centropyPost,CentropyApiError} from "@/components/centropy/lib/api"
import {useCentropyAuth} from "@/components/centropy/lib/centropy-auth"

type Ref={owner:string;id:string;revision:string;contentDigest:string}
type Root={entityType:string;entityId:string}
type Value={kind:"UNKNOWN";reason:string}|{kind:"EXACT";quantity:{numerator:string;denominator:string}}|{kind:"STATE";state:string}|{kind:"INTERVAL";lower:{numerator:string;denominator:string};upper:{numerator:string;denominator:string}}
type Assertion={assertionId:string;revision:number;exactPredicate:string;amountOrState:Value;semantics:{legalEntityId:string;accountOrParticipantIds:string[];periodStart:string;periodEnd:string;cutoff:string;currency:string;units:string;basisRef:Ref}}
type Finding={artifactId:string;conclusion:"SUPPORTED"|"CONTRADICTED"|"UNRESOLVED";assertionRef:Ref;establishedValueOrInterval:Value;startingEvidenceDigest:string;knowledgeTime:string;workRevision:string;
 sourceAuthorityAndIndependenceBasis:Array<{sourceRef:Ref;sourceClass:string;sourceControl:string;issuer:string;respondentId:string|null}>;
 observedPopulationAndCoverage:{coverageComplete:boolean;observedMembers:string[];requiredMembers:string[];uncertainty:Record<string,string[]>;excludedInterpretations:string[];sourceWitnesses:Array<{observationRef:Ref;economicId:string;issuerRecordId:string;rawPointer:string;normalizedValue:Value;sourceRevision:string}>};
 unobservedRemainderAndMaterialGaps:string[];evidenceLabels:string[];independentCheckRefs:Ref[];admissionRef:null;environment:string}
type Cost={id:string;kind:string;status:string;microUsd:string|null;possibleAdditionalMicroUsd:string;cpuMicros:string|null;bytes:number;reasons:string[]}
type Read={programmeId:string;root:Root;ref:Ref;workId:string;workRevision:string;status:string;reason:string|null;findings:Finding[];assertions:Assertion[];nextObligationRefs:Ref[];requiredApprovalRefs:Ref[];costReceipts:Cost[];startingEvidenceDigest:string;knowledgeCut:string;
 advanceBindings:{mandateRef:Ref;authorityProfileRef:Ref;budgetGrantRef:Ref;domainProfileRef:Ref;evidenceRevisionVector:Array<{key:string;revision:number}>}}
type Packet={assertions:Assertion[];startingEvidenceRefs:Ref[];mandateRef:Ref;authorityProfileRef:Ref;budgetGrantRef:Ref;sourceProfileRefs:Ref[];consentRefs:Ref[];referenceSemanticsRefs:Ref[];predecessorRef?:Ref|null}
function quantity(q:{numerator:string;denominator:string}){return q.denominator==="1"?q.numerator:`${q.numerator}/${q.denominator}`}
function value(v:Value){return v.kind==="EXACT"?quantity(v.quantity):v.kind==="STATE"?v.state:v.kind==="INTERVAL"?`${quantity(v.lower)} to ${quantity(v.upper)}`:"Unknown"}

/** Mounted ordinary Work, not a test-only artifact viewer. Packets supply frozen
 * meaning and existing owner references, never a result, source reply or finding. */
export function PrimaryDiligencePanel({root,workId,investigation,onSelectWork}:{root:Root;workId:string|null;investigation:{threadId:string;expectedRevision:number};onSelectWork?:(id:string)=>void}){
 const {session}=useCentropyAuth(),pathname=usePathname(),router=useRouter(),search=useSearchParams()
 const identity=`${session?.user.id??"signed-out"}:${session?.access_token??""}:${root.entityType}:${root.entityId}:${workId??""}:${investigation.threadId}`
 const identityRef=useRef(identity),epoch=useRef(0),readSequence=useRef(0),pending=useRef<number|null>(null);identityRef.current=identity
 const [packet,setPacket]=useState(""),[mode,setMode]=useState("protected"),[busy,setBusy]=useState(false),[message,setMessage]=useState("Supply a frozen assertion register and current source, consent, authority and original S5 grant references.")
 const [programmeId,setProgramme]=useState<string|null>(null),[read,setRead]=useState<{identity:string;data:Read}|null>(null)
 const parameter=search.get("primaryProgramme")
 const clear=useCallback(()=>{setRead(null)},[])
 const refresh=useCallback(async(id:string,generation:number)=>{
  if(pending.current!==null||document.visibilityState!=="visible"||!navigator.onLine)return
  const sequence=++readSequence.current
  try{const data=await centropyPost<Read>("company-brain/primary-read",{programmeId:id})
   if(generation!==epoch.current||sequence!==readSequence.current||identityRef.current!==identity||document.visibilityState!=="visible")return
   if(data.root.entityType!==root.entityType||data.root.entityId!==root.entityId||workId&&data.workId!==workId)throw Error("Current Work and investment identity changed")
   setRead({identity,data});setMessage(data.reason??data.status)
  }catch(error){if(generation!==epoch.current||sequence!==readSequence.current||identityRef.current!==identity)return;clear();if(error instanceof CentropyApiError&&[401,403,404].includes(error.status))setPacket("");setMessage(error instanceof CentropyApiError&&[401,403,404].includes(error.status)?"Primary evidence is unavailable in your current access or consent scope.":"Current evidence could not be revalidated. Private values cleared.")}
 },[identity,root.entityType,root.entityId,workId,clear])
 useEffect(()=>{epoch.current++;pending.current=null;clear();setBusy(false);setProgramme(parameter&&/^[0-9a-f-]{36}$/i.test(parameter)?parameter:null)},[identity,parameter,clear])
 useEffect(()=>{setPacket("")},[identity])
 useEffect(()=>{
  if(!programmeId||!session)return
  let active=true,timer:ReturnType<typeof setTimeout>
  const tick=async()=>{if(!active)return;await refresh(programmeId,epoch.current);if(active)timer=setTimeout(tick,2000)}
  const hide=()=>{epoch.current++;clear()}
  const resume=()=>{hide();if(document.visibilityState==="visible")void refresh(programmeId,epoch.current)}
  void tick();window.addEventListener("pagehide",hide);window.addEventListener("offline",hide);window.addEventListener("online",resume);document.addEventListener("visibilitychange",resume)
  return()=>{active=false;clearTimeout(timer);hide();window.removeEventListener("pagehide",hide);window.removeEventListener("offline",hide);window.removeEventListener("online",resume);document.removeEventListener("visibilitychange",resume)}
 },[programmeId,session,refresh,clear])
 const current=read?.identity===identity?read.data:null
 async function start(event:React.FormEvent){
  event.preventDefault();if(pending.current!==null||!session)return;const generation=++epoch.current;pending.current=generation;clear();setBusy(true);setMessage("Freezing the current Work and assertion scope. No finding is established yet.")
  try{
   if(packet.length>1048576)throw Error("Assertion register exceeds its bounded size")
   const input=JSON.parse(packet) as Packet
   if(!Array.isArray(input.assertions)||!input.assertions.length)throw Error("An explicit material assertion register is required")
   let boundWork=workId,inputId:string
   if(boundWork){const response=await centropyGet<{work:{work:{id:string};inputs:Array<{id:string}>;read?:{complete:boolean}}}>("works/"+boundWork);if(response.work.work.id!==boundWork||response.work.read?.complete===false)throw Error("Current Work input unavailable or read truncated");inputId=response.work.inputs.at(-1)?.id??""}
   else{const opened=await centropyPost<{workId:string;workInputId:string}>("company-brain/primary-open-work",{root,investigation,instruction:input.assertions[0].exactPredicate,idempotencyKey:crypto.randomUUID()});boundWork=opened.workId;inputId=opened.workInputId}
   if(!inputId)throw Error("The current immutable Work input is unavailable")
   if(generation!==epoch.current||identityRef.current!==identity)return
   const accepted=await centropyPost<{programmeId:string;workId:string}>("company-brain/primary-submit",{...input,schema:"finnor.primary-diligence.v1",root,workId:boundWork,expectedWorkInputId:inputId,idempotencyKey:crypto.randomUUID(),predecessorRef:input.predecessorRef??null,mode})
   if(generation!==epoch.current||identityRef.current!==identity)return
   const params=new URLSearchParams(search.toString());params.set("primaryProgramme",accepted.programmeId);router.replace(`${pathname}?${params}`,{scroll:false});setProgramme(accepted.programmeId)
   setMessage("Durable primary acquisition accepted. Pending and provisional, not verified.");if(!workId)onSelectWork?.(accepted.workId)
  }catch(error){if(generation!==epoch.current||identityRef.current!==identity)return;clear();const details=error instanceof CentropyApiError?error.details as {predicate?:string}:null;setMessage(details?.predicate??(error instanceof Error?error.message:"Primary diligence unavailable"))}
  finally{if(pending.current===generation){pending.current=null;if(identityRef.current===identity)setBusy(false)}}
 }
 async function cancel(){if(!programmeId||pending.current!==null||!session)return;const generation=++epoch.current;pending.current=generation;clear();setBusy(true);try{await centropyPost("company-brain/primary-cancel",{programmeId});if(generation===epoch.current&&identityRef.current===identity)setMessage("Cancellation requested. Existing requests, charges and unknown exposure remain accountable.")}catch{if(generation===epoch.current&&identityRef.current===identity)setMessage("Cancellation is not confirmed. Private values cleared.")}finally{if(pending.current===generation){pending.current=null;if(identityRef.current===identity)setBusy(false)}}}
 async function advance(){if(!current||pending.current!==null||!session)return;const generation=++epoch.current;pending.current=generation;clear();setBusy(true);try{await centropyPost("company-brain/primary-advance",{...current.advanceBindings,programmeRef:current.ref,expectedRevision:Number(current.ref.revision),triggerRef:current.nextObligationRefs[0]??current.ref});if(pending.current===generation)pending.current=null;await refresh(current.programmeId,generation)}catch{if(generation===epoch.current&&identityRef.current===identity)setMessage("The current authority, evidence vector or original remaining grant blocks continuation. No grant or deadline was reset.")}finally{if(pending.current===generation||pending.current===null){pending.current=null;if(identityRef.current===identity)setBusy(false)}}}
 return <section className="ct-evidence" aria-label="Primary reality due diligence">
  <p>Primary acquisition is separate from uploaded support and checked computation. Live access, contact and protected activation require authority that this development path does not supply.</p>
  <form onSubmit={start}><label>Frozen material assertion register and current owner references<textarea aria-label="Primary assertion register" value={packet} onChange={e=>setPacket(e.target.value)} required maxLength={1048576} rows={8}/></label>
   <p>Required packet fields: assertions, startingEvidenceRefs, mandateRef, authorityProfileRef, budgetGrantRef, sourceProfileRefs, consentRefs and referenceSemanticsRefs. Exact entity, facility, period, basis and coverage must be explicit. Do not paste credentials or future source replies.</p>
   <label>Acquisition scope<select aria-label="Acquisition scope" value={mode} onChange={e=>setMode(e.target.value)}><option value="protected">Protected, requires admission</option><option value="ordinary_disposable">Disposable development sources</option></select></label>
   <button type="submit" disabled={busy||!session||!!current&&["PROGRESS","RECONCILING"].includes(current.status)}>Start primary due diligence</button>
  </form>
  <p role="status" aria-live="polite">{message.replaceAll("_"," ").toLowerCase()}</p>
  {programmeId?<button type="button" onClick={()=>void cancel()} disabled={busy||!session}>Cancel and reconcile responsibility</button>:null}
  {current&&["WAITING","RECONCILING"].includes(current.status)?<button type="button" disabled={busy} onClick={()=>void advance()}>Reconcile or continue within the original grant</button>:null}
  {current?<><p>Work revision {current.workRevision}. Starting knowledge cut {current.knowledgeCut}.</p>
   {current.findings.map(f=>{const assertion=current.assertions.find(a=>a.assertionId===f.assertionRef.id);return <article key={f.artifactId} data-primary-conclusion={f.conclusion}>
    <h4>{assertion?.exactPredicate??"Exact registered assertion"}</h4><strong>{f.conclusion} (development)</strong>
    <p>Original assertion: {assertion?value(assertion.amountOrState):"Unavailable"}. Independently established scoped value: {value(f.establishedValueOrInterval)} {assertion?.semantics.currency} {assertion?.semantics.units}.</p>
    {f.conclusion==="UNRESOLVED"?<p>The unobserved remainder remains unknown. No adjusted annual or enterprise-total value is established.</p>:null}
    <p>{f.observedPopulationAndCoverage.coverageComplete?"Complete for the exact registered population.":"Partial observed population, not complete company coverage."} Observed: {f.observedPopulationAndCoverage.observedMembers.join(", ")||"none"}.</p>
    <ul>{f.sourceAuthorityAndIndependenceBasis.map(s=><li key={s.sourceRef.id}>{s.sourceClass.replaceAll("_"," ").toLowerCase()} · {s.issuer} · {s.sourceControl.toLowerCase()}</li>)}</ul>
    <details><summary>Inspect source scope, field witnesses and independent checks</summary>
     <p>Entity {assertion?.semantics.legalEntityId}; accounts or participants {assertion?.semantics.accountOrParticipantIds.join(", ")}; cutoff {assertion?.semantics.cutoff}; meaning revision {assertion?.semantics.basisRef.revision}.</p>
     {f.observedPopulationAndCoverage.sourceWitnesses.map((w,i)=><p key={`${w.observationRef.id}:${w.rawPointer}:${i}`}>{w.economicId} · source record {w.issuerRecordId} · revision {w.sourceRevision} · {w.rawPointer} = {value(w.normalizedValue)}</p>)}
     <p>Independent checks: {f.independentCheckRefs.map(r=>r.contentDigest).join(", ")}.</p>
     {Object.entries(f.observedPopulationAndCoverage.uncertainty).map(([axis,reasons])=><p key={axis}>{axis}: {reasons.join(", ")||"none reported in this exact scope"}</p>)}
     <p>Excluded interpretations: {f.observedPopulationAndCoverage.excludedInterpretations.join(", ")}.</p>
    </details>
    <ul>{f.unobservedRemainderAndMaterialGaps.map(gap=><li key={gap}>{gap.replaceAll("_"," ").toLowerCase()}</li>)}</ul>
    <p>No audit opinion, professional certification, domain qualification or S8 admission.</p>
   </article>})}
   {current.nextObligationRefs.length?<p>Next permitted obligations: {current.nextObligationRefs.map(r=>r.id).join(", ")}.</p>:null}
   {current.requiredApprovalRefs.length?<p>Additional owner authority required. No new grant or deadline was created.</p>:null}
   <details><summary>Acquisition and checking costs</summary><ul>{current.costReceipts.map(c=><li key={c.id}>{c.kind}: {c.status.toLowerCase()} · {c.microUsd===null?"money unknown":`${c.microUsd} microUSD`} · additional exposure {c.possibleAdditionalMicroUsd} microUSD · CPU {c.cpuMicros??"unknown"} microseconds · {c.bytes} bytes{c.reasons.length?` · ${c.reasons.join(", ")}`:""}</li>)}</ul><p>Meter gaps and development tariffs are not measured economic gain.</p></details>
  </>:null}
 </section>
}
