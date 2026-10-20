"use client"
import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {z} from 'zod'
import {useCentropyAuth} from '@/components/centropy/lib/centropy-auth'
import {CentropyApiError,centropyGet,centropyPost} from '@/components/centropy/lib/api'

const rootSchema=z.object({entityType:z.literal('pe_deal'),entityId:z.string().uuid()}).strict()
const modelSchema=z.object({id:z.string().uuid(),achievedClaimClass:z.enum(['PREDICTIVE','INTERVENTION_IDENTIFIED']),requestedClaimSatisfied:z.boolean(),
 analysis:z.object({predicateIds:z.array(z.string()),numericIds:z.array(z.string()),refutations:z.array(z.unknown())}).passthrough(),
 equivalence:z.object({survivingCartesianProduct:z.string(),uniqueHiddenMechanism:z.literal(false)}).passthrough(),
 protectedAdmission:z.literal(false),productionActive:z.literal(false)}).passthrough()
const viewSchema=z.object({identificationId:z.string().uuid(),workId:z.string().uuid(),workInputId:z.string().uuid(),ownerId:z.string().uuid(),root:rootSchema,
 status:z.string(),generation:z.number(),mode:z.string(),current:z.boolean(),currentnessReason:z.string().nullable(),question:z.object({text:z.string(),target:z.string(),affectedDecision:z.string(),requestedClaimClass:z.string()}),
 model:modelSchema.nullable(),family:z.unknown(),instruments:z.array(z.unknown()),experiments:z.array(z.object({id:z.string().uuid(),phase:z.string(),status:z.string(),condition:z.unknown(),protocolDigest:z.string()}).passthrough()),
 assignments:z.array(z.unknown()),uses:z.array(z.unknown()),limits:z.object({deadlineAt:z.string(),original:z.unknown(),spent:z.unknown()}),
 protectedAdmission:z.literal(false),productionActive:z.literal(false)}).passthrough()
const listSchema=z.object({identifications:z.array(z.object({identificationId:z.string().uuid(),workId:z.string().uuid(),status:z.string(),modelId:z.string().uuid().nullable()}))})
type View=z.infer<typeof viewSchema>
const IDENTIFICATION_POST_OPERATIONS=['targets','consent','revoke-consent','submit','read','list','history','experiment','replicate','use','cancel','invalidate','retry','s8-propose','admission'] as const
const post=<T,>(operation:string,body:unknown)=>{
 const registered=IDENTIFICATION_POST_OPERATIONS.find(value=>value===operation)
 if(!registered)throw new Error('IDENTIFICATION_INVALID_OPERATION')
 return centropyPost<T>('company-brain/identification-'+registered,body)
}
const pretty=(value:unknown)=>JSON.stringify(value,null,2)
type Pending={scope:string;operation:string;fingerprint:string;body:Record<string,unknown>}

/** Browser state is presentation only. Every read/mutation re-enters current
 * canonical authority; an uncertain request retains its exact invocation. */
