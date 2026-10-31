"use client"

import {useCallback,useEffect,useRef,useState} from "react"
import {centropyPost,CentropyApiError} from "@/components/centropy/lib/api"
import {useCentropyAuth} from "@/components/centropy/lib/centropy-auth"

type Root={entityType:string;entityId:string}
type ViabilityCandidate={digest:string|null;disposition:string;ordinaryStatus:string|null;winningRegionSize:number|null;nonconflictingRegionSize?:number|null;safetyKernelSize:number|null;memories:number|null;completeness:string|null}
type ViabilityCheck={digest:string|null;status:string;reason:string;ordinaryComplete:boolean;ordinaryStatus:string|null;nonconflictingComplete?:boolean|null;nonconflictingStatus?:string|null;nonconflictingRegionSize?:number|null;safety:boolean|null;liveness:boolean|null;nonconflicting:boolean|null;originalAssumptionsSatisfiable:boolean|null;reachable:number|null}
type ViabilityRead={
  schema:string;sessionId:string;workId:string;status:string;staleReason:string|null;reason:string|null;
  sourceRevision:string;rightsRevision:string;sourceDigest:string;deadlineAt:string;
  candidate:ViabilityCandidate|null;check:ViabilityCheck|null;
  nextAuthorizedAction:{action:string|null;qualification:string};
  pendingJobs:number;supersededRunningJobs:number;stalePublications:number;nativeTransitions:number;
  s4Consumed:boolean;s5Current:boolean|null;s6OutstandingEffects:number|null;
  nativeProfile?:"READINESS"|"GENERAL"|null;nativeUseStatus?:string;nativeMappingFailure?:string|null;
  s7HistoryComplete:boolean;costs:{attempts:number;money:null;status:string};
  remainingBudget:{attempts:number;steps:number;computeRequests:number}|null;remainingBudgetQualification:string;
  nativeActions:number;s4Cursor:{stateId:string;memory:number;operations:number;goalVisits:Record<string,number>}|null;
  claimFence:number;conditionality:string;gates:Record<string,string>;
  envelope:{supportedDomain:string;nativeSupportedDomain?:string;gaps:string[]};
  executionAuthorityGranted:false;protectedReceipt:null;
}

const TERMINAL=new Set(["UNREALIZABLE","STALE","FAILED"])
const label=(value:string)=>value.replaceAll("_"," ").toLowerCase()
const short=(value:string|null|undefined)=>value?value.slice(0,16)+"…":"none"
const bool=(value:boolean|null)=>value===null?"unknown":value?"yes":"no"
const GATE_LABELS:Record<string,string>={
  architecture:"Architecture",internalSoftware:"Internal software",installedReconstruction:"Installed reconstruction",
  mathematicalSecurityDomain:"Mathematical security domain",protectedAdmission:"Protected admission",
  equippedIncrement:"Equipped increment",operational100x:"Operational 100×",financialHeadroom:"Financial headroom",
  financial100x:"Financial 100×",productionActivation:"Production activation",
}

