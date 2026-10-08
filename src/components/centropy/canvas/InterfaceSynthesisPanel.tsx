"use client"

import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {useCentropyAuth as useJarvisAuth} from '@/components/centropy/lib/centropy-auth'
import {centropyPost as jarvisPost,CentropyApiError as JarvisApiError} from '@/components/centropy/lib/api'
import {readInterfaceProjection,downloadInterfaceModule,type CurrentInterface,type InterfaceOperation} from './interface-client'
const labels:Record<CurrentInterface['status'],string>={QUEUED:'Waiting to acquire',RUNNING:'Acquiring and checking',PROTOTYPE:'Prototype, practice is unavailable',
 PRACTICED:'Practice independently verified. Admission is pending.',SUPPORTED_DISPOSABLE:'Supported for the admitted disposable domain only',
 UNKNOWN:'Outcome unknown. Original responsibility is retained.',DISCREPANCY:'Requested and observed effects disagree',FAILED:'Acquisition could not complete',
 CANCELLED:'New work cancelled. Original attempts are retained.',QUARANTINED:'Quarantined, the old interface is not current'}
export function InterfaceSynthesisPanel({root,workId,threadId}:{root:{entityType:string;entityId:string};workId:string|null;threadId:string}){
 const {session}=useJarvisAuth()
 const identity=[session?.user.id??'signed-out',session?.access_token??'',threadId,root.entityType,root.entityId,workId??'none'].join(':')
 const identityRef=useRef(identity);identityRef.current=identity
 const epoch=useRef(0),inFlight=useRef<{identity:string;sequence:number}|null>(null),container=useRef<HTMLDivElement>(null)
 const [state,setState]=useState<{identity:string;records:CurrentInterface[]}|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('Select native Work and an administrator-registered disposable test access.')
 const [formScope,setFormScope]=useState(identity)
 const [access,setAccess]=useState(''),[account,setAccount]=useState(''),[entity,setEntity]=useState(''),[field,setField]=useState(''),[value,setValue]=useState(''),
  [currency,setCurrency]=useState('USD'),[revision,setRevision]=useState(''),[explicitNull,setNull]=useState(false),[substrate,setSubstrate]=useState('API')
 const pending=useRef<{identity:string;fingerprint:string;request:Record<string,unknown>}|null>(null)
 const visible=state?.identity===identity?state.records:null,latest=visible?.[0]??null
 const clear=useCallback(()=>setState(null),[])
 const refresh=useCallback(async(sequence:number)=>{
  if(!session||!workId)return
  const expected=identity,active={identity:expected,sequence}
  if(inFlight.current?.identity===expected&&inFlight.current.sequence===sequence)return
  inFlight.current=active
  try{
   const data=await readInterfaceProjection({entityType:root.entityType,entityId:root.entityId},workId)
   if(sequence!==epoch.current||identityRef.current!==expected)return
   setState({identity:expected,records:data.acquisitions});setMessage(data.acquisitions[0]?labels[data.acquisitions[0].status]:'No interface has been acquired for this Work.')
  }catch(error){
   if(sequence===epoch.current&&identityRef.current===expected){clear();setMessage(error instanceof JarvisApiError&&[401,403,404].includes(error.status)?'Interface unavailable in the current access scope.':'Current interface could not be verified. No ready claim is shown.')}
  }finally{if(inFlight.current===active)inFlight.current=null}
 },[identity,session,workId,root.entityId,root.entityType,clear])
 useEffect(()=>{
  const counter=epoch,sequence=++counter.current;clear();setBusy(false);pending.current=null;setFormScope(identity);setAccess('');setAccount('');setEntity('');setField('');setValue('');setRevision('')
  if(document.visibilityState==='visible')void refresh(sequence)
  return()=>{counter.current++}
 },[identity,refresh,clear])
 useEffect(()=>{
  if(!workId||!session)return
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh(epoch.current)},3000)
  const focus=()=>{const sequence=++epoch.current;clear();if(document.visibilityState==='visible')void refresh(sequence)}
  document.addEventListener('visibilitychange',focus);window.addEventListener('focus',focus)
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',focus);window.removeEventListener('focus',focus)}
 },[workId,session,refresh,clear])
 async function acquire(event:FormEvent){
  event.preventDefault();if(!workId||!session)return
  const operation:InterfaceOperation={meaning:'set-record-field',account,entity,field,unit:'currency',currency,value:explicitNull?null:value,tolerance:'0',priorRevision:revision,operationId:''}
  const fingerprint=JSON.stringify({root,workId,access,substrate,operation})
  if(pending.current?.identity!==identity||pending.current.fingerprint!==fingerprint)pending.current={identity,fingerprint,
   request:{schema:'finnor.p5.acquisition-request.v1',root,workId,sourceAccessId:access,substrate,operation:{...operation,operationId:crypto.randomUUID()},idempotencyKey:crypto.randomUUID(),mode:'ordinary_disposable'}}
  const sequence=++epoch.current,expected=identity,request=pending.current.request;clear();setBusy(true)
  try{await jarvisPost('company-brain/interface-acquire',request);if(sequence===epoch.current&&identityRef.current===expected)await refresh(sequence)}
  catch(error){if(sequence===epoch.current&&identityRef.current===expected){clear();setMessage(error instanceof JarvisApiError&&error.status<500?'Acquisition was refused in the current scope or exact domain.':'Acceptance is uncertain. Reload the original Work; do not repeat a possible mutation.')}}
  finally{if(sequence===epoch.current&&identityRef.current===expected)setBusy(false)}
 }
 async function control(operation:'cancel'|'resume'|'reconcile'|'admission'){
  if(!latest)return;const sequence=++epoch.current,expected=identity;clear();setBusy(true)
  try{await jarvisPost('company-brain/interface-'+operation,{acquisitionId:latest.acquisitionId});if(sequence===epoch.current&&identityRef.current===expected)await refresh(sequence)}
  catch{if(sequence===epoch.current&&identityRef.current===expected){clear();setMessage('The transition is not confirmed. Original possible effects and costs remain recorded.')}}
  finally{if(sequence===epoch.current&&identityRef.current===expected)setBusy(false)}
 }
 async function download(kind:'ADAPTER'|'OBSERVER'){
  if(!latest)return;const sequence=epoch.current,expected=identity
  try{
   const file=await downloadInterfaceModule(latest.acquisitionId,kind),bytes=new TextEncoder().encode(file.module.bytes)
   const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('')
   if(digest!==file.module.digest||sequence!==epoch.current||identityRef.current!==expected)return
   const url=URL.createObjectURL(new Blob([bytes],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=`interface-${latest.acquisitionId}-${kind.toLowerCase()}.json`;a.click();URL.revokeObjectURL(url)
  }catch{if(sequence===epoch.current&&identityRef.current===expected){clear();setMessage('The module is not current or permitted for download.')}}
 }
 const showEvidence=latest?.capability&&!['QUARANTINED','CANCELLED','FAILED'].includes(latest.status)
 return <div ref={container} className="ct-evidence ct-interface" data-interface-work={workId??'none'} data-interface-id={latest?.acquisitionId??'none'} data-interface-status={latest?.status??'none'}>
  <p role="status" aria-live="polite">{message}</p>
  <p>Only registered disposable test systems are available here. Practice, admission and business effect authority are separate.</p>
  {workId&&session&&formScope===identity?<form onSubmit={acquire}><div className="ct-evidence__fields">
   <label>Disposable access reference<input value={access} onChange={e=>setAccess(e.target.value)} required pattern="[0-9a-fA-F-]{36}"/></label>
   <label>Application account<input value={account} onChange={e=>setAccount(e.target.value)} required maxLength={128}/></label>
   <label>Record identifier<input value={entity} onChange={e=>setEntity(e.target.value)} required maxLength={128}/></label>
   <label>Exact field<input value={field} onChange={e=>setField(e.target.value)} required maxLength={64}/></label>
   <label>Exact value<input value={value} onChange={e=>setValue(e.target.value)} required={!explicitNull} disabled={explicitNull} maxLength={96}/></label>
   <label>Explicit null<input type="checkbox" checked={explicitNull} onChange={e=>setNull(e.target.checked)}/></label>
   <label>Currency<input value={currency} onChange={e=>setCurrency(e.target.value.toUpperCase())} required pattern="[A-Z]{3}" maxLength={3}/></label>
   <label>Strong prior revision<input value={revision} onChange={e=>setRevision(e.target.value)} required maxLength={122} placeholder={'"revision"'}/></label>
   <label>Interface substrate<select value={substrate} onChange={e=>setSubstrate(e.target.value)}><option value="API">Typed API</option><option value="UI">Disposable UI, when API mechanics are unavailable</option></select></label>
  </div><button type="submit" disabled={busy}>Acquire and practice interface</button></form>:null}
  {latest?<><h4>{labels[latest.status]}</h4><p>Original request: {latest.requestedOperation.account} / {latest.requestedOperation.entity} / {latest.requestedOperation.field}
   {' = '}{latest.requestedOperation.value===null?'explicit null':latest.requestedOperation.value+' '+latest.requestedOperation.currency}. Exact tolerance is zero.</p>
   <p>Source version: {latest.sourceVersion??'Not yet acquired'} · {latest.substrate} · Work {latest.workId}</p>
   {latest.practice?.observation?<p>Independent observation: {String(latest.practice.observation.value??'explicit null')} {latest.practice.observation.currency},
    record {latest.practice.observation.entity}, revision {latest.practice.observation.revision}. {latest.practice.status==='VERIFIED'?'Exact value and operation history matched.':'This does not establish the requested effect.'}</p>:null}
   <p>{latest.admission?'S8 admission covers this disposable domain only. Protected business dispatch is unavailable.':'Admission is pending. This is not a reusable approved business operation.'}</p>
   {latest.possibleEgress?<p>A physical attempt may have left. Recovery reads the original operation only. Cancellation does not erase responsibility.</p>:null}
   <p>Learning: {latest.costs.learningAttempts} attempts. Physical writes: {latest.costs.wireAttempts} possible attempts. Recovery: {latest.costs.recoveryReads} reads. USD cost is unknown. Warm invocation cost is not measured.</p>
   {latest.reason?<p>Remaining check: {latest.reason.replaceAll('_',' ').toLowerCase()}</p>:null}
   <div className="ct-evidence__actions">
    {!['CANCELLED','QUARANTINED'].includes(latest.status)?<button type="button" disabled={busy} onClick={()=>void control('cancel')}>Cancel new interface work</button>:null}
    {latest.status==='UNKNOWN'?<button type="button" disabled={busy} onClick={()=>void control('reconcile')}>Read-only reconcile original attempt</button>:null}
    {latest.status==='FAILED'&&!latest.possibleEgress?<button type="button" disabled={busy} onClick={()=>void control('resume')}>Resume original learning frontier</button>:null}
    {showEvidence?<><button type="button" onClick={()=>{container.current?.querySelector<HTMLDetailsElement>('details')?.setAttribute('open','');container.current?.querySelector<HTMLElement>('[data-interface-proof]')?.focus()}}>Inspect interface evidence</button>
     <button type="button" onClick={()=>void download('ADAPTER')}>Download current adapter</button><button type="button" onClick={()=>void download('OBSERVER')}>Download current observer</button></>:null}
   </div>
   {showEvidence?<details><summary>Exact modules, postcondition and recovery</summary><section data-interface-proof tabIndex={-1}><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({adapter:latest.capability?.adapterModule,observer:latest.capability?.observerModule,version:latest.capability?.schemaOrUiVersion,
    postcondition:latest.capability?.postcondition,recovery:latest.capability?.retryAndUnknown,practice:latest.practice,admission:latest.admission,protectedExecution:false},null,2)}</pre></section></details>:null}
  </>:null}
 </div>
}