export function IdentifiedSystemPanel({root,workId,threadId}:{root:{entityType:'pe_deal';entityId:string};workId:string;threadId:string}){
 const {session}=useCentropyAuth()
 const logical=JSON.stringify([session?.user.id??null,root.entityType,root.entityId,workId,threadId]),identity=JSON.stringify([logical,session?.access_token??null])
 const identityRef=useRef(identity);identityRef.current=identity
 const epoch=useRef(0),logicalRef=useRef(logical),scope=useRef<string|null>(null),selected=useRef(''),busyRef=useRef(false),pending=useRef<Pending|null>(null)
 const refreshing=useRef<object|null>(null)
 const [display,setDisplay]=useState<{identity:string;view:View}|null>(null),[rows,setRows]=useState<{identity:string;items:z.infer<typeof listSchema>['identifications']}|null>(null)
 const [actor,setActor]=useState<{identity:string;scope:string;principalId:string}|null>(null),[formIdentity,setFormIdentity]=useState(identity),[busy,setBusy]=useState(false)
 const [message,setMessage]=useState('Checking current Work and experiment rights.'),[observation,setObservation]=useState<{identity:string;value:unknown}|null>(null)
 const [history,setHistory]=useState<{identity:string;events:unknown[];next:string|null}|null>(null)
 const [domain,setDomain]=useState(''),[consentId,setConsentId]=useState(''),[sourceTargetId,setSourceTargetId]=useState(''),[replicaTargetId,setReplicaTargetId]=useState('')
 const [replicatorId,setReplicatorId]=useState(''),[validUntil,setValidUntil]=useState(''),[workstreamId,setWorkstreamId]=useState(''),[investmentCaseId,setInvestmentCaseId]=useState('')
 const [question,setQuestion]=useState(''),[target,setTarget]=useState(''),[affectedDecision,setAffectedDecision]=useState(''),[claim,setClaim]=useState('INTERVENTION_IDENTIFIED'),[mode,setMode]=useState('ACTIVE')
 const [deadlineMs,setDeadlineMs]=useState('3600000'),[maxExperiments,setMaxExperiments]=useState('32'),[maxObservations,setMaxObservations]=useState('256')
 const [maxAnalysis,setMaxAnalysis]=useState('64'),[maxUses,setMaxUses]=useState('4'),[reason,setReason]=useState(''),[revisionRef,setRevisionRef]=useState(''),[changed,setChanged]=useState('observations')
 const visible=display?.identity===identity?display.view:null,enabled=!!session&&formIdentity===identity&&actor?.identity===identity
 const clearForms=()=>{
  setDomain('');setConsentId('');setSourceTargetId('');setReplicaTargetId('');setReplicatorId('');setValidUntil('');setWorkstreamId('');setInvestmentCaseId('')
  setQuestion('');setTarget('');setAffectedDecision('');setClaim('INTERVENTION_IDENTIFIED');setMode('ACTIVE');setDeadlineMs('3600000');setMaxExperiments('32');setMaxObservations('256');setMaxAnalysis('64');setMaxUses('4');setReason('');setRevisionRef('');setChanged('observations')
 }
 const refresh=useCallback(async(sequence:number,preferred?:string)=>{
  if(!session)return
  const reading={};refreshing.current=reading
  const expected=identity,current=()=>epoch.current===sequence&&identityRef.current===expected
  try{
   const me=await centropyGet<{tenantId:string;userId:string;employeeId:string|null}>('me')
   if(!current())return
   if(!z.string().uuid().safeParse(me.tenantId).success||me.userId!==session.user.id||me.employeeId!==me.userId)throw Error('Current employee is unavailable.')
   const canonical=JSON.stringify([logical,me.tenantId,me.userId,me.employeeId])
   if(scope.current!==null&&scope.current!==canonical){pending.current=null;selected.current='';setDisplay(null);setObservation(null);setHistory(null);clearForms()}
   scope.current=canonical;setActor({identity:expected,scope:canonical,principalId:me.employeeId})
   const list=listSchema.parse(await post('list',{root,workId}))
   if(!current())return
   if(list.identifications.some(v=>v.workId!==workId))throw Error('Work scope changed.')
   setRows({identity:expected,items:list.identifications})
   const id=preferred||selected.current||list.identifications[0]?.identificationId
   if(!id){setDisplay(null);setMessage('No identification is registered. Explicit test-service rights and a finite domain are required.');return}
   if(!list.identifications.some(v=>v.identificationId===id))throw Error('Identification is not in current Work.')
   const data=viewSchema.parse(await post('read',{identificationId:id}))
   if(!current())return
   if(data.workId!==workId||data.root.entityId!==root.entityId||data.root.entityType!==root.entityType)throw Error('Work scope changed.')
   selected.current=id;setDisplay({identity:expected,view:data})
   setMessage(data.current?'Current finite-domain development model. Actual decision use, S8 admission and production remain separate.':`${data.status}. ${data.currentnessReason??'No current checked model yet.'}`)
  }catch{if(current()){setDisplay(null);setRows(null);setObservation(null);setHistory(null);setActor(null);setMessage('Current Work or rights cannot be verified. Reload before acting.')}}
  finally{if(refreshing.current===reading)refreshing.current=null}
 },[session,identity,logical,root,workId])
 useEffect(()=>{
  if(logicalRef.current!==logical){pending.current=null;scope.current=null;logicalRef.current=logical}
  const fence=epoch,sequence=++fence.current
  selected.current='';busyRef.current=false;setDisplay(null);setRows(null);setActor(null);setObservation(null);setHistory(null);setBusy(false);clearForms();setFormIdentity(identity)
  void refresh(sequence)
  return()=>{fence.current++}
  // Identity owns the reset, not responses or polling.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[identity])
 useEffect(()=>{
  if(!session)return
  const poll=()=>{if(!busyRef.current&&!refreshing.current&&document.visibilityState==='visible'&&navigator.onLine)void refresh(++epoch.current)}
  const reconnect=()=>{if(!busyRef.current){setDisplay(null);setObservation(null);setHistory(null);setActor(null);void refresh(++epoch.current)}}
  const offline=()=>{epoch.current++;busyRef.current=false;setBusy(false);setDisplay(null);setObservation(null);setHistory(null);setActor(null);setMessage('Offline. Current authority is not verified. Retained uncertain requests do not become new requests.')}
  const timer=setInterval(poll,4000)
  window.addEventListener('focus',reconnect);window.addEventListener('online',reconnect);window.addEventListener('offline',offline);document.addEventListener('visibilitychange',reconnect)
  return()=>{clearInterval(timer);window.removeEventListener('focus',reconnect);window.removeEventListener('online',reconnect);window.removeEventListener('offline',offline);document.removeEventListener('visibilitychange',reconnect)}
 },[session,refresh])
 async function run(operation:string,body:Record<string,unknown>,mutation=true,resume=false){
  if(!enabled||busyRef.current)return
  const retained=pending.current
  if(resume&&(!retained||retained.scope!==actor!.scope))return
  const fingerprint=resume?retained!.fingerprint:JSON.stringify([actor!.scope,operation,body])
  if(mutation&&!resume&&retained&&retained.fingerprint!==fingerprint){setMessage('Resolve the uncertain original request before another mutation.');return}
  const expected=identity,sequence=++epoch.current,oldId=selected.current,current=()=>identityRef.current===expected&&epoch.current===sequence
  if(mutation&&!resume&&!retained)pending.current={scope:actor!.scope,operation,fingerprint,body:{...body,idempotencyKey:crypto.randomUUID()}}
  const invocation=mutation?pending.current!.body:body
  busyRef.current=true;setBusy(true);setObservation(null);setHistory(null)
  if(['revoke-consent','invalidate','cancel'].includes(operation))setDisplay(null)
  try{
   const result=await post<Record<string,unknown>>(operation,invocation)
   if(!current())return
   if(mutation)pending.current=null
   setObservation({identity:expected,value:result})
   if(typeof result.consentId==='string'&&operation==='consent')setConsentId(result.consentId)
   await refresh(sequence,typeof result.identificationId==='string'?result.identificationId:oldId||undefined)
   if(current())setMessage('Owner response recorded. Acknowledgment or queued Work is not scientific acceptance or completion.')
  }catch(error){if(current()){
   const changedScope=error instanceof CentropyApiError&&!!error.details&&typeof error.details==='object'&&'code'in error.details&&error.details.code==='AUTHENTICATED_SCOPE_CHANGED'
   if(mutation&&error instanceof CentropyApiError&&!error.retryable&&!changedScope)pending.current=null
   setDisplay(null);setMessage(error instanceof Error?error.message:'Owner operation unavailable. Read retained history before retrying.')
  }}finally{if(current()){busyRef.current=false;setBusy(false)}}
 }
 async function readHistory(before?:string){
  if(!visible||!enabled||busyRef.current)return
  const expected=identity,sequence=++epoch.current,id=visible.identificationId
  busyRef.current=true;setBusy(true)
  try{
   const data=z.object({events:z.array(z.unknown()),next:z.string().nullable()}).parse(await post('history',{identificationId:id,limit:25,...(before?{before}:{})}))
   if(identityRef.current===expected&&epoch.current===sequence&&selected.current===id)setHistory({identity:expected,...data})
  }catch{if(identityRef.current===expected&&epoch.current===sequence){setHistory(null);setDisplay(null);setMessage('Current history cannot be verified.')}}
  finally{if(identityRef.current===expected&&epoch.current===sequence){busyRef.current=false;setBusy(false)}}
 }
 function submit(event:FormEvent){
  event.preventDefault()
  try{void run('submit',{schema:'finnor.x4.identification-request.v1',root,workId,consentId,sourceTargetId,replicationTargetId:replicaTargetId,
   question:{text:question,target,affectedDecision,requestedClaimClass:claim},decision:{workstreamId,investmentCaseId},domain:JSON.parse(domain),mode,
   limits:{deadlineMs:Number(deadlineMs),maxExperiments:Number(maxExperiments),maxObservationCalls:Number(maxObservations),maxAnalysisJobs:Number(maxAnalysis),maxUses:Number(maxUses)}})}
  catch{setMessage('Supply the registered bounded domain as JSON. No request was submitted.')}
 }
 const locked=busy||!enabled
 return <section className="ct-evidence ct-identified-system" aria-label="Autonomous system identification" data-identification-work={workId} data-identification-id={visible?.identificationId??'none'}>
  <h4>Autonomous system identification</h4>
  <p role="status" aria-live="polite">{formIdentity===identity?message:'Identity changed. Rechecking current Work and rights.'}</p>
  <p>Consent-bound disposable test services only. Exact integer predictions and independent replication do not establish a unique hidden mechanism, financial success or production authority.</p>
  <button type="button" disabled={busy||!session} onClick={()=>{setDisplay(null);setHistory(null);void refresh(++epoch.current)}}>Reload identified system</button>
  {enabled&&pending.current?.scope===actor?.scope?<div role="status"><p>An uncertain original request retains its exact payload and idempotency key. Server effects and spent resources remain.</p>
   <button type="button" disabled={busy} onClick={()=>{const p=pending.current;if(p)void run(p.operation,p.body,true,true)}}>Retry original identification request</button>
   <button type="button" disabled={busy} onClick={()=>{pending.current=null;setMessage('Stopped retrying locally. Queued Work, effects and audit history remain.')}}>Stop retrying, retain history</button>
  </div>:null}
  {enabled?<fieldset disabled={locked}><legend>Current Work experiment controls</legend>
   {rows?.identity===identity&&rows.items.length?<label>Identification<select value={visible?.identificationId??selected.current} onChange={e=>{selected.current=e.target.value;setDisplay(null);setObservation(null);setHistory(null);clearForms();void refresh(++epoch.current,e.target.value)}} disabled={!!pending.current}>{rows.items.map(v=><option key={v.identificationId} value={v.identificationId}>{v.identificationId} · {v.status}</option>)}</select></label>:null}
   <button type="button" onClick={()=>void run('targets',{root},false)}>Inspect permitted test targets</button>
   <details><summary>Authorize finite experiment rights</summary>
    <label>Registered finite domain JSON<textarea value={domain} onChange={e=>setDomain(e.target.value)} rows={8} spellCheck={false}/></label>
    <p>Declare records, features, role, version, admitted interventions, ordinary and withheld conditions, integer units and assumptions. This is data, not executable source.</p>
    <label>Source test target<input value={sourceTargetId} onChange={e=>setSourceTargetId(e.target.value)}/></label>
    <label>Separately administered replica target<input value={replicaTargetId} onChange={e=>setReplicaTargetId(e.target.value)}/></label>
    <label>Independent replication employee<input value={replicatorId} onChange={e=>setReplicatorId(e.target.value)}/></label>
    <label>Rights expiry, ISO timestamp<input value={validUntil} onChange={e=>setValidUntil(e.target.value)}/></label>
    <button type="button" disabled={!domain||!sourceTargetId||!replicaTargetId||!replicatorId||!validUntil} onClick={()=>{try{void run('consent',{schema:'finnor.x4.experiment-rights.v1',root,domain:JSON.parse(domain),targetIds:[sourceTargetId,replicaTargetId],actorIds:[actor!.principalId,replicatorId],
     purposes:['EXPERIMENT','OBSERVE','REPLICATE','DERIVE_FINDING','USE_IN_DECISION'],retention:'RETAIN_AUDIT_REVOKE_FUTURE_USE_NO_EFFECT_ROLLBACK',validUntil})}catch{setMessage('Supply valid registered domain JSON.')}}}>Grant explicit experiment rights</button>
    <label>Experiment consent<input value={consentId} onChange={e=>setConsentId(e.target.value)}/></label>
    <label>Rights revocation reason<input value={reason} onChange={e=>setReason(e.target.value)}/></label>
    <button type="button" disabled={!consentId||!reason} onClick={()=>void run('revoke-consent',{consentId,reason})}>Revoke future use, retain evidence and effects</button>
   </details>
   <details><summary>Register question and original allocation</summary><form onSubmit={submit}>
    <label>Operational question<textarea value={question} onChange={e=>setQuestion(e.target.value)} minLength={10} maxLength={4000} required/></label>
    <label>System and target behavior<input value={target} onChange={e=>setTarget(e.target.value)} required/></label>
    <label>Affected decision<input value={affectedDecision} onChange={e=>setAffectedDecision(e.target.value)} required/></label>
    <label>Requested claim<select value={claim} onChange={e=>setClaim(e.target.value)}>{['PREDICTIVE','INTERVENTION_IDENTIFIED','MECHANISM_SPECIFIC'].map(v=><option key={v}>{v}</option>)}</select></label>
    <label>Canonical diligence workstream<input value={workstreamId} onChange={e=>setWorkstreamId(e.target.value)} required/></label>
    <label>Canonical investment case<input value={investmentCaseId} onChange={e=>setInvestmentCaseId(e.target.value)} required/></label>
    <label>Experiment mode<select value={mode} onChange={e=>setMode(e.target.value)}><option value="ACTIVE">Authorized discriminating experiments</option><option value="OBSERVATION_ONLY">Observation only, no identification claim</option></select></label>
    <label>Original deadline, milliseconds<input type="number" min={1000} max={3600000} value={deadlineMs} onChange={e=>setDeadlineMs(e.target.value)} required/></label>
    <label>Maximum physical experiments<input type="number" min={1} max={64} value={maxExperiments} onChange={e=>setMaxExperiments(e.target.value)} required/></label>
    <label>Maximum observation calls<input type="number" min={16} max={256} value={maxObservations} onChange={e=>setMaxObservations(e.target.value)} required/></label>
    <label>Maximum analysis jobs<input type="number" min={1} max={64} value={maxAnalysis} onChange={e=>setMaxAnalysis(e.target.value)} required/></label>
    <label>Maximum decision uses<input type="number" min={1} max={16} value={maxUses} onChange={e=>setMaxUses(e.target.value)} required/></label>
    <button disabled={!!visible||!domain||!consentId||!sourceTargetId||!replicaTargetId}>Identify under this original Work</button>
   </form></details>
  </fieldset>:null}
  {visible?<><h5>{visible.question.text}</h5><p>{visible.status} · generation {visible.generation} · {visible.current?'current development model':'not current'} · original deadline {visible.limits.deadlineAt}</p>
   <p>Requested {visible.question.requestedClaimClass}. {visible.model?`Achieved ${visible.model.achievedClaimClass}; requested claim ${visible.model.requestedClaimSatisfied?'supported in the finite domain':'not satisfied'}. ${visible.model.equivalence.survivingCartesianProduct} joint programmes remain.`:'No independently checked model is published.'}</p>
   <details><summary>Original allocation and all charged work</summary><pre>{pretty(visible.limits)}</pre></details>
   <details><summary>Generated executable hypotheses and exact finite closure</summary><pre>{pretty(visible.family)}</pre></details>
   <details><summary>Independent measurement controls and calibration</summary><pre>{pretty(visible.instruments)}</pre></details>
   <details><summary>Physical experiments, frozen predictions and observations</summary><pre>{pretty(visible.experiments)}</pre>{enabled?visible.experiments.map(e=><button type="button" key={e.id} disabled={busy} onClick={()=>void run('experiment',{identificationId:visible.identificationId,experimentId:e.id},false)}>Inspect {e.phase.toLowerCase()} raw protocol {e.id}</button>):null}</details>
   <details><summary>Retained refutations, equivalent models, claims and complete envelope</summary><pre>{pretty(visible.model??{unresolved:'Independent fresh prediction and distinct-principal replica are required.'})}</pre></details>
   <details><summary>Independent replication and actual canonical decisions</summary><pre>{pretty({assignments:visible.assignments,uses:visible.uses})}</pre></details>
   {enabled?<fieldset disabled={locked}><legend>Current owner actions</legend>
    <button type="button" disabled={actor?.principalId===visible.ownerId||!['AWAITING_REPLICATION','DEVELOPMENT_READY'].includes(visible.status)} onClick={()=>void run('replicate',{identificationId:visible.identificationId,expectedModelId:visible.model?.id??null})}>Independent principal, replicate on fresh instance</button>
    <button type="button" disabled={!visible.model||actor?.principalId!==visible.ownerId} onClick={()=>void run('use',{identificationId:visible.identificationId,modelId:visible.model!.id})}>Resolve model for actual guarded decision use</button>
    <details><summary>Separate S8 development admission</summary>
     <button type="button" disabled={!visible.current||!visible.model} onClick={()=>void run('s8-propose',{identificationId:visible.identificationId,modelId:visible.model!.id})}>Propose checked model to S8 owner</button>
     <label>S8 revision reference JSON<textarea value={revisionRef} onChange={e=>setRevisionRef(e.target.value)}/></label>
     <button type="button" disabled={!visible.model||!revisionRef} onClick={()=>{try{void run('admission',{identificationId:visible.identificationId,modelId:visible.model!.id,revisionRef:JSON.parse(revisionRef)},false)}catch{setMessage('Supply an exact S8 revision reference.')}}}>Check current S8 development admission</button>
     <p>Native independent evaluation and separate promotion are not granted by this panel. No protected or production authority.</p>
    </details>
    <details><summary>Cancel, invalidate or recover without renewing resources</summary>
     <label>Lifecycle reason<input value={reason} onChange={e=>setReason(e.target.value)}/></label>
     <label>Changed dependency<select value={changed} onChange={e=>setChanged(e.target.value)}>{['domain','instrument','observations','hypotheses','replication','rights','work','checker','runtime'].map(v=><option key={v}>{v}</option>)}</select></label>
     {['cancel','invalidate','retry'].map(op=><button type="button" key={op} disabled={!reason} onClick={()=>void run(op,{identificationId:visible.identificationId,reason,...(op==='invalidate'?{changed:[changed]}:{})})}>{op}, preserve original identity and charges</button>)}
    </details>
    <button type="button" onClick={()=>void readHistory()}>Read retained lifecycle and failed attempts</button>
   </fieldset>:null}
  </>:null}
  {history?.identity===identity?<details open><summary>Retained immutable history, newest page first</summary><pre>{pretty(history.events)}</pre>{history.next?<button type="button" disabled={locked} onClick={()=>void readHistory(history.next!)}>Read earlier history</button>:null}</details>:null}
  {observation?.identity===identity?<details open><summary>Latest identification owner response</summary><pre>{pretty(observation.value)}</pre></details>:null}
 </section>
}
