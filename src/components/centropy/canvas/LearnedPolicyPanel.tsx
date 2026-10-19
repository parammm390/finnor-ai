"use client"
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {z} from 'zod'
import {useCentropyAuth} from '@/components/centropy/lib/centropy-auth'
import {CentropyApiError,centropyGet,centropyPost} from '@/components/centropy/lib/api'
import {applicationPost,ApplicationRecordSchema} from './application-client'
const viewSchema=z.object({
 compilationId:z.string().uuid(),workId:z.string().uuid(),root:z.object({entityType:z.string(),entityId:z.string().uuid()}),
 status:z.string(),current:z.boolean(),currentnessReason:z.string().nullable(),headReleaseId:z.string().uuid().nullable(),
 identity:z.object({releaseId:z.string(),policyDigest:z.string(),originalCheckpointDigest:z.string(),checkpointDigest:z.string(),sourceDigest:z.string()}).nullable(),
 capsule:z.unknown().nullable(),uses:z.array(z.object({id:z.string(),status:z.string(),mode:z.string().nullable(),disposition:z.string().nullable()}).passthrough()),
 evaluations:z.array(z.object({id:z.string(),status:z.string(),result:z.unknown().nullable()}).passthrough()),history:z.array(z.unknown()),
 counters:z.object({attempts:z.number(),maxAttempts:z.number(),uses:z.number(),maxUses:z.number(),dataBytes:z.number(),deadlineAt:z.string()}),
 protectedAdmission:z.literal(false),productionActive:z.literal(false),
}).passthrough()
type View=z.infer<typeof viewSchema>
const post=<T,>(operation:string,body:unknown)=>centropyPost<T>('company-brain/learning-'+operation,body)
const pretty=(value:unknown)=>JSON.stringify(value,null,2)
export function LearnedPolicyPanel({root,workId,threadId}:{root:{entityType:string;entityId:string};workId:string|null;threadId:string}){
 const {session}=useCentropyAuth(),logical=JSON.stringify([session?.user.id??null,root.entityType,root.entityId,workId,threadId]),identity=JSON.stringify([logical,session?.access_token??null])
 const identityRef=useRef(identity);identityRef.current=identity
 const epoch=useRef(0),logicalRef=useRef(logical),scope=useRef<string|null>(null),selected=useRef(''),busyRef=useRef(false)
 const pending=useRef<{scope:string;operation:string;fingerprint:string;body:Record<string,unknown>}|null>(null)
 const [display,setDisplay]=useState<{identity:string;view:View}|null>(null),[rows,setRows]=useState<{identity:string;items:{id:string;status:string}[]}|null>(null)
 const [actor,setActor]=useState<{identity:string;scope:string}|null>(null),[formIdentity,setFormIdentity]=useState(identity),[busy,setBusy]=useState(false)
 const [message,setMessage]=useState('Select current Work to inspect learned policies.'),[observation,setObservation]=useState<{identity:string;value:unknown}|null>(null)
 const [sourceApplication,setSourceApplication]=useState(''),[consentId,setConsentId]=useState(''),[selection,setSelection]=useState('[]'),[cut,setCut]=useState('')
 const [validUntil,setValidUntil]=useState(''),[transfer,setTransfer]=useState('SOURCE_APPLICATION_ONLY'),[targetApplication,setTargetApplication]=useState(''),[recordId,setRecordId]=useState('')
 const [mode,setMode]=useState('COMPILED_TRAINED'),[stratum,setStratum]=useState('TRANSFER'),[uses,setUses]=useState(''),[retained,setRetained]=useState(''),[reason,setReason]=useState(''),[revisionRef,setRevisionRef]=useState('')
 const [assignment,setAssignment]=useState(''),[caseId,setCaseId]=useState(''),[replicas,setReplicas]=useState('[]'),[controllerRevision,setControllerRevision]=useState('TRAINED')
 const [rollbackRelease,setRollbackRelease]=useState('')
 const visible=display?.identity===identity?display.view:null,enabled=!!session&&!!workId&&formIdentity===identity&&actor?.identity===identity
 const clearForms=()=>{setSourceApplication('');setConsentId('');setSelection('[]');setCut('');setValidUntil('');setTargetApplication('');setRecordId('');setUses('');setRetained('');setReason('');setRevisionRef('');setAssignment('');setCaseId('');setReplicas('[]');setTransfer('SOURCE_APPLICATION_ONLY');setMode('COMPILED_TRAINED');setStratum('TRANSFER');setControllerRevision('TRAINED');setRollbackRelease('')}
 const refresh=useCallback(async(sequence:number,preferred?:string)=>{
  if(!session||!workId)return;const expected=identity;
  const current=()=>epoch.current===sequence&&identityRef.current===expected
  try{
   const me=await centropyGet<{tenantId:string;userId:string;employeeId:string|null}>('me')
   if(!current())return
   if(!me.tenantId||!me.userId)throw Error('X5_ACTOR_UNAVAILABLE')
   const canonical=JSON.stringify([logical,me.tenantId,me.userId,me.employeeId])
   if(scope.current!==null&&scope.current!==canonical){pending.current=null;selected.current='';setDisplay(null);setObservation(null);clearForms()}
   scope.current=canonical;setActor({identity:expected,scope:canonical})
   const list=await post<{compilations:{id:string;status:string}[]}>('list',{root,workId})
   if(!current())return
   setRows({identity:expected,items:list.compilations})
   const id=preferred||selected.current||list.compilations[0]?.id
   if(!id){setDisplay(null);setMessage('No learned policy is registered for this Work. Explicit consent and accepted native experience are required.');return}
   const data=viewSchema.parse(await post('read',{compilationId:id}))
   if(!current())return
   if(data.workId!==workId||data.root.entityId!==root.entityId||data.root.entityType!==root.entityType)throw Error('X5_SCOPE_CHANGED')
   selected.current=id;setDisplay({identity:expected,view:data})
   setMessage(data.current?'Development policy available. Independent business approval, S8 admission and production remain separate.':`${data.status}. ${data.currentnessReason??'No current published policy.'}`)
  }catch{if(current()){setDisplay(null);setObservation(null);setRows(null);setActor(null);setMessage('Current learned policy cannot be verified in this identity and scope. Reload before acting.')}}
 },[session,workId,identity,logical,root])
 useEffect(()=>{
  if(logicalRef.current!==logical){pending.current=null;scope.current=null;logicalRef.current=logical}
  const fence=epoch,sequence=++fence.current;selected.current='';busyRef.current=false
  setDisplay(null);setRows(null);setActor(null);setObservation(null);setBusy(false);clearForms();setFormIdentity(identity)
  void refresh(sequence)
  return()=>{fence.current++}
  // Identity owns reset; response-driven selection does not.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[identity])
 useEffect(()=>{
  if(!session||!workId)return
  const poll=()=>{if(!busyRef.current&&document.visibilityState==='visible')void refresh(++epoch.current)}
  const timer=setInterval(poll,4000)
  const focus=()=>{if(!busyRef.current){setDisplay(null);void refresh(++epoch.current)}}
  window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus)
  return()=>{clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus)}
 },[session,workId,refresh])
 async function run(operation:string,body:Record<string,unknown>,mutation=true,resume=false){
  if(!enabled||busyRef.current)return
  const retained=pending.current
  if(resume&&(!retained||retained.scope!==actor!.scope))return
  const fingerprint=resume?retained!.fingerprint:JSON.stringify([actor!.scope,operation,body])
  if(mutation&&!resume&&retained&&retained.fingerprint!==fingerprint){setMessage('Resolve or explicitly stop retrying the uncertain original request before starting another mutation.');return}
  const expected=identity,sequence=++epoch.current,oldId=selected.current
  const current=()=>identityRef.current===expected&&epoch.current===sequence
  if(mutation&&!resume&&pending.current?.fingerprint!==fingerprint)pending.current={scope:actor!.scope,operation,fingerprint,body:{...body,idempotencyKey:crypto.randomUUID()}}
  const invocation=mutation?pending.current!.body:body
  busyRef.current=true;setBusy(true);setObservation(null)
  if(['revoke-consent','invalidate','cancel'].includes(operation))setDisplay(null)
  try{
   const result=await post<Record<string,unknown>>(operation,invocation)
   if(!current())return
   if(mutation)pending.current=null
   setObservation({identity:expected,value:result})
   await refresh(sequence,typeof result.compilationId==='string'?result.compilationId:oldId)
   if(current())setMessage('Owner response recorded below. Queued work is not task completion or admission.')
  }catch(error){if(current()){
   const changedSession=error instanceof CentropyApiError&&!!error.details&&typeof error.details==='object'&&'code'in error.details&&error.details.code==='AUTHENTICATED_SCOPE_CHANGED'
   if(mutation&&error instanceof CentropyApiError&&!error.retryable&&!changedSession)pending.current=null
   setDisplay(null);setMessage(error instanceof Error?error.message:'Owner operation unavailable. Reload canonical history before retrying; uncertain requests retain their invocation identity.')
  }}
  finally{if(current()){busyRef.current=false;setBusy(false)}}
 }
 async function compile(event:FormEvent){
  event.preventDefault()
  try{await run('submit',{schema:'finnor.x5.compile-request.v1',root,workId,experience:JSON.parse(selection),knowledgeCut:cut,limits:{deadlineMs:3600000,maxAttempts:8,maxUses:256}})}
  catch{setMessage('Supply explicit bounded JSON selections and an ISO knowledge cut.')}
 }
 async function execute(event:FormEvent){
  event.preventDefault();if(!visible||!enabled||busyRef.current)return
  const expected=identity,sequence=++epoch.current;busyRef.current=true;setBusy(true)
  try{
   const record=ApplicationRecordSchema.parse(await applicationPost('record',{applicationId:targetApplication,recordId}))
   if(identityRef.current!==expected||epoch.current!==sequence||selected.current!==visible.compilationId)return
   const assignmentRef=assignment?JSON.parse(assignment):undefined
   busyRef.current=false;setBusy(false)
   await run('execute',{compilationId:visible.compilationId,releaseId:visible.headReleaseId,applicationId:targetApplication,recordId,expectedRevision:record.revision,expectedReference:record.reference,mode,stratum,...(assignmentRef?{assignmentRef}:{})})
  }catch{if(identityRef.current===expected&&epoch.current===sequence)setMessage('Fresh native record binding could not be verified. No execution was submitted.')}
  finally{if(identityRef.current===expected&&epoch.current===sequence){busyRef.current=false;setBusy(false)}}
 }
 return <section className="ct-evidence ct-learned-policy" aria-label="Experience to policy" data-learning-work={workId??'none'} data-learning-id={visible?.compilationId??'none'}>
  <h4>Experience to policy</h4><p role="status" aria-live="polite">{formIdentity===identity?message:'Identity changed. Rechecking current Work and rights.'}</p>
  <p>Structural CPU learning, not financial reward learning. Exact native reconciliation and separate-principal approval remain mandatory. No learned effect authority.</p>
  {enabled?<><button type="button" disabled={busy} onClick={()=>{setDisplay(null);void refresh(++epoch.current)}}>Reload learned policy</button>
   {pending.current?.scope===actor?.scope?<div role="status"><p>An uncertain original request is retained, including its exact record, policy, checkpoint and invocation identity.</p>
    <button type="button" disabled={busy} onClick={()=>{const value=pending.current;if(value)void run(value.operation,value.body,true,true)}}>Retry original owner request</button>
    <button type="button" disabled={busy} onClick={()=>{pending.current=null;setMessage('Stopped retrying locally. Committed or queued server work and audit history remain.')}}>Stop retrying, retain server history</button>
   </div>:null}
   {rows?.identity===identity&&rows.items.length?<label>Learned policy<select value={visible?.compilationId??selected.current} disabled={busy||!!pending.current} onChange={e=>{selected.current=e.target.value;setDisplay(null);setObservation(null);clearForms();void refresh(++epoch.current,e.target.value)}}>{rows.items.map(v=><option key={v.id} value={v.id}>{v.id} · {v.status}</option>)}</select></label>:null}
   <details><summary>Authorize structural training rights</summary><form onSubmit={event=>{event.preventDefault();void run('consent',{schema:'finnor.x5.training-rights.v1',applicationId:sourceApplication,purposes:['TRAIN_STRUCTURAL_CONTROLLER','EXECUTE_DERIVED_POLICY'],transfer,failures:'NONPOSITIVE_STRUCTURAL_OBSERVATIONS_ONLY',data:'STRUCTURAL_BOOLEANS_ONLY_NO_TEXT_AMOUNTS_IDENTIFIERS_CREDENTIALS',retention:'RETAIN_AUDIT_REVOKE_DERIVED_USE_NO_UNLEARNING_CLAIM',knowledgeCut:cut,validUntil})}}>
    <label>Source application<input value={sourceApplication} onChange={e=>setSourceApplication(e.target.value)} required/></label>
    <label>Rights expiry, ISO timestamp<input value={validUntil} onChange={e=>setValidUntil(e.target.value)} required/></label>
    <label>Rights knowledge cut, ISO timestamp<input value={cut} onChange={e=>setCut(e.target.value)} required/></label>
    <label>Transfer permission<select value={transfer} onChange={e=>setTransfer(e.target.value)}><option value="SOURCE_APPLICATION_ONLY">Source application only</option><option value="SAME_TENANT_COMPATIBLE_APPLICATIONS">Compatible applications in this tenant</option></select></label><button disabled={busy}>Grant explicit training consent</button></form>
    <label>Consent to revoke<input value={consentId} onChange={e=>setConsentId(e.target.value)}/></label><label>Reason<input value={reason} onChange={e=>setReason(e.target.value)}/></label>
    <button disabled={busy||!consentId||!reason} onClick={()=>void run('revoke-consent',{consentId,reason})}>Revoke derived use, retain audit</button>
   </details>
   <details><summary>Compile independently accepted experience</summary><form onSubmit={event=>void compile(event)}>
    <label>Native selections JSON<textarea value={selection} onChange={e=>setSelection(e.target.value)} rows={5} required spellCheck={false}/></label><small>Each selection contains applicationId, recordIds and consentId. No supplied success grades or receipts.</small>
    <label>Knowledge cut, ISO timestamp<input value={cut} onChange={e=>setCut(e.target.value)} required/></label>
    <button type="button" disabled={busy||!cut} onClick={()=>{try{void run('experience',{experience:JSON.parse(selection),knowledgeCut:cut},false)}catch{setMessage('Invalid selections JSON.')}}}>Inspect canonical accepted experience</button>
    <button disabled={busy||!!visible}>Compile and train under original Work</button>
    {visible?<button type="button" disabled={busy||!reason} onClick={()=>{try{void run('retrain',{compilationId:visible.compilationId,experience:JSON.parse(selection),knowledgeCut:cut,reason})}catch{setMessage('Supply explicit current consented selections and the new knowledge cut.')}}}>Train another revision, same original allocation</button>:null}
   </form></details>
  </>:null}
  {visible?<><p>{visible.status} · {visible.current?'current development release':'not current'}. Attempts {visible.counters.attempts}/{visible.counters.maxAttempts}; uses {visible.counters.uses}/{visible.counters.maxUses}; retained {visible.counters.dataBytes} bytes. Original deadline {visible.counters.deadlineAt}.</p>
   <details><summary>Exact policy and checkpoint identities</summary><pre>{pretty(visible.identity)}</pre></details>
   {visible.current&&enabled?<><form onSubmit={event=>void execute(event)}><h5>Fresh guarded native use</h5>
    <label>Destination application<input value={targetApplication} onChange={e=>setTargetApplication(e.target.value)} required/></label><label>Fresh native record<input value={recordId} onChange={e=>setRecordId(e.target.value)} required/></label>
    <label>Controller arm<select value={mode} onChange={e=>setMode(e.target.value)}>{['COMPILED_TRAINED','COMPILED_ORIGINAL','NATIVE_EXACT','COMPILED_NO_NEURAL'].map(v=><option key={v}>{v}</option>)}</select></label>
    <label>Registered development stratum<select value={stratum} onChange={e=>setStratum(e.target.value)}>{['TRANSFER','RETENTION','BOUNDARY'].map(v=><option key={v}>{v}</option>)}</select></label><button disabled={busy}>Run guarded next step</button><p>This cannot approve its own work. Use the native application as a separate authorized approver.</p>
    <label>Scored assignment reference JSON, optional<textarea value={assignment} onChange={e=>setAssignment(e.target.value)}/></label>
   </form>
   <details><summary>Independent outcomes and S8 admission</summary>
    <form onSubmit={event=>{event.preventDefault();try{void run('register-assignment',{compilationId:visible.compilationId,releaseId:visible.headReleaseId,caseId,replicas:JSON.parse(replicas)})}catch{setMessage('Supply four distinct native replica identities.')}}}>
     <label>Preregistered development case<input value={caseId} onChange={e=>setCaseId(e.target.value)} required/></label>
     <label>Four native replica identities JSON<textarea value={replicas} onChange={e=>setReplicas(e.target.value)} required/></label>
     <button disabled={busy}>Independent evaluator, freeze native assignment</button><p>A different current evaluator must register actual replicas before use. Caller grades are not accepted.</p>
    </form>
    <label>Assigned transfer and boundary use IDs, comma separated<textarea value={uses} onChange={e=>setUses(e.target.value)}/></label><label>Assigned retained-domain use IDs, comma separated<textarea value={retained} onChange={e=>setRetained(e.target.value)}/></label>
    <button disabled={busy} onClick={()=>void run('evaluate',{compilationId:visible.compilationId,releaseId:visible.headReleaseId,useIds:uses.split(',').map(v=>v.trim()).filter(Boolean),retainedUseIds:retained.split(',').map(v=>v.trim()).filter(Boolean)})}>Request independent native evaluation</button>
    <label>S8 controller revision<select value={controllerRevision} onChange={e=>setControllerRevision(e.target.value)}><option value="TRAINED">Trained component</option><option value="ORIGINAL_ABLATION">Original checkpoint, negative control</option></select></label>
    <button disabled={busy} onClick={()=>void run('s8-propose',{compilationId:visible.compilationId,releaseId:visible.headReleaseId,controllerRevision})}>Propose to separate S8 owner</button>
    <label>S8 revision reference JSON<textarea value={revisionRef} onChange={e=>setRevisionRef(e.target.value)}/></label><button disabled={busy||!revisionRef} onClick={()=>{try{void run('admission',{compilationId:visible.compilationId,releaseId:visible.headReleaseId,revisionRef:JSON.parse(revisionRef)},false)}catch{setMessage('Invalid revision reference JSON.')}}}>Check current S8 admission</button>
    <p>The compiler cannot sign independent evaluation or promotion. Disposable S8 admission is not protected qualification or production.</p>
   </details></>:null}
   {enabled?<details><summary>Cancel, invalidate, retry or select an earlier revision</summary><label>Lifecycle reason<input value={reason} onChange={e=>setReason(e.target.value)}/></label>{['cancel','invalidate','retry'].map(op=><button key={op} disabled={busy||!reason} onClick={()=>void run(op,{compilationId:visible.compilationId,reason})}>{op} without renewing resources</button>)}<label>Earlier release identity<input value={rollbackRelease} onChange={e=>setRollbackRelease(e.target.value)}/></label><button disabled={busy||!rollbackRelease} onClick={()=>void run('rollback',{compilationId:visible.compilationId,releaseId:rollbackRelease})}>Select only if independently current, no resource renewal</button></details>:null}
   <details><summary>Capsule, accepted evidence, guard, training and unresolved costs</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{pretty(visible.capsule??{redacted:'Current rights or dependencies unavailable. Private capsule is withheld.'})}</pre></details>
   <details><summary>Actual native uses, waits and fallback</summary><pre>{pretty(visible.uses)}</pre></details>
   <details><summary>Transfer, retention and parameter/procedure ablations</summary><pre>{pretty(visible.evaluations)}</pre></details>
   <details><summary>Immutable lifecycle and failed attempts</summary><pre>{pretty(visible.history)}</pre></details>
  </>:null}
  {observation?.identity===identity?<details open><summary>Latest owner response</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{pretty(observation.value)}</pre></details>:null}
 </section>
}
