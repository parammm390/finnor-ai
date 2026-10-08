"use client"

import {useCallback,useEffect,useRef,useState} from "react"
import {centropyPost,CentropyApiError} from "@/components/centropy/lib/api"
import {useCentropyAuth} from "@/components/centropy/lib/centropy-auth"

type Root={entityType:string;entityId:string}
type Continuation={
  continuationId:string;workId:string;state:string;recordedState:string;nextProgramId:string|null;
  affectedNodes:string[];keptNodes:string[];historicalPublicationRetained:boolean;
  incurredCosts:{attempts:number;steps:number;usd:null};
  patch:null|{publication:{id:string;contentDigest:string};priorProgram:{id:string};nextProgram:{id:string}};
}

export function ContinuationPanel({root,workId,priorProgramId,onSelectProgram}:{
  root:Root;workId:string;priorProgramId:string|null;onSelectProgram:(id:string)=>void;
}){
  const {session}=useCentropyAuth();
  const identity=[session?.user.id??"signed-out",session?.access_token??"no-session",root.entityType,root.entityId,workId,priorProgramId??"none"].join(":");
  const identityRef=useRef(identity);identityRef.current=identity;
  const epoch=useRef(0);
  const readEpoch=useRef(0);
  const [view,setView]=useState<{identity:string;continuations:Continuation[]}|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("No owner-confirmed continuation loaded.");
  const visible=view?.identity===identity?view.continuations:[];
  const refresh=useCallback(async(sequence:number)=>{
    const expected=identity,request=++readEpoch.current;
    try{
      const result=await centropyPost<{workId:string;continuations:Continuation[]}>("company-brain/continuation-projection",{root:{entityType:root.entityType,entityId:root.entityId},workId});
      if(sequence!==epoch.current||request!==readEpoch.current||identityRef.current!==expected)return;
      if(result.workId!==workId||result.continuations.some(c=>c.workId!==workId))throw Error("CONTINUATION_WORK_MISMATCH");
      setView({identity:expected,continuations:result.continuations});
      setMessage(result.continuations.length?"Current owner states loaded.":"No continuation recorded for this Work.");
    }catch{
      if(sequence===epoch.current&&request===readEpoch.current&&identityRef.current===expected){
        setView(null);setMessage("Current continuation could not be verified. Retained history is not a current result.");
      }
    }
  },[identity,root.entityType,root.entityId,workId]);
  useEffect(()=>{
    const observer=epoch,sequence=++observer.current;setView(null);setBusy(false);setMessage("No owner-confirmed continuation loaded.");
    if(session&&document.visibilityState==="visible")void refresh(sequence);
    return()=>{observer.current++};
  },[identity,session,refresh]);
  useEffect(()=>{
    if(!session)return;
    const update=()=>{const sequence=++epoch.current;setView(null);setBusy(false);if(document.visibilityState==="visible")void refresh(sequence)};
    const timer=setInterval(()=>{if(document.visibilityState==="visible")void refresh(epoch.current)},2000);
    document.addEventListener("visibilitychange",update);window.addEventListener("focus",update);
    return()=>{clearInterval(timer);document.removeEventListener("visibilitychange",update);window.removeEventListener("focus",update)};
  },[session,refresh]);
  async function submit(){
    if(!priorProgramId||busy||!session)return;
    const sequence=++epoch.current,expected=identity;setView(null);setBusy(true);
    try{
      await centropyPost("company-brain/continuation-submit",{priorProgramId});
      if(sequence===epoch.current&&identityRef.current===expected)await refresh(sequence);
    }catch(error){
      if(sequence===epoch.current&&identityRef.current===expected){
        setView(null);
        const predicate=error instanceof CentropyApiError?(error.details as {predicate?:string}|null)?.predicate:null;
        setMessage(predicate?.startsWith("P7_")?predicate.replaceAll("_"," ").toLowerCase():"Continuation acceptance could not be confirmed.");
      }
    }finally{if(sequence===epoch.current&&identityRef.current===expected)setBusy(false)}
  }
  return <section className="ct-evidence" aria-label="Programme continuation" data-continuation-work={workId}>
    <h4>Source revision continuation</h4>
    <p>Ordinary source-bound analytical correction only. No effect authority, funding, reservation release or admission is granted.</p>
    <button type="button" disabled={!session||!priorProgramId||busy} onClick={()=>void submit()}>Continue from observed source revision</button>
    <p role="status" aria-live="polite">{message}</p>
    {visible.map(c=><div key={c.continuationId}>
      <p>{c.state.toLowerCase()} · {c.affectedNodes.length} affected nodes · {c.keptNodes.length} retained nodes</p>
      <p>Original episode: {c.incurredCosts.attempts} attempts and {c.incurredCosts.steps} steps. USD cost remains unknown.</p>
      {c.historicalPublicationRetained&&c.state!=="PUBLISHED"?<p>Historical publication retained, not current.</p>:null}
      {c.state==="PUBLISHED"&&c.patch&&c.nextProgramId?<><p>Current manifest digest: <code>{c.patch.publication.contentDigest}</code></p>
        <button type="button" onClick={()=>onSelectProgram(c.nextProgramId!)}>Open current continued programme</button></>:null}
    </div>)}
  </section>
}
