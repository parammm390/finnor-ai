'use client'

import {useEffect,useRef,useState} from 'react'
import {usePathname} from 'next/navigation'
import {centropyPost,CentropyApiError} from '@/components/centropy/lib/api'
import {onBusinessInvalidation} from '@/components/centropy/lib/business-invalidation'
import {usePrivateRequestScope} from '@/components/centropy/lib/use-private-request-scope'
import type {WorkEconomicAnchor,WorkEconomicContext} from '../../../../finnor-os/packages/shared-types/src/work-economic'

type Props={workId:string;onChanged:()=>void}
export function WorkEconomicOutcome(props:Props){
 const path=usePathname(),scope=usePrivateRequestScope('work-economics:'+path+':'+props.workId)
 if(!scope.allowed)return null
 return <EconomicOutcomeContent key={scope.key} {...props} scopeKey={scope.key} isCurrent={scope.isCurrent}/>
}
function EconomicOutcomeContent({workId,onChanged,scopeKey,isCurrent}:Props&{scopeKey:string;isCurrent:(key:string)=>boolean}){
 const [context,setContext]=useState<WorkEconomicContext|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null)
 const [criterion,setCriterion]=useState<number|undefined>(),[selection,setSelection]=useState(''),[replace,setReplace]=useState(false),[revision,setRevision]=useState(0),[submitting,setSubmitting]=useState(false),[uncertain,setUncertain]=useState(false)
 const command=useRef<Record<string,unknown>|null>(null),busy=useRef(false)
 const refresh=()=>setRevision(v=>v+1)
 useEffect(()=>onBusinessInvalidation(event=>{if(event.tags.some(tag=>['work','objective','closing','company-brain','economic-outcomes'].includes(tag)))refresh()}),[])
 useEffect(()=>{
  let active=true;setLoading(true);setError(null)
  void centropyPost<WorkEconomicContext>('economic-outcomes/work-context',{workId,...(criterion===undefined?{}:{criterionIndex:criterion})}).then(value=>{
   if(!active||!isCurrent(scopeKey))return
   if(value.workId!==workId||criterion!==undefined&&value.anchor&&value.anchor.criterionIndex!==criterion)throw new Error('Economic tracking did not match the selected Work requirement')
   setContext(value)
   if(command.current&&value.tracking?.estimandRef.id===(command.current.estimandRef as {id?:string}|undefined)?.id){command.current=null;setUncertain(false)}
  }).catch(cause=>{if(active&&isCurrent(scopeKey))setError(cause instanceof Error?cause.message:'Economic tracking unavailable')}).finally(()=>{if(active&&isCurrent(scopeKey))setLoading(false)})
  return()=>{active=false}
 },[workId,criterion,revision,scopeKey,isCurrent])
 const selected=context?.choices.find(c=>c.ref.id===selection)
 const selectedUntil=selected?.availability.kind==='AVAILABLE'?selected.availability.until:undefined
 useEffect(()=>{
  const until=Date.parse(selectedUntil??'');if(!Number.isFinite(until)||until<=Date.now())return
  let timer:ReturnType<typeof setTimeout>
  const expire=()=>{const remaining=until-Date.now();if(remaining>0){timer=setTimeout(expire,Math.min(remaining,2147483647));return}refresh()}
  expire();return()=>clearTimeout(timer)
 },[selectedUntil])
 async function bind(){
  if(busy.current||!context?.anchor||!isCurrent(scopeKey))return
  if(!command.current){
   if(selected?.availability.kind!=='AVAILABLE'||Date.parse(selected.availability.until)<=Date.now()||context.tracking&&!replace)return
   command.current={anchor:context.anchor,estimandRef:selected.ref,idempotencyKey:crypto.randomUUID(),...(context.tracking?{replacesBindingRef:context.tracking.bindingRef}:{})}
  }
  busy.current=true;setSubmitting(true);setError(null)
  try{
   const result=await centropyPost<{binding:{payload:{anchor:WorkEconomicAnchor};ref:{id:string}}}>('economic-outcomes/bind-work',command.current)
   if(!isCurrent(scopeKey))return
   if(result.binding.payload.anchor.workId!==workId||result.binding.payload.anchor.workInputId!==context.anchor.workInputId)throw new Error('The measurement-plan link did not match this original Work')
   command.current=null;setUncertain(false);setReplace(false);setSelection('');refresh();onChanged()
  }catch(cause){if(isCurrent(scopeKey)){const ambiguous=!(cause instanceof CentropyApiError)||cause.retryable;setUncertain(ambiguous);if(!ambiguous)command.current=null;setError(cause instanceof Error?cause.message:'The plan link is unconfirmed. Retry the same command or refresh its recorded state.')}}
  finally{busy.current=false;if(isCurrent(scopeKey))setSubmitting(false)}
 }
 if(context&&!context.applicable)return null
 return <section className='ct-world-work__section' aria-label='Acquisition economic outcome' aria-busy={loading||submitting}>
  <div className='ct-world-work__top'><h4>Acquisition economic outcome</h4><button type='button' onClick={refresh} disabled={loading||submitting}>Refresh outcome tracking</button></div>
  {loading?<p role='status'>Reading the original requirement and registered measurement plans…</p>:null}
  {error?<p role='alert'>{error}</p>:null}
  {context?.criteria.length&&context.criteria.length>1?<label>Economic requirement<select value={criterion??''} disabled={submitting||uncertain} onChange={event=>{setContext(null);setCriterion(event.target.value===''?undefined:Number(event.target.value));setSelection('');setReplace(false);command.current=null}}><option value=''>Choose the exact requirement</option>{context.criteria.map(c=><option key={c.index} value={c.index}>{c.reason}</option>)}</select></label>:null}
  {context?.originalClause?<p>{context.originalClause}</p>:null}
  {context?.tracking?<>
   <p role='status'>Measurement plan registered. {context.tracking.sourceGaps.length?`${context.tracking.sourceGaps.length} source commitments still need authenticated evidence.`:'Recorded source commitments require current verification before outcome review.'}</p>
   <dl><dt>Currency</dt><dd>{context.tracking.currency}</dd><dt>Observation begins</dt><dd>{new Date(context.tracking.assignmentAt).toLocaleString()}</dd><dt>Measurement endpoint</dt><dd>{new Date(context.tracking.endpointAt).toLocaleString()}</dd><dt>Identification</dt><dd>{context.tracking.assignmentKind==='OBSERVATIONAL_UNIDENTIFIED'?'Observational; causal contribution is unidentified':'Prospective randomized design; results remain pending'}</dd></dl>
   <p>Closing, authenticated settlement, complete costs, measurements and outcome review remain required. Registration does not establish realized profit.</p>
  </>:context?.anchor?<p>No measurement plan is linked to this original requirement.</p>:null}
  {context?.anchor?<>
   {context.choices.length?<>
    <label>Prospective measurement plan<select value={selection} disabled={loading||submitting||uncertain} onChange={event=>{setSelection(event.target.value);setReplace(false);setError(null);command.current=null}}><option value=''>Choose a registered plan for this Work</option>{context.choices.map(c=><option key={c.ref.id} value={c.ref.id} disabled={c.availability.kind!=='AVAILABLE'}>{c.key} · {c.currency} · {new Date(c.endpointAt).toLocaleDateString()}{c.availability.kind==='AVAILABLE'?'':' · '+{CURRENT:'currently linked',EXPOSURE_STARTED:'exposure has already begun',CURRENCY_MISMATCH:'currency differs from this acquisition',CORRECTION_REQUIRED:'does not correct the linked plan'}[c.availability.kind]}</option>)}</select></label>
    {context.tracking&&selected?<label><input type='checkbox' checked={replace} disabled={submitting||uncertain} onChange={event=>{setReplace(event.target.checked);setError(null)}}/> Link an explicit correction of the current measurement plan. Preserve the previous commitment.</label>:null}
    <button type='button' disabled={loading||submitting||Boolean(error)&&!uncertain||!uncertain&&(selected?.availability.kind!=='AVAILABLE'||Boolean(context.tracking)&&!replace)} onClick={()=>void bind()}>{submitting?'Recording the original plan link…':uncertain?'Retry the same plan link':'Link measurement plan to this requirement'}</button>
   </>:<p>No prospective measurement plan is registered for this Work. Its owner boundary, opening wealth, financial sources and measurement dates must be explicitly registered before exposure.</p>}
  </>:null}
  {context?.originalBudget?<p>Original automated allowance: {context.originalBudget.actionCount}/{context.originalBudget.maxActions} actions, {context.originalBudget.queryCount}/{context.originalBudget.maxQueries} queries. Execution deadline: {new Date(context.originalBudget.deadlineAt).toLocaleString()}. Outcome tracking does not extend it.</p>:null}
 </section>
}
