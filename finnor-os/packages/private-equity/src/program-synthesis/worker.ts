
import {advanceProgramSearch,invalidateUnstartedProgramSearch} from '../compute-search/controller';
import {executeHarnessCandidate} from './execution';
import {tryProcedureCandidate} from '../procedure-induction/programme';
import {sha256 as planningHash} from '@finnor/planning';
import {randomUUID} from 'node:crypto';
import {groundedMemoBytes,ingestArtifact,getArtifactBytes} from '@finnor/artifacts';
import {recordBusinessEvent} from '@finnor/data-platform';
import {describeLLMRoute,resolveProviderForPurpose} from '@finnor/tools';
import type {JobExecutionContext} from '../../../../apps/worker/src/queue';
import type {PeMutationContext} from '../types';
import {handleEvidenceOperation,readEvidence} from '../evidence-execution/api';
import {submitEvidenceContinuation} from '../evidence-execution/continuation';
import {assertDependencies,authorize,codeIdentity,principal,revisions,sha,stable,tx,currentDerivation} from '../evidence-execution/store';
import {parseHarnessRequest,type HarnessProgram,type HarnessValue,type NativeModule} from './contracts';
import {constructModules,evidenceSourceProgram} from './compiler';
import {executeTypeScriptModule} from './typescript';
import {executeNativeModule} from './native';
import {checkNumericalAcceptance,checkDraftBytes,observeAcceptedBranches} from './checker';
import {resolveEconomicBindings,executeOwnerOperation} from './owners';
import {assertProgramCurrent,enqueueProgram,requestRow,safePredicate,trace,episodeCosts,persistProgrammeHead,reserveCandidate,costWitness,type ProgramRow} from './store';

async function durableNode(ctx:PeMutationContext,q:ProgramRow,id:string,body:unknown){await tx(ctx,async c=>{const current=await requestRow(ctx,q.id,c,true);if(current.generation!==q.generation||current.claim_token!==q.claim_token||current.status!=='RUNNING')throw Error('PROGRAM_NODE_CLAIM_FENCED');const prior=(await c.query<{body:unknown;digest:string}>('SELECT body,digest FROM finnor_os.p1_node_results WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND generation=$4 AND node_id=$5',[q.tenant_id,q.principal_id,q.id,q.generation,id])).rows[0];if(prior){if(sha(prior.body)!==prior.digest||sha(body)!==prior.digest)throw Error('DURABLE_NODE_REPLAY_MISMATCH');return;}await c.query('INSERT INTO finnor_os.p1_node_results(tenant_id,principal_id,request_id,generation,node_id,body,digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT DO NOTHING',[q.tenant_id,q.principal_id,q.id,q.generation,id,stable(body),sha(body)]);});}
async function reserve(ctx:PeMutationContext,q:ProgramRow,steps:number,attempts:number,c?:import('pg').PoolClient){const run=async(client:import('pg').PoolClient)=>{const row=(await client.query('UPDATE finnor_os.p1_episodes SET steps_used=steps_used+$2,attempts_used=attempts_used+$3 WHERE id=$1 AND tenant_id=$4 AND principal_id=$5 AND steps_used+$2<=max_steps AND attempts_used+$3<=max_attempts AND deadline_at>clock_timestamp() RETURNING *',[q.episode_id,steps,attempts,q.tenant_id,q.principal_id])).rows[0];if(!row)throw Error('ORIGINAL_EPISODE_GRANT_EXHAUSTED');return row;};return c?run(c):tx(ctx,run);}

