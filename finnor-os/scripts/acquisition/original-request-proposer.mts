import {appendFile} from 'node:fs/promises';
import {registerProvider} from '@finnor/tools';

// This controlled provider receives only the production prompt. It has no DB,
// issuer access, accepted-request file, future IDs or financial answer closure.
if(process.env.FINNOR_ORIGINAL_REQUEST_PROMPTS){
 registerProvider('original-request-prompt-only',()=>({name:'original-request-prompt-only',complete:async(input:any)=>{
  const prompt=JSON.parse(input.user),state=prompt.planningContext;
  if(!state)throw Error('ORIGINAL_REQUEST_PLAN_PROMPT_REQUIRED');
  await appendFile(process.env.FINNOR_ORIGINAL_REQUEST_PROMPTS!,JSON.stringify(prompt)+'\n');
  const reviewed=state.reviewedAcquisition,request=reviewed?.request;
  if(!request)throw Error('REVIEWED_ORIGINAL_ACQUISITION_NOT_VISIBLE');
  const actions=state.actions??[],done=(type:string)=>actions.some((a:any)=>a.actionType===type&&a.status==='completed');
  const supports=prompt.goal.criteria.map((c:any)=>c.id),reads=state.ownerReads??[];
  const wait=(read:any)=>({kind:'wait',waitFor:read.data.completionEvent,deadlineAt:new Date(Math.min(Date.parse(read.data.deadlineAt),Date.parse(prompt.constraints.deadlineAt))).toISOString()});
  const awakened=(read:any)=>state.eventWake?.wait?.correlationId===read.data.completionEvent?.correlationId;
  let node:any;
  if(!done('start_primary_diligence'))node={kind:'action',actionType:'start_primary_diligence',payload:{...request.primary,dealId:request.dealId,expectedWorkInputId:reviewed.acceptance.workInputId}};
  else if(!done('create_underwriting_run')){
   const read=reads.find((r:any)=>r.intent==='primary_diligence_v1'&&r.data.programmeId);
   if(read&&['PROGRESS','RECONCILING'].includes(read.data.status)&&!awakened(read))node=wait(read);
   else if(!read||read.data.status!=='COMPLETE'){
    const source=prompt.snapshot.availableReads.find((r:any)=>r.request.intent==='primary_diligence_v1'&&r.request.programmeId);
    if(!source)throw Error('EXACT_ACCEPTED_PRIMARY_READ_NOT_VISIBLE');
    node={kind:'query',request:source.request};
   }else{
    const bindings:Record<string,unknown>={};
    for(const [nodeId,selection] of Object.entries(request.underwriting.primaryAssertions) as any){
     const findings=read.data.findings.filter((f:any)=>f.assertionRef.id===selection.assertionId&&f.assertionRef.revision===String(selection.revision));
     if(findings.length!==1)throw Error('EXACT_ORIGINAL_ASSERTION_FINDING_UNAVAILABLE');
     bindings[nodeId]={findingId:findings[0].artifactId};
    }
    const {primaryAssertions:_selectors,...underwriting}=request.underwriting;
    node={kind:'action',actionType:'create_underwriting_run',payload:{...underwriting,dealId:request.dealId,primaryFindingInputs:bindings}};
   }
  }else if(!done('start_acquisition_evaluation')){
   const runs=(state.privateEquityIcBasis?.recentRuns??[]).filter((r:any)=>r.workId===reviewed.acceptance.workId&&r.modelVersionId===request.underwriting.modelVersionId&&!r.scenarioId&&r.status==='SUCCEEDED'&&r.validity==='VALID');
   if(runs.length!==1)throw Error('EXACT_ORIGINAL_UNDERWRITING_RUN_NOT_VISIBLE');
   node={kind:'action',actionType:'start_acquisition_evaluation',payload:{...request.acquisition,dealId:request.dealId,baseRunId:runs[0].id}};
  }else{
   const read=reads.find((r:any)=>r.intent==='acquisition_decision_v1'&&r.data.decisionId);
   if(read&&['QUEUED','RUNNING','WAITING_ANALYSIS'].includes(read.data.status)&&!awakened(read))node=wait(read);
   else if(!read||read.data.status!=='TESTED'){
    const source=prompt.snapshot.availableReads.find((r:any)=>r.request.intent==='acquisition_decision_v1'&&r.request.decisionId);
    if(!source)throw Error('EXACT_ACCEPTED_ACQUISITION_READ_NOT_VISIBLE');
    node={kind:'query',request:source.request};
   }else node={kind:'wait',waitFor:{eventType:'deadline.reached'},deadlineAt:prompt.constraints.deadlineAt};
  }
  return JSON.stringify({candidates:[{version:1,candidateKey:'original-contract-next',nodes:[{key:'operation',...node,supports},...prompt.goal.criteria.map((c:any,i:number)=>({key:'check_'+i,kind:'check',criterionId:c.id,dependsOn:['operation']}))]}]});
 }}));
 process.env.LLM_PROVIDER_PLANNING_CONSOLE='original-request-prompt-only';
 process.env.LLM_PROVIDER_PLANNING='original-request-prompt-only';
}