export function ViabilityPanel({root,workId,onChanged}:{root:Root;workId:string;onChanged?:()=>void}){
  const {session}=useCentropyAuth();
  const identity=[session?.user.id??"signed-out",session?.access_token??"no-session",root.entityType,root.entityId,workId].join(":");
  const identityRef=useRef(identity);identityRef.current=identity;
  const epoch=useRef(0);
  const readEpoch=useRef(0);
  const [view,setView]=useState<{identity:string;read:ViabilityRead|null}|null>(null);
  const [busy,setBusy]=useState(false);
  const [absentIdentity,setAbsentIdentity]=useState<string|null>(null);
  const submitKey=useRef<{identity:string;key:string}|null>(null);
  const [message,setMessage]=useState("No recurring-strategy state loaded.");
  const read=view?.identity===identity?view.read:null;
  const refresh=useCallback(async(sequence:number)=>{
    const expected=identity,request=++readEpoch.current;
    try{
      const result=await centropyPost<ViabilityRead>("company-brain/viability-read",{workId,root:{entityType:root.entityType,entityId:root.entityId}});
      if(sequence!==epoch.current||request!==readEpoch.current||identityRef.current!==expected)return;
      if(result.schema!=="finnor.z3.viability-read.v1"||result.workId!==workId)throw Error("VIABILITY_WORK_MISMATCH");
      setAbsentIdentity(null);setView({identity:expected,read:result});
      setMessage(result.status==="UNKNOWN"?"The current bounded run is unresolved; UNKNOWN is retained, never silently cleared.":"Current recurring-strategy state loaded.");
    }catch(error){
      if(sequence!==epoch.current||request!==readEpoch.current||identityRef.current!==expected)return;
      if(error instanceof CentropyApiError&&error.status===404){
        setAbsentIdentity(expected);setView({identity:expected,read:null});
        setMessage("No recurring-strategy session is recorded for this exact Work.");
      }else{
        setAbsentIdentity(null);setView(null);
        setMessage("Current recurring-strategy state could not be verified. Retained history is not a current result.");
      }
    }
  },[identity,root.entityType,root.entityId,workId]);
  useEffect(()=>{
    const observer=epoch,sequence=++observer.current;setView(null);setBusy(false);setMessage("No recurring-strategy state loaded.");
    if(session&&document.visibilityState==="visible")void refresh(sequence);
    return()=>{observer.current++};
  },[identity,session,refresh]);
  useEffect(()=>{
    if(!session)return;
    const update=()=>{const sequence=++epoch.current;setView(null);setBusy(false);if(document.visibilityState==="visible")void refresh(sequence)};
    const timer=setInterval(()=>{if(document.visibilityState==="visible")void refresh(epoch.current)},2000);
    document.addEventListener("visibilitychange",update);window.addEventListener("focus",update);
    return()=>{clearInterval(timer);document.removeEventListener("visibilitychange",update);window.removeEventListener("focus",update)};
  },[session,refresh]);
  async function submit(){
    if(busy||!session||absentIdentity!==identity)return;
    const sequence=++epoch.current,expected=identity;setBusy(true);
    if(submitKey.current?.identity!==identity)submitKey.current={identity,key:`panel:${workId}:${crypto.randomUUID()}`};
    try{
      await centropyPost("company-brain/viability-submit",{workId,idempotencyKey:submitKey.current.key});
      if(sequence===epoch.current&&identityRef.current===expected){await refresh(sequence);onChanged?.()}
    }catch(error){
      if(sequence===epoch.current&&identityRef.current===expected){
        const predicate=error instanceof CentropyApiError?(error.details as {predicate?:string}|null)?.predicate:null;
        setMessage(predicate?.startsWith("Z3_")?label(predicate):"Original Work readiness could not be confirmed. No replacement mandate or allowance was created.");
      }
    }finally{if(sequence===epoch.current&&identityRef.current===expected)setBusy(false)}
  }
  async function recover(){
    const current=read;
    if(!current||busy||!session||current.staleReason||current.nativeMappingFailure||TERMINAL.has(current.status)||current.pendingJobs>0)return;
    const sequence=++epoch.current,expected=identity;setBusy(true);
    try{
      await centropyPost("company-brain/viability-recover",{sessionId:current.sessionId,root:{entityType:root.entityType,entityId:root.entityId},idempotencyKey:`panel:${current.sessionId}:${current.claimFence}:${crypto.randomUUID()}`});
      if(sequence===epoch.current&&identityRef.current===expected){await refresh(sequence);onChanged?.()}
    }catch(error){
      if(sequence===epoch.current&&identityRef.current===expected){
        const predicate=error instanceof CentropyApiError?(error.details as {predicate?:string}|null)?.predicate:null;
        setMessage(predicate?.startsWith("Z3_")?label(predicate):"Recovery could not be confirmed.");
      }
    }finally{if(sequence===epoch.current&&identityRef.current===expected)setBusy(false)}
  }
  return <section className="ct-evidence" aria-label="Recurring strategy" data-viability-work={workId}>
    <h4>Recurring strategy</h4>
    <p>Bounded public GR(1) viability synthesis under the original Work binding, independently checked in a separate process. This panel observes and reconciles; it never grants execution authority, protected admission, funding or reservation release. The accepted instruction must declare either readiness v1 or the separately versioned original-native mapping, with a current original parent and remaining original allowance. The mapping does not supply missing owner authority. This control never asks you to invent dependency digests or authority identities.</p>
    <p role="status" aria-live="polite">{message}</p>
    {absentIdentity===identity&&session?<button type="button" disabled={busy} onClick={()=>void submit()}>Check original Work strategy</button>:null}
    {read?<>
      <div className="ct-world-work__metrics">
        <div><span>Status</span><strong>{label(read.status)}</strong></div>
        <div><span>Compute attempts</span><strong>{read.costs.attempts}</strong></div>
        <div><span>Claim fence</span><strong>{read.claimFence}</strong></div>
      </div>
      {read.staleReason?<p className="ct-world-work__caveat">Currentness check: {label(read.staleReason)}. A retained result is historical, not current.</p>:null}
      {read.nativeMappingFailure?<p className="ct-world-work__caveat">Native mapping blocked: {label(read.nativeMappingFailure)}. The retained mathematical result does not permit another owner step or an initial-state reset.</p>:null}
      {read.reason&&read.status!=="VIABLE"?<p>{label(read.reason)}</p>:null}
      {read.candidate?<p>Candidate {label(read.candidate.disposition)}{read.candidate.ordinaryStatus?` · ordinary region ${label(read.candidate.ordinaryStatus)}`:""}{read.candidate.winningRegionSize!==null?` · ordinary winning region ${read.candidate.winningRegionSize}`:""}{read.candidate.nonconflictingRegionSize!=null?` · nonconflicting region ${read.candidate.nonconflictingRegionSize}`:""}{read.candidate.safetyKernelSize!==null?` · safety kernel ${read.candidate.safetyKernelSize}`:""}{read.candidate.memories!==null?` · ${read.candidate.memories} memory states`:""} · digest <code>{short(read.candidate.digest)}</code></p>:null}
      {read.check?<p>Independent check <strong>{label(read.check.status)}</strong> · safety {bool(read.check.safety)} · fair liveness {bool(read.check.liveness)} · complete nonconflicting region {bool(read.check.nonconflictingComplete??null)}{read.check.nonconflictingStatus?` (${label(read.check.nonconflictingStatus)})`:""} · nonconflicting {bool(read.check.nonconflicting)} · assumptions satisfiable {bool(read.check.originalAssumptionsSatisfiable)} · digest <code>{short(read.check.digest)}</code></p>:null}
      {read.check&&read.check.reason!==read.reason?<p>{label(read.check.reason)}</p>:null}
      {read.nextAuthorizedAction.action?<p>Model action under the current binding: <strong>{read.nextAuthorizedAction.action}</strong> ({label(read.nextAuthorizedAction.qualification)}).</p>:null}
      <p>S4 finite prefix observed: {read.s4Consumed?"yes":"no"} · reservation current: {bool(read.s5Current)} · unresolved business effects: {read.s6OutstandingEffects??"unavailable, not zero"} · stale publications refused: {read.stalePublications}</p>
      <p>USD cost remains unknown. {read.remainingBudget?`Original allowance remaining: ${read.remainingBudget.attempts} attempts, ${read.remainingBudget.steps} steps, ${read.remainingBudget.computeRequests} compute requests.`:"Current remaining allowance is unavailable, not zero."} {read.s7HistoryComplete?"":"Interrupted or incomplete cost evidence remains a gap."}</p>
      {read.nativeUseStatus?<p>Native use: {label(read.nativeUseStatus)}.</p>:null}
      {read.s4Cursor?<><p>Native prefix: {read.nativeActions} owner operations, state {read.s4Cursor.stateId}, memory {read.s4Cursor.memory}. This prefix grants no effect execution or UNKNOWN settlement.</p><p>Recorded finite goal visits: {Object.entries(read.s4Cursor.goalVisits).map(([goal,visits])=>`${goal}: ${visits}`).join(", ")}. These counts are not a fairness guarantee.</p></>:null}
      {read.pendingJobs>0?<p>A durable job is still running or queued ({read.pendingJobs}). Recovery is offered only when no live job exists.</p>:null}
      {read.supersededRunningJobs>0?<p>{read.supersededRunningJobs} killed deliver{read.supersededRunningJobs===1?"y is":"ies are"} awaiting lease expiry quarantine.</p>:null}
      <p><em>{read.conditionality}</em></p>
      {!TERMINAL.has(read.status)?<button type="button" disabled={!session||busy||!!read.staleReason||!!read.nativeMappingFailure||read.pendingJobs>0||!read.remainingBudget||read.remainingBudget.attempts<1||read.remainingBudget.steps<5||read.remainingBudget.computeRequests<1} onClick={()=>void recover()}>{read.status==="VIABLE"?(read.nativeProfile==="GENERAL"?"Continue original mapped prefix":"Continue bounded readiness"):"Reconcile recovery"}</button>:null}
      <details className="ct-record-controls"><summary>Qualification gates and limits</summary>
        <ul>{Object.entries(read.gates).map(([key,state])=><li key={key}>{GATE_LABELS[key]??label(key)}: {label(state)}</li>)}</ul>
        <p>Supported algorithm domain: {read.envelope.supportedDomain}</p>
        {read.envelope.nativeSupportedDomain?<p>Native owner domain: {read.envelope.nativeSupportedDomain}</p>:null}
        {read.envelope.gaps.length?<ul>{read.envelope.gaps.map(gap=><li key={gap}>{label(gap)}</li>)}</ul>:null}
        <p>Source revision <code>{read.sourceRevision}</code> · rights revision <code>{read.rightsRevision}</code> · deadline {new Date(read.deadlineAt).toLocaleString()}</p>
      </details>
    </>:null}
  </section>
}