export async function runHarnessProgramJob(payload:Record<string,unknown>,execution?:Readonly<JobExecutionContext>):Promise<void>{
 if(!execution||execution.protocolVersion!==1||typeof payload.tenantId!=='string'||typeof payload.principalId!=='string'||typeof payload.programId!=='string'||execution.tenantId!==payload.tenantId)throw Error('ACTUAL_DURABLE_HARNESS_JOB_CLAIM_REQUIRED');
 const ctx:PeMutationContext={auth:{tenantId:payload.tenantId,userId:payload.principalId,employeeId:payload.principalId,role:'owner'},provenance:{sourceSystem:'P1:bounded-native-worker',createdBy:payload.principalId}};
 let q=await requestRow(ctx,payload.programId);if(q.generation!==payload.generation||['TESTED','CANCELLED','INVALIDATED'].includes(q.status))return;if(typeof payload.stage==='string'&&payload.stage.startsWith('native-wait-deadline:')&&q.status!=='WAITING')return;const started=Date.now();let executedProgram:HarnessProgram|null=null;
 try{
  await assertProgramCurrent(ctx,q);
  if(q.request.computeSearch==='P2_REQUIRED'){const pending=await tx(ctx,async c=>{const locked=await requestRow(ctx,q.id,c,true);const bound=(await c.query('SELECT id FROM finnor_os.p2_requests WHERE tenant_id=$1 AND principal_id=$2 AND program_id=$3',[q.tenant_id,q.principal_id,q.id])).rows[0];if(bound)return false;await c.query("UPDATE finnor_os.p1_requests SET status='WAITING' WHERE id=$1 AND generation=$2 AND evidence_query_id IS NULL",[q.id,q.generation]);await trace(ctx,locked,'P2_OWNER_BINDING_REQUIRED',{originalEpisode:locked.episode_id,physicalAttempts:0},c);return true;});if(pending)return;}
  q=await tx(ctx,async c=>{const locked=await requestRow(ctx,q.id,c,true);if(locked.generation!==payload.generation||['TESTED','CANCELLED','INVALIDATED'].includes(locked.status))throw Error('PROGRAM_GENERATION_FENCED');const claim=(await c.query("SELECT id FROM finnor_os.jobs WHERE id=$1 AND tenant_id=$2 AND type='run_harness_program_v1' AND status='running' AND claim_token=$3 AND claim_fence=$4 AND protocol_version=1 FOR SHARE",[execution.jobId,q.tenant_id,execution.claimToken,execution.claimFence])).rows[0];if(!claim)throw Error('PROGRAM_JOB_CLAIM_FENCED');await reserve(ctx,locked,1,locked.evidence_query_id?0:1,c);await c.query("UPDATE finnor_os.p1_requests SET status='RUNNING',claim_token=$4,claim_fence=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[q.tenant_id,q.principal_id,q.id,execution.claimToken,execution.claimFence]);await trace(ctx,locked,'DELIVERY_STARTED',{jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence,workerId:execution.workerId,originalEpisode:locked.episode_id,costUSD:null},c);return {...locked,status:'RUNNING',claim_token:execution.claimToken,claim_fence:execution.claimFence};});
  const request=parseHarnessRequest(q.request);if(request.mode!=='ordinary_disposable'||process.env.NODE_ENV==='production'||process.env.FINNOR_P4_PROFILE!=='ordinary_disposable')throw Error('HARNESS_ORDINARY_RUNTIME_PROFILE_REQUIRED');
  if(!q.evidence_query_id){
   await trace(ctx,q,'MAP_PREMISES_ALTERNATIVES',{sourceSelectors:request.sources,materialRequired:request.acceptance.requiredSourceKeys,missingIsZero:false,contradictionsMayBeDropped:false});
   await trace(ctx,q,'RETRIEVE_COMPATIBLE_PROCEDURES',{catalogue:'REGISTERED_NATIVE_P4_EXACT_ARITHMETIC_ARTIFACT_V1',procedureCapsule:null,admission:null,p6Predicate:'P6_PROCEDURE_PORT_PENDING'});
   const handles=await handleEvidenceOperation(ctx,'evidence-handles',{root:request.root,validAt:q.proposed.validAt,knowledgeAt:q.proposed.knowledgeAt,inputs:request.sources.map(s=>({inputId:s.key,source:s.source}))});if(handles.status!==200)throw Error(String((handles.body as any).predicate??'P4_SOURCE_HANDLES_UNAVAILABLE'));
   await trace(ctx,q,'GENERATE_STRUCTURES',{source:'REGISTERED_NATIVE',structures:q.proposed.candidates,sourceDigest:sha(request.acceptance),cosmeticAlternativesExcluded:true});
   await trace(ctx,q,'COMPILE_PATHS',{modules:q.proposed.modules.map(m=>({id:m.id,sourceDigest:m.sourceDigest,compiledDigest:m.compiledDigest,format:m.format,bounds:m.bounds})),canonicalPlan:q.plan_revision_id,unresolvedPlaceholders:[]});
   const submitted=await submitEvidenceContinuation(ctx,{schema:'finnor.evidence-request.v1',question:request.instruction,root:request.root,workId:q.work_id,validAt:q.proposed.validAt,knowledgeAt:q.proposed.knowledgeAt,idempotencyKey:'p1:'+q.id+':'+q.generation,mode:'ordinary_disposable',inputs:(handles.body as any).handles.map((h:any)=>({inputId:h.inputId,handleId:h.id})),program:evidenceSourceProgram(request),acceptance:{selectedUniverse:'COMPLETE',absoluteTolerance:'0',materialOutputs:request.sources.map(s=>s.key)}},{workId:q.work_id,inputId:q.work_input_id,inputDigest:q.work_input_digest});
   await tx(ctx,async c=>{const current=await requestRow(ctx,q.id,c,true);if(current.claim_token!==execution.claimToken||current.generation!==q.generation||current.status!=='RUNNING')throw Error('P4_CONTINUATION_PUBLICATION_FENCED');await c.query("UPDATE finnor_os.p1_requests SET evidence_query_id=$4,status='WAITING_EVIDENCE' WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[q.tenant_id,q.principal_id,q.id,submitted.queryId]);await trace(ctx,q,'P4_CONTINUATION_QUEUED',{...submitted,exactWorkInputRetained:true,handleDigest:sha((handles.body as any).handles)},c);await enqueueProgram(ctx,q,'evidence-0',c,100);});return;
  }
  const evidence=await readEvidence(ctx,q.evidence_query_id);
  if(['QUEUED','RUNNING'].includes(evidence.status)){
   if(q.poll_count>=60)throw Error('P4_CONTINUATION_WAIT_BOUND');await tx(ctx,async c=>{const current=await requestRow(ctx,q.id,c,true);if(current.generation!==q.generation||current.claim_token!==execution.claimToken)throw Error('POLL_CLAIM_FENCED');await c.query("UPDATE finnor_os.p1_requests SET status='WAITING_EVIDENCE',poll_count=poll_count+1 WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[q.tenant_id,q.principal_id,q.id]);await enqueueProgram(ctx,q,'evidence-'+(q.poll_count+1),c,250);});return;
  }
  if(evidence.status!=='TESTED'||!evidence.derivation?.result)throw Error('P4_CURRENT_COMPLETE_TESTED_DERIVATION_REQUIRED');const d=await currentDerivation(ctx,evidence.derivation.id);
  if(d.work.id!==q.work_id||d.work.revision!==q.work_input_id||d.work.inputDigest!==q.work_input_digest||d.coverage.status!=='COMPLETE_SELECTED_UNIVERSE'||d.principalId!==q.principal_id)throw Error('P4_EXACT_PROGRAM_BINDING_MISMATCH');
  const solveNode=q.proposed.graph.find(n=>n.op==='solve')!;
  const saved=await tx(ctx,async c=>(await c.query<{body:any;digest:string}>('SELECT body,digest FROM finnor_os.p1_node_results WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND generation=$4 AND node_id=$5',[q.tenant_id,q.principal_id,q.id,q.generation,solveNode.id])).rows[0],true);
  if(saved&&sha(saved.body)!==saved.digest)throw Error('DURABLE_CHECKPOINT_DIGEST_MISMATCH');
  const program:HarnessProgram=JSON.parse(stable(saved?.body.programCheckpoint??q.proposed));executedProgram=program;
program.semanticBindings=[{producer:'P4',id:d.id,schema:d.schema,resultDigest:d.result!.digest,work:d.work,coverage:d.coverage},...await resolveEconomicBindings(ctx,request,{programId:q.id,workId:q.work_id,inputId:q.work_input_id,validAt:d.beliefView.validAt,knowledgeAt:d.beliefView.knowledgeAt})];program.dependencies=d.invalidationKeys;program.witnesses=d.witnesses;
  program.runtime={node:process.version,imageDigest:null,jobId:execution.jobId,workerId:execution.workerId,deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence};if(!saved)await trace(ctx,q,'P4_CURRENT_PRODUCER_COST',{derivationId:d.id,nativeInvocations:d.costs.nativeInvocations,costUSD:null});
  const input:Record<string,string>={};for(const s of request.sources){const value=d.result!.outputs[s.key];if(!value||value.kind!=='scalar'||value.value===null||!value.semantics||value.truthClass!=='DERIVED_VALUE')throw Error('MATERIAL_SOURCE_UNKNOWN_OR_CONTRADICTORY');input[s.key]=value.value;}
  await durableNode(ctx,q,program.graph.find(n=>n.op==='derive')!.id,{derivationId:d.id,resultDigest:d.result!.digest,witnessIds:d.witnesses.map(w=>w.id),work:d.work});
  let stepReservation=saved?program.graph.length+1:program.modules.reduce((n,m)=>n+m.bounds.steps,0)+program.graph.length+program.modules.length;let usedSteps=0;
  const meter=()=>{if(++usedSteps>stepReservation||Date.now()>Date.parse(program.bounds.deadlineAt))throw Error('ORIGINAL_EPISODE_STEP_OR_DEADLINE_EXHAUSTED');};
  const procedure=saved||!request.procedure?null:await tryProcedureCandidate(ctx,q,program,input,d,request.procedure);
  const adaptive=saved||procedure?null:await advanceProgramSearch(ctx,q,program,input,d);if(adaptive?.waiting)return;
  let selected:{moduleId:string;values:Record<string,HarnessValue>;checks:unknown[]};
  if(saved){
   if(saved.body.inputDigest!==sha(input)||saved.body.sourceResultDigest!==d.result!.digest||program.acceptanceDigest!==q.proposed.acceptanceDigest||program.producer.codeDigest!==q.proposed.producer.codeDigest||!program.modules.some(m=>m.id===saved.body.selectedModule&&sha(m.compiled)===m.compiledDigest))throw Error('CHECKED_CONTINUATION_SOURCE_OR_MODULE_MISMATCH');
   selected={moduleId:saved.body.selectedModule,values:saved.body.values,checks:saved.body.checks};await assertDependencies(ctx,program.dependencies);await reserve(ctx,q,1,0);await trace(ctx,q,'CHECKED_CONTINUATION_REUSED',{nodeId:solveNode.id,checkpointDigest:saved.digest,moduleId:selected.moduleId,sourceResultDigest:d.result!.digest,actualNewS6Executions:0,reSynthesis:false});
  }else if(procedure){
   selected=procedure;program.independentChecks=selected.checks;
   program.observableBranches=await tx(ctx,c=>observeAcceptedBranches(c,request.acceptance,input,d.witnesses.map(w=>w.id)),true);
   await durableNode(ctx,q,solveNode.id,{selectedModule:selected.moduleId,values:selected.values,checks:selected.checks,inputDigest:sha(input),sourceResultDigest:d.result!.digest,programCheckpoint:program});
  }else if(adaptive?.selected){
   selected=adaptive.selected;program.modules=adaptive.modules;program.candidates=program.modules.map(m=>({id:'candidate:'+m.structureDigest,moduleId:m.id,structureDigest:m.structureDigest,status:m.id===selected.moduleId?'CHECKED':'PROPOSED',counterexamples:[]}));program.semanticBindings.push({owner:'P2',schema:adaptive.plan?.schema,searchId:adaptive.plan?.id,revision:adaptive.plan?.revision,selection:'AUTHENTIC_CURRENT_CHECKED_P2_READER',stop:adaptive.plan?.stop,authorityGranted:false});program.unavailableBindings=program.unavailableBindings.filter(v=>v!=='P2_COMPARE');
   program.independentChecks=selected.checks;program.observableBranches=await tx(ctx,c=>observeAcceptedBranches(c,request.acceptance,input,d.witnesses.map(w=>w.id)),true);await reserve(ctx,q,program.graph.length+1,0);await durableNode(ctx,q,solveNode.id,{selectedModule:selected.moduleId,values:selected.values,checks:selected.checks,inputDigest:sha(input),sourceResultDigest:d.result!.digest,programCheckpoint:program});
  }else{
  await reserve(ctx,q,stepReservation,1);
  const checked:Array<{moduleId:string;values:Record<string,HarnessValue>;checks:unknown[]}>=[];
  const evaluateCandidate=async(module:NativeModule)=>{const candidate=program.candidates.find(c=>c.moduleId===module.id)!;try{const executed=await executeHarnessCandidate(module,request,input,d,meter,Date.parse(program.bounds.deadlineAt),async isolated=>{program.costs.nativeInvocations.push(isolated);await trace(ctx,q,'ISOLATED_MODULE_EXECUTION',isolated);}),{values}=executed;
    const checks=await tx(ctx,c=>checkNumericalAcceptance(c,request.acceptance,input,values),true);if(checks.some(c=>c.status!=='PASS')){candidate.status='REJECTED';candidate.counterexamples=checks.filter(c=>c.status==='FAIL');}else{candidate.status='CHECKED';checked.push({moduleId:module.id,values,checks});}await trace(ctx,q,'CHECK_REFINE',{candidateId:candidate.id,moduleId:module.id,status:candidate.status,checks,counterexamples:candidate.counterexamples,acceptanceDigest:program.acceptanceDigest});
   }catch(error){candidate.status='REJECTED';candidate.counterexamples=[{predicate:safePredicate(error)}];await trace(ctx,q,'CHECK_REFINE',{candidateId:candidate.id,status:'REJECTED',counterexamples:candidate.counterexamples,costUSD:null});}
    return candidate;};
  for(const module of [...program.modules])await evaluateCandidate(module);
  if(request.proposalSource==='GOVERNED_MODEL'){
   const route=describeLLMRoute('planning','console');
   if(!route.providerNames.length){await trace(ctx,q,'MODEL_ROUTE_UNAVAILABLE',{route,costUSD:null,qualifiedModelEpisodes:0});program.unavailableBindings.push('CONFIGURED_GOVERNED_MODEL_ROUTE');}
   else {
    const provider=resolveProviderForPurpose('planning','console'),sharedDeadline=Math.min(Date.parse(program.bounds.deadlineAt),Date.now()+route.deadlineMs);
    const counterexamples:unknown[]=[];
    for(let repair=0;repair<2&&Date.now()<sharedDeadline;repair++){
     const begun=Date.now(),invocationId=randomUUID();let outcome:any,rawResponse:string|null=null;
     try{
      if(program.modules.length>=program.bounds.maxCandidates)throw Error('ORIGINAL_CANDIDATE_BOUND_EXHAUSTED');
      await reserve(ctx,q,1,1);await reserveCandidate(ctx,q);await assertProgramCurrent(ctx,q);
      rawResponse=await provider.complete({tenantId:q.tenant_id,traceId:invocationId,purpose:'planning',channel:'console',deadlineAt:sharedDeadline,json:true,
       system:'Generate an alternate finite analytical implementation or repair its supplied development counterexamples. Return only JSON {targets:[{key,expression,unit,currencyCode}]}. Allowed expression kinds input,literal,add,subtract,multiply,ratio,min,max,if. An if has condition {comparison:lt|lte|eq|gte|gt,left,right}, whenTrue and whenFalse. Keep every required source and exact target key/unit/currency. Acceptance, scope, clocks and constraints stay frozen. Never grant authority, reveal protected tests or request tools, code, URL or credentials.',
       user:stable({instruction:request.instruction,accepted:request.acceptance,sourceSchemas:request.sources,registeredCatalogue:'P1_BOUNDED_EXACT_V1',counterexamples,repair,acceptanceDigest:program.acceptanceDigest})});
      if(Buffer.byteLength(rawResponse)>16384)throw Error('MODEL_PROPOSAL_BYTE_BOUND');
      let raw:any;try{raw=JSON.parse(rawResponse);}catch{throw Error('MODEL_PROPOSAL_INVALID_JSON');}
      if(!raw||Array.isArray(raw)||Object.keys(raw).length!==1||!Array.isArray(raw.targets))throw Error('MODEL_PROPOSAL_FIELDS_INVALID');
      const proposal=parseHarnessRequest({...request,acceptance:{...request.acceptance,targets:raw.targets}});
      if(stable(proposal.acceptance.targets.map(t=>({key:t.key,unit:t.unit,currencyCode:t.currencyCode})))!==stable(request.acceptance.targets.map(t=>({key:t.key,unit:t.unit,currencyCode:t.currencyCode}))))throw Error('MODEL_ACCEPTANCE_REWRITE');
      const alternate=constructModules(proposal,program.producer.codeDigest)[0]!;
      if(program.modules.some(m=>m.structureDigest===alternate.structureDigest))throw Error('DUPLICATE_PROPOSED_STRUCTURE');
      await reserve(ctx,q,alternate.bounds.steps+1,0);stepReservation+=alternate.bounds.steps+1;
      program.modules.push(alternate);program.candidates.push({id:'candidate:'+alternate.structureDigest,moduleId:alternate.id,structureDigest:alternate.structureDigest,status:'PROPOSED',counterexamples:[]});
      await tx(ctx,c=>c.query('INSERT INTO finnor_os.p1_modules(tenant_id,principal_id,digest,body) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[q.tenant_id,q.principal_id,alternate.compiledDigest,stable(alternate)]));
      const evaluated=await evaluateCandidate(alternate);outcome={status:evaluated.status,moduleId:alternate.id,counterexamples:evaluated.counterexamples};counterexamples.push(...evaluated.counterexamples);
     }catch(error){outcome={status:'FAILED',predicate:safePredicate(error),remainingAcceptanceDigest:program.acceptanceDigest};counterexamples.push({predicate:outcome.predicate});}
     const usage=provider.lastUsage??null;
     const invocation={invocationId,route,actualProvider:provider.selectedProviderName??provider.name,physicalAttempts:provider.lastAttempts??null,usage,returnedModel:usage?.returnedModel??null,modelIdentityQualification:usage?.returnedModel?'ACTUAL_ADAPTER_RETURNED_MODEL_IDENTITY':'UNKNOWN',usageQualification:usage&&(usage.inputTokens!==null||usage.outputTokens!==null)?'ACTUAL_ADAPTER_RETURNED_TOKEN_COUNTS':'UNKNOWN',elapsedMs:Date.now()-begun,deadlineAt:sharedDeadline,responseDigest:rawResponse===null?null:sha(rawResponse),rawResponse,costUSD:null,...outcome};
     program.costs.modelInvocations.push(invocation);await trace(ctx,q,'MODEL_PROPOSAL_ATTEMPT',invocation);
     if(outcome.status==='CHECKED'||outcome.predicate==='ORIGINAL_CANDIDATE_BOUND_EXHAUSTED'||outcome.predicate==='ORIGINAL_EPISODE_BUDGET_EXHAUSTED')break;
    }
   }
  }
  if(!checked.length)throw Error('NO_INDEPENDENTLY_CHECKED_IMPLEMENTATION');selected=checked.sort((a,b)=>program.modules.find(m=>m.id===a.moduleId)!.bounds.steps-program.modules.find(m=>m.id===b.moduleId)!.bounds.steps||a.moduleId.localeCompare(b.moduleId))[0]!;
  program.observableBranches=await tx(ctx,c=>observeAcceptedBranches(c,request.acceptance,input,d.witnesses.map(w=>w.id)),true);if(program.observableBranches.length)await trace(ctx,q,'OBSERVABLE_BRANCHES',program.observableBranches);
  program.independentChecks=selected.checks;program.costs=await episodeCosts(ctx,q);await durableNode(ctx,q,solveNode.id,{selectedModule:selected.moduleId,values:selected.values,checks:selected.checks,inputDigest:sha(input),sourceResultDigest:d.result!.digest,programCheckpoint:program});
  }
  for(const operation of request.operations??[]){meter();await assertProgramCurrent(ctx,q);const node=program.graph.find(n=>(n.payload as any)?.key===operation.key)!;const prior=await tx(ctx,async c=>(await c.query<{body:any;digest:string}>('SELECT body,digest FROM finnor_os.p1_node_results WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3 AND generation=$4 AND node_id=$5',[q.tenant_id,q.principal_id,q.id,q.generation,node.id])).rows[0],true);let outcome:any;
   if(prior){if(sha(prior.body)!==prior.digest)throw Error('DURABLE_NODE_DIGEST_MISMATCH');outcome=prior.body;}
   else{const invocationId=randomUUID(),begun=performance.now();try{outcome=await executeOwnerOperation(ctx,q,operation);await trace(ctx,q,'OWNER_OPERATION_ATTEMPT',{nativeInvocations:[{invocationId,owner:node.owner,operation:operation.op,nodeId:node.id,elapsedMs:performance.now()-begun,status:outcome.status,compute:outcome.value?.proposal?.compute??outcome.value?.response?.compute??null,resultDigest:sha(outcome.value),costUSD:null,qualification:'ACTUAL_OWNER_OPERATION_NO_AUTHORITY_UPGRADE'}]});}catch(error){await trace(ctx,q,'OWNER_OPERATION_ATTEMPT',{nativeInvocations:[{invocationId,owner:node.owner,operation:operation.op,nodeId:node.id,elapsedMs:performance.now()-begun,status:'FAILED',predicate:safePredicate(error),compute:null,costUSD:null,qualification:'FAILED_OWNER_OPERATION_COST_RETAINED'}]});throw error;}}
   if(outcome.status==='DONE')await durableNode(ctx,q,node.id,outcome);
   program.semanticBindings.push({owner:node.owner,nodeId:node.id,operation:operation.op,capabilityVersion:node.capabilityVersion,truthClass:node.truthClass,resultStatus:outcome.status,value:outcome.value,resultDigest:sha(outcome.value),durableReplay:!!prior,p1AuthorityGranted:false});
   if(operation.op==='propose_effect')program.effectProposals.push(outcome.value);
   if(outcome.status!=='DONE'){
    program.status='PARTIAL';program.result=null;
    await tx(ctx,async(c,db)=>{await c.query('SELECT l.id FROM finnor_os.work_objective_loops l JOIN finnor_os.work_plan_revisions p ON p.objective_loop_id=l.id AND p.tenant_id=l.tenant_id WHERE l.tenant_id=$1 AND p.id=$2 FOR UPDATE OF l',[q.tenant_id,q.plan_revision_id]);await assertProgramCurrent(ctx,q,c,true);await trace(ctx,q,outcome.status==='WAITING'?'AWAIT_OBSERVATION':'BOUNDED_STOP',outcome,c);await persistProgrammeHead(ctx,q,program,outcome.status==='WAITING'?'WAITING':'PARTIAL',operation.key,c);if(outcome.status==='WAITING'){
     if(!outcome.value?.waitId)await (await import('../../../orchestration/src/objective-loop')).schedulePreparedHarnessObjectiveTx(db,{tenantId:q.tenant_id,workId:q.work_id,planRevisionId:q.plan_revision_id});
     // The controller may fail before it installs a native timer. Observe that
     // accepted deadline through the same durable queue and checked checkpoint;
     // this delivery cannot establish a missing observation or renew a grant.
     if(operation.op==='await_observation'&&!outcome.value?.waitId)await enqueueProgram(ctx,q,'native-wait-deadline:'+node.id,c,Math.max(1,Math.min(Date.parse(operation.deadlineAt),Date.parse(program.bounds.deadlineAt))-Date.now()+1));
    }});
    if(outcome.status==='STOP')await (await import('../../../orchestration/src/objective-loop')).controlWorkObjective({tenantId:q.tenant_id,workId:q.work_id,actorId:q.principal_id,command:'interrupt'});return;
   }
  }
  await assertProgramCurrent(ctx,q);await assertDependencies(ctx,program.dependencies);if(request.ownerBindings)await resolveEconomicBindings(ctx,request,{programId:q.id,workId:q.work_id,inputId:q.work_input_id,validAt:program.validAt,knowledgeAt:program.knowledgeAt});
  const sourceRef='evidence_derivation:'+d.id,paragraphs=Object.entries(selected.values).map(([key,value])=>({text:key+': '+value.value+' '+value.semantics.unit+(value.semantics.currencyCode?' '+value.semantics.currencyCode:'')+'; DERIVED_VALUE; accepted required sources: '+request.acceptance.requiredSourceKeys.join(', '),sourceRefs:[sourceRef]}));
  const sections=[{heading:'Checked analytical values — draft',paragraphs},{heading:'Qualification',paragraphs:[{text:'Source-cited analytical draft. No IC selection, investment execution, field observation, resource reservation, scientific admission or economic outcome is established.',sourceRefs:[sourceRef]}]}];
  const bytes=groundedMemoBytes(request.acceptance.deliverable.title,sections),check=await checkDraftBytes(bytes,{values:selected.values,requiredSourceKeys:request.acceptance.requiredSourceKeys,sourceRef});if(check.status!=='PASS')throw Error('INDEPENDENT_ARTIFACT_CHECK_FAILED');program.independentChecks.push(check);
  const existing=await tx(ctx,async c=>(await c.query<{document_id:string;id:string}>('SELECT document_id::text,id::text FROM finnor_os.document_versions WHERE tenant_id=$1 AND source_system=$2 AND source_ref=$3 ORDER BY version_ordinal LIMIT 1',[q.tenant_id,'p1_analytical_draft',q.id+':'+q.generation])).rows[0],true);
  await trace(ctx,q,'ARTIFACT_PREPARED',{byteDigest:sha(bytes),sourceRef,qualification:'ORDINARY_NATIVE_ANALYTICAL_DRAFT_NO_CANONICAL_IC_PROJECTION'});
  const artifact=existing?await getArtifactBytes({...ctx.auth,userId:principal(ctx)},existing.document_id,existing.id):await ingestArtifact({...ctx.auth,userId:principal(ctx)},{title:request.acceptance.deliverable.title+'.docx',bytes,origin:'finnor_generated',sourceSystem:'p1_analytical_draft',sourceRef:q.id+':'+q.generation});
  const version=artifact.version,documentId='documentId' in artifact?artifact.documentId:existing!.document_id;const materialized='bytes' in artifact?artifact.bytes:bytes;if(sha(materialized)!==sha(bytes)||artifact.ir.semanticHash!==check.semanticHash)throw Error('DURABLE_ARTIFACT_REPLAY_DIGEST_MISMATCH');
  program.dependencies=[...program.dependencies,...await revisions(ctx,['document:'+documentId])];
  program.result={values:selected.values,digest:sha({values:selected.values,acceptance:program.acceptanceDigest,sources:d.result!.digest,module:selected.moduleId,artifact:sha(bytes)}),artifact:{documentId,versionId:version.id,sha256:sha(bytes),semanticHash:artifact.ir.semanticHash}};program.status='TESTED';program.costs.wallMs=Date.now()-started;
  await tx(ctx,async(c,db)=>{await c.query('SELECT l.id FROM finnor_os.work_objective_loops l JOIN finnor_os.work_plan_revisions p ON p.objective_loop_id=l.id AND p.tenant_id=l.tenant_id WHERE l.tenant_id=$1 AND p.id=$2 FOR UPDATE OF l',[q.tenant_id,q.plan_revision_id]);await assertDependencies(ctx,program.dependencies,c,true);await assertProgramCurrent(ctx,q,c,true);const current=await requestRow(ctx,q.id,c,true);const claimed=(await c.query("SELECT id FROM finnor_os.jobs WHERE tenant_id=$1 AND id=$2 AND status='running' AND claim_token=$3 AND claim_fence=$4 FOR SHARE",[q.tenant_id,execution.jobId,execution.claimToken,execution.claimFence])).rows[0];if(!claimed||current.generation!==q.generation||current.claim_token!==execution.claimToken||current.status!=='RUNNING')throw Error('ATOMIC_PROGRAM_PUBLICATION_FENCED');
   await persistProgrammeHead(ctx,q,program,'TESTED',null,c);
   if((request.operations??[]).some(o=>o.op==='await_observation'))await (await import('@finnor/db')).ingestIntegrationEventTx(db,{tenantId:q.tenant_id,source:'P1_CURRENT_CHECKED_PRODUCER',sourceEventId:q.id+':'+q.generation+':'+program.result!.digest,eventType:'p1.harness.checked',workId:q.work_id,resource:{type:'work',id:q.work_id},correlationId:q.id,payload:{programId:q.id,workInputId:q.work_input_id,resultDigest:program.result!.digest},evidenceRefs:[{type:'p1_program',id:q.id}],trustClass:'trusted_runtime'});
   else await (await import('../../../orchestration/src/objective-loop')).schedulePreparedHarnessObjectiveTx(db,{tenantId:q.tenant_id,workId:q.work_id,planRevisionId:q.plan_revision_id});
   await trace(ctx,q,'COMPARE_PUBLISH',{selectionPolicy:adaptive?'P2_CURRENT_CHECKED_SEARCH_V1':'FIXED_CHECKED_FEWEST_INSTRUCTIONS_V1',selectedModule:selected.moduleId,resultDigest:program.result!.digest,artifact:program.result!.artifact,checks:program.independentChecks,remainingQualifications:program.unavailableBindings,costs:costWitness(program.costs)},c);await recordBusinessEvent(db,{tenantId:q.tenant_id,entityType:'work',entityId:q.work_id,eventType:'p1_harness_program_checked',payload:{programId:q.id,workInputId:q.work_input_id,planRevisionId:q.plan_revision_id,resultDigest:program.result!.digest,qualification:'CHECKED_ANALYTICAL_DRAFT_NOT_S8_ADMISSION'},source:'P1:ordinary-native'});
  });
 }catch(error){const predicate=safePredicate(error);await tx(ctx,async c=>{const current=await requestRow(ctx,q.id,c,true);await trace(ctx,q,'FAILED_OR_FENCED',{predicate,jobId:execution.jobId,deliveryAttemptId:execution.deliveryAttemptId,claimFence:execution.claimFence,costUSD:null,acceptanceUnchanged:true},c);if(executedProgram&&current.generation===q.generation&&current.status==='RUNNING'&&current.claim_token===q.claim_token){executedProgram.status='FAILED';executedProgram.result=null;await persistProgrammeHead(ctx,q,executedProgram,'FAILED',predicate,c);}
   if(current.generation===q.generation&&!['CANCELLED','TESTED'].includes(current.status)){await c.query("UPDATE finnor_os.p1_requests SET status=$4,failure=$5,updated_at=clock_timestamp() WHERE tenant_id=$1 AND principal_id=$2 AND id=$3",[q.tenant_id,q.principal_id,q.id,/REVISION|FENCED|SOURCE_CHANGED|SCHEMA_CHANGED|SUPERSEDED/.test(predicate)?'INVALIDATED':'FAILED',predicate]);await invalidateUnstartedProgramSearch(ctx,current,c);}});}
}
