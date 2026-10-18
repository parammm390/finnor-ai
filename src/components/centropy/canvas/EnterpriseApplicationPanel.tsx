"use client"
import {useCallback,useEffect,useId,useRef,useState,type FormEvent} from 'react'
import {useCentropyAuth} from '@/components/centropy/lib/centropy-auth'
import {CentropyApiError} from '@/components/centropy/lib/api'
import {applicationPost,readApplication,applicationSpecificationInput,type ApplicationView,type ApplicationRecord,type ApplicationEntity,type ApplicationAction} from './application-client'

function unknownReason(value:unknown):string|null{
 return value!==null&&typeof value==='object'&&'kind' in value&&value.kind==='UNKNOWN'&&'reason' in value&&typeof value.reason==='string'?value.reason:null
}
function GeneratedActionForm({entity,action,record,disabled,onRun}:{entity:ApplicationEntity;action:ApplicationAction;record:ApplicationRecord|null;disabled:boolean;onRun:(action:ApplicationAction,record:ApplicationRecord|null,input:Record<string,unknown>,approvalRole?:string)=>Promise<void>}){
 const formId=useId()
 const [values,setValues]=useState<Record<string,string>>(()=>Object.fromEntries(action.inputFields.map(id=>{
  const value=action.kind==='create'?undefined:record?.values[id],field=entity.fields.find(f=>f.id===id)!
  return [id,value===undefined||unknownReason(value)!==null?'':field.encoding==='json'?JSON.stringify(value,null,2):String(value)]
 }))),[role,setRole]=useState(''),[error,setError]=useState('')
 const [unknowns,setUnknowns]=useState<Record<string,string>>(()=>Object.fromEntries(action.inputFields.flatMap(id=>{
  const reason=unknownReason(action.kind==='create'?undefined:record?.values[id]);return reason===null?[]:[[id,reason]]
 })))
 async function submit(event:FormEvent){
  event.preventDefault();setError('')
  try{
   const input:Record<string,unknown>={}
   for(const id of action.inputFields){
    const field=entity.fields.find(f=>f.id===id)!,value=values[id]??''
    if(Object.hasOwn(unknowns,id)){
     if(!field.allowUnknown||!unknowns[id].trim())throw new Error(`${field.title} requires an explicit UNKNOWN reason`)
     input[id]={kind:'UNKNOWN',reason:unknowns[id]};continue
    }
    if(value===''){if(field.required)throw new Error(`${field.title} requires an explicit value`);continue}
    input[id]=field.encoding==='json'?JSON.parse(value):field.encoding==='boolean'?value==='true':value
   }
   await onRun(action,action.kind==='create'?null:record,input,role||undefined)
  }catch(e){setError(e instanceof Error?e.message:'Input was not accepted')}
 }
 return <form onSubmit={submit} aria-label={action.title} data-application-action={action.id}>
  <h5>{action.title}</h5>
  <div className="ct-evidence__fields">{action.inputFields.map((id,index)=>{
   const field=entity.fields.find(f=>f.id===id)!,controlId=`${formId}-${index}`,isUnknown=Object.hasOwn(unknowns,id)
   return <fieldset key={id} disabled={disabled} style={{border:0,margin:0,padding:0,minWidth:0}}><label htmlFor={controlId}>{field.title}
    {field.encoding==='json'?<textarea id={controlId} data-application-field={id} value={values[id]??''} onChange={e=>setValues(v=>({...v,[id]:e.target.value}))} disabled={isUnknown} required={field.required&&!isUnknown} rows={5} spellCheck={false} aria-describedby={controlId+'-help'}/>:
     field.type==='enum'||field.type==='boolean'?<select id={controlId} data-application-field={id} value={values[id]??''} onChange={e=>setValues(v=>({...v,[id]:e.target.value}))} disabled={isUnknown} required={field.required&&!isUnknown}><option value="">Choose explicitly</option>{(field.options??['true','false']).map(x=><option key={x} value={x}>{x}</option>)}</select>:
      <input id={controlId} data-application-field={id} value={values[id]??''} onChange={e=>setValues(v=>({...v,[id]:e.target.value}))} disabled={isUnknown} required={field.required&&!isUnknown} maxLength={field.maxLength??8000}/>}
   </label>
   {field.allowUnknown?<label><input type="checkbox" aria-label={`Use UNKNOWN for ${field.title}`} checked={isUnknown} onChange={e=>setUnknowns(v=>{
    const next={...v};if(e.target.checked)next[id]='';else delete next[id];return next
   })}/>Use UNKNOWN</label>:null}
   {isUnknown?<label htmlFor={controlId+'-reason'}>UNKNOWN reason<textarea id={controlId+'-reason'} data-application-unknown-reason={id} value={unknowns[id]} onChange={e=>setUnknowns(v=>({...v,[id]:e.target.value}))} required maxLength={1000} rows={2}/></label>:null}
    <small id={controlId+'-help'}>{field.encoding==='json'?'Typed JSON business value. Quantities retain exact decimal strings, currency, entity, units, time and accounting basis. ':''}{field.allowUnknown?'UNKNOWN must include a reason.':'Blank is not zero or evidence.'}</small>
   </fieldset>
  })}</div>
  {action.kind==='transition'&&action.roles.length>1?<label>Approval role, if needed<select value={role} onChange={e=>setRole(e.target.value)}><option value="">Use my current eligible role</option>{action.roles.map(r=><option key={r} value={r}>{r}</option>)}</select></label>:null}
  {error?<p role="alert">{error}</p>:null}
  <button type="submit" disabled={disabled||action.kind!=='create'&&!record}>{action.title}</button>
 </form>
}
export function EnterpriseApplicationPanel({root,workId,threadId}:{root:{entityType:string;entityId:string};workId:string|null;threadId:string}){
 const {session}=useCentropyAuth(),identity=[session?.user.id??'signed-out',session?.access_token??'',threadId,root.entityType,root.entityId,workId??'none'].join(':')
 const identityRef=useRef(identity);identityRef.current=identity
 const epoch=useRef(0),request=useRef<{fingerprint:string;body:Record<string,unknown>}|null>(null),refreshing=useRef(false)
 const upload=useRef<{identity:string;digest:string;id:string}|null>(null)
 const [state,setState]=useState<{identity:string;application:ApplicationView}|null>(null),[selected,setSelected]=useState<{identity:string;id:string}|null>(null)
 const [apps,setApps]=useState<{identity:string;rows:{id:string;status:string}[]}|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('Select canonical Work to construct or open an enterprise application.')
 const [spec,setSpec]=useState(''),[migration,setMigration]=useState('[]'),[change,setChange]=useState('BUSINESS_RULES_UNITS'),[recordId,setRecordId]=useState(''),[rollbackId,setRollbackId]=useState('')
 const [history,setHistory]=useState<{identity:string;value:unknown}|null>(null),[formIdentity,setFormIdentity]=useState(identity)
 const [pageCursor,setPageCursor]=useState<string|undefined>(),[lastDecision,setLastDecision]=useState<{identity:string;applicationId:string;value:unknown}|null>(null)
 const visible=state?.identity===identity?state.application:null,currentRecord=visible?.records.find(r=>r.id===recordId)??null
 const historyIdentity=JSON.stringify([identity,visible?.applicationId??null,currentRecord?.id??null]),historyIdentityRef=useRef(historyIdentity)
 historyIdentityRef.current=historyIdentity
 const refresh=useCallback(async(sequence:number,preferred?:string,cursor?:string|null)=>{
  if(!session||!workId||refreshing.current)return
  refreshing.current=true;const expected=identity
  try{
   const list=await applicationPost<{applications:{id:string;status:string}[]}>('list',{root:{entityType:root.entityType,entityId:root.entityId},workId})
   if(sequence!==epoch.current||identityRef.current!==expected)return
   setApps(previous=>previous?.identity===expected&&JSON.stringify(previous.rows)===JSON.stringify(list.applications)?previous:{identity:expected,rows:list.applications})
   const id=preferred??(selected?.identity===expected?selected.id:null)??list.applications[0]?.id
   if(!id){setState(null);setMessage('No application is installed for this Work. Supply an explicit business contract.');return}
   const data=await readApplication(id,cursor===undefined?pageCursor:cursor??undefined)
   if(sequence!==epoch.current||identityRef.current!==expected)return
   if(data.workId!==workId||data.root.entityId!==root.entityId||data.root.entityType!==root.entityType)throw new Error('APPLICATION_SCOPE_CHANGED')
   setSelected(previous=>previous?.identity===expected&&previous.id===id?previous:{identity:expected,id})
   // Currentness can change without local counters, so compare the whole projection.
   setState(previous=>previous?.identity===expected&&JSON.stringify(previous.application)===JSON.stringify(data)?previous:{identity:expected,application:data})
   setMessage(data.headReleaseId?`Stored application: ${data.status}. Development installation, not protected admission.`:`Construction: ${data.status}. No installed success is claimed.`)
  }catch(error){
   if(sequence===epoch.current&&identityRef.current===expected){setState(null);setApps(null);setHistory(null);setMessage(error instanceof CentropyApiError&&[401,403,404].includes(error.status)?'Application unavailable in the current identity and scope.':'Current application could not be verified. Reload before taking another action.')}
  }finally{refreshing.current=false}
 },[session,workId,identity,root.entityId,root.entityType,selected,pageCursor])
 useEffect(()=>{
  const requests=epoch,sequence=++requests.current;setState(null);setApps(null);setSelected(null);setHistory(null);setLastDecision(null);setPageCursor(undefined);request.current=null;upload.current=null;setSpec('');setMigration('[]');setRecordId('');setRollbackId('');setBusy(false);setFormIdentity(identity)
  if(document.visibilityState==='visible')void refresh(sequence)
  return()=>{requests.current++}
  // Identity, not response-driven selection, owns this reset.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[identity])
 useEffect(()=>{
  if(!session||!workId)return
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh(epoch.current)},4000)
  const focus=()=>{const sequence=++epoch.current;setState(null);setHistory(null);if(document.visibilityState==='visible')void refresh(sequence)}
  document.addEventListener('visibilitychange',focus);window.addEventListener('focus',focus)
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',focus);window.removeEventListener('focus',focus)}
 },[session,workId,refresh])
 async function mutate(operation:string,body:Record<string,unknown>,after?:(data:Record<string,unknown>)=>void){
  if(!session||!workId||busy)return
  const sequence=++epoch.current,expected=identity,fingerprint=JSON.stringify({identity,operation,body})
  if(request.current?.fingerprint!==fingerprint)request.current={fingerprint,body:{...body,idempotencyKey:crypto.randomUUID()}}
  const invocation=request.current,sentUpload=upload.current
  setBusy(true);setHistory(null)
  try{
   const result=await applicationPost<Record<string,unknown>>(operation,invocation.body)
   if(request.current===invocation)request.current=null
   if((operation==='submit'||operation==='maintain')&&upload.current===sentUpload)upload.current=null
   if(sequence!==epoch.current||identityRef.current!==expected)return
   after?.(result)
   if(result.decision)setLastDecision({identity:expected,applicationId:String(result.applicationId),value:result.decision})
   await refresh(sequence,typeof result.applicationId==='string'?result.applicationId:visible?.applicationId)
   if(sequence!==epoch.current||identityRef.current!==expected)return
   const decision=result.decision as {outcome?:string}|undefined
   setMessage(decision?.outcome??String(result.status??'Accepted. Reloaded canonical state.'))
  }catch(error){
   if(error instanceof CentropyApiError&&error.status>=400&&error.status<500&&![408,429].includes(error.status)&&request.current===invocation)request.current=null
   if(sequence===epoch.current&&identityRef.current===expected){setState(null);setHistory(null);setMessage(error instanceof CentropyApiError&&error.status<500?`Request refused: ${error.message}`:'Acceptance is uncertain. Reload the original Work before retrying; the same unchanged request retains its idempotency key.')}
  }finally{if(identityRef.current===expected)setBusy(false)}
 }
 async function build(event:FormEvent,maintenance:boolean){
  event.preventDefault();if(!session||!workId||busy)return
  const expected=identity,sequence=epoch.current
  try{
   const contract=JSON.parse(spec),source=await applicationSpecificationInput(contract,root,()=>identityRef.current===expected&&epoch.current===sequence,digest=>{
    if(upload.current?.identity!==expected||upload.current.digest!==digest)upload.current={identity:expected,digest,id:crypto.randomUUID()}
    return upload.current.id
   })
   if(identityRef.current!==expected||epoch.current!==sequence)return
   if(maintenance&&visible)await mutate('maintain',{applicationId:visible.applicationId,expectedReleaseId:visible.headReleaseId,...source,changeClass:change,migration:JSON.parse(migration)})
   else await mutate('submit',{schema:'finnor.x3.application-request.v1',root,workId,...source,limits:{deadlineMs:3600000,maxBuilds:16,maxMutations:10000}})
  }catch(error){if(identityRef.current===expected)setMessage(error instanceof Error?error.message:'Business contract is not valid JSON')}
 }
 async function run(action:ApplicationAction,record:ApplicationRecord|null,input:Record<string,unknown>,approvalRole?:string){
  if(!visible)return
  await mutate('command',{applicationId:visible.applicationId,entityId:visible.frontend!.entities.find(e=>e.actions.some(a=>a.id===action.id))!.entityId,actionId:action.id,input,
   ...(record?{recordId:record.id,expectedRevision:record.revision,expectedReference:record.reference}:{}),...(approvalRole?{approvalRole}:{})},
   data=>{const r=data.record as {id?:string}|undefined;if(r?.id)setRecordId(r.id)})
 }
 async function inspectHistory(){
  if(!visible)return;const sequence=++epoch.current,expected=identity,target=historyIdentity
  const current=()=>sequence===epoch.current&&identityRef.current===expected&&historyIdentityRef.current===target
  try{const value=await applicationPost('history',{applicationId:visible.applicationId,...(currentRecord?{recordId:currentRecord.id}:{}),limit:20});if(current())setHistory({identity:target,value})}
  catch{if(current()){setHistory(null);setState(null);setMessage('History is unavailable in the current scope.')}}
 }
 const enabled=!!session&&!!workId&&formIdentity===identity
 return <section className="ct-evidence ct-enterprise-application" data-application-work={workId??'none'} data-application-id={visible?.applicationId??'none'} data-application-status={visible?.status??'none'}>
  <p role="status" aria-live="polite">{formIdentity===identity?message:'Identity changed. Rechecking the current Work and authority.'}</p>
  <p>Build and maintain a typed firm-operation application. Business data, authority, source currentness, prepared intentions, protected qualification and production are separate.</p>
  {enabled?<><button type="button" disabled={busy} onClick={()=>void refresh(++epoch.current)}>Reload current application</button>
   {apps?.identity===identity&&apps.rows.length?<label>Application<select value={visible?.applicationId??''} onChange={e=>{setState(null);setHistory(null);setLastDecision(null);setPageCursor(undefined);setRecordId('');setSpec('');setMigration('[]');setRollbackId('');setSelected({identity,id:e.target.value});void refresh(++epoch.current,e.target.value,null)}}>{apps.rows.map(a=><option key={a.id} value={a.id}>{a.id} · {a.status}</option>)}</select></label>:null}
   <details><summary>Construct from an explicit business contract</summary><form onSubmit={event=>void build(event,false)}><label>Business specification JSON<textarea value={spec} onChange={e=>setSpec(e.target.value)} required rows={12} spellCheck={false}/></label><button type="submit" disabled={busy}>Construct application</button></form><p>Critical unresolved requirements refuse construction. No arbitrary source code, SQL or generated scripts are accepted.</p></details>
  </>:null}
  {visible?<><h4>{String((visible.specification as {title?:string}|null)?.title??'Enterprise application')}</h4>
   <p>Release {visible.headReleaseId??'not installed'} · builds {visible.counters.builds}/16 · mutations {visible.counters.mutations}/10000 · retained data {visible.counters.dataBytes} bytes. Original allocation expires {visible.counters.deadlineAt}.</p>
   {visible.builds.filter(b=>b.failure).map(b=><p role="alert" key={b.id}>Build {b.generation}: {JSON.stringify(b.failure)}</p>)}
   {visible.frontend?<><label>Stored record<select value={recordId} onChange={e=>{epoch.current++;setRecordId(e.target.value);setHistory(null);setLastDecision(null)}}><option value="">Choose a record</option>{visible.records.map(r=><option key={r.id} value={r.id}>{r.entityId} · {r.id} · {r.state}</option>)}</select></label>
    {currentRecord?<article aria-label="Persisted application record"><h5>{currentRecord.state} · {currentRecord.currentness}</h5><p>Revision {currentRecord.revision}. {currentRecord.releaseCurrent?'Bound to the installed release.':'Historical decision contract retained. Explicit update/rebase is required before new decisions.'}</p>
     <pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(currentRecord.values,null,2)}</pre>
     <details><summary>Approval and prepared-intent bindings</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({reference:currentRecord.reference,releaseId:currentRecord.releaseId,originReleaseId:currentRecord.originReleaseId,approvals:currentRecord.approvals,preparedIntent:currentRecord.preparedIntent,pendingEffectId:currentRecord.pendingEffectId},null,2)}</pre></details>
    </article>:null}
    {visible.frontend.entities.map(entity=><section key={entity.entityId} aria-label={entity.title}><h4>{entity.title}</h4><p>Declared states: {entity.states.join(' → ')}</p>
     {entity.actions.filter(a=>a.kind==='create'||currentRecord?.entityId===entity.entityId).map(action=><GeneratedActionForm key={`${identity}:${visible.headReleaseId}:${action.id}:${currentRecord?.id??'new'}:${currentRecord?.revision??'new'}`}
      entity={entity} action={action} record={currentRecord} disabled={busy||visible.status==='CANCELLED'} onRun={run}/>)}
    </section>)}
    {visible.nextCursor?<button type="button" disabled={busy} onClick={()=>{const cursor=visible.nextCursor!;setPageCursor(cursor);setRecordId('');setState(null);void refresh(++epoch.current,visible.applicationId,cursor)}}>Next record page</button>:null}
    {pageCursor?<button type="button" disabled={busy} onClick={()=>{setPageCursor(undefined);setRecordId('');setState(null);void refresh(++epoch.current,visible.applicationId,null)}}>First record page</button>:null}
   </>:null}
   {lastDecision?.identity===identity&&lastDecision.applicationId===visible.applicationId?<details open><summary>Last checked decision and exact diagnostics</summary><p>Evaluated assignments explain the decision. A refusal does not commit them as business values.</p><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(lastDecision.value,null,2)}</pre></details>:null}
   <button type="button" disabled={busy} onClick={()=>void inspectHistory()}>Inspect immutable history</button>
   {visible.controls.canManage?<details><summary>Maintain, roll back or cancel</summary>
    <button type="button" onClick={()=>setSpec(JSON.stringify(visible.specification,null,2))}>Load installed contract into editor</button>
    <form onSubmit={event=>void build(event,true)}><label>Replacement business specification<textarea value={spec} onChange={e=>setSpec(e.target.value)} rows={12} required spellCheck={false}/></label>
     <label>Maintenance class<select value={change} onChange={e=>setChange(e.target.value)}><option value="BUSINESS_RULES_UNITS">Business rules and units</option><option value="IDENTITY_AUTHORIZATION_CONCURRENCY">Identity, authorization and concurrency</option><option value="DEPENDENCY_SCHEMA_DEPLOYMENT">Dependencies, schema and deployment</option></select></label>
     <label>Explicit additive migration JSON<textarea value={migration} onChange={e=>setMigration(e.target.value)} rows={4} required spellCheck={false}/></label>
     <button type="submit" disabled={busy}>Build and validate maintenance release</button>
    </form>
    <label>Rollback destination<select value={rollbackId} onChange={e=>setRollbackId(e.target.value)}><option value="">Choose an immutable release</option>{visible.releases.map(r=><option key={r.id} value={r.id}>{r.id}</option>)}</select></label>
    <button type="button" disabled={busy||!rollbackId} onClick={()=>void mutate('rollback',{applicationId:visible.applicationId,expectedReleaseId:visible.headReleaseId,releaseId:rollbackId})}>Validate actual data and roll back</button>
    <button type="button" disabled={busy} onClick={()=>void mutate('cancel',{applicationId:visible.applicationId,expectedReleaseId:visible.headReleaseId})}>Cancel future application work, retain data and obligations</button>
    <p>Unsafe rollback blocks. Maintenance never renews the original allocation. No action here dispatches a business effect or activates production.</p>
   </details>:null}
   <details><summary>Package, source, runtime and checking evidence</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(visible.package,null,2)}</pre></details>
  </>:null}
  {history?.identity===historyIdentity?<details open><summary>Canonical application history</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(history.value,null,2)}</pre></details>:null}
 </section>
}
