"use client"

import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react'
import {centropyPost,CentropyApiError} from '@/components/centropy/lib/api'
import {useCentropyAuth} from '@/components/centropy/lib/centropy-auth'

type Root={entityType:string;entityId:string}
type Reading={state:'PROPOSED'|'INVALIDATED';capsule:{id:string;admission:null;module:unknown;template:unknown;
 support:{episodes:string[];companies:string[];adverseRecords:unknown[]};unavailableBindings:string[]};history:unknown[]}
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function ProcedureInductionPanel({root,workId,threadId,onSelect}:{root:Root;workId:string|null;threadId:string;onSelect:(id:string|null)=>void}){
 const {session}=useCentropyAuth()
 const identity=[session?.user.id??'none',session?.access_token??'',threadId,root.entityType,root.entityId,workId??'none'].join(':')
 const current=useRef(identity);current.current=identity
 const epoch=useRef(0),container=useRef<HTMLDivElement>(null),active=useRef(false)
 const [reading,setReading]=useState<{identity:string;value:Reading}|null>(null)
 const [proof,setProof]=useState<{identity:string;value:unknown}|null>(null)
 const [programmes,setProgrammes]=useState(''),[lookup,setLookup]=useState(''),[correction,setCorrection]=useState('')
 const [cut,setCut]=useState(''),[busy,setBusy]=useState(false),[message,setMessage]=useState('Select native Work to inspect or induce an ordinary procedure.')
 const induction=useRef<{identity:string;id:string}|null>(null)
 const inspected=useRef<{identity:string;id:string}|null>(null)
 const pending=useRef<{fingerprint:string;request:Record<string,unknown>}|null>(null)
 const notice=useRef<{fingerprint:string;key:string}|null>(null)
 const visible=reading?.identity===identity?reading.value:null
 const clear=useCallback(()=>{setReading(null);setProof(null);onSelect(null)},[onSelect])
 const refresh=useCallback(async(sequence:number,id?:string)=>{
  if(!session||!workId||active.current)return
  const expected=identity;active.current=true
  try{
   let selected=id??(inspected.current?.identity===expected?inspected.current.id:undefined)
   if(induction.current?.identity===expected){
    const status=await centropyPost<{state:string;capsuleIds:string[]}>('company-brain/procedure-induction-read',{inductionId:induction.current.id})
    if(sequence!==epoch.current||current.current!==expected)return
    if(['QUEUED','RUNNING'].includes(status.state)){setMessage('Native induction is '+status.state.toLowerCase()+'. Original deadline and attempts are retained.');return}
    selected=status.capsuleIds[0];induction.current=null;setBusy(false)
    if(!selected){clear();setMessage('No supported abstraction was published. Failed records remain retained.');return}
   }
   const value=selected?await centropyPost<Reading>('company-brain/procedure-read',{capsuleId:selected}):
    (await centropyPost<{capsules:Reading[]}>('company-brain/procedure-projection',{root,workId})).capsules[0]
   if(sequence!==epoch.current||current.current!==expected)return
   inspected.current=value?{identity:expected,id:value.capsule.id}:null
   setReading(value?{identity:expected,value}:null)
   if(value?.state==='INVALIDATED'){setProof(null);onSelect(null)}
   setMessage(value?value.state==='INVALIDATED'?'Invalidated. Historical module bytes and failures are retained.':'Executable proposal available for disposable evaluation only.':'No procedure has been induced for this Work.')
  }catch(error){if(sequence===epoch.current&&current.current===expected){clear();setBusy(false);setMessage(error instanceof CentropyApiError&&[401,403,404].includes(error.status)?'Procedure unavailable in the current access scope.':'The current procedure could not be verified. No ready claim is shown.')}}
  finally{active.current=false}
 },[identity,session,workId,root.entityType,root.entityId,onSelect,clear])
 useEffect(()=>{
  const sequence=++epoch.current;clear();setBusy(false);induction.current=null;inspected.current=null;pending.current=null;notice.current=null
  setProgrammes('');setLookup('');setCorrection('');setCut(new Date().toISOString())
  if(document.visibilityState==='visible')void refresh(sequence)
  return()=>{epoch.current++}
 },[identity,refresh,clear])
 useEffect(()=>{
  if(!session||!workId)return
  const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh(epoch.current)},3000)
  const focus=()=>{const sequence=++epoch.current;clear();if(document.visibilityState==='visible')void refresh(sequence)}
  document.addEventListener('visibilitychange',focus);window.addEventListener('focus',focus)
  return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',focus);window.removeEventListener('focus',focus)}
 },[session,workId,refresh,clear])
 async function induce(event:FormEvent){
  event.preventDefault();if(!session||!workId)return
  const programIds=programmes.split(/[\s,]+/).filter(Boolean)
  if(programIds.length<2||programIds.some(id=>!uuid.test(id))||!Number.isFinite(Date.parse(cut))){setMessage('Provide at least two exact programme identifiers and a valid knowledge cut.');return}
  const fingerprint=JSON.stringify({identity,programIds,cut})
  if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,request:{
   schema:'finnor.p6.induction-request.v1',root,workId,programIds,knowledgeCut:new Date(cut).toISOString(),
   idempotencyKey:crypto.randomUUID(),mode:'ordinary_disposable'}}
  const sequence=++epoch.current,expected=identity;inspected.current=null;clear();setBusy(true)
  try{const result=await centropyPost<{inductionId:string}>('company-brain/procedure-induce',pending.current.request)
   if(sequence!==epoch.current||current.current!==expected)return
   induction.current={identity:expected,id:result.inductionId};await refresh(sequence)
  }catch{if(sequence===epoch.current&&current.current===expected){setBusy(false);setMessage('Induction was not confirmed. Retrying unchanged inputs uses the same request identity.')}}
 }
 async function invalidate(event:FormEvent){
  event.preventDefault();if(!visible)return
  const fingerprint=JSON.stringify({identity,id:visible.capsule.id,correction})
  if(notice.current?.fingerprint!==fingerprint)notice.current={fingerprint,key:crypto.randomUUID()}
  const id=visible.capsule.id,sequence=++epoch.current,expected=identity;clear();setBusy(true)
  try{await centropyPost('company-brain/procedure-counterexample',{capsuleId:id,type:'CORRECTION',reason:correction,idempotencyKey:notice.current.key})
   if(sequence===epoch.current&&current.current===expected){setBusy(false);await refresh(sequence,id)}
  }catch{if(sequence===epoch.current&&current.current===expected){setBusy(false);setMessage('The notice was not confirmed. No current-use claim is shown.')}}
 }
 async function inspect(){
  if(!visible)return
  const id=visible.capsule.id,sequence=epoch.current,expected=identity;setProof(null)
  try{const value=await centropyPost('company-brain/procedure-read',{capsuleId:id})
   if(sequence===epoch.current&&current.current===expected){setProof({identity:expected,value});requestAnimationFrame(()=>container.current?.querySelector<HTMLElement>('[data-procedure-proof]')?.focus())}
  }catch{if(sequence===epoch.current&&current.current===expected){clear();setMessage('Procedure evidence is no longer current or permitted.')}}
 }
 return <section ref={container} className="ct-evidence ct-procedure" data-procedure-work={workId??'none'} data-procedure-id={visible?.capsule.id??'none'} data-procedure-state={visible?.state??'none'}>
  <h4>Executable procedures</h4><p>No protected admission is available. These proposals cannot authorize business effects, funding, or causal transport.</p>
  <p role="status" aria-live="polite">{message}</p>
  {session&&workId?<><form onSubmit={induce}>
   <label>Source programme identifiers<textarea value={programmes} onChange={e=>setProgrammes(e.target.value)} required maxLength={2048}/></label>
   <label>Episode knowledge cut<input value={cut} onChange={e=>setCut(e.target.value)} required maxLength={64}/></label>
   <p>The declared original episodes include adverse, failed and incomplete records. This is not a global or independently controlled sample.</p>
   <button type="submit" disabled={busy}>Induce executable procedure</button>
  </form><form onSubmit={e=>{e.preventDefault();if(uuid.test(lookup)){clear();void refresh(++epoch.current,lookup)}}}>
   <label>Exact procedure identifier<input value={lookup} onChange={e=>setLookup(e.target.value)} required pattern={uuid.source}/></label>
   <button type="submit" disabled={busy}>Read authorized procedure</button>
  </form></>:null}
  {visible?<><p>Procedure {visible.capsule.id} · {visible.state.toLowerCase()} · {visible.capsule.support.episodes.length} original episodes · {visible.capsule.support.adverseRecords.length} adverse records retained.</p>
   <p>USD cost remains unknown. Induction, checking, failed use, fallback, corrections and maintenance are not free.</p>
   <button type="button" onClick={()=>void inspect()}>Inspect procedure evidence</button>
   {visible.state==='PROPOSED'?<button type="button" onClick={()=>onSelect(visible.capsule.id)}>Select for disposable execution</button>:null}
   <details><summary>Procedure domain and outstanding qualifications</summary><pre>{JSON.stringify(visible.capsule.template,null,2)}</pre><p>{visible.capsule.unavailableBindings.join(', ')}</p></details>
   <form onSubmit={invalidate}><label>Procedure correction or failure<textarea value={correction} onChange={e=>setCorrection(e.target.value)} required maxLength={2000}/></label>
    <button type="submit" disabled={busy}>Record counterexample and invalidate</button></form>
  </>:null}
  {proof?.identity===identity?<section tabIndex={-1} data-procedure-proof aria-label="Procedure immutable evidence"><pre>{JSON.stringify(proof.value,null,2)}</pre>
   <button type="button" onClick={()=>setProof(null)}>Close procedure evidence</button></section>:null}
 </section>
}
