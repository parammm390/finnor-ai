'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {centropyPost} from '../../../../../../src/components/centropy/lib/api';
import {usePrivateRequestScope} from '../../../../../../src/components/centropy/lib/use-private-request-scope';
import type {PeWorldRootRef} from '../../../../../../src/components/centropy/pe/contracts';

const id=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const reference=z.object({owner:z.string(),id:z.string(),version:z.string(),contentDigest:digest});
const viewSchema=z.object({
 sessionId:id,workId:id,workInputId:id,status:z.string(),currentness:z.enum(['CURRENT','STALE']),reason:z.string().nullable(),
 originalDeadline:z.string().datetime({offset:true}),privateOutputsWithheld:z.boolean(),
 remainingBudget:z.object({cpuReservedSeconds:z.number(),cpuLimitSeconds:z.number(),retainedBytes:z.number(),retainedByteLimit:z.number()}),
 capsule:z.object({digest,envelope:z.record(z.unknown()),statement:z.object({
  finalState:z.array(z.string()).max(8),steps:z.number(),program:z.object({registers:z.array(z.object({unit:z.string()})).max(8)}),
 }),artifact:z.object({proofBytes:z.number(),parameterHash:digest,planHash:digest}),
 verification:z.object({mode:z.literal('ORIGINAL_RELATION_AND_INPUT_COMMITMENT_THEN_PINNED_PROOF'),
  originalExecutionReplayed:z.literal(false),inputRows:z.number().int().min(1).max(256)}),
 verifier:z.object({binarySha256:digest,sourceDigest:digest})}).nullable(),
 delivery:z.object({state:z.string(),acks:z.array(z.string()),owner:z.string()}).nullable(),
 qualifications:z.record(z.string()),failure:z.string().nullable(),executionAuthorityGranted:z.literal(false),
 currentObligations:z.object({unknown:z.boolean(),refs:z.array(z.object({id:z.string(),status:z.string()})).max(128)}),
 costs:z.object({eligibleReuseN:z.number(),money:z.null(),humanSeconds:z.null(),aggregateRSS:z.null(),
  unknownAttemptCosts:z.number(),observedAnalyticalDeliveries:z.number()}),
});
type View=z.infer<typeof viewSchema>;
type FormOperation='intake'|'plan'|'submit';
type WriteOperation=FormOperation|'audit'|'consume'|'cancel';
const display=(s:string)=>s.replaceAll('_',' ').toLowerCase();
export function ExecutionProofPanel({root,workId,workInputId,onChanged}:{
 root:PeWorldRootRef;workId:string;workInputId?:string;onChanged?:()=>void;
}){
 const scope=usePrivateRequestScope(JSON.stringify([root.entityType,root.entityId,workId,workInputId??null]));
 const {key:scopeKey,allowed:scopeAllowed,isCurrent:scopeIsCurrent}=scope;
 const [saved,setSaved]=useState<{scope:string;view:View}|null>(null);
 const [draft,setDraft]=useState<{scope:string;text:string}|null>(null);
 const [receipt,setReceipt]=useState<{scope:string;value:unknown}|null>(null);
 const [notice,setNotice]=useState('No current proof evidence has been read.');
 const [busy,setBusy]=useState(false),[operation,setOperation]=useState<FormOperation>('plan');
 const writing=useRef<object|null>(null),epoch=useRef(0),latest=useRef(scope.key);
 latest.current=scope.key;
 const view=scope.allowed&&saved?.scope===scope.key?saved.view:null;
 const text=scope.allowed&&draft?.scope===scope.key?draft.text:'';
 const visible=()=>document.visibilityState==='visible'&&navigator.onLine;
 const refresh=useCallback(async()=>{
  const key=scopeKey,n=epoch.current;
  if(!scopeAllowed||!visible()||writing.current)return;
  try{
   const listed=z.object({workId:id,sessions:z.array(z.object({sessionId:id,status:z.string()})).max(16)}).parse(
    await centropyPost('company-brain/execution-proof-list',{root,workId}));
   if(!scopeIsCurrent(key)||n!==epoch.current||!visible())return;
   if(listed.workId!==workId)throw Error('Work mismatch');
   if(!listed.sessions.length){setSaved(null);setNotice('No ExecutionProofCapsule is registered for this original Work.');return;}
   const next=viewSchema.parse(await centropyPost('company-brain/execution-proof-read',{sessionId:listed.sessions[0]!.sessionId}));
   if(!scopeIsCurrent(key)||n!==epoch.current||!visible())return;
   if(next.workId!==workId||workInputId&&next.workInputId!==workInputId)throw Error('Work input mismatch');
   setSaved({scope:key,view:next});
   setNotice(next.currentness==='CURRENT'
    ?`${display(next.status)}. Exact integer history guard only, not the S3/S4 Float64 algorithm.`
    :'Current source, rights, Work or deadline could not be verified. Private proof output is withheld.');
  }catch{
   if(scopeIsCurrent(key)&&n===epoch.current){setSaved(null);setNotice('Current authorized proof evidence is unavailable. No write was retried.');}
  }
 },[scopeKey,scopeAllowed,scopeIsCurrent,root,workId,workInputId]);
 useEffect(()=>{
  epoch.current++;setSaved(null);setDraft(null);setReceipt(null);setBusy(false);writing.current=null;
 },[scope.key]);
 useEffect(()=>{
  if(!scope.allowed)return;
  let reading=false,stopped=false;
  const read=async()=>{if(stopped||reading)return;reading=true;try{await refresh();}finally{reading=false;}};
  const hide=()=>{epoch.current++;setSaved(null);setReceipt(null);setDraft(null);};
  const recheck=()=>{hide();if(visible())void read();};
  void read();
  const timer=setInterval(()=>void read(),5000);
  window.addEventListener('offline',hide);window.addEventListener('online',recheck);
  window.addEventListener('pagehide',hide);window.addEventListener('blur',hide);
  window.addEventListener('focus',recheck);document.addEventListener('visibilitychange',recheck);
  return()=>{stopped=true;hide();clearInterval(timer);
   window.removeEventListener('offline',hide);window.removeEventListener('online',recheck);
   window.removeEventListener('pagehide',hide);window.removeEventListener('blur',hide);
   window.removeEventListener('focus',recheck);document.removeEventListener('visibilitychange',recheck);};
 },[scope.allowed,refresh]);
 useEffect(()=>{
  if(!view||view.currentness!=='CURRENT')return;
  const timer=setTimeout(()=>{epoch.current++;setSaved(null);setReceipt(null);
   setNotice('The original deadline expired. Output cleared; no resources were renewed.');},
  Math.max(0,Date.parse(view.originalDeadline)-Date.now()));
  return()=>clearTimeout(timer);
 },[view]);
 async function act(name:WriteOperation,body:unknown,accepted?:(result:unknown)=>void){
  if(!scope.allowed||!scope.isCurrent(scope.key)||!visible()||writing.current)return;
  const key=scope.key,marker={},n=++epoch.current;
  writing.current=marker;setBusy(true);setSaved(null);setReceipt(null);
  try{
   if(!['intake','plan','submit','audit','consume','cancel'].includes(name))throw Error('Operation');
   const result=await centropyPost('company-brain/execution-proof-'+name,body);
   if(scope.isCurrent(key)&&epoch.current===n&&visible()){
    accepted?.(result);setNotice('Request recorded. Recheck this original Work for persisted evidence. No effect authority was granted.');
    onChanged?.();
   }
  }catch{
   if(scope.isCurrent(key)&&epoch.current===n)setNotice('Request refused or outcome uncertain. Recheck retained evidence; writes are never automatically retried.');
  }finally{
   if(writing.current===marker){writing.current=null;
    if(latest.current===key){setBusy(false);void refresh();}}
  }
 }
 function submitDefinition(){
  try{
   const body=JSON.parse(text) as Record<string,unknown>,r=body.root as PeWorldRootRef;
   if(!r||r.entityType!==root.entityType||r.entityId!==root.entityId||
    operation!=='intake'&&(body.workId!==workId||workInputId&&body.workInputId!==workInputId))throw Error('Scope');
   void act(operation,body,result=>{
    if(operation==='intake'){
     const native=z.object({workId:id,workInputId:id}).parse(result);
     setReceipt({scope:scope.key,value:native});setDraft(null);
    }else if(operation==='plan'){
     const native=z.object({workRevisionRef:reference}).parse(result);
     setReceipt({scope:scope.key,value:native});setOperation('submit');
     setDraft({scope:scope.key,text:JSON.stringify({...body,workRevisionRef:native.workRevisionRef},null,2)});
    }else{setDraft(null);setReceipt({scope:scope.key,value:result});}
   });
  }catch{setNotice('Enter the exact typed ordinary-disposable definition for this root and original Work. Do not enter credentials.');}
 }
 return <section aria-label="Execution proof capsule" className="ct-world-work__section">
  <h4>ExecutionProofCapsule</h4>
  <p>Public-input exact integer computation, checked by the pinned proof verifier and original semantics.
   This is not source truth, private-input security, a proof of the native Float64 solver, or permission to act.</p>
  <p role="status" aria-live="polite">{scope.allowed?notice:'Sign in with current owner access. Private proof output is hidden.'}</p>
  {scope.allowed?<button type="button" disabled={busy} onClick={()=>{epoch.current++;setSaved(null);void refresh();}}>Recheck execution proof</button>:null}
  {view?<article>
   <p>State: {display(view.status)}. Currentness: {display(view.currentness)}.</p>
   <p>Original deadline: <time dateTime={view.originalDeadline}>{view.originalDeadline}</time></p>
   <p>CPU reserved, never refunded: {view.remainingBudget.cpuReservedSeconds} / {view.remainingBudget.cpuLimitSeconds} seconds.
    Retained bytes: {view.remainingBudget.retainedBytes} / {view.remainingBudget.retainedByteLimit}.</p>
   {view.failure?<p>Retained refusal: {view.failure}</p>:null}
   {view.currentObligations.unknown?<p>Unresolved or unknown S6 obligations remain. Cancellation does not release or compensate them.</p>:null}
   <p>Native owner delivery: {view.delivery?display(view.delivery.state):'not observed'}.
    Eligible reuse N: {view.costs.eligibleReuseN}. Money, human work and aggregate RSS: unknown.</p>
   {view.capsule&&view.currentness==='CURRENT'&&!view.privateOutputsWithheld?<div>
    <h5>Checked integer result</h5>
    <dl>{view.capsule.statement.finalState.map((value,i)=><div key={i}><dt>Register {i}</dt>
     <dd>{value} {view.capsule!.statement.program.registers[i]?.unit}</dd></div>)}</dl>
    <p>{view.capsule.statement.steps} actual steps, {view.capsule.artifact.proofBytes} proof bytes.</p>
    <p>Audit and owner verification do not re-execute the programme.
     Original input binding still checks {view.capsule.verification.inputRows} rows.</p>
    <details><summary>Current build and proof identities</summary><pre>{JSON.stringify({
     capsuleDigest:view.capsule.digest,planHash:view.capsule.artifact.planHash,parameterHash:view.capsule.artifact.parameterHash,
     verification:view.capsule.verification,verifier:view.capsule.verifier},null,2)}</pre></details>
    <button type="button" disabled={busy} onClick={()=>void act('audit',{sessionId:view.sessionId})}>Run independent audit</button>
    <button type="button" disabled={busy||view.delivery?.state==='DELIVERING'} onClick={()=>void act('consume',{
     sessionId:view.sessionId,capsuleDigest:view.capsule!.digest,idempotencyKey:crypto.randomUUID()})}>Use exact native owner guard</button>
   </div>:null}
   {!['CANCELLED','STALE'].includes(view.status)?<button type="button" disabled={busy}
    onClick={()=>void act('cancel',{sessionId:view.sessionId})}>Cancel without releasing obligations</button>:null}
   <details><summary>Separate qualification gates</summary><dl>{Object.entries(view.qualifications).map(([gate,status])=>
    <div key={gate}><dt>{gate}</dt><dd>{display(status)}</dd></div>)}</dl></details>
  </article>:null}
  {scope.allowed?<details><summary>Exact computation and original Work controls</summary>
   <p>Planning and submission keep the selected original Work. Intake creates a different original Work, which must be selected separately.
    Definitions and results stay in memory and are cleared when the authenticated scope changes.</p>
   <form onSubmit={event=>{event.preventDefault();submitDefinition();}}>
    <label>Proof operation<select value={operation} disabled={busy} onChange={event=>{
     setOperation(event.target.value as FormOperation);setDraft(null);setReceipt(null);
    }}><option value="plan">Select original proof plan</option><option value="submit">Submit exact computation</option>
     <option value="intake">Accept new original proof Work</option></select></label>
    <label>Typed ordinary-disposable definition<textarea value={text} maxLength={65536} disabled={busy}
     onChange={event=>setDraft({scope:scope.key,text:event.target.value})}/></label>
    <button type="submit" disabled={busy||!text.trim()}>Record proof request</button>
   </form>
  </details>:null}
  {scope.allowed&&receipt?.scope===scope.key?<details open><summary>Native Work references, not completion</summary>
   <pre>{JSON.stringify(receipt.value,null,2)}</pre></details>:null}
 </section>;
}
