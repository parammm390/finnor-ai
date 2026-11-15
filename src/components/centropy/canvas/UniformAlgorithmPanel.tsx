"use client"
import {useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {z} from 'zod'
import {useCentropyAuth} from '@/components/centropy/lib/centropy-auth'
import {usePrivateRequestScope} from '@/components/centropy/lib/use-private-request-scope'
import {centropyGet,centropyPost,CentropyApiError} from '@/components/centropy/lib/api'
const operations=['specification','record-task-episode','submit-total','consume-total','submit','read','list','consume','cancel','invalidate','assign-evaluation','evaluate','s8-propose','admission'] as const
type Operation=typeof operations[number]
const post=<T,>(operation:Operation,body:unknown)=>centropyPost<T>('uniform-algorithms/'+operation,body)
const viewSchema=z.object({discoveryId:z.string().uuid(),workId:z.string().uuid(),root:z.object({entityType:z.string(),entityId:z.string().uuid()}),
 status:z.string(),current:z.boolean(),currentnessReason:z.string().nullable(),sourceVisibility:z.enum(['AUTHORIZED','WITHHELD']),historyPayloadsWithheld:z.boolean(),
 capsule:z.object({digest:z.string()}).passthrough().nullable(),capsuleAvailable:z.boolean().optional(),envelope:z.unknown(),
 history:z.array(z.object({id:z.string(),kind:z.string(),created_at:z.string(),body:z.unknown().optional()}).passthrough()),
 protectedAdmission:z.literal(false),productionActive:z.literal(false),
 counters:z.object({attempts:z.number(),maxAttempts:z.number(),uses:z.number(),maxUses:z.number(),deadlineAt:z.string()})}).passthrough()
type View=z.infer<typeof viewSchema>
const referenceSchema=z.object({owner:z.string(),id:z.string(),version:z.string(),contentDigest:z.string()}).passthrough()
const specificationSchema=z.discriminatedUnion('status',[
 z.object({status:z.literal('UNAVAILABLE'),reason:z.string()}),
 z.object({status:z.enum(['PUBLIC_DEVELOPMENT','ACCEPTED']),specification:z.object({
  schema:z.literal('finnor.y5.resolved-specification.v2'),sourceRef:referenceSchema,definitionDigest:z.string(),
  definition:z.object({schema:z.literal('finnor.y5.total-family-definition.v2'),input:z.literal('ALL_FINITE_INTEGER_LISTS'),
   output:z.literal('MATHEMATICAL_INTEGER'),objective:z.literal('LEAST_FEASIBLE_INITIAL_STATE'),
   prefixes:z.literal('INCLUDING_EMPTY_AND_COMPLETE'),numericalMeaning:z.literal('EXACT_UNBOUNDED_INTEGER')}).passthrough(),
  acceptance:z.object({status:z.enum(['PUBLIC_DEVELOPMENT','ACCEPTED']),protectedFamilyCredit:z.literal(false)}).passthrough(),
 })}),
]).refine(value=>value.status==='UNAVAILABLE'||value.status===value.specification.acceptance.status)
type Specification=z.infer<typeof specificationSchema>
const typedLimits={wallMs:180000,maxAttempts:2,maxUses:8,maxPrograms:20000,maxPropositions:10000,maxProofAttempts:12,maxRetainedBytes:8388608}
const evidenceBasis=(view:View)=>JSON.stringify([view.discoveryId,view.current,view.status,view.currentnessReason,view.sourceVisibility,view.counters.attempts])
const taskIdSchema=z.string().uuid()
const typedUseSchema=z.object({status:z.literal('CHECKED'),actualMethod:z.literal('Y5_SAME_LEAN_TOTAL_DEFINITION'),
 result:z.object({value:z.string().regex(/^(?:0|-?[1-9][0-9]*)$/),operations:z.number().int().nonnegative()}).passthrough()}).passthrough()
const exactInteger=z.string().regex(/^(?:0|-?[1-9][0-9]*)$/)
const taskEpisodeSchema=z.object({schema:z.literal('finnor.s5.total-task-model-result.v2'),
 requestRef:referenceSchema,resultRef:referenceSchema,
 result:z.discriminatedUnion('status',[
  z.object({status:z.literal('MODEL_ACCEPTED'),value:exactInteger,reason:z.null(),reference:z.unknown()}).passthrough(),
  z.object({status:z.enum(['REFUSED','UNKNOWN']),value:z.null(),reason:z.string(),reference:z.unknown()}).passthrough(),
 ]),cost:z.unknown(),businessCompletionAccepted:z.literal(false),protectedReceipt:z.null(),
 protectedFamilyCredit:z.literal(false),reservationCreated:z.literal(false),s6EffectsCreated:z.array(z.unknown()).length(0),
 executionAuthorityGranted:z.literal(false),
 qualification:z.literal('S5_MODEL_ONLY_PUBLIC_OR_AUTHENTICATED_TASK_NOT_INDEPENDENT_BUSINESS_QUALIFICATION')}).passthrough()
const s8RevisionSchema=z.object({owner:z.literal('S8'),id:z.string(),version:z.string(),contentDigest:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
const admissionSchema=z.object({current:z.boolean(),currentUntil:z.string().nullable(),admission:referenceSchema.nullable(),
 revisionRef:s8RevisionSchema,protectionDomain:z.literal('DISPOSABLE_TEST_AUTHORITY'),
 protectedAdmission:z.literal(false),productionActive:z.literal(false),executionAuthorityGranted:z.literal(false)}).passthrough()
const printable=(value:unknown)=>JSON.stringify(value,(key,value)=>key==='proofObject'&&typeof value==='string'?`Serialized proof retained by owner (${value.length} base64 characters)`:value,2)
function EvidenceDisclosure({title,value,initiallyOpen=false}:{title:string;value:unknown;initiallyOpen?:boolean}){
 const [open,setOpen]=useState(initiallyOpen),formatted=useMemo(()=>open?printable(value):'',[open,value])
 return <details open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary>{title}</summary>
  {open?<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{formatted}</pre>:null}</details>
}
export function UniformAlgorithmPanel({root,workId,threadId}:{root:{entityType:string;entityId:string};workId:string|null;threadId:string}){
 const {session}=useCentropyAuth(),logical=JSON.stringify([session?.user.id??null,root.entityType,root.entityId,workId,threadId])
 const rootType=root.entityType,rootId=root.entityId,signedIn=!!session
 const {key:identity,allowed,isCurrent}=usePrivateRequestScope(logical),activeRefresh=useRef<{identity:string}|null>(null)
 const epoch=useRef(0),selected=useRef(''),busyRef=useRef(false),priorLogical=useRef(logical),scope=useRef<string|null>(null)
 const pending=useRef<{scope:string;operation:Operation;fingerprint:string;body:Record<string,unknown>}|null>(null)
 const [display,setDisplay]=useState<{identity:string;view:View;stamp:string}|null>(null),[rows,setRows]=useState<{identity:string;items:{id:string;status:string}[]}|null>(null)
 const [actor,setActor]=useState<{identity:string;scope:string}|null>(null),[formIdentity,setFormIdentity]=useState(identity),[busy,setBusy]=useState(false)
 const [message,setMessage]=useState('Select current Work to inspect uniform algorithm discovery.'),[observation,setObservation]=useState<{identity:string;operation:Operation;value:unknown;taskWorkId?:string}|null>(null)
 const [allocation,setAllocation]=useState(''),[baseline,setBaseline]=useState('null'),[evaluator,setEvaluator]=useState(''),[evaluation,setEvaluation]=useState('')
 const [reason,setReason]=useState(''),[dependency,setDependency]=useState('implementation'),[revision,setRevision]=useState('')
 const [specification,setSpecification]=useState<{identity:string;value:Specification}|null>(null),[taskWorkId,setTaskWorkId]=useState('')
 const [evidence,setEvidence]=useState<{identity:string;view:View;basis:string}|null>(null)
 const specificationPin=useRef<string|null>(null)
 const visible=allowed&&display?.identity===identity?display.view:null,enabled=allowed&&!!session&&!!workId&&formIdentity===identity&&actor?.identity===identity
 const resolved=allowed&&specification?.identity===identity?specification.value:null
 const typed=resolved&&resolved.status!=='UNAVAILABLE'?resolved.specification:null
 const typedDiscovery=visible?.capsuleAvailable!==undefined
 const loadedEvidence=visible&&evidence?.identity===identity&&evidence.basis===evidenceBasis(visible)?evidence.view:null
 const evidenceView=typedDiscovery?loadedEvidence:visible
 const typedUse=allowed&&observation?.identity===identity?typedUseSchema.safeParse(observation.value):null
 const taskEpisode=allowed&&observation?.identity===identity&&observation.operation==='record-task-episode'?taskEpisodeSchema.safeParse(observation.value):null
 const typedAdmission=typedDiscovery&&allowed&&observation?.identity===identity&&observation.operation==='admission'?admissionSchema.safeParse(observation.value):null
 const resetForms=useCallback(()=>{setAllocation('');setBaseline('null');setEvaluator('');setEvaluation('');setReason('');setRevision('');setDependency('implementation');setTaskWorkId('')},[])
 const refresh=useCallback(async(sequence:number,preferred?:string)=>{
  if(!allowed||!signedIn||!workId)return
  const scopeRoot={entityType:rootType,entityId:rootId}
  const expected=identity,ticket={identity:expected},current=()=>isCurrent(expected)&&epoch.current===sequence
  activeRefresh.current=ticket
  try{
   const me=await centropyGet<{tenantId:string;userId:string;employeeId:string|null}>('me')
   if(!current())return
   const canonical=JSON.stringify([logical,me.tenantId,me.userId,me.employeeId])
   if(!me.tenantId||!me.userId)throw Error('Y5_AUTHENTICATED_SCOPE_UNAVAILABLE')
   if(scope.current!==null&&scope.current!==canonical){pending.current=null;selected.current='';setDisplay(null);setObservation(null);setEvidence(null);setSpecification(null);specificationPin.current=null;resetForms()}
   scope.current=canonical;setActor(prior=>prior?.identity===expected&&prior.scope===canonical?prior:{identity:expected,scope:canonical})
   const [list,spec]=await Promise.all([
    post<{discoveries:{id:string;status:string}[]}>('list',{root:scopeRoot,workId}),
    post<unknown>('specification',{root:scopeRoot,workId}).then(value=>specificationSchema.parse(value)),
   ])
   if(!current())return
   const pin=JSON.stringify(spec)
   if(specificationPin.current!==null&&specificationPin.current!==pin){setObservation(null);setEvidence(null);resetForms()}
   specificationPin.current=pin
   setSpecification(prior=>prior?.identity===expected&&JSON.stringify(prior.value)===pin?prior:{identity:expected,value:spec})
   setRows(prior=>prior?.identity===expected&&prior.items.length===list.discoveries.length&&prior.items.every((item,i)=>item.id===list.discoveries[i]?.id&&item.status===list.discoveries[i]?.status)?prior:{identity:expected,items:list.discoveries})
   const id=preferred||selected.current||list.discoveries[0]?.id
   if(!id){setDisplay(null);setEvidence(null);setMessage('No uniform algorithm discovery is registered for this Work.');return}
   const view=viewSchema.parse(await post('read',{discoveryId:id}))
   if(!current())return
   if(view.workId!==workId||view.root.entityId!==rootId||view.root.entityType!==rootType)throw Error('Y5_WORK_SCOPE_CHANGED')
   if(view.sourceVisibility==='WITHHELD'){setObservation(null);setEvidence(null);setSpecification(null);resetForms()}
   if(!view.current){setEvidence(null);setObservation(prior=>prior?.operation==='admission'?null:prior)}
   const stamp=JSON.stringify([view.discoveryId,view.workId,view.root,view.status,view.current,view.currentnessReason,
    view.sourceVisibility,view.historyPayloadsWithheld,view.capsule?.digest,view.capsuleAvailable,view.counters,view.envelope,view.history.map(event=>event.id)])
   selected.current=id;setDisplay(prior=>prior?.identity===expected&&prior.stamp===stamp?prior:{identity:expected,view,stamp})
   setMessage(view.current?`${view.status}. Mathematical checking, discovery qualification and admission remain separate.`:`${view.status}. ${view.currentnessReason??'Not current.'}`)
  }catch{if(current()){setDisplay(null);setRows(null);setActor(null);setObservation(null);setEvidence(null);setSpecification(null);resetForms();setMessage('Current Work, source and rights could not be verified. No private capsule is displayed.')}}
  finally{if(activeRefresh.current===ticket)activeRefresh.current=null}
 },[allowed,signedIn,workId,identity,logical,rootType,rootId,isCurrent,resetForms])
 useEffect(()=>{
  if(priorLogical.current!==logical){pending.current=null;scope.current=null;priorLogical.current=logical}
  const fence=epoch,sequence=++fence.current;selected.current='';busyRef.current=false
  setDisplay(null);setRows(null);setActor(null);setObservation(null);setEvidence(null);setSpecification(null);specificationPin.current=null;setBusy(false);resetForms();setFormIdentity(identity)
  void refresh(sequence);return()=>{fence.current++}
 },[identity,logical,refresh,resetForms])
 useEffect(()=>{
  if(!allowed||!signedIn||!workId)return
  const poll=()=>{if(!busyRef.current&&activeRefresh.current?.identity!==identity&&document.visibilityState==='visible')void refresh(++epoch.current)}
  const focus=()=>{if(!busyRef.current){setDisplay(null);setObservation(null);setEvidence(null);void refresh(++epoch.current)}}
  const timer=setInterval(poll,4000);window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus)
  return()=>{clearInterval(timer);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus)}
 },[allowed,signedIn,workId,identity,refresh])
 async function run(operation:Operation,body:Record<string,unknown>,mutation=true,resume=false){
  if(!enabled||busyRef.current)return
  const retained=pending.current
  if(resume&&(!retained||retained.scope!==actor!.scope))return
  const fingerprint=resume?retained!.fingerprint:JSON.stringify([actor!.scope,operation,body])
  if(mutation&&!resume&&retained&&retained.fingerprint!==fingerprint){setMessage('Resolve the uncertain original request before starting another mutation.');return}
  const expected=identity,sequence=++epoch.current,current=()=>isCurrent(expected)&&epoch.current===sequence,oldId=selected.current
  const keyed=['record-task-episode','submit-total','consume-total','submit','consume','invalidate','assign-evaluation','s8-propose'].includes(operation)
  if(mutation&&!resume&&pending.current?.fingerprint!==fingerprint)pending.current={scope:actor!.scope,operation,fingerprint,body:{...body,...(keyed?{idempotencyKey:crypto.randomUUID()}:{})}}
  busyRef.current=true;setBusy(true);setObservation(null);setEvidence(null)
  if(['cancel','invalidate'].includes(operation))setDisplay(null)
  try{
   const result=await post<Record<string,unknown>>(operation,mutation?pending.current!.body:body)
   if(!current())return
   if(mutation)pending.current=null
   setObservation({identity:expected,operation,value:result,...(['consume-total','record-task-episode'].includes(operation)&&typeof body.taskWorkId==='string'?{taskWorkId:body.taskWorkId}:{})})
   if(operation==='assign-evaluation'&&taskIdSchema.safeParse(result.evaluationId).success)setEvaluation(result.evaluationId as string)
   if(operation==='s8-propose'){
    const ref=s8RevisionSchema.safeParse(result.revisionRef)
    if(ref.success)setRevision(JSON.stringify(ref.data,null,2))
   }
   await refresh(sequence,typeof result.discoveryId==='string'?result.discoveryId:oldId)
  }catch(error){if(current()){
   if(mutation&&error instanceof CentropyApiError&&!error.retryable&&error.status!==401)pending.current=null
   const ownerError=error instanceof CentropyApiError?z.object({code:z.string().max(256)}).safeParse(error.details):null
   if(error instanceof CentropyApiError)setObservation({identity:expected,operation,value:{
    httpStatus:error.status,...(ownerError?.success?{code:ownerError.data.code}:{}),message:error.message,
   }})
   setDisplay(null);setSpecification(null);resetForms();setMessage(error instanceof Error?error.message+(ownerError?.success?` (${ownerError.data.code})`:''):'Owner response unavailable. Original invocation identity is retained.')
  }}finally{if(current()){busyRef.current=false;setBusy(false)}}
 }
 function submit(){
  try{void run('submit',{root,workId,allocation:JSON.parse(allocation),baselineManifestRef:JSON.parse(baseline),limits:{wallMs:3600000,maxAttempts:2,maxUses:8}})}
  catch{setMessage('Supply the full original S5 allocation input and a baseline reference or null. No constraints may be omitted.')}
 }
 function typedTask(){
  const id=taskIdSchema.parse(taskWorkId.trim())
  if(id===workId)throw Error('Use a separate recorded task Work, not the specification Work.')
  return id
 }
 function submitTyped(){
  try{void run('submit-total',{schema:'finnor.y5.total-discovery-request.v2',root,workId,taskWorkId:typedTask(),limits:typedLimits,baselineManifestRef:null})}
  catch(error){setMessage(error instanceof Error&&error.message.startsWith('Use a separate')?error.message:'Supply the UUID of a separate current recorded typed task Work.')}
 }
 function recordTaskEpisode(){
  try{void run('record-task-episode',{root,workId,taskWorkId:typedTask()})}
  catch{setMessage('Supply the UUID of a separate current recorded typed task Work. No inline task values or answers are accepted.')}
 }
 async function loadEvidence(){
  if(!enabled||!visible||!typedDiscovery||busyRef.current)return
  const expected=identity,id=visible.discoveryId,sequence=++epoch.current,current=()=>isCurrent(expected)&&epoch.current===sequence&&selected.current===id
  busyRef.current=true;setBusy(true);setEvidence(null)
  try{
   const view=viewSchema.parse(await post('read',{discoveryId:id,includeCapsule:true,includeHistory:true}))
   if(!current())return
   if(view.workId!==workId||view.root.entityType!==root.entityType||view.root.entityId!==root.entityId)throw Error('Y5_WORK_SCOPE_CHANGED')
   setDisplay({identity:expected,view:{...view,capsule:null,history:[]},stamp:''})
   if(!view.current||view.sourceVisibility!=='AUTHORIZED'){setObservation(null);setSpecification(null);resetForms();setMessage('Current proof evidence is withheld.');return}
   setEvidence({identity:expected,view,basis:evidenceBasis(view)})
   setMessage('Proof evidence explicitly loaded from the current owner. This is not protected admission.')
  }catch(error){if(current()){setDisplay(null);setObservation(null);setSpecification(null);resetForms();setMessage(error instanceof Error?error.message:'Proof evidence unavailable.')}}
  finally{if(current()){busyRef.current=false;setBusy(false)}}
 }
 return <section className="ct-evidence ct-uniform-algorithm" aria-label="Uniform algorithm discovery" data-y5-work={workId??'none'} data-y5-id={visible?.discoveryId??'none'}>
  <h4>Uniform algorithm discovery</h4><p role="status" aria-live="polite">{formIdentity===identity?message:'Identity changed. Rechecking current Work and rights.'}</p>
  <p>Public development only. Exact unbounded-list theorem, bounded native execution. CHECKED is not protected discovery, business approval or production admission. No effect authority.</p>
  {allowed&&session&&workId?<button disabled={busy} onClick={()=>{setDisplay(null);setEvidence(null);setObservation(null);setSpecification(null);void refresh(++epoch.current)}}>Reload uniform algorithm</button>:null}
  {resolved?<section aria-label="Typed task specification">
   <h5>Current Work task meaning</h5>
   {resolved.status==='UNAVAILABLE'?<p>No usable typed specification. {resolved.reason}. The original allocation path remains separate.</p>:<>
    <p>Semantic acceptance: {resolved.status}. No protected-family credit or execution authority.</p>
    <p>Task: least feasible initial integer state for every finite integer list, checking all prefixes including the empty and complete prefix. The actual safety and transition definitions below determine its meaning.</p>
    <p>Exact integer arithmetic. This is not an S5 allocation optimum or an economic claim. Recorded task values are not verified field measurements.</p>
    <EvidenceDisclosure key={identity+':specification'} title="Recorded definition, immutable source and semantic acceptance" value={resolved.specification} initiallyOpen/>
   </>}
  </section>:null}
  {enabled?<>
   {pending.current?.scope===actor?.scope?<div><p>An uncertain original request is retained. A retry does not renew its resources.</p>
    <button disabled={busy} onClick={()=>{const p=pending.current;if(p)void run(p.operation,p.body,true,true)}}>Retry original request</button>
    <button disabled={busy} onClick={()=>{pending.current=null;setMessage('Local retries stopped. Server work and history remain.')}}>Stop local retries, retain history</button></div>:null}
   {rows?.identity===identity&&rows.items.length?<label>Discovery<select value={visible?.discoveryId??selected.current} disabled={busy||!!pending.current} onChange={e=>{selected.current=e.target.value;setDisplay(null);setEvidence(null);setObservation(null);setEvaluator('');setEvaluation('');setRevision('');void refresh(++epoch.current,e.target.value)}}>{rows.items.map(item=><option key={item.id} value={item.id}>{item.id} · {item.status}</option>)}</select></label>:null}
   {typed?<section aria-label="Recorded typed task and discovery">
    <label>Recorded task Work ID<input value={taskWorkId} onChange={e=>setTaskWorkId(e.target.value)} spellCheck={false} autoComplete="off"/></label>
    <p>Name a separate current authenticated Work containing finnor.s5.total-task-instance.v2 with this specificationRef and exact values. No values or algorithm are supplied by this form.</p>
    <button disabled={busy||!!pending.current||!taskWorkId.trim()||!!visible&&!visible.current} onClick={recordTaskEpisode}>Check recorded task with S5 model-only baseline</button>
    <p>The S5 reference is bounded to 4,096 candidates, 2,000,000 expression steps and 1,000 ms of reference evaluation. Unsupported safety expressions refuse; exhausted bounds return UNKNOWN. The owner receipt records all actual bounds and evidence.</p>
    <p>Discovery requires at least two distinct prior MODEL_ACCEPTED task Works with this exact specification source, definition and acceptance policy. Allocation certificates do not satisfy this gate. Record only intended training tasks before discovery; keep future held-out tasks unrecorded until discovery completes.</p>
    <EvidenceDisclosure title="Finite typed discovery limits" value={typedLimits} initiallyOpen/>
    <button disabled={busy||!!pending.current||!!visible||!taskWorkId.trim()} onClick={submitTyped}>Queue typed discovery under original Work</button>
    {typedDiscovery&&visible?.current&&visible.status==='CHECKED'?<button disabled={busy||!!pending.current||!taskWorkId.trim()||visible.counters.uses>=visible.counters.maxUses} onClick={()=>{
     try{void run('consume-total',{discoveryId:visible.discoveryId,taskWorkId:typedTask()})}
     catch{setMessage('Supply a separate current recorded task Work UUID.')}
    }}>Use proved typed algorithm on recorded task Work</button>:null}
   </section>:null}
   {!typed&&!typedDiscovery&&resolved?.status==='UNAVAILABLE'?<><details><summary>Original S5 input and discovery</summary><label>Complete current allocation input JSON<textarea value={allocation} onChange={e=>setAllocation(e.target.value)} rows={6} spellCheck={false}/></label>
    <p>Use original mandate, policy/resource references, complete joint model, demand bindings and funding. This does not clear or reserve resources.</p>
    <label>Baseline manifest reference JSON, or null<textarea value={baseline} onChange={e=>setBaseline(e.target.value)} spellCheck={false}/></label>
    <button disabled={busy||!!visible||!allocation} onClick={submit}>Queue discovery under original Work</button>
    {visible?.current&&visible.status==='CHECKED'?<button disabled={busy||!allocation} onClick={()=>{try{void run('consume',{discoveryId:visible.discoveryId,allocation:JSON.parse(allocation),fallback:'NONE'})}catch{setMessage('Supply the full current original S5 input.')}}}>Use proved algorithm with fresh original-space checks</button>:null}
   </details></>:null}
   <details><summary>{typedDiscovery?'Independent typed task development evaluation':'Independent development evaluation'}</summary>
    <p>Register a different real evaluator before replay. The assigned evaluator runs the evaluation ID while signed in as themselves, from their own accessible Work. This panel does not impersonate or sign for them.</p>
    {typedDiscovery?<p>The v2 owner checks the exact kernel expected type and original typed task, including every prefix. Evaluation uses the original finite use allowance and at most a 28.5-second invocation. CHECKED_DEVELOPMENT is not independent semantic acceptance, protected custody or admission.</p>:null}
    <label>Assigned evaluation ID<input value={evaluation} onChange={e=>setEvaluation(e.target.value)}/></label><button disabled={busy||!evaluation} onClick={()=>void run('evaluate',{evaluationId:evaluation})}>Run as assigned independent evaluator</button>
    {visible?.current&&visible.status==='CHECKED'?<><label>Different current evaluator ID<input value={evaluator} onChange={e=>setEvaluator(e.target.value)}/></label><button disabled={busy||!!pending.current||!taskIdSchema.safeParse(evaluator.trim()).success||evaluator.trim()===session?.user.id} onClick={()=>void run('assign-evaluation',{discoveryId:visible.discoveryId,evaluatorId:evaluator.trim()})}>Register assignment before replay</button></>:null}
   </details>
  </>:null}
  {visible?<><p>{visible.status} · {visible.current?'current':'not current'}. Attempts {visible.counters.attempts}/{visible.counters.maxAttempts}; uses {visible.counters.uses}/{visible.counters.maxUses}. Original deadline {visible.counters.deadlineAt}.</p>
   {typedDiscovery?<><p>Lightweight status polling does not fetch the proof capsule or history payloads.</p><button disabled={busy||!enabled||!visible.current||!visible.capsuleAvailable} onClick={()=>void loadEvidence()}>Load proof evidence</button></>:null}
   <EvidenceDisclosure key={identity+':'+visible.discoveryId+':capsule'} title="Theorem, implementation, imports, axioms and reuse" value={evidenceView?.capsule??{withheld:typedDiscovery?'Not loaded. Request current proof evidence explicitly.':'No current checked capsule.'}}/>
   <EvidenceDisclosure key={identity+':envelope'} title="Original semantics, scope, costs, responsibilities and gates" value={visible.envelope}/>
   {enabled?<><details><summary>{typedDiscovery?'Separate typed S8 admission':'Separate S8 admission'}</summary>
    <button disabled={busy||!!pending.current||!visible.current||visible.status!=='CHECKED'} onClick={()=>void run('s8-propose',{discoveryId:visible.discoveryId})}>Propose to independently configured S8 owner</button>
    <label>S8 revision reference JSON<textarea value={revision} onChange={e=>setRevision(e.target.value)}/></label>
    <button disabled={busy||!revision||!visible.current||visible.status!=='CHECKED'} onClick={()=>{try{const ref=JSON.parse(revision);void run('admission',{discoveryId:visible.discoveryId,revisionRef:typedDiscovery?s8RevisionSchema.parse(ref):ref},false)}catch{setMessage('Supply the exact owner-returned S8 revision reference.')}}}>Check fresh S8 admission</button>
    <p>This proposes to and reads the separately configured S8 owner. It does not sign a protocol, evaluation or promotion. Missing configuration and actual refusals remain refusals; PUBLIC_DEVELOPMENT does not become independent semantic acceptance.</p>
    {typedDiscovery?<p>For S8, register the assignment and propose its typed revision first. The independent S8 owner must register its protocol before native evaluation starts. The assigned evaluator then runs their evaluation ID; signed evaluation and promotion remain at S8. Finally check that exact revision here.</p>:null}
    {typedDiscovery?<p>The server dispatches this capsule to the typed v2 S8 profile, not the allocation v1 profile. Even a current disposable S8 admission grants no protected admission, production activation or effect authority.</p>:null}
   </details><details><summary>Cancel or P7 invalidate, retaining history and costs</summary>
    <button disabled={busy} onClick={()=>void run('cancel',{discoveryId:visible.discoveryId})}>Cancel original discovery</button>
    <label>Changed dependency<select value={dependency} onChange={e=>setDependency(e.target.value)}>{['specification','implementation','runtime','rights','instance','admission'].map(v=><option key={v}>{v}</option>)}</select></label>
    <label>Reason<input value={reason} onChange={e=>setReason(e.target.value)}/></label>
    <button disabled={busy||!reason} onClick={()=>void run('invalidate',{discoveryId:visible.discoveryId,dependency,reason})}>Invalidate affected uses, retain unaffected theorem history</button>
   </details></>:null}
   <EvidenceDisclosure key={identity+':'+visible.discoveryId+':history'} title="Immutable history and failed attempts" value={evidenceView?.history??{withheld:'Request history with current proof evidence.'}}/>
  </>:null}
  {typedUse?.success?<section aria-label="Exact typed task result">
   <h5>Checked recorded task result</h5><p>Recorded task Work {observation?.taskWorkId??'reference retained in owner response'}.</p>
   <p>Exact least feasible initial integer: <output>{typedUse.data.result.value}</output>.</p>
   <p>Counted AST and fold operations: <output>{typedUse.data.result.operations}</output>. Unit integer arithmetic only, not a bit-complexity or wall-time bound.</p>
   <p>No S5 allocation optimum, economic gain, reservation, admission or effect authority is claimed.</p>
  </section>:null}
  {taskEpisode?.success?<section aria-label="S5 model-only task baseline result">
   <h5>Recorded S5 model-only baseline</h5><p>Task Work {observation?.taskWorkId}. Actual owner status: {taskEpisode.data.result.status}.</p>
   {taskEpisode.data.result.status==='MODEL_ACCEPTED'?<p>Exact bounded-reference initial integer: <output>{taskEpisode.data.result.value}</output>.</p>:<p>No accepted answer. {taskEpisode.data.result.reason}.</p>}
   <p>Model acceptance only. Not business completion, independent semantic acceptance, protected credit, an all-size theorem, S5 allocation optimality, a reservation or S6 authority. This receipt alone does not establish the two-case discovery gate.</p>
   <EvidenceDisclosure key={identity+':task-episode'} title="S5 immutable references, bounded prefix evidence and costs" value={{requestRef:taskEpisode.data.requestRef,resultRef:taskEpisode.data.resultRef,reference:taskEpisode.data.result.reference,cost:taskEpisode.data.cost}} initiallyOpen/>
  </section>:null}
  {typedAdmission?.success?<section aria-label="Observed typed S8 admission">
   <h5>Last explicit typed S8 check</h5>
   <p>{typedAdmission.data.current?`Disposable S8 admission reported current until ${typedAdmission.data.currentUntil}.`:'The owner reported no current S8 admission.'} This is a request-time observation, not a continuing authorization.</p>
   <p>Protection domain {typedAdmission.data.protectionDomain}. Protected admission false. Production active false. Execution authority false.</p>
  </section>:null}
  {allowed&&observation?.identity===identity?<EvidenceDisclosure key={identity+':response'} title="Latest owner response" value={observation.value} initiallyOpen/>:null}
 </section>
}
