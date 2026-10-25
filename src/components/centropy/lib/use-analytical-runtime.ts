"use client"

import {useEffect,useState} from 'react'
import {centropyPost} from './api'

type AnalysisMode='ordinary_disposable'|'production_analysis'
type Runtime={mode:AnalysisMode|null;effectAuthority:false;protectedExecution:false}
type ProgramExecution={configurationReady:boolean}

/** The server owns executable modes. Never offer a form choice that grants
 * authority or outlives the authenticated principal and source context. */
export function useAnalyticalRuntime(root:{entityType:string;entityId:string},identity:string,enabled:boolean,producer:'evidence'|'program'='evidence'){
 const {entityType,entityId}=root
 const scope=JSON.stringify([identity,entityType,entityId,producer])
 const [reading,setReading]=useState<{scope:string;mode:AnalysisMode|null}|null>(null)
 useEffect(()=>{
  if(!enabled)return
  let current=true
  void centropyPost<{runtime:Runtime;programExecution:ProgramExecution}>('company-brain/program-ports',{root:{entityType,entityId}}).then(({runtime,programExecution})=>{
   if(!current)return
   const mode=runtime?.effectAuthority===false&&runtime?.protectedExecution===false&&
    (runtime.mode==='ordinary_disposable'||runtime.mode==='production_analysis')&&
    (producer==='evidence'||programExecution?.configurationReady===true)?runtime.mode:null
   setReading({scope,mode})
  }).catch(()=>{if(current)setReading({scope,mode:null})})
  return()=>{current=false}
 },[scope,entityType,entityId,enabled,producer])
 const current=enabled&&reading?.scope===scope?reading:null
 return {mode:current?.mode??null,message:!enabled?'Sign in to run analysis.':!current?'Checking analysis availability…':!current.mode?'Analysis is unavailable. Contact your workspace administrator.':null}
}
