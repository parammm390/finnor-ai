"use client"

import {useCallback,useEffect,useRef,useState} from 'react'
import {centropyPost,CentropyApiError} from '../lib/api'
import {useCentropyAuth} from '../lib/centropy-auth'
import type {AcquisitionDecisionRead} from '../../../../finnor-os/packages/shared-types/src/acquisition-decisions'

type Decision=AcquisitionDecisionRead
const label=(key:string)=>key.replaceAll('_',' ').replaceAll('.',' ')

/** Read the canonical owner at the current access boundary. A verified start
 * receipt supplies identity only; no receipt or browser cache supplies a bid. */
export function AcquisitionDecisionPanel({decisionId,workId,dealId}:{decisionId:string;workId:string;dealId:string}){
 const {session}=useCentropyAuth(),scope=JSON.stringify([session?.user.id??null,decisionId,workId,dealId])
 const activeScope=useRef(scope);activeScope.current=scope
 const [reading,setReading]=useState<{scope:string;data:Decision}|null>(null),[proof,setProof]=useState<{scope:string;data:unknown}|null>(null),[notice,setNotice]=useState<{scope:string;text:string}|null>(null)
 const proofElement=useRef<HTMLElement>(null),sequence=useRef(0),readSequence=useRef(0)
 const data=session&&reading?.scope===scope?reading.data:null
 const checked=data?.status==='TESTED'&&data.result?.completeSearch===true?data.result:null
 const refresh=useCallback(async()=>{
  if(!session)return
  const epoch=sequence.current,readId=++readSequence.current
  try{
   const current=await centropyPost<Decision>('company-brain/acquisition-read',{decisionId})
   if(epoch!==sequence.current||readId!==readSequence.current||activeScope.current!==scope)return
   if(current.decisionId!==decisionId||current.workId!==workId||current.request.dealId!==dealId)throw Error('Acquisition read scope mismatch')
   setReading({scope,data:current});setNotice(null)
   if(current.status!=='TESTED'){sequence.current++;setProof(null)}
  }catch(error){
   if(epoch!==sequence.current||readId!==readSequence.current||activeScope.current!==scope)return
   sequence.current++
   setReading(null);setProof(null)
   setNotice({scope,text:error instanceof CentropyApiError&&error.status===409?'This decision is no longer current. Recheck the financial sources and acquisition mandate.':'The current acquisition decision could not be verified.'})
  }
 },[session,scope,decisionId,workId,dealId])
 useEffect(()=>{
  sequence.current++;setReading(null);setProof(null);setNotice(null)
  if(!session)return
  let busy=false
  const read=async()=>{if(busy||document.visibilityState!=='visible')return;busy=true;try{await refresh()}finally{busy=false}}
  void read();const timer=setInterval(()=>void read(),3000)
  const visibility=()=>{sequence.current++;setReading(null);setProof(null);if(document.visibilityState==='visible')void read()}
  document.addEventListener('visibilitychange',visibility)
  return()=>{sequence.current++;clearInterval(timer);document.removeEventListener('visibilitychange',visibility)}
 },[scope,session,refresh])
 async function inspect(){
  if(!checked||!data?.analysis?.programId)return
  const epoch=sequence.current;setProof(null)
  try{
   const witness=await centropyPost('company-brain/program-witness',{programId:data.analysis.programId})
   if(epoch!==sequence.current||activeScope.current!==scope)return
   // Check the financial consumer again after reading its producer witnesses.
   const current=await centropyPost<Decision>('company-brain/acquisition-read',{decisionId})
   if(epoch!==sequence.current||activeScope.current!==scope)return
   if(current.workId!==workId||current.status!=='TESTED'||current.analysis?.resultDigest!==data.analysis.resultDigest)throw Error('Acquisition source changed')
   setProof({scope,data:witness});requestAnimationFrame(()=>proofElement.current?.focus())
  }catch{if(epoch===sequence.current&&activeScope.current===scope){setReading(null);setProof(null);setNotice({scope,text:'The financial source analysis is no longer current.'})}}
 }
 const pending=data?.status==='WAITING_ANALYSIS'?'Verifying the selected financial sources.':data?.status==='RUNNING'?'Comparing bids and financing.':data?.status==='QUEUED'?'Acquisition analysis is queued.':data?'The financial analysis did not produce a complete decision.':'Reading the current acquisition decision…'
 return <div className="ct-evidence" data-acquisition-decision={decisionId} data-acquisition-work={workId}>
  <p role="status" aria-live="polite">{!session?'Sign in to inspect this acquisition.':notice?.scope===scope?notice.text:checked?'Financial comparison checked.':pending}</p>
  {checked&&data?<>
   <p className="ct-canvas-block__lede">{checked.maximumBid.qualification==='NO_FEASIBLE_CANDIDATE'?'No feasible bid in the declared domain.':`Maximum tested bid: ${checked.maximumBid.value} ${data.request.bidDomain.currency}`}</p>
   {checked.maximumBid.financingCaseKey?<p>Financing: {data.request.financingCases.find(f=>f.key===checked.maximumBid.financingCaseKey)?.name??checked.maximumBid.financingCaseKey}</p>:null}
   <p>{checked.candidates.length} candidates checked across {data.request.bidDomain.values.length} bid amounts and {data.request.financingCases.length} financing cases.</p>
   <p>The result covers the stated financial model, sources and constraints. It does not establish realized profit or investment approval.</p>
   <details><summary>Financial constraints and financing comparison</summary>
    <ul>{data.request.constraints.map((c,i)=><li key={i}>{label(c.outputNodeId)}: {c.operator==='gte'?'at least':'at most'} {c.threshold} {c.currency??c.unit}</li>)}</ul>
    <div className="ct-instrument-table" role="table" aria-label="Acquisition bid and financing comparison">
     <div role="row"><span role="columnheader">Bid</span><span role="columnheader">Financing</span><span role="columnheader">Feasibility</span><span role="columnheader">Unsatisfied constraints</span></div>
     {checked.candidates.map(c=><div role="row" key={c.runId}><span role="cell">{c.bid} {data.request.bidDomain.currency}</span><span role="cell">{data.request.financingCases.find(f=>f.key===c.financingCaseKey)?.name??c.financingCaseKey}</span><span role="cell">{c.feasible===true?'Feasible':c.feasible===false?'Infeasible':'Unresolved'}</span><span role="cell">{c.failedConstraints.map(label).join(', ')||'None'}</span></div>)}
    </div>
   </details>
   {data.analysis?.programId?<button type="button" onClick={()=>void inspect()}>Inspect financial source analysis</button>:null}
   <p>Computation cost remains unmetered.</p>
  </>:null}
  <button type="button" disabled={!session} onClick={()=>void refresh()}>Recheck acquisition decision</button>
  {proof?.scope===scope&&checked?<section ref={proofElement} tabIndex={-1} data-acquisition-proof aria-label="Financial source analysis"><h4>Financial source analysis and independent checks</h4><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(proof.data,null,2)}</pre><button type="button" onClick={()=>setProof(null)}>Close financial source analysis</button></section>:null}
 </div>
}
