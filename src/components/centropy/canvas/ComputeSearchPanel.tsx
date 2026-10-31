"use client"
import {useCallback,useEffect,useRef,useState} from 'react'
import {useCentropyAuth as useJarvisAuth} from '@/components/centropy/lib/centropy-auth'
import {centropyPost as jarvisPost,CentropyApiError as JarvisApiError} from '@/components/centropy/lib/api'
type Ref={owner:string;id:string;version:string;contentDigest:string}
type Read={searchId:string;programId:string;status:string;reason:string|null;plan:{deliberationPolicyRef?:Ref;orchestrationPolicyRef?:Ref;policyRequest:Ref;computeGrant:Ref;work:{id:string;revision:string};frontier:Array<{id:string;kind:string;status:string;mechanism:string;prerequisites:string[]}>;next:unknown[];incumbent:null|{moduleId:string;values:Record<string,{value:string;semantics:{unit:string;currencyCode:string|null}}>};stop:{heuristic:boolean;reason:string|null;remainingPredicates:string[]};quotaProfile:unknown[];outstanding:Array<{attemptId:string;status:string;disposition:string;liabilityRetained:boolean}>;costs:{usd:null;physicalAttempts:number;nativeAttempts:number;modelAttempts:number;recoveryAttempts:number};bottleneck:{kind:string};topology:{kind?:string;selection?:string;strategy?:string;proposalStatus?:string};qualifications:string[]}}
type Eligible={programId:string;status:string;workRevision:string;policyRequest:Ref;computeGrant:Ref}
type Projection={workId:string;searches:Read[];eligiblePrograms:Eligible[]}
type NativeProjection={workId:string;searches:Array<{searchId:string;workId:string;workRevision:string;currentness:string;policyCurrentness?:string;historicalCapsuleDigest?:string|null;capsule:unknown;measurementGaps?:unknown[];originalOutcomeAccepted?:boolean}>}
export function ComputeSearchPanel({root,workId,threadId,methodOwner='P2'}:{root:{entityType:string;entityId:string};workId:string|null;threadId:string;methodOwner?:'P2'|'W1'}){
 const {session}=useJarvisAuth()
 const identity=[session?.user.id??'signed-out',session?.access_token??'',threadId,root.entityType,root.entityId,workId??'none',methodOwner].join(':')
 const identityRef=useRef(identity);identityRef.current=identity
 const refreshing=useRef<{identity:string;sequence:number}|null>(null)
 const pending=useRef<{identity:string}|null>(null)
 const epoch=useRef(0),panel=useRef<HTMLDivElement>(null)
 const [state,setState]=useState<{identity:string;data:Projection;native:NativeProjection|null}|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState('Select native Work with a computation allocation.'),[strategy,setStrategy]=useState('ADAPTIVE'),[parallel,setParallel]=useState(1),[selected,setSelected]=useState('')
 const visible=state?.identity===identity?state.data:null,latest=visible?.searches[0]??null
 const native=state?.identity===identity?state.native?.searches.find(search=>search.searchId===latest?.searchId):null
 const clear=useCallback(()=>setState(null),[])
 const refresh=useCallback(async(sequence:number)=>{
  if(!session||!workId||!navigator.onLine)return;const expected=identity
  if(refreshing.current?.identity===expected&&refreshing.current.sequence===sequence)return
  const active={identity:expected,sequence};refreshing.current=active
  try{const data=await jarvisPost<Projection>('company-brain/compute-search-projection',{root:{entityType:root.entityType,entityId:root.entityId},workId,methodOwner})
   const native=methodOwner==='W1'?await jarvisPost<NativeProjection>('company-brain/economic-orchestration-projection',{root:{entityType:root.entityType,entityId:root.entityId},workId}):null
   if(sequence!==epoch.current||identityRef.current!==expected||!navigator.onLine)return
   if(data.workId!==workId||data.searches.some(s=>s.plan.work.id!==workId)){clear();setMessage('The computation belongs to another Work.');return}
   if(native&&(native.workId!==workId||native.searches.some(search=>search.workId!==workId))){
    clear();setMessage('Current orchestration could not be bound to this exact Work input.');return
   }
   if(native){
    // Bind current native evidence per search row. A stale INVALIDATED
    // historical row without a CURRENT binding leaves the live view; it must
    // never clear the fresh current projection or its reconciliation
    // controls (M1).
    const bound=(search:Read)=>native.searches.some(current=>
     current.searchId===search.searchId&&current.workRevision===search.plan.work.revision&&current.currentness==='CURRENT'&&
     (search.plan.orchestrationPolicyRef
      ?current.policyCurrentness==='CURRENT'&&current.capsule!==null&&current.historicalCapsuleDigest===search.plan.orchestrationPolicyRef.contentDigest
      :current.capsule===null&&current.policyCurrentness!=='CURRENT'))
    data.searches=data.searches.filter(search=>bound(search))
   }
   data.searches=data.searches.filter(search=>!search.plan.deliberationPolicyRef)
   setState({identity:expected,data,native});setMessage(data.searches[0]?.reason?.replaceAll('_',' ').toLowerCase()??(data.searches.length?'Current computation verified.':data.eligiblePrograms.length?'A method is waiting for its computation plan.':'No allocated method is waiting for computation.'))
  }catch(error){if(sequence===epoch.current&&identityRef.current===expected){clear();setMessage(error instanceof JarvisApiError&&[401,403,404].includes(error.status)?'Computation unavailable in the current access scope.':'Current computation could not be verified.')}}
   finally{if(refreshing.current===active)refreshing.current=null}
 },[identity,session,workId,root.entityId,root.entityType,methodOwner,clear])
 useEffect(()=>{const observer=epoch,sequence=++observer.current;clear();pending.current=null;setBusy(false);setSelected('');if(document.visibilityState==='visible')void refresh(sequence);return()=>{observer.current++}},[identity,refresh,clear])
 useEffect(()=>{if(!workId||!session)return;const timer=setInterval(()=>{if(document.visibilityState==='visible')void refresh(epoch.current)},3000);const focus=()=>{const sequence=++epoch.current;clear();if(!navigator.onLine){setMessage('Offline. Current computation must be verified after reconnecting.');return}if(document.visibilityState==='visible')void refresh(sequence)};document.addEventListener('visibilitychange',focus);window.addEventListener('focus',focus);window.addEventListener('offline',focus);window.addEventListener('online',focus);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',focus);window.removeEventListener('focus',focus);window.removeEventListener('offline',focus);window.removeEventListener('online',focus)}},[workId,session,refresh,clear])
 async function start(){
  const candidate=visible?.eligiblePrograms.find(p=>p.programId===selected)??visible?.eligiblePrograms[0];if(!candidate||pending.current?.identity===identity)return
  const operation={identity};pending.current=operation
  const sequence=++epoch.current,expected=identity;clear();setBusy(true)
  try{await jarvisPost('company-brain/'+(methodOwner==='W1'?'economic-orchestration-submit':'compute-search-submit'),{schema:methodOwner==='W1'?'finnor.economic-orchestration-request.v1':'finnor.compute-search-request.v1',programId:candidate.programId,policyRequest:candidate.policyRequest,computeGrant:candidate.computeGrant,idempotencyKey:crypto.randomUUID(),mode:'ordinary_disposable',strategy:methodOwner==='W1'?'ADAPTIVE':strategy,limits:{maxUnits:8,maxParallel:parallel},...(methodOwner==='W1'?{orchestration:{schema:'finnor.economic-orchestration-options.v1',purposeRef:'work:'+workId,populationRef:'work:'+workId,domainRef:root.entityType+':'+root.entityId,responseRef:null,observationSplit:'TRAIN'}}:{})})
   if(sequence===epoch.current&&identityRef.current===expected)await refresh(sequence)
  }catch(error){if(sequence===epoch.current&&identityRef.current===expected){clear();setMessage(error instanceof JarvisApiError?(error.details as {predicate?:string})?.predicate?.replaceAll('_',' ').toLowerCase()??'The original allocation could not admit computation.':'Computation could not be accepted.')}}
  finally{if(pending.current===operation){pending.current=null;if(identityRef.current===expected)setBusy(false)}}
 }
 async function control(transition:'cancel'|'resume'|'reconcile'){
  if(!latest||pending.current?.identity===identity)return;const operation={identity};pending.current=operation;const sequence=++epoch.current,expected=identity;clear();setBusy(true)
  try{await jarvisPost('company-brain/'+(methodOwner==='W1'?'economic-orchestration-':'compute-search-')+transition,{searchId:latest.searchId});if(sequence===epoch.current&&identityRef.current===expected)await refresh(sequence)}
  catch{if(sequence===epoch.current&&identityRef.current===expected){clear();setMessage('The computation transition could not be confirmed.')}}
  finally{if(pending.current===operation){pending.current=null;if(identityRef.current===expected)setBusy(false)}}
 }
 const currentIncumbent=latest&&!['CANCELLED','INVALIDATED'].includes(latest.status)&&(methodOwner!=='W1'||native?.currentness==='CURRENT')?latest.plan.incumbent:null
 return <div ref={panel} className={methodOwner==='W1'?'ct-evidence ct-economic-orchestration':'ct-evidence ct-compute-search'} data-compute-work={methodOwner==='P2'?workId??'none':undefined} data-compute-search={methodOwner==='P2'?latest?.searchId??'none':undefined} data-orchestration-work={methodOwner==='W1'?workId??'none':undefined} data-orchestration-search={methodOwner==='W1'?latest?.searchId??'none':undefined}>
  <h3>{methodOwner==='W1'?'Economic orchestration':'Allocated computation'}</h3>
  <p role="status" aria-live="polite">{message}</p>
  {visible?.eligiblePrograms.length?<div className="ct-evidence__fields">
   <label>Allocated analytical method<select value={selected||visible.eligiblePrograms[0]?.programId} onChange={e=>setSelected(e.target.value)}>{visible.eligiblePrograms.map(p=><option key={p.programId} value={p.programId}>{p.programId} · {p.status.toLowerCase()}</option>)}</select></label>
   {methodOwner==='P2'?<label>Computation strategy<select value={strategy} onChange={e=>setStrategy(e.target.value)}><option value="ADAPTIVE">Adaptive checks</option><option value="FIXED_SEQUENTIAL">Fixed sequential comparison</option><option value="FIXED_WIDE">Fixed parallel comparison</option></select></label>:null}
   <label>Maximum parallel work<select value={parallel} onChange={e=>setParallel(Number(e.target.value))}><option value={1}>One</option><option value={2}>Two</option></select></label>
   <button type="button" disabled={busy||!session} onClick={()=>void start()}>{methodOwner==='W1'?'Run economic orchestration':'Run allocated computation'}</button>
  </div>:null}
  {latest?<><p>Native Work {latest.plan.work.id} · input {latest.plan.work.revision} · {latest.status.toLowerCase()}</p>
   <p>{latest.plan.bottleneck.kind.replaceAll('_',' ').toLowerCase()} · {(latest.plan.topology.kind??latest.plan.topology.strategy??'unknown').replaceAll('_',' ').toLowerCase()}</p>
   <ol>{latest.plan.frontier.map(u=><li key={u.id}>{u.kind.replaceAll('_',' ').toLowerCase()} · {u.mechanism} · {u.status.toLowerCase()} {u.prerequisites.length?'· waits for a completed prerequisite':''}</li>)}</ol>
   {currentIncumbent?<dl className="ct-evidence__values">{Object.entries(currentIncumbent.values).map(([key,v])=><div key={key}><dt>{key}</dt><dd>{v.value} {v.semantics.currencyCode??v.semantics.unit}</dd></div>)}</dl>:null}
   <p>{latest.plan.costs.physicalAttempts} physical attempts · {latest.plan.costs.recoveryAttempts} recovery attempts. USD cost is unknown.</p>
   <p>{methodOwner==='W1'?'Policy checking is model-relative, not protected admission or field value. Compatible fallback requires current owners, remaining resources and settled obligations.':'Stopping is heuristic. Remaining decision value and unseen mechanisms are unknown.'}</p>
   {methodOwner==='W1'?<p>Policy: {native?.policyCurrentness?.replaceAll('_',' ').toLowerCase()??'unavailable'}. Complete child, preparation and monetary costs remain unknown.</p>:null}
   {latest.plan.outstanding.length?<><p>Outstanding physical work retains its allocation liability.</p><ul>{latest.plan.outstanding.map(a=><li key={a.attemptId}>{a.status.toLowerCase()} · {a.disposition.toLowerCase()} · {a.attemptId}</li>)}</ul></>:null}
   <div className="ct-evidence__actions">{!['STOPPED','CANCELLED','INVALIDATED'].includes(latest.status)?<button type="button" disabled={busy} onClick={()=>void control('cancel')}>Cancel computation</button>:null}{latest.status==='WAITING'?<button type="button" disabled={busy} onClick={()=>void control('resume')}>Resume with original allocation</button>:null}{latest.plan.outstanding.length?<button type="button" disabled={busy} onClick={()=>void control('reconcile')}>Reconcile outstanding work</button>:null}
   <button type="button" onClick={()=>{panel.current?.querySelector<HTMLDetailsElement>('details')?.setAttribute('open','');panel.current?.querySelector<HTMLElement>('[data-compute-proof]')?.focus()}}>{methodOwner==='W1'?'Inspect orchestration evidence':'Inspect computation evidence'}</button></div>
   <details><summary>Allocation, endpoint limits and remaining checks</summary><section data-compute-proof tabIndex={-1}><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify({searchId:latest.searchId,programId:latest.programId,policyRequest:latest.plan.policyRequest,computeGrant:latest.plan.computeGrant,costs:latest.plan.costs,stop:latest.plan.stop,quota:latest.plan.quotaProfile,outstanding:latest.plan.outstanding,qualifications:latest.plan.qualifications,...(methodOwner==='W1'?{orchestrationPolicyRef:latest.plan.orchestrationPolicyRef,nativeReader:native}: {})},null,2)}</pre></section></details>
  </>:null}
 </div>
}
